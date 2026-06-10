"""Security primitives for video-use Studio.

Three concerns, all stdlib (no extra deps — brief Delta 1 prefers stdlib):

1. **Session cookies** — sign/verify a ``username|expiry`` payload with an HMAC
   keyed on ``settings.session_secret()``. The signed token rides in an
   httpOnly, SameSite=Lax cookie. Constant-time verification.
2. **Credential check** — multi-user, constant-time password comparison against
   the configured ``settings.users()`` map. An absent username still runs a
   constant-time compare against a fixed dummy so timing does not reveal whether
   a username exists; the caller returns one indistinguishable 401 either way.
3. **Path safety** — ``resolve_in_roots`` realpath-confines any user path to the
   allowed roots; filename sanitizers reject traversal / reserved names.

Nothing here logs secrets, passwords, tokens, or PII.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import time
from pathlib import Path

from . import settings


# ============================================================================
# Session tokens
# ============================================================================

_SEP = "|"


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(payload: str) -> str:
    sig = hmac.new(settings.session_secret(), payload.encode("utf-8"), hashlib.sha256)
    return _b64e(sig.digest())


def issue_session(username: str, ttl_seconds: int | None = None) -> str:
    """Mint a signed session token for ``username``.

    Token format: ``<b64(username)>|<expiry_epoch>|<b64(hmac)>``.
    """
    ttl = ttl_seconds if ttl_seconds is not None else settings.SESSION_TTL_SECONDS
    expiry = int(time.time()) + ttl
    body = f"{_b64e(username.encode('utf-8'))}{_SEP}{expiry}"
    return f"{body}{_SEP}{_sign(body)}"


def verify_session(token: str | None) -> str | None:
    """Verify a session token. Returns the username if valid+unexpired, else None.

    Uses ``hmac.compare_digest`` for the signature check (constant time).
    """
    if not token:
        return None
    parts = token.split(_SEP)
    if len(parts) != 3:
        return None
    user_b64, expiry_str, sig = parts
    body = f"{user_b64}{_SEP}{expiry_str}"

    expected = _sign(body)
    if not hmac.compare_digest(expected, sig):
        return None

    try:
        expiry = int(expiry_str)
    except ValueError:
        return None
    if expiry < int(time.time()):
        return None

    try:
        name = _b64d(user_b64).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    # An empty username is never a valid session: require_session only rejects
    # None, so returning "" would let an empty-username cookie slip through.
    return name or None


# A fixed, non-empty dummy used when the supplied username is unknown. Comparing
# against it keeps the work (and timing) of the unknown-user path close to the
# known-user path, so an attacker cannot cheaply enumerate valid usernames.
_DUMMY_PASSWORD = "x" * 32


def check_credentials(username: str, password: str) -> bool:
    """Validate a login against the configured ``settings.users()`` map.

    Returns ``True`` only when ``username`` exists AND its password matches under
    a constant-time compare (``hmac.compare_digest``). For an unknown username we
    still run a constant-time compare against a dummy value and return ``False``,
    so the unknown-user and wrong-password paths are timing-similar and the
    caller can emit a single indistinguishable 401 (no username enumeration).
    """
    # An empty username can never own an account; reject up front so a blank
    # credential is never issued a cookie (and burn no compare for it).
    if not username:
        return False
    accounts = settings.users()
    expected = accounts.get(username)
    if expected is None:
        # Unknown user: burn an equivalent compare, then fail.
        hmac.compare_digest(password.encode("utf-8"), _DUMMY_PASSWORD.encode("utf-8"))
        return False
    return hmac.compare_digest(password.encode("utf-8"), expected.encode("utf-8"))


# ============================================================================
# Path-traversal safety
# ============================================================================

class PathOutsideRoots(Exception):
    """Raised when a user-supplied path resolves outside all allowed roots."""


def _norm(p: Path) -> str:
    # ``os.path.realpath`` can raise on a removable/network drive that is mapped
    # but not ready (Windows ``WinError 21`` -> OSError). Mirror
    # ``settings._normalize_root`` and fall back to a purely lexical normpath so a
    # transiently offline root never crashes the guard with a 500. A NUL in the
    # path (``ValueError`` from the underlying stat) is left to propagate so
    # ``resolve_in_roots`` can turn it into a clean ``PathOutsideRoots``.
    try:
        s = os.path.realpath(str(p))
    except OSError:
        s = os.path.normpath(str(p))
    return s.lower() if os.name == "nt" else s


def _is_within(child_real: str, root_real: str) -> bool:
    """True if ``child_real`` is ``root_real`` or a descendant of it.

    Both inputs must already be realpath-normalized (and case-folded on Windows).
    Uses ``os.path.commonpath`` to avoid the ``/foo`` vs ``/foobar`` prefix trap.
    """
    if child_real == root_real:
        return True
    try:
        return os.path.commonpath([child_real, root_real]) == root_real
    except ValueError:
        # Different drives on Windows raise ValueError -> not within.
        return False


def is_within_root(child: str | Path, root: str | Path) -> bool:
    """True if ``child`` resolves to ``root`` or a descendant of it.

    Both paths are realpath-normalized (and case-folded on Windows) BEFORE the
    containment test, so a symlink that escapes is rejected. Used to enforce the
    per-user ownership prefix on ``/api/file`` (root-confinement to
    ``USER_SESSIONS_ROOT`` alone would still let one user stream another user's
    media — this narrows it to the caller's own ``users/<username>/`` subtree).

    Never raises: a NUL/offline-drive normalization failure is treated as "not
    within" so the caller emits a clean 4xx instead of a 500.
    """
    try:
        child_real = _norm(Path(child))
        root_real = _norm(Path(root))
    except (ValueError, OSError):
        return False
    return _is_within(child_real, root_real)


def resolve_in_roots(user_path: str | Path, roots: list[Path] | None = None) -> Path:
    """Resolve ``user_path`` and confirm it lives inside one of the allowed roots.

    Symlinks are resolved (``os.path.realpath``) BEFORE the containment check, so
    a symlink pointing outside the roots is rejected. Returns the realpath as a
    ``Path``. Raises ``PathOutsideRoots`` otherwise.

    Normalizing a user-supplied path can raise: an embedded NUL (e.g. a decoded
    ``%00``) makes the underlying stat raise ``ValueError`` on POSIX, and a
    mapped-but-offline drive raises ``OSError`` (Windows ``WinError 21``). Both
    are treated as a confinement failure so callers get a clean ``PathOutsideRoots``
    (4xx) instead of an uncaught 500. Every router already handles
    ``PathOutsideRoots``.
    """
    if roots is None:
        roots = settings.allowed_roots()

    try:
        candidate_real = _norm(Path(user_path))
    except (ValueError, OSError):
        raise PathOutsideRoots(str(user_path))
    root_reals = [_norm(r) for r in roots]

    for rr in root_reals:
        if _is_within(candidate_real, rr):
            try:
                return Path(os.path.realpath(str(user_path)))
            except OSError:
                return Path(os.path.normpath(str(user_path)))

    raise PathOutsideRoots(str(user_path))


# ============================================================================
# Filename sanitization (upload / mkdir)
# ============================================================================

# Windows reserved device names (case-insensitive, with or without extension).
_RESERVED_WIN = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_BAD_CHARS_RE = re.compile(r'[<>:"/\\|?*]')


def sanitize_name(name: str) -> str:
    """Validate a single path component (folder name or filename).

    Rejects: empty, separators, ``..``/``.``, control chars, Windows reserved
    names, names ending in space/dot. Returns the cleaned name. Raises
    ``ValueError`` on anything unsafe.
    """
    if not name or not name.strip():
        raise ValueError("empty name")
    name = name.strip()

    if name in (".", "..") or "/" in name or "\\" in name:
        raise ValueError("name contains separators or traversal")
    if _CONTROL_RE.search(name):
        raise ValueError("name contains control characters")
    if _BAD_CHARS_RE.search(name):
        raise ValueError("name contains disallowed characters")

    stem = name.split(".")[0].lower()
    if stem in _RESERVED_WIN:
        raise ValueError("name is a reserved system name")

    if name.endswith(" ") or name.endswith("."):
        raise ValueError("name cannot end with a space or dot")

    if len(name) > 255:
        raise ValueError("name too long")

    return name


_DISPLAY_NAME_MAX = 80


def sanitize_display_name(name: str) -> str:
    """Sanitize a session DISPLAY name (never used as a path component).

    The session's filesystem identity is its ``ses_<hex12>`` id, NOT this name,
    so this validator is intentionally permissive: it only needs to be safe to
    store + render. It strips control chars (incl. CR/LF/TAB and DEL), collapses
    runs of internal whitespace to single spaces, trims surrounding whitespace,
    and caps the length at ~80 chars. Raises ``ValueError`` if nothing printable
    remains (empty / whitespace-only / control-only input).
    """
    if not isinstance(name, str):
        raise ValueError("name must be a string")
    # Drop control characters (C0 range + DEL) entirely.
    cleaned = _CONTROL_RE.sub("", name)
    # Collapse any internal whitespace runs (now that controls are gone) and trim.
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        raise ValueError("name is empty after sanitization")
    if len(cleaned) > _DISPLAY_NAME_MAX:
        cleaned = cleaned[:_DISPLAY_NAME_MAX].strip()
    if not cleaned:
        raise ValueError("name is empty after sanitization")
    return cleaned


def _video_exts_folded() -> set[str]:
    """``settings.VIDEO_EXTS`` lower-cased, for case-insensitive acceptance.

    The CONTENT of ``VIDEO_EXTS`` stays in lockstep with
    ``helpers/transcribe_batch.py`` (helper-parity rule — never edit one without
    the other); only the COMPARISON is folded here, so a phone's ``CLIP.M4V`` /
    ``movie.Mp4`` is no longer rejected at init after passing the client's own
    lower-cased check.
    """
    return {e.lower() for e in settings.VIDEO_EXTS}


def sanitize_filename(filename: str) -> str:
    """Sanitize an uploaded filename: strip any path, validate the basename,
    enforce the video extension allowlist (case-insensitive), and NORMALIZE the
    suffix to a spelling that is literally in ``VIDEO_EXTS``.

    Acceptance is case-folded, but downstream discovery is case-SENSITIVE
    (``helpers_wrap/inventory.py`` and ``helpers/transcribe_batch.py`` both
    check ``p.suffix in VIDEO_EXTS``) — so a stored ``CLIP.M4V`` would upload
    fine yet never appear in Clips or transcribe. When the exact-case suffix is
    NOT in ``VIDEO_EXTS`` but a case-variant IS, the suffix is rewritten to the
    canonical lowercase in-allowlist form (``CLIP.M4V`` -> ``CLIP.m4v``; the
    stem is untouched). Suffixes already in the allowlist (e.g. ``.MP4``) are
    stored as-is. ``VIDEO_EXTS`` CONTENT is unchanged (helper-parity rule).
    """
    base = os.path.basename(filename.replace("\\", "/"))
    base = sanitize_name(base)
    stem, ext = os.path.splitext(base)
    folded = ext.lower()
    if folded not in _video_exts_folded():
        raise ValueError(f"unsupported file type: {ext or '(none)'}")
    if ext not in settings.VIDEO_EXTS:
        # Prefer the lowercase spelling (every current allowlist entry has
        # one); the fallback picks a deterministic in-allowlist case-variant so
        # the invariant "stored suffix is literally in VIDEO_EXTS" holds even
        # if the allowlist's shape ever changes. Re-attaching a known-good
        # allowlist suffix to the sanitize_name-validated stem cannot
        # introduce separators / control chars / a trailing space-or-dot.
        canonical = (
            folded
            if folded in settings.VIDEO_EXTS
            else min(e for e in settings.VIDEO_EXTS if e.lower() == folded)
        )
        base = stem + canonical
    return base


def is_video_file(path: Path) -> bool:
    return path.suffix.lower() in _video_exts_folded()
