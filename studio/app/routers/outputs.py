"""GET /api/outputs?session_id= — listing of the session's edit/ dir (contract §17).

The ``session_id`` (client-carried) is resolved to the caller's OWNED session dir
via ``deps.require_session_dir``; a bad / cross-user / missing id is one uniform
404 session_not_found.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, Query

from ..helpers_wrap import runner
from . import deps

router = APIRouter(prefix="/api", tags=["outputs"])


def _video_meta(path: Path) -> dict:
    if not path.exists():
        return {"exists": False}
    meta: dict = {"exists": True, "path": str(path)}
    try:
        meta["mtime"] = int(path.stat().st_mtime)
    except OSError:
        pass
    info = runner.ffprobe_json(path)
    if info:
        dur = info.get("format", {}).get("duration")
        if dur:
            try:
                meta["duration_s"] = round(float(dur), 1)
            except (ValueError, TypeError):
                pass
    return meta


def _text_meta(path: Path) -> dict:
    """Existence + absolute path for a text artifact (srt/md). The path lets the
    frontend open it via /api/file (which allowlists .srt/.json/.md); omitted when
    the file is absent, mirroring _video_meta.
    """
    if not path.exists():
        return {"exists": False}
    return {"exists": True, "path": str(path)}


@router.get("/outputs")
def outputs(
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> dict:
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    edit_dir = folder / "edit"

    edl_info: dict = {"exists": False}
    edl_path = edit_dir / "edl.json"
    if edl_path.exists():
        edl_info = {"exists": True, "path": str(edl_path)}
        try:
            edl = json.loads(edl_path.read_text(encoding="utf-8"))
            edl_info["ranges"] = len(edl.get("ranges", []))
            total = edl.get("total_duration_s")
            if total is not None:
                edl_info["total_duration_s"] = total
        # ValueError covers both json.JSONDecodeError and UnicodeDecodeError (bad
        # UTF-8 bytes in the EDL) so a single corrupt file cannot 500 the whole
        # endpoint — the pre-set {"exists": True, "path": ...} is returned as-is.
        except (OSError, ValueError):
            pass

    verify_pngs = []
    verify_dir = edit_dir / "verify"
    if verify_dir.is_dir():
        for png in sorted(verify_dir.glob("*.png")):
            verify_pngs.append({"name": png.name, "path": str(png)})

    animations = []
    anim_dir = edit_dir / "animations"
    if anim_dir.is_dir():
        for slot in sorted(p for p in anim_dir.iterdir() if p.is_dir()):
            render = slot / "render.mp4"
            animations.append({
                "slot": slot.name,
                "render": str(render),
                "exists": render.exists(),
            })

    return {
        "edit_dir": str(edit_dir),
        "preview": _video_meta(edit_dir / "preview.mp4"),
        "final": _video_meta(edit_dir / "final.mp4"),
        "edl": edl_info,
        "master_srt": _text_meta(edit_dir / "master.srt"),
        "verify_pngs": verify_pngs,
        "animations": animations,
        "project_md": _text_meta(edit_dir / "project.md"),
    }
