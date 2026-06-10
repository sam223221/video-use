"""AgentSession facade (ARCHITECTURE.md §5.1).

One :class:`AgentSession` per user session, cached in ``core.sessions`` keyed by
``session_id`` (NOT by folder path — the per-user session cutover re-keyed the
cache). The SAME AgentSession object is reused across chat turns so the
``ask_user`` pending-question Futures (``_pending_questions``) survive between
requests and the answer round-trip keeps working. It is bound to the session's
resolved directory (``folder``), which the agent uses as its cwd and the root for
every tool path + output. Wraps a ``ClaudeSDKClient`` configured for clean,
isolated operation:

* ``system_prompt`` = SKILL.md body + Studio addendum (a plain string, which
  OVERRIDES the default — no ``claude_code`` preset, so the user's personal
  context is not inherited).
* ``setting_sources=[]`` — do NOT load user/project/local settings, hooks, or
  memory (brief Delta 2 isolation requirement).
* ``mcp_servers={"studio": <in-process server>}`` and ``allowed_tools`` =
  ``mcp__studio__*`` only (no shell/file/web).
* ``include_partial_messages=True`` for token-delta streaming.
* ``permission_mode="bypassPermissions"`` so the sanctioned Studio tools run
  without prompts (the tool surface is already tightly restricted).
* ``env`` from ``env.build_agent_env()`` — dual-mode auth (key kept in Docker,
  stripped natively for the subscription login).

``send(message)`` is an async generator of Studio SSE event tuples
``(event_type, data)``; the chat router serializes them. ``cancel()`` interrupts
the running turn. ``tool_progress`` events are merged in via an asyncio.Queue fed
by the per-tool progress callback.
"""

from __future__ import annotations

import asyncio
import secrets
from pathlib import Path
from typing import Any, AsyncIterator

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from ..helpers_wrap import inventory as inventory_wrap
from ..helpers_wrap import pack as pack_wrap
from . import env, prompt, relay, tools


class AgentSession:
    """A lazily-connected, per-folder agent conversation."""

    def __init__(self, folder: Path, *, session_id: str | None = None) -> None:
        self.folder = folder
        # The owning user-session id (cache key in core.sessions). Carried for
        # diagnostics / logging context; the conversation still binds to ``folder``.
        self.session_id = session_id
        self._client: ClaudeSDKClient | None = None
        self._connected = False
        self._lock = asyncio.Lock()
        self._current_turn_id: str | None = None
        # Out-of-band events for the in-flight turn (tool_progress + ask_user).
        self._progress_q: asyncio.Queue[tuple[str, dict]] | None = None
        self._active_tool_call_id: str | None = None
        # Pending interactive questions awaiting a browser answer, keyed by
        # (turn_id, question_id) so a stale turn's answer can never resolve a new
        # turn's question. Lives on the running event loop.
        self._pending_questions: dict[tuple[str, str], asyncio.Future] = {}

    # -- interactive questions (ask_user tool) -----------------------------
    @property
    def current_turn_id(self) -> str | None:
        """The turn_id of the in-flight turn, or None when idle. Read by the
        ``ask_user`` tool to key its pending question to the running turn."""
        return self._current_turn_id

    def register_question(self, turn_id: str, question_id: str) -> asyncio.Future:
        """Register (and return) a Future the ``ask_user`` tool awaits. Resolved by
        :meth:`resolve_question` (the answer endpoint) or cancelled on
        timeout / turn-cancel / client-disconnect so the turn never wedges."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending_questions[(turn_id, question_id)] = future
        return future

    async def emit_event(self, event_type: str, data: dict) -> None:
        """Push an out-of-band SSE event onto the per-turn queue so ``_merge``
        forwards it to the StreamingResponse alongside tool_progress."""
        if self._progress_q is not None:
            await self._progress_q.put((event_type, data))

    def resolve_question(self, turn_id: str, question_id: str, answers: Any) -> bool:
        """Resolve a pending question with the user's answers (called by the answer
        endpoint). Returns True if a matching, still-pending question was resolved,
        False otherwise (already answered / stale / unknown turn)."""
        key = (turn_id, question_id)
        future = self._pending_questions.get(key)
        if future is None or future.done():
            return False
        future.set_result(answers)
        self._pending_questions.pop(key, None)
        return True

    def cancel_question(self, turn_id: str, question_id: str) -> None:
        """Cancel + forget a single pending question (idempotent)."""
        future = self._pending_questions.pop((turn_id, question_id), None)
        if future is not None and not future.done():
            future.cancel()

    def _cancel_questions(self, turn_id: str | None = None) -> None:
        """Cancel all pending questions (optionally only those for ``turn_id``).

        Synchronous and idempotent so it is safe to call from the ``_merge``
        teardown path (during ``GeneratorExit``) and from ``cancel()`` — no yield,
        no await."""
        for key in list(self._pending_questions.keys()):
            if turn_id is not None and key[0] != turn_id:
                continue
            future = self._pending_questions.pop(key, None)
            if future is not None and not future.done():
                future.cancel()

    # -- lifecycle ---------------------------------------------------------
    async def _ensure_connected(self) -> None:
        if self._connected and self._client is not None:
            return

        live = await self._live_context()
        system_prompt = prompt.build_system_prompt(self.folder, live_context=live)

        async def progress_cb(tool_name: str, payload: dict) -> None:
            if self._progress_q is None:
                return
            data = {
                "tool_call_id": self._active_tool_call_id,
                "percent": payload.get("percent"),
                "phase": payload.get("phase"),
            }
            await self._progress_q.put(("tool_progress", data))

        server, allowed = tools.build_server(
            self.folder, progress_cb=progress_cb, session=self
        )

        options = ClaudeAgentOptions(
            system_prompt=system_prompt,
            mcp_servers={"studio": server},
            allowed_tools=allowed,
            # Block the CLI built-in AskUserQuestion: it is unanswerable in
            # Studio's headless bypassPermissions session and would otherwise show
            # as an inert chip. The Studio-owned mcp__studio__ask_user replaces it.
            disallowed_tools=["AskUserQuestion"],
            setting_sources=[],            # isolation: no user/project/local config
            permission_mode="bypassPermissions",
            include_partial_messages=True,
            cwd=str(self.folder),
            env=env.build_agent_env(),
        )

        self._client = ClaudeSDKClient(options=options)
        await self._client.connect()
        self._connected = True

    async def _live_context(self) -> dict[str, Any]:
        try:
            inv = await inventory_wrap.inventory(self.folder)
        except Exception:  # noqa: BLE001
            inv = {"count": None, "total_duration_s": None}
        transcripts_dir = self.folder / "edit" / "transcripts"
        return {
            "count": inv.get("count"),
            "total_duration_s": inv.get("total_duration_s"),
            "has_transcripts": transcripts_dir.is_dir()
            and any(transcripts_dir.glob("*.json")),
            "has_packed": pack_wrap.read_packed(self.folder) is not None,
        }

    # -- turn --------------------------------------------------------------
    async def send(self, message: str) -> AsyncIterator[tuple[str, dict]]:
        """Run one agent turn. Yields Studio SSE event tuples.

        Merges the SDK relay stream with out-of-band ``tool_progress`` events.
        Never raises — auth/SDK failures are yielded as an ``error`` event.
        """
        async with self._lock:
            turn_id = f"t_{secrets.token_hex(3)}"
            self._current_turn_id = turn_id
            self._progress_q = asyncio.Queue()

            yield "turn_start", {"turn_id": turn_id}

            try:
                await self._ensure_connected()
            except Exception as exc:  # noqa: BLE001
                yield "error", {
                    "turn_id": turn_id,
                    "code": "agent_auth",
                    "message": f"agent could not start: {exc}",
                }
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error"}
                self._reset_turn()
                return

            assert self._client is not None
            try:
                await self._client.query(message)
            except Exception as exc:  # noqa: BLE001
                yield "error", {"turn_id": turn_id, "code": "agent_error", "message": str(exc)}
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error"}
                self._reset_turn()
                return

            relay_iter = relay.relay(self._client.receive_response(), turn_id)
            try:
                async for event in self._merge(relay_iter):
                    if event[0] == "tool_start":
                        self._active_tool_call_id = event[1].get("tool_call_id")
                    yield event
            except Exception as exc:  # noqa: BLE001
                yield "error", {"turn_id": turn_id, "code": "agent_error", "message": str(exc)}
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error"}
            finally:
                self._reset_turn()

    def _reset_turn(self) -> None:
        # Cancel any question still pending for the turn that is ending so a tool
        # blocked on ask_user unblocks (returns "(cancelled)") and the per-folder
        # lock is released — the turn can never wedge waiting on an answer.
        self._cancel_questions(self._current_turn_id)
        self._current_turn_id = None
        self._progress_q = None
        self._active_tool_call_id = None

    async def _merge(
        self, relay_iter: AsyncIterator[tuple[str, dict]]
    ) -> AsyncIterator[tuple[str, dict]]:
        """Interleave relay events with queued tool_progress events."""
        q = self._progress_q
        assert q is not None

        relay_task: asyncio.Task | None = asyncio.ensure_future(_anext(relay_iter))
        prog_task: asyncio.Task | None = asyncio.ensure_future(q.get())

        try:
            while relay_task is not None:
                wait_set = {t for t in (relay_task, prog_task) if t is not None}
                done, _ = await asyncio.wait(wait_set, return_when=asyncio.FIRST_COMPLETED)

                if prog_task is not None and prog_task in done:
                    yield prog_task.result()
                    prog_task = asyncio.ensure_future(q.get())

                if relay_task in done:
                    try:
                        event = relay_task.result()
                    except StopAsyncIteration:
                        relay_task = None
                        break
                    yield event
                    if event[0] == "turn_end":
                        relay_task = None
                        break
                    relay_task = asyncio.ensure_future(_anext(relay_iter))
        finally:
            # Only cancel the pending tasks here. Do NOT yield inside finally:
            # on client disconnect mid-turn the finally runs during GeneratorExit
            # (aclose), and a yield there raises RuntimeError "async generator
            # ignored GeneratorExit" when the progress queue is non-empty.
            for t in (relay_task, prog_task):
                if t is not None and not t.done():
                    t.cancel()
            # Client disconnect mid-turn (aclose) must also unblock any ask_user
            # tool awaiting an answer that will now never arrive. Cancelling the
            # Future is synchronous (no yield/await), so it is GeneratorExit-safe.
            self._cancel_questions(self._current_turn_id)

    async def cancel(self) -> None:
        """Interrupt the running turn (best-effort)."""
        # Unblock any ask_user tool first so a turn parked on an unanswered
        # question actually stops instead of waiting out the 600 s timeout.
        self._cancel_questions(self._current_turn_id)
        if self._client is not None and self._connected:
            try:
                await self._client.interrupt()
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        self._cancel_questions()
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self._connected = False
        self._client = None


async def _anext(it: AsyncIterator) -> Any:
    return await it.__anext__()
