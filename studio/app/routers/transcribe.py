"""Transcription: start a job + stream progress (contract §7-§9).

* POST /api/transcribe              -> 202 {job_id, files, already_cached}
* GET  /api/transcribe/{job}/events -> SSE progress/file_done/done/error
* GET  /api/transcribe/{job}        -> non-stream snapshot for reconnect

The job runs in a background task; the SSE endpoint polls the shared job record
and the per-job event buffer. Single-flight: a second start returns
409 job_in_flight. The browser sends the session cookie automatically on the SSE
request (no token-in-URL).

Per-user session model: ``POST /api/transcribe`` carries ``session_id`` in its
body and the SSE/snapshot endpoints carry it as a query param; the session is
resolved to the caller's OWNED dir via ``deps.require_session_dir`` (uniform
404 session_not_found on a bad / cross-user / missing id). Starting a job touches
the session's stale clock.
"""

from __future__ import annotations

import asyncio
from collections import deque
from typing import Any, Deque

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from ..core import jobs, sessions
from ..core.events import sse, sse_comment
from ..helpers_wrap import transcribe as transcribe_wrap
from . import deps

router = APIRouter(prefix="/api", tags=["transcribe"])

# Per-job SSE event buffers (job_id -> deque of (event, data)). The worker
# appends; the SSE endpoint drains. Bounded so a never-consumed buffer can't grow
# without limit.
_buffers: dict[str, Deque[tuple[str, dict]]] = {}

# How long a finished job's buffer lingers so an in-flight/reconnecting client
# can still drain its terminal frame before it is evicted (BUG-19).
_BUFFER_GRACE_SECS = 30.0


def _terminal_frame(job: "jobs.Job") -> tuple[str, dict]:
    """Synthesize the terminal SSE frame for an already-finished job.

    Mirrors the exact shapes the worker appends so the frontend's idempotent
    ``done`` / ``error`` handlers fire even when the live buffer was already
    drained or evicted (BUG-03 / BUG-19). Reads ``job.snapshot()``.
    """
    snap = job.snapshot()
    status = snap.get("status")
    if status == "done":
        result = snap.get("result") or {}
        return "done", {
            "job_id": job.job_id,
            "ok": True,
            "packed": result.get("packed"),
            "transcribed": result.get("transcribed"),
            "cached": result.get("cached"),
        }
    # error / cancelled (or any non-done terminal state) -> an ``error`` frame.
    err = snap.get("error") or {}
    if status == "cancelled":
        code = "cancelled"
        message = "transcription cancelled"
    else:
        code = err.get("code") or "transcribe_failed"
        message = err.get("message") or "transcription failed"
    return "error", {"job_id": job.job_id, "code": code, "message": message}


async def _evict_buffer(job_id: str) -> None:
    """Drop a finished job's event buffer after a short grace window so it does
    not leak for the process lifetime (BUG-19).
    """
    await asyncio.sleep(_BUFFER_GRACE_SECS)
    _buffers.pop(job_id, None)


class TranscribeBody(BaseModel):
    session_id: str | None = None
    files: list[str] | None = None
    workers: int = 4
    language: str | None = None
    num_speakers: int | None = None
    pack: bool = True


@router.post("/transcribe", status_code=202)
async def start_transcribe(
    body: TranscribeBody,
    user: str = Depends(deps.require_session),
) -> JSONResponse:
    _user, session_id, folder = deps.require_session_dir(user, body.session_id)
    # Starting a transcribe is activity on the session — reset its stale clock.
    sessions.touch(user, session_id)

    job, running = jobs.registry.create("transcribe", "trx")
    if job is None:
        raise deps.http_error(
            409, "job_in_flight", "a transcription job is already running",
            detail={"job_id": running.job_id},
        )

    pre = transcribe_wrap.plan(folder, body.files)
    buf: Deque[tuple[str, dict]] = deque(maxlen=2000)
    _buffers[job.job_id] = buf

    async def on_progress(snap: dict) -> None:
        buf.append(("progress", {
            "job_id": job.job_id,
            "done": snap.get("done"),
            "total": snap.get("total"),
            "current": snap.get("current"),
            "percent": snap.get("percent"),
            "phase": snap.get("phase"),
        }))

    async def on_file_done(ev: dict) -> None:
        buf.append(("file_done", {
            "name": ev.get("name"),
            "cached": ev.get("cached", False),
            "transcript": ev.get("transcript"),
        }))

    async def worker() -> None:
        try:
            result = await transcribe_wrap.run_job(
                job, folder,
                files=body.files,
                workers=body.workers,
                language=body.language,
                num_speakers=body.num_speakers,
                do_pack=body.pack,
                on_progress=on_progress,
                on_file_done=on_file_done,
            )
            if result.get("ok"):
                buf.append(("done", {
                    "job_id": job.job_id,
                    "ok": True,
                    "packed": result.get("packed"),
                    "transcribed": result.get("transcribed"),
                    "cached": result.get("cached"),
                }))
            else:
                buf.append(("error", {
                    "job_id": job.job_id,
                    "code": result.get("code", "transcribe_failed"),
                    "message": result.get("message", "transcription failed"),
                }))
        except Exception as exc:  # noqa: BLE001
            job.finish_error("exception", str(exc))
            buf.append(("error", {"job_id": job.job_id, "code": "exception", "message": str(exc)}))
        finally:
            jobs.registry.release(job.job_id)
            # Evict this job's buffer after a short grace window so a connected
            # or reconnecting client can drain it first; a late reconnect then
            # gets buf=None and the stream synthesizes the terminal frame from
            # the job snapshot (BUG-19, dovetails with BUG-03). In-flight streams
            # hold their own local ``buf`` reference, so the pop is safe.
            asyncio.create_task(_evict_buffer(job.job_id))

    asyncio.create_task(worker())

    return JSONResponse(
        status_code=202,
        content={
            "job_id": job.job_id,
            "files": pre["files"],
            "already_cached": pre["already_cached"],
        },
    )


@router.get("/transcribe/{job_id}/events")
async def transcribe_events(
    job_id: str,
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> StreamingResponse:
    # Confirm the caller owns the session before streaming any job state.
    deps.require_session_dir(user, session_id)
    job = jobs.registry.get(job_id)
    if job is None:
        raise deps.http_error(404, "not_found", "job not found")

    async def stream():
        buf = _buffers.get(job_id)
        yield sse_comment("connected")
        # Stream until the job is terminal AND the buffer is drained.
        while True:
            drained = False
            if buf:
                while buf:
                    event, data = buf.popleft()
                    yield sse(event, data)
                    drained = True
            # ``buf`` may be None (BUG-19 eviction after the grace window) or
            # already empty (a prior dropped connection drained the terminal
            # frame). On reconnect we must still deliver a terminal event, so
            # synthesize it from the job snapshot. Frontend handlers are
            # idempotent, so a rare double-delivery is harmless (BUG-03).
            if job.is_terminal and not buf:
                event, data = _terminal_frame(job)
                yield sse(event, data)
                break
            if not drained:
                yield sse_comment("ping")
            await asyncio.sleep(0.5)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/transcribe/{job_id}")
def transcribe_snapshot(
    job_id: str,
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> dict[str, Any]:
    deps.require_session_dir(user, session_id)
    job = jobs.registry.get(job_id)
    if job is None:
        raise deps.http_error(404, "not_found", "job not found")
    snap = job.snapshot()
    return {
        "status": snap["status"],
        "done": snap["done"],
        "total": snap["total"],
        "percent": snap["percent"],
        "error": snap["error"],
    }
