"""GET /api/status — relay health (arch §2.1).

Shape: ``{ok, version, agent_auth:{mode, detail}, agent_model:"<id>"|"default",
bridge:{devices_connected}, transcribe:{configured, enabled,
daily_remaining:{calls, audio_mib}}}``.

Step-1 reality (NOTED per the build plan): the agent runtime (``app/agent/``)
and the device-tool bridge (``core/bridge.py``) arrive in Step 3. Until those
modules exist this endpoint reports ``agent_auth.mode = "unknown"`` and
``bridge.devices_connected = 0`` via guarded lazy imports — the moment Step 3
lands its modules, the real values flow through this file UNCHANGED (no
Step-3 edit to this router needed, preserving one-owner-per-file).

Auth-gated like every ``/api/*`` route (cookie). Unlike v1's status endpoint
there is no ffmpeg/ELEVENLABS probing — the relay runs no media tooling at
all (arch kill list).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import settings
from . import deps

router = APIRouter(prefix="/api", tags=["status"])


def _agent_auth() -> dict:
    """Agent credential mode — real once Step 3's ``agent/env.py`` exists.

    Mirrors v1's ``agent/env.py`` ``auth_status()`` contract:
    ``{mode: "subscription"|"api_key"|"unavailable", detail: str}``. Until
    then: ``mode="unknown"`` with an honest detail string. Never raises.
    """
    try:
        from ..agent import env as agent_env  # Step 3 module

        status = agent_env.auth_status()
        if isinstance(status, dict):
            return status
    except Exception:  # noqa: BLE001 - the stub path IS the Step-1 contract
        pass
    return {"mode": "unknown", "detail": "agent runtime not installed yet (Step 3)"}


def _devices_connected() -> int:
    """Open bridge streams — real once Step 3's ``core/bridge.py`` exists."""
    try:
        from ..core import bridge  # Step 3 module

        return int(bridge.devices_connected())
    except Exception:  # noqa: BLE001 - the stub path IS the Step-1 contract
        return 0


def _agent_model() -> str:
    """The current GLOBAL agent-model selection for display (the model picker).

    An allowlist id, or ``"default"`` (inherit the CLI). Guarded-lazy like the
    rest of this file: a missing/broken store degrades to ``"default"`` rather
    than 500ing status. Presence/display only — the model id is not a secret."""
    try:
        from ..core import agent_model  # the model picker store

        return agent_model.current()
    except Exception:  # noqa: BLE001 - status must never 500 on a sub-probe
        return "default"


def _transcribe() -> dict:
    """Transcription availability + daily headroom — the PWA gates the
    Transcribe affordance on ``configured`` (arch §3.5). Presence only, never
    the key. Guarded-lazy like the rest of this file: a broken transcribe
    module degrades to ``configured:false`` instead of 500ing /api/status.

    Shape: ``{configured, enabled, daily_remaining:{calls, audio_mib}}``.
    """
    try:
        from ..core import transcribe as transcribe_svc  # M2 module

        summary = transcribe_svc.status_summary()
        if isinstance(summary, dict):
            return summary
    except Exception:  # noqa: BLE001 - status must never 500 on a sub-probe
        pass
    return {
        "configured": False,
        "enabled": False,
        "daily_remaining": {"calls": 0, "audio_mib": 0},
    }


@router.get("/status")
def status(user: str = Depends(deps.require_session)) -> dict:
    return {
        "ok": True,
        "version": settings.VERSION,
        "agent_auth": _agent_auth(),
        "agent_model": _agent_model(),
        "bridge": {"devices_connected": _devices_connected()},
        "transcribe": _transcribe(),
    }
