"""Shared router dependencies & error helpers (brief Delta 1).

Session-cookie authentication for every ``/api/*`` route except login/logout/me
and the public SPA/static assets. The session token rides in an httpOnly
``studio_session`` cookie that the browser sends automatically (including on SSE
and media requests), so there is no token-in-URL.

``require_session`` returns the authenticated username or raises 401. Routers
declare ``user: str = Depends(require_session)`` to gate themselves.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request, status

from .. import security, settings
from ..core import sessions


def current_user(request: Request) -> str | None:
    """Return the authenticated username from the session cookie, or None.

    Secure Studio (2026-06-11): https logins carry ``__Host-studio_session``
    (Secure, so browsers only send it on https) while http logins keep the
    legacy ``studio_session`` — verify the ``__Host-`` cookie FIRST, then fall
    back to the legacy name, so a phone hopping between the http bootstrap
    origin and the https origin stays signed in on both. Same HMAC token
    format in both cookies; ``verify_session`` is the single validator.
    """
    token = request.cookies.get(settings.SECURE_SESSION_COOKIE_NAME)
    user = security.verify_session(token)
    if user is not None:
        return user
    return security.verify_session(request.cookies.get(settings.SESSION_COOKIE_NAME))


def require_session(request: Request) -> str:
    """Dependency: require a valid session cookie. Raises 401 otherwise."""
    user = current_user(request)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": {"code": "unauthorized", "message": "login required"}},
        )
    return user


def require_session_dir(user: str, session_id: str | None) -> tuple[str, str, Path]:
    """Resolve ``session_id`` to the caller's OWNED session dir, or raise 404.

    The single resolution point for every per-session route. Goes through
    ``core.sessions.get`` / ``resolve_dir`` (the ownership chokepoint), so a bad
    id, a cross-user id, or a missing session all collapse to one uniform
    ``404 session_not_found`` — the response never reveals whether another user's
    session exists (IDOR-safe). Returns ``(user, session_id, session_dir)``.

    Routers call this with the username from ``require_session`` and the
    client-carried ``session_id`` (query param or request body).
    """
    if not session_id:
        raise http_error(404, "session_not_found", "session not found")
    session_dir = sessions.resolve_dir(user, session_id)
    if session_dir is None:
        raise http_error(404, "session_not_found", "session not found")
    return user, session_id, session_dir


def error_response(code: str, message: str, detail: Any = None) -> dict[str, Any]:
    """Build the contract's JSON error body."""
    body: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        body["detail"] = detail
    return {"error": body}


def http_error(http_status: int, code: str, message: str, detail: Any = None) -> HTTPException:
    return HTTPException(status_code=http_status, detail=error_response(code, message, detail))
