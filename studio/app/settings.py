"""Settings & path resolution for video-use Studio.

Single source of truth for every path, port, limit, credential, and root the
backend needs. Everything is derived from this file's location so it works
regardless of the CWD or where the venv lives.

Path layout::

    <repo_root>/                  <- REPO_ROOT
    ├── .env                      <- ENV_FILE (ELEVENLABS_API_KEY lives here)
    ├── SKILL.md                  <- SKILL_MD (agent system prompt source)
    ├── helpers/                  <- HELPERS_DIR (unmodified helper scripts)
    └── studio/
        ├── app/                  <- this package (PACKAGE_DIR)
        ├── frontend/             <- FRONTEND_DIR (served static SPA)
        ├── config.toml           <- optional config (env vars take precedence)
        └── .runtime/             <- RUNTIME_DIR (session secret, state, uploads)

Auth model (brief Delta 1 + Delta 3 multi-user): a username/password login mints
a signed, httpOnly ``studio_session`` cookie. Multiple accounts are supported via
a ``[users]`` table in ``config.toml`` (``name = "password"``). The legacy single
pair ``STUDIO_USERNAME`` / ``STUDIO_PASSWORD`` still works and is merged in as one
additional account. The signing secret ``STUDIO_SECRET`` is resolved here.
Nothing secret is logged.
"""

from __future__ import annotations

import os
import secrets
import shutil
from pathlib import Path

try:  # Python 3.11+ stdlib TOML reader (3.13/3.14 both ship it).
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - defensive only
    tomllib = None  # type: ignore[assignment]


# --- core paths -----------------------------------------------------------
# studio/app/settings.py -> studio/app -> studio -> repo root
PACKAGE_DIR: Path = Path(__file__).resolve().parent
STUDIO_DIR: Path = PACKAGE_DIR.parent
REPO_ROOT: Path = STUDIO_DIR.parent

ENV_FILE: Path = REPO_ROOT / ".env"
SKILL_MD: Path = REPO_ROOT / "SKILL.md"
HELPERS_DIR: Path = REPO_ROOT / "helpers"

FRONTEND_DIR: Path = STUDIO_DIR / "frontend"
RUNTIME_DIR: Path = STUDIO_DIR / ".runtime"
UPLOADS_DIR: Path = RUNTIME_DIR / "uploads"
# Per-user session tree (the new storage model). Every session lives under
# ``.runtime/users/<owner>/sessions/ses_<hex12>/`` and is the ONLY footage root
# the agent (cwd + tools + outputs) is allowed to touch — see allowed_roots().
USER_SESSIONS_ROOT: Path = RUNTIME_DIR / "users"
# Legacy single-folder transcript dir (pre-v2). Retained ONLY so the one-time
# migration can import the old transcript; no live code writes here anymore.
SESSIONS_DIR: Path = RUNTIME_DIR / "sessions"
STATE_FILE: Path = RUNTIME_DIR / "state.json"
# One-time migration marker (v2 per-user sessions). Its presence means the boot
# migration has already run; absence triggers an idempotent migration attempt.
MIGRATED_MARKER: Path = RUNTIME_DIR / "migrated_v2"
CONFIG_FILE: Path = STUDIO_DIR / "config.toml"

VERSION: str = "studio 0.1.0"

# Video extensions mirror helpers/transcribe_batch.py VIDEO_EXTS EXACTLY so an
# uploaded/inventoried file is discoverable by the helpers' find_videos().
# (No .webm — the helpers do not pick it up.)
VIDEO_EXTS: set[str] = {
    ".mp4", ".MP4", ".mov", ".MOV", ".mkv", ".MKV", ".avi", ".AVI", ".m4v",
}

# Session cookie configuration (brief Delta 1).
SESSION_COOKIE_NAME: str = "studio_session"
SESSION_TTL_SECONDS: int = 7 * 24 * 3600  # ~7 days


# --- optional config.toml loading -----------------------------------------
def _load_config() -> dict:
    """Read ``config.toml`` if present. Env vars always take precedence over it.

    Never raises: a malformed/missing config falls back to an empty dict.
    """
    if tomllib is None or not CONFIG_FILE.exists():
        return {}
    try:
        with CONFIG_FILE.open("rb") as fh:
            return tomllib.load(fh)
    except Exception:  # noqa: BLE001 - config is best-effort
        return {}


_CONFIG: dict = _load_config()


def _cfg(section: str, key: str, default=None):
    sect = _CONFIG.get(section)
    if isinstance(sect, dict) and key in sect:
        return sect[key]
    return default


# --- server binding -------------------------------------------------------
# 0.0.0.0 so a phone can reach Studio on the LAN (ARCHITECTURE.md §9.3).
HOST: str = os.environ.get("STUDIO_HOST") or str(_cfg("server", "host", "0.0.0.0"))
PORT: int = int(os.environ.get("STUDIO_PORT") or _cfg("server", "port", 8420))

# Per-file upload cap (default 8 GiB). ARCHITECTURE.md §9.4.
MAX_UPLOAD_BYTES: int = int(
    os.environ.get("STUDIO_MAX_UPLOAD")
    or _cfg("limits", "max_upload_bytes", 8 * 1024**3)
)


# --- allowed roots --------------------------------------------------------
def _normalize_root(p: Path) -> Path:
    """Normalize a configured root WITHOUT probing the device.

    A footage root may live on a removable/network/virtual drive that is mapped
    but not ready (Windows ``WinError 21``). ``Path.resolve()`` /
    ``os.path.realpath(strict=False)`` can still raise on such a drive, which
    must never crash the app or hide the configured root. ``os.path.normpath``
    canonicalizes separators/case-insensitive comparison without touching the
    filesystem, matching ``security.resolve_in_roots`` which uses
    ``os.path.realpath`` (purely lexical for an absolute path with no symlinks
    in the reachable prefix). Any unexpected error falls back to the raw path so
    the root stays configured and the guard keeps working once the drive is up.
    """
    try:
        return Path(os.path.realpath(str(p)))
    except OSError:
        try:
            return Path(os.path.normpath(str(p)))
        except OSError:
            return p


def allowed_roots() -> list[Path]:
    """The single allowed root: the per-user session tree (``.runtime/users/``).

    In the per-user session model the agent (cwd + every tool path + every
    output) is confined to the per-user session tree. There is no longer any
    browse-the-whole-disk file system — a session is the only place footage and
    edit/ outputs live, and every session dir is a descendant of
    ``USER_SESSIONS_ROOT``. The dir is created so it always resolves.

    Upload chunk PARTS live in ``.runtime/uploads/`` (which is NOT a footage
    root): the assembled file is written into the destination SESSION dir, which
    IS inside ``USER_SESSIONS_ROOT``, so the confinement check still passes for
    the file that actually matters. The part dir need not be an allowed root.
    """
    USER_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    return [_normalize_root(USER_SESSIONS_ROOT)]


# --- auth / credentials (multi-user — brief Delta 3) ----------------------
# Credentials are loaded as a username -> password map from three merged
# sources, in increasing precedence:
#
#   1. The ``[users]`` table in config.toml  (the real accounts live here).
#   2. The legacy single pair STUDIO_USERNAME / STUDIO_PASSWORD or
#      [auth].username / [auth].password (kept for backward compatibility).
#   3. If NO account is configured at all, a single ``admin`` account with an
#      auto-generated password (native first-run convenience; printed once).
#
# Passwords are never logged. The compare itself (constant time) lives in
# security.py; this module only exposes the resolved map.
_GENERATED_PASSWORD: str | None = None


def _legacy_single_user() -> tuple[str, str] | None:
    """The legacy ``[auth]`` / ``STUDIO_*`` single account, if explicitly set.

    Returns ``(username, password)`` only when a username AND password are
    explicitly configured; otherwise ``None`` (so it is not silently merged with
    a generated password — that path is handled by the fallback in ``users()``).
    """
    user = os.environ.get("STUDIO_USERNAME") or _cfg("auth", "username")
    pw = os.environ.get("STUDIO_PASSWORD") or _cfg("auth", "password")
    if user and pw:
        return str(user), str(pw)
    return None


def _config_users() -> dict[str, str]:
    """The ``[users]`` table from config.toml as a username -> password map.

    Non-string values are coerced to ``str``. A missing/malformed table yields
    an empty map. Usernames are kept verbatim (case-sensitive).
    """
    section = _CONFIG.get("users")
    if not isinstance(section, dict):
        return {}
    out: dict[str, str] = {}
    for name, pw in section.items():
        if isinstance(name, str) and pw is not None:
            out[name] = str(pw)
    return out


def users() -> dict[str, str]:
    """Resolved username -> password map for all valid login accounts.

    Merge order (later wins on key collision): config ``[users]`` table, then
    the legacy single ``[auth]``/``STUDIO_*`` account. If the result is empty
    (nothing configured anywhere), fall back to a single ``admin`` account whose
    password is auto-generated once per process and surfaced via
    ``generated_password()`` for the startup banner.
    """
    global _GENERATED_PASSWORD
    merged: dict[str, str] = {}
    merged.update(_config_users())

    legacy = _legacy_single_user()
    if legacy is not None:
        merged[legacy[0]] = legacy[1]

    if merged:
        return merged

    # Nothing configured: native first-run convenience account.
    if _GENERATED_PASSWORD is None:
        _GENERATED_PASSWORD = secrets.token_urlsafe(12)
    return {"admin": _GENERATED_PASSWORD}


def username() -> str:
    """A representative login username (the first configured account).

    Multi-user logins record their own username in the session cookie; this
    helper exists only for the startup banner and as a sensible default.
    """
    configured = list(users().keys())
    return configured[0] if configured else "admin"


def generated_password() -> str | None:
    """The auto-generated password if one was generated, else None.

    None means at least one account was explicitly configured (never print a
    configured secret). A value is returned only on the no-config fallback path.
    """
    # Calling users() ensures the fallback password is generated if needed.
    users()
    return _GENERATED_PASSWORD


# Session signing secret. Persisted so cookies survive a native restart, unless
# STUDIO_SECRET is supplied (Docker). Never logged.
_SESSION_SECRET: bytes | None = None
_SECRET_FILE: Path = RUNTIME_DIR / "session_secret"


def session_secret() -> bytes:
    """HMAC signing secret for session cookies.

    Resolution order:
      1. ``STUDIO_SECRET`` env (Docker — survives restarts via .env).
      2. Persisted ``.runtime/session_secret`` (native — survives restarts).
      3. A freshly generated 32-byte secret, persisted to (2).

    The secret value is never logged.
    """
    global _SESSION_SECRET
    if _SESSION_SECRET is not None:
        return _SESSION_SECRET

    env_secret = os.environ.get("STUDIO_SECRET")
    if env_secret:
        _SESSION_SECRET = env_secret.encode("utf-8")
        return _SESSION_SECRET

    try:
        if _SECRET_FILE.exists():
            data = _SECRET_FILE.read_bytes()
            if data:
                _SESSION_SECRET = data
                return _SESSION_SECRET
    except OSError:
        pass

    _SESSION_SECRET = secrets.token_bytes(32)
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        _SECRET_FILE.write_bytes(_SESSION_SECRET)
        if os.name != "nt":  # restrict perms on POSIX
            os.chmod(_SECRET_FILE, 0o600)
    except OSError:
        pass  # ephemeral secret is acceptable if we can't persist
    return _SESSION_SECRET


def secret_source() -> str:
    """Where the session secret came from (for diagnostics, never the value)."""
    if os.environ.get("STUDIO_SECRET"):
        return "env"
    if _SECRET_FILE.exists():
        return "runtime_file"
    return "generated"


# --- environment probes ---------------------------------------------------
def ffmpeg_version() -> str | None:
    """Return the ffmpeg version string if resolvable on PATH, else None."""
    exe = shutil.which("ffmpeg")
    if not exe:
        return None
    try:
        import subprocess

        out = subprocess.run(
            [exe, "-version"], capture_output=True, text=True, timeout=10
        )
        first = (out.stdout or "").splitlines()[0] if out.stdout else ""
        # "ffmpeg version 8.1.1 ..." -> "8.1.1"
        parts = first.split()
        if len(parts) >= 3 and parts[0] == "ffmpeg" and parts[1] == "version":
            return parts[2]
        return first or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def ffmpeg_available() -> bool:
    """True if both ffmpeg and ffprobe are resolvable on PATH."""
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def elevenlabs_key_present() -> tuple[bool, str | None]:
    """Mirror transcribe.py's resolution order (repo .env -> ./.env -> env).

    Returns ``(present, source)``. The key value is never read into the response;
    ``source`` is one of ``repo_root_env`` | ``cwd_env`` | ``environment`` | None.
    """
    for candidate, label in [(ENV_FILE, "repo_root_env"), (Path(".env"), "cwd_env")]:
        try:
            if candidate.exists():
                for raw in candidate.read_text(encoding="utf-8").splitlines():
                    line = raw.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    if k.strip() == "ELEVENLABS_API_KEY" and v.strip():
                        return True, label
        except OSError:
            continue
    if os.environ.get("ELEVENLABS_API_KEY"):
        return True, "environment"
    return False, None


def has_anthropic_api_key() -> bool:
    """True if ANTHROPIC_API_KEY is present (selects agent API-key mode)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))
