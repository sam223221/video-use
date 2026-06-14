"""The bridge HTTP surface (arch §2.3 + §3) — the device half's two endpoints.

* ``GET /api/bridge/events?device_id=dev_…`` — the persistent command SSE
  stream. Cookie-auth'd like every ``/api/*`` route (EventSource sends
  cookies same-origin; read-only, so the GET is CSRF-safe — arch §8.1).
  Frames: ``: connected`` comment, ``hello`` (``id: 0``, carries
  ``device_id`` / ``server_boot_id`` / ``replayed``), ``command`` frames
  (per-device monotonic ``id:`` seq via ``events.sse_id``), and a ``: hb``
  comment every 20 s (keeps Safari/EventSource and middleboxes from idling
  the stream out). ``Last-Event-ID`` is honored on reconnect: still-pending
  commands with seq greater than it are replayed with their ORIGINAL seq;
  a missing/garbage header replays every still-pending command (the device
  dedupes by ``command_id`` either way — arch §3.6).

* ``POST /api/bridge/result`` — the device's answer. Body per arch §3.2,
  raw-size-capped at 2 MiB (413 ``payload_too_large``; raised from 512 KB for
  Agent Vision's view_frames image results — plan 2026-06-13 §3, a lockstep
  pair with the PWA bridge.js cap, both authenticated), JSON-object-only
  (400 ``invalid_body`` — manual parse so the cap runs on RAW bytes and
  malformed JSON maps to the contract's 400, the client_log pattern). The
  resolve must match the pending command's authenticated user AND device_id;
  anything resolved/timed-out/unknown/foreign is one uniform 409
  ``no_pending_command`` (benign to the device — arch §2.3).

Stream lifecycle: one stream per ``(user, device_id)`` — a second connect
supersedes the first (the superseded generator receives a ``None`` sentinel,
emits ``: superseded`` and ends). The 8-devices-per-user cap is enforced
BEFORE the response starts (409 ``too_many_devices``) and re-checked at
generator registration (the handler→generator race window), where a trip
ends the stream immediately after an ``error`` frame.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from starlette.requests import ClientDisconnect

from ..core import applog, bridge, events
from . import deps

router = APIRouter(prefix="/api", tags=["bridge"])

_log = logging.getLogger("studio2.bridge")

DEVICE_ID_RE = re.compile(r"^dev_[0-9a-f]{16}$")
_COMMAND_ID_RE = re.compile(r"^cmd_[0-9a-f]{12}$")
_ERROR_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

# Raised 512 KB -> 2 MiB for Agent Vision (plan 2026-06-13 §3). view_frames
# returns up to 4 downscaled JPEG stills as base64 inside the result body;
# base64 inflates ~33%, so ≤4 frames × ~512px-long-edge q≈0.6 (~40-110 KB b64
# each) sit comfortably under 2 MiB with headroom, and the device's per-image
# byte clamp keeps any single frame bounded. This is a LOCKSTEP pair: the PWA
# bridge.js RESULT_MAX_BYTES moves to the same 2 MiB (plan §3) — the two caps
# must match or a valid frame result that one side accepts the other rejects.
# Threat model: BOTH bridge routes are authenticated (the endpoint is
# require_session-gated, 2-user trusted LAN), so this widens the authed-result
# body the endpoint accepts to a bounded, documented, accepted DoS budget — an
# oversized/hostile body still costs at most cap+one-chunk of RAM (the body is
# stream-read with the cap enforced on RAW bytes, pre-parse, in _read_body_capped).
_RESULT_MAX_BYTES = 2 * 1024 * 1024   # arch §2.3 / §8.5; 2 MiB (Agent Vision, plan §3)
_ERROR_MESSAGE_MAX = 2000        # device error messages truncated, not rejected

_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}
_HEARTBEAT_S = 20.0


def _validate_device_id(device_id: str) -> str:
    if not DEVICE_ID_RE.match(device_id or ""):
        raise deps.http_error(
            400, "invalid_device_id", "device_id must match dev_<16 hex chars>"
        )
    return device_id


def _parse_last_event_id(request: Request) -> int:
    """The reconnect cursor. Missing/garbage/negative → 0 (replay all
    still-pending — safe by command_id dedupe)."""
    raw = request.headers.get("last-event-id")
    if raw is None:
        return 0
    try:
        return max(0, int(raw.strip()))
    except (ValueError, OverflowError):
        return 0


@router.get("/bridge/events")
async def bridge_events(
    request: Request,
    device_id: str = Query(...),
    user: str = Depends(deps.require_session),
) -> StreamingResponse:
    _validate_device_id(device_id)
    # Pre-check the cap so an over-limit connect is a REAL 409 (a status code
    # can't be changed once streaming starts). Re-checked inside connect().
    if bridge.live_streams_for_user(user, exclude_device=device_id) >= bridge.MAX_DEVICES_PER_USER:
        raise deps.http_error(
            409, "too_many_devices",
            f"this account already has {bridge.MAX_DEVICES_PER_USER} connected devices",
        )
    last_event_id = _parse_last_event_id(request)

    async def stream():
        try:
            conn, replay_frames, replayed = bridge.connect(user, device_id, last_event_id)
        except bridge.BridgeError as exc:
            # The handler→generator race window: the cap filled in between.
            # Too late for a status code — emit one error frame and end.
            yield events.sse("error", {"code": exc.code, "message": exc.message})
            return
        try:
            yield events.sse_comment("connected")
            yield events.sse_id("hello", 0, {
                "device_id": device_id,
                "server_boot_id": bridge.SERVER_BOOT_ID,
                "replayed": replayed,
            })
            for frame in replay_frames:
                yield frame
            while True:
                try:
                    frame = await asyncio.wait_for(
                        conn.queue.get(), timeout=_HEARTBEAT_S
                    )
                except TimeoutError:  # asyncio.TimeoutError is this alias (3.11+)
                    yield events.sse_comment("hb")
                    continue
                if frame is None:  # superseded by a newer stream for this pair
                    yield events.sse_comment("superseded")
                    return
                yield frame
        finally:
            # No yields here (the BUG-15 hazard); deregister exactly once,
            # and only if this generator's conn is still the active one.
            bridge.disconnect(user, device_id, conn)

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


async def _read_body_capped(request: Request, cap: int) -> bytes:
    """Stream-read the raw body, aborting past ``cap`` bytes (413). The
    client_log pattern: an oversized/hostile body costs at most cap+one-chunk
    bytes of RAM and the cap runs on RAW bytes, pre-parse."""
    chunks: list[bytes] = []
    total = 0
    async for piece in request.stream():
        if not piece:
            continue
        total += len(piece)
        if total > cap:
            raise deps.http_error(
                413, "payload_too_large", f"result body exceeds {cap} bytes"
            )
        chunks.append(piece)
    return b"".join(chunks)


def _invalid(message: str):
    return deps.http_error(400, "invalid_body", message)


@router.post("/bridge/result")
async def bridge_result(
    request: Request, user: str = Depends(deps.require_session)
) -> dict:
    try:
        raw = await _read_body_capped(request, _RESULT_MAX_BYTES)
    except ClientDisconnect:
        raise deps.http_error(
            499, "client_disconnected",
            "client disconnected before the result was fully received",
        )

    try:
        body = json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, RecursionError):
        raise _invalid("body must be a JSON object")
    if not isinstance(body, dict):
        raise _invalid("body must be a JSON object")

    device_id = body.get("device_id")
    if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id):
        raise _invalid("device_id must match dev_<16 hex chars>")
    command_id = body.get("command_id")
    if not isinstance(command_id, str) or not _COMMAND_ID_RE.match(command_id):
        raise _invalid("command_id must match cmd_<12 hex chars>")
    ok = body.get("ok")
    if not isinstance(ok, bool):
        raise _invalid("ok must be a boolean")

    result = body.get("result")
    error = body.get("error")
    if ok:
        if result is not None and not isinstance(result, dict):
            raise _invalid("result must be a JSON object when present")
        error = None
    else:
        if not isinstance(error, dict):
            raise _invalid("error must be {code, message} when ok is false")
        code = error.get("code")
        message = error.get("message")
        if not isinstance(code, str) or not _ERROR_CODE_RE.match(code):
            raise _invalid("error.code must be a lowercase snake_case identifier")
        if not isinstance(message, str):
            raise _invalid("error.message must be a string")
        error = {"code": code, "message": message[:_ERROR_MESSAGE_MAX]}
        result = None

    duration_ms = body.get("duration_ms")
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, (int, float)):
        duration_ms = None
    else:
        duration_ms = int(duration_ms)

    resolved = bridge.resolve(
        user, device_id, command_id,
        ok=ok, result=result, error=error, duration_ms=duration_ms,
    )
    if not resolved:
        # Already resolved, timed out, cancelled, unknown, or not this
        # user's/device's command — one uniform, benign 409 (arch §2.3).
        raise deps.http_error(
            409, "no_pending_command",
            "no pending command matches this command_id for this device",
        )

    _log.info(
        "result accepted user=%s device_id=%s command_id=%s ok=%s "
        "duration_ms=%s body_bytes=%d",
        applog.sanitize_log_value(user, 64), device_id, command_id, ok,
        duration_ms if duration_ms is not None else "-", len(raw),
    )
    return {"ok": True}
