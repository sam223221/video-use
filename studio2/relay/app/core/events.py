"""SSE event serialization — v1 ``studio/app/core/events.py`` verbatim, plus
the :func:`sse_id` variant carrying an ``id:`` line.

Frames (the API contract — arch §2.2/§2.3)::

    event: <type>\\n
    data: <json>\\n
    \\n

and, for streams that support ``Last-Event-ID`` resume (the bridge command
stream and the chat turn buffer)::

    event: <type>\\n
    id: <seq>\\n
    data: <json>\\n
    \\n

Keeping every producer on these helpers guarantees byte-identical framing
across streams. EventSource records the LAST ``id:`` it saw and replays it as
the ``Last-Event-ID`` request header on reconnect — which is what makes the
bridge's pending-command replay and the chat attach endpoint work (arch §3.3).
"""

from __future__ import annotations

import json
from typing import Any


def sse(event: str, data: dict[str, Any] | None = None) -> str:
    """Format one SSE frame. ``data`` is JSON-encoded."""
    payload = json.dumps(data or {}, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def sse_id(event: str, seq: int, data: dict[str, Any] | None = None) -> str:
    """Format one SSE frame carrying an ``id:`` line (resume/replay streams).

    ``seq`` is the per-stream monotonic sequence number; the line order
    (event, id, data) mirrors the arch §2.3 examples. The SSE spec treats the
    field order as irrelevant, but emitting one canonical order keeps frames
    byte-comparable in tests and logs.
    """
    payload = json.dumps(data or {}, ensure_ascii=False, default=str)
    return f"event: {event}\nid: {seq}\ndata: {payload}\n\n"


def sse_comment(text: str) -> str:
    """A no-op SSE comment line — a heartbeat to keep proxies from closing an
    idle stream. Clients ignore comment lines.
    """
    return f": {text}\n\n"
