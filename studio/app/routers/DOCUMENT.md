# studio/app/routers/ — DOCUMENT

## What this is
The HTTP layer. One `APIRouter` per area, all mounted by `app.main.create_app()`.
Routers validate requests, enforce session-cookie auth, and delegate to `core/`,
`helpers_wrap/`, and `agent/`. They never shell out or import helper modules
directly.

## Per-user session model (the v2 cutover)
Every per-session route now carries a client-carried **`session_id`** (in the JSON
body for POSTs, as a query param for GETs) and resolves it to the caller's OWNED
dir via **`deps.require_session_dir(user, session_id) -> (user, session_id, dir)`**
(which calls the `core.sessions` ownership chokepoint). A bad / cross-user /
missing id is one uniform **`404 session_not_found`** (the old `no_active_folder`
/ `folder_mismatch` 409s are gone). `routers/fs.py` was DELETED entirely. New
`routers/sessions.py` owns the session lifecycle.

## Status — IMPLEMENTED
- `deps.py` — `current_user`/`require_session` (session-cookie auth, 401) +
  **`require_session_dir`** (the per-request ownership resolution → 404
  session_not_found) + `http_error`.
- `auth.py` — **`POST /api/login`** (multi-user, signed cookie, one
  indistinguishable 401), **`POST /api/logout`**, **`GET /api/me`** (public —
  `{authenticated, username, stale_sessions, asset_version}`; `stale_sessions`
  is the COUNT of the caller's sessions idle > 14 days, full list at
  `/api/sessions`; **`asset_version`** (2026-06-10) is the frontend
  `ASSET_VERSION` the server is serving — regex-parsed READ-ONLY from
  `frontend/app.js`, cached by mtime so a frontend bump lands without a backend
  restart, `null` on ANY parse failure, never hardcoded — used by long-lived
  tabs for stale-frontend detection).
- `status.py` — `GET /api/status` (ffmpeg+version, ffprobe, ELEVENLABS key +
  source, dual-mode agent_auth, version). **No longer leaks** active_folder,
  allowed_roots, or any internal path.
- `sessions.py` — **NEW.** `GET /api/sessions` (lists ONLY the caller's;
  `{sessions:[{id,name,created_at,last_touched_at,age_days,media_count,stale}],
  stale:[ids]}`), `POST /api/sessions {name}` (201 `{id,name,created_at,
  last_touched_at}`; 400 invalid_name), `POST /api/sessions/{id}/open` (touches +
  returns absolute `dir`; 404), `POST /api/sessions/{id}/keep` (resets the 14-day
  clock; 404), `DELETE /api/sessions/{id}` (permanent delete; 404; async route
  since 2026-06-10 — `core.sessions.delete` AWAITS the cached agent client's
  disconnect BEFORE the rmtree because the SDK subprocess cwd pins the dir on
  Windows, retries the rmtree briefly off the event loop, and on an
  unreleasable handle drops `meta.json` (unlistable husk, swept at next boot)
  while still answering `{ok:true}` — worst case a few seconds, never a hang).
- `inventory.py` — `GET /api/inventory?session_id=`.
- `transcribe.py` — `POST /api/transcribe` (body `session_id`; 202, single-flight
  → 409 job_in_flight; TOUCHES the session on start), `GET
  /api/transcribe/{job}/events?session_id=` (SSE), `GET
  /api/transcribe/{job}?session_id=` (reconnect snapshot). The session is
  ownership-checked before any job state is streamed.
- `transcripts.py` — `GET /api/transcripts?session_id=`, `GET
  /api/transcripts/{stem}?session_id=`, `GET /api/packed?session_id=`.
- `chat.py` — `POST /api/chat` (body `session_id`; SSE agent turn — the **only**
  chat-turn endpoint, no GET variant; TOUCHES the session on turn start), `POST
  /api/chat/cancel` (body `session_id`), **`POST /api/chat/answer`** (body
  `session_id` — resolve a pending `ask_user` question), `GET
  /api/chat/history?session_id=`. The AgentSession is cached in `core.sessions`
  keyed by `session_id` (so the same object — and its `ask_user` Futures —
  survives across turns); the transcript persists to `<session_dir>/
  transcript.json`. POST + JSON-body only blocks CSRF (the `GET /api/chat/stream`
  fallback stays removed).

### `POST /api/chat/answer` — interactive question answer (2026-06-08)
Resolves a pending `ask_user` question for the active folder. During a turn the
agent may call the `mcp__studio__ask_user` tool, which blocks awaiting a browser
answer and announces itself via an **`ask_user`** SSE frame on the `POST /api/chat`
stream: `data: {turn_id, question_id, questions:[{question, header, multiSelect,
options:[{label, description}]}]}`. The browser renders clickable options and POSTs
the answer here (a NORMAL POST + JSON body, NOT a stream).
- **Auth:** cookie-gated with the same `deps.require_session` as the other chat
  routes (401 `unauthorized` without a valid `studio_session` cookie).
- **Request body** (`AnswerBody`): `{ "turn_id": str, "question_id": str,
  "answers": [ { "header": str, "selected": [str], "other_text": str | null } ] }`
  — one `answers` entry per question in the `ask_user` event.
- **Success:** looks up the AgentSession for the active folder, resolves the
  pending Future keyed by `(turn_id, question_id)` with the answers, returns **200
  `{"ok": true}`**; the blocked tool unblocks and feeds the selections to the model.
- **No match** (already answered / timed out / turn cancelled / stale tab / wrong
  turn / no active folder / no session): **409 `no_pending_question`** via
  `deps.http_error` — never a 500. Keying on `turn_id+question_id` means a stale
  turn's answer cannot resolve a different live turn's question.
- `files.py` — `GET /api/file` (range-aware 206 media serving; extension
  allowlist; realpath root-checked; **AND per-user prefix-confined to the
  caller's own `users/<username>/` subtree** so one user can never stream
  another's media — root-confinement alone would allow it; 403 otherwise).
  **`?download=1` (2026-06-10):** adds `Content-Disposition: attachment;
  filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded>` —
  control chars (incl. CR/LF) stripped, RFC 5987-encoded, ASCII fallback
  reduced to `[A-Za-z0-9._ -]` (no header injection possible). WITHOUT the
  param the response is byte-identical to before (Range/206 + headers
  unchanged); all auth + confinement checks identical on both paths.
- `outputs.py` — `GET /api/outputs?session_id=` (edit/ listing: preview/final/edl/
  master_srt/verify_pngs/animations/project_md).
- `upload.py` — `POST /api/upload/init` (body `session_id` — server derives dest =
  the session dir; ext allowlist [case-insensitive since 2026-06-10, and the
  STORED suffix is normalized to the canonical in-allowlist spelling:
  `CLIP.M4V` → `CLIP.m4v` — see `security.sanitize_filename`] + 8 GiB cap
  + free-disk guard), `PUT …/{id}/chunk` (idempotent; resumable 499
  `client_disconnected` on a mid-chunk drop — on BOTH the main streaming write
  AND the idempotent re-PUT drain, per the documented contract), `GET
  …/{id}/status`, `POST …/{id}/complete` (ordered assemble INTO the session dir
  + size verify; TOUCHES the session), `DELETE …/{id}` (explicit user cancel —
  TOMBSTONES the upload_id atomically with the registry pop, then deletes the
  part dir ON THE SPOT with a brief bounded sub-second retry for Windows
  locks, never 500s on a cleanup failure; when the cancel races a STILL-
  STREAMING chunk PUT — whose open `.part.tmp` handle the retry cannot outwait
  — the racing WRITER detects the tombstone after its write, refuses to
  commit, sweeps the dir itself, and answers 404 `upload_not_found` ("last
  writer sweeps", see the 2026-06-10 cancel-race pass below); the 48 h boot GC
  is only the last-resort backstop; transient failures — 499 / retryable
  assemble — never reach this path, so resume state for non-cancelled uploads
  is untouched). Every `{id}` op
  re-checks the caller owns the upload's bound session (IDOR-safe — uniform
  **404 `upload_not_found`** on a missing/leaked/cross-user upload_id, DISTINCT
  from `session_not_found`: the frontend's restart self-heal + Resume copy key
  on exactly this code; upload ids are unguessable so the distinct code leaks
  nothing. DELETE is an idempotent no-op for non-owners).
  **`client_id` resume (2026-06-10):** `init` now honors the previously-unused
  `client_id` (opaque, `^[A-Za-z0-9_-]{8,64}$`). If a LIVE upload exists for the
  same (authenticated owner, session_id, client_id) with an IDENTICAL
  filename+size_bytes+chunk_size, init returns **200 with the SAME `upload_id`
  and `received:[int,...]`** (sorted, pruned of any index whose part file
  vanished) so the client skips done chunks; otherwise a fresh upload
  (`received:[]`). **Documented decision:** a malformed `client_id` is treated
  as ABSENT (fresh, non-resumable upload) rather than a 400 — completing the
  upload beats strictness, and the client always falls back cleanly. In-memory
  only: resume does NOT survive a restart (post-restart re-init = fresh upload,
  no error). Response shape of every route is unchanged; `complete`'s `path`
  now reflects the collision-auto-renamed filename when one was needed (see
  `core/uploads.py`).
  **QA fixes (2026-06-10, post-implementation):**
  - `_owned_upload` (and therefore chunk/status/complete on a bad id) now
    raises **404 `upload_not_found`** instead of the generic `not_found` —
    the frontend (`upload.js` `canResume`/`errorMessage`) keys its
    server-restarted-mid-upload self-heal and Resume copy on this exact code.
    HTTP status unchanged (404); `init`'s `session_not_found` untouched.
  - **Drain-path 499 restored:** a `ClientDisconnect` during the idempotent
    re-PUT drain of an already-committed chunk again returns **499
    `client_disconnected`** (the documented contract in PM/conventions.md),
    not a success body the client never received anyway. The chunk STAYS
    committed/received (it is never unmarked), so the client's retry re-PUTs
    the index, lands in the idempotent branch, and gets a cheap 200; the main
    write-path 499 (chunk NOT marked received) is unchanged.
  - Stored-filename extension-case normalization at init via
    `security.sanitize_filename` (`CLIP.M4V` → `CLIP.m4v`) so case-sensitive
    helper discovery (`suffix in VIDEO_EXTS`) finds the assembled file; the
    collision rename operates on the normalized name (`CLIP (2).m4v`).

## Constraints honored
- Auth on every `/api/*` route except login/logout/me + the SPA/static.
- **Ownership chokepoint:** per-session routes resolve via
  `deps.require_session_dir` (owner + id-regex + inside-root); cross-user/bad/
  missing → uniform 404 session_not_found (no existence leak).
- `/api/file` is confined to the caller's own `users/<username>/` subtree.
- SSE endpoints return `text/event-stream` with the exact contract event schema.
- Single-flight enforcement via `core.jobs` → 409 job_in_flight.

## Bug fixes (2026-06-08)
- **upload.py — upload cap bypass (BUG-04, P1 security):** `put_chunk` no longer
  buffers the whole chunk via `await request.body()`. It validates the index up
  front, then **streams `request.stream()` to the `.part` file in bounded
  reads** with a running-total guard that aborts (→ HTTP 413
  `upload_too_large`) the moment the chunk exceeds its expected size or the
  cumulative cap — so an oversized chunk can never be fully buffered in RAM. The
  size enforcement is also in `core/uploads.py`.
- **upload.py — mid-chunk disconnect 500 + orphaned `.part.tmp` (P1 robustness):**
  `put_chunk` streams the request body inside a `try` whose `except` clauses caught
  only `uploads.UploadTooLarge` and `OSError`. When a client (e.g. a phone on weak
  Wi-Fi) drops the connection MID-CHUNK, Starlette raises
  `starlette.requests.ClientDisconnect` — a plain `Exception`, NOT an `OSError` — so
  it escaped uncaught → a generic **HTTP 500** AND left an orphaned
  `<index>.part.tmp` on disk (real `.runtime/uploads` had such leftovers). Added
  `from starlette.requests import ClientDisconnect` and a dedicated handler in the
  streaming `try` that **unlinks the partial temp** and returns a clean **HTTP 499
  `client_disconnected`** via `deps.http_error` (instead of a 500). The chunk is NOT
  marked received, so the session stays **resumable** — the client's resume protocol
  re-PUTs that index and `complete` then succeeds. The temp file is also
  opportunistically cleared before writing (scoped to this `upload_id`/index only —
  no broad delete) so a stale leftover from a prior aborted PUT cannot accumulate.
  The chunk-size / cumulative-cap math (BUG-04), the per-user session resolution,
  the normal success path, and the `UploadTooLarge` → 413 path are all unchanged.
- **upload.py — destroy-on-fail (BUG-18, P2):** `complete()` removed the
  destructive `finally: registry.remove(...)`. A transient `OSError` during
  assemble now raises 500 while leaving parts + session intact so `/complete`
  can be retried (no re-upload of an up-to-8 GiB file); success calls the new
  `registry.forget(id)` (no re-cleanup, assemble already removed the part dir);
  the permanent `ValueError`/incomplete branch still discards via `remove`.
- **transcribe.py — reconnect hang + buffer leak (BUG-03 / BUG-19):** the SSE
  `stream()` now **synthesizes the terminal `done`/`error` frame from
  `job.snapshot()`** whenever the job is terminal and the buffer is drained or
  None — so a client that reconnects after a dropped connection (which destructively
  drained the buffer) still receives `done`/`error` and unsticks the UI. The
  worker's `finally` schedules `_evict_buffer` (a 30 s-grace `_buffers.pop`) so
  each job's `deque` no longer leaks for the process lifetime; a late reconnect
  then gets `buf=None` and falls through to the same snapshot synthesis.
- **chat.py — folder arg ignored (BUG-25, P3 contract):** `_resolve_folder` now
  honors its documented contract — an explicit `ChatBody.folder` that does not
  equal the active folder raises **409 `folder_mismatch`** (was silently running
  against the active folder). A stale tab targeting folder B while A is active is
  rejected instead of editing the wrong project.
- **chat.py — history tool status lost (BUG-16, P2):** `_run_stream` only
  persisted `{tool, tool_call_id, input_summary}` from `tool_start`, so reloaded
  history showed every tool chip green even when a tool failed. It now merges the
  `tool_end` `ok`/`summary` into the matching `tool_calls` entry (matched by
  `tool_call_id` via the new `_find_tool_call`) before `turn_end` persists.
  `artifacts` are intentionally NOT persisted into history.
- **chat.py — refined tool input dropped on reload (BUG-24 backend, P3):** with
  `include_partial_messages=True` the first `tool_start` carries an empty
  `input_summary`; the relay later emits a `tool_input` event with the real
  summary. `_run_stream` now merges that refined `input_summary` into the matching
  persisted entry so a reload shows the actual tool input. (Live consumption is
  frontend.)
- **outputs.py — non-video outputs had no `path` (BUG-08 backend, P2 contract):**
  `master_srt`, `project_md`, and `edl` returned a bare `{exists}` flag with no
  `path`, so the frontend's `openArtifact('')` was a no-op. They now include the
  absolute `path` when the file exists (`master_srt`/`project_md` via the new
  `_text_meta()`, mirroring `_video_meta`; `edl` carries `path` alongside its
  `ranges`/`total_duration_s`). `/api/file` already allowlists `.srt`/`.json`/`.md`.
- **outputs.py — corrupt EDL bytes 500'd the endpoint (BUG-10, P2 runtime):** the
  `edl.json` read was guarded only by `(OSError, json.JSONDecodeError)`; invalid
  UTF-8 bytes raise `UnicodeDecodeError` (a `ValueError`) which was uncaught and
  500'd all of `/api/outputs`. The except is broadened to `(OSError, ValueError)`
  (covers both), leaving the pre-set `{exists, path}` intact so the endpoint
  still returns 200.

## Feature: interactive question options (2026-06-08)
- **chat.py — new `POST /api/chat/answer`:** resolves a pending `ask_user`
  question (the agent blocks awaiting the browser's answer). Documented in full
  above. Cookie-gated like the other chat routes; 200 `{ok:true}` on resolve, 409
  `no_pending_question` on any non-match (never 500). Backend agent plumbing lives
  in `app/agent/` (see that DOCUMENT.md). One new API route registered.

## Feature: per-user sessions cutover (2026-06-08)
Replaced the single global active folder + filesystem browser with per-user,
user-owned, upload-only sessions.
- **DELETED `fs.py`** (`/api/fs/roots|browse|select|mkdir`) and its registration.
- **ADDED `sessions.py`** — the session lifecycle (`GET/POST /api/sessions`, `POST
  /api/sessions/{id}/open|keep`, `DELETE /api/sessions/{id}`).
- **ADDED `deps.require_session_dir`** — the per-request ownership resolution used
  by every per-session route.
- `chat.py`: `ChatBody.folder` → `ChatBody.session_id`; cancel/answer bodies gain
  `session_id`; history takes `?session_id=`; agent cache via `core.sessions`;
  transcript via `<session_dir>/transcript.json`; the `no_active_folder`/
  `folder_mismatch` 409s → 404 session_not_found; touches the session on turn start.
- `inventory.py` / `outputs.py` / `transcripts.py` / `transcribe.py`: each gains
  `session_id` and resolves via `require_session_dir`; transcribe touches on start.
- `upload.py`: `dest_folder` → `session_id` (server derives dest = the session
  dir; assembled file lands there); touches on complete; per-`{id}` ownership
  re-check.
- `status.py`: stops leaking `active_folder`/`allowed_roots`/internal paths.
- `auth.py`: `/api/me` adds `stale_sessions` (count of the caller's stale sessions).
- `files.py`: per-user prefix check confines `/api/file` to the caller's own tree.
- All imports of `core.state` removed (it is now empty; use `core.sessions`).

## Bug fixes (2026-06-10, live-test defects — post-App-Tester)
- **upload.py — `DELETE /api/upload/{id}` left the part dir on disk (P2,
  tester-confirmed):** the cancel returned 200 but `.runtime/uploads/up_<id>/`
  (with its `.part` files) survived until the 48 h boot GC, because the explicit
  cancel races the in-flight chunk PUT it just aborted and Windows holds the
  part-file handle for a beat — a single immediate rmtree failed. The route now
  calls `core.uploads.registry.remove`, which deletes the part dir with a
  bounded retry (`remove_tree_with_retry`, ~0.9 s total) and tolerates
  ENOENT/lock failures silently (logged once, request still `{ok:true}`, dir
  left for the boot GC as last resort). The handler is sync (threadpool), so
  the retry sleeps never block the event loop. The 499 `client_disconnected`
  contract, the `client_id` resume contract, and assemble/collision logic are
  all UNCHANGED — verified by the extended suite (resume identity + `received`
  list survive a 499 and a retryable assemble failure; `/complete` then
  succeeds).
- *(Related P1, see `helpers_wrap/DOCUMENT.md`)* `/api/inventory` no longer
  reports stale `has_transcript:false` after a transcribe job completes — the
  inventory cache signature now covers `edit/transcripts/` state, so badges and
  the journey stepper advance without a server restart. No router change; the
  fix lives in `helpers_wrap/inventory.py`.

## Bug fixes (2026-06-10, cancel-race pass — App Tester live ×2)
- **upload.py — a real cancel still orphaned the part dir when it raced an
  IN-FLIGHT chunk PUT (P1, deterministic live repro):** the previous fix's
  bounded retry (~0.9 s) on `DELETE /api/upload/{id}` only wins when NO writer
  is active. In the live repro the user cancelled mid-chunk: the DELETE
  returned 200 while a chunk PUT was still streaming — that PUT's open
  `.part.tmp` handle made every rmtree attempt fail on Windows (an 8 MB write
  on a slow link outlasts any handler-safe retry), the `.part.tmp` GREW
  1.5→8 MB AFTER the cancel, the late PUT then COMMITTED (tmp→part +
  received-marking) and returned **200**, and the dir persisted until a boot
  >48 h later. Fix — **tombstone + "last writer sweeps"**:
  - `core.uploads.registry.remove` now **tombstones the upload_id atomically
    with the registry pop** (bounded FIFO, cap 256 — see `core/DOCUMENT.md`)
    BEFORE attempting its delete, and the DELETE route is otherwise unchanged
    (same sub-second retry as the first attempt — it still reclaims the
    no-writer case instantly; the retry was deliberately NOT lengthened).
  - `put_chunk` re-checks the tombstone (`_sweep_cancelled` helper) the moment
    its own file handle is closed — **before committing** (the tmp→part
    replace + `note_part_written`), again on a replace `OSError`, and once
    more post-commit. On a cancelled/destroyed upload it deletes the
    `.part.tmp`, does NOT commit, best-effort removes the WHOLE part dir (one
    immediate rmtree, no retry sleeps — the writer's handle is closed so this
    normally succeeds), and answers **404 `upload_not_found`** in the standard
    envelope — never a 200, never a 500 (the cancelling client has moved on).
  - The same guard covers the **idempotent re-PUT drain** (post-drain
    tombstone check → 404 + sweep) and the **499 paths** (a `ClientDisconnect`
    from the client's pre-DELETE fetch abort still returns the documented 499
    `client_disconnected`, but the tmp unlink + tombstone sweep now run there
    too, so the abort-then-cancel order the new frontend uses also leaves no
    dir). The 413/500 stream-error paths sweep as well (404 when cancelled).
  - **Non-cancel semantics are byte-identical:** for live uploads
    `_sweep_cancelled` returns False with zero side effects — 499
    resumability, `client_id` resume, `received[]` state, assemble/collision
    logic, and the boot GC (which had behaved correctly; the June 8 orphans
    were simply <48 h old at the last boots) are all untouched. Verified by
    the extended suite (117 checks): mid-write-cancel race → DELETE 200, dir
    initially survives (defect precondition), late PUT → 404 + dir GONE + no
    `.part*` files + second DELETE idempotent 200; drain-race → 404; cancel +
    disconnect → 499 with dir swept; a concurrent NON-cancelled upload's
    resume state unaffected and completes; tombstones FIFO-capped at 256;
    real uvicorn boot OK.
