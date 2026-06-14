"""POST /api/client-log — phone-side diagnostics ingestion. v1 contract
VERBATIM (``studio/app/routers/client_log.py``); only the logger namespace
changed.

The PWA's ``diag.js`` ring-buffers events and ships them here in small
batches (plus a ``sendBeacon`` tail on pagehide); each event becomes ONE line
in the rotating server log (``studio2.client`` logger):

    client user=<username> ip=<ip> ua="<first-80-of-user-agent>" | <level> t=<epoch_ms> <msg> <data>

Contract (frozen — do not "improve"):

* Auth-gated by ``deps.require_session`` — anonymous posts are 401.
* Body ``{events: [{t:<epoch_ms>, level:"debug|info|warn|error", msg:<str>,
  data?:<obj>}, ...]}``.
* Caps, enforced server-side: body <= 64 KiB (413 ``payload_too_large``),
  <= 200 events per request (400 ``invalid_body``), msg truncated to 500
  chars, ``data`` JSON-dumped and capped at ~2 KiB per event.
* A garbage body is a clean 400 ``invalid_body`` envelope — never a 500. The
  body is parsed manually (not via a Pydantic model) precisely so the size
  cap runs against the RAW bytes and malformed JSON maps to the contract's
  400 instead of FastAPI's 422 validation array.
* Log-line injection is impossible: every client string passes through
  ``applog.sanitize_log_value`` (C0/C1 control chars — incl. CR/LF —
  replaced, length-capped), and events are written as DATA via the logging
  framework, never interpolated into anything executable.
* Response: 200 ``{ok: true}``.

Content-Type is deliberately NOT restricted to ``application/json``: the
``navigator.sendBeacon`` fallback (the dying-tab tail — historically the
single most valuable batch) may ship as ``text/plain`` depending on how the
Blob is constructed, and losing that tail would defeat the feature. The CSRF
exposure this opens is writing rate-capped, sanitized NOISE into a private
diagnostic log under the victim's own username — no state changes, no
reflection, bounded size — accepted and documented (v1 decision carried).
Do NOT "fix" this by adding a JSON Content-Type check.

Within a batch, a malformed EVENT (non-object entry) is skipped and counted
(``dropped=N`` summary line) rather than failing the whole batch: during an
incident, losing 199 good events because one was mangled is the worse bug.
Unknown ``level`` values degrade to ``info``.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, Request
from starlette.requests import ClientDisconnect

from ..core import applog
from . import deps

router = APIRouter(prefix="/api", tags=["client-log"])

_log = logging.getLogger("studio2.client")

_MAX_BODY_BYTES = 64 * 1024  # 64 KiB raw body cap -> 413
_MAX_EVENTS = 200            # events per request -> 400
_MAX_MSG_CHARS = 500         # per-event message cap (truncated, not rejected)
_MAX_DATA_CHARS = 2048       # per-event serialized-data cap (truncated)
_MAX_UA_CHARS = 80           # user-agent prefix recorded per line

# Client level -> server log level. ``debug`` maps to INFO on purpose: the
# studio2 logger filters below INFO, and dropping the client's debug events
# would gut the diagnostic value — the client's CLAIMED level is preserved
# textually in the line itself either way.
_LEVEL_MAP = {
    "debug": logging.INFO,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
}


async def _read_body_capped(request: Request) -> bytes:
    """Read the raw body in bounded pieces, aborting past the 64 KiB cap.

    Streaming (rather than ``await request.body()``) means an oversized or
    hostile body is rejected after at most cap+one-chunk bytes in RAM.
    """
    chunks: list[bytes] = []
    total = 0
    async for piece in request.stream():
        if not piece:
            continue
        total += len(piece)
        if total > _MAX_BODY_BYTES:
            raise deps.http_error(
                413, "payload_too_large",
                f"client-log body exceeds {_MAX_BODY_BYTES} bytes",
            )
        chunks.append(piece)
    return b"".join(chunks)


def _format_event(ev: dict) -> tuple[int, str]:
    """Render one client event -> (server log level, sanitized line tail)."""
    raw_level = ev.get("level")
    level = raw_level.lower() if isinstance(raw_level, str) else "info"
    if level not in _LEVEL_MAP:
        level = "info"

    msg = applog.sanitize_log_value(ev.get("msg", ""), _MAX_MSG_CHARS)

    # Client-claimed epoch-ms timestamp: kept on the line because replayed
    # localStorage batches (a frozen tab's story) arrive long after the fact —
    # the server-side timestamp alone would mis-order them.
    t = ev.get("t")
    try:
        t_str = str(int(t)) if isinstance(t, (int, float)) and not isinstance(t, bool) else "-"
    except (ValueError, OverflowError):  # NaN / inf
        t_str = "-"

    data = ev.get("data")
    data_str = ""
    if data is not None:
        try:
            data_str = json.dumps(
                data, ensure_ascii=False, default=str, separators=(",", ":")
            )
        except (TypeError, ValueError, RecursionError):
            # RecursionError mirrors the json.loads guard: a deeply-nested
            # ``data`` object must degrade to a placeholder, not a 500.
            data_str = "<unserializable>"
        data_str = applog.sanitize_log_value(data_str, _MAX_DATA_CHARS)

    tail = f"{level} t={t_str} {msg}"
    if data_str:
        tail += " " + data_str
    return _LEVEL_MAP[level], tail


@router.post("/client-log")
async def client_log(
    request: Request, user: str = Depends(deps.require_session)
) -> dict:
    try:
        raw = await _read_body_capped(request)
    except ClientDisconnect:
        # The shipper is fire-and-forget and a dying tab can drop mid-POST;
        # the v1 contract's resumable 499 rather than a 500.
        raise deps.http_error(
            499, "client_disconnected",
            "client disconnected before the log batch was fully received",
        )

    try:
        payload = json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, RecursionError):
        # RecursionError: a deeply-nested body (e.g. 60 KB of "[") blows the
        # parser's recursion limit. Per the contract that is still just a
        # garbage body -> 400 invalid_body, never a 500.
        raise deps.http_error(400, "invalid_body", "body must be a JSON object")
    if not isinstance(payload, dict) or not isinstance(payload.get("events"), list):
        raise deps.http_error(400, "invalid_body", "expected {events: [...]}")
    events = payload["events"]
    if len(events) > _MAX_EVENTS:
        raise deps.http_error(
            400, "invalid_body", f"too many events (max {_MAX_EVENTS})"
        )

    # Per-line provenance. The username comes from the VERIFIED cookie and the
    # UA/IP from the transport; all are sanitized as defense in depth. No
    # cookie value or token ever appears here.
    ip = request.client.host if request.client else "-"
    safe_user = applog.sanitize_log_value(user, 64)
    ua = applog.sanitize_log_value(
        request.headers.get("user-agent", "-"), _MAX_UA_CHARS
    )
    prefix = f'client user={safe_user} ip={ip} ua="{ua}" | '

    dropped = 0
    for ev in events:
        if not isinstance(ev, dict):
            dropped += 1
            continue
        level, tail = _format_event(ev)
        _log.log(level, "%s%s", prefix, tail)
    if dropped:
        _log.warning("%sbatch had %d malformed event(s) (skipped)", prefix, dropped)

    return {"ok": True}
