"""GET /api/inventory?session_id= — ffprobe the session's sources (contract §6).

The ``session_id`` (client-carried) is resolved to the caller's OWNED session dir
via ``deps.require_session_dir``; a bad / cross-user / missing id is one uniform
404 session_not_found.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from ..helpers_wrap import inventory as inventory_wrap
from . import deps

router = APIRouter(prefix="/api", tags=["inventory"])


@router.get("/inventory")
async def inventory(
    session_id: str | None = Query(None),
    user: str = Depends(deps.require_session),
) -> dict:
    _user, _sid, folder = deps.require_session_dir(user, session_id)
    return await inventory_wrap.inventory(folder)
