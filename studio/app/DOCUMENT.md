# studio/app/ — DOCUMENT

## What this is
The FastAPI backend package for video-use Studio. The HTTP layer (`routers/`)
routes requests, the agent module (`agent/`) drives the Claude Agent SDK, and the
helper-wrapper layer (`helpers_wrap/`) is the single seam to the repo's unmodified
`helpers/`. Implemented in full by the Backend Engineer.

## Per-user session model (the v2 cutover, 2026-06-08)
The single global `active_folder` + filesystem browser were replaced with
**per-user, user-owned, upload-only sessions** under
`.runtime/users/<owner>/sessions/ses_<hex12>/`. `core/sessions.py` is the store +
ownership chokepoint + session_id-keyed agent cache. `allowed_roots()` is now the
single `USER_SESSIONS_ROOT` (`.runtime/users/`) so the agent is confined to the
per-user tree. Every per-session request carries a client-carried `session_id`
(stateless, concurrency-safe) resolved via `routers/deps.require_session_dir`.

## Status — IMPLEMENTED
- `__init__.py` — package marker, `__version__ = "0.1.0"`.
- `main.py` — app factory: lifespan (warms the session secret, runs the one-time
  **v2 session migration**, sweeps orphaned upload part dirs via
  `core.uploads.gc_orphan_part_dirs` [>48 h AND not live — never an active
  upload], sweeps session-delete husks via `core.sessions.sweep_session_husks`
  [empty meta-less `ses_*` dirs only], warms the frontend `asset_version`
  cache, prints the startup banner via `net` — every sweep is best-effort and
  never blocks boot), mounts every router (incl. the new `sessions` router; the
  `fs` router is gone), serves the SPA at `/` and `/static`.
- `settings.py` — all paths, host/port, upload cap, **multi-user login map
  (`users()`) + session secret + first-run auto-generated password**, real
  ffmpeg/ffprobe/version + ELEVENLABS key (with source) + `has_anthropic_api_key`
  detection. `VIDEO_EXTS` mirrors the helpers exactly. New: **`USER_SESSIONS_ROOT`**
  (`.runtime/users/`) and **`MIGRATED_MARKER`** (`.runtime/migrated_v2`);
  `allowed_roots()` returns `[USER_SESSIONS_ROOT]` (the agent's single confined
  root). The disk-browser default-roots helper + `default_footage_dir` were
  removed (no more browse-the-disk).
- `security.py` — session token sign/verify (stdlib HMAC, constant-time),
  multi-user constant-time credential check (anti-enumeration dummy compare),
  `resolve_in_roots` realpath path-traversal guard, filename/foldername
  sanitizers. New: **`sanitize_display_name`** (printable, control-stripped,
  whitespace-collapsed, capped ~80 — for the session DISPLAY name only; the id is
  the path component) and **`is_within_root`** (realpath prefix check used to
  confine `/api/file` to the caller's own `users/<username>/` subtree).
- `net.py` — LAN IP, terminal QR for the LAN URL, startup banner (URLs + login
  creds + firewall hint). Prints the generated password once.
- `core/`, `helpers_wrap/`, `agent/`, `routers/` — see each subpackage's
  DOCUMENT.md.

## Auth model (Delta 1 + Delta 3) — multi-user, single mechanism
Username/password login (`POST /api/login`) is validated against a configured
**set of accounts** and mints a signed, httpOnly, SameSite=Lax `studio_session`
cookie (NOT Secure — plain http on the LAN) recording WHICH username
authenticated. The browser sends it automatically on every request incl. SSE and
media, so there is no token-in-URL. `POST /api/logout` clears it; `GET /api/me`
(public) returns the cookie's username and gates the UI. Everything else under
`/api/*` requires the cookie (`require_session` → 401). Accounts: the `[users]`
table in `config.toml` (`name = "password"`), plus the legacy
`STUDIO_USERNAME`/`STUDIO_PASSWORD` (or `[auth]`) pair merged in; if nothing is
configured, an `admin` account with a random password is generated + printed
once. Signing secret: `STUDIO_SECRET` (Docker) or a persisted per-install secret.
Constant-time compares; an unknown user and a wrong password yield the same 401
(no enumeration); passwords never logged.

## Agent auth (Delta 2) — dual mode
`agent/env.py`: if `ANTHROPIC_API_KEY` is present (Docker/primary) the SDK uses it
(api_key mode); if absent (native) the key + `ANTHROPIC_AUTH_TOKEN` are stripped
so the SDK uses the local Claude Code login (subscription mode). The agent is
isolated from the user's personal config via `setting_sources=[]` + an explicit
SKILL.md-derived `system_prompt` (no inherited settings/hooks/memory).

## One-time v2 migration (main.py lifespan, idempotent)
Guarded by the `.runtime/migrated_v2` marker. On boot, if the marker is absent:
- If the legacy `state.json` `active_folder` EXISTS and is INSIDE `.runtime` (the
  live case — it points at `.runtime/uploads` holding the videos + an `edit/`
  dir), use ONE **"Imported footage"** session owned by **`Sam`**
  (created_at/last_touched_at=now, so it is not instantly stale) — **REUSING** a
  prior partial-import session if one already exists (so a retry never creates a
  duplicate), else creating it. MOVE the videos into the session dir and **MERGE**
  the legacy `edit/` children INTO the session's `edit/` (outputs/transcripts/
  relay only read `<session_dir>/edit/`, so the legacy dir is never relocated to
  `edit_imported/`). The move is same-volume within `.runtime`; NON-DESTRUCTIVE —
  `shutil.move` only removes the source on success, so an error never deletes an
  original. Import the legacy `sessions/<folder-hash>.json` transcript into the
  session's `transcript.json` (NON-FATAL — a transcript failure is logged, never
  blocks the marker, and never propagates).
- If `active_folder` is OUTSIDE `.runtime` (a real on-disk footage dir), MOVE
  NOTHING and skip the import (logged).
- If there is nothing to migrate, just write the marker.
- The marker is written ONLY when every video + every `edit/` child moved cleanly
  (`failed == 0`). If ANY entry could not be moved (a transient Windows lock or a
  merge collision) the marker is LEFT UNWRITTEN, so the next clean boot retries
  the stragglers and REUSES the same session — footage is never
  stranded-and-forgotten and no duplicate session is created. Migration never
  blocks boot (any unexpected exception is logged, not raised, marker unwritten).

Verified against seeded throwaway runtimes: the live case (2 media moved, edit/
children merged, transcript imported, owner=Sam, not stale, originals drained),
idempotent reboot (no duplicate), a partial move failure (marker withheld, 1st
file moved, failed file's original + bytes intact, retry REUSES the same session
+ moves the straggler + only THEN writes the marker), an `edit/` merge failure
(marker withheld, no `edit_imported/`, non-failing child merged, retry completes),
and transcript-write failures (non-fatal — videos still move, marker still
written, no duplicate on reboot).

## Boot entrypoint
`app.main:app` (uvicorn). Verified (2026-06-10): `create_app()` imports clean;
**29 routes** registered (28 API routes + the `/static` mount — the same "29"
PM/overview counts). No route was added or removed by the 2026-06-10
red-thread-uploads pass.

## Feature: fully managed per-user sessions (2026-06-08)
The cutover from a single global `active_folder` to per-user, user-owned,
upload-only sessions. ADDED `core/sessions.py` + `routers/sessions.py`; DELETED
`routers/fs.py`. MODIFIED `settings.py` (`USER_SESSIONS_ROOT`/`MIGRATED_MARKER`,
`allowed_roots`→`[USER_SESSIONS_ROOT]`), `security.py` (`sanitize_display_name` +
`is_within_root`), `core/state.py` (emptied), `core/persist.py` (transcript per
session dir), `core/uploads.py` (`session_id` + assemble into session dir),
`routers/deps.py` (`require_session_dir`), `routers/{chat,inventory,outputs,
transcripts,transcribe,upload,status,auth,files}.py`, `agent/session.py` (cache
re-key by `session_id`; `ask_user` Futures preserved), `main.py` (register
sessions router, drop fs, v2 migration in lifespan). Storage layout, session
model (`meta.json`), API contract, access control, and migration are documented
in the per-subpackage DOCUMENT.md files. Locked decisions: legacy-import owner =
`Sam`; delete = permanent rmtree; stale threshold = 14 days; transport =
client-carried `session_id` per request; `/api/me` returns a stale COUNT.

## Feature: reliable phone uploads + red-thread backend (2026-06-10)
Backend half of the red-thread-uploads plan (frontend retry/resume/wake-lock is
the parallel frontend pass). NO new routes (count unchanged at 29 incl. mount):
- **`routers/upload.py` + `core/uploads.py` — `client_id` resume.** `init`'s
  previously-unused `client_id` is now honored: a re-init matching a LIVE upload's
  (owner, session_id, client_id) with an identical filename+size+chunk_size
  returns the SAME `upload_id` + `received:[int,...]` so the client skips done
  chunks. Opaque id, `^[A-Za-z0-9_-]{8,64}$`; a malformed id is treated as ABSENT
  (degrades to a fresh upload, never a 400 — documented decision: upload
  completion beats strictness). In-memory only — a restart falls back to a fresh
  upload cleanly. Received indices whose part files vanished are pruned on
  resume. The 499 `client_disconnected` chunk-PUT contract holds on BOTH the
  main streaming write AND the idempotent re-PUT drain (the drain path was
  restored to the documented contract in the 2026-06-10 QA fix pass — a
  disconnect mid-drain 499s, while the chunk itself STAYS committed/received
  so the retry is a cheap idempotent 200). A missing/leaked/cross-user
  `upload_id` is a uniform **404 `upload_not_found`** (was `not_found`; the
  frontend's restart self-heal keys on this code — QA fix, same pass).
- **Collision-safe assemble (`core/uploads.py`).** `assemble()` never overwrites
  an existing same-named file in the session dir — it auto-renames to
  `name (2).ext` (extension preserved, candidate re-checked through
  `sanitize_filename`, choose+rename serialized under a lock); the complete
  response `path` reflects the name ACTUALLY stored (shape unchanged).
- **Orphan part-dir GC.** `core/uploads.gc_orphan_part_dirs()` (called from the
  lifespan in `main.py`) removes `.runtime/uploads/up_*` dirs that are NOT in
  the live registry AND older than 48 h (mtime). Never touches active uploads;
  best-effort; logs what it removed; never blocks boot.
- **`security.py` — case-folded extension check + stored-name normalization.**
  `sanitize_filename` / `is_video_file` compare lower-cased ext against the
  lower-cased allowlist, so `CLIP.M4V` no longer 400s at init. Since the
  2026-06-10 QA fix pass, `sanitize_filename` also NORMALIZES the stored
  suffix to the canonical in-allowlist spelling when the exact-case suffix is
  not literally in `VIDEO_EXTS` (`CLIP.M4V` → `CLIP.m4v`; an already-in-list
  `.MP4` is kept as-is) — case-SENSITIVE helper discovery
  (`helpers_wrap/inventory.py`, `helpers/transcribe_batch.py`:
  `suffix in VIDEO_EXTS`) would otherwise never surface or transcribe the
  uploaded file. Applied at init, so resume identity, assemble, and the
  collision rename all agree on the normalized name. `VIDEO_EXTS` CONTENT
  unchanged (helper-parity rule with `helpers/transcribe_batch.py`). Known
  pre-existing gap left alone: `_migrate_v2` (`main.py`) still checks
  `entry.suffix in VIDEO_EXTS` case-sensitively — one-time legacy migration,
  semantics intentionally untouched.
- **`routers/files.py` — `?download=1`** adds `Content-Disposition: attachment`
  (control chars stripped, RFC 5987 `filename*` percent-encoded + conservative
  ASCII fallback — no header injection). Without the param the response is
  byte-identical to before (Range/206 preserved); auth + per-user confinement
  unchanged.
- **`routers/auth.py` + `main.py` — `asset_version` on `/api/me`** (stale-tab
  detection): the frontend's `ASSET_VERSION` is regex-parsed READ-ONLY from
  `frontend/app.js`, mtime-cached (a frontend bump lands without a backend
  restart), `null` on any failure; warmed at startup.
- **`agent/tools.py` — two QA P2 confinement fixes:** the `render` tool's
  `output` path and EDL `overlays[].file` are now root-confined via
  `security.resolve_in_roots` before use (clean tool error on escape — closes an
  arbitrary write/mkdir and an arbitrary-file-read-into-render primitive).
Verified by a 48-check isolated-runtime suite (resume contract, rename, GC
guards, headers, confinement, 401/400/404 envelopes) + a real boot on :8499.
The 2026-06-10 QA fix pass (upload_not_found code, .M4V→.m4v stored-name
normalization incl. the collision path, drain-path 499 restoration) re-ran an
extended 68-check suite (all green) + a real boot on :8431.

## Live-test defect fixes (2026-06-10, post-App-Tester)
Two backend defects found by the App Tester's live browser run:
- **P1 — `/api/inventory` reported stale `has_transcript:false` until a server
  restart** after a transcribe job wrote real transcripts (clip badges + the
  journey stepper never advanced). Root cause: the inventory cache signature
  hashed only the source videos. Fixed in `helpers_wrap/inventory.py` by
  folding the `edit/transcripts/` state (json count + newest `st_mtime_ns` +
  total bytes) into the signature — self-healing for EVERY transcript producer
  (REST job and agent chat tools alike), cache + cheapness preserved (no
  ffprobe on the signature path). Details in `helpers_wrap/DOCUMENT.md`.
- **P2 — explicit `DELETE /api/upload/{id}` returned 200 but left the
  `.runtime/uploads/up_<id>/` part dir on disk** (only the 48 h boot GC would
  collect it). Fixed in `core/uploads.py` (`remove_tree_with_retry` — bounded
  ~0.9 s retry for transient Windows locks, never raises, logs once and defers
  to the boot GC if still locked) wired from `registry.remove`; the DELETE
  route never 500s on cleanup failure. Transient-failure semantics untouched:
  499 disconnects and retryable assemble errors still leave parts + the
  `client_id` resume state intact. Details in `core/DOCUMENT.md` +
  `routers/DOCUMENT.md`.
The same pass also landed the session-delete husk hardening
(`core/sessions.py` async `delete` + `sweep_session_husks`, async
`DELETE /api/sessions/{id}`) — a PM-deferred item found already in-tree,
flagged to the PM. Verified by the extended 92-check isolated-runtime suite
(all green: transcript flip without restart + cache-hit retention, cancel
part-dir deletion + locked-dir tolerance, 499/assemble-failure resume
invariants, plus all prior checks) and a real uvicorn boot on :8433
(`GET /api/me` 200, sane shape). Route count unchanged at 29.

## Constraints honored
- Routers never shell out or import helper modules directly — they go through
  `helpers_wrap/`. `agent/` is the only package that imports `claude_agent_sdk`.
- Single-flight per job type (one render, one transcribe) via `core/jobs`.
- **Ownership chokepoint:** a session path is only ever built from a client string
  through `core.sessions.get`/`resolve_dir` (owner + id-regex + inside-root).

## Bug fixes (2026-06-08)
- **main.py — startup banner on non-UTF-8 stdout (BUG-20):** the QR's Unicode
  block glyphs broke `print(banner)` on a cp1252/redirected/service stdout, and
  the old `logger.info` fallback was dropped (no handlers yet) — silently losing
  the auto-generated first-run password. Lifespan now reconfigures stdout to
  UTF-8 (errors='replace') and, on any failure, writes the raw UTF-8 bytes
  directly so the credentials block always reaches stdout. Banner text unchanged.
- **main.py — index 500 on missing assets (BUG-22):** `GET /` now returns a
  clean 503 ("frontend assets not built") when `index.html` is absent instead of
  letting Starlette raise an obscure 500 at send time.
- **main.py — /openapi.json ungated (BUG-23):** added `openapi_url=None` to the
  `FastAPI()` constructor so the unauthenticated route/param schema is no longer
  served (the docs UIs were already disabled).
- **net.py — QR hardening (BUG-20 defense-in-depth):** `startup_banner` now omits
  the QR block when `sys.stdout.encoding` isn't UTF-8, so the credentials banner
  prints cleanly even before the stdout reconfigure in `main.py` takes effect.
- **main.py — stale SPA shell on returning clients (cache delivery):** `index.html`
  (the `GET /` route) and `/static/*` were served with `etag`/`last-modified` but
  NO `Cache-Control`, so a returning client (especially a phone) could reuse a
  cached `index.html` without revalidating. Because the cache-busting `?v=N` query
  lives INSIDE `index.html` (on `app.js`/`styles.css`), a stale shell meant the
  client never requested the new versioned assets and kept running old code until
  a manual hard-reload. Fix: `GET /` now sets `Cache-Control: no-cache` (via
  `FileResponse(..., headers=...)`) so the shell is cached but ALWAYS revalidated
  via ETag on every load, making the `?v=` asset bumps reliable. A tiny
  `_RevalidatingStaticFiles(StaticFiles)` subclass overrides `file_response` to add
  `Cache-Control: no-cache` to every `/static/*` response (so even bare,
  un-versioned ES-module imports revalidate); the mount now uses it. This is
  `no-cache` (revalidate), NOT `no-store` — unchanged assets still get cheap `304`s.
  ETag/Last-Modified, Range/`206` partial responses, the `304` conditional path,
  and the existing 503-guard on a missing `index.html` are all unchanged.
  Verified via an isolated throwaway-runtime boot + `curl`: `GET /` carries
  `cache-control: no-cache`; `/static/{app.js,styles.css}` carry it on `200`/`304`/
  `206`; the `503` guard still fires when `index.html` is absent.

## v2 migration robustness fixes (2026-06-08, post-review)
Hardened `_migrate_v2` against partial-move + retry hazards (real ~440 MB of
footage moves on the user's next restart):
- **P1 — footage-stranding:** the per-file move loop now tracks a `failed` count
  and the `migrated_v2` marker is written ONLY when `failed == 0`. Previously a
  single transient Windows lock left a video orphaned in `.runtime/uploads` while
  the marker was written unconditionally, so it was never retried (invisible
  forever). Now a clean restart retries the stragglers (the `dest.exists()` guard
  keeps already-moved files idempotent).
- **P2 #1 — no duplicate session + guarded transcript:** added
  `_find_prior_import_session` — a retry detects the existing Sam-owned "Imported
  footage" session (via `sessions.list_for`) and REUSES it instead of creating a
  second one. The legacy-transcript import is now non-fatal in two layers: the
  `os.replace` write inside `_import_legacy_transcript` is wrapped (logs + returns
  False, cleans up the `.tmp`), AND the call site in `_migrate_v2` is wrapped, so
  no OSError from the import path can propagate, leave the marker unwritten, and
  cause a duplicate session next boot.
- **P2 #2 — `edit/` merge (was `edit_imported/`):** added `_merge_edit_dir`, which
  moves the legacy `edit/` CHILDREN into the created session's `edit/` (the only
  dir outputs/transcripts/relay read). A merge collision/failure is counted into
  `failed` so the marker is withheld (fail loud, retry next boot) rather than
  silently stranding outputs under an unread `edit_imported/`.
Preserved properties: non-destructive (originals never deleted on error),
idempotent, only moves data INSIDE `.runtime` (never relocates a real on-disk
footage dir), owner = `Sam`, created_at/last_touched_at = now, safe when there is
nothing to migrate. Verified with a throwaway-runtime self-test (36/36 checks):
happy path + idempotent reboot, partial-failure + reuse-on-retry, edit-merge
failure + withheld marker, and transcript-failure non-fatality.
