# studio2/relay/ — the Studio v2 brain relay

FastAPI service carrying **identity (cookies), transport security (TLS), the
agent conversation (Step 3), the device-tool bridge (Step 3), and
transcription (M2)**. It never sees video bytes, device file paths, or the EDL
except as tool-result JSON passing through to the model (arch §1.4).

**The ONE media exception (M2, arch §8.1):** `POST /api/transcribe` accepts a
clip's audio-only `.m4a` as a RAW streamed body — the deliberate, consented,
size-capped exception to "media never reaches the relay". It is still **no
multipart parsing**: the inbound route reads `request.stream()` straight to a
job-named disk spool against a hard 256 MiB cap (no `UploadFile`/`Form`/`File`/
`request.form()`); `python-multipart` remains a non-direct dependency
(transitively present via `mcp`, never used to parse). The ElevenLabs multipart
is built OUTBOUND by `httpx` (the relay's only outbound-HTTP dependency) and
never parsed. The audio bytes are opaque (never decoded), live at most minutes
in the gitignored `.runtime/transcribe/` spool, and are deleted in `finally` on
every path. **Privacy (arch §8.6):** audio leaving the device is the
architecture's one byte-leaves-device exception — consented per clip, in plain
words, on the device's confirm sheet ("the clip's audio, not the video, is sent
to ElevenLabs"); ElevenLabs is a third-party processor; the relay holds the
transcript in memory only until the device polls it once (+120 s grace) then
forgets. The **ElevenLabs key never reaches the browser** (EL's CORS is `*`, so
a browser COULD call EL — which is exactly why the key stays home) and is never
logged, echoed, or surfaced by `/api/status`. There is still no `/api/file`
streaming and no server-side sessions/projects — the rest of the kill list
(arch §1.2) stays dead.

## Files

| File | Purpose |
|---|---|
| `app/` | The Python package (see `app/DOCUMENT.md`) |
| `requirements.txt` | Pinned deps: fastapi, uvicorn[standard], claude-agent-sdk (Step 3's runtime), cryptography, qrcode[pil], pillow, **httpx==0.28.1** (M2 — the relay's first & only OUTBOUND HTTP dep: async-native, streams the spool, builds the EL multipart natively; current stable verified at build 2026-06-14, already present transitively via the SDK's mcp). NOTHING else; `python-multipart` stays OFF the list. |
| `config.example.toml` | `[server]` host/port/tls/tls_port/ca_dir + `[users]` placeholders + **`[transcribe]`** (M2 — `enabled`/`api_key`/`model_id`/`language`/`diarize` + the cost caps; the real EL key goes ONLY in the gitignored `config.toml` or an env var, never the committed example). Copy to `config.toml` (gitignored) for real accounts/keys. |
| `start.bat` / `start.sh` | Native launchers: venv at `.venv` (Python 3.14) → pip install once → dependency self-check (incl. `cryptography` — BOTH scripts, closing v1's start.sh gap) → `python -m app.serve`. Never start with a bare uvicorn command line (loses the HTTPS listener + signal handling). |
| `open-firewall.ps1` | Idempotent inbound rules TCP 8520 + 8543 (rule names `video-use Studio2 <port>`, distinct from v1's). Run once as Administrator. |
| `.runtime/` | Runtime-created, gitignored: `session_secret`, `tls/leaf.{pem,key}` (v2's own leaf), `logs/studio2.log`, **`transcribe/*.m4a`** (M2 — transient per-job audio spool, deleted in `finally` + boot-swept). |
| `.venv/` | Local virtualenv (gitignored via the repo-wide `.venv/` rule). |

## Environment variables

| Var | Purpose |
|---|---|
| `STUDIO2_HOST` / `STUDIO2_PORT` / `STUDIO2_TLS` / `STUDIO2_TLS_PORT` | Override `[server]` values (defaults 0.0.0.0 / 8520 / on / 8543). |
| `STUDIO2_CA_DIR` | Where the SHARED v1 CA lives (default `<repo>/studio/.runtime/tls`). Read-only. |
| `STUDIO2_SECRET` | Cookie signing secret (else persisted to `.runtime/session_secret`, 0600 on POSIX). Independent of v1's secret by design. |
| `STUDIO2_USERNAME` / `STUDIO2_PASSWORD` | Optional single env account (test harnesses); real accounts go in `config.toml [users]`. |
| `ANTHROPIC_API_KEY` | NOT set on the native run path (MAX subscription mode — Step 3). |
| `STUDIO2_ELEVENLABS_API_KEY` / `ELEVENLABS_API_KEY` | M2 — the ElevenLabs Scribe key (env wins over `config.toml [transcribe] api_key`). Never logged/echoed/in-status. Absent ⇒ transcription returns 403 `transcribe_disabled`. |

## Build status

**Step 1 complete:** dual-listener boot, login/logout/me, /setup + /ca.crt +
/api/tls/info, /api/status, /api/client-log.

**Step 3 complete:** the device-tool bridge (`app/core/bridge.py` +
`app/routers/bridge.py` — command SSE stream with `Last-Event-ID` replay,
result POST with 512 KB cap, §3.5 error taxonomy, 8-devices/16-pending
caps), the turn-survival buffer (`app/core/turns.py` — detached turn task +
bounded ring, attach replay), chat endpoints (`app/routers/chat.py` —
`POST /api/chat`, `GET /api/chat/attach`, `POST /api/chat/cancel`), and the
agent runtime (`app/agent/` — 7 `mcp__studio2__*` tools, validation per
arch §8.3, MAX-subscription env per v1). `/api/status` now reports the real
`agent_auth` mode + `devices_connected` through the Step-1 lazy imports
(zero edits to that router). `config.toml` is additionally gitignored at the
repo root (real passwords must never be committable).

**M2 T1 complete (relay transcription service):** `app/core/transcribe.py` +
`app/routers/transcribe.py` (the 7th router) — `POST /api/transcribe` (raw
streamed body, 256 MiB cap enforced on the fly, 202 + detached EL job),
`GET /api/transcribe/{job_id}` (lock-proof poll → `transcribing`/`done`/`error`,
uniform 404, 120 s delivered-grace + 30-min TTL), `DELETE /api/transcribe/
{job_id}` (best-effort cancel). ElevenLabs Scribe call via httpx (key home,
no auto-retry); response normalized to the arch §4.2 transcript schema
(`words[] {w,s,e,c?}`, `audio_events[]`, `language_code`+probability,
source-clip times). Per-user concurrency (1) + per-process daily caps (24 calls
/ 1 GiB) + master switch. `/api/status` gains the `transcribe` gate block.
Verified against a fake EL upstream: full 202→poll→done lifecycle + the entire
error taxonomy (400/401/403/409/413/429/499 + `provider_*`/timeout/cancel/
restart-404), streamed-413 early rejection proven over a real socket, ownership
(anti-IDOR) enforced, key absent from every log line. (T3 — the agent tools —
and the PWA half are separate lanes.)

**M3 Step 4 complete (relay render-tier tools + prompt):** the agent surface
grows from 9 to **15** `mcp__studio2__*` tools — the 6 new render-tier tools
(`set_output_format`, `set_clip_fit`, `list_music_library`, `add_music`,
`update_music`, `remove_music`, arch §7.1) in `app/agent/tools.py`, plus
`prompt.py` §7 (output shape/combine) + §8 (music) — see `app/agent/
DOCUMENT.md`. **NO new relay media surface** (music stays on-device, mixed
locally; the M2 audio upload remains the only byte-leak — arch §9). Relay-side
param validation (ids/bounds/enums/even-dims-N-A-deferred/no-unknown-keys/
exactly-one-of) at two layers + device re-validate; `custom` dims deferred
(rejected with guidance, plan §0.3). Verified with a scripted fake device
(round-trip command params + result shapes per tool) AND a REAL subscription
turn (portrait + ducked library music; render/SDR tradeoff stated; tier
reported; never claimed export). The PWA `bridge.js` executors must match the
`app/agent/DOCUMENT.md` command-param and result shapes exactly.

**M3 render-tier flag (dormant-behind-a-flag deploy gate, 2026-06-14):** the
entire M3 render tier (the 6 tools above + the prompt §7/§8 sections + the
`core/bridge.py` allowlist entries) is now GATED behind `settings.render_enabled()`
— a new `[render] enabled` config key (env `STUDIO2_RENDER_ENABLED` wins),
**DEFAULT FALSE**. This lets the relay ship the already-built **Agent Vision
(`view_frames`) + M2** features (which need a restart to deploy) WITHOUT exposing
the M3 tools, whose **DEVICE executors (pwa/bridge.js) don't exist yet** — they
are dead at runtime and the prompt would make the agent OFFER format/music it
can't deliver. With the flag OFF the agent surface is the **9-tool** M2+vision+
base set, the prompt omits §7/§8 (renumbered contiguous 1–7), and the bridge
allowlist excludes the 6 M3 names — the agent has NO idea the render tier exists.
The earlier "PENDING follow-up" (the 6 names → `_BRIDGE_TOOLS`) is RESOLVED by
the same flag: `_bridge_tools()` admits them only when render is on, in lockstep
with the tool surface. Flip the flag ON (and ship the M3 frontend) to expose the
15-tool surface. Both states verified in-process: OFF → 9 tools / no §7-8 / M3
dispatch blocked; ON → 15 tools / §7-8 present / M3 dispatch round-trips. The
live relay stays flag-OFF on the next deploy (vision + M2 ship, M3 dormant).
