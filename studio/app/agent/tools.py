"""In-process MCP tools that expose the helpers to the agent (ARCHITECTURE.md §5.2).

Each helper becomes a ``@tool`` registered via ``create_sdk_mcp_server`` under the
server name ``studio``; the model sees them as ``mcp__studio__<name>``. Every tool
**catches all exceptions** and returns ``{"content":[...], "is_error": True}`` on
failure — an uncaught exception would kill the SDK loop (§8). Tools call the
``helpers_wrap`` layer; they never shell out directly.

The MCP server is built ONCE per chat session so it binds the correct active
folder and a per-turn progress callback (used to emit ``tool_progress`` for long
tools). ``build_server(...)`` returns ``(server, allowed_tool_names)``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import security
from ..core import jobs
from ..helpers_wrap import grade as grade_wrap
from ..helpers_wrap import inventory as inventory_wrap
from ..helpers_wrap import pack as pack_wrap
from ..helpers_wrap import render as render_wrap
from ..helpers_wrap import timeline as timeline_wrap
from ..helpers_wrap import transcribe as transcribe_wrap

if TYPE_CHECKING:  # avoid an import cycle (session imports tools)
    from .session import AgentSession

# A progress callback: (tool_name, payload) -> awaitable. The session injects it.
ProgressCb = Callable[[str, dict], Awaitable[None]]

# How long the ask_user tool blocks awaiting a browser answer before giving up so
# the per-folder chat lock is never held forever (brief: 600 s).
ASK_USER_TIMEOUT_S = 600.0
# Bounds mirroring Claude's AskUserQuestion schema (see ask_user docstring).
_MAX_QUESTIONS = 4
_MIN_OPTIONS = 2
_MAX_OPTIONS = 4
_MAX_HEADER_LEN = 12

TOOL_NAMES = [
    "mcp__studio__inventory",
    "mcp__studio__transcribe_batch",
    "mcp__studio__pack_transcripts",
    "mcp__studio__read_packed",
    "mcp__studio__timeline_view",
    "mcp__studio__grade",
    "mcp__studio__write_edl",
    "mcp__studio__read_edl",
    "mcp__studio__render",
    "mcp__studio__read_text",
    "mcp__studio__write_project_note",
    "mcp__studio__ask_user",
]


def _text(s: str) -> dict[str, Any]:
    return {"type": "text", "text": s}


def _ok(text: str, extra: dict | None = None) -> dict[str, Any]:
    content = [_text(text)]
    if extra:
        content.append(_text(json.dumps(extra, ensure_ascii=False, default=str)))
    return {"content": content}


def _err(message: str) -> dict[str, Any]:
    return {"content": [_text(f"ERROR: {message}")], "is_error": True}


def _resolve_source(folder: Path, source: str) -> Path | None:
    """Resolve a source reference (a bare stem/name or a path) to a real file
    inside the active folder, root-checked. Returns None if not found/unsafe.
    """
    candidates: list[Path] = []
    p = Path(source)
    if p.is_absolute():
        candidates.append(p)
    else:
        # bare name/stem -> look in the active folder
        for v in inventory_wrap.find_videos(folder):
            if v.name == source or v.stem == source:
                candidates.append(v)
        candidates.append(folder / source)
    for c in candidates:
        try:
            real = security.resolve_in_roots(c)
            if real.exists():
                return real
        except security.PathOutsideRoots:
            continue
    return None


def _validate_edl(edl: Any, folder: Path) -> tuple[bool, str]:
    """Validate an EDL against SKILL.md's format before persisting it."""
    if not isinstance(edl, dict):
        return False, "edl must be a JSON object"
    ranges = edl.get("ranges")
    if not isinstance(ranges, list) or not ranges:
        return False, "edl.ranges must be a non-empty array"
    sources = edl.get("sources")
    if not isinstance(sources, dict) or not sources:
        return False, "edl.sources must be a non-empty object mapping name->path"
    for i, r in enumerate(ranges):
        if not isinstance(r, dict):
            return False, f"ranges[{i}] must be an object"
        for key in ("source", "start", "end"):
            if key not in r:
                return False, f"ranges[{i}] missing '{key}'"
        if r["source"] not in sources:
            return False, f"ranges[{i}].source '{r['source']}' not in sources"
        try:
            if float(r["end"]) <= float(r["start"]):
                return False, f"ranges[{i}].end must be > start"
        except (ValueError, TypeError):
            return False, f"ranges[{i}].start/end must be numbers"
    for name, path in sources.items():
        if _resolve_source(folder, str(path)) is None:
            return False, f"source '{name}' path does not resolve to a file inside the project"
    overlays = edl.get("overlays") or []
    for j, ov in enumerate(overlays):
        if not isinstance(ov, dict) or "file" not in ov:
            return False, f"overlays[{j}] must be an object with a 'file'"
        ov_file = ov["file"]
        ov_path = Path(ov_file) if Path(ov_file).is_absolute() else (folder / "edit" / ov_file)
        # Root-confine the overlay path BEFORE the existence check (QA P2): an
        # existence-only check let an absolute/escaping path pull an arbitrary
        # readable file into a render. resolve_in_roots realpaths (symlinks +
        # ..) before the containment test against USER_SESSIONS_ROOT.
        try:
            ov_path = security.resolve_in_roots(ov_path)
        except security.PathOutsideRoots:
            return False, f"overlays[{j}].file '{ov_file}' is outside the allowed roots"
        if not ov_path.exists():
            return False, (
                f"overlays[{j}].file '{ov_file}' does not exist — animation generation "
                "is not available in Studio v1, so overlays must point at a pre-rendered file"
            )
    return True, "ok"


def _rel_to_edit(path: Path, edit_dir: Path) -> str:
    try:
        return "edit/" + str(path.relative_to(edit_dir)).replace("\\", "/")
    except ValueError:
        return str(path)


def _normalize_questions(raw: Any) -> tuple[list[dict[str, Any]] | None, str]:
    """Validate + normalize the ask_user ``questions`` payload.

    Mirrors Claude's AskUserQuestion schema: 1-4 questions, each with a non-empty
    ``question`` and ``header`` (<=12 chars) and 2-4 ``options`` (``label`` +
    optional ``description``). ``multiSelect`` defaults to False. An "Other"
    free-text answer is always implicitly allowed, so it is not part of the
    options list. Returns ``(normalized, "ok")`` or ``(None, reason)``.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None, "questions must be a JSON array"
    if not isinstance(raw, list) or not raw:
        return None, "questions must be a non-empty array"
    if len(raw) > _MAX_QUESTIONS:
        return None, f"at most {_MAX_QUESTIONS} questions are allowed"

    normalized: list[dict[str, Any]] = []
    for i, q in enumerate(raw):
        if not isinstance(q, dict):
            return None, f"questions[{i}] must be an object"
        question = q.get("question")
        if not isinstance(question, str) or not question.strip():
            return None, f"questions[{i}].question must be a non-empty string"
        header = q.get("header")
        if not isinstance(header, str) or not header.strip():
            return None, f"questions[{i}].header must be a non-empty string"
        header = header.strip()
        if len(header) > _MAX_HEADER_LEN:
            return None, f"questions[{i}].header must be <= {_MAX_HEADER_LEN} chars"
        opts_raw = q.get("options")
        if not isinstance(opts_raw, list):
            return None, f"questions[{i}].options must be an array"
        if not (_MIN_OPTIONS <= len(opts_raw) <= _MAX_OPTIONS):
            return None, (
                f"questions[{i}].options must have between {_MIN_OPTIONS} and "
                f"{_MAX_OPTIONS} entries"
            )
        options: list[dict[str, str]] = []
        for j, opt in enumerate(opts_raw):
            if isinstance(opt, str):
                opt = {"label": opt}
            if not isinstance(opt, dict):
                return None, f"questions[{i}].options[{j}] must be an object"
            label = opt.get("label")
            if not isinstance(label, str) or not label.strip():
                return None, f"questions[{i}].options[{j}].label must be a non-empty string"
            desc = opt.get("description")
            options.append({
                "label": label.strip(),
                "description": str(desc).strip() if isinstance(desc, str) else "",
            })
        normalized.append({
            "question": question.strip(),
            "header": header,
            "multiSelect": bool(q.get("multiSelect")),
            "options": options,
        })
    return normalized, "ok"


def _format_answers(questions: list[dict[str, Any]], answers: Any) -> str:
    """Render the user's answers into the readable text the MODEL reads.

    One line per question: ``"<header>: <comma-joined labels>"`` plus any free-text
    "Other" the user typed. ``answers`` is the list the answer endpoint resolved the
    Future with (one ``{header, selected, other_text}`` entry per question). It is
    matched to questions by ``header`` (falling back to positional order).
    """
    by_header: dict[str, dict[str, Any]] = {}
    answer_list = answers if isinstance(answers, list) else []
    for a in answer_list:
        if isinstance(a, dict) and isinstance(a.get("header"), str):
            by_header[a["header"]] = a

    lines: list[str] = []
    for idx, q in enumerate(questions):
        header = q["header"]
        ans = by_header.get(header)
        if ans is None and idx < len(answer_list) and isinstance(answer_list[idx], dict):
            ans = answer_list[idx]
        selected = ans.get("selected") if isinstance(ans, dict) else None
        labels = [str(s) for s in selected if isinstance(s, str)] if isinstance(selected, list) else []
        other = ans.get("other_text") if isinstance(ans, dict) else None
        if isinstance(other, str) and other.strip():
            labels.append(f"Other: {other.strip()}")
        chosen = ", ".join(labels) if labels else "(no selection)"
        lines.append(f"{header}: {chosen}")
    return "\n".join(lines) if lines else "(no answer)"


def build_server(
    folder: Path,
    *,
    progress_cb: ProgressCb | None = None,
    session: "AgentSession | None" = None,
) -> tuple[Any, list[str]]:
    """Build the in-process ``studio`` MCP server bound to ``folder``.

    ``progress_cb(tool_name, payload)`` is invoked for long tools (render,
    transcribe) so the session can emit ``tool_progress`` SSE events.

    ``session`` is the owning :class:`AgentSession`; the ``ask_user`` tool routes
    its blocking question/answer round-trip through it (registers a Future, emits
    the ``ask_user`` SSE event, awaits the browser's answer). Binding the session
    here — at the point the per-folder client is created — keeps the tool routed to
    the exact session running the turn, with no global/contextvar state.
    """
    edit_dir = folder / "edit"

    @tool("inventory",
          "List the source videos in the active folder with duration, dimensions, "
          "fps, portrait flag, size, and transcript status.", {})
    async def inventory_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            data = await inventory_wrap.inventory(folder)
            return _ok(json.dumps(data, ensure_ascii=False, default=str))
        except Exception as exc:  # noqa: BLE001
            return _err(f"inventory failed: {exc}")

    @tool("transcribe_batch",
          "Transcribe the folder's videos with ElevenLabs Scribe (4 workers, "
          "cached files skipped). Optionally restrict to `files`.",
          {"files": list, "workers": int, "language": str, "num_speakers": int})
    async def transcribe_tool(args: dict[str, Any]) -> dict[str, Any]:
        job, running = jobs.registry.create("transcribe", "trx")
        if job is None:
            return _err(f"a transcription job is already running ({running.job_id})")
        try:
            async def cb(snap: dict) -> None:
                if progress_cb:
                    label = f"{snap.get('done')}/{snap.get('total')} {snap.get('current') or ''}"
                    await progress_cb("transcribe_batch", {
                        "percent": snap.get("percent"),
                        "phase": label.strip(),
                    })

            result = await transcribe_wrap.run_job(
                job, folder,
                files=args.get("files"),
                workers=int(args.get("workers") or 4),
                language=args.get("language"),
                num_speakers=args.get("num_speakers"),
                do_pack=True,
                on_progress=cb,
            )
            if not result.get("ok"):
                return _err(result.get("message") or "transcription failed")
            return _ok(
                f"Transcribed {result['transcribed']} file(s), {result['cached']} cached. "
                f"Packed: {bool(result.get('packed'))}.",
                result,
            )
        except Exception as exc:  # noqa: BLE001
            job.finish_error("exception", str(exc))
            return _err(f"transcription failed: {exc}")
        finally:
            jobs.registry.release(job.job_id)

    @tool("pack_transcripts",
          "Pack cached transcripts into takes_packed.md (phrase-level, the primary "
          "reading view).", {})
    async def pack_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            res = await pack_wrap.run(folder)
            if not res.get("ok"):
                return _err(res.get("message") or "pack failed")
            return _ok(f"Packed transcripts -> {res['packed']}", res)
        except Exception as exc:  # noqa: BLE001
            return _err(f"pack failed: {exc}")

    @tool("read_packed",
          "Read takes_packed.md — the phrase-level transcript view used to plan "
          "cuts.", {})
    async def read_packed_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            text = pack_wrap.read_packed(folder)
            if text is None:
                return _err("takes_packed.md does not exist yet — run transcribe_batch first")
            return _ok(text)
        except Exception as exc:  # noqa: BLE001
            return _err(f"read_packed failed: {exc}")

    @tool("timeline_view",
          "Render a filmstrip + waveform PNG for a [start,end] range of a source "
          "(or the rendered output). Returns the image so you can SEE it.",
          {"source": str, "start": float, "end": float, "n_frames": int})
    async def timeline_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            source_ref = args.get("source")
            if not source_ref:
                return _err("source is required")
            src = _resolve_source(folder, str(source_ref))
            if src is None:
                # Allow referencing an edit/ artifact (e.g. preview.mp4) by name.
                cand = edit_dir / str(source_ref)
                try:
                    cand = security.resolve_in_roots(cand)
                except security.PathOutsideRoots:
                    cand = None  # type: ignore[assignment]
                if cand and cand.exists():
                    src = cand
            if src is None:
                return _err(f"source '{source_ref}' not found in the project")

            start = float(args.get("start", 0.0))
            end = float(args.get("end", 0.0))
            n_frames = int(args.get("n_frames") or 10)
            res = await timeline_wrap.run(src, start, end, edit_dir=edit_dir, n_frames=n_frames)
            if not res.get("ok"):
                return _err(res.get("message") or "timeline_view failed")

            png_path = Path(res["png"])
            content: list[dict[str, Any]] = [_text(f"timeline PNG saved: {png_path}")]
            try:
                data = base64.standard_b64encode(png_path.read_bytes()).decode("ascii")
                content.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": data},
                })
            except OSError:
                pass
            return {"content": content}
        except Exception as exc:  # noqa: BLE001
            return _err(f"timeline_view failed: {exc}")

    @tool("grade",
          "Color grade helper: list presets, print a preset, analyze a clip, or "
          "apply a preset/raw filter to a single file.",
          {"input": str, "output": str, "preset": str, "filter": str,
           "analyze": bool, "list_presets": bool, "print_preset": str})
    async def grade_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            in_path = None
            out_path = None
            if args.get("input"):
                in_path = _resolve_source(folder, str(args["input"]))
                if in_path is None:
                    return _err(f"input '{args['input']}' not found in the project")
            if args.get("output"):
                out_ref = Path(str(args["output"]))
                out_candidate = out_ref if out_ref.is_absolute() else (edit_dir / out_ref)
                check_dir = out_candidate.parent if out_candidate.parent.exists() else edit_dir
                try:
                    security.resolve_in_roots(check_dir)
                except security.PathOutsideRoots:
                    return _err("output path is outside the allowed roots")
                out_path = out_candidate

            res = await grade_wrap.run(
                input_path=in_path,
                output_path=out_path,
                preset=args.get("preset"),
                filter_str=args.get("filter"),
                analyze=bool(args.get("analyze")),
                list_presets=bool(args.get("list_presets")),
                print_preset=args.get("print_preset"),
            )
            if not res.get("ok"):
                return _err(res.get("message") or "grade failed")
            return _ok(res.get("stdout") or "grade done", res)
        except Exception as exc:  # noqa: BLE001
            return _err(f"grade failed: {exc}")

    @tool("write_edl",
          "Validate and write the EDL to <edit>/edl.json. The EDL is the cut "
          "decision list (version, sources, ranges[], grade, overlays[], "
          "subtitles, total_duration_s). Confirm the strategy with the user FIRST.",
          {"edl": dict})
    async def write_edl_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            edl = args.get("edl")
            if isinstance(edl, str):
                edl = json.loads(edl)
            ok, msg = _validate_edl(edl, folder)
            if not ok:
                return _err(f"invalid EDL: {msg}")
            edit_dir.mkdir(parents=True, exist_ok=True)
            edl_path = edit_dir / "edl.json"
            edl_path.write_text(json.dumps(edl, indent=2, ensure_ascii=False), encoding="utf-8")
            n = len(edl.get("ranges", []))
            return _ok(f"EDL written ({n} ranges) -> {edl_path}", {"edl_path": str(edl_path)})
        except json.JSONDecodeError as exc:
            return _err(f"edl is not valid JSON: {exc}")
        except Exception as exc:  # noqa: BLE001
            return _err(f"write_edl failed: {exc}")

    @tool("read_edl", "Read the current <edit>/edl.json.", {})
    async def read_edl_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            edl_path = edit_dir / "edl.json"
            if not edl_path.exists():
                return _err("no edl.json yet")
            return _ok(edl_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            return _err(f"read_edl failed: {exc}")

    @tool("render",
          "Render the EDL to a video (preview = fast 1080p, else final). Builds "
          "master.srt with build_subtitles. Emits live progress.",
          {"preview": bool, "draft": bool, "build_subtitles": bool,
           "no_subtitles": bool, "no_loudnorm": bool, "output": str})
    async def render_tool(args: dict[str, Any]) -> dict[str, Any]:
        job, running = jobs.registry.create("render", "rnd")
        if job is None:
            return _err(f"a render job is already running ({running.job_id})")
        try:
            preview = bool(args.get("preview"))
            draft = bool(args.get("draft"))
            out_ref = args.get("output")
            if out_ref:
                out_path = Path(str(out_ref))
                if not out_path.is_absolute():
                    out_path = edit_dir / out_path
                # Root-confine the OUTPUT path itself BEFORE dispatch (QA P2;
                # mirrors grade_tool's output confinement): render mkdir()s the
                # output's parent, so an unconfined absolute path was an
                # arbitrary write/mkdir primitive for the model.
                # resolve_in_roots realpaths (symlinks + ..) before the
                # containment test against USER_SESSIONS_ROOT; an escaping path
                # is a clean tool error, never a write outside the root.
                try:
                    out_path = security.resolve_in_roots(out_path)
                except security.PathOutsideRoots:
                    return _err("output path is outside the allowed roots")
            else:
                out_path = edit_dir / ("preview.mp4" if (preview or draft) else "final.mp4")

            try:
                security.resolve_in_roots(edit_dir)
            except security.PathOutsideRoots:
                return _err("edit dir is outside the allowed roots")

            async def cb(payload: dict) -> None:
                if progress_cb:
                    await progress_cb("render", payload)

            result = await render_wrap.run_job(
                job, edit_dir,
                output=out_path,
                preview=preview,
                draft=draft,
                build_subtitles=bool(args.get("build_subtitles")),
                no_subtitles=bool(args.get("no_subtitles")),
                no_loudnorm=bool(args.get("no_loudnorm")),
                on_progress=cb,
            )
            if not result.get("ok"):
                return _err(result.get("message") or "render failed")
            rel = _rel_to_edit(Path(result["output"]), edit_dir)
            return _ok(
                f"Render complete: {rel} ({result['duration_s']}s).",
                {**result, "artifact": rel},
            )
        except Exception as exc:  # noqa: BLE001
            job.finish_error("exception", str(exc))
            return _err(f"render failed: {exc}")
        finally:
            jobs.registry.release(job.job_id)

    @tool("read_text",
          "Read a text artifact from the edit/ dir (project.md, master.srt, a "
          "transcript json, etc.). Root-checked.",
          {"path": str})
    async def read_text_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            ref = args.get("path")
            if not ref:
                return _err("path is required")
            p = Path(str(ref))
            target = p if p.is_absolute() else (edit_dir / p)
            try:
                target = security.resolve_in_roots(target)
            except security.PathOutsideRoots:
                return _err("path is outside the allowed roots")
            if not target.exists() or not target.is_file():
                return _err("file not found")
            if target.suffix.lower() not in {".md", ".srt", ".json", ".txt", ".edl"}:
                return _err("only text artifacts may be read")
            data = target.read_text(encoding="utf-8", errors="replace")
            return _ok(data[:200_000])
        except Exception as exc:  # noqa: BLE001
            return _err(f"read_text failed: {exc}")

    @tool("write_project_note",
          "Append a session block to <edit>/project.md (session memory).",
          {"markdown": str})
    async def write_note_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            md = args.get("markdown")
            if not md:
                return _err("markdown is required")
            edit_dir.mkdir(parents=True, exist_ok=True)
            note_path = edit_dir / "project.md"
            with note_path.open("a", encoding="utf-8") as fh:
                fh.write("\n\n" + str(md).rstrip() + "\n")
            return _ok(f"appended to {note_path}")
        except Exception as exc:  # noqa: BLE001
            return _err(f"write_project_note failed: {exc}")

    @tool("ask_user",
          "Ask the user a multiple-choice question and PAUSE until they click an "
          "answer in the chat. Use this whenever you need the user to choose "
          "between options or clarify a decision — it is the ONLY question "
          "mechanism. Provide 1-4 questions; each has a `question`, a short "
          "`header` (<=12 chars used as a label), 2-4 `options` (each a `label` + "
          "a one-line `description`), and `multiSelect` (true if more than one "
          "option may apply). An 'Other' free-text answer is always allowed, so do "
          "not add it as an option. Returns the user's selections as text.",
          {"questions": list})
    async def ask_user_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            if session is None:
                return _err("ask_user is unavailable outside an interactive chat turn")
            questions, msg = _normalize_questions(args.get("questions"))
            if questions is None:
                return _err(f"invalid questions: {msg}")

            turn_id = session.current_turn_id
            if not turn_id:
                return _err("ask_user can only be used during an active chat turn")

            question_id = f"q_{secrets.token_hex(4)}"
            future = session.register_question(turn_id, question_id)

            # Emit the question to the frontend through the same SSE channel that
            # carries tool_progress (drained by AgentSession._merge while this tool
            # blocks on the relay side). The frontend renders clickable options and
            # POSTs /api/chat/answer, which resolves the Future.
            await session.emit_event("ask_user", {
                "turn_id": turn_id,
                "question_id": question_id,
                "questions": questions,
            })

            try:
                answers = await asyncio.wait_for(future, timeout=ASK_USER_TIMEOUT_S)
            except asyncio.TimeoutError:
                # Nobody answered within the window. The task itself is healthy —
                # forget the (now-cancelled) Future and let the model proceed.
                session.cancel_question(turn_id, question_id)
                return _ok("The user did not answer (timed out).")
            except asyncio.CancelledError:
                # Reached when the session cancelled the Future on turn-cancel /
                # client-disconnect / turn-end (the await target is cancelled while
                # THIS task stays alive — see AgentSession._cancel_questions). Tell
                # the model plainly so it never hangs; the turn is tearing down
                # anyway. (A genuine task-cancel from the SDK interrupt path also
                # lands here; returning a result is harmless — the CLI ignores the
                # response for an already-abandoned request.)
                session.cancel_question(turn_id, question_id)
                return _ok("(cancelled)")

            return _ok(_format_answers(questions, answers))
        except Exception as exc:  # noqa: BLE001
            return _err(f"ask_user failed: {exc}")

    server = create_sdk_mcp_server(
        name="studio",
        version="0.1.0",
        tools=[
            inventory_tool, transcribe_tool, pack_tool, read_packed_tool,
            timeline_tool, grade_tool, write_edl_tool, read_edl_tool,
            render_tool, read_text_tool, write_note_tool, ask_user_tool,
        ],
    )
    return server, list(TOOL_NAMES)
