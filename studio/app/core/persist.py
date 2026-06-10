"""Chat transcript persistence (per-user session model).

Each session's chat transcript is stored at ``<session_dir>/transcript.json``
(alongside ``meta.json`` and the session's media). This replaces the old
``.runtime/sessions/<folder-hash>.json`` pathing and the global ``active_folder``
state — both removed in the per-user session cutover.

All writes are atomic (temp file + ``os.replace``). Best-effort reads: a
corrupt/missing file degrades to an empty transcript rather than crashing.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import sessions

_lock = threading.Lock()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_transcript(session_dir: Path) -> list[dict[str, Any]]:
    """Return the persisted messages for ``session_dir`` (``[]`` if absent/corrupt)."""
    path = sessions.transcript_path(session_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return []  # valid JSON but not an object — degrade gracefully
        msgs = data.get("messages")
        return msgs if isinstance(msgs, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def append_message(session_dir: Path, message: dict[str, Any]) -> None:
    """Append one message ({role, content, tool_calls?}) to the session transcript."""
    path = sessions.transcript_path(session_dir)
    with _lock:
        msgs = load_transcript(session_dir)
        msgs.append(message)
        _atomic_write(
            path,
            json.dumps({"messages": msgs}, ensure_ascii=False),
        )
