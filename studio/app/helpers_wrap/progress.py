"""Parse helper stdout/stderr lines into progress signals (ARCHITECTURE.md §5.5).

Two long helpers emit parseable progress:

* **render.py** echoes its phase markers (``extracting N segment(s)`` / ``[NN]``
  / ``concat`` / ``compositing`` / ``loudnorm``) to the wrapper. In practice it
  captures ffmpeg's own stderr (and passes ``-nostats`` in places), so the
  ``frame=… time=00:00:12.34 …`` lines usually do NOT reach the wrapper — the
  percent is therefore driven primarily by the coarse ``[NN]`` segment markers
  (extraction across the 0–80 band) plus fixed checkpoints on the concat /
  compositing / loudnorm phases. When ffmpeg ``time=`` IS visible it refines the
  estimate; all signals feed one monotonic (never-decreasing) clamp.
* **transcribe_batch.py** prints ``found N videos (… cached, … to transcribe)``
  and one ``  + <stem>`` / ``  x <stem> FAILED`` line per completed/failed file.

Pure functions + a small stateful parser per job — no I/O here.
"""

from __future__ import annotations

import re

# ffmpeg progress line: "... time=00:00:12.34 ..." (also "time=12.34")
_TIME_RE = re.compile(r"time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)")
_TIME_SECS_RE = re.compile(r"time=(\d+(?:\.\d+)?)\b")

# render.py markers
_EXTRACT_RE = re.compile(r"extracting (\d+) segment")
_SEG_RE = re.compile(r"^\s*\[(\d+)\]")  # "  [03] C0108 ..."

# transcribe_batch.py markers
_FOUND_RE = re.compile(r"found (\d+) videos.*?\((\d+) cached,\s*(\d+) to transcribe\)")
_FILE_DONE_RE = re.compile(r"^\s*\+\s+(\S+)")
_FILE_FAIL_RE = re.compile(r"^\s*x\s+(\S+)\s+FAILED")


def parse_ffmpeg_time(line: str) -> float | None:
    """Return the ffmpeg ``time=`` value in seconds, or None if absent."""
    m = _TIME_RE.search(line)
    if m:
        h, mm, ss = int(m.group(1)), int(m.group(2)), float(m.group(3))
        return h * 3600 + mm * 60 + ss
    m2 = _TIME_SECS_RE.search(line)
    if m2:
        try:
            return float(m2.group(1))
        except ValueError:
            return None
    return None


class RenderProgress:
    """Stateful render-progress parser.

    Feed it stdout AND stderr lines via ``feed(line)``. It tracks the number of
    segments and the current phase, and derives a coarse overall percent driven
    primarily by the parsed ``[NN]`` segment markers (mapped across the 0–80
    band) plus fixed phase checkpoints (concat/compositing/loudnorm); any ffmpeg
    ``time=`` signal, when visible, is folded in via a monotonic (never-
    decreasing) clamp. Returns a dict to push as ``tool_progress`` when something
    changed, else None.
    """

    def __init__(self, total_output_duration: float | None = None) -> None:
        self.n_segments = 0
        self.seg_index = 0
        self.phase = "starting"
        self.total_duration = total_output_duration or 0.0
        self._last_percent = -1.0

    def feed(self, line: str) -> dict | None:
        changed = False
        # Candidate percents from every available signal; the monotonic clamp
        # below takes the max so coarse markers and fine ffmpeg time= cooperate.
        candidates: list[float] = []

        m = _EXTRACT_RE.search(line)
        if m:
            self.n_segments = int(m.group(1))
            self.phase = "extracting"
            changed = True

        m = _SEG_RE.match(line)
        if m:
            self.seg_index = int(m.group(1)) + 1
            self.phase = f"extract {self.seg_index}/{self.n_segments or '?'}"
            changed = True
            # Coarse segment-derived percent: ffmpeg's per-segment time= lines do
            # not reach the wrapper (render.py captures its own ffmpeg stderr /
            # passes -nostats), so without this the bar would sit at 0 through the
            # entire extraction phase. Map completed segments across the 0–80 band.
            if self.n_segments:
                candidates.append(self.seg_index / self.n_segments * 80.0)

        if "concat" in line and ("→" in line or "->" in line):
            self.phase = "concat"
            candidates.append(82.0)
            changed = True
        elif "compositing" in line and ("→" in line or "->" in line):
            self.phase = "compositing"
            candidates.append(85.0)
            changed = True
        elif "loudnorm pass 1" in line:
            self.phase = "loudnorm (measuring)"
            candidates.append(90.0)
            changed = True
        elif "loudnorm pass 2" in line or "loudnorm (1-pass" in line:
            self.phase = "loudnorm (normalizing)"
            candidates.append(94.0)
            changed = True

        # Fine percent from ffmpeg time= against total output duration — used when
        # ffmpeg stats ARE visible to the wrapper (kept for forward-compat).
        t = parse_ffmpeg_time(line)
        if t is not None and self.total_duration > 0:
            if self.phase.startswith("extract") and self.n_segments:
                base = (self.seg_index - 1) / self.n_segments * 80.0
                per_seg = max(self.total_duration / self.n_segments, 0.1)
                seg_frac = min(1.0, t / per_seg)
                candidates.append(base + seg_frac * (80.0 / self.n_segments))
            elif self.phase == "concat":
                candidates.append(82.0)
            else:  # compositing / loudnorm track the whole output
                frac = min(1.0, t / self.total_duration)
                candidates.append(85.0 + frac * 14.0)

        if candidates:
            new_percent = max(self._last_percent, min(99.0, max(candidates)))
            if new_percent - self._last_percent >= 1.0:
                self._last_percent = new_percent
                changed = True

        if not changed:
            return None
        return {
            "percent": round(self._last_percent, 1) if self._last_percent >= 0 else None,
            "phase": self.phase,
        }


class TranscribeProgress:
    """Stateful transcribe-batch progress parser."""

    def __init__(self) -> None:
        self.total = 0
        self.cached = 0
        self.to_do = 0
        self.done = 0  # newly transcribed + failed (terminal per-file)
        self.last_done_name: str | None = None
        self.last_done_failed = False

    def feed(self, line: str) -> dict | None:
        m = _FOUND_RE.search(line)
        if m:
            self.total = int(m.group(1))
            self.cached = int(m.group(2))
            self.to_do = int(m.group(3))
            self.done = self.cached  # cached count as already-complete
            return self._snapshot(phase="starting")

        m = _FILE_DONE_RE.match(line)
        if m:
            self.done += 1
            self.last_done_name = m.group(1)
            self.last_done_failed = False
            return self._snapshot(phase="transcribing")

        m = _FILE_FAIL_RE.match(line)
        if m:
            self.done += 1
            self.last_done_name = m.group(1)
            self.last_done_failed = True
            return self._snapshot(phase="transcribing")

        return None

    def _snapshot(self, phase: str) -> dict:
        total = max(self.total, 1)
        percent = min(100.0, self.done / total * 100.0)
        return {
            "done": self.done,
            "total": self.total,
            "percent": round(percent, 1),
            "phase": phase,
            "current": self.last_done_name,
            "failed": self.last_done_failed,
        }
