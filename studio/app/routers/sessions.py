"""Per-user session lifecycle (the new project-management surface).

Every endpoint is scoped to the AUTHENTICATED caller — a user only ever sees,
opens, keeps, or deletes their OWN sessions. Resolution goes through
``core.sessions`` (the ownership chokepoint), so a cross-user / unknown / bad id
all return one uniform ``404 session_not_found`` (IDOR-safe).

Routes (frozen API contract):

* ``GET    /api/sessions``            -> {sessions:[summary], stale:[ids]}
* ``POST   /api/sessions``  {name}    -> 201 {id, name, created_at, last_touched_at}
* ``POST   /api/sessions/{id}/open``  -> {id, name, created_at, last_touched_at, dir}
                                         (touches last_touched_at; 404 if not owned)
* ``POST   /api/sessions/{id}/keep``  -> {ok, last_touched_at} (resets the 14-day clock)
* ``DELETE /api/sessions/{id}``       -> {ok} (permanent rmtree + drop agent client)

A chat turn / upload / transcribe is what creates media in a session; this router
only manages the session container itself.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .. import security
from ..core import sessions
from . import deps

router = APIRouter(prefix="/api", tags=["sessions"])


class CreateBody(BaseModel):
    name: str


@router.get("/sessions")
def list_sessions(user: str = Depends(deps.require_session)) -> dict:
    """List ONLY the caller's sessions (newest-touched first) + the stale ids.

    ``stale`` is the subset of ids idle for more than the 14-day threshold — the
    frontend uses it to surface a delete prompt. The full per-session ``stale``
    flag is also on each summary entry.
    """
    now = int(time.time())
    out = []
    stale_ids = []
    for sess in sessions.list_for(user):
        session_dir = sessions.resolve_dir(user, sess.id)
        if session_dir is None:
            continue
        summary = sess.to_public(session_dir, now=now)
        out.append(summary)
        if summary["stale"]:
            stale_ids.append(sess.id)
    return {"sessions": out, "stale": stale_ids}


@router.post("/sessions", status_code=201)
def create_session(
    body: CreateBody,
    user: str = Depends(deps.require_session),
) -> JSONResponse:
    """Create a new session owned by the caller. 400 invalid_name on empty/long."""
    try:
        name = security.sanitize_display_name(body.name)
    except ValueError:
        raise deps.http_error(400, "invalid_name", "name is empty or invalid")
    try:
        sess = sessions.create(user, name)
    except OSError as exc:
        raise deps.http_error(500, "create_failed", f"could not create session: {exc}")
    return JSONResponse(
        status_code=201,
        content={
            "id": sess.id,
            "name": sess.name,
            "created_at": sess.created_at,
            "last_touched_at": sess.last_touched_at,
        },
    )


@router.post("/sessions/{session_id}/open")
def open_session(
    session_id: str,
    user: str = Depends(deps.require_session),
) -> dict:
    """Open a session: touch it and return its ABSOLUTE dir.

    The frontend joins ``dir`` with ``edit/...`` to build ``/api/file`` URLs for
    chat artifacts, so the absolute path is part of the contract here.
    """
    _user, _sid, session_dir = deps.require_session_dir(user, session_id)
    sessions.touch(user, session_id)
    sess = sessions.get(user, session_id)
    if sess is None:  # raced with a concurrent delete
        raise deps.http_error(404, "session_not_found", "session not found")
    return {
        "id": sess.id,
        "name": sess.name,
        "created_at": sess.created_at,
        "last_touched_at": sess.last_touched_at,
        "dir": str(session_dir),
    }


@router.post("/sessions/{session_id}/keep")
def keep_session(
    session_id: str,
    user: str = Depends(deps.require_session),
) -> dict:
    """Reset the 14-day stale clock (the user chose to keep a stale session)."""
    deps.require_session_dir(user, session_id)
    touched = sessions.touch(user, session_id)
    if touched is None:
        raise deps.http_error(404, "session_not_found", "session not found")
    return {"ok": True, "last_touched_at": touched}


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: str = Depends(deps.require_session),
) -> dict:
    """Permanently delete the session dir + drop its cached agent client.

    Async on purpose: ``sessions.delete`` AWAITS the cached agent client's
    disconnect BEFORE the rmtree (the SDK subprocess cwd pins the dir on
    Windows) and runs the bounded-retry rmtree in a worker thread. Worst case
    is a few seconds, never a hang. A dir pinned by an unreleasable handle is
    made unlistable and swept at the next boot — the response is still
    ``{ok:true}`` because the session is gone from the store either way.

    The frontend shows the confirm dialog; this endpoint just performs the
    permanent delete. 404 if the caller does not own the session.
    """
    if not await sessions.delete(user, session_id):
        raise deps.http_error(404, "session_not_found", "session not found")
    return {"ok": True}
