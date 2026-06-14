"""Agent settings HTTP surface — the global model picker (plan 2026-06-13).

Two cookie-authenticated routes on the v1 error envelope
(``{detail:{error:{code,message}}}``), the 8th router:

* ``GET  /api/agent/model`` -> ``{current, available:[{id,label,hint}],
  applies_to:"new conversations"}`` — the current GLOBAL selection plus the
  verified allowlist for the picker.
* ``POST /api/agent/model`` ``{model}`` -> validate against the allowlist
  (400 ``invalid_model`` otherwise), persist, bump the model-version (so
  ``agent/session.py`` rebuilds cached sessions on the next turn), return the
  new ``{current, available}``.

GLOBAL scope (USER decision): any logged-in household user may read or change
the setting — there is no per-user / per-project model state. The change
applies to NEW agent conversations/turns; an in-flight turn finishes on its old
model (``agent/session.py`` evicts the cached session so the NEXT turn rebuilds).

Security (plan §7): cookie auth on BOTH routes (``deps.require_session``);
allowlist-only model ids (no free text — can't inject a bogus/non-subscription
model); the selection persists under the gitignored ``.runtime/``; NO secret is
read, written, logged, or returned (the model id is not a secret, and no
ANTHROPIC_API_KEY is ever introduced — the subscription invariant is untouched).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from ..core import agent_model
from . import deps

router = APIRouter(prefix="/api", tags=["agent"])

# Constant copy describing WHEN a change takes effect — surfaced verbatim in the
# picker so the user understands an in-flight turn keeps its old model.
_APPLIES_TO = "new conversations"


def _payload() -> dict:
    """The shared GET / POST response body: current selection + allowlist."""
    return {
        "current": agent_model.current(),
        "available": agent_model.available(),
    }


@router.get("/agent/model")
def get_model(user: str = Depends(deps.require_session)) -> dict:
    """The current GLOBAL agent model + the verified allowlist (arch picker)."""
    body = _payload()
    body["applies_to"] = _APPLIES_TO
    return body


@router.post("/agent/model")
def set_model(
    payload: dict = Body(...),
    user: str = Depends(deps.require_session),
) -> dict:
    """Set the GLOBAL agent model. ``{model: "<id>"|"default"}``.

    400 ``invalid_model`` when ``model`` is missing, the wrong type, or not on
    the allowlist (no free text — security §7). On success the value is
    persisted to ``.runtime/agent_model.json`` and the model-version is bumped
    so cached agent sessions rebuild on their next turn. Returns the new
    ``{current, available}``.
    """
    model = payload.get("model") if isinstance(payload, dict) else None
    if not isinstance(model, str) or not agent_model.is_allowed(model):
        raise deps.http_error(
            400,
            "invalid_model",
            "choose one of the available models",
        )
    agent_model.set(model)
    return _payload()
