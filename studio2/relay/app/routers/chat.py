"""Chat — the agent turn over the turn-survival buffer (arch §2.2).

* ``POST /api/chat`` ``{message, project_id, device_id}`` → starts the turn
  as a DETACHED task (``core/turns.py``) and streams the buffer back as SSE.
  409 ``turn_in_progress`` when this (device, project) already has a live
  turn. The response is a PURE READER: the phone locking mid-stream no
  longer aborts the turn or drops the reply (the 06-11 incident fix — the
  v1 generator-tied lifetime this file replaces).
* ``GET /api/chat/attach?project_id=&device_id=&after_seq=`` → replays the
  buffered live/most-recent turn from ``after_seq`` (then live-follows a
  still-running turn to ``turn_end``); 404 ``no_active_turn`` when no buffer
  exists (none yet, or swept 10 min past turn end).
* ``POST /api/chat/cancel`` ``{project_id, device_id}`` → cancels the turn's
  pending bridge commands AND interrupts the SDK turn; ``{cancelled: bool}``.

NO history endpoint — the transcript lives on the device (arch §9.3); the
relay forgets each turn 10 minutes after it ends.

Event vocabulary (exactly arch §2.2, every frame ``id:``-seq'd for resume):
``turn_start {turn_id}`` · ``assistant_delta {turn_id, text}`` ·
``tool_start {turn_id, tool_call_id, tool, input_summary}`` ·
``tool_input {tool_call_id, input_summary}`` ·
``tool_end {tool_call_id, ok, summary}`` ·
``turn_end {turn_id, stop_reason, text}`` · ``error {turn_id?, code,
message}``. There is NO ``ask_user`` event here — questions travel the
bridge (arch §3.4), which is what makes them survive a locked phone. Both
streams heartbeat (``: hb`` every ~20 s) while idle: an ``ask_user``-parked
turn can sit quiet for minutes and middleboxes must not reap it.

CSRF posture (v1 invariant): a chat turn is state-changing (it invokes the
SDK and consumes tokens), so it is POST + JSON body only — a cross-site form
cannot send ``application/json``. The attach GET is a read-only replay of
the caller's own buffer. Auth: ``require_session`` on all three.

Logging (``studio2.chat``): message LENGTH only, never content.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..core import applog, events, turns
from ..core.bridge import cancel_for_turn
from . import deps

router = APIRouter(prefix="/api", tags=["chat"])

_log = logging.getLogger("studio2.chat")

_PROJECT_ID_RE = re.compile(r"^prj_[0-9a-f]{12}$")
_DEVICE_ID_RE = re.compile(r"^dev_[0-9a-f]{16}$")
# DoS guard only (no contract value specifies a cap): a single chat message
# has no business being near this size, and an unbounded string would ride
# into the SDK subprocess unchecked.
_MAX_MESSAGE_CHARS = 100_000

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _validated_key(user: str, project_id: str, device_id: str) -> turns.TurnKey:
    if not isinstance(project_id, str) or not _PROJECT_ID_RE.match(project_id):
        raise deps.http_error(
            400, "invalid_project_id", "project_id must match prj_<12 hex chars>"
        )
    if not isinstance(device_id, str) or not _DEVICE_ID_RE.match(device_id):
        raise deps.http_error(
            400, "invalid_device_id", "device_id must match dev_<16 hex chars>"
        )
    return (user, device_id, project_id)


class ChatBody(BaseModel):
    message: str
    project_id: str
    device_id: str


@router.post("/chat")
async def chat(
    body: ChatBody, user: str = Depends(deps.require_session)
) -> StreamingResponse:
    key = _validated_key(user, body.project_id, body.device_id)
    message = body.message
    if not message.strip():
        raise deps.http_error(400, "invalid_body", "message must not be empty")
    if len(message) > _MAX_MESSAGE_CHARS:
        raise deps.http_error(
            413, "payload_too_large",
            f"message exceeds {_MAX_MESSAGE_CHARS} characters",
        )

    # Import here (not module top) so the relay can boot and serve everything
    # non-agent even if the SDK install is broken — the failure then surfaces
    # as a clean 500 on /api/chat instead of an ImportError at startup.
    from ..agent import session as agent_session

    sess = agent_session.get_session(user, body.device_id, body.project_id)
    try:
        buf = turns.start_turn(key, sess.send(message))
    except turns.TurnInProgress:
        raise deps.http_error(
            409, "turn_in_progress",
            "a turn is already running for this project on this device",
        )

    _log.info(
        "chat post user=%s device_id=%s project_id=%s msg_chars=%d",
        applog.sanitize_log_value(user, 64), body.device_id, body.project_id,
        len(message),
    )

    async def stream():
        yield events.sse_comment("connected")
        async for frame in turns.read(buf, after_seq=0):
            yield frame

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@router.get("/chat/attach")
async def attach(
    project_id: str = Query(...),
    device_id: str = Query(...),
    after_seq: int = Query(0, ge=0),
    user: str = Depends(deps.require_session),
) -> StreamingResponse:
    key = _validated_key(user, project_id, device_id)
    buf = turns.get_buffer(key)
    if buf is None:
        raise deps.http_error(
            404, "no_active_turn",
            "no live or recent turn exists for this project on this device",
        )

    _log.info(
        "chat attach user=%s device_id=%s project_id=%s after_seq=%d live=%s",
        applog.sanitize_log_value(user, 64), device_id, project_id,
        after_seq, not buf.done,
    )

    async def stream():
        yield events.sse_comment("connected")
        async for frame in turns.read(buf, after_seq=after_seq):
            yield frame

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


class CancelBody(BaseModel):
    project_id: str
    device_id: str


@router.post("/chat/cancel")
async def cancel(
    body: CancelBody, user: str = Depends(deps.require_session)
) -> JSONResponse:
    key = _validated_key(user, body.project_id, body.device_id)

    turn_id = turns.active_turn_id(key)
    if turn_id is None:
        return JSONResponse(content={"cancelled": False})

    # Unblock pending bridge commands FIRST (a turn parked on ask_user must
    # not wait out its 600 s timeout), then interrupt the SDK turn. The
    # session also re-cancels by turn_id internally — both are idempotent.
    cancel_for_turn(turn_id)

    from ..agent import session as agent_session

    sess = agent_session.peek_session(user, body.device_id, body.project_id)
    if sess is not None:
        await sess.cancel()

    _log.info(
        "chat cancel user=%s device_id=%s project_id=%s turn_id=%s",
        applog.sanitize_log_value(user, 64), body.device_id, body.project_id,
        turn_id,
    )
    return JSONResponse(content={"cancelled": True})
