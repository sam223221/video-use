"""Shared router dependencies & error helpers — v1 ``routers/deps.py`` minus
``require_session_dir`` (there are no server-side sessions/projects in v2;
projects live in the device's OPFS — arch §1.4).

Session-cookie authentication for every ``/api/*`` route except
login/me/tls-info and the public PWA shell. The session token rides in an
httpOnly cookie that the browser sends automatically (including on SSE
requests — both bridge and chat streams are gated this way, arch §8.1), so
there is no token-in-URL.

``require_session`` returns the authenticated username or raises 401. Routers
declare ``user: str = Depends(require_session)`` to gate themselves.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request, status

from .. import security, settings


def current_user(request: Request) -> str | None:
    """Return the authenticated username from the session cookie, or None.

    https logins carry ``__Host-studio2_session`` (Secure, so browsers only
    send it on https) while http logins keep the plain ``studio2_session`` —
    verify the ``__Host-`` cookie FIRST, then fall back to the plain name, so
    a phone hopping between the http bootstrap origin and the https origin
    stays signed in on both. Same HMAC token format in both cookies;
    ``verify_session`` is the single validator.
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


def error_response(code: str, message: str, detail: Any = None) -> dict[str, Any]:
    """Build the contract's JSON error body (``{detail:{error:{code,…}}}``
    once FastAPI wraps it — the PWA unwraps via ``normalizeError``)."""
    body: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        body["detail"] = detail
    return {"error": body}


def http_error(http_status: int, code: str, message: str, detail: Any = None) -> HTTPException:
    return HTTPException(status_code=http_status, detail=error_response(code, message, detail))
