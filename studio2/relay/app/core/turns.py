"""Turn-survival buffer (arch §2.2 + §10.5 — IN SCOPE per PM resolution #2).

Each agent turn runs as a DETACHED ``asyncio.Task`` that writes its SSE
events into a bounded, seq'd ring buffer keyed by
``(user, device_id, project_id)``. The ``POST /api/chat`` response and the
``GET /api/chat/attach`` endpoint are both PURE READERS of that buffer — a
mid-turn disconnect (the phone locking is the canonical case; it cost the
user a finished render on 06-11) no longer aborts the turn or drops the
assistant reply. On unlock, the PWA calls ``attach`` with the last seq it
saw and catches up, including ``turn_end``.

Buffer discipline (arch §1.2/§8.6):

* one buffer per key — the LIVE turn, or the MOST-RECENT finished turn
* ring-bounded: ≤ ``MAX_EVENTS`` (1000) frames AND ≤ ``MAX_BYTES`` (2 MB);
  overflow evicts the OLDEST frames (a reader attaching below the evicted
  range simply misses frames it almost certainly already received live)
* kept ``KEEP_AFTER_END_S`` (10 min) past turn end, then swept lazily on the
  next ``start_turn`` / ``get_buffer`` call (no background timer needed at
  household scale)
* per-turn seq starts at 1; every frame is emitted via ``events.sse_id`` so
  EventSource-style ``after_seq`` resume works exactly like the bridge stream

Concurrency: a second ``POST /api/chat`` for a key whose buffer is still live
raises :class:`TurnInProgress` (the router maps it to 409
``turn_in_progress``). The detached task is the ONLY writer; readers
synchronize on the buffer's ``asyncio.Condition`` and heartbeat (``: hb``
comment every ~20 s) while waiting, so an ``ask_user``-parked turn cannot be
idled out by a middlebox. Readers never mutate shared state and hold no
resources — tearing one down mid-turn is free (that is the whole point).

Logging (``studio2.chat``): one line at turn start and one at turn end with
outcome + duration + event count. Message CONTENT is never logged.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from . import bridge, events

_log = logging.getLogger("studio2.chat")

MAX_EVENTS = 1000          # frames per buffer (ring)
MAX_BYTES = 2 * 1024 * 1024  # bytes per buffer (ring)
KEEP_AFTER_END_S = 600.0   # finished buffers stay attachable this long
_HEARTBEAT_S = 20.0

TurnKey = tuple[str, str, str]  # (user, device_id, project_id)


class TurnInProgress(Exception):
    """A live turn already exists for this (user, device, project)."""


@dataclass
class TurnBuffer:
    """The seq'd event ring for one turn. Written ONLY by the detached task."""

    key: TurnKey
    turn_id: str | None = None
    created_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    done: bool = False
    frames: list[tuple[int, str]] = field(default_factory=list)  # (seq, sse frame)
    total_bytes: int = 0
    next_seq: int = 1
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)

    async def append(self, event_type: str, data: dict[str, Any]) -> None:
        """Frame + store one event, evicting oldest past the ring caps."""
        async with self.cond:
            seq = self.next_seq
            self.next_seq += 1
            frame = events.sse_id(event_type, seq, data)
            self.frames.append((seq, frame))
            self.total_bytes += len(frame.encode("utf-8"))
            while self.frames and (
                len(self.frames) > MAX_EVENTS or self.total_bytes > MAX_BYTES
            ):
                _s, old = self.frames.pop(0)
                self.total_bytes -= len(old.encode("utf-8"))
            self.cond.notify_all()

    async def finish(self) -> None:
        async with self.cond:
            self.done = True
            self.ended_at = time.time()
            self.cond.notify_all()


_buffers: dict[TurnKey, TurnBuffer] = {}


def _sweep() -> None:
    cutoff = time.time() - KEEP_AFTER_END_S
    for key in [
        k for k, b in _buffers.items()
        if b.done and b.ended_at is not None and b.ended_at < cutoff
    ]:
        _buffers.pop(key, None)


def get_buffer(key: TurnKey) -> TurnBuffer | None:
    """The live or most-recent buffer for ``key`` (None when empty/expired)."""
    _sweep()
    return _buffers.get(key)


def active_turn_id(key: TurnKey) -> str | None:
    """The turn_id of a LIVE (not finished) turn on ``key``, else None."""
    buf = _buffers.get(key)
    if buf is not None and not buf.done:
        return buf.turn_id
    return None


def start_turn(
    key: TurnKey, turn_events: AsyncIterator[tuple[str, dict[str, Any]]]
) -> TurnBuffer:
    """Create the buffer for a new turn and launch the detached writer task.

    ``turn_events`` is ``AgentSession.send(message)`` — an async generator of
    ``(event_type, data)`` tuples that never raises by design (errors arrive
    as ``error`` + ``turn_end`` events). Raises :class:`TurnInProgress` when
    the key already has a live turn (arch §2.2 → 409). MUST be called from a
    running event loop (the chat router's async handler).
    """
    _sweep()
    existing = _buffers.get(key)
    if existing is not None and not existing.done:
        raise TurnInProgress()

    buf = TurnBuffer(key=key)
    _buffers[key] = buf
    asyncio.get_running_loop().create_task(
        _pump(buf, turn_events), name=f"studio2-turn-{key[2]}"
    )
    return buf


async def _pump(
    buf: TurnBuffer, turn_events: AsyncIterator[tuple[str, dict[str, Any]]]
) -> None:
    """The detached writer: drain the agent turn into the buffer.

    Lives independently of every HTTP response — readers come and go; this
    task runs the turn to completion regardless (the 06-11 incident fix).
    Belt-and-braces: ``AgentSession.send`` never raises, but if anything DOES
    escape, the buffer still receives ``error`` + ``turn_end`` and is marked
    done, so no reader can hang on a wedged turn.
    """
    t0 = time.perf_counter()
    outcome = "incomplete"
    n_events = 0
    saw_turn_end = False
    try:
        async for event_type, data in turn_events:
            if buf.turn_id is None and event_type == "turn_start":
                buf.turn_id = data.get("turn_id")
                _log.info(
                    "turn start turn_id=%s device_id=%s project_id=%s",
                    buf.turn_id, buf.key[1], buf.key[2],
                )
            await buf.append(event_type, data)
            n_events += 1
            if event_type == "turn_end":
                saw_turn_end = True
                outcome = "error" if data.get("stop_reason") == "error" else "ok"
        if not saw_turn_end:
            # The generator ended without a terminal frame (should not happen;
            # AgentSession always closes with turn_end). Synthesize one so
            # attached readers terminate cleanly.
            await buf.append(
                "turn_end", {"turn_id": buf.turn_id, "stop_reason": "error", "text": ""}
            )
            outcome = "error"
    except Exception as exc:  # noqa: BLE001 - the detached task must never die silently
        outcome = "error"
        try:
            await buf.append(
                "error",
                {"turn_id": buf.turn_id, "code": "agent_error", "message": str(exc)},
            )
            await buf.append(
                "turn_end", {"turn_id": buf.turn_id, "stop_reason": "error", "text": ""}
            )
        except Exception:  # noqa: BLE001 - appending must not mask the original failure
            pass
    finally:
        await buf.finish()
        # Defensive: a turn that ends with commands still pending (e.g. the
        # SDK tore down a tool task without resolving) must not strand
        # Futures until their timeout. Normal turns have nothing pending here.
        if buf.turn_id:
            try:
                bridge.cancel_for_turn(buf.turn_id)
            except Exception:  # noqa: BLE001
                pass
        _log.info(
            "turn end turn_id=%s outcome=%s duration_ms=%d events=%d buffered_bytes=%d",
            buf.turn_id, outcome, int((time.perf_counter() - t0) * 1000),
            n_events, buf.total_bytes,
        )


async def read(buf: TurnBuffer, after_seq: int = 0) -> AsyncIterator[str]:
    """PURE READER: yield buffered frames with seq > ``after_seq``, then
    follow the live turn until ``turn_end``, heartbeating while idle.

    Yields ready-to-send SSE strings (frames already carry ``id:``).
    Multiple concurrent readers are fine; a reader dying mid-turn affects
    nothing (no shared mutation, no yield inside a finally — the v1 BUG-15
    hazard has no surface here).
    """
    last = after_seq
    while True:
        batch: list[str] = []
        heartbeat = False
        async with buf.cond:
            for seq, frame in buf.frames:
                if seq > last:
                    batch.append(frame)
                    last = seq
            if not batch:
                if buf.done:
                    return
                try:
                    await asyncio.wait_for(buf.cond.wait(), timeout=_HEARTBEAT_S)
                except (asyncio.TimeoutError, TimeoutError):
                    heartbeat = True
        for frame in batch:
            yield frame
        if heartbeat:
            yield events.sse_comment("hb")
