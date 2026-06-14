"""Global agent-model store — the persisted app-wide model selection for the
Claude Agent SDK editor (Agent Model Picker, plan 2026-06-13).

USER decision: GLOBAL scope — ONE model setting for the whole app, shared by
both household users (a 2-person trusted LAN tool). This module owns:

* the persisted GLOBAL selection at ``relay/.runtime/agent_model.json`` (the
  same gitignored-``.runtime`` persisted-file pattern as ``session_secret`` —
  survives a relay restart),
* the VERIFIED allowlist of subscription-path models (id -> label -> hint),
* ``resolve()`` — the model id to hand ``ClaudeAgentOptions(model=...)``, or
  ``None`` for "default" (which OMITS the kwarg so the agent inherits the
  Claude Code CLI default, byte-identical to the pre-picker behavior),
* a monotonically increasing ``version()`` bumped on every successful ``set``
  so ``agent/session.py`` can detect a change and rebuild cached sessions.

**Subscription invariant (security §7):** the picker selects WHICH subscription
model the SDK uses; it NEVER touches billing mode. No ANTHROPIC_API_KEY is ever
read or written here — ``agent/env.build_agent_env()`` still strips the key in
subscription mode regardless of the selected model.

**Allowlist is verified-live, not guessed.** Each id below drove a real
subscription-mode agent turn (``ClaudeAgentOptions(model=<id>,
setting_sources=[], permission_mode="bypassPermissions")``) at build time
(2026-06-13) and the SDK's ``ResultMessage.model_usage`` reported the matching
model id — proof the model actually resolved on the MAX-subscription SDK path,
not merely that the option was accepted. Free-text ids are rejected: only an
id in this list (or the sentinel ``"default"``) may ever be persisted, so the
picker can't inject a bogus / non-subscription / unexpectedly-expensive model
or wedge the SDK.

**Never raises.** A missing / corrupt / unreadable JSON file falls back to
``"default"`` (today's behavior). Persistence is best-effort: if the file
cannot be written the new value still applies in-process for this run (the
``version()`` bump and resolver reflect it); only survival-across-restart is
lost, and that degrades silently rather than 500ing the POST route.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Final

from .. import settings

_log = logging.getLogger("studio2.agent")

# The sentinel meaning "omit ClaudeAgentOptions.model -> inherit the CLI
# default". Stored verbatim; resolve() maps it to None. NOT a real model id.
DEFAULT_MODEL: Final[str] = "default"

# The persisted global selection. ``.runtime`` is gitignored (like
# session_secret / the transcribe spool); the value is a plain model id string,
# never a secret.
_STORE_FILE: Path = settings.RUNTIME_DIR / "agent_model.json"


# --- the VERIFIED allowlist (security §7: allowlist-only, no free text) -------
# Order = display order in the picker. Each entry: a stable id, a friendly
# label, and a one-line hint. The "default" sentinel leads (it preserves
# today's behavior and is the unset value). Every NON-default id was confirmed
# live on the subscription SDK path (see the module docstring). To add a tier,
# probe it live first and only then list it here.
_ALLOWLIST: Final[tuple[dict[str, str], ...]] = (
    {
        "id": DEFAULT_MODEL,
        "label": "Default",
        "hint": "Follow the Claude Code default",
    },
    {
        "id": "claude-opus-4-8",
        "label": "Opus",
        "hint": "Most capable",
    },
    {
        "id": "claude-sonnet-4-6",
        "label": "Sonnet",
        "hint": "Balanced and faster",
    },
    {
        "id": "claude-haiku-4-5",
        "label": "Haiku",
        "hint": "Fastest and lightest",
    },
)

_ALLOWED_IDS: Final[frozenset[str]] = frozenset(e["id"] for e in _ALLOWLIST)

# In-process state. The model-version starts at 1 and is bumped on every
# SUCCESSFUL set() (even a no-op same-value set bumps, so a caller can always
# detect "the user re-applied"). session.py compares this against the version a
# cached AgentSession was built with to decide whether to evict+rebuild.
_lock = threading.Lock()
_current: str = DEFAULT_MODEL
_version: int = 1
_loaded = False


def available() -> list[dict[str, str]]:
    """The allowlist as a fresh list of ``{id, label, hint}`` dicts.

    Returns copies so a caller mutating the payload can never corrupt the
    module-level allowlist.
    """
    return [dict(entry) for entry in _ALLOWLIST]


def is_allowed(model: str) -> bool:
    """True when ``model`` is a persistable selection (an allowlist id or the
    ``"default"`` sentinel). Drives the POST route's 400 ``invalid_model``."""
    return model in _ALLOWED_IDS


def _load_once() -> None:
    """Read the persisted selection ONCE per process (lazy). Never raises: a
    missing / corrupt / non-dict / unknown-id file leaves the in-memory default
    in place. Holds ``_lock`` via the callers."""
    global _current, _loaded
    if _loaded:
        return
    _loaded = True  # one read attempt; a corrupt file is not retried per call
    try:
        raw = _STORE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw)
        model = data.get("model") if isinstance(data, dict) else None
        if isinstance(model, str) and model in _ALLOWED_IDS:
            _current = model
            return
        if model is not None:
            # A persisted id that is no longer on the allowlist (e.g. a tier
            # was retired): fall back to default rather than honor an id the
            # SDK may reject. Loud but non-fatal.
            _log.warning(
                "persisted agent model %r not in allowlist — using default",
                model,
            )
    except FileNotFoundError:
        pass  # first run: default stands
    except (OSError, ValueError, TypeError) as exc:
        _log.warning("agent model store unreadable (%s) — using default", exc)


def current() -> str:
    """The current global selection: an allowlist id, or ``"default"``."""
    with _lock:
        _load_once()
        return _current


def version() -> int:
    """The monotonically increasing model-version. ``session.py`` rebuilds a
    cached AgentSession whenever this differs from the version the session was
    built with. Stable across reads; bumped only by a successful ``set``."""
    with _lock:
        _load_once()
        return _version


def resolve() -> str | None:
    """The value for ``ClaudeAgentOptions(model=...)``: a concrete model id, or
    ``None`` for ``"default"`` (the caller must then OMIT the ``model`` kwarg so
    behavior is byte-identical to today). Never raises."""
    sel = current()
    return None if sel == DEFAULT_MODEL else sel


def set(model: str) -> str:
    """Persist a new global selection and bump the model-version.

    ``model`` MUST be an allowlist id or ``"default"`` — callers validate via
    :func:`is_allowed` and return 400 ``invalid_model`` otherwise (this function
    raises :class:`ValueError` as a defensive backstop). On success the value is
    applied in-process (``current``/``resolve``/``version`` reflect it
    immediately) and written to ``.runtime/agent_model.json``; a write failure
    is logged and swallowed (the new value still applies for this run — only
    restart-survival is lost). Returns the stored selection.
    """
    if not is_allowed(model):
        raise ValueError(f"model not in allowlist: {model!r}")
    with _lock:
        _load_once()
        global _current, _version
        _current = model
        _version += 1
        _persist_locked(model)
        return _current


def _persist_locked(model: str) -> None:
    """Best-effort write of the selection to the store file. Never raises.

    Atomic-ish: write a temp sibling then ``os.replace`` so a crash mid-write
    can't leave a half-written JSON the next ``_load_once`` would reject (and
    then silently drop to default). Restricts perms on POSIX, mirroring the
    ``session_secret`` precedent (the value isn't secret, but the pattern is
    consistent and harmless)."""
    try:
        settings.RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"model": model}, separators=(",", ":"))
        tmp = _STORE_FILE.with_name(_STORE_FILE.name + ".tmp")
        tmp.write_text(payload, encoding="utf-8")
        if os.name != "nt":
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
        os.replace(tmp, _STORE_FILE)
        _log.info("agent model set model=%s version=%s", model, _version)
    except OSError as exc:
        # In-memory selection still applies for this process; only
        # survival-across-restart is lost. Never fail the POST on a disk error.
        _log.warning("could not persist agent model %r (%s)", model, exc)
