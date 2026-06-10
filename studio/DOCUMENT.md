# studio/ — DOCUMENT

## What this is
**video-use Studio** — a self-hosted, LAN-facing web app for editing video by
conversation: a FastAPI backend + a buildless vanilla-JS SPA with an embedded
Claude Agent SDK chat that drives the repo's `video-use` helpers (transcribe,
cut, grade, render, subtitles). Fully implemented and verified — this is a
working app, not a scaffold. Studio code lives only in this directory; the
repo-root helpers, `SKILL.md`, and `.env` are never modified by it.

## The app in one paragraph
**Multi-user session-cookie auth** (`POST /api/login` → signed httpOnly
`studio_session` cookie; accounts in the gitignored `config.toml` `[users]`
table; constant-time checks, no token-in-URL). Each user works in **per-user,
user-owned, upload-only sessions** stored under
`.runtime/users/<owner>/sessions/ses_<hex12>/` (videos + `transcript.json` +
`edit/` outputs); every editor request carries a `session_id`, resolved through
the ownership chokepoint in `app/core/sessions.py` (cross-user/bad ids → uniform
404). **29 routes** (28 API routes + the `/static` mount); chunked/resumable
uploads (8 GiB cap, `client_id` resume, collision-safe assemble, 499
`client_disconnected` contract); Range/206 media streaming with per-user
confinement (`?download=1` for save-as); SSE for chat/transcribe progress; the
agent runs via the Claude MAX subscription (native path — no API key) confined
to the per-user tree. The frontend is served at **`/static/*`** (from
`frontend/`) with `Cache-Control: no-cache`, and `GET /api/me` reports the
served frontend `asset_version` so stale tabs can self-detect.

## File structure (this directory)
```
studio/
├── app/                   # FastAPI backend package (see app/DOCUMENT.md)
├── frontend/              # buildless SPA, served at /static/* (see frontend/DOCUMENT.md)
├── config.toml            # ACTUAL config (gitignored): [users] accounts, [server], [limits]
├── config.example.toml    # committed template (placeholders only)
├── start.bat / start.sh   # NATIVE run path (the real deployment; subscription agent mode)
├── open-firewall.ps1      # one-time admin: inbound TCP 8420 rule
├── Dockerfile / docker-compose.yml  # OPTIONAL, unused path (API-key agent mode)
├── requirements.txt       # pinned deps (web + helper runtime deps for the venv)
├── ARCHITECTURE.md / API_CONTRACT.md  # STALE (pre-sessions) — pending a doc-reconciliation pass
├── README.md / DOCUMENT.md
└── .runtime/              # gitignored: session_secret, users/<owner>/sessions/…,
                           #   uploads/ (chunk staging; orphans GC'd at boot), migrated_v2
```

## Run paths
- **Native (ACTUAL):** `start.bat` → `studio/.venv` python → uvicorn on
  **0.0.0.0:8420**. No `ANTHROPIC_API_KEY` → the agent uses the local Claude
  Code MAX-subscription login. Interpreter invariant: the venv python that runs
  uvicorn is the same one `helpers_wrap/runner.py` uses to launch helpers;
  `start.bat` fails loud if the venv is corrupt or missing helper deps
  (`requests`, `numpy`, `matplotlib`, `PIL`, `librosa` — pinned in
  `requirements.txt`).
- **Docker (optional, unused):** API-key agent mode via `../.env`. Kept in the
  repo; not the deployment.

## Key invariants
- Auth: cookie only (httpOnly, SameSite=Lax); every `/api/*` route except
  login/logout/me is gated; credentials/secrets never logged.
- Ownership: session dirs resolve ONLY through `core/sessions.py` (owner match +
  id regex + realpath-inside-root); `/api/file` is additionally confined to the
  caller's own `users/<username>/` subtree.
- Agent confinement: `allowed_roots()` = `.runtime/users/` only; agent tool
  output/overlay paths are root-confined via `security.resolve_in_roots`.
- Helpers are wrapped (`app/helpers_wrap/`), never edited; `settings.VIDEO_EXTS`
  stays in lockstep with `helpers/transcribe_batch.py` (comparison is
  case-insensitive; the set content is the parity contract).
- Errors use the `{detail:{error:{code,…}}}` envelope; uploads keep the
  resumable 499 `client_disconnected` contract.
