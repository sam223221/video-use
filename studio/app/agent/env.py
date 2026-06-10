"""Agent environment hygiene — dual-mode auth (brief Delta 2).

The Agent SDK picks billing from the environment:

* ``ANTHROPIC_API_KEY`` present  -> API-key mode (pay-as-you-go). This is the
  Docker / primary run path; we KEEP the key so the SDK uses it.
* ``ANTHROPIC_API_KEY`` absent   -> subscription mode via the local Claude Code
  login (Max subscription). We additionally STRIP ``ANTHROPIC_AUTH_TOKEN`` so a
  stray token can't silently switch billing.

Either way we ISOLATE the agent from the user's PERSONAL Claude Code config: the
SDK is told ``setting_sources=[]`` (see session.py) so it does NOT load
user/project/local settings, hooks, or memory. This module only decides the env
dict and reports the detected mode.
"""

from __future__ import annotations

import os
import shutil
from typing import Literal

from .. import settings

AgentAuthMode = Literal["api_key", "subscription", "unavailable"]


def build_agent_env() -> dict[str, str]:
    """Return the environment the SDK subprocess should see.

    * API-key mode: pass the env through unchanged (the key is honored).
    * Subscription mode: strip ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN``
      so the SDK falls back to the local Claude Code login.
    """
    env = dict(os.environ)
    if settings.has_anthropic_api_key():
        return env  # API-key mode — keep the key.
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def detect_mode() -> AgentAuthMode:
    """Cheap, non-billing detection of how the agent will authenticate.

    * API key present                       -> ``api_key``.
    * No key, ``claude`` CLI on PATH        -> ``subscription`` (login may exist).
    * No key, no CLI                         -> ``unavailable``.

    A definitive subscription check requires a real turn (which costs tokens), so
    we treat CLI presence as "subscription available" and surface a clear error
    in the chat stream if the actual turn fails to authenticate.
    """
    if settings.has_anthropic_api_key():
        return "api_key"
    if shutil.which("claude"):
        return "subscription"
    return "unavailable"


def auth_status() -> dict:
    """Status payload for ``GET /api/status`` -> ``agent_auth`` (contract §1)."""
    mode = detect_mode()
    detail = {
        "api_key": "ANTHROPIC_API_KEY present (pay-as-you-go)",
        "subscription": "claude code login detected (Max subscription)",
        "unavailable": "no ANTHROPIC_API_KEY and no claude CLI on PATH",
    }[mode]
    return {"ok": mode != "unavailable", "mode": mode, "detail": detail}
