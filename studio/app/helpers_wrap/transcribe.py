"""Transcription wrapper (ARCHITECTURE.md §4.4 / §5.5).

Drives ``transcribe_batch.py`` over the active folder as a tracked Job, parses
per-file progress from its stdout, and optionally runs ``pack_transcripts.py``
afterward to produce ``takes_packed.md``. Cached files are skipped by the helper
itself (Hard Rule 9). One transcription job at a time (single-flight via the job
registry).

Used by BOTH the REST ``POST /api/transcribe`` button and the agent's
``mcp__studio__transcribe_batch`` tool, so the logic lives once.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable

from ..core.jobs import Job
from . import inventory, pack, progress, runner

# Generous per-batch timeout: the helper allows ~600s/file. Scale with count.
_BASE_TIMEOUT = 600.0
_PER_FILE_TIMEOUT = 600.0


def plan(folder: Path, files: list[str] | None) -> dict[str, Any]:
    """Pre-flight: how many videos, how many already cached."""
    videos = inventory.find_videos(folder)
    if files:
        wanted = set(files)
        videos = [v for v in videos if v.name in wanted or v.stem in wanted]
    transcripts_dir = folder / "edit" / "transcripts"
    cached = [v for v in videos if (transcripts_dir / f"{v.stem}.json").exists()]
    return {"files": len(videos), "already_cached": len(cached), "videos": videos}


async def run_job(
    job: Job,
    folder: Path,
    *,
    files: list[str] | None = None,
    workers: int = 4,
    language: str | None = None,
    num_speakers: int | None = None,
    do_pack: bool = True,
    on_progress: Callable[[dict], Any] | None = None,
    on_file_done: Callable[[dict], Any] | None = None,
) -> dict[str, Any]:
    """Execute the transcription job. Updates ``job`` in place and returns a
    result dict. Never raises — failures are recorded on the job and returned.
    """
    edit_dir = folder / "edit"
    transcripts_dir = edit_dir / "transcripts"

    pre = plan(folder, files)
    total = pre["files"]
    job.update(total=total, phase="starting")

    if total == 0:
        result = {"ok": True, "transcribed": 0, "cached": 0, "packed": None,
                  "note": "no videos found"}
        job.finish_ok(result)
        return result

    args: list[str] = [str(folder), "--edit-dir", str(edit_dir), "--workers", str(workers)]
    if language:
        args += ["--language", language]
    if num_speakers:
        args += ["--num-speakers", str(num_speakers)]

    tracker = progress.TranscribeProgress()
    seen_done: set[str] = set()

    async def handle_line(line: str) -> None:
        job.log(line)
        snap = tracker.feed(line)
        if snap is None:
            return
        job.update(
            done=snap["done"], total=snap["total"],
            percent=snap["percent"], phase=snap["phase"], current=snap.get("current"),
        )
        if on_progress:
            await _maybe_await(on_progress(snap))
        name = snap.get("current")
        if name and name not in seen_done and snap["phase"] == "transcribing":
            seen_done.add(name)
            tr_path = transcripts_dir / f"{name}.json"
            file_event = {
                "name": name,
                "cached": False,
                "failed": snap.get("failed", False),
                "transcript": str(tr_path) if tr_path.exists() else None,
            }
            if on_file_done:
                await _maybe_await(on_file_done(file_event))

    pending = max(pre["files"] - pre["already_cached"], 0)
    timeout = _BASE_TIMEOUT + _PER_FILE_TIMEOUT * pending
    res = await runner.run(
        "transcribe_batch.py", args,
        timeout=timeout,
        on_line=handle_line,
        cancel_check=lambda: job.cancel_requested,
    )

    if job.cancel_requested:
        job.mark_cancelled()
        return {"ok": False, "cancelled": True}

    if not res.ok:
        code, message = _classify_error(res)
        job.finish_error(code, message)
        return {"ok": False, "code": code, "message": message}

    # Recount from disk (authoritative).
    final = plan(folder, files)
    cached_before = pre["already_cached"]
    newly = max(0, final["already_cached"] - cached_before)

    packed_path: str | None = None
    if do_pack:
        job.update(phase="packing")
        pack_res = await pack.run(folder)
        packed_path = pack_res.get("packed") if pack_res.get("ok") else None

    result = {
        "ok": True,
        "transcribed": newly,
        "cached": cached_before,
        "packed": packed_path,
    }
    job.finish_ok(result)
    return result


def _classify_error(res: runner.RunResult) -> tuple[str, str]:
    tail = res.tail_text
    if res.timed_out:
        return "timeout", "transcription timed out"
    if "401" in tail or "Invalid API key" in tail or "ELEVENLABS_API_KEY not found" in tail:
        return "elevenlabs_401", "ElevenLabs rejected the API key (or it is missing)"
    return "transcribe_failed", tail[-400:] or "transcription failed"


async def _maybe_await(value: Any) -> None:
    if asyncio.iscoroutine(value):
        await value
