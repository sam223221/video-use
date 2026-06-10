"""Subprocess launcher for the helper scripts (ARCHITECTURE.md §2.3 / §5.5).

Single integration seam with the unmodified ``helpers/*.py``. Responsibilities:

* Run a helper as ``python <helpers>/<script>.py ...`` with ``cwd=helpers/`` so
  sibling imports work (``transcribe_batch`` imports ``transcribe``; ``render``
  imports ``grade``).
* Build a clean env. ``ELEVENLABS_API_KEY`` is left intact (helpers read it from
  ``.env``). We add the helpers dir to ``PYTHONPATH`` belt-and-suspenders so the
  sibling imports resolve even if a caller changes cwd.
* Stream stdout+stderr line-by-line to an optional callback (for progress).
* Enforce a timeout and support cooperative cancellation (kill the process tree).
* Never raise into the caller for an ffmpeg/helper failure — return a structured
  ``RunResult`` with the captured stderr/stdout tail.

Async-first (``run`` is a coroutine) so the FastAPI event loop is never blocked.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .. import settings

# A line callback may be sync or async; we support both.
LineCallback = Callable[[str], None] | Callable[[str], "Awaitable[None]"]
CancelCheck = Callable[[], bool]

_TAIL_LINES = 60


@dataclass
class RunResult:
    ok: bool
    returncode: int | None
    stdout_tail: list[str] = field(default_factory=list)
    stderr_tail: list[str] = field(default_factory=list)
    timed_out: bool = False
    cancelled: bool = False

    @property
    def tail_text(self) -> str:
        lines = self.stderr_tail or self.stdout_tail
        return "\n".join(lines[-20:])


def _python_exe() -> str:
    """The interpreter running Studio also runs the helpers (same deps available)."""
    return sys.executable or "python"


def _build_env() -> dict[str, str]:
    env = dict(os.environ)
    helpers = str(settings.HELPERS_DIR)
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = helpers + (os.pathsep + existing if existing else "")
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # Force UTF-8 mode in the child interpreter (Python 3.14 is NOT UTF-8-mode by
    # default, and this Windows host's locale encoding is cp1252). Without this,
    # the helpers' read_text/write_text/open default to cp1252 and crash on
    # non-ASCII subtitle/EDL/JSON I/O (UnicodeEncode/DecodeError). PYTHONIOENCODING
    # only covers stdio; PYTHONUTF8 covers all default file I/O. Applies to every
    # helper launch since run() is the single subprocess seam.
    env["PYTHONUTF8"] = "1"
    return env


async def _emit(cb: LineCallback | None, line: str) -> None:
    if cb is None:
        return
    res = cb(line)
    if asyncio.iscoroutine(res):
        await res


async def run(
    script: str,
    args: list[str],
    *,
    timeout: float,
    on_line: LineCallback | None = None,
    cancel_check: CancelCheck | None = None,
) -> RunResult:
    """Run ``helpers/<script>`` with ``args``. Returns a RunResult, never raises
    for a non-zero helper exit.

    ``script`` is a bare filename like ``"render.py"`` (resolved under HELPERS_DIR).
    Stdout and stderr are streamed line-by-line to ``on_line``. ``cancel_check``
    is polled; when it returns True the process tree is killed.
    """
    script_path = settings.HELPERS_DIR / script
    cmd = [_python_exe(), str(script_path), *args]

    stdout_tail: deque[str] = deque(maxlen=_TAIL_LINES)
    stderr_tail: deque[str] = deque(maxlen=_TAIL_LINES)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(settings.HELPERS_DIR),
            env=_build_env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (OSError, ValueError) as exc:
        return RunResult(ok=False, returncode=None, stderr_tail=[f"failed to launch: {exc}"])

    timed_out = False
    cancelled = False

    async def pump(stream: asyncio.StreamReader, tail: deque[str]) -> None:
        while True:
            raw = await stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            if line:
                tail.append(line)
                await _emit(on_line, line)

    async def watch_cancel() -> None:
        nonlocal cancelled
        if cancel_check is None:
            return
        while proc.returncode is None:
            if cancel_check():
                cancelled = True
                _kill_tree(proc)
                return
            await asyncio.sleep(0.4)

    pumps = [
        asyncio.create_task(pump(proc.stdout, stdout_tail)),  # type: ignore[arg-type]
        asyncio.create_task(pump(proc.stderr, stderr_tail)),  # type: ignore[arg-type]
    ]
    canceller = asyncio.create_task(watch_cancel())

    try:
        await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        timed_out = True
        _kill_tree(proc)
        try:
            await asyncio.wait_for(proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
    finally:
        canceller.cancel()
        for p in pumps:
            try:
                await asyncio.wait_for(p, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                p.cancel()

    rc = proc.returncode
    ok = (rc == 0) and not timed_out and not cancelled
    return RunResult(
        ok=ok,
        returncode=rc,
        stdout_tail=list(stdout_tail),
        stderr_tail=list(stderr_tail),
        timed_out=timed_out,
        cancelled=cancelled,
    )


def _kill_tree(proc: asyncio.subprocess.Process) -> None:
    """Kill the helper process (and its ffmpeg children where possible)."""
    if proc.returncode is not None:
        return
    try:
        if os.name == "nt":
            import subprocess

            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        else:
            proc.kill()
    except Exception:  # noqa: BLE001 - best-effort kill
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


# --- synchronous ffprobe helper (used by inventory, no progress needed) ----
def ffprobe_json(path: Path, timeout: float = 30.0) -> dict | None:
    """Run ffprobe and return parsed JSON (format+streams), or None on failure.

    Synchronous + bounded; called from a thread pool by the inventory wrapper so
    it doesn't block the loop for large folders.
    """
    import json
    import subprocess

    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(path),
    ]
    try:
        # Decode ffprobe's UTF-8 JSON explicitly: the parent process default is
        # cp1252 on this Windows host, which raises UnicodeDecodeError on non-ASCII
        # container metadata tags (same class as commit 196d7e9). errors="replace"
        # keeps one odd byte from aborting the whole inventory. encoding= implies
        # text mode. ValueError covers json.JSONDecodeError (and any decode slip).
        out = subprocess.run(
            cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except (subprocess.TimeoutExpired, ValueError, OSError):
        return None
