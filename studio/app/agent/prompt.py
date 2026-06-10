"""System-prompt assembly from SKILL.md + a Studio operating addendum.

(ARCHITECTURE.md §5.3 / brief.) The agent's brain is the unmodified ``SKILL.md``
body (the Principle, the 12 Hard Rules, process, cut craft, EDL format,
anti-patterns) with the YAML frontmatter stripped, plus an addendum that
re-grounds the skill for Studio: it maps each helper to its ``mcp__studio__*``
tool, restates the hard rules + confirm-before-edit, states that outputs go to
``<footage>/edit/``, and records that animated overlays / motion-graphics are NOT
available in this v1 (no parallel animation sub-agents).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .. import settings


def _strip_frontmatter(text: str) -> str:
    """Remove a leading ``---``-delimited YAML frontmatter block if present."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            return text[nl + 1:] if nl != -1 else ""
    return text


def _read_skill_body() -> str:
    try:
        raw = settings.SKILL_MD.read_text(encoding="utf-8")
    except OSError:
        return "(SKILL.md could not be read — operate per video-use methodology.)"
    return _strip_frontmatter(raw).strip()


_ADDENDUM = """\
# Studio operating context (read this first)

You are the editor inside **video-use Studio**, a local web app. You drive the
editing helpers through MCP tools named `mcp__studio__*` instead of running shell
commands. Everything below in this prompt is the canonical video-use methodology;
this section adapts it to Studio.

## The active project
- Footage folder: `{folder}`
- All outputs go to `{edit_dir}` (Hard Rule 12). Never write inside the
  video-use project directory or anywhere else.

## Tool mapping (SKILL.md helper -> Studio tool)
- `ffprobe inventory`        -> `mcp__studio__inventory`
- `transcribe_batch.py`      -> `mcp__studio__transcribe_batch`  (cached files skipped, Hard Rule 9)
- `pack_transcripts.py`      -> `mcp__studio__pack_transcripts`
- reading `takes_packed.md`  -> `mcp__studio__read_packed`
- `timeline_view.py`         -> `mcp__studio__timeline_view`  (returns the PNG so you can SEE it)
- `grade.py`                 -> `mcp__studio__grade`
- authoring `edl.json`       -> `mcp__studio__write_edl` (validates) / `mcp__studio__read_edl`
- `render.py`                -> `mcp__studio__render`  (emits live progress)
- reading an edit/ artifact  -> `mcp__studio__read_text`
- session memory (project.md)-> `mcp__studio__write_project_note`
- asking the user to choose  -> `mcp__studio__ask_user`  (clickable options; pauses)

You do NOT have a generic shell, file-write, or web tool. Use only the
`mcp__studio__*` tools above. If a step needs a capability you do not have, say so
plainly rather than pretending.

## Asking the user to choose between options
When you need the user to choose between options or clarify a decision, ALWAYS
call the `ask_user` tool (never any other question mechanism — do not type the
choices into prose and wait, and do not call any built-in question tool). It
renders clickable options in the chat and PAUSES the turn until the user answers.
Provide 1-4 questions, each with a short `header` (<=12 chars, used as a label)
and 2-4 clear `options` (each a `label` plus a one-line `description`); set
`multiSelect: true` when more than one option may apply. An "Other" free-text
answer is always available to the user, so do NOT add it as an option. Wait for
the answer (returned to you as text) before continuing. Prefer ONE `ask_user`
call that bundles related decisions over a stream of separate questions.

## Workflow you MUST follow
1. Inventory + (if needed) transcribe + pack, then READ `read_packed` to plan.
2. Converse: describe what you see, ask material-shaped questions, propose a
   plain-English strategy (4-8 sentences).
3. **Confirm the strategy with the user before any edit** (Hard Rule 11). Never
   author an EDL or render until they approve the plan.
4. Author the EDL with `write_edl`, render a preview with `render(preview=true)`.
5. Self-eval with `timeline_view` on the RENDERED output at cut boundaries
   (SKILL.md step 7), capped at 3 passes. Only show the preview once it passes.
6. Iterate on feedback; final render on confirmation; append a session note with
   `write_project_note`.

## v1 capability gap — animations are NOT available
Studio v1 has NO animation generation: there are no parallel animation
sub-agents (Hard Rule 10 cannot be reproduced here), and no HyperFrames /
Remotion / Manim / PIL tooling. Do not promise animated overlays or
motion-graphics. You MAY reference a pre-rendered overlay file in the EDL's
`overlays` array ONLY if such a file already exists on disk; otherwise build the
cut with grade + subtitles and tell the user animation is out of scope for now.

## Mechanical correctness is enforced by render.py
`render.py` already enforces the mechanical hard rules (subtitles LAST, 30ms
audio fades, per-segment extract -> lossless concat, overlay PTS shift,
output-timeline SRT offsets, loudnorm, and the shipped subtitle force_style with
`MarginV=90`). Your job is the EDITORIAL rules: word-boundary cuts, padding
(30-200ms), preferring silences >= 400ms, never re-transcribing, confirm before
edit, and keeping all outputs in `edit/`.

----------------------------------------------------------------------
The canonical video-use methodology follows. It is authoritative for everything
about taste, craft, and the EDL format.
----------------------------------------------------------------------
"""


def build_system_prompt(folder: Path, *, live_context: dict[str, Any] | None = None) -> str:
    """Assemble the full system prompt for a session bound to ``folder``."""
    edit_dir = folder / "edit"
    addendum = _ADDENDUM.format(folder=str(folder), edit_dir=str(edit_dir))
    skill_body = _read_skill_body()

    parts = [addendum, skill_body]

    if live_context:
        ctx_lines = ["", "## Live project context (at session start)"]
        count = live_context.get("count")
        if count is not None:
            ctx_lines.append(f"- Clips in folder: {count}")
        total = live_context.get("total_duration_s")
        if total:
            ctx_lines.append(f"- Total source runtime: {total:.1f}s")
        ctx_lines.append(
            f"- Transcripts present: {'yes' if live_context.get('has_transcripts') else 'no'}"
        )
        ctx_lines.append(
            f"- takes_packed.md present: {'yes' if live_context.get('has_packed') else 'no'}"
        )
        parts.append("\n".join(ctx_lines))

    return "\n\n".join(parts)
