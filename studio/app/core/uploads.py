"""Chunked / resumable upload registry (ARCHITECTURE.md §4.9, §9.4).

Three-phase protocol: init -> chunk (PUT, idempotent) -> complete (assemble).
Each in-flight upload owns a temp dir ``.runtime/uploads/<upload_id>/`` holding
``<index>.part`` files. ``complete`` concatenates the parts in order into the
destination SESSION dir, verifies the total size, fsyncs, and removes the part
dir. (Only the part dir lives under ``.runtime/uploads/``; the assembled file
lands in the per-user session dir, which is inside ``USER_SESSIONS_ROOT``.)

Per-user session model: each upload is bound to its owning ``session_id`` and the
``dest_folder`` is that session's directory, which the router resolves through
``core.sessions`` (the ownership chokepoint) BEFORE an UploadSession is created;
this module only handles bookkeeping and byte assembly. Thread-safe;
single-process.

Resume-by-identity: an upload also carries its authenticated ``owner`` and the
client's opaque ``client_id``; ``registry.find_resumable`` lets a re-init with
the same (owner, session_id, client_id) + identical filename/size/chunk_size get
the SAME upload back (in-memory only — a restart falls back to a fresh upload).
Assembly is collision-safe: an existing same-named file in the session dir is
never overwritten (auto-rename ``name (2).ext``), and ``gc_orphan_part_dirs``
sweeps stale ``up_*`` part dirs at startup (>48 h old AND not in the registry).
An explicit abort (``registry.remove``, the DELETE route) deletes the part dir
immediately with a brief bounded retry for Windows file locks; it ALSO
tombstones the upload_id (bounded FIFO, ``registry.is_cancelled``) so a chunk
PUT that was already mid-write when the cancel landed — the one case the
bounded retry cannot beat, because that writer's open ``.part.tmp`` handle
blocks the delete — refuses to commit and sweeps the part dir itself once its
own handle closes ("last writer sweeps", see ``routers/upload.py``). Transient
failures (499 disconnect, retryable assemble errors) never delete parts.
"""

from __future__ import annotations

import logging
import math
import os
import secrets
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .. import security, settings

logger = logging.getLogger("studio")

# Orphaned part dirs older than this are eligible for the startup GC sweep.
GC_MAX_AGE_SECONDS = 48 * 3600

# Explicit-abort cleanup: bounded retry schedule for removing a part dir whose
# files may be transiently locked on Windows (the in-flight chunk PUT the user
# just cancelled still holds its .part/.part.tmp handle for a beat, or an
# AV/indexer scan has a part open). First attempt is immediate; total added wait
# is ~0.9 s. The abort endpoint is a sync handler (FastAPI threadpool), so the
# sleeps never block the event loop.
_PART_DIR_RETRY_DELAYS = (0.0, 0.3, 0.6)

# Cancelled-upload tombstones: ``registry.remove`` records the destroyed
# upload_id so a chunk PUT that was ALREADY streaming when the cancel landed
# can detect the cancel after its own write finishes (the DELETE's rmtree
# fails on Windows while that writer holds its ``.part.tmp`` handle open — no
# retry schedule short enough for a request handler can outwait an 8 MB chunk
# on a slow link). Bounded FIFO: a tombstone only needs to outlive the longest
# in-flight chunk request, and a few hundred entries is orders of magnitude
# beyond any realistic number of concurrent cancels (memory stays O(cap)).
_CANCEL_TOMBSTONE_CAP = 256

# Serializes the choose-final-name + rename step across concurrent assembles so
# two same-named uploads finishing together can never race past the collision
# check and overwrite each other (single process; the byte copy itself is NOT
# under this lock — only the cheap final rename is).
_ASSEMBLE_NAME_LOCK = threading.Lock()


class UploadTooLarge(ValueError):
    """A chunk (or the running total) exceeds the size the session declared.

    Signals a resource-exhaustion attempt; the router maps it to HTTP 413.
    """


@dataclass
class UploadSession:
    upload_id: str
    session_id: str  # owning session (the dest_folder is that session's dir)
    dest_folder: Path
    filename: str  # already sanitized basename
    size_bytes: int
    chunk_size: int
    total_chunks: int
    part_dir: Path
    # Resume identity: the authenticated owner + the client's opaque, per-file
    # stable id. A re-init carrying the same (owner, session_id, client_id) with
    # an identical filename/size/chunk_size declaration is handed THIS session
    # back (with its received chunk list) instead of a fresh upload_id. Both are
    # optional so pre-resume callers keep working; "" / None never match.
    owner: str = ""
    client_id: str | None = None
    # The filename the assembled file was ACTUALLY stored under (set by
    # ``assemble``). Differs from ``filename`` only on a collision auto-rename.
    stored_name: str | None = None
    received: set[int] = field(default_factory=set)
    _part_sizes: dict[int, int] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def expected_chunk_size(self, index: int) -> int:
        """Bytes expected for chunk ``index``: ``chunk_size`` for every chunk
        except the last, which holds the remainder.
        """
        if index < self.total_chunks - 1:
            return self.chunk_size
        last = self.size_bytes - self.chunk_size * (self.total_chunks - 1)
        # Guard against a degenerate declaration (e.g. size_bytes == 0).
        return max(0, last)

    def check_chunk_size(self, index: int, length: int) -> None:
        """Reject an oversized chunk BEFORE/while buffering it.

        Enforces both the per-chunk expected size and the cumulative cap so a
        single declared-small upload can never balloon in RAM or on disk.
        Raises ``UploadTooLarge`` (router -> 413) on violation.
        """
        if length > self.expected_chunk_size(index):
            raise UploadTooLarge(
                f"chunk {index} is {length} bytes, expected at most "
                f"{self.expected_chunk_size(index)}"
            )
        with self._lock:
            # Cumulative bytes across distinct chunks (re-PUTs of the same index
            # replace, they don't add), plus this chunk if it is new.
            prior = sum(s for i, s in self._part_sizes.items() if i != index)
            projected = prior + length
        if projected > self.size_bytes or projected > settings.MAX_UPLOAD_BYTES:
            raise UploadTooLarge(
                f"upload exceeds the declared size ({self.size_bytes} bytes) "
                f"or the {settings.MAX_UPLOAD_BYTES} byte cap"
            )

    def write_chunk(self, index: int, data: bytes) -> int:
        """Write chunk ``index`` (idempotent). Returns bytes written for it.

        Validates both the chunk-index range and the chunk size (per-chunk +
        cumulative) so an oversized chunk is rejected, not silently written.
        """
        if index < 0 or index >= self.total_chunks:
            raise IndexError(f"chunk index {index} out of range 0..{self.total_chunks - 1}")
        self.check_chunk_size(index, len(data))
        part_path = self.part_dir / f"{index}.part"
        with self._lock:
            # Idempotent: re-PUT of a received index is a no-op success.
            if index in self.received and part_path.exists():
                return part_path.stat().st_size
            tmp = part_path.with_suffix(".part.tmp")
            tmp.write_bytes(data)
            tmp.replace(part_path)
            self.received.add(index)
            self._part_sizes[index] = len(data)
            return len(data)

    def note_part_written(self, index: int, length: int) -> None:
        """Record that chunk ``index`` was streamed to disk out-of-band (router
        bounded streaming). Marks it received and tracks its size for the
        cumulative cap. Idempotent.
        """
        with self._lock:
            self.received.add(index)
            self._part_sizes[index] = length

    def part_path(self, index: int) -> Path:
        return self.part_dir / f"{index}.part"

    def missing(self) -> list[int]:
        with self._lock:
            return sorted(set(range(self.total_chunks)) - self.received)

    def received_sorted(self) -> list[int]:
        with self._lock:
            return sorted(self.received)

    def prune_missing_parts(self) -> None:
        """Drop received indices whose ``<index>.part`` file is gone from disk.

        Called on a client_id resume BEFORE the ``received`` list is handed back,
        so the client is never told to skip a chunk whose bytes were lost (an
        external cleanup, a crashed write, ...). The pruned indices simply get
        re-PUT by the client; idempotent and cheap (one ``exists`` per chunk).
        """
        with self._lock:
            gone = [i for i in self.received if not (self.part_dir / f"{i}.part").exists()]
            for i in gone:
                self.received.discard(i)
                self._part_sizes.pop(i, None)

    @property
    def complete(self) -> bool:
        with self._lock:
            return len(self.received) == self.total_chunks

    def assemble(self) -> Path:
        """Concatenate parts in order into the destination session dir.

        Verifies the final size matches the declared ``size_bytes``, fsyncs the
        output, and removes the part dir. Raises on a missing chunk or size
        mismatch.

        Collision-safe: if ``dest_folder/filename`` already exists, the file is
        stored under an auto-renamed ``name (2).ext`` / ``name (3).ext`` / ...
        instead of silently overwriting the existing media. The returned path is
        the file that was ACTUALLY written (also recorded on ``stored_name``),
        so the router's complete response reflects the real stored filename. The
        choose-name + rename step is serialized under a module lock so two
        same-named uploads finishing concurrently cannot race the check.
        """
        missing = self.missing()
        if missing:
            raise ValueError(f"incomplete: {len(missing)} chunk(s) missing")

        self.dest_folder.mkdir(parents=True, exist_ok=True)
        # The temp name embeds the upload_id so two concurrent assembles of the
        # SAME filename never share (and clobber) one ``.assembling`` temp.
        tmp_out = self.dest_folder / f"{self.filename}.{self.upload_id}.assembling"

        written = 0
        with open(tmp_out, "wb") as out:
            for i in range(self.total_chunks):
                part = self.part_dir / f"{i}.part"
                with open(part, "rb") as pf:
                    while True:
                        buf = pf.read(1024 * 1024)
                        if not buf:
                            break
                        out.write(buf)
                        written += len(buf)
            out.flush()
            os.fsync(out.fileno())

        if written != self.size_bytes:
            tmp_out.unlink(missing_ok=True)
            raise ValueError(
                f"size mismatch: assembled {written} bytes, declared {self.size_bytes}"
            )

        with _ASSEMBLE_NAME_LOCK:
            final_name = collision_free_name(self.dest_folder, self.filename)
            out_path = self.dest_folder / final_name
            try:
                tmp_out.replace(out_path)
            except OSError:
                # Leave parts intact (the router keeps /complete retryable) but
                # drop the temp so retries never strand ``.assembling`` litter.
                tmp_out.unlink(missing_ok=True)
                raise
        self.stored_name = final_name
        self.cleanup()
        return out_path

    def cleanup(self) -> None:
        shutil.rmtree(self.part_dir, ignore_errors=True)


def collision_free_name(dest_folder: Path, filename: str) -> str:
    """Pick a name for ``filename`` in ``dest_folder`` that overwrites nothing.

    Returns ``filename`` unchanged when free; otherwise ``stem (2).ext``,
    ``stem (3).ext``, ... (extension preserved). Every candidate is re-checked
    through ``security.sanitize_filename`` (same allowlist/sanitization the
    original name passed at init) so the rename can never introduce an unsafe
    component; over-long stems are truncated to keep the candidate <= 255 chars.
    Raises ``OSError`` if no free name exists after 999 attempts (pathological;
    the router maps it to a retryable 500 assemble_failed).
    """
    if not (dest_folder / filename).exists():
        return filename
    stem, ext = os.path.splitext(filename)
    for n in range(2, 1001):
        suffix = f" ({n}){ext}"
        keep = 255 - len(suffix)
        candidate = f"{stem[:keep].rstrip(' .')}{suffix}" if len(stem) > keep else f"{stem}{suffix}"
        try:
            candidate = security.sanitize_filename(candidate)
        except ValueError:
            continue  # paranoia: never store a candidate the sanitizer rejects
        if not (dest_folder / candidate).exists():
            return candidate
    raise OSError(f"no collision-free name available for {filename!r}")


def remove_tree_with_retry(
    path: Path, delays: tuple[float, ...] = _PART_DIR_RETRY_DELAYS
) -> bool:
    """``rmtree`` with a brief bounded retry; True when the tree is fully gone.

    Windows can transiently refuse the delete (a racing chunk PUT, an AV scan).
    Retry a couple of times over <1 s, then give up — the caller logs once and
    the 48 h boot GC remains the backstop. An already-missing tree is success.
    """
    for delay in delays:
        if delay:
            time.sleep(delay)
        try:
            shutil.rmtree(path)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            continue
    # A failed attempt may still have removed part of the tree — report the
    # actual end state, not the last exception.
    try:
        return not path.exists()
    except OSError:
        return False


def gc_orphan_part_dirs(max_age_seconds: int = GC_MAX_AGE_SECONDS) -> list[str]:
    """Delete orphaned ``.runtime/uploads/up_*`` part dirs; return their names.

    A part dir is removed only when BOTH guards hold:

    * it is NOT in the live registry (at startup the registry is empty, so every
      pre-existing dir qualifies — the in-memory protocol cannot resume across a
      restart anyway), AND
    * its mtime is older than ``max_age_seconds`` (default 48 h) — the
      belt-and-suspenders guard so nothing plausibly active (e.g. a fast dev
      restart mid-upload) is ever touched.

    Best-effort and side-effect-free on failure: unreadable entries are skipped,
    a partially-removed dir is not reported as removed, and nothing here raises.
    """
    removed: list[str] = []
    try:
        entries = list(settings.UPLOADS_DIR.iterdir())
    except OSError:
        return removed
    live = registry.live_ids()
    now = time.time()
    for entry in entries:
        try:
            if not entry.is_dir() or not entry.name.startswith("up_"):
                continue
            if entry.name in live:
                continue  # never touch an active upload
            if now - entry.stat().st_mtime < max_age_seconds:
                continue
        except OSError:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        if not entry.exists():
            removed.append(entry.name)
    return removed


class UploadRegistry:
    def __init__(self) -> None:
        self._uploads: dict[str, UploadSession] = {}
        # Insertion-ordered (FIFO-evicted) tombstones for explicitly destroyed
        # uploads: upload_id -> time of removal. See _CANCEL_TOMBSTONE_CAP.
        self._cancelled: dict[str, float] = {}
        self._lock = threading.Lock()

    def create(
        self,
        session_id: str,
        dest_folder: Path,
        filename: str,
        size_bytes: int,
        chunk_size: int,
        owner: str = "",
        client_id: str | None = None,
    ) -> UploadSession:
        upload_id = f"up_{secrets.token_hex(4)}"
        part_dir = settings.UPLOADS_DIR / upload_id
        part_dir.mkdir(parents=True, exist_ok=True)
        total_chunks = max(1, math.ceil(size_bytes / chunk_size)) if size_bytes > 0 else 1
        sess = UploadSession(
            upload_id=upload_id,
            session_id=session_id,
            dest_folder=dest_folder,
            filename=filename,
            size_bytes=size_bytes,
            chunk_size=chunk_size,
            total_chunks=total_chunks,
            part_dir=part_dir,
            owner=owner,
            client_id=client_id,
        )
        with self._lock:
            self._uploads[upload_id] = sess
            # Paranoia: token_hex(4) ids are random, but if one ever collided
            # with a lingering tombstone the fresh upload would be unkillable —
            # a new registration always clears any same-id tombstone.
            self._cancelled.pop(upload_id, None)
        return sess

    def get(self, upload_id: str) -> UploadSession | None:
        with self._lock:
            return self._uploads.get(upload_id)

    def find_resumable(
        self,
        owner: str,
        session_id: str,
        client_id: str,
        filename: str,
        size_bytes: int,
        chunk_size: int,
    ) -> UploadSession | None:
        """Find the live upload matching this exact resume identity, or None.

        Identity = (owner, session_id, client_id) AND an IDENTICAL
        filename/size_bytes/chunk_size declaration — a same-client_id init whose
        file metadata differs never resumes the wrong bytes (it falls through to
        a fresh upload). Keyed on the authenticated owner + the caller's OWN
        session, so a client_id can never resolve another user's upload.
        In-memory only: a server restart empties the registry, so a post-restart
        re-init cleanly creates a fresh upload (by design, no error).
        """
        if not client_id:
            return None
        with self._lock:
            for sess in self._uploads.values():
                if (
                    sess.owner == owner
                    and sess.session_id == session_id
                    and sess.client_id == client_id
                    and sess.filename == filename
                    and sess.size_bytes == size_bytes
                    and sess.chunk_size == chunk_size
                ):
                    return sess
        return None

    def live_ids(self) -> set[str]:
        """Snapshot of the upload_ids currently in the registry (GC guard)."""
        with self._lock:
            return set(self._uploads)

    def remove(self, upload_id: str) -> None:
        """Discard a session AND delete its parts (explicit abort / permanent-
        incomplete only — TRANSIENT failures never reach this method, so a 499
        disconnect or a retryable assemble error always leaves parts resumable).

        The upload_id is TOMBSTONED atomically with the registry pop (same lock
        hold), BEFORE any cleanup is attempted — so a chunk PUT that is still
        streaming when the cancel lands is guaranteed to observe the cancel via
        ``is_cancelled`` once its write finishes, refuse to commit, and sweep
        the part dir itself ("last writer sweeps", ``routers/upload.py``).

        The part-dir delete then retries briefly (``remove_tree_with_retry``) —
        this reclaims the NO-writer case instantly. When a racing chunk PUT
        holds its open ``.part``/``.part.tmp`` handle (Windows), the bounded
        retry loses by design (an in-flight 8 MB write outlasts any retry short
        enough for a request handler): the dir is left for that writer's
        tombstone sweep, with the 48 h boot GC as the last-resort backstop
        (logged once, request never fails).
        """
        with self._lock:
            sess = self._uploads.pop(upload_id, None)
            if sess is not None:
                self._cancelled[upload_id] = time.time()
                while len(self._cancelled) > _CANCEL_TOMBSTONE_CAP:
                    self._cancelled.pop(next(iter(self._cancelled)))
        if sess is None:
            return
        if not remove_tree_with_retry(sess.part_dir):
            logger.warning(
                "upload abort: part dir %s is locked and was left on disk; "
                "the in-flight writer's tombstone sweep (or the boot GC) "
                "will collect it", sess.part_dir.name,
            )

    def is_cancelled(self, upload_id: str) -> bool:
        """True when ``upload_id`` was explicitly destroyed via ``remove``
        (user cancel, or the permanent-incomplete discard in ``complete``).

        Consulted by late in-flight chunk writers AFTER their streaming write
        finishes: a cancel that raced the write means DO NOT COMMIT — the
        writer drops its temp, best-effort removes the whole part dir (its own
        handle is closed by then, so the delete that just failed for the
        DELETE handler now succeeds), and answers 404 ``upload_not_found``.
        """
        with self._lock:
            return upload_id in self._cancelled

    def forget(self, upload_id: str) -> None:
        """Drop the session entry WITHOUT deleting parts.

        Used after a successful ``assemble`` (which already removed the part
        dir): we only need to free the registry slot, never destroy data.
        """
        with self._lock:
            self._uploads.pop(upload_id, None)


registry = UploadRegistry()
