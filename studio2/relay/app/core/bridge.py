"""THE DEVICE-TOOL BRIDGE — server half (arch §2.3 + §3, the authoritative
contract).

Generalizes v1's field-proven ``ask_user`` mechanism (``studio/app/agent/
tools.py`` + ``session.py``): a tool handler registers an ``asyncio.Future``,
pushes a JSON event to the browser, and awaits the Future that an
authenticated POST resolves. v2 changes only the scale — the Future registry
is keyed by ``command_id``, the push channel is the device's long-lived SSE
stream (``GET /api/bridge/events``), and the resolver is
``POST /api/bridge/result``.

Data structures (all in-memory, all on the ONE event loop / ONE process —
the serve.py invariant):

* ``_channels`` — per-``(user, device_id)`` persistent state: the monotonic
  per-device ``seq`` counter (survives stream reconnects so ``Last-Event-ID``
  replay filtering stays meaningful) and the ACTIVE stream connection
  (``None`` while the device is offline). A second connect for the same pair
  SUPERSEDES the first — newest wins (zombie streams after iOS tab
  resurrection, arch §2.3).
* ``_pending`` — the Future registry keyed by ``command_id``
  (``cmd_<hex12>``). Each entry records the OWNING ``(user, device_id)`` so a
  result POST can never resolve another user's / another device's command
  (arch §8.6 IDOR bullet), plus ``turn_id`` for cancellation grouping and
  ``seq`` for ``Last-Event-ID`` replay.

Replay (arch §3.3/§3.6): on reconnect the relay re-sends ONLY commands whose
Futures are still pending, with ``seq`` greater than the client's
``Last-Event-ID`` (a missing/garbage header is treated as 0 — i.e. replay
every still-pending command: a fresh page never saw them, and an undelivered
pending command is a guaranteed ``command_timeout``). Replayed frames keep
their ORIGINAL seq; the device dedupes by ``command_id`` either way.

Error taxonomy (arch §3.5) — raised as :class:`BridgeError`, rendered to the
model by ``agent/tools.py`` as ``ERROR <code>: <message>``:

* ``device_offline``   — no open bridge stream at dispatch time (immediate;
  M1 has no store-and-forward, arch §10.10).
* ``command_timeout``  — the device did not answer within ``timeout_s``. The
  Future is removed; a LATE result POST gets 409 ``no_pending_command``.
* ``cancelled``        — the turn was cancelled while the command was pending
  (:func:`cancel_for_turn`).
* ``project_mismatch`` / ``engine_error`` / ``storage_error`` — produced by
  the DEVICE (its result POST carries ``ok:false`` + ``error{code,message}``);
  any code outside that device set degrades to ``engine_error`` with the
  original code folded into the message (defense in depth — the model only
  ever sees taxonomy codes).
* ``too_many_pending`` — the §8.6 per-turn cap (16) tripped. Not in the §3.5
  table (it is a DoS guard, not a protocol state); rendered identically.

Caps (arch §8.6): 8 live streams per user (the 9th DISTINCT device is
rejected; a reconnect of an EXISTING device supersedes and never counts
against the cap), 16 pending commands per turn, and a bounded per-connection
outbound queue (a backlogged stream fails dispatch cleanly instead of
growing without bound).

Logging (``studio2.bridge``): command/connection lifecycle with ids, tool
names, outcomes and durations — NEVER params or result content (lengths
only); device-supplied strings pass ``sanitize_log_value`` first.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from .. import settings
from . import applog, events

_log = logging.getLogger("studio2.bridge")

# --- caps (arch §8.6) -------------------------------------------------------
MAX_DEVICES_PER_USER = 8     # live bridge streams per user
MAX_PENDING_PER_TURN = 16    # in-flight commands per agent turn
_QUEUE_MAX = 256             # outbound frames per connection (defensive only)

# Changes on relay restart so devices can drop stale local expectations
# (arch §2.3). ``b_<hex4>`` per the contract example.
SERVER_BOOT_ID: str = f"b_{secrets.token_hex(2)}"

# Tools that may cross the bridge (defense in depth — agent/tools.py already
# only dispatches these). read_transcript and find_in_transcript are real
# device dispatches as of M2/T3 (the M1 relay-side stub is gone); view_frames
# is the Agent Vision tool (plan 2026-06-13) — without it here, bridge.dispatch
# would reject view_frames with invalid_params 'unknown tool' BEFORE it reaches
# the device (the same allowlist gate find_in_transcript needed in M2).
_BRIDGE_TOOLS = frozenset({
    "get_inventory", "describe_clip", "apply_cuts", "undo_last_edit",
    "read_edl", "read_transcript", "find_in_transcript", "view_frames",
    "ask_user",
})

# M3 render-tier tools (arch §7.1) — GATED on settings.render_enabled() (the
# same find_in_transcript/view_frames allowlist gotcha, but flag-conditional).
# They are admitted to the bridge ONLY while the render tier is turned on; with
# the flag OFF (the default) they are absent, so even if one were somehow
# dispatched it is blocked with invalid_params 'unknown tool' before reaching
# the device — and agent/tools.py never registers them in the first place. The
# flag is read PER-DISPATCH (via _bridge_tools()) so flipping the config/env
# takes effect without a code change here. view_frames stays UNCONDITIONALLY in
# _BRIDGE_TOOLS above — it ships regardless of the render flag.
_M3_BRIDGE_TOOLS = frozenset({
    "set_output_format", "set_clip_fit", "list_music_library",
    "add_music", "update_music", "remove_music",
})


def _bridge_tools() -> frozenset[str]:
    """The dispatch allowlist for the CURRENT render-flag state: the always-on
    base set, plus the six M3 tools only while ``settings.render_enabled()`` is
    true. Read per-dispatch so a flag flip needs no restart of this module."""
    if settings.render_enabled():
        return _BRIDGE_TOOLS | _M3_BRIDGE_TOOLS
    return _BRIDGE_TOOLS

# Device-producible error codes (arch §3.5). Anything else a device sends
# degrades to engine_error so the model only ever sees taxonomy codes.
_DEVICE_ERROR_CODES = frozenset({"project_mismatch", "engine_error", "storage_error"})

# Channels with no live stream AND no pending commands are swept after this
# idle window (they are tiny — this is hygiene, not a correctness need; the
# ``hello`` frame's ``id: 0`` re-bases the client's Last-Event-ID on every
# connect, so dropping a long-dead channel's seq counter is safe).
_CHANNEL_IDLE_SWEEP_S = 24 * 3600


class BridgeError(Exception):
    """A tool-visible bridge failure (arch §3.5). ``code`` is the taxonomy
    code; ``message`` is plain language for the model."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass
class _Connection:
    """One live SSE stream. ``queue`` carries pre-framed SSE strings; ``None``
    is the close sentinel (pushed when a newer stream supersedes this one)."""

    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=_QUEUE_MAX))
    connected_at: float = field(default_factory=time.time)


@dataclass
class _Channel:
    """Persistent per-(user, device_id) state surviving stream reconnects."""

    user: str
    device_id: str
    seq: int = 0                      # last assigned per-device seq
    conn: _Connection | None = None   # the ACTIVE stream (None = offline)
    last_seen: float = field(default_factory=time.time)

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq


@dataclass
class _Pending:
    """One in-flight command awaiting its device result."""

    command_id: str
    user: str
    device_id: str
    turn_id: str
    project_id: str
    tool: str
    seq: int
    timeout_s: float
    issued_at_ms: int
    frame: str                        # the exact SSE frame, for replay
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())
    cancelled_by_turn: bool = False


_channels: dict[tuple[str, str], _Channel] = {}
_pending: dict[str, _Pending] = {}


# ============================================================================
# Stream registry (called by routers/bridge.py)
# ============================================================================

def live_streams_for_user(user: str, *, exclude_device: str | None = None) -> int:
    """How many DISTINCT devices currently hold a live stream for ``user``."""
    return sum(
        1
        for (u, d), ch in _channels.items()
        if u == user and ch.conn is not None and d != exclude_device
    )


def connect(
    user: str, device_id: str, last_event_id: int
) -> tuple[_Connection, list[str], int]:
    """Register a new stream for ``(user, device_id)``.

    Returns ``(connection, replay_frames, replayed_count)``. Supersedes any
    existing stream for the same pair (newest wins — the old generator gets a
    ``None`` sentinel and ends). Raises :class:`BridgeError`
    (``too_many_devices``) when the user already holds
    ``MAX_DEVICES_PER_USER`` live streams on OTHER devices — the router maps
    this to 409 BEFORE streaming starts (and re-checks here against the
    handler→generator race).
    """
    _sweep_channels()
    if live_streams_for_user(user, exclude_device=device_id) >= MAX_DEVICES_PER_USER:
        raise BridgeError(
            "too_many_devices",
            f"this account already has {MAX_DEVICES_PER_USER} connected devices",
        )

    key = (user, device_id)
    channel = _channels.get(key)
    if channel is None:
        channel = _Channel(user=user, device_id=device_id)
        _channels[key] = channel

    superseded = False
    if channel.conn is not None:
        superseded = True
        _push_nowait(channel.conn, None)  # close sentinel for the old stream

    conn = _Connection()
    channel.conn = conn
    channel.last_seen = time.time()

    # Replay: still-pending commands for THIS device with seq > Last-Event-ID,
    # in original-seq order, original frames (arch §3.3/§3.6).
    replay = sorted(
        (
            p
            for p in _pending.values()
            if p.user == user and p.device_id == device_id
            and not p.future.done() and p.seq > last_event_id
        ),
        key=lambda p: p.seq,
    )
    frames = [p.frame for p in replay]

    _log.info(
        "bridge connect user=%s device_id=%s last_event_id=%s replayed=%d superseded=%s",
        applog.sanitize_log_value(user, 64), device_id, last_event_id,
        len(frames), superseded,
    )
    return conn, frames, len(frames)


def disconnect(user: str, device_id: str, conn: _Connection) -> None:
    """Clear the channel's active stream — only if it is still THIS stream
    (a superseded stream must never knock out its replacement)."""
    channel = _channels.get((user, device_id))
    if channel is not None and channel.conn is conn:
        channel.conn = None
        channel.last_seen = time.time()
        _log.info(
            "bridge disconnect user=%s device_id=%s",
            applog.sanitize_log_value(user, 64), device_id,
        )


def devices_connected() -> int:
    """Open bridge streams across all users (``GET /api/status`` hookup —
    the Step-1 stub in routers/status.py lights up through this)."""
    return sum(1 for ch in _channels.values() if ch.conn is not None)


def _sweep_channels() -> None:
    """Drop long-idle channels with no live stream and no pending commands."""
    cutoff = time.time() - _CHANNEL_IDLE_SWEEP_S
    pending_keys = {(p.user, p.device_id) for p in _pending.values()}
    for key in [
        k for k, ch in _channels.items()
        if ch.conn is None and ch.last_seen < cutoff and k not in pending_keys
    ]:
        _channels.pop(key, None)


def _push_nowait(conn: _Connection, frame: str | None) -> bool:
    """Best-effort enqueue. False when the queue is full (backlogged stream)."""
    try:
        conn.queue.put_nowait(frame)
        return True
    except asyncio.QueueFull:
        return False


# ============================================================================
# Dispatch / resolve (the Future round-trip)
# ============================================================================

async def dispatch(
    user: str,
    device_id: str,
    project_id: str,
    turn_id: str,
    tool: str,
    params: dict[str, Any],
    timeout_s: float,
) -> dict[str, Any]:
    """Send one command to the device and await its result.

    ``params`` MUST already be schema-validated (agent/tools.py, arch §8.3) —
    this function validates routing, not tool semantics. Returns the device's
    ``result`` object on ``ok:true``; raises :class:`BridgeError` for every
    failure (taxonomy above). Never raises anything else except a genuine
    task cancellation (re-raised so the SDK can tear the tool task down).
    """
    if tool not in _bridge_tools():  # defense in depth — tools.py is the gate
        raise BridgeError("invalid_params", f"unknown tool '{tool}'")

    channel = _channels.get((user, device_id))
    if channel is None or channel.conn is None:
        raise BridgeError(
            "device_offline",
            "the device has no open connection to the studio — it may be "
            "locked or the app may be closed",
        )

    if sum(1 for p in _pending.values() if p.turn_id == turn_id) >= MAX_PENDING_PER_TURN:
        raise BridgeError(
            "too_many_pending",
            f"this turn already has {MAX_PENDING_PER_TURN} commands awaiting "
            "the device — wait for them to finish",
        )

    command_id = f"cmd_{secrets.token_hex(6)}"
    seq = channel.next_seq()
    issued_at_ms = int(time.time() * 1000)
    envelope = {
        "command_id": command_id,
        "turn_id": turn_id,
        "project_id": project_id,
        "tool": tool,
        "params": params,
        "issued_at": issued_at_ms,
        "timeout_s": timeout_s,
    }
    frame = events.sse_id("command", seq, envelope)

    entry = _Pending(
        command_id=command_id, user=user, device_id=device_id, turn_id=turn_id,
        project_id=project_id, tool=tool, seq=seq, timeout_s=timeout_s,
        issued_at_ms=issued_at_ms, frame=frame,
    )
    _pending[command_id] = entry

    if not _push_nowait(channel.conn, frame):
        _pending.pop(command_id, None)
        raise BridgeError(
            "device_offline",
            "the device's command stream is backlogged and not draining",
        )

    _log.info(
        "command dispatch user=%s device_id=%s command_id=%s tool=%s turn_id=%s "
        "seq=%d timeout_s=%s params_bytes=%d",
        applog.sanitize_log_value(user, 64), device_id, command_id, tool,
        turn_id, seq, timeout_s, len(json.dumps(params, default=str)),
    )

    t0 = time.perf_counter()
    try:
        outcome = await asyncio.wait_for(entry.future, timeout=timeout_s)
    except asyncio.TimeoutError:
        _log.warning(
            "command timeout command_id=%s tool=%s after_s=%s", command_id, tool, timeout_s
        )
        raise BridgeError(
            "command_timeout",
            f"the device did not answer within {int(timeout_s)} seconds — it "
            "may be locked, suspended, or offline",
        )
    except asyncio.CancelledError:
        if entry.cancelled_by_turn:
            raise BridgeError("cancelled", "the turn was cancelled")
        raise  # genuine task cancellation (SDK interrupt) — propagate
    finally:
        _pending.pop(command_id, None)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    if outcome.get("ok"):
        result = outcome.get("result")
        result = result if isinstance(result, dict) else {}
        _log.info(
            "command ok command_id=%s tool=%s elapsed_ms=%d result_bytes=%d",
            command_id, tool, elapsed_ms, len(json.dumps(result, default=str)),
        )
        return result

    # Device-reported failure — normalize to the §3.5 device subset.
    error = outcome.get("error")
    error = error if isinstance(error, dict) else {}
    code = error.get("code") if isinstance(error.get("code"), str) else "engine_error"
    message = error.get("message") if isinstance(error.get("message"), str) else ""
    message = message.strip()[:2000] or "the device reported an unspecified failure"
    if code not in _DEVICE_ERROR_CODES:
        message = f"device error '{applog.sanitize_log_value(code, 64)}': {message}"
        code = "engine_error"
    _log.info(
        "command err command_id=%s tool=%s elapsed_ms=%d code=%s",
        command_id, tool, elapsed_ms, code,
    )
    raise BridgeError(code, message)


def resolve(
    user: str,
    device_id: str,
    command_id: str,
    *,
    ok: bool,
    result: dict[str, Any] | None,
    error: dict[str, Any] | None,
    duration_ms: int | None,
) -> bool:
    """Resolve a pending command with the device's result POST.

    Returns True when a matching, still-pending command was resolved; False
    otherwise (resolved / timed out / cancelled / unknown / WRONG user or
    device — the caller maps False to 409 ``no_pending_command``, which the
    device treats as benign, arch §2.3). The user/device match is the §8.6
    spoofing guard: an authenticated user can only ever resolve THEIR OWN
    device's commands.
    """
    entry = _pending.get(command_id)
    if entry is None or entry.future.done():
        return False
    if entry.user != user or entry.device_id != device_id:
        _log.warning(
            "result rejected (owner mismatch) command_id=%s poster_user=%s "
            "poster_device=%s",
            command_id, applog.sanitize_log_value(user, 64), device_id,
        )
        return False
    entry.future.set_result({
        "ok": bool(ok),
        "result": result,
        "error": error,
        "duration_ms": duration_ms,
    })
    _pending.pop(command_id, None)
    return True


def cancel_for_turn(turn_id: str) -> int:
    """Cancel every pending command belonging to ``turn_id`` (chat cancel /
    turn teardown). Each blocked dispatcher raises ``cancelled``. Returns the
    number of commands cancelled. Idempotent."""
    n = 0
    for entry in list(_pending.values()):
        if entry.turn_id == turn_id and not entry.future.done():
            entry.cancelled_by_turn = True
            entry.future.cancel()
            n += 1
    if n:
        _log.info("cancel_for_turn turn_id=%s cancelled=%d", turn_id, n)
    return n


def pending_count(turn_id: str | None = None) -> int:
    """In-flight command count (diagnostics; optionally for one turn)."""
    if turn_id is None:
        return len(_pending)
    return sum(1 for p in _pending.values() if p.turn_id == turn_id)
