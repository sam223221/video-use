"""Persistent rotating file logging (incident tooling, plan 2026-06-10).

Until this module existed, every log line lived ONLY in the start.bat console
window — a phone upload could stall silently and there was zero forensic record
once the window scrolled or closed. This module gives the backend a durable,
greppable file log:

* ``studio/.runtime/logs/studio.log`` — UTF-8, rotated at ~5 MB, 5 backups
  (``studio.log.1`` ... ``studio.log.5``), so disk use is capped at ~30 MB.
* Line format: ``2026-06-10 19:30:01.123 INFO  studio.upload | msg key=value``
  — timestamp with milliseconds, level, logger name, then a structured
  key=value message written by the call sites (one logger per area:
  ``studio.upload`` / ``studio.auth`` / ``studio.session`` / ``studio.job`` /
  ``studio.agent`` / ``studio.client``).
* The SAME file handler is attached to ``uvicorn.access`` and
  ``uvicorn.error`` so HTTP access lines and server errors land in the file
  too. Their console handlers are NOT touched (uvicorn configures them before
  importing the app — ``start.bat`` runs ``python -m uvicorn app.main:app``,
  so this must work from inside the app, not via CLI flags).
* Console behavior for ``studio.*`` is preserved: previously (no handlers
  anywhere) WARNING+ reached stderr via logging's lastResort handler; we
  attach an explicit stderr handler at WARNING so attaching the file handler
  does not silence the console.

EVERYTHING here is best-effort: a failed mkdir, an unwritable disk, a locked
rotation — none of it may ever break the app. ``init_logging`` swallows every
exception (the app simply runs file-log-less, exactly as before), and the
logging package itself already swallows per-record handler errors.

Security: call sites must never log passwords, cookie values, or session
tokens. Client-supplied strings (filenames, usernames on FAILED logins,
client-shipped diagnostic events) go through :func:`sanitize_log_value`, which
strips control characters so a crafted value can never forge log lines
(CR/LF injection) and caps the length.
"""

from __future__ import annotations

import logging
import re
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from .. import settings

LOG_DIR_NAME = "logs"
LOG_FILE_NAME = "studio.log"
LOG_MAX_BYTES = 5 * 1024 * 1024  # ~5 MB per file
LOG_BACKUP_COUNT = 5  # studio.log + .1 ... .5 -> ~30 MB cap

_FORMAT = "%(asctime)s.%(msecs)03d %(levelname)-5s %(name)s | %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

# C0 + DEL + C1 control characters: stripped from every client-influenced
# value so no value can embed a newline (log-line forgery) or terminal junk.
_CTRL_RE = re.compile("[%s-%s%s-%s]" % (chr(0), chr(31), chr(127), chr(159)))

_initialized = False
_log_path: Path | None = None


def sanitize_log_value(value: object, max_len: int = 500) -> str:
    """Render ``value`` safe for a single log line: no control chars, capped.

    CR/LF (and every other C0/C1 control char) are replaced with a space so a
    crafted filename/username/message can never start a forged log line; the
    result is truncated to ``max_len`` characters with an ellipsis marker.
    Never raises — an unstringable object degrades to ``"?"``.
    """
    try:
        text = value if isinstance(value, str) else str(value)
    except Exception:  # noqa: BLE001 - logging must never raise
        return "?"
    text = _CTRL_RE.sub(" ", text)
    if len(text) > max_len:
        text = text[:max_len] + "...(truncated)"
    return text


def log_file_path() -> Path | None:
    """The active log file path, or None when file logging is unavailable."""
    return _log_path


def init_logging() -> None:
    """Attach the rotating file handler (idempotent, best-effort, never raises).

    Called first thing in ``create_app()`` (i.e. at import time under
    ``python -m uvicorn app.main:app``, AFTER uvicorn has configured its own
    console logging) and again defensively at the top of the lifespan. The
    second and every later call is a no-op.

    Wiring:
      * ``studio`` logger -> level INFO, file handler + a stderr handler at
        WARNING (mirrors the pre-existing lastResort console behavior),
        ``propagate=False`` so a future root-logger config can never
        double-print.
      * ``uvicorn.access`` / ``uvicorn.error`` -> file handler APPENDED only;
        their own console handlers, levels, and propagation are untouched.
    """
    global _initialized, _log_path
    if _initialized:
        return
    _initialized = True  # one attempt per process — a dead disk is not retried

    try:
        log_dir = settings.RUNTIME_DIR / LOG_DIR_NAME
        log_dir.mkdir(parents=True, exist_ok=True)
        path = log_dir / LOG_FILE_NAME

        formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)
        file_handler = RotatingFileHandler(
            path,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
            errors="replace",  # a weird byte must never kill a log record
        )
        file_handler.setFormatter(formatter)
        # Tag so re-init / double create_app() can detect an already-attached
        # handler instead of stacking duplicates.
        file_handler._studio_applog = True  # type: ignore[attr-defined]

        def _has_ours(lg: logging.Logger) -> bool:
            return any(getattr(h, "_studio_applog", False) for h in lg.handlers)

        studio = logging.getLogger("studio")
        studio.setLevel(logging.INFO)
        if not _has_ours(studio):
            studio.addHandler(file_handler)
            # Preserve the console: with no handlers anywhere, logging's
            # lastResort printed WARNING+ to stderr. Attaching ANY handler
            # disables lastResort, so add an equivalent explicit one.
            console = logging.StreamHandler(sys.stderr)
            console.setLevel(logging.WARNING)
            console.setFormatter(formatter)
            studio.addHandler(console)
        studio.propagate = False

        # HTTP access lines + uvicorn server errors -> same file. Append-only:
        # uvicorn's own console handlers/levels/propagation stay as configured.
        for name in ("uvicorn.access", "uvicorn.error"):
            lg = logging.getLogger(name)
            if not _has_ours(lg):
                lg.addHandler(file_handler)

        _log_path = path
    except Exception:  # noqa: BLE001 - logging must NEVER break the app
        _log_path = None
