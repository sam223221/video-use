"""SSE event serialization for video-use Studio.

One tiny helper that formats a Server-Sent Event frame exactly as the API
contract requires::

    event: <type>\\n
    data: <json>\\n
    \\n

Used by the transcribe SSE and the chat SSE relay. Keeping it in one place
guarantees both streams emit byte-identical framing.
"""

from __future__ import annotations

import json
from typing import Any


def sse(event: str, data: dict[str, Any] | None = None) -> str:
    """Format one SSE frame. ``data`` is JSON-encoded."""
    payload = json.dumps(data or {}, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {payload}\n\n"


def sse_comment(text: str) -> str:
    """A no-op SSE comment line — a heartbeat to keep proxies from closing an
    idle stream. Clients ignore comment lines.
    """
    return f": {text}\n\n"
