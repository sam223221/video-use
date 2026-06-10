"""Inventory of a footage folder (ARCHITECTURE.md §4.3, contract §6).

ffprobe every source video in the active folder and report duration, dimensions,
fps, portrait flag, size, and whether a cached transcript exists. Mirrors the
helpers' ``VIDEO_EXTS`` so the listed files are exactly those the helpers can
process. Results are cached per (folder, signature) so repeated calls are cheap;
the signature covers BOTH the source videos (name/size/mtime) AND the state of
``edit/transcripts/`` (count/newest-mtime/bytes), so the cache invalidates when
videos change OR when transcripts are written/removed — ``has_transcript`` flips
as soon as a transcribe job (or the agent, mid-chat) writes a transcript, with no
server restart and no explicit cache-busting hook needed (signature-based, so it
is self-healing for every transcript producer).
"""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path
from typing import Any

from .. import settings
from . import runner

_cache: dict[str, dict[str, Any]] = {}
_cache_lock = threading.Lock()


def find_videos(folder: Path) -> list[Path]:
    """Mirror helpers/transcribe_batch.find_videos: top-level video files only."""
    try:
        return sorted(
            p for p in folder.iterdir()
            if p.is_file() and p.suffix in settings.VIDEO_EXTS
        )
    except OSError:
        return []


def _folder_signature(videos: list[Path], transcripts_dir: Path) -> str:
    parts = []
    for v in videos:
        try:
            st = v.stat()
            parts.append(f"{v.name}:{st.st_size}:{int(st.st_mtime)}")
        except OSError:
            parts.append(f"{v.name}:?")
    parts.append(_transcripts_signature(transcripts_dir))
    return "|".join(parts)


def _transcripts_signature(transcripts_dir: Path) -> str:
    """Compact state of ``edit/transcripts/``: count + newest mtime_ns + bytes.

    ``has_transcript`` is derived from this directory, so the inventory cache
    MUST be invalidated whenever a transcript appears, changes, or disappears —
    whether written by the transcribe job OR by the agent mid-chat. Folding the
    dir state into the signature (rather than an explicit cache-bust on the job
    completion path) makes the invalidation self-healing for every producer.
    ``st_mtime_ns`` (not whole seconds) so a same-second rewrite still busts the
    entry. A missing/unreadable dir degrades to the empty state, never raises.
    """
    count = 0
    latest_ns = 0
    total = 0
    try:
        entries = list(transcripts_dir.iterdir())
    except OSError:
        return "t:0:0:0"  # missing dir == no transcripts yet
    for p in entries:
        try:
            if not p.is_file() or p.suffix.lower() != ".json":
                continue
            st = p.stat()
        except OSError:
            count += 1  # unreadable entry still perturbs the signature
            continue
        count += 1
        total += st.st_size
        if st.st_mtime_ns > latest_ns:
            latest_ns = st.st_mtime_ns
    return f"t:{count}:{latest_ns}:{total}"


def _parse_fps(rate: str | None) -> float | None:
    if not rate or rate == "0/0":
        return None
    try:
        if "/" in rate:
            num, den = rate.split("/", 1)
            den_f = float(den)
            return round(float(num) / den_f, 3) if den_f else None
        return round(float(rate), 3)
    except (ValueError, ZeroDivisionError):
        return None


def _probe_one(video: Path, transcripts_dir: Path) -> dict[str, Any]:
    info = runner.ffprobe_json(video)
    width = height = None
    fps = None
    duration = None

    if info:
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                width = stream.get("width")
                height = stream.get("height")
                fps = _parse_fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))
                if stream.get("duration"):
                    try:
                        duration = float(stream["duration"])
                    except (ValueError, TypeError):
                        pass
                break
        if duration is None:
            fmt = info.get("format", {})
            if fmt.get("duration"):
                try:
                    duration = float(fmt["duration"])
                except (ValueError, TypeError):
                    pass

    try:
        size_bytes = video.stat().st_size
    except OSError:
        size_bytes = None

    has_transcript = (transcripts_dir / f"{video.stem}.json").exists()
    portrait = bool(height and width and height > width)

    return {
        "name": video.name,
        "path": str(video),
        "duration_s": round(duration, 2) if duration is not None else None,
        "width": width,
        "height": height,
        "fps": fps,
        "portrait": portrait,
        "has_transcript": has_transcript,
        "size_bytes": size_bytes,
    }


def inventory_sync(folder: Path) -> dict[str, Any]:
    """Synchronous inventory (used by the agent tool + the cache filler)."""
    videos = find_videos(folder)
    edit_dir = folder / "edit"
    transcripts_dir = edit_dir / "transcripts"

    signature = _folder_signature(videos, transcripts_dir)
    resolved = str(folder.resolve())
    cache_key = resolved.lower() if os.name == "nt" else resolved

    with _cache_lock:
        cached = _cache.get(cache_key)
        if cached and cached.get("_signature") == signature:
            return cached["data"]

    clips = [_probe_one(v, transcripts_dir) for v in videos]
    total = sum(c["duration_s"] for c in clips if c.get("duration_s"))
    data = {
        "folder": str(folder),
        "clips": clips,
        "total_duration_s": round(total, 2),
        "count": len(clips),
    }

    with _cache_lock:
        _cache[cache_key] = {"_signature": signature, "data": data}
    return data


async def inventory(folder: Path) -> dict[str, Any]:
    """Async inventory — runs the blocking ffprobe loop in a thread."""
    return await asyncio.to_thread(inventory_sync, folder)
