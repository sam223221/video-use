"""Agent package — the embedded Claude Agent SDK editor (Step 3).

The ONLY package that imports ``claude_agent_sdk``. Deliberately exports
nothing at import time: ``routers/status.py`` lazily imports ``agent.env``
(stdlib-only) for ``auth_status()``, and keeping this ``__init__`` empty
means that probe never pays the SDK import. The chat router imports
``agent.session`` directly (which pulls the SDK + tools + prompt); the SDK
client/subprocess itself is only constructed lazily on the first
``AgentSession.send()``.
"""

from __future__ import annotations
