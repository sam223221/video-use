# studio/ — DOCUMENT

## What this is
**video-use Studio** — a self-hosted, LAN-facing web app for editing video by
conversation: a FastAPI backend + a buildless vanilla-JS SPA with an embedded
Claude Agent SDK chat that drives the repo's `video-use` helpers (transcribe,
cut, grade, render, subtitles). Fully implemented and verified — this is a
working app, not a scaffold. Studio code lives only in this directory; the
repo-root helpers, `SKILL.md`, and `.env` are never modified by it. (One
explicitly authorized exception, 2026-06-11: `helpers/timeline_view.py` got a
minimal repo-level fix — duration probe + EOF clamp + ffmpeg stderr capture —
after a P1 timeline-tool bug; see `app/agent/DOCUMENT.md`. The helper remains
standalone-compatible and the never-edit discipline stays in force.)

## The app in one paragraph
**Multi-user session-cookie auth** (`POST /api/login` → signed httpOnly
`studio_session` cookie; accounts in the gitignored `config.toml` `[users]`
table; constant-time checks, no token-in-URL). Each user works in **per-user,
user-owned, upload-only sessions** stored under
`.runtime/users/<owner>/sessions/ses_<hex12>/` (videos + `transcript.json` +
`edit/` outputs); every editor request carries a `session_id`, resolved through
the ownership chokepoint in `app/core/sessions.py` (cross-user/bad ids → uniform
404). **33 routes** (32 API routes + the `/static` mount); chunked/resumable
uploads (8 GiB cap, `client_id` resume, collision-safe assemble, 499
`client_disconnected` contract); Range/206 media streaming with per-user
confinement (`?download=1` for save-as); SSE for chat/transcribe progress; the
agent runs via the Claude MAX subscription (native path — no API key) confined
to the per-user tree. The frontend is served at **`/static/*`** (from
`frontend/`) with `Cache-Control: no-cache`, and `GET /api/me` reports the
served frontend `asset_version` so stale tabs can self-detect.
**Secure Studio (2026-06-11):** the server also listens on **https://…:8443**
with an app-generated local CA + leaf cert (`.runtime/tls/`; `app/core/tls.py`)
so phones get a secure context (iOS Wake Lock → uploads survive a locked
screen). One-time phone trust via the login-free **`/setup`** page +
**`/ca.crt`**; https logins use a `__Host-studio_session` cookie; `STUDIO_TLS=0`
or any TLS failure falls back to HTTP-only without blocking boot.

## File structure (this directory)
```
studio/
├── app/                   # FastAPI backend package (see app/DOCUMENT.md)
├── frontend/              # buildless SPA, served at /static/* (see frontend/DOCUMENT.md)
├── config.toml            # ACTUAL config (gitignored): [users] accounts, [server], [limits]
├── config.example.toml    # committed template (placeholders only)
├── start.bat / start.sh   # NATIVE run path (the real deployment; subscription agent mode)
│                          #   2026-06-11: final line is now `python -m app.serve` (dual
│                          #   HTTP+HTTPS listener); the script-side LAN-IP/QR block was
│                          #   REMOVED — the in-process startup banner is the single source
├── open-firewall.ps1      # one-time admin: inbound TCP 8420 (http) + 8443 (https) rules
├── Dockerfile / docker-compose.yml  # OPTIONAL, unused path (API-key agent mode)
├── requirements.txt       # pinned deps (web + helper runtime deps for the venv;
│                          #   + cryptography==48.0.0 for Secure Studio certs)
├── ARCHITECTURE.md / API_CONTRACT.md  # STALE (pre-sessions) — pending a doc-reconciliation pass
├── README.md / DOCUMENT.md
└── .runtime/              # gitignored: session_secret, users/<owner>/sessions/…,
                           #   uploads/ (chunk staging; orphans GC'd at boot), migrated_v2,
                           #   tls/ (ca.pem/ca.key/leaf.pem/leaf.key — Secure Studio;
                           #   damaged CAs preserved as *.bad-<ts>)
```

## Run paths
- **Native (ACTUAL):** `start.bat` → `studio/.venv` python → **`python -m
  app.serve`** — TWO programmatic uvicorn servers in ONE process/loop: HTTP on
  **0.0.0.0:8420** (lifespan on; byte-identical to the old uvicorn line) +
  HTTPS on **0.0.0.0:8443** (`.runtime/tls/` certs; lifespan off). One Ctrl+C
  stops both. `STUDIO_TLS=0` / any TLS failure → HTTP-only, exactly like
  before. No `ANTHROPIC_API_KEY` → the agent uses the local Claude Code
  MAX-subscription login. Interpreter invariant: the venv python that runs
  the server is the same one `helpers_wrap/runner.py` uses to launch helpers;
  `start.bat` fails loud if the venv is corrupt or missing required deps
  (`requests`, `numpy`, `matplotlib`, `PIL`, `librosa`, `cryptography` — pinned
  in `requirements.txt`; `cryptography` is in the list because `app/core/tls.py`
  imports it at module level and BOTH entrypoints import `tls.py`, so a broken
  install would otherwise block ALL boot with a raw stack trace, even with
  `STUDIO_TLS=0`). `start.sh` has NO equivalent self-check (known gap). The
  legacy `python -m uvicorn app.main:app` entrypoint still works (HTTP-only;
  `/api/tls/info` still answers sanely).
- **Docker (optional, unused):** API-key agent mode via `../.env`. Kept in the
  repo; not the deployment.

## Key invariants
- Auth: cookie only (httpOnly, SameSite=Lax); every `/api/*` route except
  login/logout/me (+ the public `/ca.crt`, `/setup`, `/api/tls/info`) is
  gated; credentials/secrets never logged. Scheme-aware cookie names: https
  logins get `__Host-studio_session` (Secure/Path=/, no Domain), http logins
  keep `studio_session`; deps reads `__Host-` first; logout clears both.
  **NO HSTS** (deliberate — the http bootstrap origin must stay reachable).
- Ownership: session dirs resolve ONLY through `core/sessions.py` (owner match +
  id regex + realpath-inside-root); `/api/file` is additionally confined to the
  caller's own `users/<username>/` subtree.
- Agent confinement: `allowed_roots()` = `.runtime/users/` only; agent tool
  output/overlay paths are root-confined via `security.resolve_in_roots`.
- Helpers are wrapped (`app/helpers_wrap/`), never edited; `settings.VIDEO_EXTS`
  stays in lockstep with `helpers/transcribe_batch.py` (comparison is
  case-insensitive; the set content is the parity contract). Sole sanctioned
  exception to date: the 2026-06-11 authorized `helpers/timeline_view.py` fix
  (EOF clamp + stderr capture — a skill-layer bug, not a Studio behavior change).
- Errors use the `{detail:{error:{code,…}}}` envelope; uploads keep the
  resumable 499 `client_disconnected` contract.
- TLS (Secure Studio): private keys live only in `.runtime/tls/` (0600 POSIX),
  never logged, never served; the CA is STABLE across leaf regens (phones
  trust once — a DHCP IP change only re-issues the leaf); a damaged CA is
  preserved as `*.bad-<ts>` and regenerated LOUDLY; TLS can never block boot.
