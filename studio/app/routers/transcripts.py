"""Transcripts & packed transcript reads (contract §10-§12).

* GET /api/transcripts?session_id=        — list cached transcripts.
* GET /api/transcripts/{stem}?session_id= — raw Scribe JSON for one source.
* GET /api/packed?session_id=             — takes_packed.md text (404 not_packed).

Each read is scoped to the caller's OWNED session dir, resolved via
``deps.require_session_dir`` (a bad / cross-user / missing ``session_id`` is one
uniform 404 session_not_found).
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse

from .. import security
from . import deps

router = APIRouter(prefix="/api", tags=["transcripts"])


def _transcripts_dir(folder: Path) -> Path:
    return folder / "edit" / "transcripts"


@router.get("/transcripts")
def list_transcripts(
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> dict:
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    tdir = _transcripts_dir(folder)
    out = []
    if tdir.is_dir():
        for jf in sorted(tdir.glob("*.json")):
            words = 0
            duration = None
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
                word_list = [w for w in data.get("words", []) if w.get("type") == "word"]
                words = len(word_list)
                if word_list:
                    last = word_list[-1].get("end")
                    first = word_list[0].get("start")
                    if last is not None and first is not None:
                        duration = round(float(last) - float(first), 2)
            except (OSError, json.JSONDecodeError, ValueError, TypeError):
                pass
            out.append({"stem": jf.stem, "words": words, "duration_s": duration})
    return {"transcripts": out}


@router.get("/transcripts/{stem}")
def get_transcript(
    stem: str,
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
):
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    tdir = _transcripts_dir(folder)
    try:
        safe = security.sanitize_name(f"{stem}.json")
    except ValueError:
        raise deps.http_error(400, "invalid_stem", "invalid transcript name")
    path = tdir / safe
    if not path.exists():
        raise deps.http_error(404, "not_found", "transcript not found")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise deps.http_error(500, "read_error", "could not read transcript")


@router.get("/packed", response_class=PlainTextResponse)
def packed(
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> PlainTextResponse:
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    path = folder / "edit" / "takes_packed.md"
    if not path.exists():
        raise deps.http_error(404, "not_packed", "takes_packed.md does not exist")
    try:
        return PlainTextResponse(path.read_text(encoding="utf-8"), media_type="text/markdown")
    except OSError:
        raise deps.http_error(500, "read_error", "could not read takes_packed.md")
