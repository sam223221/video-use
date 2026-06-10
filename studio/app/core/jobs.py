"""Job registry + single-flight concurrency control.

A `Job` tracks a long-running helper subprocess (transcription or render):
status, progress percent, current phase, a bounded log tail, the result, and a
cancel flag. Progress is the SINGLE source that feeds BOTH the chat
``tool_progress`` SSE and the REST transcribe SSE (ARCHITECTURE.md §5.5).

Concurrency policy (ARCHITECTURE.md §8): one heavy job of each TYPE at a time.
``create(kind, prefix)`` returns the running job if one is already in flight, so
callers can return ``409 job_in_flight`` instead of starting a second.

Process-global (single-user, single-process) and thread-safe.
"""

from __future__ import annotations

import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Literal

JobStatus = Literal["queued", "running", "done", "error", "cancelled"]
JobKind = Literal["transcribe", "render"]

_MAX_LOG_LINES = 200


@dataclass
class Job:
    job_id: str
    kind: JobKind
    status: JobStatus = "queued"
    done: int = 0
    total: int = 0
    percent: float = 0.0
    phase: str = ""
    current: str | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    _log: Deque[str] = field(default_factory=lambda: deque(maxlen=_MAX_LOG_LINES))
    _cancel: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    # -- progress / logging (called from the worker coroutine) -------------
    def update(
        self,
        *,
        done: int | None = None,
        total: int | None = None,
        percent: float | None = None,
        phase: str | None = None,
        current: str | None = None,
        status: JobStatus | None = None,
    ) -> None:
        with self._lock:
            if done is not None:
                self.done = done
            if total is not None:
                self.total = total
            if percent is not None:
                self.percent = max(0.0, min(100.0, percent))
            if phase is not None:
                self.phase = phase
            if current is not None:
                self.current = current
            if status is not None:
                self.status = status
            self.updated_at = time.time()

    def log(self, line: str) -> None:
        line = line.rstrip("\n")
        if not line:
            return
        with self._lock:
            self._log.append(line)
            self.updated_at = time.time()

    def log_tail(self, n: int = 40) -> list[str]:
        with self._lock:
            return list(self._log)[-n:]

    def finish_ok(self, result: dict[str, Any]) -> None:
        with self._lock:
            self.status = "done"
            self.result = result
            self.percent = 100.0
            self.updated_at = time.time()

    def finish_error(self, code: str, message: str) -> None:
        with self._lock:
            self.status = "error"
            self.error_code = code
            self.error_message = message
            self.updated_at = time.time()

    def mark_cancelled(self) -> None:
        with self._lock:
            self.status = "cancelled"
            self.updated_at = time.time()

    # -- cancellation ------------------------------------------------------
    def request_cancel(self) -> None:
        self._cancel.set()

    @property
    def cancel_requested(self) -> bool:
        return self._cancel.is_set()

    @property
    def is_terminal(self) -> bool:
        return self.status in ("done", "error", "cancelled")

    # -- serialization -----------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "job_id": self.job_id,
                "kind": self.kind,
                "status": self.status,
                "done": self.done,
                "total": self.total,
                "percent": round(self.percent, 1),
                "phase": self.phase,
                "current": self.current,
                "result": self.result,
                "error": (
                    {"code": self.error_code, "message": self.error_message}
                    if self.error_code
                    else None
                ),
            }


class JobRegistry:
    """Process-global job store with per-kind single-flight enforcement."""

    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._active: dict[JobKind, str] = {}  # kind -> active job_id
        self._lock = threading.Lock()

    def active_job(self, kind: JobKind) -> Job | None:
        with self._lock:
            jid = self._active.get(kind)
            if not jid:
                return None
            job = self._jobs.get(jid)
            if job is None or job.is_terminal:
                self._active.pop(kind, None)
                return None
            return job

    def create(self, kind: JobKind, prefix: str) -> tuple[Job | None, Job | None]:
        """Create a new job of ``kind`` unless one is already in flight.

        Returns ``(job, None)`` on success, or ``(None, running_job)`` if a job
        of the same kind is already running (caller -> 409 job_in_flight).
        """
        with self._lock:
            existing_id = self._active.get(kind)
            if existing_id:
                existing = self._jobs.get(existing_id)
                if existing and not existing.is_terminal:
                    return None, existing
                self._active.pop(kind, None)

            job_id = f"{prefix}_{secrets.token_hex(3)}"
            job = Job(job_id=job_id, kind=kind, status="running")
            self._jobs[job_id] = job
            self._active[kind] = job_id
            return job, None

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def release(self, job_id: str) -> None:
        """Clear the active slot for a finished job (idempotent)."""
        with self._lock:
            for kind, jid in list(self._active.items()):
                if jid == job_id:
                    self._active.pop(kind, None)


# Process-global singleton.
registry = JobRegistry()
