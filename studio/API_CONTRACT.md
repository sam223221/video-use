# video-use Studio — API Contract (FROZEN)

> Frozen reference extracted from `ARCHITECTURE.md` §4 by the Setup Engineer so
> the **Backend Engineer** (implements) and **Frontend Engineer** (consumes) can
> build in parallel against the same spec. If a change is needed, update
> `ARCHITECTURE.md` first, then this file, then notify both engineers.

## Conventions

- **Base path:** `/api`. The SPA is served at `/` (and static assets at `/static`).
- **Auth (MULTI-USER LOGIN + SESSION — supersedes the old token-in-URL design):**
  the user signs in with a username + password (`POST /api/login`), validated
  against a configured **set of accounts**; on success the server sets a signed,
  **httpOnly, SameSite=Lax** cookie named `studio_session` that records WHICH
  username authenticated. The browser sends that cookie automatically on every
  subsequent request — including `fetch`, `<video>`/`<img>` media, and
  SSE/`EventSource` — so there is **no token in the URL**.
  - **Public (ungated):** `POST /api/login`, `POST /api/logout`, `GET /api/me`,
    and the SPA at `/` + static assets at `/static/*`.
  - **Gated:** every other `/api/*` request requires a valid `studio_session`
    cookie. Missing/invalid/expired → `401`.
  - The cookie is **not** `Secure` (Studio runs over plain http on the trusted
    LAN). The session token is HMAC-signed (stdlib `hmac`/`hashlib`), carries the
    authenticated username + a ~7-day expiry, and is verified in constant time.
    Passwords are compared in constant time and never logged. An unknown username
    and a wrong password return the **same** 401 (no username enumeration).
  - Accounts come from the `[users]` table in `studio/config.toml`
    (`name = "password"`, case-sensitive). The legacy single pair
    `STUDIO_USERNAME` / `STUDIO_PASSWORD` (or an `[auth]` table) still works and
    is merged in as one additional account. If nothing is configured anywhere
    (native first run), a single `admin` account with a random password is
    generated at startup and printed once to the console. The signing secret is
    `STUDIO_SECRET` if set (Docker — survives restarts), else a per-install
    secret persisted under `studio/.runtime/`.
  - `STUDIO_TOKEN` / `X-Studio-Token` / `?token=` from the scaffold are **dropped**
    in favor of the session cookie.
- **JSON errors:** `{ "error": { "code": "<machine>", "message": "<human>", "detail": <optional> } }` with an appropriate HTTP status.
- **SSE:** endpoints marked **SSE** return `text/event-stream`; each event is `event: <type>\ndata: <json>\n\n`.
- **Path inputs** are validated against the allowed roots; traversal → `400 path_outside_roots`.

### Auth endpoints (new — Backend Engineer, Delta 1)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/login` | public | `{username, password}` validated against the multi-user map → 200 `{ok:true, username}` + sets `studio_session` cookie recording that username; same 401 `{ok:false, error:"invalid credentials"}` for unknown-user OR wrong-password |
| POST | `/api/logout` | public | clears the cookie → `{ok:true}` |
| GET | `/api/me` | public | `{authenticated: bool, username: str|null}` — the frontend gates the UI on this |

## Endpoint index

| # | Method | Path | Auth | Stream | Purpose |
|---|--------|------|------|--------|---------|
| 1 | GET | `/api/status` | yes | no | health: ffmpeg, key, agent auth, active folder |
| 2 | GET | `/api/fs/roots` | yes | no | list allowed roots |
| 3 | GET | `/api/fs/browse?path=<dir>` | yes | no | list subdirs + video counts |
| 4 | POST | `/api/fs/select` | yes | no | set active footage folder |
| 5 | POST | `/api/fs/mkdir` | yes | no | make an upload destination folder |
| 6 | GET | `/api/inventory` | yes | no | ffprobe clips of active folder |
| 7 | POST | `/api/transcribe` | yes | no (202) | start a transcription job |
| 8 | GET | `/api/transcribe/{job_id}/events` | yes (query) | **SSE** | transcription progress |
| 9 | GET | `/api/transcribe/{job_id}` | yes | no | job snapshot (reconnect) |
| 10 | GET | `/api/transcripts` | yes | no | list cached transcripts |
| 11 | GET | `/api/transcripts/{stem}` | yes | no | raw Scribe JSON for one source |
| 12 | GET | `/api/packed` | yes | no | `takes_packed.md` text |
| 13 | POST | `/api/chat` | yes | **SSE** | send message; stream the agent turn |
| 14 | POST | `/api/chat/cancel` | yes | no | interrupt current turn |
| 15 | GET | `/api/chat/history?folder=<active>` | yes | no | persisted transcript |
| 16 | GET | `/api/file?path=<abs>` | yes (query) | no (Range) | safe media/image serving |
| 17 | GET | `/api/outputs` | yes | no | listing of active `edit/` |
| 18 | POST | `/api/upload/init` | yes | no | begin a chunked upload |
| 19 | PUT | `/api/upload/{id}/chunk?index=<n>` | yes | no | upload one chunk |
| 20 | GET | `/api/upload/{id}/status` | yes | no | received/missing chunks |
| 21 | POST | `/api/upload/{id}/complete` | yes | no | assemble the file |
| 22 | DELETE | `/api/upload/{id}` | yes | no | abort, delete parts |

> "Auth: yes" above now means **a valid `studio_session` cookie** (sent
> automatically by the browser), NOT a token header/query param. The three auth
> endpoints (`/api/login`, `/api/logout`, `/api/me`) are public and are listed in
> the Conventions section above.

> Chat turns are **POST-only** (#13). A chat turn is state-changing — it invokes
> the Claude Agent SDK and consumes tokens — so it must not be reachable via GET.
> Because the `studio_session` cookie is `SameSite=Lax` (sent on cross-site
> top-level GET navigations), a GET trigger would be CSRF-able; the JSON request
> body required by `POST /api/chat` blocks cross-site form forgery. The earlier
> `GET /api/chat/stream` fallback has been **removed**.

---

## 1. `GET /api/status`

Auth required. Response:
```json
{
  "ffmpeg": { "ok": true, "version": "8.1.1" },
  "ffprobe": { "ok": true },
  "elevenlabs_key": { "present": true, "source": "repo_root_env" },
  "agent_auth": { "ok": true, "mode": "subscription", "detail": "claude code login detected" },
  "active_folder": "C:\\Users\\samgl\\Videos\\shoot1",
  "allowed_roots": ["C:\\Users\\samgl\\Videos", "...\\studio\\.runtime\\uploads"],
  "version": "studio 0.1.0"
}
```
- `agent_auth.ok` from a lightweight, non-billing probe. `agent_auth.mode` ∈
  `api_key` (ANTHROPIC_API_KEY present — Docker/primary, pay-as-you-go) |
  `subscription` (no key, `claude` CLI present — Max subscription via local login) |
  `unavailable` (no key, no CLI). [Delta 2: dual-mode auth.]
- `elevenlabs_key.present` checks repo-root `.env` → `./.env` → env, never exposing the value.
  `elevenlabs_key.source` ∈ `repo_root_env` | `cwd_env` | `environment` | `null`.

> SCAFFOLD NOTE: the current `app/main.py` returns a minimal subset:
> `{ "ok": true, "ffmpeg": <bool>, "elevenlabs_key": <bool>, "agent_auth": "unknown", "version": "studio-scaffold" }`.
> The Backend Engineer replaces it with the full shape above.

## 2. `GET /api/fs/roots`
`{ "roots": [{ "path": "...", "label": "Videos" }] }`

## 3. `GET /api/fs/browse?path=<dir>`
`path` must resolve inside an allowed root.
```json
{ "path": "C:\\Users\\samgl\\Videos",
  "parent": "C:\\Users\\samgl",
  "dirs": [{ "name": "shoot1", "path": "...", "video_count": 6 }],
  "video_files": 0 }
```

## 4. `POST /api/fs/select`
Body `{ "path": "<dir>" }`. Validates existence + root membership, ensures `<dir>/edit/` creatable, persists.
Response `{ "active_folder": "...", "edit_dir": "...\\edit" }`.

## 5. `POST /api/fs/mkdir`
Body `{ "parent": "<allowed dir>", "name": "<safe name>" }`. Name validated (no separators, no `..`, no reserved Windows names).
Response `{ "path": "..." }`.

## 6. `GET /api/inventory`
ffprobe of the active folder.
```json
{ "folder": "...",
  "clips": [
    { "name": "C0103.MP4", "path": "...", "duration_s": 43.0,
      "width": 1920, "height": 1080, "fps": 24.0, "portrait": false,
      "has_transcript": true, "size_bytes": 734003200 }
  ],
  "total_duration_s": 312.4, "count": 6 }
```
`409 no_active_folder` if none selected. Cached per folder + mtime.

## 7. `POST /api/transcribe`
Body (all optional): `{ "files": ["C0103.MP4"], "workers": 4, "language": null, "num_speakers": null, "pack": true }`.
Response `202`: `{ "job_id": "trx_8f2a", "files": 6, "already_cached": 2 }`.
Wraps `transcribe_batch.py`; `pack=true` runs `pack_transcripts.py` after. Cached files skipped (Hard Rule 9).

## 8. `GET /api/transcribe/{job_id}/events` — **SSE**
```
event: progress
data: {"job_id":"trx_8f2a","done":3,"total":6,"current":"C0108.MOV","percent":50,"phase":"transcribing"}

event: file_done
data: {"name":"C0108.MOV","cached":false,"transcript":".../transcripts/C0108.json"}

event: done
data: {"job_id":"trx_8f2a","ok":true,"packed":".../takes_packed.md","transcribed":4,"cached":2}

event: error
data: {"job_id":"trx_8f2a","code":"elevenlabs_401","message":"Invalid API key"}
```

## 9. `GET /api/transcribe/{job_id}`
Non-stream snapshot: `{ "status": "...", "done": 3, "total": 6, "percent": 50, "error": null }`.

## 10. `GET /api/transcripts`
`{ "transcripts": [{ "stem": "C0103", "words": 412, "duration_s": 43.0 }] }`

## 11. `GET /api/transcripts/{stem}`
Raw Scribe JSON for one source (read-only).

## 12. `GET /api/packed`
`takes_packed.md` content (text/markdown). `404 not_packed` if absent.

## 13. `POST /api/chat` — **SSE**
Body `{ "message": "make a 60s cut, warm grade, bold subtitles", "folder": "<active>" }`.
Transport: **POST + streamed fetch body reader** (the browser sends the
`studio_session` cookie automatically; the JSON request body keeps the
state-changing turn safe from cross-site forgery). This is the **only** chat-turn
endpoint — there is no GET variant. Event stream:
```
event: turn_start      data: {"turn_id":"t_19"}
event: assistant_delta data: {"turn_id":"t_19","text":"Let me look at the footage. "}
event: tool_start      data: {"turn_id":"t_19","tool":"render","tool_call_id":"c1","input_summary":"preview, warm_cinematic"}
event: tool_progress   data: {"tool_call_id":"c1","percent":42,"phase":"extract 3/7"}
event: tool_end        data: {"tool_call_id":"c1","ok":true,"summary":"preview.mp4 87.4s","artifacts":["edit/preview.mp4"]}
event: assistant_delta data: {"turn_id":"t_19","text":"Preview is ready. "}
event: turn_end        data: {"turn_id":"t_19","stop_reason":"end_turn"}
event: error           data: {"turn_id":"t_19","code":"agent_auth","message":"Not logged into Claude Code"}
```

## 14. `POST /api/chat/cancel`
Body `{ "turn_id": "t_19" }`. Response `{ "cancelled": true }`.

## 15. `GET /api/chat/history?folder=<active>`
`{ "messages": [{ "role": "user|assistant", "content": "...", "tool_calls": [...] }] }`

## 16. `GET /api/file?path=<abs path>`
Safely serve a media/image file from inside the active `edit/` dir (or allowed roots). Supports HTTP **Range** (video scrubbing). Content-Type sniffed from extension; allowlist only: `.mp4`, `.mov`(served as mp4 container), `.png`, `.jpg`, `.srt`, `.json`, `.md`. Path validated against roots; symlinks resolved + re-checked. `403` otherwise.

## 17. `GET /api/outputs`
```json
{ "edit_dir": "...\\edit",
  "preview": { "exists": true, "path": "...", "duration_s": 87.4, "mtime": 1717000000 },
  "final":   { "exists": false },
  "edl":     { "exists": true, "ranges": 9, "total_duration_s": 87.4 },
  "master_srt": { "exists": true },
  "verify_pngs": [{ "name": "cut_03.png", "path": "..." }],
  "animations": [{ "slot": "slot_1", "render": "...", "exists": true }],
  "project_md": { "exists": true } }
```

## 18. `POST /api/upload/init`
```json
{ "dest_folder": "...allowed dir...",
  "filename": "IMG_4421.MOV", "size_bytes": 2147483648,
  "chunk_size": 8388608, "content_type": "video/quicktime",
  "client_id": "optional-uuid-for-resume" }
```
Validates: extension in video allowlist (`.mp4 .mov .mkv .avi .m4v` + uppercase), `size_bytes <= MAX_UPLOAD` (default 8 GiB), dest inside allowed root, filename sanitized, free disk ≥ size.
Response:
```json
{ "upload_id": "up_3c1d", "chunk_size": 8388608, "total_chunks": 256, "received": [] }
```
`413 upload_too_large` if over cap.

## 19. `PUT /api/upload/{upload_id}/chunk?index=<n>`
Body = raw bytes of chunk `n` (octet-stream). Optional `Content-Range` / `X-Chunk-Sha256`.
Response `{ "index": n, "received": [0,1,...,n], "bytes_received": 1234 }`. Idempotent.

## 20. `GET /api/upload/{upload_id}/status`
`{ "received": [...], "missing": [...], "total_chunks": 256, "complete": false }`

## 21. `POST /api/upload/{upload_id}/complete`
Assembles parts in order into `<dest_folder>/<sanitized filename>`, verifies total size (+ optional whole-file hash), fsyncs, removes the part dir.
Response `{ "ok": true, "path": "...", "size_bytes": 2147483648 }`. `409 incomplete` if chunks missing.

## 22. `DELETE /api/upload/{upload_id}`
Abort: delete parts. Response `{ "ok": true }`.

---

## Error codes (non-exhaustive)

| HTTP | code | when |
|------|------|------|
| 401 | `unauthorized` | missing/invalid/expired `studio_session` cookie on a gated route |
| 401 | (login) | `POST /api/login` with wrong credentials → `{ok:false, error:"invalid credentials"}` |
| 507 | `insufficient_storage` | upload `init` when free disk < declared size |
| 400 | `path_outside_roots` | path traversal / outside allowed roots |
| 409 | `no_active_folder` | inventory/outputs with no folder selected |
| 409 | `job_in_flight` | a render/transcribe of that type already running |
| 409 | `incomplete` | upload complete called with missing chunks |
| 413 | `upload_too_large` | `size_bytes > MAX_UPLOAD` |
| 404 | `not_packed` | `/api/packed` with no `takes_packed.md` |
| 500 | `elevenlabs_401` | Scribe rejected the key (surfaced in transcribe SSE) |
| 500 | `agent_auth` | not logged into Claude Code (surfaced in chat SSE) |
