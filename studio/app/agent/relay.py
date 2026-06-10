"""Translate SDK stream messages into Studio SSE events (ARCHITECTURE.md §5.6).

``ClaudeSDKClient.receive_response()`` yields a mix of:

* ``StreamEvent``     — raw partial-message events. ``.event`` is the Anthropic
  streaming dict; ``content_block_delta`` with ``delta.type == "text_delta"``
  carries assistant text deltas. ``content_block_start`` for a ``tool_use`` block
  announces a tool call.
* ``AssistantMessage``— the complete assistant turn (TextBlock + ToolUseBlock).
  Fallback for text if partial deltas weren't emitted; captures tool inputs.
* ``UserMessage``     — carries ToolResultBlocks (tool outputs). -> ``tool_end``.
* ``ResultMessage``   — end of the turn. -> ``turn_end``.

Pure mapper: yields Studio SSE event tuples ``(event_type, data_dict)``. The chat
router serializes them. ``turn_start`` and ``tool_progress`` are emitted by the
session, not here.
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)


def _short_tool(name: str) -> str:
    """Friendly short name for a tool chip (strip the mcp__studio__ prefix)."""
    if name.startswith("mcp__studio__"):
        return name[len("mcp__studio__"):]
    if name.startswith("mcp__"):
        return name.split("__")[-1]
    return name


def _summarize_input(tool: str, inp: Any) -> str:
    """A compact one-line summary of a tool call's input for the UI chip."""
    if not isinstance(inp, dict) or not inp:
        return ""
    if tool.endswith("render"):
        bits = []
        if inp.get("preview"):
            bits.append("preview")
        if inp.get("draft"):
            bits.append("draft")
        if inp.get("build_subtitles"):
            bits.append("subtitles")
        return ", ".join(bits) or "final"
    if tool.endswith("timeline_view"):
        return f"{inp.get('source', '?')} {inp.get('start', '?')}-{inp.get('end', '?')}"
    if tool.endswith("grade"):
        return inp.get("preset") or inp.get("print_preset") or ("analyze" if inp.get("analyze") else "")
    if tool.endswith("write_edl"):
        edl = inp.get("edl")
        if isinstance(edl, dict):
            return f"{len(edl.get('ranges', []))} ranges"
        return ""
    for k, v in inp.items():
        if isinstance(v, (str, int, float, bool)):
            return f"{k}={v}"
    return ""


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


# Tool-result JSON keys that carry an artifact path (or list of them). The render
# tool emits ``artifact`` (already edit-relative, e.g. ``edit/preview.mp4``);
# write_edl emits ``edl_path``; pack/transcribe emit ``packed``; grade emits
# ``output``; timeline emits ``png``. ``artifacts``/``master_srt`` are accepted
# for forward-compat with the documented contract (API_CONTRACT.md §13).
_ARTIFACT_KEYS = (
    "artifact", "artifacts", "output", "edl_path", "png", "packed", "master_srt",
)

# Match an ``edit/...`` (or ``edit\...``) segment so an absolute path like
# ``C:\\…\\proj\\edit\\master.srt`` normalizes to ``edit/master.srt``. The
# leading ``.*`` is greedy so the engine backtracks to the LAST segment-boundary
# ``edit/`` — the real output lives under the active folder's single, deepest
# ``edit/`` dir, so when a parent dir is also named ``edit`` (e.g.
# ``.../edit/sub/edit/final.mp4``) the rightmost wins. The ``(?:^|[\\/])`` anchor
# requires a path-segment boundary so a literal ``edit`` dir matches but a
# substring like ``clipedit`` does not.
_EDIT_REL_RE = re.compile(r"^.*(?:^|[\\/])(edit[\\/].+)$")


def _rel_to_edit(path: str) -> str | None:
    """Normalize an artifact path to the edit-relative ``edit/...`` convention.

    Returns the edit-relative form (forward slashes) anchored on the LAST
    ``edit/`` path segment, else None (so non-edit paths are dropped rather than
    leaking an absolute filesystem path to the client).
    """
    if not isinstance(path, str) or not path:
        return None
    m = _EDIT_REL_RE.match(path)
    if not m:
        return None
    return m.group(1).replace("\\", "/")


def _result_artifacts(content: Any) -> list[str]:
    """Collect edit-relative artifact paths from a ToolResultBlock's content.

    Tools append a JSON text block alongside the human summary (tools.py ``_ok``);
    we parse any JSON-object text block and pull artifact paths from the known
    keys, normalize each to ``edit/...``, and de-duplicate preserving order.
    """
    if not isinstance(content, list):
        return []
    out: list[str] = []
    seen: set[str] = set()

    def add(value: Any) -> None:
        candidates = value if isinstance(value, list) else [value]
        for cand in candidates:
            rel = _rel_to_edit(cand) if isinstance(cand, str) else None
            if rel and rel not in seen:
                seen.add(rel)
                out.append(rel)

    for item in content:
        text = None
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text", "")
        elif isinstance(item, TextBlock):
            text = item.text
        if not text or not text.lstrip().startswith("{"):
            continue
        try:
            obj = json.loads(text)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        for key in _ARTIFACT_KEYS:
            if key in obj:
                add(obj[key])

    return out


async def relay(
    messages: AsyncIterator[Any],
    turn_id: str,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Map an SDK message stream to ``(event_type, data)`` SSE tuples.

    Emits: ``assistant_delta``, ``tool_start``, ``tool_input``, ``tool_end``,
    ``turn_end``.
    """
    seen_tool_starts: set[str] = set()
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
                    summary = _result_text(block.content)
                    is_error = bool(block.is_error)
                    payload: dict[str, Any] = {
                        "turn_id": turn_id,
                        "tool_call_id": block.tool_use_id,
                        "ok": not is_error,
                        "summary": summary[:500],
                    }
                    artifacts = _result_artifacts(block.content)
                    if artifacts:
                        payload["artifacts"] = artifacts
                    yield "tool_end", payload
            continue

        if isinstance(msg, SystemMessage):
            continue

        # ---- result message ends the turn --------------------------------
        if isinstance(msg, ResultMessage):
            if not emitted_text_via_delta and final_assistant_text_parts:
                yield "assistant_delta", {
                    "turn_id": turn_id,
                    "text": "".join(final_assistant_text_parts),
                }
            stop_reason = "error" if msg.is_error else (msg.stop_reason or "end_turn")
            yield "turn_end", {
                "turn_id": turn_id,
                "stop_reason": stop_reason,
                "text": "".join(final_assistant_text_parts),
            }
            return

    # Stream ended without an explicit ResultMessage.
    if not emitted_text_via_delta and final_assistant_text_parts:
        yield "assistant_delta", {
            "turn_id": turn_id,
            "text": "".join(final_assistant_text_parts),
        }
    yield "turn_end", {
        "turn_id": turn_id,
        "stop_reason": "end_turn",
        "text": "".join(final_assistant_text_parts),
    }
