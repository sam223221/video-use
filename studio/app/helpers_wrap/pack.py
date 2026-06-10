"""Wrapper for pack_transcripts.py -> takes_packed.md (contract §5/§12)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import runner

_TIMEOUT = 120.0


async def run(folder: Path) -> dict[str, Any]:
    """Run pack_transcripts over ``folder/edit``. Returns {ok, packed, message}."""
    edit_dir = folder / "edit"
    transcripts_dir = edit_dir / "transcripts"
    if not transcripts_dir.is_dir() or not any(transcripts_dir.glob("*.json")):
        return {"ok": False, "message": "no transcripts to pack", "packed": None}

    res = await runner.run(
        "pack_transcripts.py",
        ["--edit-dir", str(edit_dir)],
        timeout=_TIMEOUT,
    )
    packed = edit_dir / "takes_packed.md"
    if res.ok and packed.exists():
        return {"ok": True, "packed": str(packed)}
    return {"ok": False, "message": res.tail_text or "pack failed", "packed": None}


def read_packed(folder: Path) -> str | None:
    """Return the contents of takes_packed.md, or None if it doesn't exist."""
    packed = folder / "edit" / "takes_packed.md"
    try:
        return packed.read_text(encoding="utf-8") if packed.exists() else None
    except OSError:
        return None
