"""GET /api/status — health (contract §1).

Real detection: ffmpeg/ffprobe on PATH (+ version), ELEVENLABS key presence and
source, agent auth mode, and the version. Per-user session model: this endpoint
NO LONGER leaks a global active folder, the allowed roots, or any internal
filesystem path — there is no shared "current folder" anymore, and exposing the
session-tree root would be a needless information disclosure.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import settings
from ..agent import env as agent_env
from . import deps

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
def status(user: str = Depends(deps.require_session)) -> dict:
    ffmpeg_ok = settings.ffmpeg_available()
    version = settings.ffmpeg_version() if ffmpeg_ok else None
    key_present, key_source = settings.elevenlabs_key_present()

    return {
        "ffmpeg": {"ok": ffmpeg_ok, "version": version},
        "ffprobe": {"ok": settings.ffprobe_available()},
        "elevenlabs_key": {"present": key_present, "source": key_source},
        "agent_auth": agent_env.auth_status(),
        "version": settings.VERSION,
    }
