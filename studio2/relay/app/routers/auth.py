"""Login / logout / me — v1 ``routers/auth.py`` minus ``stale_sessions``
(no server-side sessions exist in v2), with v2 cookie names (arch §8.2).

* ``POST /api/login``  {username, password, remember?} -> validated against
  the configured multi-user map; on success sets a signed httpOnly session
  cookie recording WHICH username authenticated. **Scheme-aware:** a login
  over plain http issues ``studio2_session`` (SameSite=Lax, NOT Secure); a
  login over https issues ``__Host-studio2_session`` instead (Secure +
  Path=/ + NO Domain — the ``__Host-`` prefix integrity rules mean an
  insecure origin can never plant or overwrite it). Same HMAC token format
  either way. The request scheme is trustworthy here because uvicorn serves
  both listeners directly (no proxy). On failure: one indistinguishable 401
  ``{"ok": false, "error": "invalid credentials"}`` for both unknown-user
  and wrong-password (no enumeration).
* ``POST /api/logout`` -> clears BOTH cookie names.
* ``GET  /api/me``     -> ``{"authenticated": bool, "username": str|null,
  "asset_version": str|null, "secure_url": str|null}`` — PUBLIC (the PWA
  gates its UI on it); ``asset_version`` is parsed read-only from
  ``pwa/app.js`` (v2 starts its own ``ASSET_VERSION`` lineage at "1") so a
  long-lived installed PWA can self-detect stale JS; ``secure_url`` is the
  https LAN URL when TLS is up.

NO HSTS anywhere (deliberate — v1 invariant carried): Strict-Transport-
Security would force-upgrade the plain-http bootstrap origin
(``http://<ip>:8520/setup``) that first-contact onboarding depends on.

Logging policy (v1 diagnostic-logging conventions): login success/failure and
logout are logged to the private rotating file log with the USERNAME and the
client IP only — the password is NEVER logged (neither are cookie values or
session tokens), and the failed-login username is control-stripped + capped
so a crafted value cannot forge log lines. Credentials are compared in
constant time (``hmac.compare_digest``).
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import security, settings
from ..core import applog
from . import deps

router = APIRouter(prefix="/api", tags=["auth"])

_log = logging.getLogger("studio2.auth")


def _client_ip(request: Request) -> str:
    """Best-effort peer IP for log lines (transport-derived, not spoofable
    via headers; '-' when the test client / transport provides none)."""
    return request.client.host if request.client else "-"


# --- PWA asset_version (stale-tab detection — v1 pattern, v2 lineage) -------
# The PWA declares `const ASSET_VERSION = "N";` in pwa/app.js. /api/me reports
# the version the SERVER is currently serving so a long-lived installed PWA
# can detect it is running older JS and show an update banner. Parsed
# dynamically (never hardcoded) with READ-ONLY access to the PWA file, cached
# by mtime so a frontend bump lands without a relay restart while steady-state
# /api/me calls cost one stat(). The PWA may not exist yet (parallel build) —
# every failure path returns None.
_ASSET_VERSION_RE = re.compile(r"\bASSET_VERSION\s*=\s*\"([^\"\r\n]{1,32})\"")
_av_mtime: float | None = None
_av_value: str | None = None


def asset_version() -> str | None:
    """The PWA's ASSET_VERSION as served right now, or None.

    Tolerates EVERY failure (missing/unreadable app.js, pattern absent) by
    returning None — /api/me must never break because the PWA is absent or
    its layout changed. Re-parses only when pwa/app.js's mtime changes.
    """
    global _av_mtime, _av_value
    path = settings.PWA_DIR / "app.js"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        _av_mtime, _av_value = None, None
        return None
    if mtime == _av_mtime:
        return _av_value
    value: str | None = None
    try:
        match = _ASSET_VERSION_RE.search(path.read_text(encoding="utf-8", errors="replace"))
        if match:
            value = match.group(1)
    except (OSError, ValueError):
        value = None
    _av_mtime, _av_value = mtime, value
    return value


class LoginBody(BaseModel):
    username: str
    password: str
    remember: bool = True


def _set_session_cookie(
    response: Response, username: str, remember: bool = True, secure: bool = False
) -> None:
    # remember=True (default): persistent cookie with the standard ~7-day TTL.
    # remember=False: a session cookie (no max_age) that the browser drops on
    # close, with a matching short token TTL so the signed token cannot
    # outlive the intended short-lived session.
    #
    # secure=True (an https login): issue __Host-studio2_session instead. The
    # __Host- prefix is only ACCEPTED by browsers when the cookie is Secure +
    # Path=/ + has NO Domain attribute — which is why domain is never set
    # here. The plain http cookie stays byte-identical to the v1 model (the
    # dual-name design avoids the strict-Secure-cookie http-login-loop trap:
    # marking the ONE cookie Secure would silently break plain-http logins).
    ttl = settings.SESSION_TTL_SECONDS if remember else settings.UNREMEMBERED_TTL_SECONDS
    token = security.issue_session(username, ttl_seconds=ttl)
    response.set_cookie(
        key=settings.SECURE_SESSION_COOKIE_NAME if secure else settings.SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_TTL_SECONDS if remember else None,
        httponly=True,
        samesite="lax",
        secure=secure,
        path="/",
    )


def _secure_url() -> str | None:
    """The https LAN URL for /api/me, or None when TLS is off/unavailable.

    Best-effort by contract — /api/me must never break because cert parsing
    or IP detection hiccupped. Imported lazily to keep the module graph
    simple (core/tls imports net, which this module also uses).
    """
    try:
        from .. import net
        from ..core import tls as tls_core

        if not tls_core.is_enabled():
            return None
        return f"https://{net.lan_ip()}:{settings.TLS_PORT}/"
    except Exception:  # noqa: BLE001 - secure_url is advisory only
        return None


@router.post("/login")
def login(body: LoginBody, request: Request) -> JSONResponse:
    # Multi-user: validate against the configured users map. The same 401 is
    # returned for an unknown username and a wrong password (no enumeration —
    # the RESPONSE stays indistinguishable; the private file log may record
    # the attempted username + IP per the diagnostic-logging conventions, but
    # NEVER the password).
    if not security.check_credentials(body.username, body.password):
        _log.warning(
            "login fail user=%s ip=%s",
            applog.sanitize_log_value(body.username, 64) or "-",
            _client_ip(request),
        )
        return JSONResponse(
            status_code=401,
            content={"ok": False, "error": "invalid credentials"},
        )
    # The scheme decides the cookie name: direct uvicorn, no proxy, so
    # request.url.scheme is ground truth. Logged for diagnostics — never the
    # token.
    secure = request.url.scheme == "https"
    _log.info(
        "login ok user=%s ip=%s remember=%s scheme=%s",
        body.username, _client_ip(request), body.remember, request.url.scheme,
    )
    # Record WHICH username authenticated in the signed session cookie.
    resp = JSONResponse(content={"ok": True, "username": body.username})
    _set_session_cookie(resp, body.username, remember=body.remember, secure=secure)
    return resp


@router.post("/logout")
def logout(request: Request) -> JSONResponse:
    # Best-effort attribution: logout is reachable without a valid cookie, so
    # the user may be "-". The cookie VALUE is never logged.
    _log.info(
        "logout user=%s ip=%s",
        deps.current_user(request) or "-", _client_ip(request),
    )
    resp = JSONResponse(content={"ok": True})
    # Clear BOTH cookie names — the caller may hold either (or both, after
    # mixed-scheme use). The __Host- deletion must itself satisfy the prefix
    # rules (Secure + Path=/ + no Domain) or browsers discard the Set-Cookie
    # and the cookie would survive logout. Documented limitation (v1 parity):
    # a logout over the HTTP origin cannot clear the __Host- cookie — full
    # logout happens on the https origin.
    resp.delete_cookie(key=settings.SESSION_COOKIE_NAME, path="/")
    resp.delete_cookie(
        key=settings.SECURE_SESSION_COOKIE_NAME,
        path="/",
        secure=True,
        httponly=True,
        samesite="lax",
    )
    return resp


@router.get("/me")
def me(request: Request) -> JSONResponse:
    user = deps.current_user(request)
    return JSONResponse(
        content={
            "authenticated": user is not None,
            "username": user,
            # The PWA version the server is serving (stale-tab detection);
            # null when it cannot be determined. Public like the rest of
            # /api/me — it reveals nothing sensitive (the JS itself is public).
            "asset_version": asset_version(),
            # The https LAN URL when TLS is up (drives the PWA's secure-setup
            # banner); null when TLS is off/unavailable. Public material — the
            # LAN IP already appears in the startup banner and /api/tls/info.
            "secure_url": _secure_url(),
        }
    )
