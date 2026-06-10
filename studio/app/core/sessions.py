"""Per-user session store — the ownership chokepoint + agent-client cache.

A *session* is a user-created, user-owned project directory under
``.runtime/users/<owner>/sessions/ses_<hex12>/`` holding the user's uploaded
videos, their ``edit/`` outputs, the chat ``transcript.json``, and a ``meta.json``
describing the session. Users only ever see / open / upload-to / delete their own
sessions.

This module is the **single chokepoint** for turning a (owner, session_id) pair
into a real directory. Every router resolves a session through :func:`get` /
:func:`resolve_dir`, which enforce, in order:

  1. ``SESSION_ID_RE`` — the id is syntactically ``ses_<12 hex>`` (so it can never
     contain a path separator / traversal).
  2. ``meta.owner == owner`` — the caller owns the session.
  3. The resolved directory is INSIDE ``USER_SESSIONS_ROOT`` (realpath-confined).

Any failure (bad id, cross-user, missing, escapes the root) returns ``None`` so a
router emits a uniform ``404 session_not_found`` — never confirming whether
another user's session exists (IDOR-safe).

The agent-client cache (the per-session :class:`AgentSession`, holding the
``ask_user`` pending-question Futures) is keyed by ``session_id`` and lives here
(moved off ``core.state``). Deleting a session pops its cached client and AWAITS
its disconnect BEFORE the rmtree (the SDK subprocess cwd pins the dir on
Windows); a still-pinned leftover dir is made unlistable (meta.json dropped) and
swept at the next boot by :func:`sweep_session_husks`.

All meta writes are atomic (temp file + ``os.replace``). Best-effort reads: a
corrupt/missing ``meta.json`` degrades to "no such session" rather than crashing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import security, settings

logger = logging.getLogger("studio")

# A session id is ``ses_`` + 12 lowercase hex chars (``secrets.token_hex(6)``).
SESSION_ID_RE = re.compile(r"^ses_[0-9a-f]{12}$")

STALE_AFTER_SECONDS = 14 * 86400  # 14 days
META_SCHEMA = 1

# Session-delete rmtree retry schedule. On Windows the just-disconnected agent
# subprocess's cwd handle (or an AV/indexer scan) can take a beat to release;
# first attempt is immediate, total added wait ~1 s — bounded, never longer.
_DELETE_RETRY_DELAYS = (0.0, 0.4, 0.6)

# How long the delete path waits for the cached agent client to disconnect
# before proceeding. The rmtree retries above cover a slightly-late release, so
# this stays short — the DELETE request must never hang on a wedged subprocess.
_AGENT_CLOSE_TIMEOUT_S = 3.0

_lock = threading.Lock()


@dataclass
class Session:
    """The session entity (the persisted fields + read-time derived fields)."""

    id: str
    owner: str
    name: str
    created_at: int
    last_touched_at: int
    status: str = "active"
    schema: int = META_SCHEMA

    def age_days(self, now: int | None = None) -> int:
        now = int(time.time()) if now is None else now
        return max(0, (now - self.last_touched_at) // 86400)

    def is_stale(self, now: int | None = None) -> bool:
        now = int(time.time()) if now is None else now
        return (now - self.last_touched_at) > STALE_AFTER_SECONDS

    def media_count(self, session_dir: Path) -> int:
        """Number of source video files at the session root (excludes edit/)."""
        try:
            return sum(
                1
                for p in session_dir.iterdir()
                if p.is_file() and p.suffix in settings.VIDEO_EXTS
            )
        except OSError:
            return 0

    def to_meta(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "name": self.name,
            "created_at": self.created_at,
            "last_touched_at": self.last_touched_at,
            "status": self.status,
            "schema": self.schema,
        }

    def to_public(self, session_dir: Path, now: int | None = None) -> dict[str, Any]:
        """The shape the API returns for a list/summary entry."""
        now = int(time.time()) if now is None else now
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "last_touched_at": self.last_touched_at,
            "age_days": self.age_days(now),
            "media_count": self.media_count(session_dir),
            "stale": self.is_stale(now),
        }


# --- path helpers ---------------------------------------------------------
def _owner_dir(owner: str) -> Path:
    """The ``.runtime/users/<owner>/sessions/`` dir for ``owner``.

    The owner string comes from the verified session cookie (never raw client
    input), but it is still validated as a single safe path component so a
    hypothetical odd username can never escape the users tree.
    """
    safe_owner = security.sanitize_name(owner)
    return settings.USER_SESSIONS_ROOT / safe_owner / "sessions"


def _session_dir_unchecked(owner: str, session_id: str) -> Path:
    return _owner_dir(owner) / session_id


def _meta_path(session_dir: Path) -> Path:
    return session_dir / "meta.json"


def transcript_path(session_dir: Path) -> Path:
    return session_dir / "transcript.json"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _read_meta(meta_path: Path) -> Session | None:
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    try:
        return Session(
            id=str(data["id"]),
            owner=str(data["owner"]),
            name=str(data.get("name", "")),
            created_at=int(data.get("created_at", 0)),
            last_touched_at=int(data.get("last_touched_at", 0)),
            status=str(data.get("status", "active")),
            schema=int(data.get("schema", META_SCHEMA)),
        )
    except (KeyError, TypeError, ValueError):
        return None


# --- store API ------------------------------------------------------------
def create(owner: str, name: str) -> Session:
    """Create a new session owned by ``owner`` with display ``name``.

    Makes the session dir + its ``edit/`` subdir and writes ``meta.json``
    atomically. ``name`` is sanitized by the caller (router) via
    ``security.sanitize_display_name``; it is NOT a path component (the id is).
    Raises ``OSError`` if the directory cannot be created.
    """
    now = int(time.time())
    with _lock:
        # Generate a fresh, non-colliding id under the lock.
        while True:
            session_id = "ses_" + secrets.token_hex(6)
            session_dir = _session_dir_unchecked(owner, session_id)
            if not session_dir.exists():
                break
        (session_dir / "edit").mkdir(parents=True, exist_ok=True)
        sess = Session(
            id=session_id,
            owner=owner,
            name=name,
            created_at=now,
            last_touched_at=now,
        )
        _atomic_write(_meta_path(session_dir), json.dumps(sess.to_meta(), ensure_ascii=False))
    return sess


def list_for(owner: str) -> list[Session]:
    """All sessions owned by ``owner``, newest-touched first.

    Scans ``users/<owner>/sessions/*/meta.json``; entries whose meta is missing,
    corrupt, or owned by someone else are skipped (defense in depth).
    """
    out: list[Session] = []
    try:
        owner_dir = _owner_dir(owner)
    except ValueError:
        return out
    if not owner_dir.is_dir():
        return out
    for child in owner_dir.iterdir():
        if not child.is_dir() or not SESSION_ID_RE.match(child.name):
            continue
        sess = _read_meta(_meta_path(child))
        if sess is None or sess.owner != owner or sess.id != child.name:
            continue
        out.append(sess)
    out.sort(key=lambda s: s.last_touched_at, reverse=True)
    return out


def get(owner: str, session_id: str) -> Session | None:
    """Resolve (owner, session_id) -> Session, or None — the OWNERSHIP CHOKEPOINT.

    Returns the Session ONLY when ALL of these hold:
      * ``session_id`` matches ``SESSION_ID_RE`` (syntactic — no separators),
      * ``meta.json`` exists, parses, and ``meta.owner == owner``,
      * the resolved session dir is inside ``USER_SESSIONS_ROOT``.
    Otherwise None -> caller raises a uniform 404 (no cross-user existence leak).
    """
    if not owner or not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
        return None
    try:
        session_dir = _session_dir_unchecked(owner, session_id)
    except ValueError:
        return None
    # Realpath-confine the resolved dir to the per-user session root.
    if not security.is_within_root(session_dir, settings.USER_SESSIONS_ROOT):
        return None
    sess = _read_meta(_meta_path(session_dir))
    if sess is None or sess.owner != owner or sess.id != session_id:
        return None
    return sess


def resolve_dir(owner: str, session_id: str) -> Path | None:
    """Return the realpath of the session dir if the caller owns it, else None.

    The returned path is what the agent cwd / tools / outputs are anchored to. It
    re-confines via :func:`get` (ownership + root) so it can never point outside
    the caller's own session tree.
    """
    if get(owner, session_id) is None:
        return None
    session_dir = _session_dir_unchecked(owner, session_id)
    try:
        return Path(os.path.realpath(str(session_dir)))
    except OSError:
        return session_dir


def touch(owner: str, session_id: str) -> int | None:
    """Set ``last_touched_at = now`` (atomic rewrite). Returns the new value or None.

    Resets the 14-day stale clock. No-op (returns None) if the caller does not
    own the session.
    """
    with _lock:
        sess = get(owner, session_id)
        if sess is None:
            return None
        now = int(time.time())
        sess.last_touched_at = now
        session_dir = _session_dir_unchecked(owner, session_id)
        _atomic_write(_meta_path(session_dir), json.dumps(sess.to_meta(), ensure_ascii=False))
        return now


async def delete(owner: str, session_id: str) -> bool:
    """Permanently delete the session + drop/disconnect its cached agent client.

    Order matters on Windows: the cached AgentSession's SDK subprocess runs
    with ``cwd=<session dir>``, and an alive subprocess cwd PINS the directory.
    So the client is popped AND its ``close()`` is AWAITED (bounded by
    ``_AGENT_CLOSE_TIMEOUT_S``) BEFORE the rmtree — never fire-and-forgotten
    (the old ``loop.create_task`` scheduling silently did nothing from the sync
    route's threadpool thread, leaving the subprocess alive and the dir pinned
    until server stop). ``close()`` also cancels pending ask_user Futures so no
    in-flight turn writes back into the dir being removed.

    The rmtree runs in a worker thread (the route is async — sleeps must not
    block the loop) with a brief bounded retry (~1 s) for a late handle
    release. If the directory STILL cannot be fully removed, ``meta.json`` is
    explicitly dropped — ``get``/``list_for``/``resolve_dir`` all key on it, so
    the store can never list or resurrect the husk — ONE line is logged, and
    the delete reports success; ``sweep_session_husks`` removes the empty husk
    at the next boot (the pinning handle dies with the old process).

    Returns False only when the caller does not own the session, or when even
    ``meta.json`` could not be removed (the session genuinely still exists, so
    the router 404s and a later retry can succeed).
    """
    sess = get(owner, session_id)
    if sess is None:
        return False
    session_dir = _session_dir_unchecked(owner, session_id)

    # 1) Disconnect the cached agent client FIRST (releases the cwd handle).
    agent = pop_agent(session_id)
    if agent is not None:
        close = getattr(agent, "close", None)
        if close is not None:
            try:
                await asyncio.wait_for(close(), timeout=_AGENT_CLOSE_TIMEOUT_S)
            except Exception:  # noqa: BLE001 - best-effort; rmtree retries cover it
                pass

    # 2) Remove the tree (bounded retry, off the event loop).
    if await asyncio.to_thread(_remove_session_tree, session_dir):
        return True

    # 3) Husk path: the dir (or something in it) is still pinned. Guarantee the
    #    store can never resurrect it, log once, and let the boot sweep finish.
    if await asyncio.to_thread(_drop_meta_best_effort, session_dir):
        logger.warning(
            "session delete: %s could not be fully removed (locked handle); "
            "meta.json dropped so it is unlistable — leftover dir will be "
            "swept at next boot if empty", session_id,
        )
        return True
    return False


def _remove_session_tree(session_dir: Path) -> bool:
    """``rmtree`` with the bounded ``_DELETE_RETRY_DELAYS`` retry (sync; run via
    ``asyncio.to_thread``). True when the tree is fully gone."""
    for delay in _DELETE_RETRY_DELAYS:
        if delay:
            time.sleep(delay)
        try:
            shutil.rmtree(session_dir)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            continue
    try:
        return not session_dir.exists()
    except OSError:
        return False


def _drop_meta_best_effort(session_dir: Path) -> bool:
    """Ensure ``meta.json`` is gone (the store keys every lookup on it).

    Called only on the husk path — the rmtree usually already unlinked it
    before hitting the locked entry. True when the meta file is absent."""
    meta = _meta_path(session_dir)
    try:
        meta.unlink(missing_ok=True)
    except OSError:
        pass
    try:
        return not meta.exists()
    except OSError:
        return False


def sweep_session_husks() -> list[str]:
    """Boot-time sweep of delete husks: EMPTY ``ses_*`` dirs with NO meta.json.

    A Windows session delete can leave a content-less, handle-pinned dir behind
    (typically the old agent subprocess's cwd). That handle dies with the old
    server process, so at the NEXT boot the husk is removable. Strictly
    conservative — a dir is removed only when it (a) matches ``SESSION_ID_RE``,
    (b) has no ``meta.json``, and (c) contains no files anywhere (only empty
    subdirectories; symlinks are never followed and count as content) — user
    data is never touched, and a real-but-corrupt session (meta present) is
    never swept. Best-effort, never raises; returns the removed
    ``owner/ses_...`` names for the caller (main.py lifespan) to log.
    """
    removed: list[str] = []
    try:
        owners = list(settings.USER_SESSIONS_ROOT.iterdir())
    except OSError:
        return removed
    for owner_dir in owners:
        sessions_dir = owner_dir / "sessions"
        try:
            if not owner_dir.is_dir() or not sessions_dir.is_dir():
                continue
            children = list(sessions_dir.iterdir())
        except OSError:
            continue
        for child in children:
            try:
                if child.is_symlink() or not child.is_dir():
                    continue
                if not SESSION_ID_RE.match(child.name):
                    continue
                if _meta_path(child).exists():
                    continue  # a live (or data-bearing) session — never sweep
            except OSError:
                continue
            if _remove_empty_dir_tree(child):
                removed.append(f"{owner_dir.name}/{child.name}")
    return removed


def _remove_empty_dir_tree(path: Path) -> bool:
    """Remove ``path`` iff it contains only (recursively) empty directories.

    Deletes directories bottom-up via ``rmdir`` ONLY — no file is ever deleted,
    and symlinks are never followed (a symlinked entry counts as content and
    aborts the removal). Returns True when ``path`` is gone.
    """
    try:
        for entry in path.iterdir():
            if entry.is_symlink() or not entry.is_dir():
                return False  # real content — not a husk; keep everything
            if not _remove_empty_dir_tree(entry):
                return False
        path.rmdir()
    except OSError:
        return False
    return True


# --- agent-client cache (keyed by session_id) -----------------------------
# Holds the SAME AgentSession object for a session across chat turns so the
# ``ask_user`` pending-question Futures survive between requests. Typed Any to
# avoid importing the agent package (keeps this module import-cycle free).
_agents: dict[str, Any] = {}
_agents_lock = threading.Lock()


def get_agent(session_id: str) -> Any | None:
    with _agents_lock:
        return _agents.get(session_id)


def set_agent(session_id: str, agent: Any) -> None:
    with _agents_lock:
        _agents[session_id] = agent


def pop_agent(session_id: str) -> Any | None:
    """Remove AND return the cached agent for ``session_id`` — no close here.

    The CALLER owns shutdown: :func:`delete` AWAITS ``agent.close()`` (bounded)
    BEFORE removing the session dir. The previous fire-and-forget
    ``loop.create_task(close())`` scheduling silently did nothing when called
    from a sync route's threadpool thread (no running loop in that thread), so
    the SDK subprocess survived with its cwd pinning the session dir on
    Windows. Any new caller must ``await agent.close()`` itself (or accept the
    popped client leaking until process teardown).
    """
    with _agents_lock:
        return _agents.pop(session_id, None)
