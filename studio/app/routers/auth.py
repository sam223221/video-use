"""Login / logout / me (brief Delta 1 + Delta 3 multi-user — the primary auth UX).

* ``POST /api/login``  {username, password} -> validated against the configured
  multi-user map; on success sets the signed httpOnly ``studio_session`` cookie
  (SameSite=Lax, NOT Secure — plain http on the LAN) recording WHICH username
  authenticated. On failure: one indistinguishable 401
  ``{"ok": false, "error": "invalid credentials"}`` for both unknown-user and
  wrong-password (no username enumeration).
* ``POST /api/logout`` -> clears the cookie.
* ``GET  /api/me``     -> ``{"authenticated": bool, "username": str|null,
  "stale_sessions": int, "asset_version": str|null}`` — PUBLIC (used by the
  frontend to gate the UI); reflects the cookie's username, the COUNT of the
  caller's stale sessions (idle > 14 days; full list at ``GET /api/sessions``),
  and the frontend ASSET_VERSION the server is serving (parsed read-only from
  ``frontend/app.js``, mtime-cached; ``null`` on any parse failure) so a
  long-lived tab can self-detect that it is running stale JS.

The username and password are never logged. Credentials are compared in
constant time (``hmac.compare_digest``).
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import security, settings
from ..core import sessions
from . import deps

router = APIRouter(prefix="/api", tags=["auth"])


# --- frontend asset_version (stale-tab detection) ---------------------------
# The SPA declares `const ASSET_VERSION = "N";` in frontend/app.js. /api/me
# reports the version the SERVER is currently serving so a long-lived tab
# (phones keep tabs alive for days) can detect it is running older JS and show
# a "refresh for the new version" banner. The value is parsed dynamically
# (NEVER hardcoded — the frontend bumps it on every deploy) with READ-ONLY
# access to the frontend file, and cached by mtime so a frontend bump lands
# without a backend restart while steady-state /api/me calls cost one stat().
_ASSET_VERSION_RE = re.compile(r"\bASSET_VERSION\s*=\s*\"([^\"\r\n]{1,32})\"")
_av_mtime: float | None = None
_av_value: str | None = None


def asset_version() -> str | None:
    """The frontend's ASSET_VERSION as served right now, or None.

    Tolerates EVERY failure (missing/unreadable app.js, pattern absent) by
    returning None — /api/me must never break because the frontend is absent or
    its layout changed. Re-parses only when frontend/app.js's mtime changes.
    """
    global _av_mtime, _av_value
    path = settings.FRONTEND_DIR / "app.js"
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


# How long an un-remembered ("remember me" unchecked) session token stays valid.
# The cookie itself is a session cookie (no max_age -> dies on browser close),
# but the signed token still needs a finite TTL so a cookie restored from a
# crashed/re-opened browser cannot be replayed indefinitely.
_UNREMEMBERED_TTL_SECONDS: int = 12 * 3600  # 12 hours


class LoginBody(BaseModel):
    username: str
    password: str
    remember: bool = True


def _set_session_cookie(response: Response, username: str, remember: bool = True) -> None:
    # remember=True (default): persistent cookie with the standard ~7-day TTL.
    # remember=False: a session cookie (no max_age) that the browser drops on
    # close, with a matching short token TTL so the signed token cannot outlive
    # the intended short-lived session.
    ttl = settings.SESSION_TTL_SECONDS if remember else _UNREMEMBERED_TTL_SECONDS
    token = security.issue_session(username, ttl_seconds=ttl)
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_TTL_SECONDS if remember else None,
        httponly=True,
        samesite="lax",
        secure=False,  # plain http on the LAN (documented in API_CONTRACT.md)
        path="/",
    )


@router.post("/login")
def login(body: LoginBody) -> JSONResponse:
    # Multi-user: validate against the configured users map. The same 401 is
    # returned for an unknown username and a wrong password (no enumeration).
    if not security.check_credentials(body.username, body.password):
        # Do NOT log the attempted username or password.
        return JSONResponse(
            status_code=401,
            content={"ok": False, "error": "invalid credentials"},
        )
    # Record WHICH username authenticated in the signed session cookie.
    resp = JSONResponse(content={"ok": True, "username": body.username})
    _set_session_cookie(resp, body.username, remember=body.remember)
    return resp


@router.post("/logout")
def logout() -> JSONResponse:
    resp = JSONResponse(content={"ok": True})
    resp.delete_cookie(key=settings.SESSION_COOKIE_NAME, path="/")
    return resp


@router.get("/me")
def me(request: Request) -> JSONResponse:
    user = deps.current_user(request)
    stale_count = 0
    if user is not None:
        # Count the caller's stale sessions (idle > 14 days) so the frontend can
        # nudge a cleanup; the full list lives at GET /api/sessions.
        stale_count = sum(1 for s in sessions.list_for(user) if s.is_stale())
    return JSONResponse(
        content={
            "authenticated": user is not None,
            "username": user,
            "stale_sessions": stale_count,
            # The frontend version the server is serving (stale-tab detection);
            # null when it cannot be determined. Public like the rest of /api/me
            # — it reveals nothing sensitive (the JS itself is public).
            "asset_version": asset_version(),
        }
    )
