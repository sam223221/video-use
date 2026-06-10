# studio/app/agent/ — DOCUMENT

## What this is
The embedded AI editor. The **only** package that imports `claude_agent_sdk`. It
owns the SDK lifecycle, the in-process MCP server exposing the helper tools, the
system prompt assembled from SKILL.md, the dual-mode auth env hygiene, and the
translation of SDK streaming events into Studio SSE events.

## Status — IMPLEMENTED (verified end-to-end on the subscription path)
- `env.py` — **dual-mode auth (Delta 2)**: keeps `ANTHROPIC_API_KEY` if present
  (Docker → api_key mode), else strips it + `ANTHROPIC_AUTH_TOKEN` (native →
  subscription login). `auth_status()` reports `api_key`/`subscription`/`unavailable`
  for `/api/status` (cheap, non-billing — CLI presence as the subscription signal).
- `prompt.py` — strips SKILL.md frontmatter, prepends a Studio addendum (tool
  mapping, confirm-before-edit, outputs→edit/, **v1 has no animation tooling**,
  **always use `ask_user` to ask the user to choose between options**), appends
  live inventory context.
- `tools.py` — 12 `@tool`s registered via `create_sdk_mcp_server("studio", …)`
  (surface as `mcp__studio__*`): inventory, transcribe_batch, pack_transcripts,
  read_packed, timeline_view (returns the PNG as image content for self-eval),
  grade, write_edl (validates against the SKILL.md EDL schema, rejects overlays
  pointing at non-existent files since v1 has no animation), read_edl, render,
  read_text, write_project_note, **ask_user**. **Every tool catches all
  exceptions and returns `{is_error: True}`** so an exception never kills the SDK
  loop. Paths are root-checked via `security.resolve_in_roots`.
- `session.py` — `AgentSession` per user session (cached in **`core.sessions`**
  keyed by **`session_id`** — the v2 cutover re-keyed the cache off folder-path so
  the SAME object, and its `ask_user` Futures, survives across turns). Bound to the
  session's resolved dir (`folder`) for cwd + tool paths + outputs. Wraps
  `ClaudeSDKClient` with `system_prompt`, `mcp_servers`, `allowed_tools`
  (mcp__studio__* only — no shell/file/web), **`disallowed_tools=["AskUserQuestion"]`**
  (block the unanswerable CLI built-in), `setting_sources=[]` (isolation),
  `permission_mode="bypassPermissions"`, `include_partial_messages=True`,
  `cwd`=folder, `env`=dual-mode. `send()` is an async generator of Studio SSE
  tuples; it merges the relay stream with out-of-band `tool_progress` **and
  `ask_user`** events from a per-turn asyncio.Queue. `cancel()` → `client.interrupt()`.

### Per-user session cutover (2026-06-08) — what changed here
The agent-client cache moved from `core.state` (keyed by folder path) to
`core.sessions` (keyed by `session_id`) — the chat router now does
`sessions.get_agent/set_agent(session_id, …)`. `AgentSession.__init__` gained an
optional `session_id` (carried for context; the conversation still binds to
`folder`). The `ask_user` Futures registry, the `register_question`/
`resolve_question`/`emit_event` round-trip, and `disallowed_tools=
["AskUserQuestion"]` are **fully intact** — verified end-to-end under the new
keying (registry round-trip + cross-turn-resolve rejection + cache get/set/pop).
The agent stays confined to the per-user session tree (`allowed_roots()` ==
`[USER_SESSIONS_ROOT]`), and `cwd`/tools/outputs anchor to the session dir.

### Interactive questions — the `ask_user` tool (PAUSES the turn)
The model asks a multiple-choice question that renders as clickable options and
blocks the turn until the user answers in the browser. Routing is **per-session,
no global state**: `build_server(folder, …, session=self)` binds the owning
`AgentSession` to the tool when the per-session client is created, so the tool
reaches exactly the session running the turn.

- **`ask_user(questions)`** (mirrors Claude's `AskUserQuestion` schema so the model
  uses it naturally): `questions` is 1–4 `{question, header(<=12 chars),
  multiSelect, options:[{label, description}]}` (2–4 options each; an "Other"
  free-text is always implicitly allowed and is NOT an option). `_normalize_questions`
  validates + normalizes the payload; bad input → `is_error` (no SSE event emitted,
  nothing left pending).
- Handler flow: generate `question_id` → `session.register_question(turn_id,
  question_id)` returns an `asyncio.Future` → `session.emit_event("ask_user",
  {turn_id, question_id, questions})` pushes it onto the per-turn queue (so
  `_merge` forwards it to the StreamingResponse alongside `tool_progress`) →
  `await asyncio.wait_for(future, 600s)`.
  - **Answered:** the answer endpoint resolves the Future; the tool returns
    `_format_answers(...)` — one line per question, `"<header>: <comma-joined
    labels>"` plus any `Other: <free text>` — the text the model reads.
  - **Timeout (600 s):** returns `"The user did not answer (timed out)."`
  - **Turn-cancel / client-disconnect / turn-end:** the session cancels the
    Future (synchronous, GeneratorExit-safe) → the tool catches `CancelledError`
    and returns `"(cancelled)"`. NEVER hangs the per-folder lock.
- **Pending-question registry** on `AgentSession`: `_pending_questions: {(turn_id,
  question_id): Future}`. Methods: `register_question`, `resolve_question`
  (returns False on stale/already-answered/unknown — keyed on `turn_id+question_id`
  so a stale turn's answer can't resolve a new turn's question), `cancel_question`
  (single, idempotent), `_cancel_questions(turn_id=None)` (bulk, synchronous,
  idempotent). Cleanup is wired into `_reset_turn` (turn end), `cancel()`,
  `close()`, and the `_merge` `finally` (disconnect) — so a question is cleaned up
  on answer, timeout, cancel, AND disconnect; the chat is never permanently wedged.
- **Deadlock-free:** the SDK dispatches in-process MCP tool calls on a *spawned*
  task (`_spawn_control_request_handler`), so the message read loop / relay keeps
  running while `ask_user` blocks; `_merge` keeps draining the queue (which is how
  the `ask_user` event reaches the client and how `tool_progress` still flows).
- `relay.py` — maps SDK messages → Studio SSE: `StreamEvent` text deltas →
  `assistant_delta`; tool_use block start → `tool_start`; `AssistantMessage`
  ToolUseBlock → enriched `tool_start`/`tool_input`; `UserMessage` ToolResultBlock
  → `tool_end`; `ResultMessage` → `turn_end`.

## Verification (subscription path, no ANTHROPIC_API_KEY)
A bounded smoke test ran one turn: event sequence was
`turn_start → tool_start(inventory) → tool_end(ok) → assistant_delta → turn_end`,
no error — confirming subscription auth, the in-process MCP tools routed through
`helpers_wrap`, the relay mapping, and the merge loop all work.

## Constraints honored
- `allowed_tools` = `mcp__studio__*` only; no arbitrary shell/Bash (§9.6).
- Agent isolated from the user's personal Claude config (`setting_sources=[]` +
  explicit system_prompt) — does not inherit ~40k tokens of personal context or
  fire personal hooks.
- Hard Rule 10 (parallel animation sub-agents) is NOT reproduced in v1; the
  prompt states this and write_edl enforces overlays-only-if-pre-rendered.

## Security fixes (2026-06-10, QA P2 — red-thread pass)
- **tools.py — `render` `output` path confinement:** the tool's `output`
  argument was used verbatim (relative → `edit_dir/…`, but an ABSOLUTE path was
  dispatched as-is, and `render_wrap.run_job` `mkdir(parents=True)`s the output
  parent — an arbitrary write/mkdir primitive for the model). The resolved
  `out_path` is now passed through `security.resolve_in_roots` (default roots =
  `[USER_SESSIONS_ROOT]`; realpaths symlinks/`..` BEFORE the containment test)
  before dispatch, mirroring `grade_tool`'s output confinement but on the FULL
  path; an escaping path returns the clean `_err("output path is outside the
  allowed roots")` tool error. In-root relative/absolute outputs are unaffected.
- **tools.py — EDL `overlays[].file` confinement (`_validate_edl`):** overlay
  paths were existence-checked but NOT root-confined, so an absolute (or
  deep-`..`) path could pull an arbitrary readable file into a render. The
  overlay path is now `resolve_in_roots`-confined BEFORE the existence check;
  escapes are rejected with `overlays[j].file '…' is outside the allowed
  roots`. In-root relative paths (incl. `..` that stays inside `users/`) keep
  their previous behavior. No other tool behavior changed.

## Bug fixes (2026-06-08)
- **session.py — yield inside finally (BUG-15):** `AgentSession._merge` drained
  the `tool_progress` queue with a `yield` inside its `finally` block. On client
  disconnect mid-turn (`GeneratorExit` during `aclose`) with a non-empty queue,
  that yield raised `RuntimeError: async generator ignored GeneratorExit` (noisy
  traceback / unclean shutdown on Python 3.14). The `finally` now ONLY cancels
  `relay_task`/`prog_task`; the drain was removed. Verified `aclose()` returns
  cleanly with a non-empty queue.
- **relay.py — `tool_end` missing `artifacts` (BUG-02, P1 contract):** `tool_end`
  emitted only `{turn_id, tool_call_id, ok, summary}`; the render tool's artifact
  (a JSON text block in the tool RESULT, e.g. `{"artifact":"edit/preview.mp4"}`)
  was flattened into the `summary` string and lost, so the frontend's artifact
  pipeline (which keys off `d.artifacts`) never fired — no auto-preview, no chips,
  no verify-PNG lightbox, no outputs reload. Added `_result_artifacts(content)`:
  it parses any JSON-object text block in the result, collects paths from
  `artifact`/`artifacts`/`output`/`edl_path`/`png`/`packed`/`master_srt`,
  **normalizes each to the edit-relative `edit/...` convention** (`_rel_to_edit`,
  dropping any path without an `edit/` segment so no absolute filesystem path
  leaks), de-duplicates preserving order, and `tool_end` includes
  `artifacts: [...]` when non-empty (matches API_CONTRACT.md §13). `tool_input`
  emission (BUG-24) was verified intact and unchanged.

## Feature: interactive question options (2026-06-08)
Added the **`ask_user`** tool (see the dedicated section above) so the model can
ask a multiple-choice question that renders as clickable options and pauses the
turn until the browser answers. Backend surface added this pass:
- `tools.py` — new `ask_user` tool + `_normalize_questions`/`_format_answers`
  helpers; `mcp__studio__ask_user` added to `TOOL_NAMES`; `build_server` gained a
  `session=` param to route the tool to its owning session.
- `session.py` — pending-question registry (`register_question` /
  `resolve_question` / `cancel_question` / `_cancel_questions`), `current_turn_id`
  property, `emit_event` (push onto the per-turn queue), `disallowed_tools=
  ["AskUserQuestion"]` on the SDK options, and cleanup hooks on turn-end / cancel /
  close / disconnect.
- `prompt.py` — addendum instruction to ALWAYS use `ask_user` for choices.
- `routers/chat.py` — `POST /api/chat/answer` resolves the pending Future (see the
  routers DOCUMENT.md for the request/response shape).

**SSE event emitted** (through `_merge`, alongside `tool_start`/`tool_end`):
`event: ask_user`, `data: {"turn_id", "question_id", "questions":[{question,
header, multiSelect, options:[{label, description}]}]}`.

Verified with local asyncio tests (registry round-trip; the real in-process MCP
server driving the `ask_user` handler through resolve/timeout/invalid-input; and
`POST /api/chat/answer` through a `TestClient` for 401 / 409 / 200 + stale-turn +
idempotent re-answer). All passed.
