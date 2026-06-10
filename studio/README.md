# video-use Studio

A local, multi-user web app with an **embedded AI chat** that performs real
video edits. It is a thin, tasteful UI shell over the already-installed
`video-use` skill and its helper scripts (`transcribe`, `pack`, `timeline_view`,
`grade`, `render`). You point Studio at a folder of footage — or upload clips
from your phone — then converse with an AI editor that drives the helpers
exactly the way `SKILL.md` prescribes. You never leave the browser.

The embedded AI is the **Claude Agent SDK**. How it authenticates depends on how
you run Studio (see the two run paths below).

> **Status:** Studio v1 is complete and ready to run — a full conversational
> editor, not a scaffold. The flow is upload → inventory → transcribe →
> chat-driven edits → color grade → render → live preview. It pairs a FastAPI
> backend with a vanilla-JS SPA frontend and signs you in with a multi-user
> session cookie. See `ARCHITECTURE.md` (full design) and `API_CONTRACT.md`
> (frozen endpoint spec).

---

## Two ways to run

| | Native (`start.bat`) | Docker (`docker compose up`) |
|---|---|---|
| Agent auth | **Claude MAX** login (free with your subscription) | pay-as-you-go **`ANTHROPIC_API_KEY`** |
| ffmpeg | your native build (fast, GPU if available) | Debian apt build (CPU-only, **slower renders**) |
| Footage | any allowed folder on disk | must live under the **mounted** folder |
| Best for | day-to-day editing on this PC | sandboxed / headless runs |

### Native (recommended) — Claude MAX plan

Requires **Python 3.14** (via the `py -3.14` launcher) and **ffmpeg/ffprobe on
PATH** (Gyan 8.1.1 confirmed).

```bat
:: from the studio\ folder
start.bat
```

On launch it will:
1. Create `studio\.venv` (Python 3.14) and `pip install -r requirements.txt` on
   first run only (the download is **~90 MB+**; later launches skip it).
2. Detect your LAN IPv4 and print: the **localhost URL**, the **LAN URL**, and a
   scannable **QR code** of the LAN URL right in the terminal.
3. Open your default browser to the localhost URL.
4. Start the server bound to `0.0.0.0:8420`. As it starts, the server prints a
   **startup banner** showing the LAN URL and the **login credentials**
   (username + password) to sign in with.

You sign in from the browser: enter the username/password from the startup
banner (these come from the `[users]` table in your `studio\config.toml`). On a
successful login the server sets a signed, httpOnly `studio_session` cookie that
authenticates every subsequent request — there is **no token in the URL**.

It deliberately **does not set `ANTHROPIC_API_KEY`**, so the agent uses your
local Claude Code login (your MAX subscription). **Do not set
`ANTHROPIC_API_KEY` globally** if you want the native path to stay on the MAX
plan — if it is set, the agent module strips it for the agent specifically, but
keeping it unset is cleaner.

POSIX users: `bash start.sh` is the equivalent.

### Docker — API-key path

Set both keys in the **repo-root `.env`** first (this is the only place keys
live; it is gitignored):

```
ELEVENLABS_API_KEY=sk-...      # transcription
ANTHROPIC_API_KEY=sk-ant-...   # the agent, pay-as-you-go in this path
```

Then, from the `studio\` folder:

```bash
# point FOOTAGE_DIR at the host folder you want mounted (defaults to ../footage)
set FOOTAGE_DIR=C:\Users\you\Videos        &:: Windows cmd
docker compose up --build
```

Caveats for the Docker path:
- **CPU-only ffmpeg** — renders/transcodes are noticeably slower than native.
- **Footage must be under the mounted folder.** Inside the container the only
  allowed browse/read/write root is `/footage`, which maps to your
  `FOOTAGE_DIR`. Files outside it are invisible to Studio (by design — path
  safety, `ARCHITECTURE.md` §9).
- The agent uses your `ANTHROPIC_API_KEY` (billed) rather than the MAX plan.
- Set a login account before `docker compose up`: put `STUDIO_USERNAME` and
  `STUDIO_PASSWORD` in the repo-root `.env`, or mount a `config.toml` with a
  `[users]` table (see the commented volume in `docker-compose.yml`). If you set
  neither, the app generates an `admin` account and prints its one-time password
  to the container logs (`docker compose logs`). Auth is the same
  `studio_session` cookie as the native path — sign in from the browser.

---

## Reaching Studio from your phone

1. Make sure the phone is on the **same Wi-Fi** as this PC.
2. Open the firewall port once (see below).
3. **Scan the QR** printed in the terminal (or open the **LAN URL** manually).
   The QR points at the bare LAN URL — no token, no query string.
4. **Sign in** with the **username and password** shown in the server's startup
   banner (these are your `config.toml` `[users]` credentials).

On a successful login the server issues a signed, httpOnly `studio_session`
cookie. The browser sends it automatically on every request — page loads, API
calls, the chat SSE stream, and media — so you stay signed in for the session.
There is no access token to copy and nothing appended to the address bar.

---

## Firewall (one-time, elevated)

Studio binds `0.0.0.0` so phones on your Wi-Fi can reach it. Windows blocks
inbound connections by default, so open TCP **8420** once. From an **elevated
(Administrator)** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\open-firewall.ps1
```

That script is idempotent. The exact rule it adds (if you prefer to run it
directly in an elevated terminal):

```bat
netsh advfirewall firewall add rule name="video-use Studio 8420" dir=in action=allow protocol=TCP localport=8420
```

To remove it later:

```bat
netsh advfirewall firewall delete rule name="video-use Studio 8420"
```

> **LAN only.** `0.0.0.0` is for your home Wi-Fi, not the internet. Studio does
> not open any tunnel or port-forward. Do not forward 8420 on your router.

---

## Reference

- **Port:** `8420` (TCP). Change via `STUDIO_PORT`; update the firewall rule to match.
- **Upload cap:** **8 GiB** per file (configurable via `STUDIO_MAX_UPLOAD`).
- **Accepted video extensions:** `.mp4 .mov .mkv .avi .m4v` (and uppercase) —
  must match the helper's `VIDEO_EXTS` so uploads are discoverable.
- **Outputs:** all editing artifacts land in `<footage>/edit/` (Hard Rule 12);
  Studio's own runtime state lives in `studio/.runtime/` (gitignored).
- **Dependency footprint:** first install ~90 MB+ (`uvicorn[standard]`,
  `claude-agent-sdk`, `pillow` via `qrcode[pil]`). Pinned in `requirements.txt`.

### Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `ELEVENLABS_API_KEY` | repo-root `.env` | transcription (ElevenLabs Scribe) — both run paths |
| `ANTHROPIC_API_KEY` | repo-root `.env` | **Docker path only** — the agent (pay-as-you-go). Leave empty for native (MAX). |
| `STUDIO_USERNAME` / `STUDIO_PASSWORD` | optional (`config.toml` `[users]` preferred) | a single login account, merged in alongside any `[users]` accounts. Native run normally uses `config.toml` instead. |
| `STUDIO_SECRET` | optional | `studio_session` cookie signing key (HMAC-SHA256). If unset, persisted/generated under `studio/.runtime/`. |
| `STUDIO_HOST` | optional | bind host (default `0.0.0.0`) |
| `STUDIO_PORT` | optional | bind port (default `8420`) |
| `STUDIO_MAX_UPLOAD` | optional | per-file upload cap in bytes (default 8 GiB) |
| `STUDIO_ALLOWED_ROOTS` | optional / set in compose | folders Studio may browse (Docker: `/footage`) |

> **Login accounts** live in the gitignored `studio/config.toml` `[users]`
> table (one `username = "password"` line per account). The startup banner
> prints which credentials to sign in with. `config.example.toml` carries
> placeholders only — never put real passwords in any tracked file.

---

## Layout

See `ARCHITECTURE.md` for the full design and `API_CONTRACT.md` for the frozen
endpoint spec. Each subdirectory has a `DOCUMENT.md` describing what lives there.
