# studio/app/core/ — DOCUMENT

## What this is
Studio's in-memory services and tiny persistence. No HTTP, no ffmpeg, no SDK —
just state and bookkeeping shared by routers, the helper-wrapper layer, and the
agent.

## Per-user session model (the v2 cutover)
The single global `active_folder` is GONE. Studio now stores **per-user, user-owned,
upload-only sessions** under `.runtime/users/<owner>/sessions/ses_<hex12>/` (each
holds `meta.json`, `transcript.json`, the uploaded videos, and an `edit/` dir).
`core/sessions.py` is the store + the **ownership chokepoint** + the agent-client
cache. Every router turns a client-carried `session_id` into a real dir ONLY
through `sessions.get` / `resolve_dir`, which require `meta.owner == caller` and
re-confine the dir to `USER_SESSIONS_ROOT` — so a cross-user / bad / missing id is
one uniform `404 session_not_found` (IDOR-safe).

## Status — IMPLEMENTED
- `sessions.py` — **the session store + ownership chokepoint + agent cache.**
  `SESSION_ID_RE` (`^ses_[0-9a-f]{12}$`); `Session` entity (id, owner [immutable],
  name [sanitized display], created_at, last_touched_at, status, schema) with
  read-time-derived `media_count` / `age_days(14d)` / `is_stale`. API: `create`
  (mkdir dir + `edit/`, atomic `meta.json`), `list_for` (scan `users/<owner>/
  sessions/*/meta.json`, sort last_touched desc), `get` (the chokepoint — owner +
  `SESSION_ID_RE` + inside-root or None), `resolve_dir` (realpath, re-confined),
  `touch` (atomic last_touched_at rewrite), `delete` (async since 2026-06-10:
  pops the cached agent client and AWAITS its `close()` — bounded by
  `_AGENT_CLOSE_TIMEOUT_S` = 3 s — BEFORE the rmtree, because the SDK
  subprocess's cwd pins the dir on Windows; the rmtree runs in a worker thread
  with a bounded ~1 s retry, and if the dir is STILL pinned its `meta.json` is
  dropped so the store can never list/resurrect the husk, which
  `sweep_session_husks()` removes at the next boot — strictly conservative:
  only `ses_*` dirs with NO meta.json and NO files anywhere, rmdir-only, never
  follows symlinks). **Agent-client cache keyed by `session_id`**
  (`get_agent`/`set_agent`/`pop_agent`) — stores the SAME `AgentSession` object so
  the `ask_user` pending-question Futures survive across turns; `pop_agent` does
  NOT close — the CALLER owns shutdown (`delete` awaits it; the old
  fire-and-forget `loop.create_task(close())` silently did nothing from a sync
  route's threadpool thread). Imports neither the agent nor routers (acyclic;
  agent typed `Any`).
- `state.py` — **emptied by the cutover.** No more `active_folder` singleton, no
  more persisted `state.json` active folder, no more per-folder agent cache (all
  moved to `sessions.py`). Kept as a stable import target / migration breadcrumb;
  exports nothing.
- `jobs.py` — `Job` (status, percent, phase, bounded log tail, cancel Event,
  thread-safe) + `JobRegistry` with **single-flight per kind** (`create()`
  returns the running job if one is in flight → caller emits `409 job_in_flight`).
  Progress is the single source feeding both the chat `tool_progress` SSE and the
  REST transcribe SSE. **2026-06-10 (diagnostic logging, additive):** this is
  the SINGLE chokepoint every transcribe AND render job passes through — REST
  router or agent chat tool alike — so `registry.create` logs `start kind=
  job_id=` and `finish_ok`/`finish_error`/`mark_cancelled` log `end job_id=
  kind= outcome= duration_ms=` (logger `studio.job`; error messages pass
  `applog.sanitize_log_value` since subprocess stderr can be multi-line; log
  calls sit OUTSIDE the registry/job locks). No behavioral change.
- `uploads.py` — `UploadSession` now carries its owning **`session_id`** and the
  `dest_folder` is that session's dir; chunk PARTS still live in the temp
  `.runtime/uploads/<id>/<n>.part` dir, but `assemble()` writes the finished file
  into the session dir (inside `USER_SESSIONS_ROOT`). Idempotent chunk writes,
  **per-chunk + cumulative size enforcement** (`expected_chunk_size`/
  `check_chunk_size`/`note_part_written` + `UploadTooLarge`), ordered assemble
  with size verify + fsync. `UploadRegistry.create(session_id, dest, …,
  owner=, client_id=)`; `get`/`forget` unchanged; `remove` (explicit abort)
  deletes the part dir on the spot since 2026-06-10, and since the cancel-race
  pass ALSO tombstones the upload_id (`is_cancelled`, bounded FIFO cap 256) so
  a chunk PUT that was mid-write when the cancel landed refuses to commit and
  sweeps the dir itself ("last writer sweeps") — see the live-test fixes
  below.
  **2026-06-10 (red-thread uploads):**
  - **Resume identity:** `UploadSession` gained `owner` + `client_id`;
    `registry.find_resumable(owner, session_id, client_id, filename, size,
    chunk_size)` returns the live upload matching the FULL tuple (a same-
    client_id init with different metadata never resumes the wrong bytes), and
    `prune_missing_parts()` drops received indices whose part file vanished
    before the `received` list is handed back. In-memory only — a restart
    empties the registry and re-init falls back to a fresh upload by design.
  - **Collision-safe assemble:** `assemble()` auto-renames on a destination
    collision via `collision_free_name()` (`name (2).ext`, extension preserved,
    candidate re-checked through `security.sanitize_filename`, length-capped);
    the choose-name + rename step is serialized under `_ASSEMBLE_NAME_LOCK` and
    the `.assembling` temp embeds the `upload_id` so concurrent same-named
    assembles cannot clobber each other. The path returned (and `stored_name`)
    is the file ACTUALLY written — an existing file is NEVER overwritten.
  - **Orphan GC:** `gc_orphan_part_dirs(max_age_seconds=48h)` removes
    `.runtime/uploads/up_*` dirs NOT in `registry.live_ids()` AND older than
    the mtime threshold (both guards required — active uploads are never
    touched). Best-effort, never raises; returns the removed names for the
    caller (main.py lifespan) to log.
- `applog.py` — **NEW (2026-06-10, diagnostic-logging plan): rotating file
  logging.** `init_logging()` attaches a `RotatingFileHandler` →
  `studio/.runtime/logs/studio.log` (UTF-8 with `errors="replace"`, ~5 MB ×
  5 backups ⇒ ~30 MB disk cap) to the `studio` logger (level INFO,
  `propagate=False`, plus an explicit stderr handler at WARNING that preserves
  the pre-existing lastResort console behavior) AND to `uvicorn.access` /
  `uvicorn.error` (handler appended only — their console output/levels are
  untouched), so HTTP access lines persist too. Line format:
  `2026-06-10 19:30:01.123 INFO  studio.upload | msg key=value`. Idempotent
  (tagged handler, one attempt per process) and best-effort top to bottom — a
  failed mkdir/dead disk means the app simply runs file-log-less, never an
  exception. Called first in `create_app()` (import time under uvicorn) +
  defensively at lifespan start. `sanitize_log_value(value, max_len)` is the
  shared scrubber for client-influenced values (C0/C1 control chars → space,
  so no CR/LF log-line forgery; length-capped; never raises);
  `log_file_path()` reports the active file for the startup facts line.
  Imports only `settings` (acyclic; safe for both routers and core modules).
- `tls.py` — **NEW (2026-06-11, Secure Studio plan): local CA + leaf TLS
  certificates.** Pure cert logic (`cryptography==48.0.0` x509 builder API;
  NO FastAPI imports; imports only `net` + `settings`). **`ensure_certs() ->
  TlsPaths | None`** makes `.runtime/tls/` hold a valid pair every launch and
  NEVER raises (None ⇒ HTTPS unavailable, caller serves HTTP-only — the
  applog best-effort discipline). Plan-§2-verbatim spec: EC P-256 PKCS8 keys
  (0600 POSIX); CA = BC CA:true (critical) + keyUsage keyCertSign,cRLSign
  (critical) + SKI + **nameConstraints (critical)** (dNSName `.local`/
  `localhost`, iPAddress 192.168/16, 10/8, 172.16/12, 127/8) + 10y validity
  − 48h backdate + CN `video-use Studio CA <hostname> <8-hex-fp>` + random
  128-bit serial; leaf = SANs (`localhost`, `<hostname>.local`, `127.0.0.1`,
  every current private IPv4 — collected via `getaddrinfo(gethostname())` +
  `net.lan_ip()`, deduped, FILTERED to RFC1918+loopback so no SAN can fall
  outside the constraints) + EKU serverAuth + keyUsage digitalSignature +
  397d − 48h + AKI, ECDSA-SHA256-signed by the CA. **Regen rules:** CA is
  STABLE — regenerated only on missing/unparseable/key-mismatch (damaged
  files preserved as `*.bad-<ts>`, LOUD warning + banner: phones must redo
  Secure Setup; a FIRST-run creation is informational, not loud); leaf is
  silently re-issued on missing/unparseable/key-mismatch/not-signed-by-
  current-CA/<30d-to-expiry/`lan_ip()`-not-in-IP-SANs/`<hostname>.local`-
  not-in-DNS-SANs. No metadata sidecar — everything re-derived by parsing.
  `ensure_certs` also sweeps stale `*.tmp` leftovers (crashed `_atomic_write`;
  may hold key bytes) from `.runtime/tls/` at the start of each run —
  best-effort unlink, `*.bad-<ts>` forensic files never touched.
  **`CA_NAME_CONSTRAINTS`** module constant is the documented fallback: set
  False to regenerate the CA WITHOUT nameConstraints if a device rejects the
  constrained chain (the flag-vs-disk mismatch triggers the regen).
  Read-side: `get_state()` (mtime-cached PEM parse → `{available, ca_sha256,
  leaf_expires, sans}`; never raises), `ca_der()` (for `GET /ca.crt`),
  `set_serving(bool)` (serve.py stamps whether HTTPS is actually up) +
  `is_enabled()` (serve decision wins; legacy `-m uvicorn` entrypoint falls
  back to configured-AND-files-valid — documented nuance),
  `ca_regenerated_this_boot()` (banner warning hook). Keys are never logged.
- `events.py` — `sse(event, data)` / `sse_comment(text)` — the exact
  `event:/data:` SSE framing used by both SSE endpoints.
- `persist.py` — atomic JSON chat-transcript persistence at
  **`<session_dir>/transcript.json`** (replaces the old `state.json` active folder
  + `sessions/<folder-hash>.json` pathing). `load_transcript(session_dir)` /
  `append_message(session_dir, msg)`. Transcript lives in the session dir
  alongside `meta.json` + media; outputs still go to `edit/` (Hard Rule 12).

## Key invariants
- **Ownership chokepoint:** never build a session path from a raw client string
  except through `sessions.get` / `resolve_dir` (owner + id-regex + inside-root).
- Single-flight: one render + one transcribe at a time (per process).
- All persistence lives in `studio/.runtime/` (gitignored).
- Thread-safe: jobs/uploads/sessions guard mutable state with locks; the worker
  coroutine updates job progress while the SSE consumer reads it.
- **TLS (2026-06-11):** `ensure_certs` never raises (TLS can never block
  boot); the CA stays stable across leaf regens (phones trust ONCE); private
  keys never appear in any log line or HTTP response.

## Feature: per-user sessions cutover (2026-06-08)
Replaced the single global `active_folder` with per-user, user-owned, upload-only
sessions. New `core/sessions.py` (store + ownership chokepoint + session_id-keyed
agent cache). `state.py` emptied (`active_folder` + persisted active folder + the
old folder-keyed agent cache removed). `persist.py` rewritten to store transcripts
at `<session_dir>/transcript.json` (the `load_active_folder`/`save_active_folder`
and `sessions/<folder-hash>.json` pathing are gone). `uploads.py` `UploadSession`
gained `session_id` and assembles into the session dir. The non-object-JSON guard
from BUG-17 (below) was preserved in the rewritten `persist.load_transcript`.

## Bug fixes (2026-06-08)
- **persist.py — non-object JSON crash (BUG-17):** the transcript loader parsed
  the file with `json.loads` then called `data.get(...)`, which raised
  `AttributeError` (uncaught) when the file was valid JSON but not a dict (`null`,
  `[]`, `"x"`, `42`) — a 500 on the first request touching `/api/chat/history`.
  `load_transcript` guards `isinstance(data, dict)` after the parse and before
  `.get`, returning `[]` so corrupt files degrade gracefully. (The old
  `load_active_folder` that shared this guard was removed in the session cutover.)
- **uploads.py — upload cap bypass (BUG-04, P1 security):** `write_chunk`
  validated only the chunk INDEX, so a client could declare a tiny `size_bytes`
  (one chunk) then write a multi-GB chunk-0. `UploadSession` now enforces the
  per-chunk expected size and a cumulative byte total against both `size_bytes`
  and `MAX_UPLOAD_BYTES` (`expected_chunk_size`/`check_chunk_size`), signalling
  the new `UploadTooLarge` (router → HTTP 413). Per-chunk byte sizes are tracked
  in `_part_sizes`. The router streams to disk and reports each part via
  `note_part_written`. (Paired with the bounded-streaming fix in
  `routers/upload.py`.)
- **uploads.py — destroy-on-fail (BUG-18, P2):** added `UploadRegistry.forget`
  (drops the session entry WITHOUT deleting parts) so the router can free the
  registry slot after a successful assemble while reserving `remove`
  (parts-deleting) for explicit abort and permanent-incomplete only — a
  transient `OSError` during assemble no longer wipes uploaded parts.

## Bug fixes (2026-06-10, live-test defects)
- **uploads.py — explicit cancel stranded the part dir (P2, tester-confirmed):**
  `DELETE /api/upload/{id}` returned 200 but `registry.remove` only popped the
  registry entry on some paths where the racing in-flight chunk PUT still held
  the `.part` handle on Windows — so `.runtime/uploads/up_<id>/0.part` (8 MB in
  the live repro) stayed on disk until the 48 h boot GC. `remove` now deletes
  the part dir via the new `remove_tree_with_retry(path)` — bounded retry
  schedule `(0.0, 0.3, 0.6)` s for transient Windows locks (the just-aborted
  PUT, an AV/indexer scan), `FileNotFoundError` is success, end state (not the
  last exception) is reported, and NOTHING here ever raises: a still-locked dir
  is logged ONCE and left for the boot GC, the DELETE request never 500s on
  cleanup failure. The abort route is a sync handler (threadpool), so the retry
  sleeps never block the event loop. **Transient-failure semantics unchanged:**
  `remove` is reached ONLY from explicit abort + the permanent-incomplete
  branch — a 499 disconnect or a retryable assemble `OSError` still leaves
  parts + registry intact (verified: same upload_id + `received` list survive
  both, then `/complete` retries to success).
- **sessions.py — Windows locked-session-dir delete husks:** the prior pass also
  landed the session-delete hardening (awaited agent close before rmtree,
  bounded rmtree retry, meta-drop + `sweep_session_husks()` boot sweep) — noted
  here for accuracy; it was a PM-deferred item, flagged to the PM as found
  in-tree (see routers/sessions.py `DELETE /api/sessions/{id}`).

## Bug fix (2026-06-10, cancel-race pass)
- **uploads.py — cancel raced by an in-flight chunk PUT (P1, live x2):** the
  bounded retry above only wins when NO writer is active. A cancel landing
  mid-chunk could not delete the part dir at all (the streaming PUT's open
  `.part.tmp` handle blocks every attempt on Windows for the WHOLE write,
  which a handler-safe retry cannot outwait), and the late PUT then committed
  its chunk and re-persisted the dir until a boot >48 h later. Now:
  - `UploadRegistry` keeps a **bounded FIFO tombstone dict** (`_cancelled`,
    cap `_CANCEL_TOMBSTONE_CAP = 256` — a tombstone only needs to outlive the
    longest in-flight chunk request; memory stays O(cap)). `remove()` records
    the tombstone **atomically with the registry pop (same lock hold), BEFORE
    attempting its delete**, so a still-streaming writer is guaranteed to
    observe the cancel. New **`is_cancelled(upload_id)`** is the query;
    `create()` clears a same-id tombstone (token-collision paranoia). The
    tombstone also covers the permanent-incomplete discard in `complete` (the
    other `remove` caller) — semantics are "explicitly destroyed", and a late
    writer racing that discard is swept identically.
  - The sweep itself lives in the router (`routers/upload.py`
    `_sweep_cancelled`): the late writer deletes its tmp, makes ONE immediate
    `remove_tree_with_retry(part_dir, delays=(0.0,))` attempt (no retry
    sleeps in a request handler; its own handle is closed so this normally
    succeeds — "last writer sweeps"), and answers 404 `upload_not_found`.
  - `remove()`'s retry schedule is unchanged (sub-second, first attempt —
    still reclaims the no-writer case instantly); its locked-dir warning now
    names the writer sweep as the expected collector (boot GC = last resort).
  - **Transient-failure semantics unchanged:** `remove` is still reached ONLY
    from explicit abort + permanent-incomplete; 499 disconnects and retryable
    assemble errors leave parts + registry intact, and non-cancelled uploads
    see zero behavior change (re-verified by the full extended suite, 117
    checks PASS, including a live mid-write race repro and an unaffected
    concurrent control upload).
