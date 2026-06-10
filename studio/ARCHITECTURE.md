# video-use Studio — Architecture

> Status: Design v1 (Architect deliverable). No implementation code here.
> Author: Architect (for the PM). Date: 2026-05-30.
> Scope: a NEW local web app that wraps the existing `video-use` skill + helpers. The helpers, `SKILL.md`, and `.env` are NOT modified.

---

## 0. Reading map

This document is organized so each section is independently consumable by the engineer who owns it:

| Section | Owner | Purpose |
|---|---|---|
| 1 Overview & goals | PM / both | What we are building and why |
| 2 Component breakdown | both | The boundaries everyone codes against |
| 3 File/folder structure | both | Exact files to create |
| 4 API contract | Backend (FE consumes) | Every endpoint |
| 5 Agent design | Backend | SDK wiring, tools, prompt, auth, streaming |
| 6 Data-flow diagrams | both | How a request moves end to end |
| 7 Responsive/mobile UX | Frontend | Layout per device, QR onboarding |
| 8 Error handling & edge cases | both | Failure modes |
| 9 Security model | Backend (FE aware) | Token, path safety, bind scope |
| 10 Dependencies | Backend | Packages, pinning, where they live |
| 11 Build sequence | PM | Parallelizable plan of work |
| 12 Open questions / risks | PM | Decisions to make / watch |

---

## 1. Overview, Goals, Non-Goals

### 1.1 Overview

**video-use Studio** is a local, single-user, control-panel web app with an **embedded AI chat** that performs real video edits. It is a thin, beautiful UI shell over the already-installed `video-use` skill. The user points Studio at a folder of footage (on the desktop) or uploads clips from a phone, then converses with an embedded AI editor that drives the existing helper scripts (`transcribe`, `pack`, `timeline_view`, `grade`, `render`) exactly the way the `video-use` SKILL.md prescribes — including all 12 production-correctness hard rules. The user never leaves the browser.

The embedded AI is the **Claude Agent SDK** (Python, `claude-agent-sdk`), authenticated through the user's **Claude MAX subscription** via the local Claude Code login — NOT an API key. The helpers are exposed to the agent as in-process MCP tools.

### 1.2 Goals

1. One-double-click launch (`studio/start.bat`) that serves the app on localhost AND the LAN, prints a QR code + token, and opens the browser.
2. Desktop flow: select an existing folder on disk; inventory → transcribe → converse → edit → preview → iterate, all in the browser.
3. Phone flow: scan QR, authenticate via token in the deep-link, upload clips (chunked + resumable, with progress) into a folder on the PC, then run the same flow.
4. Faithful reproduction of the `video-use` editing methodology: the agent's system prompt is assembled from `SKILL.md`, so the 12 hard rules and the ask→confirm→execute→iterate loop are preserved.
5. High design quality. No generic AI aesthetic. Custom typography, intentional palette, considered spacing, subtle motion. Mobile-first responsive.
6. Live feedback: assistant text streams token-by-token; tool calls show start/finish; long renders/transcriptions show real progress; finished previews play inline.
7. Keep the repo clean: Studio code lives only under `studio/`; all editing artifacts continue to land in `<footage>/edit/` (Hard Rule 12).

### 1.3 Non-Goals (explicit YAGNI for v1)

- No multi-project management dashboard. One active footage folder at a time (switchable, but no library/CRUD of projects).
- No accounts / user management / cloud. One shared access token.
- No internet tunnel / remote access. **LAN only.** Binding to `0.0.0.0` is for the home Wi-Fi, not the internet.
- No manual drag-to-trim timeline editor. **The chat does the editing.** Studio displays state and previews; it does not implement a non-linear editor UI.
- No modification of helpers, `SKILL.md`, `install.md`, or `.env`.
- No transcoding/upload format conversion server-side beyond what the helpers already do.

### 1.4 Acceptance criteria (user-facing)

- Run `start.bat` → browser opens to a working app; terminal shows localhost URL, LAN URL, token, and a scannable QR.
- Desktop: paste or browse to a footage folder → see clip inventory with durations → click "Transcribe" → watch progress → chat "make me a 60s cut" → agent asks questions, confirms, renders, and the preview plays.
- Phone: scan QR → app loads already authenticated → upload 3 clips with a progress bar → same chat flow.
- A render in progress shows live progress and does not freeze the chat.
- Killing/restarting the server and reloading the page restores the selected folder and the chat transcript for that folder.

---

## 2. Component Breakdown

Five components with hard boundaries. Each is understandable on its own.

```
┌───────────────────────────────────────────────────────────────────────┐
│                          BROWSER (buildless SPA)                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │  Chat    │ │ Control  │ │ Preview  │ │ Upload   │ │ Responsive   │  │
│  │  (SSE)   │ │  Panel   │ │  Player  │ │ (chunk)  │ │ shell/drawer │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└───────────────┬───────────────────────────────────────────────────────┘
                │  HTTP + SSE   (X-Studio-Token on every request)
┌───────────────▼───────────────────────────────────────────────────────┐
│                       BACKEND  (FastAPI / uvicorn)                      │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ HTTP layer: routers (status, fs, inventory, transcribe, chat,    │  │
│  │   transcripts, preview/files, upload, outputs) + auth middleware  │  │
│  └───────────────┬──────────────────────────────┬──────────────────┘  │
│                  │                               │                      │
│  ┌───────────────▼──────────────┐  ┌────────────▼──────────────────┐  │
│  │  AGENT MODULE                │  │  HELPER-WRAPPER LAYER          │  │
│  │  - Claude Agent SDK client   │  │  - subprocess runners for     │  │
│  │  - SKILL.md → system prompt  │──┼─▶  transcribe_batch/pack/      │  │
│  │  - @tool MCP server          │  │    timeline/grade/render      │  │
│  │  - streaming → SSE relay     │  │  - stdout parsing → progress  │  │
│  │  - subscription auth (env)   │  │  - path/edit-dir resolution   │  │
│  └──────────────────────────────┘  └────────────┬──────────────────┘  │
│  ┌──────────────────────────────┐               │                      │
│  │  STATE / SESSION STORE       │               │                      │
│  │  - active folder, sessions   │               │                      │
│  │  - job registry + progress   │               │                      │
│  │  - upload session registry   │               │                      │
│  └──────────────────────────────┘               │                      │
│  ┌──────────────────────────────┐               │                      │
│  │  NETWORKING / LAUNCHER       │               ▼                      │
│  │  - bind 0.0.0.0, LAN IP      │      ┌──────────────────┐            │
│  │  - QR + token print          │      │  EXISTING helpers │            │
│  │  - firewall hint             │      │  + ffmpeg + Scribe│            │
│  └──────────────────────────────┘      └──────────────────┘            │
└───────────────────────────────────────────────────────────────────────┘
```

### 2.1 Backend app (FastAPI)

**Owns:** HTTP routing, auth middleware, request validation, SSE plumbing, static file serving of the SPA, safe serving of media previews, the in-memory state store, and the job/upload registries. It does NOT contain ffmpeg/agent logic directly — it delegates to the wrapper layer and agent module.

**Boundary:** routers call into `agent/` and `helpers_wrap/` and `core/` services; routers never shell out or import helper modules directly.

### 2.2 Agent module (`studio/app/agent/`)

**Owns:** the Claude Agent SDK lifecycle, the in-process MCP server that exposes the helper tools, the assembly of the system prompt from `SKILL.md`, the environment hygiene that guarantees subscription auth, and the translation of SDK streaming events into Studio SSE events. It depends on the helper-wrapper layer for the actual subprocess work (tools call wrappers; wrappers run ffmpeg/Scribe).

**Boundary:** the agent module is the ONLY place that imports `claude_agent_sdk`. The HTTP layer talks to it through an `AgentSession` facade (`send(text) -> async iterator of events`).

### 2.3 Helper-wrapper layer (`studio/app/helpers_wrap/`)

**Owns:** turning each helper into a callable Python function with a clean signature, resolving absolute paths and the correct `--edit-dir`, launching subprocesses with timeouts, capturing/parsing stdout for progress, and returning structured results (success/error + key output paths). This is the single integration seam with the unmodified `helpers/` directory.

**Boundary:** it imports nothing from the agent; it knows about subprocess, path validation, and the job/progress store. Both the agent's tools AND plain REST endpoints (e.g. the "Transcribe" button) call this layer, so the wrapper logic exists exactly once.

### 2.4 Networking / launcher (`studio/start.bat`, `studio/start.sh`, `studio/app/net.py`)

**Owns:** ensuring deps, generating/loading the token, computing the LAN IP, rendering the terminal QR, printing the firewall command, starting uvicorn on `0.0.0.0`, and opening the browser to the localhost URL.

**Boundary:** pure process/network concerns; imports nothing from agent or helpers.

### 2.5 Frontend SPA (`studio/app/web/`)

**Owns:** the entire UI — chat-first responsive shell, control panel/drawer, preview player, upload widget, folder picker. Buildless: a few hand-authored ES modules + one CSS file + `index.html`. No npm, no bundler. It is a pure consumer of the API contract in §4.

**Boundary:** the only thing it knows about the backend is the API contract and the token. It holds no secrets beyond the token (which it stores in `localStorage`/`sessionStorage` after onboarding).

---

## 3. File / Folder Structure

Everything under `studio/`. One-line purpose each. **No app code is scaffolded by this document** — this is the target layout for the engineers.

```
studio/
├── ARCHITECTURE.md              # this document
├── README.md                    # run instructions, firewall command, troubleshooting
├── start.bat                    # Windows launcher: deps → uvicorn 0.0.0.0 → QR/token → open browser
├── start.sh                     # POSIX launcher (parity for completeness)
├── requirements.txt             # studio-only Python deps (pinned); see §10 for pyproject alternative
├── .gitignore                   # ignore studio/.runtime/, __pycache__, *.pyc
├── config.example.toml          # optional config template (host/port/roots/max-upload)
│
├── app/
│   ├── __init__.py
│   ├── main.py                  # FastAPI app factory, middleware mount, static mount, router includes
│   ├── settings.py              # resolves repo root, helpers dir, allowed roots, port, token, limits
│   ├── net.py                   # LAN IP detection, QR rendering, URL/token banner, firewall hint string
│   ├── security.py              # token check dependency, path-traversal-safe resolver, upload validators
│   │
│   ├── core/
│   │   ├── __init__.py
│   │   ├── state.py             # in-memory app state: active folder, per-folder chat session map
│   │   ├── jobs.py              # JobRegistry: job id, status, progress %, log tail, result, cancel
│   │   ├── uploads.py           # UploadRegistry: upload id, chunk bitmap, temp assembly, finalize
│   │   ├── events.py            # SSE event dataclasses + serializer (assistant_delta, tool_start, ...)
│   │   └── persist.py           # tiny JSON persistence of active folder + chat transcript per folder
│   │
│   ├── helpers_wrap/
│   │   ├── __init__.py
│   │   ├── runner.py            # subprocess launcher: cwd=helpers dir, env hygiene, timeout, stdout pump
│   │   ├── progress.py          # stdout line → progress %/phase parser (ffmpeg time=, [transcribing] etc.)
│   │   ├── transcribe.py        # wrap transcribe_batch.py (+ single) → job; per-file progress
│   │   ├── pack.py              # wrap pack_transcripts.py → takes_packed.md
│   │   ├── timeline.py          # wrap timeline_view.py → verify/*.png
│   │   ├── grade.py             # wrap grade.py (analyze/list-presets/apply)
│   │   ├── render.py            # wrap render.py → preview/final mp4; progress via ffmpeg stderr time=
│   │   └── inventory.py         # ffprobe each source → clip list (name, dur, w/h, fps, portrait flag)
│   │
│   ├── agent/
│   │   ├── __init__.py
│   │   ├── session.py           # AgentSession facade: lifecycle, send(text)->async events, cancel
│   │   ├── tools.py             # @tool defs + create_sdk_mcp_server; maps tools → helpers_wrap
│   │   ├── prompt.py            # assemble system prompt from SKILL.md + Studio operating addendum
│   │   ├── env.py               # guarantees ANTHROPIC_API_KEY unset for the SDK; subscription auth
│   │   └── relay.py             # SDK partial-message/tool events → Studio SSE events
│   │
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── status.py            # GET /api/status (ffmpeg, key, agent-auth, active folder)
│   │   ├── fs.py                # GET /api/fs/roots, /api/fs/browse, POST /api/fs/select, /api/fs/mkdir
│   │   ├── inventory.py         # GET /api/inventory
│   │   ├── transcribe.py        # POST /api/transcribe (start job), GET /api/transcribe/{job}/events (SSE)
│   │   ├── transcripts.py       # GET /api/transcripts, GET /api/transcripts/{stem}, GET /api/packed
│   │   ├── chat.py              # POST /api/chat (SSE stream), POST /api/chat/cancel, GET /api/chat/history
│   │   ├── files.py             # GET /api/file?path=... (safe media/PNG serving with range support)
│   │   ├── outputs.py           # GET /api/outputs (edit/ listing: preview.mp4, final.mp4, edl, srt, verify)
│   │   └── upload.py            # POST /api/upload/init, PUT /api/upload/{id}/chunk, POST /api/upload/{id}/complete, GET status, DELETE
│   │
│   └── web/                     # buildless SPA (served as static)
│       ├── index.html           # single page; semantic landmarks; module script entry
│       ├── styles.css           # one stylesheet: tokens, layout, responsive, motion (no framework)
│       ├── app.js               # bootstrap: token onboarding, router-less view wiring, status poll
│       ├── api.js               # fetch wrapper (injects token), SSE helpers, error normalization
│       ├── chat.js              # chat view: send, render deltas, tool-call chips, transcript memory
│       ├── panel.js             # control panel: folder picker, inventory, transcribe button, outputs
│       ├── preview.js           # preview player + verify PNG lightbox + range-served media
│       ├── upload.js            # chunked/resumable uploader with progress + retry
│       ├── drawer.js            # responsive drawer/sheet behavior + focus trap
│       ├── qr.js                # (desktop only, optional) renders QR in-page as a fallback to terminal
│       └── assets/
│           ├── fonts/           # self-hosted display + text faces (NOT Inter) — woff2
│           └── icons.svg        # sprite of UI icons
│
└── .runtime/                    # gitignored; created at runtime
    ├── token                    # persisted access token (chmod-restricted on POSIX)
    ├── state.json               # active folder + settings snapshot
    ├── sessions/<folder-hash>.json   # persisted chat transcript per footage folder
    └── uploads/<upload-id>/     # in-flight chunk parts before finalize
```

Notes:
- `.runtime/` keeps all Studio-generated state out of the repo tree and out of the footage `edit/` dirs. Editing artifacts still go to `<footage>/edit/` via the helpers (Hard Rule 12 preserved).
- The SPA is intentionally a handful of small ES modules, no build step.

---

## 4. API Contract

Conventions:
- Base path: `/api`. SPA served at `/`.
- **Auth:** every `/api/*` request requires the token. Sent as header `X-Studio-Token: <token>` for fetch calls, OR as `?token=<token>` query param for `<video>`/`<img>`/EventSource requests that cannot set headers. Missing/wrong → `401`.
- All non-stream responses are JSON. Errors: `{ "error": { "code": "<machine>", "message": "<human>", "detail": <optional> } }` with appropriate HTTP status.
- SSE endpoints return `text/event-stream`; each event is `event: <type>\ndata: <json>\n\n`.
- `path` inputs are validated against allowed roots (§9). Traversal → `400 path_outside_roots`.

### 4.1 Status & health

**`GET /api/status`** — auth required.
Response:
```json
{
  "ffmpeg": { "ok": true, "version": "8.1.1" },
  "ffprobe": { "ok": true },
  "elevenlabs_key": { "present": true, "source": "repo_root_env" },
  "agent_auth": { "ok": true, "mode": "subscription", "detail": "claude code login detected" },
  "active_folder": "C:\\Users\\samgl\\Videos\\shoot1",
  "allowed_roots": ["C:\\Users\\samgl\\Videos", "C:\\Users\\samgl\\Documents\\GitHub\\VideoEditing\\studio\\.runtime\\uploads"],
  "version": "studio 0.1.0"
}
```
- `agent_auth.ok` is determined by a lightweight probe (see §5.4). `key.present` checks the resolution order Scribe uses (repo-root `.env` → `./.env` → env), without exposing the key value.

### 4.2 Filesystem (folder selection + browse)

**`GET /api/fs/roots`** — list the configured allowed roots (drive-ish entry points). Returns `{ "roots": [{ "path": "...", "label": "Videos" }] }`.

**`GET /api/fs/browse?path=<dir>`** — server-side folder browser. Lists immediate subdirectories and a count of video files in `path`. `path` must resolve inside an allowed root.
```json
{ "path": "C:\\Users\\samgl\\Videos",
  "parent": "C:\\Users\\samgl",
  "dirs": [{ "name": "shoot1", "path": "...", "video_count": 6 }],
  "video_files": 0 }
```

**`POST /api/fs/select`** — set the active footage folder. Body `{ "path": "<dir>" }`. Validates existence + root membership, ensures `<dir>/edit/` is creatable, persists to state. Response: `{ "active_folder": "...", "edit_dir": "...\\edit" }`.

**`POST /api/fs/mkdir`** — create a destination folder for phone uploads. Body `{ "parent": "<allowed dir>", "name": "<safe name>" }`. Name validated (no separators, no `..`). Response: `{ "path": "..." }`.

### 4.3 Inventory & clips

**`GET /api/inventory`** — ffprobe the active folder's sources.
```json
{ "folder": "...",
  "clips": [
    { "name": "C0103.MP4", "path": "...", "duration_s": 43.0,
      "width": 1920, "height": 1080, "fps": 24.0, "portrait": false,
      "has_transcript": true, "size_bytes": 734003200 }
  ],
  "total_duration_s": 312.4, "count": 6 }
```
- `409 no_active_folder` if none selected. Cached per folder + mtime; recomputed when files change.

### 4.4 Transcription (job + progress SSE)

**`POST /api/transcribe`** — start a batch transcription job over the active folder (or a subset).
Body (all optional): `{ "files": ["C0103.MP4"], "workers": 4, "language": null, "num_speakers": null, "pack": true }`.
Response `202`: `{ "job_id": "trx_8f2a", "files": 6, "already_cached": 2 }`.
- Wraps `transcribe_batch.py`; `pack=true` runs `pack_transcripts.py` after. Cached files are skipped (Hard Rule 9 — never re-transcribe).

**`GET /api/transcribe/{job_id}/events`** — **SSE**. Streams progress until done.
Events:
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

**`GET /api/transcribe/{job_id}`** — non-stream snapshot for reconnect: `{ status, done, total, percent, error? }`.

### 4.5 Transcripts

**`GET /api/transcripts`** — list available cached transcripts: `{ "transcripts": [{ "stem": "C0103", "words": 412, "duration_s": 43.0 }] }`.

**`GET /api/transcripts/{stem}`** — raw Scribe JSON for one source (read-only).

**`GET /api/packed`** — the `takes_packed.md` content (text). `404 not_packed` if absent.

### 4.6 Chat (the agent — SSE)

**`POST /api/chat`** — send a user message; **response is `text/event-stream`** (the request opens an SSE stream that lives for the duration of the agent turn). The browser uses `fetch()` with a streaming reader (EventSource cannot POST) OR a GET fallback (see note).
Body: `{ "message": "make a 60s cut, warm grade, bold subtitles", "folder": "<active>" }`.
Stream events (this is the core UX surface):
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
- `tool_progress` is the bridge from the long-tool progress mechanism (§5.5) into the chat UI.
- Note on transport: chat is **POST `/api/chat` only**, using a streamed `fetch()` body reader (works in all modern browsers, carries a JSON body). Authentication is the httpOnly `studio_session` cookie, which the browser sends automatically on the streamed request — there is **no token in the URL** and no `GET /api/chat/stream` variant. (An earlier design floated a GET SSE fallback with `?token=...`; it was not shipped.)

**`POST /api/chat/cancel`** — body `{ "turn_id": "t_19" }`. Interrupts the current agent turn (and signals running tools to stop where safe). Response `{ "cancelled": true }`.

**`GET /api/chat/history?folder=<active>`** — returns persisted transcript for the folder so a reload restores the conversation: `{ "messages": [{ "role": "user|assistant", "content": "...", "tool_calls": [...] }] }`.

### 4.7 Files / preview serving

**`GET /api/file?path=<abs path>`** — safely serve a media/image file from inside the active `edit/` dir (or allowed roots). Supports HTTP **Range** (needed for video scrubbing). Content-Type sniffed from extension; only an allowlist of types served (`.mp4`, `.mov`(as mp4 container)→served, `.png`, `.jpg`, `.srt`, `.json`, `.md`). Path validated against roots; symlinks resolved and re-checked. `403` otherwise.
- Used by the preview player (`/api/file?path=...\edit\preview.mp4&token=...`) and the verify-PNG lightbox.

### 4.8 Outputs (edit/ listing)

**`GET /api/outputs`** — what exists in the active `edit/`:
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

### 4.9 Upload (chunked + resumable)

Three-phase protocol. Target = a folder created/selected via §4.2.

**`POST /api/upload/init`** — body:
```json
{ "dest_folder": "...allowed dir...",
  "filename": "IMG_4421.MOV", "size_bytes": 2147483648,
  "chunk_size": 8388608, "content_type": "video/quicktime",
  "client_id": "optional-uuid-for-resume" }
```
Validates: extension in video allowlist, `size_bytes <= MAX_UPLOAD` (default 8 GiB, configurable), dest inside allowed root, filename sanitized. Response:
```json
{ "upload_id": "up_3c1d", "chunk_size": 8388608, "total_chunks": 256, "received": [] }
```
- `received` lets a reconnecting client skip chunks it already sent (resumable).

**`PUT /api/upload/{upload_id}/chunk?index=<n>`** — body is the raw bytes of chunk `n` (octet-stream). Optional `Content-Range` / `X-Chunk-Sha256` for integrity. Writes to `.runtime/uploads/<id>/<n>.part`. Response: `{ "index": n, "received": [0,1,...,n], "bytes_received": 1234 }`. Idempotent: re-PUTting a received index is a no-op success.

**`GET /api/upload/{upload_id}/status`** — `{ "received": [...], "missing": [...], "total_chunks": 256, "complete": false }` (for resume after a dropped connection).

**`POST /api/upload/{upload_id}/complete`** — assembles parts in order into `<dest_folder>/<sanitized filename>`, verifies total size (and optional whole-file hash), fsyncs, removes the part dir. Response: `{ "ok": true, "path": "...", "size_bytes": 2147483648 }`. `409 incomplete` if chunks missing.

**`DELETE /api/upload/{upload_id}`** — abort: delete parts. Response `{ "ok": true }`.

---

## 5. Agent Design

### 5.1 SDK client & session

The agent lives behind `AgentSession` (`agent/session.py`). One session per active footage folder (so each folder keeps conversation continuity); sessions are created lazily and cached in `core/state.py`. A session wraps the `claude-agent-sdk` client configured with:

- `system_prompt`: assembled in `agent/prompt.py` (see §5.3).
- `mcp_servers`: the in-process server from `agent/tools.py` (`create_sdk_mcp_server(name="studio", tools=[...])`).
- `allowed_tools`: the `mcp__studio__*` names plus read-only built-ins the agent needs to inspect outputs (file read of `edit/` artifacts) — but NOT arbitrary shell, to keep the surface tight.
- `include_partial_messages=True`: enables token-delta streaming (§5.6).
- `cwd`/working context: the active footage folder, so relative `edit/` paths resolve there.
- `permission_mode`: auto-approve the Studio MCP tools (they are the sanctioned actions); deny everything else by default.

`AgentSession.send(text)` returns an **async iterator of Studio SSE event objects**; the chat router simply forwards them. `AgentSession.cancel(turn_id)` interrupts the SDK turn.

### 5.2 Tool list (exact signatures → helper mapping)

Each tool is defined with the `@tool` decorator and registered in `create_sdk_mcp_server`. Tool names surface to the model as `mcp__studio__<name>`. Every tool **catches all exceptions and returns `{"content":[...], "is_error": true}`** on failure (an uncaught exception kills the SDK loop — see §8). Tools call the helper-wrapper layer; they never shell out directly.

| Tool (`mcp__studio__…`) | Signature (args the model passes) | Maps to helper + flags |
|---|---|---|
| `inventory` | `{}` | `helpers_wrap.inventory` (ffprobe over active folder) → clip list JSON |
| `transcribe_batch` | `{ "files"?: [str], "workers"?: int=4, "language"?: str, "num_speakers"?: int }` | `transcribe_batch.py <folder> --edit-dir <edit> [--workers --language --num-speakers]`; cached files skipped |
| `pack_transcripts` | `{}` | `pack_transcripts.py --edit-dir <edit>` → `takes_packed.md` (returns its text/path) |
| `read_packed` | `{}` | reads `<edit>/takes_packed.md` (the agent's primary reading view) |
| `timeline_view` | `{ "source": str, "start": float, "end": float }` | `timeline_view.py <source-abs> <start> <end>` → `verify/*.png`; returns the PNG path (and the image content so the model can SEE it) |
| `grade` | `{ "input": str, "output": str, "preset"?: str, "filter"?: str, "analyze"?: bool, "list_presets"?: bool, "print_preset"?: str }` | `grade.py <in> -o <out> [--filter / --analyze / --list-presets / --print-preset]` |
| `write_edl` | `{ "edl": <object> }` | validates against the EDL schema, writes `<edit>/edl.json` (the agent authors the EDL; this persists it) |
| `read_edl` | `{}` | reads `<edit>/edl.json` |
| `render` | `{ "preview"?: bool=false, "draft"?: bool, "build_subtitles"?: bool, "no_subtitles"?: bool, "no_loudnorm"?: bool, "output"?: str }` | `render.py <edit>/edl.json -o <out> [--preview --draft --build-subtitles --no-subtitles --no-loudnorm]`; emits live progress |
| `read_text` | `{ "path": str }` | safe read of an `edit/` artifact (project.md, master.srt, transcript json) — root-checked |
| `write_project_note` | `{ "markdown": str }` | append a session block to `<edit>/project.md` (memory; SKILL.md §Memory) |

Notes:
- `timeline_view` returns the PNG **as image content** in the tool result so the model can visually verify cuts/grade (the self-eval loop in SKILL.md step 7 depends on the model seeing rendered output).
- `write_edl` exists because in the CLI skill the model writes `edl.json` by hand; in Studio we give it a validating tool so malformed EDLs are caught before `render.py` runs. The schema mirrors SKILL.md's EDL format exactly (version, sources, ranges[], grade, overlays[], subtitles, total_duration_s).
- Animation generation (HyperFrames/Remotion/Manim/PIL) is **out of scope for v1 automated tooling** but the agent may still reference existing rendered overlay files via the EDL `overlays` array; see Open Questions §12.

### 5.3 System prompt assembly (from SKILL.md)

`agent/prompt.py` builds the prompt at session start:

1. **Read `SKILL.md`** from the repo root (path resolved via `settings.py`, relative to the studio package → repo root). Strip the YAML frontmatter; keep the full body (Principle, the 12 Hard Rules, process, cut craft, EDL format, anti-patterns).
2. **Prepend a Studio operating addendum** that re-grounds the skill for the web context:
   - "You are the editor inside video-use Studio. You drive the tools `mcp__studio__*` instead of running shell commands. The footage folder is `<active>`; all outputs go to `<active>/edit/` (Hard Rule 12)."
   - Map each SKILL.md helper reference to its Studio tool (e.g. "where SKILL.md says run `render.py`, call `mcp__studio__render`").
   - "Multiple-animation parallel sub-agents (Hard Rule 10) are NOT available in v1 Studio; if animations are needed, tell the user how you'd build them and proceed with overlays only if pre-rendered files exist." (Records the one capability gap.)
   - Re-state the ask→confirm→execute→iterate loop and that the **strategy must be confirmed in chat before editing** (Hard Rule 11).
   - Tell it to use `timeline_view` for the self-eval pass on the rendered output (SKILL.md step 7), capped at 3 passes.
3. **Append live context**: current inventory summary and whether transcripts/packed exist, so the model starts grounded without a wasted tool call.

The 12 Hard Rules pass through verbatim — `render.py` already enforces the mechanical ones (subtitles last, 30ms fades, per-segment extract, PTS shift, loudnorm, and the shipped `SUB_FORCE_STYLE` which in the actual source is `MarginV=90`, a platform safe-zone value — NOT the `MarginV=35` shown in SKILL.md prose; the code is authoritative), so the prompt's job is the editorial rules (word-boundary cuts, padding, caching, confirm-before-edit, outputs location).

### 5.4 Subscription auth (env hygiene) — CRITICAL

The Agent SDK authenticates via the local Claude Code login **only if `ANTHROPIC_API_KEY` is unset**. If present, it silently switches to pay-as-you-go billing. Therefore:

- `agent/env.py` builds the environment for the SDK client and **explicitly removes `ANTHROPIC_API_KEY`** (and `ANTHROPIC_AUTH_TOKEN`) from the process env the SDK sees. The SDK client is constructed with this sanitized env.
- The launcher (`start.bat`) does NOT set `ANTHROPIC_API_KEY`. The README warns the user not to set it globally; if it is set in the user's environment, `env.py` strips it for the agent subprocess specifically.
- Note: `ELEVENLABS_API_KEY` is untouched — Scribe reads it directly from `.env` inside `transcribe.py`, so the agent never needs it in env.
- **Auth probe (`agent_auth` in /api/status):** a cheap, bounded check at startup — attempt a minimal SDK turn (or the SDK's auth/whoami path if available) with a short timeout; classify result as `subscription` ok / `would_bill_api_key` (ANTHROPIC_API_KEY detected) / `not_logged_in` / `unknown`. Surface this to the UI so the user fixes login before chatting. (Exact probe mechanism is an Open Question — §12 — pending the SDK's supported introspection.)

### 5.5 Long-tool progress mechanism

The SDK has no intra-tool progress. We bridge it with a **job registry + stdout tailing**:

1. A long tool (`render`, `transcribe_batch`) creates a `Job` in `core/jobs.py` and launches the helper via `helpers_wrap/runner.py` with `stdout`/`stderr` piped (line-buffered).
2. `helpers_wrap/progress.py` parses each line:
   - **render**: `render.py`'s `run()` echoes each ffmpeg command as `  $ ffmpeg …` (confirmed in source) and runs it with `subprocess.run(check=True)`; ffmpeg itself prints `frame=… time=00:00:12.34 …` to stderr. We parse `time=` against the known segment/total duration → percent; phase from which `$ ffmpeg` command is running (extract N/total, concat, overlay, subtitles, loudnorm pass 1/2). NOTE: `render.py` uses `check=True`, so a failed ffmpeg raises `CalledProcessError` and the script exits non-zero — the runner must capture the stderr tail for the `is_error` tool result.
   - **transcribe**: `transcribe.py` prints `[transcribing] <name>`, `[done] <name>`, `[cached] <name>` per file. We count completed files / total → percent and current filename.
3. The tool, while the subprocess runs, **does not block the event loop**: it `await`s the subprocess and the job updates a thread-safe progress field.
4. Two consumers read job progress:
   - The **chat SSE** stream emits `tool_progress` events by polling the job's progress field between SDK events (the relay merges them).
   - The **REST transcribe SSE** (`/api/transcribe/{job}/events`) reads the same registry for the non-chat "Transcribe" button.
5. Subprocess **timeouts** are set generously (transcribe 600s/file like the helper; render scales with EDL duration, e.g. base 600s + k·duration) and surfaced as `is_error` tool results, never crashes.

This gives a single progress source feeding both the chat tool-chip and the panel's job UI.

### 5.6 Streaming + tool events → UI

`agent/relay.py` consumes the SDK stream (`include_partial_messages=True`) and maps:

| SDK signal | Studio SSE event |
|---|---|
| turn begins | `turn_start` |
| assistant text delta (partial message) | `assistant_delta` |
| tool use begins | `tool_start` (with a short `input_summary`) |
| (out-of-band) job progress for that tool | `tool_progress` |
| tool result message | `tool_end` (ok + summary + artifact paths) |
| turn completes | `turn_end` (stop_reason) |
| exception / auth failure | `error` |

The chat router pipes these straight to `text/event-stream`. The frontend renders deltas into the live assistant bubble and tool events as expandable "tool chips" with a progress bar.

---

## 6. Data-Flow Diagrams

### 6.1 Desktop edit flow

```
User                  Browser SPA            Backend                 Agent/Helpers
 │  open start.bat ───────────────────────────► uvicorn 0.0.0.0, print URL+QR+token
 │  browser opens (localhost?token=…)
 │                     GET /api/status ─────────► ffmpeg/key/auth probe ──► {ok}
 │  paste/browse folder
 │                     GET /api/fs/browse ──────► list dirs (root-checked)
 │  click "Use this folder"
 │                     POST /api/fs/select ─────► set active, ensure edit/ ──► {edit_dir}
 │                     GET /api/inventory ───────► ffprobe sources ──► clips[]
 │  click "Transcribe"
 │                     POST /api/transcribe ─────► Job + transcribe_batch.py ─┐
 │                     GET …/events (SSE) ◄───────── progress/file_done/done ◄┘ (cached skipped)
 │                                                  then pack_transcripts.py → takes_packed.md
 │  chat: "60s cut, warm grade, bold subs"
 │                     POST /api/chat (SSE) ──────► AgentSession.send()
 │                          ◄ assistant_delta (asks clarifying Qs)            [Hard Rule 11]
 │  answers / confirms strategy
 │                          ◄ tool_start read_packed / timeline_view (sees PNGs)
 │                          ◄ tool_start write_edl  (validates EDL)
 │                          ◄ tool_start render(preview=true) + tool_progress%  [progress §5.5]
 │                          ◄ tool_start timeline_view on OUTPUT (self-eval, ≤3) [SKILL step 7]
 │                          ◄ tool_end + assistant_delta "preview ready"
 │  preview plays
 │                     GET /api/file?path=…/edit/preview.mp4 (Range) ──► bytes
 │  "tighten the intro"  → another /api/chat turn → re-render → preview
 │  "ship it"            → render(preview=false) → final.mp4 ; write_project_note
```

### 6.2 Phone upload → edit flow

```
Phone                 Phone Browser          Backend
 │ scan QR (terminal) → opens http://<LAN-IP>:<port>/?token=<token>
 │                     app.js stores token (sessionStorage), GET /api/status ──► ok
 │ tap "Upload from phone"
 │                     POST /api/fs/mkdir {parent, name:"phone_shoot"} ──► dest path
 │ pick clips (camera roll)
 │  for each file:
 │                     POST /api/upload/init {dest, name, size, chunk} ──► upload_id, total_chunks, received[]
 │   slice file into chunks:
 │                     PUT  /api/upload/{id}/chunk?index=k  (bytes) ──► received[] (progress bar)
 │   (Wi-Fi drops) → GET /api/upload/{id}/status → resume missing chunks
 │                     POST /api/upload/{id}/complete ──► assemble → dest/<file>  (verify size)
 │ when all uploaded:
 │                     POST /api/fs/select {path: dest} ──► active folder
 │                     GET /api/inventory ──► clips[]   (then same chat/edit flow as 6.1)
```

### 6.3 Render-with-live-preview flow (zoom on the long tool)

```
Agent turn                 render tool (mcp__studio__render)        Job/Helper
 │ model calls render ──────► create Job(job_id), status=running
 │                            runner.py: subprocess(python render.py edl.json
 │                                       -o edit/preview.mp4 --preview),
 │                                       cwd=helpers dir, env w/o ANTHROPIC_API_KEY,
 │                                       stdout/stderr piped
 │                            progress.py parses:
 │                              "  $ ffmpeg … (extract 3/7)"  → phase
 │                              ffmpeg stderr "time=00:00:18" → percent vs total
 │   (meanwhile)              Job.progress updated continuously
 │                                          ▲
 │ chat SSE relay polls Job ─────────────────┘ emits tool_progress {percent,phase}
 │                            subprocess exits 0 → result {ok, output, duration}
 │ tool result (is_error=false) ◄───────────  Job.status=done
 │ model: timeline_view on preview.mp4 (self-eval) → sees frames/waveform PNG
 │ model: assistant_delta "Preview ready (87.4s). Issues? "
 │ Browser plays GET /api/file?path=…/preview.mp4 (Range)
 (on failure: subprocess !=0 or timeout → tool returns is_error=true with stderr tail;
  model reports the problem instead of crashing the loop)
```

---

## 7. Responsive / Mobile UX Plan

### 7.1 Breakpoints

- **Phone** `< 640px`: single column, chat-first. Control panel is a slide-in **drawer** (bottom sheet for actions, left sheet for folder/inventory). Preview is a phone-sized inline player above the chat or in a collapsible card.
- **Tablet** `640–1024px`: two-pane — chat + a collapsible side panel. Preview docks top of the panel.
- **Desktop** `> 1024px`: three-pane layout — left control panel (folder, inventory, outputs, jobs), center chat, right preview/verify. No drawer; everything visible.

### 7.2 Layout per form factor

```
PHONE (<640)                 DESKTOP (>1024)
┌───────────────┐           ┌───────┬───────────────┬───────────┐
│ top bar  ☰    │           │ PANEL │     CHAT       │  PREVIEW  │
│ (folder, status)          │ folder│  messages…     │  player   │
├───────────────┤           │ clips │  tool chips    │  verify   │
│  preview card │           │ jobs  │                │  outputs  │
│  (collapsible)│           │ outputs                │           │
├───────────────┤           │       │                │           │
│   chat        │           │       │  composer ▢    │           │
│   messages    │           └───────┴───────────────┴───────────┘
│   tool chips  │           ☰ opens nothing (panel already shown)
├───────────────┤
│  composer  ▢  │   drawer (from ☰): folder picker, inventory,
└───────────────┘   transcribe, upload, outputs, jobs
```

- Drawer (`drawer.js`): focus-trapped, ESC/overlay-tap to close, `aria-modal`, body scroll lock. Subtle 180–220ms transform/opacity transition (GPU-friendly), respects `prefers-reduced-motion`.
- Composer is sticky to the bottom (accounts for mobile keyboard via `dvh` units / `visualViewport`).
- Preview player: native `<video controls playsinline>` with Range-served source; verify PNGs open in a swipeable lightbox.

### 7.3 QR / token onboarding (phone)

1. `start.bat` prints to terminal: localhost URL, `LAN URL: http://<IP>:<port>/?token=<token>`, the **token**, and a **QR encoding that exact deep link** (token embedded).
2. User scans QR with the phone camera → opens the deep link → `app.js` reads `?token=` from the URL, stores it in `sessionStorage`, then **strips it from the visible URL** (`history.replaceState`) so it isn't left in the address bar.
3. All subsequent API calls attach the token (header for fetch, query for media/SSE).
4. If the token is missing/invalid, the SPA shows a minimal "enter access token" screen (the token is also printed in the terminal for manual entry). No QR scanner is required in-app; the OS camera handles scanning. (`qr.js` can render an in-page QR on desktop as a convenience to hand off to the phone, but the terminal QR is the primary path.)

### 7.4 Design language (anti-generic)

- **Typography:** self-hosted faces, NOT Inter. Proposed: a characterful grotesque/transitional display face for headings + a comfortable mono or humanist sans for body and timecodes (timecodes in mono read as "editing tool"). Concrete pairing to be finalized by `pm-frontend` via the `ui-ux-pro-max`/`frontend-design` skill.
- **Color:** intentional, single accent + neutral ink scale; dark-first (editors live in the dark), NO purple gradient. A warm accent echoing the video-use launch palette (e.g. a considered orange `#FF5A00`-family) reads as on-brand, on a near-black `(10,10,10)` ground — but the FE engineer makes the final taste call.
- **Spacing/motion:** generous whitespace, an explicit spacing scale, micro-motion only (tool chips, drawer, message-in). No 3-equal-card hero grid.
- **Accessibility:** semantic landmarks, labeled controls, keyboard-operable chat and drawer, visible focus, AA contrast.

---

## 8. Error Handling & Edge Cases

| Case | Detection | Behavior |
|---|---|---|
| **ffmpeg/ffprobe missing** | startup probe + `/api/status` | Status shows `ffmpeg.ok=false`; render/timeline/inventory tools return `is_error` with a clear message; UI shows a banner with the fix (install ffmpeg / PATH). |
| **ELEVENLABS_API_KEY missing** | resolver checks repo `.env`→`./.env`→env | `status.elevenlabs_key.present=false`; transcribe job fails fast with `key_missing`; UI prompts user to add it to repo-root `.env` (never to footage dir). |
| **Key invalid (401 from Scribe)** | `transcribe.py` exits non-zero, stderr captured | Job emits `error: elevenlabs_401`; partial cached files retained; user re-enters key. |
| **Not logged into Claude Code (agent auth fails)** | auth probe at startup + on first chat | `status.agent_auth.ok=false`; chat composer disabled with message "Run `claude` once to log in, or you're not on a MAX subscription"; never silently falls back to API billing. |
| **ANTHROPIC_API_KEY present in env** | `agent/env.py` detects + strips for agent | Agent still uses subscription; `/api/status` notes `would_bill_api_key=stripped`. |
| **Tool raises** | wrapper try/except | Returns `{is_error:true}` — never an uncaught exception (which would kill the SDK loop). |
| **Tool timeout** | subprocess timeout in runner | Kill process tree, return `is_error` with "timed out after Ns"; job marked failed; chat shows it. |
| **render fails (bad EDL / source missing)** | non-zero exit, stderr tail | `tool_end ok=false` with stderr tail; `write_edl` validation catches most malformed EDLs before render. |
| **Huge upload** | `size_bytes > MAX_UPLOAD` at init | `413 upload_too_large`; configurable cap (default 8 GiB). |
| **Interrupted upload** | client reconnect → `GET status` | Server lists `missing` chunks; client re-PUTs only those; `complete` verifies total size. |
| **Disk full during assemble/render** | OSError on write | Surface `insufficient_storage`; clean partial parts; job failed. |
| **Bad folder path / traversal** | `security.resolve_in_roots()` | `400 path_outside_roots`; logged; nothing read/written. |
| **No clips found** | inventory empty | UI: "No video files here" + extensions accepted; chat tool returns empty inventory; agent asks user to point elsewhere or upload. |
| **Portrait vs landscape mix** | inventory `portrait` flag per clip | Surfaced to agent + UI; `render.py` already does portrait-aware scaling; agent warns if mixing aspect ratios would letterbox. |
| **Concurrent jobs** | JobRegistry single-flight per type | Only one render and one transcribe per folder at a time; a second request returns `409 job_in_flight` with the running job_id; UI shows the active job instead of starting another. (Transcription's own 4 workers handle file-level parallelism.) |
| **Two browsers / phone + desktop at once** | shared server state | Last folder selection wins; chat is per-folder so both see the same transcript; SSE is per-connection. Acceptable for single-user. |
| **SSE connection drop mid-turn** | client detects close | Reconnect to `/api/chat/history` to recover finished messages; in-flight delta may be lost — turn result still persisted server-side. |
| **Reload during render** | job persists in registry | Reconnecting UI re-attaches to the running job's progress via the job snapshot endpoint. |
| **Cache hit on transcribe** | `transcribe.py` prints `[cached]` | Counted as `already_cached`; never re-transcribes (Hard Rule 9). |

---

## 9. Security Model

This is a single-user tool on a trusted home LAN. Security is **proportionate**: enough to prevent accidental exposure and path escapes, not a full auth system.

### 9.1 Access token

- A high-entropy token (≥ 128-bit, URL-safe) generated on first run, persisted to `studio/.runtime/token` (restricted perms on POSIX). Stable across restarts so QR links keep working; regenerable via a flag.
- **Required on every `/api/*` request** — header `X-Studio-Token` or `?token=` (for media/SSE that can't set headers). Constant-time compare. Missing/wrong → `401`.
- Embedded in the QR deep link; the SPA strips it from the visible URL after capture and stores in `sessionStorage`.
- The SPA itself (`/`, static assets) is served WITHOUT the token (so the page can load and then prompt/capture the token); only `/api/*` is gated.

### 9.2 Path-traversal defenses

- Single helper `security.resolve_in_roots(user_path, roots)`: `os.path.realpath` the candidate, then verify it is within one of the configured **allowed roots** using a normalized prefix check (and on Windows, case-insensitive, drive-aware). Symlinks resolved BEFORE the check.
- Allowed roots (config): the user's chosen footage parent(s) + `studio/.runtime/uploads`. The repo dir and `helpers/`/`.env` are NOT in the roots → the file-serving and browse endpoints cannot read them.
- Applies to: `/api/fs/browse`, `/api/fs/select`, `/api/fs/mkdir`, `/api/file`, all upload endpoints, and every tool that takes a path.
- Filenames for upload/mkdir are sanitized (reject separators, `..`, reserved Windows names like `CON`/`NUL`, control chars).

### 9.3 Bind scope

- uvicorn binds `0.0.0.0` so the phone can reach it on the LAN — this is intentional and required. It is **NOT** exposed to the internet (no tunnel, no port forward by us). README is explicit: this is a home-network tool.
- The user opens the Windows firewall port themselves; README/launcher prints the exact inbound rule, e.g.:
  ```
  netsh advfirewall firewall add rule name="video-use Studio" dir=in action=allow protocol=TCP localport=<PORT>
  ```

### 9.4 Upload validation

- Extension allowlist MUST mirror the helper's `VIDEO_EXTS` exactly so uploads are then discoverable by `find_videos()`: `.mp4 .mov .mkv .avi .m4v` (incl. uppercase variants `.MP4 .MOV .MKV .AVI`). Do NOT add extensions the helper won't pick up (e.g. `.webm`) or transcription/inventory will silently skip them. Content-type checked but extension is authoritative.
- Size cap per file (`MAX_UPLOAD`, default 8 GiB) checked at `init` and enforced again at `complete`.
- Chunks written to a per-upload temp dir; assembly only on `complete` after all indices present; optional per-chunk and whole-file hash verification.
- Total disk guard: refuse `init` if free space < declared size.

### 9.5 Media serving

- `/api/file` serves only from allowed roots, only allowlisted extensions, with correct Content-Type and Range support; never directory listing; never executes anything.

### 9.6 Agent surface

- The agent's `allowed_tools` is restricted to `mcp__studio__*` plus read of `edit/` artifacts; no arbitrary shell/Bash tool is granted. Tools themselves only operate within the active folder / `edit/` dir.
- `ANTHROPIC_API_KEY` stripped from the agent env (billing safety, §5.4).

### 9.7 Intentionally NOT protected (and why acceptable)

- **No per-user accounts / RBAC** — single user.
- **No TLS** — LAN-only, trusted network; HTTPS on localhost/LAN adds cert friction with little benefit here. (Token still required.)
- **No CSRF tokens** — there are no cookies/ambient auth; the token must be explicitly supplied, so cross-site form posts can't carry it.
- **No rate limiting** — single user; the only expensive operations are single-flighted jobs anyway.
- **No audit log** beyond `project.md` and server logs.

These omissions are appropriate for a single-user home-LAN tool and are documented so the reviewer doesn't flag them as gaps.

---

## 10. Dependencies

### 10.1 New Python packages (backend)

| Package | Why | Pin guidance |
|---|---|---|
| `fastapi` | web framework | pin to a recent minor, e.g. `~=0.115` |
| `uvicorn[standard]` | ASGI server (0.0.0.0 bind) | `~=0.32` |
| `claude-agent-sdk` | the embedded AI agent | pin to a known-good version after a smoke test (see §12 risk) |
| `python-multipart` | multipart parsing (uploads) | `~=0.0.12` |
| `qrcode` | terminal/in-page QR (ASCII to terminal; optional PNG) | `~=8.0` (pure-python; avoids `Pillow`-only path — `Pillow` already present for PNG if wanted) |
| `anyio` | structured concurrency for SSE + subprocess (FastAPI dep, used explicitly) | follow FastAPI's range |

Already present in the repo's `pyproject.toml` and reused as-is: `requests`, `librosa`, `matplotlib`, `pillow`, `numpy` (the helpers' deps). `ffmpeg`/`ffprobe` from PATH (Gyan 8.1.1). Python 3.14.

No `aiofiles` strictly required (we can use thread-pool file IO for chunk assembly), but it's an acceptable optional add if the engineer prefers — keep the list minimal.

### 10.2 Where they live — DECISION

Add a **new optional-dependencies extra** to the existing `pyproject.toml`:
```toml
[project.optional-dependencies]
animations = ["manim"]            # existing
studio = ["fastapi", "uvicorn[standard]", "claude-agent-sdk",
          "python-multipart", "qrcode"]   # new
```
- Rationale: keeps a single source of truth, installs cleanly with `pip install -e ".[studio]"` from the repo root, and does NOT burden the base skill install. This is a one-line addition to an existing file — the PM should note it as the single permitted modification outside `studio/` (it does not touch helpers/SKILL/.env).
- **Belt-and-suspenders:** also ship `studio/requirements.txt` mirroring the extra, so `start.bat` can `pip install -r studio/requirements.txt` without depending on the editable-install state. (Engineers pick one as the launcher's install step; both documented.)

> If the PM prefers zero changes to `pyproject.toml`, fall back to `studio/requirements.txt` only. Recorded as Open Question §12.

### 10.3 Frontend

- **No node, no build step.** Vanilla ES modules + one CSS file + self-hosted woff2 fonts. No CDN at runtime (LAN may be offline-ish); fonts and any QR-in-page lib are vendored locally. Zero npm dependencies.

---

## 11. Build Sequence (for the PM to turn into a Feature Plan)

Ordered, dependency-aware. **[BE]** = Backend Engineer, **[FE]** = Frontend Engineer, **[∥]** = parallelizable.

**Phase 0 — Scaffold & contracts (do first, unblocks everything)**
1. [BE] `settings.py`, `main.py`, `security.py` (token + path resolver), `/api/status`. Decide port/roots/limits. `DOCUMENT.md` in each new dir.
2. [BE] Freeze the API contract (this doc §4) as the shared interface. [FE] can mock against it immediately.
3. [BE+FE ∥] `requirements.txt` / `pyproject.toml [studio]` extra + a stub `start.bat` that boots uvicorn and prints URL/token/QR (`net.py`).

**Phase 1 — Helper-wrapper layer + filesystem (BE) ∥ SPA shell (FE)**
4. [BE] `helpers_wrap/runner.py`, `inventory.py`, `fs` router (browse/select/mkdir), `outputs.py`. (No agent yet.)
5. [BE] `transcribe` wrapper + job registry + `/api/transcribe` + SSE progress; `pack`; `transcripts`/`packed` routers.
6. [FE ∥] SPA shell: `index.html`, `styles.css` (design tokens, responsive, drawer), `app.js` (token onboarding from `?token=`), `api.js`, `panel.js` (folder picker + inventory + transcribe button wired to real endpoints), status banner. Use `ui-ux-pro-max`/`frontend-design` for the look.

**Phase 2 — Agent (BE) ∥ Preview + transcripts UI (FE)**
7. [BE] `agent/env.py` (strip key), `agent/prompt.py` (SKILL.md assembly), `agent/tools.py` (the tool table §5.2), `agent/session.py`, `agent/relay.py`, `/api/chat` SSE + cancel + history. Wire `tool_progress` to the job registry (§5.5).
8. [FE ∥] `chat.js` (deltas, tool chips, progress bars), `preview.js` (Range video + verify lightbox), transcripts/packed viewer in panel.

**Phase 3 — Upload (mobile) — BE then FE**
9. [BE] upload router (init/chunk/status/complete/abort) + `uploads.py` registry + validators.
10. [FE] `upload.js` chunked/resumable uploader with progress + retry; mobile QR onboarding polish; drawer/sheet finalization.

**Phase 4 — Launcher, polish, hardening (both)**
11. [BE] finalize `start.bat`/`start.sh` (deps check, QR, firewall hint, open browser), persistence (`persist.py`), auth probe wording.
12. [FE] responsive pass across breakpoints, reduced-motion, a11y, empty/error states, dark theme polish.
13. [both] README (run, firewall command, troubleshooting, "don't set ANTHROPIC_API_KEY").

**Critical path:** 1→2→(4,6 ∥)→(5,7,8 ∥)→(9→10)→11/12/13.
**Best early parallelism:** after step 2, FE builds the whole shell against the frozen contract while BE builds wrappers and the agent.

Hand-off to PM workflow: each phase → QA Inspector → App Tester → Code Reviewer before context update.

---

## 12. Open Questions / Risks

**Risks to watch (P1):**
1. **Agent-SDK subscription auth assumption.** The whole "free via MAX" premise rests on `claude-agent-sdk` honoring the local Claude Code login when `ANTHROPIC_API_KEY` is unset. This is stated as verified in the brief, but it MUST be smoke-tested on this exact machine in Phase 0/2 before building the chat UI. Mitigation: the auth probe + `/api/status` surfaces a clear failure rather than silently billing.
2. **Auth-probe mechanism.** There may be no cheap "whoami" in the SDK; the probe might require a minimal real turn (small token cost on subscription). Decide the lightest reliable probe during Phase 2. If none is cheap, probe lazily on first chat instead of at startup.
3. **Python 3.14 compatibility.** `fastapi`/`uvicorn`/`python-multipart`/`qrcode`/`claude-agent-sdk` must all install and run on Python 3.14 (very new). Some may lag wheels. Mitigation in Phase 0: `pip install -e ".[studio]"` smoke test; if a package is incompatible, pin a compatible version or (worst case) run Studio under a 3.12/3.13 venv while helpers stay on 3.14 — the helpers are invoked as subprocesses, so the Studio interpreter and the helper interpreter need not be identical. PM decision if this arises.
4. **Chunked-upload reliability over Wi-Fi for multi-GB files.** Resumable design mitigates drops; still validate with a real >2 GB phone upload on the actual LAN. Watch: mobile Safari/Chrome memory when slicing huge `File` objects (slice lazily per chunk, never read whole file). Confirm `complete` assembly time/disk for 8 GiB.

**Decisions for the PM / user:**
5. **`pyproject.toml [studio]` extra vs `requirements.txt` only.** Recommendation: add the extra (one line, doesn't touch helpers/SKILL/.env). Confirm this counts as an allowed modification, or fall back to requirements-only.
6. **Default port.** Recommend a memorable, rarely-used high port (e.g. `8420`). PM/user to confirm before the firewall command is baked into README.
7. **MAX_UPLOAD default.** Recommend 8 GiB; confirm vs typical phone clip sizes.
8. **Allowed roots default.** Recommend the user's `Videos`/`Movies` folder + `.runtime/uploads`. Should the user configure this in `config.toml` on first run, or should Studio prompt? Recommend a first-run prompt that writes `config.toml`.
9. **Animations in scope?** v1 exposes overlays only if pre-rendered files exist; full HyperFrames/Remotion/Manim/PIL sub-agent generation (SKILL.md Hard Rule 10 parallel sub-agents) is deferred. Confirm this is acceptable for v1, or schedule it as v2.
10. **Token persistence vs rotation.** Recommend persist-and-reuse (stable QR). Confirm the user is fine with a long-lived token on the LAN (regenerate flag provided).
11. **Concurrency policy.** Recommend single-flight per job type per folder (one render, one transcribe at a time). Confirm that matches the user's expectation vs allowing queued jobs.

**Capability gap noted (not a blocker):** Hard Rule 10 (parallel animation sub-agents) cannot be reproduced inside the single Agent SDK session in v1; the system prompt explicitly tells the agent this and to proceed with overlays only when pre-rendered. All other 11 hard rules are preserved (the mechanical ones by `render.py`, the editorial ones by the SKILL.md-derived prompt).
