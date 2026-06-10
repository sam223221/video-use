"""Agent package — the embedded Claude Agent SDK editor.

The ONLY package that imports ``claude_agent_sdk``. Exposes the ``AgentSession``
facade; the HTTP layer talks to the agent exclusively through it.

Importing this package pulls in ``session`` (and thus ``claude_agent_sdk``), but
constructing the SDK client / connecting only happens lazily on the first
``AgentSession.send()``.
"""

from __future__ import annotations

from .session import AgentSession

__all__ = ["AgentSession"]
