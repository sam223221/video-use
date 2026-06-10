"""Render wrapper (ARCHITECTURE.md §4.6 / §5.5 / §6.3).

Drives ``render.py <edit>/edl.json -o <out>`` as a tracked Job, parsing live
ffmpeg ``time=`` progress and phase markers. Computes the expected output
duration from the EDL so the percent estimate is meaningful. One render at a time
(single-flight via the job registry). Used by the agent's ``mcp__studio__render``
tool.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable

from ..core.jobs import Job
from . import progress, runner

# Render time scales with EDL duration. base + k * duration (seconds).
_BASE_TIMEOUT = 600.0
_PER_OUTPUT_SECOND = 30.0


def edl_total_duration(edl_path: Path) -> float:
    """Sum the EDL ranges to estimate output duration (seconds)."""
    try:
        edl = json.loads(edl_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0.0
    if isinstance(edl.get("total_duration_s"), (int, float)):
        return float(edl["total_duration_s"])
    total = 0.0
    for r in edl.get("ranges", []):
        try:
            total += float(r["end"]) - float(r["start"])
        except (KeyError, ValueError, TypeError):
            continue
    return total


async def run_job(
    job: Job,
    edit_dir: Path,
    *,
    output: Path,
    preview: bool = False,
    draft: bool = False,
    build_subtitles: bool = False,
    no_subtitles: bool = False,
    no_loudnorm: bool = False,
    on_progress: Callable[[dict], Any] | None = None,
) -> dict[str, Any]:
    """Execute the render. Updates ``job`` in place; returns a result dict.
    Never raises — failures are recorded on the job and returned.
    """
    edl_path = edit_dir / "edl.json"
    if not edl_path.exists():
        msg = "no edl.json in the edit dir — author the EDL first"
        job.finish_error("no_edl", msg)
        return {"ok": False, "code": "no_edl", "message": msg}

    total_duration = edl_total_duration(edl_path)
    tracker = progress.RenderProgress(total_output_duration=total_duration)
    job.update(phase="starting", total=100)

    output.parent.mkdir(parents=True, exist_ok=True)

    args = [str(edl_path), "-o", str(output)]
    if preview:
        args.append("--preview")
    if draft:
        args.append("--draft")
    if build_subtitles:
        args.append("--build-subtitles")
    if no_subtitles:
        args.append("--no-subtitles")
    if no_loudnorm:
        args.append("--no-loudnorm")

    async def handle_line(line: str) -> None:
        job.log(line)
        snap = tracker.feed(line)
        if snap is None:
            return
        new_percent = snap.get("percent")
        job.update(
            percent=new_percent if new_percent is not None else job.percent,
            phase=snap.get("phase", job.phase),
        )
        if on_progress:
            await _maybe_await(on_progress({"percent": job.percent, "phase": job.phase}))

    timeout = _BASE_TIMEOUT + _PER_OUTPUT_SECOND * max(total_duration, 0.0)
    res = await runner.run(
        "render.py", args,
        timeout=timeout,
        on_line=handle_line,
        cancel_check=lambda: job.cancel_requested,
    )

    if job.cancel_requested:
        job.mark_cancelled()
        return {"ok": False, "cancelled": True}

    if not res.ok:
        code = "timeout" if res.timed_out else "render_failed"
        msg = res.tail_text[-500:] or "render failed"
        job.finish_error(code, msg)
        return {"ok": False, "code": code, "message": msg}

    result = {
        "ok": True,
        "output": str(output),
        "duration_s": round(total_duration, 1),
        "preview": preview,
    }
    job.finish_ok(result)
    return result


async def _maybe_await(value: Any) -> None:
    if asyncio.iscoroutine(value):
        await value
