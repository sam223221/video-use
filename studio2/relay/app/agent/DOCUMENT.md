# studio2/relay/app/agent/ — the embedded Claude Agent SDK editor (Step 3)

The ONLY package importing `claude_agent_sdk`. One conversation per
`(user, device_id, project_id)` (arch §3.7 — the conversation is bound to
the device+project that opened it; all its tool commands route to exactly
that device). The HTTP layer talks to it only through `core/turns.py`'s
detached task.

## Files

| File | Purpose | Relation to v1 |
|---|---|---|
| `__init__.py` | Deliberately empty: `routers/status.py` lazily imports `agent.env` (stdlib-only) and must not pay the SDK import for a status probe. | v1 exported `AgentSession`; v2 imports `agent.session` directly where needed |
| `session.py` | `AgentSession` + the module-level session cache (keyed per arch §3.7, **idle-evicted after 60 min** — lazy sweep on `get_session` + a 10-min background timer; fixes v1's unbounded-cache nit). `send(message)` = async generator of §2.2 event tuples, NEVER raises (failures become `error` + `turn_end` events); consumed only by `core/turns.py`. The SDK-message→event mapper (`_relay_events`) is v1's `agent/relay.py` folded in, minus artifact extraction (v2 tools return no paths). **`turn_end.text` assembly:** a text→tool→text turn yields MULTIPLE TextBlocks (one per stretch of prose between tool calls); `turn_end.text` (and the no-delta fallback `assistant_delta`) joins them with a blank line — `_join_text_segments`, `"\n\n".join` of non-whitespace segments — never a bare `"".join`. The PWA persists `turn_end.text` to the device transcript (`chat.json`) and re-renders paragraphs on reload by splitting on blank lines, so a bare join fused words across segments ("…cut?Great — I removed…") and collapsed reloaded turns into one run-on blob while the live delta stream looked fine. **Turn-cancel chip copy:** when `cancel()` interrupts a turn with a tool still in flight, the SDK discards the tool's real result and synthesizes an `is_error` tool_result carrying model-coaching boilerplate ("The user doesn't want to proceed with this tool use… consider saving that to memory…") — `_relay_events` rewrites that `tool_end` summary to the v1-verbatim `(cancelled)` so SDK copy never reaches a UI chip (`ok` stays false — only the copy is contract-bound). The rewrite is double-gated: the turn's cancel flag must be set AND the text must start with a known prefix (`_SDK_INTERRUPT_PREFIXES`: "The user doesn't want to proceed with this tool use" / "[Request interrupted by user") — real tool failures pass through untouched. **Documented fragility:** there is no structured interrupt marker on the ToolResultBlock, so an SDK upgrade that rewords the boilerplate leaks it to the chip again until a prefix is added. **Chip filtering (only product tools get chips):** the SDK's deferred-tool mechanism makes the model call the built-in `ToolSearch` before every `mcp__studio2__*` call — plumbing, not product. `_relay_events` emits `tool_start`/`tool_input`/`tool_end` ONLY for `mcp__studio2__*` names (`_is_product_tool`); every other tool call AND its paired tool_result is suppressed entirely (no chip; the suppressed NAME is logged once per call on `studio2.agent`, sanitized, name-only — never the input). Assistant text deltas are NEVER filtered. Suppression is seq-safe by construction: `core/turns.py` assigns seq at buffer-append time, so unemitted events never occupy a seq and attach replay matches the live stream exactly. **ClaudeAgentOptions invariants:** plain-string `system_prompt`, `setting_sources=[]`, `permission_mode="bypassPermissions"`, `include_partial_messages=True`, built-in `AskUserQuestion` disallowed, `env` from `env.py`, **NO cwd binding** (the agent has no filesystem tools). Live-context priming = ONE `get_inventory` bridge dispatch at session connect (10 s budget; `device_offline` degrades to an "unknown — call get_inventory" prompt). No `_merge`/progress-queue/ask_user-Future plumbing — questions are bridge commands now. **Model picker (plan 2026-06-13):** `_ensure_connected` applies the GLOBAL selection via `core/agent_model.resolve()` → passes `model=<id>` ONLY when non-None; for `"default"` the kwarg is OMITTED ENTIRELY so the option set is byte-identical to the pre-picker behavior (verified: default's kwargs == today's 8 keys; non-default == those + `model`). Each `AgentSession` stamps the `agent_model.version()` it built against; `get_session()` evicts+closes (in the background) a cached session whose stamp is stale BEFORE returning, so the NEXT turn rebuilds with the newly-selected model — a session mid-turn (`_lock.locked()`) is NEVER yanked (`_model_version_stale` reports it not-stale; the in-flight turn finishes on its old model and is evicted on the first post-turn `get_session`, same posture as the idle sweep). The connect log line records `model=`/`model_version=`. Live-verified: a real subscription turn after a model change reports the new id in `ResultMessage.model_usage`. | adapted v1 `session.py` + `relay.py` |
| `tools.py` | **M3 update: the surface is 15 tools when the render tier is ON, 9 when OFF (the DEFAULT)** — the 6 render-tier tools (`set_output_format`, `set_clip_fit`, `list_music_library`, `add_music`, `update_music`, `remove_music`, arch §7.1) are **GATED on `settings.render_enabled()`**. While OFF (the dormant-deploy state): `tool_names()` returns the 9-tool base (M2+vision+base), `build_server` passes only those 9 to `create_sdk_mcp_server` and returns them as `allowed_tools`, and `_timeouts()` has no M3 entries — so the model never SEES, is offered, or can call the not-yet-functional render tools (their `@tool`-decorated closures are still defined inside `build_server` but simply not added to the server list — harmless). `get_inventory`/`read_edl` descriptions are ALSO flag-gated (`_get_inventory_desc()`/`_read_edl_desc()`): the canvas/fit/music/tier mentions appear only when render is on, so the dormant surface has zero hint of the render tier (the device-returned fields were always pure passthrough either way). When ON, all 6 join the surface (count 15), `_timeouts()` gains the M3 entries, and the inventory/edl descriptions carry the render-field wording. `TOOL_NAMES`/`TIMEOUTS_S` are import-time snapshots of the current flag state; `build_server`/`_dispatch` read `tool_names()`/`_timeouts()` FRESH so an in-process flag flip is honored (the live relay restarts to deploy, so its flag is fixed per process). The matching prompt §7/§8 and `core/bridge.py` allowlist are gated on the SAME flag. **Both states verified in-process:** OFF → 9 tools, no M3 in allowed/timeouts/server, prompt has no format/music, bridge blocks an M3 dispatch with `invalid_params`; ON → 15 tools, M3 present everywhere, prompt §7/§8 present, M3 dispatches to a fake device. When ON, the 6 render-tier tools follow the same validate → `bridge.dispatch` → `_ok(json)`/`_err` pipeline. **`set_output_format`** (`_validate_set_output_format`, EXPLICIT `_SET_OUTPUT_FORMAT_SCHEMA`, `required:[]`): EXACTLY ONE of {aspect+resolution preset | match_primary | custom}; presets are the §3.1 table (`_FORMAT_PRESETS` — only the six valid combos, 1x1/4x5 are 1080-only) → dispatches `{mode:"preset",preset}` or `{mode:"match_primary"}` (+ optional `fps` 1–60); **`custom` is RECOGNIZED by the schema but REJECTED** with a plain "custom dimensions aren't available yet — use a preset or match your main clip" (DEFERRED, plan §0.3) — kept in the schema for forward-compat. Returns `{canvas,tier,note}`. **`set_clip_fit`** (`_SET_CLIP_FIT_SCHEMA`, `required:[clip_id,fit]`): `fit∈{contain,cover}`, optional `background∈{blur,black}` (forwarded only when supplied). **`add_music`** (`_validate_add_music`, `_ADD_MUSIC_SCHEMA`, `required:[track_ref]`): `track_ref` = EXACTLY ONE of `{library_id}`(`_LIBRARY_ID_RE`)|`{track_id}`(`_TRACK_ID_RE` `trk_<8hex>`) — the relay bounds the id SHAPE, the DEVICE owns the catalog allowlist (arch §9); optional placement `at_s`/`track_offset_s`(≥0), `duration_s`(>0 finite OR the literal `"whole"`), `gain_db`(−60…+6), `fade_in_s`/`fade_out_s`(0…10), `duck{enabled,amount_db(−60…0),attack_s/release_s(0…5)}` — only supplied keys forwarded, device fills §2.2 defaults. **`update_music`** (`_UPDATE_MUSIC_SCHEMA`, `required:[music_seq]`): a partial of the same placement fields, ≥1 required; `track_ref` change rejected (remove+add). **`remove_music`**: just `{music_seq}` (shorthand `{music_seq:int}` schema — honest `required`). **`list_music_library`** ({} schema): pure passthrough of the device's bundled catalog (forwards an empty/stub `{tracks:[]}` until the assets land). Two validation LAYERS prove out (defense in depth): the SDK jsonschema gate (from the explicit schemas — enum/min/max/additionalProperties/required, rejecting with "Input validation error: …" BEFORE the handler) AND the handler's `_validate_*` (custom `ERROR invalid_params` text); the device re-validates as a third. `TIMEOUTS_S`: `list_music_library` 30 s (read), the five setters 120 s (mutations). `get_inventory`/`read_edl` are PASSTHROUGH for the new fields (canvas, per-clip fit, music placements, current tier) — descriptions updated to tell the agent those flow through; no relay validation change. **FLAGGED:** the 6 names need adding to `core/bridge.py` `_BRIDGE_TOOLS` (a different file/owner) or `bridge.dispatch` blocks them with `invalid_params: unknown tool` (the find_in_transcript/view_frames gotcha — see the bridge.py-allowlist note below). VERIFIED with a REAL subscription turn ("make this portrait + calm music"): the model called set_output_format(9x16_1080)→list_music_library→add_music(library track, ducked), STATED the re-encode+SDR tradeoff BEFORE, reported the realized 1080×1920 canvas + render tier AFTER, and told the user to tap Export (never claimed it exported). <hr/> The original **9-tool** surface (arch §4-5 + Agent Vision) as an in-process MCP server named `studio2`: `get_inventory`, `describe_clip`, `apply_cuts`, `undo_last_edit`, `read_edl`, `read_transcript`, **`find_in_transcript`** (M2), **`view_frames`** (Agent Vision), `ask_user`. Every tool = **validate (arch §8.3/§8.4: regex ids, 1–50 finite/ordered/non-overlapping-after-sort ranges, snap enum, transcript window/detail/query bounds, view_frames ≤4-frame/finite/≥0 times, unknown keys rejected) → `bridge.dispatch` → `_ok(json)` / `_err(code, message)`** (`ERROR <code>: <message>` — the §3.5 rendering). `TOOL_NAMES` lists all 9 and is returned as `allowed_tools`. Timeouts per §3.4/§5.5: reads (incl. both transcript tools) 30 s, **view_frames 60 s** (decode is heavier than a read), apply_cuts/undo 120 s, ask_user 600 s. `_normalize_questions` / `_format_answers` are v1 VERBATIM. ask_user keeps v1's model-friendly outcomes: timeout → `"The user did not answer (timed out)."`, turn-cancel → `"(cancelled)"` (ordinary results, not errors). **M2: `read_transcript` is now a REAL bridge dispatch** — the M1 relay stub short-circuit is GONE (transcript truth lives device-side; `device_offline`/`command_timeout` is the honest answer when the phone is gone). `_validate_read_transcript` enforces the §5.3 token-budget contract: optional `clip_id` (no clip_id ⇒ overview, and window/detail then rejected), optional finite/ordered `from_s`/`to_s`, `detail` enum (`text` default / `words`), and `detail:"words"` REQUIRES a bounded window ≤120 s. **M2: `find_in_transcript`** (`_validate_find_in_transcript`) — `query` 2–80 chars, optional `clip_id`, `max_results` 1–10 int. **Agent Vision: `view_frames`** (`_validate_view_frames`) — the agent's only way to SEE the pixels: required `clip_id`, EITHER `at_seconds` (1–4 finite ≥0 times, >4 REJECTED, dups collapsed) OR `around_s` (one time, normalized server-side into a small at_seconds set via `_AROUND_OFFSETS_S`, negatives clamped to 0); both/neither rejected. ALWAYS dispatches the §5 command shape `{clip_id, at_seconds:[...]}`. The device result `{frames:[{at_s,b64,w,h,bytes}], note?}` is rendered by `_render_view_frames` into MCP image content via the NEW `_ok_images(image_blocks, text)` helper — `{"type":"image","data":<b64>,"mimeType":"image/jpeg"}` blocks (the MCP CONTENT shape, NOT the Anthropic-API `{"source":{...}}` shape, which would `KeyError 'data'` AFTER the tool returns and silently isError EVERY call — PM/conventions §image-returns) + a `frame at m:ss` caption line. **Image-tool failure degrades to TEXT + a clear message, never a silent except-pass nor a broken image block:** a device error (`{error:{code,message}}` or a raised BridgeError) → `_err`; no/empty frames → `_err`; per-frame b64 missing/garbage/oversized → that frame is skipped (counted in the caption), and if NONE survive → `_err`. The schema is an EXPLICIT JSON Schema (`_VIEW_FRAMES_SCHEMA`, `required:["clip_id"]`) — NOT the `{name:type}` shorthand, which the SDK marks every-key-required (fatal for the either/or param: the model would be forced to send both at_seconds AND around_s, then the mutex rejects "both" → the tool can NEVER be called; verified). VERIFIED with a REAL subscription turn: the model called view_frames, got a GREEN result with image blocks, and DESCRIBED the seeded frames' colors ("bright orange", "bold blue with a white circle") — i.e. it actually SAW them, not just tool-success. Both transcript tools + view_frames forward only the keys the device needs. Every handler catches all exceptions — an uncaught one would kill the SDK loop. | v1 `tools.py` patterns; tool surface per arch §4-5 + Agent Vision |
| `prompt.py` | **M3 update: two load-bearing sections (arch §7.2) GATED on `settings.render_enabled()` — present (contiguous 1–9) when render is ON, OMITTED (contiguous 1–7) when OFF (the DEFAULT).** `build_system_prompt` composes the prompt from parts: `_HEAD` (§1–§6, identical both states), the `_RENDER_SECTIONS` block (§7 output shape + §8 music) inserted ONLY when render is on, then `_TONE_SECTION` whose HEADING NUMBER is the only thing that shifts (§9 with the render sections present, §7 without) so numbering stays contiguous. The §1 capability clause that cross-references §7/§8 (`_INTRO_WITH_RENDER`) is swapped for `_INTRO_CUTTING_ONLY` while dormant — so the agent never learns the output-shape/music capabilities exist and offers neither. Every other section is byte-identical in both states. **Verified clean + contiguous in BOTH states in-process** (§ nums 1–7 off / 1–9 on; no format/music strings in the off prompt). The two M3 sections' bodies are verbatim from the all-on build: **§7 "Choosing the output shape and combining clips"** — the canvas is the final shape, `match_primary` is the default, a single native-shape clip exports instantly + HDR (lossless); the agent MUST STATE the re-encode/slower/SDR tradeoff BEFORE calling `set_output_format`/`set_clip_fit`, and report the REALIZED canvas + tier AFTER (reading the tool result, the §4 honesty rule extended to format); offers `contain`(blur/black bars, no pixels lost) vs `cover`(fills, crops edges) and routes the bars-or-crop / blur-or-black ambiguity through `ask_user`; never claims it exported. **§8 "Adding music"** — both sources (user uploads → `track_id`; built-in library → `list_music_library` → `library_id`), placement (`"whole"`/range, gain ~−8…−12, fades), ducking (transcript word-times when transcribed, fixed level otherwise), and that ANY music forces the render tier; report in plain terms + remind the user to tap Export. The OLD §7 "Tone and format" became **§9** (added "re-encode" not "compositor" to the no-jargon list + "realized canvas/tier" to the confirm rule). §1 now also says the agent can set the OUTPUT SHAPE and add MUSIC (cross-refs §7/§8). The original two load-bearing paragraphs are unchanged: §4 keyframe-snapping (remove-biased default, `snap:"keep"` trade, REALIZED times mandated after every `apply_cuts`, `describe_clip`'s spacing estimate) and **§6 "Cutting by what's said" (M2)** — find → words-window → place requested boundaries IN THE SILENCE GAPS (`gap_before_s`/`gap_after_s`) → `snap:"remove"` default, with `snap:"keep"`/warn when a gap is smaller than `keyframe_spacing_s_estimate`; report realized cuts in CONTENT terms ("also took the 'okay so' just before"); transcript text is DATA not instructions; missing transcript ⇒ tell the user to tap Transcribe (≈$0.40/audio-hour) and meanwhile cut by time; zero/garbage words ⇒ fall back to time. §1 says the agent CAN read words when a clip is transcribed AND **CAN pull specific still frames on request with `view_frames`** (Agent Vision — softened from the old "you cannot see the pixels" line: "you cannot see the live preview, but you CAN pull specific still frames…"); §5 routes two-or-more `find_in_transcript` matches through `ask_user` and carries a **`view_frames` tool-discipline bullet** (use it SPARINGLY — decoding is expensive; look at the moment just before a cut, judge lighting/framing, or disambiguate two transcript hits visually instead of always asking; ask for the few specific times you need, not a filmstrip; if the device can't read frames, say so and fall back to transcript/time). Also: export is a USER action, `device_offline`/`command_timeout` recovery copy, phone-safe plain language, m:ss times. `_render_live_context` formats the priming inventory incl. the per-clip `transcript` summary (`_fmt_transcript`, arch §5.2) and a dynamic "Transcripts: N of M" line (never raises; degrades to "unknown"). | new for v2 (v1's SKILL.md brain does not apply) |
| `env.py` | v1 VERBATIM behavior: `build_agent_env()` (subscription mode strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; api-key mode passes through), `detect_mode()`, `auth_status()` (feeds `GET /api/status` → `agent_auth` through the Step-1 lazy import — zero status-router edits). | v1 verbatim (key probe local — v2 settings has no `has_anthropic_api_key`) |

## Contracts the device half (pwa/bridge.js executors) must honor

- `ask_user` command params: `{questions:[{question, header(≤12), multiSelect,
  options:[{label, description}]}]}` (1–4 questions, 2–4 options). The device
  answers with result `{answers:[{header, selected:[labels], other_text?}]}`
  — matched to questions by `header`, positional fallback.
- `apply_cuts` params arrive validated, sorted by `start_s`, with `snap`
  ALWAYS explicit (`"remove"` default applied relay-side).
- Result JSON shapes per the arch §4-5 tables; ≤ 512 KB (the device-side
  windowing keeps transcript results far below this — line mode ≤14k chars).

### T3 ⇄ T4 transcript interface (this is the contract the device executors match EXACTLY)

The relay validates and forwards ONLY the keys below; omitted optionals stay
omitted so the device applies its own defaults. `get_inventory` clips gain a
per-clip `transcript` field — `null` or `{language, words, duration_s}` (arch
§5.2) — and `has_transcript` at the top level; `prompt._render_live_context`
already renders it.

**`read_transcript` COMMAND params** (relay-validated, arch §5.3):
- `{detail: "text"|"words"}` — always present (default `"text"`).
- `clip_id` (`clip_<8 hex>`) — present only when the model named a clip;
  **absent ⇒ the device returns the overview** (and the relay guarantees no
  window/non-default detail is present in that case).
- `from_s`, `to_s` (finite, ≥0, `to_s > from_s`) — present only when given.
  The relay guarantees: `detail:"words"` always arrives WITH both `from_s`
  and `to_s` and `(to_s - from_s) ≤ 120`. A lone `to_s` means "from 0".

**`read_transcript` RESULT shapes the device must produce** (arch §5.3):
- overview (no clip_id): `{clips:[{clip_id, name, has_transcript, language,
  words, duration_s}], hint}`.
- `detail:"text"`: `{clip_id, language, clip_duration_s, window:{from_s,to_s},
  lines:[{s,e,text}], truncated, next_from_s, word_count_total}` — **lines
  hard-capped ≤14,000 chars/call**, truncated at a line boundary, with
  `next_from_s` as the page cursor.
- `detail:"words"`: `{clip_id, window:{from_s,to_s}, words:[{w,s,e}]}`.
- no transcript on the clip: `{has_transcript:false, message:"…"}` (an
  ORDINARY non-error result the prompt leans on).

**`find_in_transcript` COMMAND params** (relay-validated, arch §5.4):
- `{query, max_results}` — `query` 2–80 chars (trimmed); `max_results` int
  1–10 (default 5, applied relay-side).
- `clip_id` (`clip_<8 hex>`) — present only when given; **absent ⇒ search
  every transcribed clip**.

**`find_in_transcript` RESULT shape the device must produce** (arch §5.4):
`{total_matches, searched_clips:[clip_id…], matches:[{clip_id, start_s,
end_s, text, words:[{w,s,e}], gap_before_s, gap_after_s}]}` — `gap_before_s`
/`gap_after_s` are the LOAD-BEARING fields (silence to the prev/next word)
that feed gap-placed cut boundaries. No transcripts anywhere ⇒ the same
`{has_transcript:false, message:"…"}` shape as `read_transcript`.

### view_frames (Agent Vision) — the device executor MUST match this EXACTLY

**`view_frames` COMMAND params** (relay-validated, plan §5 — the relay ALWAYS
sends `at_seconds`, never `around_s`):
- `{clip_id, at_seconds:[<number>, …]}` — `clip_id` (`clip_<8 hex>`) always
  present; `at_seconds` always present, **1–4 finite numbers ≥ 0** (the relay
  expands `around_s` to a small set and caps the count, so the device receives
  a clean list every time). Times are seconds from clip start; the device
  CLAMPS any time past the clip end and reports what it actually decoded.

**`view_frames` RESULT shape the device must produce** (plan §5; the FRONTEND
executor builds this):
- success: `{frames:[{at_s, b64, w, h, bytes}], note?}` — `b64` is a base64
  **JPEG** (the relay wraps it into an MCP image block as
  `{"type":"image","data":<b64>,"mimeType":"image/jpeg"}`); `at_s` is the
  ACTUAL decoded time, `w`/`h` the downscaled dimensions, `bytes` the encoded
  size; optional `note` is surfaced to the model as a caption suffix. The
  device fixes the downscale/quality server-side (≤ ~512px long edge, q≈0.6,
  per-image byte clamp) — the model cannot request arbitrarily large frames.
- failure: `{error:{code:"engine_error"|"unsupported", message}}` — e.g. a
  device whose WebCodecs decode is unavailable returns `unsupported` "this
  device can't read frames", which the relay renders as a clean `_err` and the
  prompt tells the agent to fall back to transcript/time. (A device that
  instead returns `ok:false` with `error{code,message}` over the bridge also
  renders to `_err` via `bridge.dispatch`'s §3.5 normalization.)
- **The result-cap PAIR (plan §3, LOCKSTEP):** `routers/bridge.py`
  `_RESULT_MAX_BYTES` is **2 MiB** (raised from 512 KB for these image
  results, authenticated-only + documented). The PWA `bridge.js`
  `RESULT_MAX_BYTES` MUST move to the same **2 MiB** in UTF-8 bytes — the two
  caps must match or a valid 4-frame result one side accepts the other rejects.
  ≤4 frames × ~512px JPEG q≈0.6 ≈ 40–110 KB b64 each → comfortably under 2 MiB.

### bridge.py allowlist (different file/owner — flagged, see Report to PM)

`core/bridge.py`'s `_BRIDGE_TOOLS` frozenset (a relay-side defense-in-depth
gate) must include EVERY dispatchable tool, or `bridge.dispatch` rejects it
with `invalid_params: unknown tool '<name>'` BEFORE it ever reaches the device.
`read_transcript` / `find_in_transcript` (M2) / `view_frames` (Agent Vision)
were each added the same way.

**M3 (render tier) — RESOLVED, flag-gated (render-flag deploy gate, 2026-06-14):**
the six new tool names `set_output_format`, `set_clip_fit`,
`list_music_library`, `add_music`, `update_music`, `remove_music` are now in the
bridge allowlist via `core/bridge.py`'s `_bridge_tools()` — admitted ONLY while
`settings.render_enabled()` is true (the M3 `[render] enabled` flag, DEFAULT
OFF). While OFF they are absent there too, but it is moot: `tools.py` does not
register them with the model while dormant, so the model cannot call one. When
the flag is flipped ON, both the tool surface AND the bridge allowlist admit all
six in lockstep (no separate follow-up needed). `view_frames` stays in
`_BRIDGE_TOOLS` UNCONDITIONALLY. Verified in-process: ON → an M3 `dispatch`
round-trips to a fake device; OFF → the gate returns `invalid_params: unknown
tool` exactly as it did for find_in_transcript in M2.
