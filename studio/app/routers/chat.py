"""Chat — the embedded agent over SSE (contract §13-§15).

* POST /api/chat            -> SSE: turn_start, assistant_delta, tool_start,
  tool_progress, tool_end, ask_user, turn_end, error.
* POST /api/chat/cancel     -> interrupt the current turn.
* POST /api/chat/answer     -> resolve a pending ask_user question (the agent is
  blocked awaiting the browser's answer to a multiple-choice question emitted as
  an ``ask_user`` SSE event). A normal POST + JSON body — NOT a stream.
* GET  /api/chat/history    -> persisted transcript for the session.

Per-user session model: every chat call carries a ``session_id`` (in the JSON
body for the POSTs, as a query param for the GET). The session is resolved to the
caller's OWNED directory via ``deps.require_session_dir`` (the ownership
chokepoint) — a bad / cross-user / missing id is one uniform
``404 session_not_found``. The old global ``active_folder`` and its
``no_active_folder`` / ``folder_mismatch`` 409s are gone.

A chat turn is **state-changing** (it invokes the Claude Agent SDK and consumes
tokens), so it MUST NOT be reachable via GET. With a ``SameSite=Lax`` session
cookie, a cross-site top-level GET navigation would still carry the cookie, so a
GET trigger would be CSRF-able. Standardizing on ``POST /api/chat`` with a JSON
body (parsed by the ``ChatBody`` Pydantic model) blocks cross-site forgery: a
cross-site HTML form can only send the "simple" content-types
(``application/x-www-form-urlencoded`` / ``multipart/form-data`` / ``text/plain``),
which FastAPI rejects for a JSON body — so no agent turn is ever invoked.

One AgentSession per user session is cached in ``core.sessions`` keyed by
``session_id`` (so the same object — and its ``ask_user`` Futures — is reused
across turns). The session yields Studio SSE event tuples; this router serializes
them and persists the user + assistant messages so a reload restores the
conversation. Touches ``last_touched_at`` at the start of each turn.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..agent import AgentSession
from ..core import persist, sessions
from ..core.events import sse, sse_comment
from . import deps

router = APIRouter(prefix="/api", tags=["chat"])

# Agent-turn diagnostics (rotating file log; see core/applog.py). One line at
# turn start and one at turn end (with duration + how it ended). The message
# CONTENT is never logged — only its length. Observation only.
_log = logging.getLogger("studio.agent")


def _find_tool_call(tool_calls: list[dict], tool_call_id: str | None) -> dict | None:
    """Return the persisted tool-call entry with this id, or None."""
    if not tool_call_id:
        return None
    for tc in tool_calls:
        if tc.get("tool_call_id") == tool_call_id:
            return tc
    return None


def _get_session(session_id: str, folder: Path) -> AgentSession:
    """Return the cached AgentSession for ``session_id``, creating it if needed.

    The SAME object is returned across turns so the ``ask_user`` pending-question
    Futures survive (the cache lives in ``core.sessions``, keyed by session_id).
    """
    sess = sessions.get_agent(session_id)
    if sess is None:
        sess = AgentSession(folder, session_id=session_id)
        sessions.set_agent(session_id, sess)
    return sess


class ChatBody(BaseModel):
    message: str
    session_id: str | None = None


async def _run_stream(session_id: str, folder: Path, message: str):
    """Async generator producing SSE frames for one agent turn."""
    session = _get_session(session_id, folder)

    # Persist the user message immediately.
    persist.append_message(folder, {"role": "user", "content": message})

    yield sse_comment("connected")

    assistant_text_parts: list[str] = []
    tool_calls: list[dict] = []

    # Turn-end diagnostics: "ok" once a turn_end event was streamed, "error"
    # when the stream raised, and "incomplete" when the generator was torn
    # down before either (the browser/tab dropped mid-turn — exactly the
    # silent-phone signature this logging exists to catch). The log call
    # lives in `finally` (NEVER a yield there — the BUG-15 hazard).
    t0 = time.perf_counter()
    turn_outcome = "incomplete"

    try:
        async for event_type, data in session.send(message):
            yield sse(event_type, data)
            if event_type == "assistant_delta":
                assistant_text_parts.append(data.get("text", ""))
            elif event_type == "tool_start":
                tool_calls.append({
                    "tool": data.get("tool"),
                    "tool_call_id": data.get("tool_call_id"),
                    "input_summary": data.get("input_summary", ""),
                })
            elif event_type == "tool_input":
                # The relay refines the input summary once the tool input has
                # streamed in; merge it so reloaded history shows the real input.
                tc = _find_tool_call(tool_calls, data.get("tool_call_id"))
                if tc is not None:
                    summary = data.get("input_summary")
                    if summary:
                        tc["input_summary"] = summary
            elif event_type == "tool_end":
                # Merge the tool's outcome so reloaded history reflects real
                # success/failure (not a blanket green "done").
                tc = _find_tool_call(tool_calls, data.get("tool_call_id"))
                if tc is not None:
                    tc["ok"] = data.get("ok", True)
                    tc["summary"] = data.get("summary", "")
            elif event_type == "turn_end":
                turn_outcome = "ok"
                # Prefer the consolidated text the relay reports, if any.
                final_text = data.get("text") or "".join(assistant_text_parts)
                persist.append_message(folder, {
                    "role": "assistant",
                    "content": final_text,
                    "tool_calls": tool_calls,
                })
    except Exception as exc:  # noqa: BLE001 - never crash the stream
        turn_outcome = "error"
        yield sse("error", {"code": "stream_error", "message": str(exc)})
        yield sse("turn_end", {"stop_reason": "error"})
    finally:
        _log.info(
            "turn end session_id=%s outcome=%s duration_ms=%s tool_calls=%s",
            session_id, turn_outcome,
            int((time.perf_counter() - t0) * 1000), len(tool_calls),
        )


_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


@router.post("/chat")
async def chat(body: ChatBody, user: str = Depends(deps.require_session)) -> StreamingResponse:
    _user, session_id, folder = deps.require_session_dir(user, body.session_id)
    # A chat turn is activity on the session — reset its stale clock.
    sessions.touch(user, session_id)
    _log.info(
        "turn start session_id=%s user=%s msg_chars=%s",
        session_id, user, len(body.message),
    )
    return StreamingResponse(
        _run_stream(session_id, folder, body.message),
        media_type="text/event-stream",
        headers=_SSE_HEADERS,
    )


class CancelBody(BaseModel):
    session_id: str | None = None
    turn_id: str | None = None


@router.post("/chat/cancel")
async def cancel(body: CancelBody, user: str = Depends(deps.require_session)) -> JSONResponse:
    _user, session_id, _folder = deps.require_session_dir(user, body.session_id)
    session = sessions.get_agent(session_id)
    if session is not None:
        await session.cancel()
        return JSONResponse(content={"cancelled": True})
    return JSONResponse(content={"cancelled": False})


class AnswerItem(BaseModel):
    header: str
    selected: list[str] = []
    other_text: str | None = None


class AnswerBody(BaseModel):
    session_id: str | None = None
    turn_id: str
    question_id: str
    answers: list[AnswerItem] = []


@router.post("/chat/answer")
async def answer(body: AnswerBody, user: str = Depends(deps.require_session)) -> JSONResponse:
    """Resolve a pending ``ask_user`` question for the caller's session.

    The agent turn is blocked inside the ``ask_user`` tool awaiting this answer
    (it was announced via an ``ask_user`` SSE event carrying ``turn_id`` +
    ``question_id``). We look up the cached AgentSession for ``session_id``,
    resolve the matching pending Future keyed by (turn_id, question_id), and the
    tool unblocks and feeds the selections back to the model. A normal POST —
    never a stream.
    """
    _user, session_id, _folder = deps.require_session_dir(user, body.session_id)
    session = sessions.get_agent(session_id)
    if session is None:
        raise deps.http_error(
            409, "no_pending_question", "no active agent session for this session"
        )

    answers = [a.model_dump() for a in body.answers]
    resolved = session.resolve_question(body.turn_id, body.question_id, answers)
    if not resolved:
        # Already answered, timed out, the turn was cancelled, or a stale tab is
        # answering a question from a turn that is no longer running. Not a server
        # fault — surface a 409 the frontend can ignore/clean up, never a 500.
        raise deps.http_error(
            409,
            "no_pending_question",
            "no pending question matches this turn_id/question_id",
        )
    return JSONResponse(content={"ok": True})


@router.get("/chat/history")
def history(
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> dict:
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    return {"messages": persist.load_transcript(folder)}
