"""Wrapper for grade.py — preset/analyze/apply/list (contract §5.2).

The agent uses this for color work outside the render pipeline (render.py already
bakes the EDL ``grade`` per-segment). Supports: list presets, print a preset,
analyze a clip, or apply a preset/raw filter to a single file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import runner

_TIMEOUT_FAST = 60.0
_TIMEOUT_APPLY = 1800.0


async def run(
    *,
    input_path: Path | None = None,
    output_path: Path | None = None,
    preset: str | None = None,
    filter_str: str | None = None,
    analyze: bool = False,
    list_presets: bool = False,
    print_preset: str | None = None,
) -> dict[str, Any]:
    """Dispatch to grade.py. Returns {ok, stdout, output?, message?}."""
    if list_presets:
        res = await runner.run("grade.py", ["--list-presets"], timeout=_TIMEOUT_FAST)
        return _result(res)

    if print_preset is not None:
        res = await runner.run("grade.py", ["--print-preset", print_preset], timeout=_TIMEOUT_FAST)
        return _result(res)

    if analyze:
        if input_path is None:
            return {"ok": False, "message": "analyze requires an input path"}
        res = await runner.run("grade.py", ["--analyze", str(input_path)], timeout=_TIMEOUT_FAST)
        return _result(res)

    # Apply mode
    if input_path is None or output_path is None:
        return {"ok": False, "message": "input and output are required to apply a grade"}

    args = [str(input_path), "-o", str(output_path)]
    if filter_str is not None:
        args += ["--filter", filter_str]
    elif preset is not None:
        args += ["--preset", preset]
    # else: auto mode (default)

    res = await runner.run("grade.py", args, timeout=_TIMEOUT_APPLY)
    out = _result(res)
    if out["ok"]:
        out["output"] = str(output_path)
    return out


def _result(res: runner.RunResult) -> dict[str, Any]:
    return {
        "ok": res.ok,
        "stdout": "\n".join(res.stdout_tail),
        "message": None if res.ok else (res.tail_text or "grade failed"),
    }
