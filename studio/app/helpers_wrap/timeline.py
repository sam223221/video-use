"""Wrapper for timeline_view.py -> filmstrip/waveform PNG (contract §5.2).

The agent's visual drill-down tool. Produces a PNG into ``<edit>/verify/`` and
returns its path. The agent tool layer reads the PNG bytes back so the model can
SEE the rendered frame (SKILL.md step 7 self-eval).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import runner

_TIMEOUT = 180.0


async def run(
    source: Path,
    start: float,
    end: float,
    *,
    edit_dir: Path,
    n_frames: int = 10,
) -> dict[str, Any]:
    """Render a timeline PNG for ``source[start:end]`` into ``edit_dir/verify``.

    Returns {ok, png, message}. ``source`` must already be path-validated by the
    caller.
    """
    if end <= start:
        return {"ok": False, "message": "end must be greater than start", "png": None}

    verify_dir = edit_dir / "verify"
    verify_dir.mkdir(parents=True, exist_ok=True)
    out_png = verify_dir / f"{source.stem}_{start:.2f}-{end:.2f}.png"

    args = [
        str(source), f"{start}", f"{end}",
        "-o", str(out_png),
        "--n-frames", str(n_frames),
    ]
    # Pass the transcript explicitly if it exists (helper also auto-resolves).
    transcript = edit_dir / "transcripts" / f"{source.stem}.json"
    if transcript.exists():
        args += ["--transcript", str(transcript)]

    res = await runner.run("timeline_view.py", args, timeout=_TIMEOUT)
    if res.ok and out_png.exists():
        return {"ok": True, "png": str(out_png)}
    return {"ok": False, "message": res.tail_text or "timeline_view failed", "png": None}
