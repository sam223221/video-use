"""AgentSession — the per-conversation Claude Agent SDK facade (arch §1.2).

Adapted from v1 ``studio/app/agent/session.py`` + ``relay.py`` (the SDK
message → SSE event mapper is folded in here as :func:`_relay_events`; the
arch's agent/ file list has no separate relay module). What changed vs v1:

* **Cache key** = ``(user, device_id, project_id)`` — the conversation is
  bound to the device+project pair that opened it (arch §3.7); all its tool
  commands route to exactly that device. The cache lives HERE
  (module-level), with **idle eviction after 60 min** (arch §9 — fixes v1's
  known unbounded-cache nit): a lazy sweep on every :func:`get_session` plus
  a 10-minute background timer closes idle SDK subprocesses.
* **No cwd binding** — the SDK subprocess runs wherever the relay runs; the
  agent has no filesystem tools at all, so the working directory is inert
  (v1 bound cwd to the session folder; v2 has no folders).
* **No ask_user Future plumbing and no _merge/progress queue** — questions
  are bridge commands now (arch §10.7): the ask_user tool blocks inside
  ``bridge.dispatch`` like every other tool, so the chat stream carries ONLY
  the §2.2 vocabulary (turn_start / assistant_delta / tool_start /
  tool_input / tool_end / turn_end / error) and the session needs no
  out-of-band event channel.
* **Live-context priming over the bridge** (arch §4.3 item 2): one
  ``get_inventory`` dispatch at session connect feeds the system prompt; a
  ``device_offline``/timeout degrades gracefully to a prompt that says the
  contents are unknown and to call ``get_inventory`` first.
* **Turn-cancel chip copy is contract-bound**: when ``cancel()`` interrupts a
  turn with a tool still in flight, the SDK synthesizes an error tool_result
  carrying model-coaching boilerplate ("The user doesn't want to proceed with
  this tool use…"); ``_relay_events`` rewrites that summary to the v1-verbatim
  ``"(cancelled)"`` so SDK copy never reaches a UI chip (gated on the turn's
  cancel flag + known prefixes — see ``_SDK_INTERRUPT_PREFIXES``).
* **Only product tools get chips**: the SDK's deferred-tool mechanism makes
  the model call the built-in ``ToolSearch`` before every ``mcp__studio2__*``
  call — plumbing, not product. ``_relay_events`` emits
  tool_start/tool_input/tool_end ONLY for ``mcp__studio2__*`` names and
  suppresses every other tool call AND its paired result entirely (no chip;
  the suppressed NAME is logged once per call, sanitized — see
  ``_is_product_tool``). Text deltas are never filtered. Seq-safe by
  construction: ``core/turns.py`` assigns seq at buffer-append time, so
  unemitted events never occupy a seq and attach replay matches live.

ClaudeAgentOptions carries the v1 isolation invariants verbatim:
``system_prompt`` as a plain string (overrides the default — no personal
context inherited), ``setting_sources=[]``, ``permission_mode=
"bypassPermissions"`` (the tool surface is already tightly restricted),
``include_partial_messages=True`` for token deltas, built-in
``AskUserQuestion`` disallowed (replaced by ``mcp__studio2__ask_user``), and
``env`` from ``env.build_agent_env()`` (subscription-mode stripping).

``send(message)`` is an async generator of ``(event_type, data)`` tuples and
NEVER raises — auth/SDK failures become ``error`` + ``turn_end`` events. It
is consumed by ``core/turns.py``'s detached task, never directly by an HTTP
response (the turn-survival design).
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any, AsyncIterator, Callable

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from ..core import agent_model, applog, bridge
from . import env, prompt, tools

_log = logging.getLogger("studio2.agent")

IDLE_EVICT_S = 60 * 60      # arch §9: close idle SDK subprocesses after 60 min
_SWEEP_INTERVAL_S = 10 * 60

SessionKey = tuple[str, str, str]  # (user, device_id, project_id)


class AgentSession:
    """A lazily-connected agent conversation for one (user, device, project)."""

    def __init__(self, user: str, device_id: str, project_id: str) -> None:
        self.user = user
        self.device_id = device_id
        self.project_id = project_id
        self.last_used = time.time()
        # The agent_model.version() this session was BUILT against. Stamped at
        # construction so the cache can detect a model change (a later set()
        # bumps the global version) and rebuild the session on the next turn —
        # the running turn keeps its old model, the NEXT one gets the new one.
        # See get_session()'s stale-version eviction.
        self.model_version = agent_model.version()
        self._client: ClaudeSDKClient | None = None
        self._connected = False
        self._lock = asyncio.Lock()
        self._current_turn_id: str | None = None
        # True once cancel() ran for the CURRENT turn (reset at turn start).
        # Gates the §2.2 "(cancelled)" rewrite of the SDK's synthesized
        # interrupt tool_result in _relay_events — see _SDK_INTERRUPT_PREFIXES.
        self._cancel_requested = False

    # -- read by agent/tools.py to key dispatches to the running turn -------
    @property
    def current_turn_id(self) -> str | None:
        return self._current_turn_id

    # -- lifecycle -----------------------------------------------------------
    async def _ensure_connected(self) -> None:
        if self._connected and self._client is not None:
            return

        live = await self._prime_live_context()
        system_prompt = prompt.build_system_prompt(
            self.project_id, live_context=live
        )
        server, allowed = tools.build_server(self)

        # Global agent-model selection (the model picker). resolve() returns the
        # model id to pass, or None for "default" — in which case the ``model``
        # kwarg is OMITTED ENTIRELY so the options are byte-identical to the
        # pre-picker behavior (inherit the Claude Code CLI default). The version
        # this build commits to is re-stamped here (the connect, not the
        # construct, is when the model is actually bound), so a model change
        # that lands between construction and first connect still rebuilds on
        # the next turn rather than silently using a stale stamp.
        resolved_model = agent_model.resolve()
        self.model_version = agent_model.version()
        model_kwargs: dict[str, Any] = (
            {"model": resolved_model} if resolved_model is not None else {}
        )

        options = ClaudeAgentOptions(
            system_prompt=system_prompt,
            mcp_servers={"studio2": server},
            allowed_tools=allowed,
            # Block the CLI built-in AskUserQuestion: unanswerable in a
            # headless bypassPermissions session — mcp__studio2__ask_user
            # (a bridge command) replaces it. v1 invariant.
            disallowed_tools=["AskUserQuestion"],
            setting_sources=[],            # isolation: no user/project/local config
            permission_mode="bypassPermissions",
            include_partial_messages=True,
            # NO cwd: the agent has no filesystem tools; nothing user-related
            # is ever bound to the subprocess working directory (arch §1.2).
            env=env.build_agent_env(),
            # The selected model when non-default; OMITTED for "default" (above)
            # so the option set stays byte-identical to today.
            **model_kwargs,
        )

        self._client = ClaudeSDKClient(options=options)
        await self._client.connect()
        self._connected = True
        _log.info(
            "agent connected device_id=%s project_id=%s primed=%s model=%s "
            "model_version=%s",
            self.device_id, self.project_id, live is not None,
            resolved_model or "default", self.model_version,
        )

    async def _prime_live_context(self) -> dict[str, Any] | None:
        """One get_inventory over the bridge (arch §4.3 item 2). Tolerates an
        unreachable device — the prompt then says 'unknown, call
        get_inventory'. Uses a SHORT timeout: priming must not stall the
        first turn for the full 30 s read window."""
        try:
            return await bridge.dispatch(
                user=self.user,
                device_id=self.device_id,
                project_id=self.project_id,
                turn_id=self._current_turn_id or f"t_{secrets.token_hex(3)}",
                tool="get_inventory",
                params={},
                timeout_s=10.0,
            )
        except bridge.BridgeError as exc:
            _log.info(
                "live-context prime skipped device_id=%s code=%s",
                self.device_id, exc.code,
            )
            return None
        except Exception:  # noqa: BLE001 - priming is best-effort by contract
            return None

    # -- turn ------------------------------------------------------------------
    async def send(self, message: str) -> AsyncIterator[tuple[str, dict]]:
        """Run one agent turn. Yields §2.2 event tuples. Never raises."""
        async with self._lock:
            turn_id = f"t_{secrets.token_hex(3)}"
            self._current_turn_id = turn_id
            self._cancel_requested = False
            self.last_used = time.time()

            yield "turn_start", {"turn_id": turn_id}

            try:
                await self._ensure_connected()
            except Exception as exc:  # noqa: BLE001
                yield "error", {
                    "turn_id": turn_id,
                    "code": "agent_auth",
                    "message": f"agent could not start: {exc}",
                }
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error", "text": ""}
                self._reset_turn()
                return

            assert self._client is not None
            try:
                await self._client.query(message)
            except Exception as exc:  # noqa: BLE001
                yield "error", {
                    "turn_id": turn_id, "code": "agent_error", "message": str(exc),
                }
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error", "text": ""}
                self._reset_turn()
                return

            try:
                async for event in _relay_events(
                    self._client.receive_response(),
                    turn_id,
                    # Evaluated per tool_end (the flag flips mid-stream when
                    # /api/chat/cancel lands while events are being mapped).
                    lambda: self._cancel_requested,
                ):
                    yield event
            except Exception as exc:  # noqa: BLE001
                yield "error", {
                    "turn_id": turn_id, "code": "agent_error", "message": str(exc),
                }
                yield "turn_end", {"turn_id": turn_id, "stop_reason": "error", "text": ""}
            finally:
                self._reset_turn()

    def _reset_turn(self) -> None:
        # Any command still pending for the ending turn must not strand its
        # dispatcher (mirrors v1's _cancel_questions teardown; normally the
        # SDK resolved every tool before turn_end and this is a no-op).
        if self._current_turn_id:
            bridge.cancel_for_turn(self._current_turn_id)
        self._current_turn_id = None
        self.last_used = time.time()

    async def cancel(self) -> None:
        """Interrupt the running turn (best-effort): unblock pending bridge
        commands FIRST (a turn parked on ask_user must not wait out 600 s),
        then SDK interrupt."""
        # Mark BEFORE the interrupt goes out: the SDK's synthesized interrupt
        # tool_result (if the interrupt beats a tool's real result) is only
        # rewritten to the "(cancelled)" contract text when the turn really
        # was cancelled — never on an ordinary failure.
        self._cancel_requested = True
        if self._current_turn_id:
            bridge.cancel_for_turn(self._current_turn_id)
        if self._client is not None and self._connected:
            try:
                await self._client.interrupt()
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        if self._current_turn_id:
            bridge.cancel_for_turn(self._current_turn_id)
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
        self._connected = False
        self._client = None


# ============================================================================
# Session cache (keyed per arch §3.7; idle-evicted per arch §9)
# ============================================================================

_sessions: dict[SessionKey, AgentSession] = {}
_sweeper_started = False


def get_session(user: str, device_id: str, project_id: str) -> AgentSession:
    """The cached AgentSession for this key, created on first use. The SAME
    object is reused across turns so the SDK conversation context persists
    (v1 behavior). Must be called from a running event loop.

    Before returning, a cached session built against an OUTDATED agent-model
    version is evicted so the NEXT turn rebuilds with the newly-selected model
    (the model picker). A session mid-turn (lock held) is NEVER yanked — the
    in-flight turn finishes on its old model and is evicted on the first
    post-turn call (same posture as the idle sweep)."""
    _ensure_sweeper()
    _sweep_idle()
    key: SessionKey = (user, device_id, project_id)
    sess = _sessions.get(key)
    if sess is not None and _model_version_stale(sess):
        # The global model changed since this session connected. Drop it from
        # the cache (closed in the background) so a fresh one rebuilds with the
        # new model on this very turn.
        _sessions.pop(key, None)
        _log.info(
            "agent session evicted (model change) device_id=%s project_id=%s "
            "built_version=%s current_version=%s",
            sess.device_id, sess.project_id,
            sess.model_version, agent_model.version(),
        )
        asyncio.get_running_loop().create_task(sess.close())
        sess = None
    if sess is None:
        sess = AgentSession(user, device_id, project_id)
        _sessions[key] = sess
    sess.last_used = time.time()
    return sess


def _model_version_stale(sess: AgentSession) -> bool:
    """True when ``sess`` was built against an older agent-model version AND is
    not currently running a turn. A mid-turn session (lock held) is reported
    NOT stale so a live turn is never interrupted by a model change; it is
    re-checked (and evicted) on the next ``get_session`` after the turn ends."""
    if sess.model_version == agent_model.version():
        return False
    if sess._lock.locked():
        return False  # a turn is live — let it finish on its old model
    return True


def peek_session(user: str, device_id: str, project_id: str) -> AgentSession | None:
    """The cached session if one exists — used by chat/cancel (a cancel must
    never CREATE a conversation)."""
    return _sessions.get((user, device_id, project_id))


def _sweep_idle() -> None:
    cutoff = time.time() - IDLE_EVICT_S
    for key in [k for k, s in _sessions.items() if s.last_used < cutoff]:
        sess = _sessions.pop(key, None)
        if sess is None:
            continue
        if sess._lock.locked():  # a turn is somehow live — never yank it
            _sessions[key] = sess
            continue
        _log.info(
            "agent session evicted (idle) device_id=%s project_id=%s",
            sess.device_id, sess.project_id,
        )
        asyncio.get_running_loop().create_task(sess.close())


def _ensure_sweeper() -> None:
    """A 10-minute background sweep so idle subprocesses close even when no
    new chat traffic arrives to trigger the lazy sweep."""
    global _sweeper_started
    if _sweeper_started:
        return
    _sweeper_started = True

    async def _loop() -> None:
        while True:
            await asyncio.sleep(_SWEEP_INTERVAL_S)
            try:
                _sweep_idle()
            except Exception:  # noqa: BLE001 - the sweeper must never die
                pass

    asyncio.get_running_loop().create_task(_loop(), name="studio2-agent-sweeper")


# ============================================================================
# SDK message stream -> §2.2 event tuples (v1 agent/relay.py, adapted)
# ============================================================================

_PRODUCT_TOOL_PREFIX = "mcp__studio2__"


def _is_product_tool(name: str) -> bool:
    """True only for the product's own MCP tools (the §4 tool surface).

    Everything else is SDK plumbing — the deferred-tool ``ToolSearch`` the
    CLI makes the model call before each ``mcp__studio2__*`` call today, any
    future built-in tomorrow — and must never surface as a UI chip:
    ``_relay_events`` suppresses tool_start/tool_input/tool_end for the call
    and its paired result entirely, logging the suppressed NAME (sanitized,
    name-only) so debugging stays possible. Text deltas are never filtered.
    """
    return name.startswith(_PRODUCT_TOOL_PREFIX)


def _short_tool(name: str) -> str:
    """Friendly short name for a tool chip (strip the mcp__studio2__ prefix)."""
    if name.startswith("mcp__studio2__"):
        return name[len("mcp__studio2__"):]
    if name.startswith("mcp__"):
        return name.split("__")[-1]
    return name


def _summarize_input(tool: str, inp: Any) -> str:
    """A compact one-line summary of a tool call's input for the UI chip."""
    if not isinstance(inp, dict) or not inp:
        return ""
    if tool.endswith("apply_cuts"):
        remove = inp.get("remove")
        n = len(remove) if isinstance(remove, list) else "?"
        bits = [f"{inp.get('clip_id', '?')}: {n} range(s)"]
        if inp.get("snap") == "keep":
            bits.append("snap=keep")
        return ", ".join(bits)
    if tool.endswith("ask_user"):
        qs = inp.get("questions")
        return f"{len(qs)} question(s)" if isinstance(qs, list) else ""
    if tool.endswith(("describe_clip", "read_transcript")):
        return str(inp.get("clip_id", ""))
    for k, v in inp.items():
        if isinstance(v, (str, int, float, bool)):
            return f"{k}={v}"
    return ""


# When interrupt() lands while a tool call is still in flight, the SDK CLI
# DISCARDS the tool's real result and synthesizes an ``is_error`` tool_result
# whose text is coaching aimed at the MODEL ("The user doesn't want to proceed
# with this tool use. … consider saving that to memory for future sessions") —
# copy that references files/memory this product does not have and that must
# never reach a UI chip. The §2.2 contract for a turn-cancel is the v1-verbatim
# "(cancelled)" (the same text the ask_user bridge-cancel path returns when its
# result WINS the race against the interrupt — the two paths must render
# identically). There is no structured interrupt marker on the ToolResultBlock
# (only ``is_error`` + free text), so this matches stable PREFIXES of the known
# shapes. FRAGILE BY NATURE: an SDK upgrade that rewords the boilerplate leaks
# it to the chip again until a prefix is added here. The rewrite is additionally
# gated on the turn actually having been cancelled (session._cancel_requested),
# so a real tool failure can never be masked.
_SDK_INTERRUPT_PREFIXES = (
    # Interrupt/rejection of an in-flight tool use (the shape the M1 desktop
    # test run hit on Stop with a pending ask_user).
    "The user doesn't want to proceed with this tool use",
    # The SDK's other known interrupt rendering ("[Request interrupted by
    # user]" / "[Request interrupted by user for tool use]").
    "[Request interrupted by user",
)


def _is_sdk_interrupt_boilerplate(text: str) -> bool:
    """True when a tool_result's text is the SDK's own interrupt copy."""
    return text.lstrip().startswith(_SDK_INTERRUPT_PREFIXES)


def _result_text(content: Any) -> str:
    """Flatten a ToolResultBlock content into a short text summary."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif item.get("type") == "image":
                    parts.append("[image]")
            elif isinstance(item, TextBlock):
                parts.append(item.text)
            else:
                parts.append(str(item))
        return " ".join(p for p in parts if p)
    return str(content)


def _join_text_segments(parts: list[str]) -> str:
    """Assemble the turn's final assistant text from its TextBlock segments.

    A turn shaped text→tool→text produces MULTIPLE TextBlocks (one assistant
    message per stretch of prose between tool calls). A bare ``"".join``
    fused the last word of one segment to the first word of the next
    ("…which part should I cut?Great — I removed…"): the live delta stream
    rendered fine (each segment streams as its own bubble), but the PWA
    persists ``turn_end.text`` to the device transcript and re-renders it on
    reload by splitting paragraphs on blank lines (``\\n{2,}``) — which never
    fired, so reloaded turns collapsed into one run-on blob. Joining with a
    blank line keeps the reload rendering identical to the live stream.
    Whitespace-only segments are dropped (they carry no rendered content and
    would otherwise produce stray empty paragraphs).
    """
    return "\n\n".join(p for p in parts if p.strip())


async def _relay_events(
    messages: AsyncIterator[Any],
    turn_id: str,
    cancel_requested: Callable[[], bool],
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Map an SDK message stream to §2.2 event tuples — v1 ``relay.relay``
    minus the artifact extraction (v2 tools return no file paths; there is
    no edit/ dir anywhere). Emits: ``assistant_delta``, ``tool_start``,
    ``tool_input``, ``tool_end``, ``turn_end``.

    ``turn_end.text`` (and the no-delta fallback ``assistant_delta``) is the
    turn's TextBlock segments joined with a BLANK LINE between them
    (:func:`_join_text_segments`) — the PWA persists that text and re-renders
    paragraphs on reload by splitting on blank lines, so segment boundaries
    must survive assembly.

    ``cancel_requested`` reports whether THIS turn was cancelled (checked at
    each tool_end, not captured at generator start — the flag flips
    mid-stream): when it has been AND an error tool_result carries the SDK's
    synthesized interrupt boilerplate, the chip summary is rewritten to the
    contract text ``"(cancelled)"`` (see ``_SDK_INTERRUPT_PREFIXES``). Real
    tool failures pass through untouched.

    Chip filtering: ONLY ``mcp__studio2__*`` tools produce chip events
    (``_is_product_tool``). Any other tool name — the SDK's deferred-tool
    ``ToolSearch`` today, future built-ins — is suppressed: no
    tool_start/tool_input is emitted for the call and no tool_end for its
    result (tracked via ``suppressed_tool_ids``); the suppressed NAME is
    logged once per call (sanitized, name-only, never the input). Assistant
    text deltas are NEVER filtered. Suppression cannot break seq continuity
    or attach replay: the turn buffer (``core/turns.py``) assigns seq at
    append time, so events that are simply not yielded never occupy a seq.
    """
    seen_tool_starts: set[str] = set()
    suppressed_tool_ids: set[str] = set()  # non-product tool calls: no chips
    emitted_text_via_delta = False
    final_assistant_text_parts: list[str] = []

    async for msg in messages:
        # ---- partial streaming events (token deltas, block starts) -------
        if isinstance(msg, StreamEvent):
            ev = msg.event or {}
            etype = ev.get("type")
            if etype == "content_block_delta":
                delta = ev.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    emitted_text_via_delta = True
                    yield "assistant_delta", {"turn_id": turn_id, "text": delta["text"]}
            elif etype == "content_block_start":
                block = ev.get("content_block") or {}
                if block.get("type") == "tool_use":
                    tcid = block.get("id", "")
                    name = block.get("name", "")
                    if tcid and tcid not in seen_tool_starts:
                        seen_tool_starts.add(tcid)
                        if not _is_product_tool(name):
                            suppressed_tool_ids.add(tcid)
                            _log.info(
                                "tool chip suppressed (non-product tool) "
                                "tool=%s turn_id=%s",
                                applog.sanitize_log_value(name, 200), turn_id,
                            )
                        else:
                            yield "tool_start", {
                                "turn_id": turn_id,
                                "tool": _short_tool(name),
                                "tool_call_id": tcid,
                                "input_summary": "",
                            }
            continue

        # ---- complete assistant message (text + tool_use blocks) ---------
        if isinstance(msg, AssistantMessage):
            for block in msg.content:
                if isinstance(block, TextBlock):
                    final_assistant_text_parts.append(block.text)
                elif isinstance(block, ToolUseBlock):
                    if block.id in suppressed_tool_ids:
                        continue  # already suppressed at content_block_start
                    if not _is_product_tool(block.name):
                        # First sighting arrived via the complete message
                        # (no partial stream event for this call).
                        seen_tool_starts.add(block.id)
                        suppressed_tool_ids.add(block.id)
                        _log.info(
                            "tool chip suppressed (non-product tool) "
                            "tool=%s turn_id=%s",
                            applog.sanitize_log_value(block.name, 200), turn_id,
                        )
                        continue
                    if block.id not in seen_tool_starts:
                        seen_tool_starts.add(block.id)
                        yield "tool_start", {
                            "turn_id": turn_id,
                            "tool": _short_tool(block.name),
                            "tool_call_id": block.id,
                            "input_summary": _summarize_input(block.name, block.input),
                        }
                    else:
                        yield "tool_input", {
                            "turn_id": turn_id,
                            "tool_call_id": block.id,
                            "input_summary": _summarize_input(block.name, block.input),
                        }
            continue

        # ---- user message carrying tool results --------------------------
        if isinstance(msg, UserMessage):
            content = msg.content
            blocks = content if isinstance(content, list) else []
            for block in blocks:
                if isinstance(block, ToolResultBlock):
                    if block.tool_use_id in suppressed_tool_ids:
                        # Paired with a suppressed (non-product) tool call —
                        # there is no chip to close. Not emitting is seq-safe:
                        # the buffer numbers only what is yielded.
                        continue
                    summary = _result_text(block.content)
                    is_error = bool(block.is_error)
                    if (
                        is_error
                        and cancel_requested()
                        and _is_sdk_interrupt_boilerplate(summary)
                    ):
                        # Turn-cancel contract text (v1-verbatim; aligns with
                        # the ask_user bridge-cancel path's ordinary
                        # "(cancelled)" result). ``ok`` stays False — the tool
                        # did not complete; only the COPY is contract-bound.
                        summary = "(cancelled)"
                    yield "tool_end", {
                        "turn_id": turn_id,
                        "tool_call_id": block.tool_use_id,
                        "ok": not is_error,
                        "summary": summary[:500],
                    }
            continue

        if isinstance(msg, SystemMessage):
            continue

        # ---- result message ends the turn --------------------------------
        if isinstance(msg, ResultMessage):
            final_text = _join_text_segments(final_assistant_text_parts)
            if not emitted_text_via_delta and final_text:
                yield "assistant_delta", {
                    "turn_id": turn_id,
                    "text": final_text,
                }
            stop_reason = "error" if msg.is_error else (msg.stop_reason or "end_turn")
            yield "turn_end", {
                "turn_id": turn_id,
                "stop_reason": stop_reason,
                "text": final_text,
            }
            return

    # Stream ended without an explicit ResultMessage.
    final_text = _join_text_segments(final_assistant_text_parts)
    if not emitted_text_via_delta and final_text:
        yield "assistant_delta", {
            "turn_id": turn_id,
            "text": final_text,
        }
    yield "turn_end", {
        "turn_id": turn_id,
        "stop_reason": "end_turn",
        "text": final_text,
    }
