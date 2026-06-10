# studio/app/helpers_wrap/ — DOCUMENT

## What this is
The single integration seam with the repo's unmodified `helpers/`. Each helper
becomes a clean async function: resolve paths + the right `--edit-dir`, launch the
subprocess with a timeout, parse stdout/stderr for progress, return a structured
result. BOTH the agent tools AND the REST endpoints call this layer, so the logic
exists exactly once.

## Status — IMPLEMENTED
- `runner.py` — async subprocess launcher. Runs `python <helpers>/<script>.py`
  with `cwd=helpers/` (so `transcribe_batch`→`transcribe` and `render`→`grade`
  sibling imports resolve) and `PYTHONPATH` seeded with the helpers dir. Streams
  stdout+stderr line-by-line to a callback, enforces a timeout, supports
  cooperative cancel (kills the process tree via `taskkill /T` on Windows).
  **Never raises** for a non-zero helper exit — returns `RunResult` with the
  captured stderr tail. Also a sync `ffprobe_json()` for inventory.
- `progress.py` — `RenderProgress` (drives a monotonic percent primarily from the
  coarse `[NN]` segment markers across the 0–80 extraction band plus fixed
  `concat`/`compositing`/`loudnorm` checkpoints, refined by ffmpeg `time=` when
  visible — see BUG-13) and `TranscribeProgress` (parses `found N videos
  (… cached, … to transcribe)` and `+ <stem>` / `x <stem> FAILED`).
- `inventory.py` — `find_videos` (mirrors the helper's VIDEO_EXTS) + ffprobe each
  source → clip list (name, duration, w/h, fps, portrait, size, has_transcript),
  cached per (folder, signature). The signature covers BOTH the source videos
  (name:size:mtime) AND the state of `edit/transcripts/` (json count + newest
  `st_mtime_ns` + total bytes via `_transcripts_signature`) — see the 2026-06-10
  fix below.
- `transcribe.py` — drives `transcribe_batch.py` as a Job + optional `pack`;
  per-file progress; classifies `elevenlabs_401`/timeout/failed.
- `pack.py` — drives `pack_transcripts.py`; `read_packed()`.
- `timeline.py` — drives `timeline_view.py` → `verify/*.png`.
- `grade.py` — drives `grade.py` (list/print/analyze/apply).
- `render.py` — drives `render.py` as a Job; estimates output duration from the
  EDL for percent; classifies render_failed/timeout.

## Constraints honored
- Imports nothing from `agent/`.
- `render.py` uses `subprocess.run(check=True)` internally → a failed ffmpeg
  exits non-zero; `runner` captures the stderr tail for the tool's `is_error`.
- Generous timeouts: transcribe `600 + 600/file`; render `600 + 30·EDL-seconds`.
- `ELEVENLABS_API_KEY` is left in the env (the helper reads it from `.env`).

## Bug fixes (2026-06-08)
- **runner.py — helper UTF-8 file I/O (BUG-01, P1 runtime, STUDIO-SIDE):**
  `_build_env()` now sets `env["PYTHONUTF8"] = "1"`. Python 3.14 is not UTF-8-mode
  by default and this Windows host's locale is cp1252, so the helpers'
  `read_text`/`write_text`/`open` defaulted to cp1252 and crashed on non-ASCII
  subtitle/EDL/JSON I/O (master-SRT `UnicodeEncodeError`, EDL `UnicodeDecodeError`
  → generic `render_failed`). `PYTHONIOENCODING` only covered stdio; `PYTHONUTF8`
  puts the **child** interpreter in UTF-8 mode for all default file I/O. `run()`
  is the single subprocess seam, so this covers render/transcribe/pack/timeline/
  grade alike. No `helpers/*.py` edits (skill scope boundary preserved).
- **runner.py — ffprobe cp1252 decode (BUG-12, P2 runtime):** `ffprobe_json` ran
  `subprocess.run(..., text=True)` with no `encoding`, so the **parent** decoded
  ffprobe's UTF-8 JSON via cp1252 → `UnicodeDecodeError` on non-ASCII container
  metadata tags, which was uncaught and 500'd `/api/inventory` (one bad file
  aborted the whole inventory; same class as commit 196d7e9). Note `PYTHONUTF8`
  does NOT help here — the failing decode is in the parent. Fixed by
  `subprocess.run(..., encoding="utf-8", errors="replace", ...)` and widening the
  except to `(subprocess.TimeoutExpired, ValueError, OSError)` so it returns None.
- **progress.py — render progress stuck at 0 (BUG-13, P2 functional):**
  `RenderProgress` derived percent entirely from `parse_ffmpeg_time()`, but
  `render.py` captures its own ffmpeg stderr (and passes `-nostats`), so no
  `time=` line reaches the wrapper and the bar sat at 0 until completion. The
  parser now also feeds coarse percents from the `[NN]` segment markers
  (`seg_index/n_segments * 80`) and fixed checkpoints on concat (82) /
  compositing (85) / loudnorm (90/94). All signals (segment-derived, phase
  checkpoints, and time=-when-visible) feed one `max()` through the existing
  monotonic clamp, so the bar visibly advances and never regresses. Misleading
  module docstring corrected. No `helpers/render.py` edits.

## Bug fixes (2026-06-10, live-test defects)
- **inventory.py — stale `has_transcript` until restart (P1, tester-confirmed):**
  `_folder_signature()` hashed only the source videos (name:size:mtime), so
  writing transcript JSONs never invalidated the inventory cache —
  `/api/inventory` kept returning `has_transcript:false` after a transcribe job
  completed until a server restart or a video change (clip badges + the journey
  stepper never advanced). Fixed signature-side (option (a) of the brief, chosen
  over an explicit cache-bust on the job-completion path because it is
  self-healing for EVERY transcript producer — the REST transcribe job AND the
  agent writing transcripts mid-chat via its tools): the signature now appends
  `_transcripts_signature(edit/transcripts/)` = `t:<json count>:<newest
  st_mtime_ns>:<total bytes>`. Adding, rewriting (mtime_ns, so even same-second),
  or DELETING a transcript busts the entry; a missing/unreadable dir degrades to
  the empty state (`t:0:0:0`), never raises. The cache itself is KEPT (it exists
  to avoid re-ffprobing every poll) and the signature stays cheap — one
  `iterdir` + `stat` per transcript json, NO ffprobe on the signature path.
  Verified: `has_transcript` flips true on the very next `/api/inventory` call
  after the json appears (no restart), flips back on removal, and an unchanged
  folder is still a cache hit (same cached object returned).
