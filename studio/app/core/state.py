"""In-memory application state — emptied by the per-user session cutover.

Studio used to hold a SINGLE GLOBAL ``active_folder`` (persisted to
``state.json``, shared across all users) plus a per-folder agent-session cache in
this module. The per-user session model removed both:

* The global active folder is gone — every request now carries its own
  ``session_id`` and resolves a user-owned directory through ``core.sessions``
  (the ownership chokepoint). There is no shared, mutable "current folder".
* The agent-client cache moved to ``core.sessions`` (keyed by ``session_id``,
  holding the same :class:`AgentSession` so the ``ask_user`` Futures survive).

This module intentionally no longer exposes any state. It is kept as a stable
import target / migration breadcrumb; new code should use ``core.sessions``.
"""

from __future__ import annotations

# Nothing to export. See core/sessions.py for the session store + agent cache.
