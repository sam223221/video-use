# studio2/relay/app/ — the relay package

Adapted from v1 `studio/app/` (field-hardened patterns carried verbatim where
the arch doc says "verbatim"; v1 itself is byte-untouched). Entrypoint:
`python -m app.serve` with cwd = `studio2/relay/`.

## Files

| File | Purpose | Relation to v1 |
|---|---|---|
| `serve.py` | Dual `uvicorn.Server`s (HTTP :8520 lifespan-on, HTTPS :8543 lifespan-off) in ONE loop/process. `_QuietSignalServer` + a single process-wide SIGINT/SIGTERM/SIGBREAK handler stopping both; second Ctrl+C → `force_exit`. TLS failure → HTTP-only; TLS can never block boot. | v1 `serve.py` adapted (log line mentions the shared CA instead of `ca_regenerated`) |
| `main.py` | `create_app()` factory: 8 routers (Step 1: auth/status/client_log/tls; Step 3: bridge/chat; **M2: transcribe**; **model picker: agent** — `GET`/`POST /api/agent/model`, the 8th), `/static` → `../../pwa` via `_RevalidatingStaticFiles` (Cache-Control: no-cache), `GET /` → `pwa/index.html` (503 `pwa assets not deployed yet` while the parallel PWA build lands), **root-scope PWA aliases** `GET /sw.js` (`text/javascript`) + `GET /manifest.webmanifest` (`application/manifest+json`) — FileResponse from `pwa/`, explicit media types (no mimetypes guessing), `Cache-Control: no-cache`, same 503 partial-deploy guard as `/` (a SW served from `/static/` can never get root scope — Step-2 finding), `openapi_url=None`, lifespan = applog init + `.runtime` warmup + **transcribe spool boot-sweep** (M2, arch §7.3 — clears `*.m4a` a crashed process stranded; the in-memory job registry is intentionally NOT persisted) + banner ONLY (no migration/GC — none exist in v2). `_EffectiveBindLogger` one-shot middleware kept. | v1 `main.py` minus migration/GC/sweeps/sessions |
| `settings.py` | Paths/ports/limits/credentials. Ports 8520/8543; `CA_DIR` (env `STUDIO2_CA_DIR` → `[server] ca_dir` → default `<repo>/studio/.runtime/tls`, relative values resolve against the relay root); cookie names `studio2_session` / `__Host-studio2_session`; own `session_secret()` (`STUDIO2_SECRET` → `.runtime/session_secret`); `users()` (config `[users]` → `STUDIO2_USERNAME/PASSWORD` → generated admin); session TTLs (7d / 12h unremembered). **M2 `[transcribe]`**: `elevenlabs_api_key()` (env `STUDIO2_ELEVENLABS_API_KEY` → `ELEVENLABS_API_KEY` → config `[transcribe] api_key`; read lazily, NEVER logged/echoed/in-status), `transcribe_configured()` (master `enabled` switch AND a key present), model id (`scribe_v2` default — `core/transcribe.py` upgrades a legacy `scribe_v1` pin to v2 and honors other explicit pins), optional pinned `language` (empty = auto-detect, the mixed-language path), `diarize` (off), cost caps (`max_audio_mib`=256 hard byte cap, `max_duration_min`=180 soft, `daily_call_cap`=24, `daily_audio_mib_cap`=1024), and `TRANSCRIBE_SPOOL_DIR` under `.runtime`. **M3 `[render]`**: `render_enabled()` — the M3 render-tier feature flag, **DEFAULT FALSE** (env `STUDIO2_RENDER_ENABLED` wins → config `[render] enabled` → False). Read LAZILY (like `elevenlabs_api_key()`), never raises. While false, `agent/tools.py` does NOT register the 6 M3 render tools (surface stays 9 = M2+vision+base), `agent/prompt.py` OMITS its §7/§8 format+music sections, and `core/bridge.py`'s allowlist excludes the 6 M3 names — so the relay can deploy Agent Vision + M2 without exposing the not-yet-functional M3 tools. Flip on once the M3 device executors (pwa/bridge.js) ship. | v1 `settings.py` minus uploads/sessions/helpers/ffmpeg probes; + M2 `[transcribe]`; + M3 `[render]` flag |
| `net.py` | `lan_ip()`, `hostname_local()`, `firewall_hint()`, startup banner + terminal QR. The QR encodes the **http /setup URL** (arch §1.2). A configured-but-unavailable TLS prints the "run Studio v1 once or set STUDIO2_CA_DIR" instruction. NO HSTS anywhere. | trimmed v1 `net.py` |
| `security.py` | `issue_session`/`verify_session` (HMAC-SHA256, constant-time), `check_credentials` (multi-user, anti-enumeration dummy compare, empty-username rejection). | v1 verbatim, MINUS all path/filename code (the relay touches no media paths) |
| `core/` | applog / events / tls / bridge / turns / transcribe (M2) / **agent_model** (the global model-picker store — see `core/DOCUMENT.md`) | |
| `routers/` | deps / auth / tls / status / client_log / bridge / chat / transcribe (M2) / **agent** (`/api/agent/model` — see `routers/DOCUMENT.md`) | |
| `agent/` | session / tools / prompt / env — the Claude Agent SDK editor, Step 3 (`session.py` now applies the picker's `agent_model.resolve()` to `ClaudeAgentOptions.model` and rebuilds cached sessions on a model change — see `agent/DOCUMENT.md`) | |

## Decisions

- **Cookie names + secret are v2's own** (arch §8.2): cookies are
  host-scoped, not port-scoped — reusing v1's names would let each login
  clobber the other app's session.
- **`/api/status` stubs** agent_auth/bridge values through guarded lazy
  imports of the Step-3 modules, so Step 3 lands without touching the router
  (one-owner-per-file preserved).
- The `users()` env fallback uses `STUDIO2_*` names so v1's `STUDIO_*` env
  (if ever set) cannot leak accounts across stacks.
