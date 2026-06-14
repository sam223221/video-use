"""Security primitives for the Studio v2 relay.

Two concerns, all stdlib, carried VERBATIM from v1 ``studio/app/security.py``
(field-hardened patterns):

1. **Session cookies** — sign/verify a ``username|expiry`` payload with an
   HMAC keyed on ``settings.session_secret()``. The signed token rides in an
   httpOnly, SameSite=Lax cookie. Constant-time verification.
2. **Credential check** — multi-user, constant-time password comparison
   against the configured ``settings.users()`` map. An absent username still
   runs a constant-time compare against a fixed dummy so timing does not
   reveal whether a username exists; the caller returns one
   indistinguishable 401 either way.

v1's path/filename code (``resolve_in_roots``, ``sanitize_filename``, …) is
DELIBERATELY ABSENT: the relay never touches media paths — there are no
uploads, no file streaming, no server-side projects (arch §1.2, §8.5). Log
sanitization lives in ``core/applog.sanitize_log_value``.

Nothing here logs secrets, passwords, tokens, or PII.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

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
