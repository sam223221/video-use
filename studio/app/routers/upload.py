"""Chunked / resumable upload (contract §18-§22).

Three-phase protocol with validation at the boundary:

* POST   /api/upload/init               -> validate session/ext/size/disk, create upload
* PUT    /api/upload/{id}/chunk?index=n -> write one chunk (idempotent)
* GET    /api/upload/{id}/status        -> received / missing chunks (resume)
* POST   /api/upload/{id}/complete      -> assemble into the session dir + verify size
* DELETE /api/upload/{id}               -> abort, delete parts

Per-user session model: ``init`` carries ``session_id`` (NOT a raw dest folder) —
the server derives the destination as the caller's OWNED session dir via
``deps.require_session_dir`` (uniform 404 session_not_found on a bad / cross-user
/ missing id). The assembled file lands in that session dir; chunk PARTS live in
``.runtime/uploads/<upload_id>/``. ``complete`` touches the session's stale clock.

Extension allowlist mirrors the helpers' VIDEO_EXTS (compared case-insensitively
since the red-thread pass — ``CLIP.M4V`` is accepted, and the STORED suffix is
normalized to the canonical in-allowlist spelling, ``CLIP.M4V`` -> ``CLIP.m4v``,
so case-sensitive helper discovery still finds the file); size cap MAX_UPLOAD
(8 GiB); filename sanitized; free-disk guard. A missing / not-owned upload_id is
a uniform 404 ``upload_not_found`` (distinct from ``session_not_found`` — the
client's restart self-heal keys on it).

Resume-by-identity (``client_id``): ``init`` may carry an opaque client-stable
id (``[A-Za-z0-9_-]{8,64}``; anything else is treated as absent, never a 400).
A re-init matching a LIVE upload's (owner, session_id, client_id) with an
identical filename+size+chunk_size returns 200 with the SAME ``upload_id`` and
``received: [int, ...]`` so the client skips done chunks. In-memory only — a
restart falls back to a fresh upload (``received: []``), never an error.

``complete`` never overwrites an existing same-named file: assembly auto-renames
to ``name (2).ext`` on collision and the response ``path`` carries the filename
ACTUALLY stored.

Cancel-vs-writer race (tombstone + "last writer sweeps"): an explicit DELETE
tombstones the upload_id in the registry atomically with removing the entry,
because the part-dir delete can FAIL on Windows while a still-streaming chunk
PUT holds its ``.part.tmp`` handle open (the live defect: the late PUT then
committed, returned 200, and the dir leaked ~8 MB per cancel until the >48 h
boot GC). Every chunk PUT therefore re-checks the tombstone the moment its own
handle is closed — BEFORE committing the chunk — and on a cancelled upload it
discards the temp, best-effort removes the whole part dir itself, and answers
404 ``upload_not_found`` (never a 200, never a 500; the cancelling client has
already moved on). The blessed 499 ``client_disconnected`` path runs the same
sweep. Non-cancelled uploads are byte-identical to before.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from starlette.requests import ClientDisconnect

from .. import security, settings
from ..core import sessions, uploads
from . import deps

router = APIRouter(prefix="/api/upload", tags=["upload"])

_DEFAULT_CHUNK = 8 * 1024 * 1024  # 8 MiB

# The opaque resume id the client derives per file (name+size+lastModified).
# Strictly URL-safe charset, bounded length — anything else is IGNORED (treated
# as absent), see init() below.
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class InitBody(BaseModel):
    session_id: str
    filename: str
    size_bytes: int
    chunk_size: int = _DEFAULT_CHUNK
    content_type: str | None = None
    client_id: str | None = None


@router.post("/init")
def init(body: InitBody, user: str = Depends(deps.require_session)) -> dict:
    # Resolve destination = the caller's OWNED session dir (ownership chokepoint).
    _user, session_id, dest = deps.require_session_dir(user, body.session_id)
    if not dest.is_dir():
        raise deps.http_error(404, "session_not_found", "session not found")

    # Validate filename + extension (authoritative over content_type).
    try:
        filename = security.sanitize_filename(body.filename)
    except ValueError as exc:
        raise deps.http_error(400, "invalid_filename", str(exc))

    # Size cap.
    if body.size_bytes < 0:
        raise deps.http_error(400, "invalid_size", "size_bytes must be >= 0")
    if body.size_bytes > settings.MAX_UPLOAD_BYTES:
        raise deps.http_error(
            413, "upload_too_large",
            f"file exceeds the {settings.MAX_UPLOAD_BYTES} byte cap",
        )

    # Chunk size sanity.
    chunk_size = body.chunk_size if body.chunk_size > 0 else _DEFAULT_CHUNK

    # client_id resume (in-memory only). The client sends an opaque, per-file
    # stable id so a re-init after a dropped connection / page reload finds its
    # own in-flight upload and resumes instead of restarting at chunk 0.
    # Validation is strict but NON-FATAL by design: a malformed client_id is
    # treated as ABSENT (the init degrades to a fresh, non-resumable upload)
    # rather than a 400 — completing the upload is the whole point of this
    # field, so a buggy/older client must still get a working upload. The
    # lookup is keyed on the AUTHENTICATED owner + the caller's OWN session, so
    # a client_id can never resolve another user's upload (Plan §6).
    client_id = (
        body.client_id
        if body.client_id and _CLIENT_ID_RE.fullmatch(body.client_id)
        else None
    )
    if client_id is not None:
        existing = uploads.registry.find_resumable(
            user, session_id, client_id, filename, body.size_bytes, chunk_size
        )
        if existing is not None:
            # Identical identity + declaration -> hand back the SAME upload_id
            # with the chunks already received, so the client skips them. Prune
            # any received index whose part file vanished from disk first — the
            # client must never skip a chunk we cannot assemble.
            existing.prune_missing_parts()
            return {
                "upload_id": existing.upload_id,
                "chunk_size": existing.chunk_size,
                "total_chunks": existing.total_chunks,
                "received": existing.received_sorted(),
            }
    # NOTE: a server restart empties the registry, so a post-restart re-init
    # simply falls through here and creates a fresh upload — clean fallback,
    # never an error (resume does NOT survive a restart by design).

    # Free-disk guard.
    try:
        free = shutil.disk_usage(str(dest)).free
        if free < body.size_bytes:
            raise deps.http_error(
                507, "insufficient_storage",
                "not enough free disk space for this upload",
            )
    except OSError:
        pass  # if we can't check, proceed; complete() re-verifies size

    sess = uploads.registry.create(
        session_id, dest, filename, body.size_bytes, chunk_size,
        owner=user, client_id=client_id,
    )
    return {
        "upload_id": sess.upload_id,
        "chunk_size": sess.chunk_size,
        "total_chunks": sess.total_chunks,
        "received": [],
    }


def _owned_upload(user: str, upload_id: str) -> "uploads.UploadSession":
    """Fetch an upload session and confirm the caller owns its target session.

    The ``upload_id`` is an unguessable random token, but we still re-check
    ownership of the bound ``session_id`` so a leaked id can never let another
    user touch the upload (defense in depth, IDOR-safe). A missing upload OR a
    session the caller does not own both surface as a UNIFORM 404
    ``upload_not_found`` — the frontend keys its restart self-heal on exactly
    this code (``upload.js`` ``canResume``/``errorMessage``: a stale id after a
    server restart re-inits with the same client_id and shows Resume, instead
    of the dead-end "session no longer exists" copy). Upload ids are
    unguessable, so the distinct code leaks nothing enumerable (Plan §6).
    """
    sess = uploads.registry.get(upload_id)
    if sess is None:
        raise deps.http_error(404, "upload_not_found", "upload session not found")
    if sessions.resolve_dir(user, sess.session_id) is None:
        raise deps.http_error(404, "upload_not_found", "upload session not found")
    return sess


def _sweep_cancelled(sess: uploads.UploadSession, tmp: Path | None = None) -> bool:
    """Last-writer sweep: detect a cancel that raced this in-flight request.

    A user cancel (``DELETE /api/upload/{id}``) that lands while a chunk PUT is
    still streaming cannot delete the part dir on Windows — the PUT's open
    ``.part.tmp`` handle makes the DELETE's bounded rmtree fail and the dir is
    stranded (historically ~8 MB per cancel until the >48 h boot GC).
    ``registry.remove`` therefore tombstones the upload_id BEFORE attempting
    its delete, and every chunk PUT re-checks that tombstone once its OWN file
    handle is closed. If the upload was cancelled mid-request: drop the temp
    (when given), make ONE immediate best-effort attempt to remove the whole
    part dir (no retry sleeps — handler latency stays flat; with the writer's
    handle closed this normally succeeds), and return True so the caller
    answers 404 ``upload_not_found`` instead of committing the chunk. With two
    concurrent writers the first sweep may fail on the other's open handle —
    the LAST writer's sweep then succeeds, hence the name. Returns False, with
    ZERO side effects, for live (non-cancelled) uploads.
    """
    if not uploads.registry.is_cancelled(sess.upload_id):
        return False
    if tmp is not None:
        tmp.unlink(missing_ok=True)
    uploads.remove_tree_with_retry(sess.part_dir, delays=(0.0,))
    return True


@router.put("/{upload_id}/chunk")
async def put_chunk(
    upload_id: str,
    request: Request,
    index: int = Query(...),
    user: str = Depends(deps.require_session),
) -> dict:
    sess = _owned_upload(user, upload_id)

    # Validate the chunk index up front (before touching the body).
    if index < 0 or index >= sess.total_chunks:
        raise deps.http_error(
            400, "bad_index",
            f"chunk index {index} out of range 0..{sess.total_chunks - 1}",
        )

    part_path = sess.part_path(index)

    # Idempotent: a re-PUT of an already-received chunk is a no-op success.
    # Drain the request body without buffering so the connection closes cleanly.
    if index in sess.received and part_path.exists():
        try:
            async for _ in request.stream():
                pass
        except ClientDisconnect:
            # Client dropped mid-drain. Symmetric with the main-write path:
            # ClientDisconnect is a plain Exception (NOT an OSError) and would
            # otherwise escape as a generic 500. The chunk itself stays
            # committed — it was received by an earlier PUT and is never
            # unmarked here — so the session remains resumable/completable.
            # But the CLIENT did not get a response on this connection, so per
            # the documented contract (PM/conventions.md: 499 on BOTH the main
            # write AND the idempotent re-PUT drain) report the same resumable
            # 499 client_disconnected; the client's retry re-PUTs this index
            # and lands back in this idempotent branch for a cheap success.
            # If an explicit cancel ALSO raced this drain, the tombstone sweep
            # must still run — the 499 path must never strand the part dir.
            _sweep_cancelled(sess)
            raise deps.http_error(
                499, "client_disconnected",
                "client disconnected before the chunk was fully received",
            )
        # Cancel race: a DELETE may have tombstoned this upload while the body
        # was draining. The drain holds no file handle, so the DELETE usually
        # removed the dir already (the sweep is belt-and-suspenders) — answer
        # 404 upload_not_found, NOT a 200 (and NOT the stat below, whose part
        # file may be gone). Non-cancelled drains are unchanged.
        if _sweep_cancelled(sess):
            raise deps.http_error(404, "upload_not_found", "upload session not found")
        return {
            "index": index,
            "received": sess.received_sorted(),
            "bytes_received": part_path.stat().st_size,
        }

    # Stream the body to disk in bounded reads, aborting the moment the running
    # total would exceed the per-chunk expected size or the global cap — so an
    # oversized chunk can never be fully buffered in RAM (BUG-04).
    max_chunk = sess.expected_chunk_size(index)
    tmp = part_path.with_suffix(".part.tmp")
    # Opportunistically clear a STALE leftover temp from a previous aborted PUT
    # of THIS SAME index (scoped to this upload_id/index — never a broad delete).
    tmp.unlink(missing_ok=True)
    written = 0
    try:
        with open(tmp, "wb") as out:
            async for piece in request.stream():
                if not piece:
                    continue
                written += len(piece)
                # Per-chunk bound (cheap, no lock) — abort before writing more.
                if written > max_chunk:
                    raise uploads.UploadTooLarge(
                        f"chunk {index} exceeds expected {max_chunk} bytes"
                    )
                # Cumulative-cap bound across the whole upload.
                sess.check_chunk_size(index, written)
                out.write(piece)
            out.flush()
            os.fsync(out.fileno())
    except uploads.UploadTooLarge as exc:
        tmp.unlink(missing_ok=True)
        if _sweep_cancelled(sess):
            raise deps.http_error(404, "upload_not_found", "upload session not found")
        raise deps.http_error(413, "upload_too_large", str(exc))
    except ClientDisconnect:
        # Client (e.g. a phone on weak Wi-Fi) dropped the connection mid-chunk.
        # Starlette raises ClientDisconnect (a plain Exception, NOT an OSError),
        # so it would otherwise escape as a generic 500 and leave an orphaned
        # ``<index>.part.tmp`` on disk. Clean up the partial temp and return a
        # clean 499 (client closed request); the chunk is NOT marked received,
        # so the session stays resumable and the client can re-PUT this index.
        # A user CANCEL may have raced this chunk too (the client aborts the
        # fetch, then sends DELETE): keep the documented 499 contract, but run
        # the tombstone sweep so the dir the DELETE could not remove (this
        # handler's tmp handle was still open) is reclaimed now, not at boot.
        tmp.unlink(missing_ok=True)
        _sweep_cancelled(sess)
        raise deps.http_error(
            499, "client_disconnected",
            "client disconnected before the chunk was fully received",
        )
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        if _sweep_cancelled(sess):
            raise deps.http_error(404, "upload_not_found", "upload session not found")
        raise deps.http_error(500, "write_failed", f"could not write chunk: {exc}")

    # Cancel-race guard ("last writer sweeps"): the user may cancel while this
    # chunk is streaming — the DELETE tombstones + pops the registry entry, but
    # its rmtree fails on Windows because THIS handler still holds the open
    # ``.part.tmp`` handle, stranding the dir. Our handle is closed here, so
    # re-check BEFORE committing: on a cancel, discard the temp, remove the
    # whole part dir ourselves, and answer 404 upload_not_found — a cancelled
    # upload must never gain a committed chunk (the live defect: the late PUT
    # returned 200 and the persisted part leaked ~8 MB per real cancel until
    # the >48 h boot GC).
    if _sweep_cancelled(sess, tmp):
        raise deps.http_error(404, "upload_not_found", "upload session not found")

    try:
        tmp.replace(part_path)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        # A cancel can land BETWEEN the guard above and the replace: with no
        # handle open any more the DELETE's rmtree succeeds and yanks the dir
        # out from under the replace. That is a cancel, not a server fault —
        # sweep + 404, never a 500.
        if _sweep_cancelled(sess):
            raise deps.http_error(404, "upload_not_found", "upload session not found")
        raise deps.http_error(500, "write_failed", f"could not write chunk: {exc}")

    sess.note_part_written(index, written)

    # Final re-check: a cancel landing after the replace has normally rmtree'd
    # cleanly itself (nothing was locked), but if it interleaved with the
    # commit the committed part could survive — sweep it and report the upload
    # gone. For live uploads this is a no-op and the response is unchanged.
    if _sweep_cancelled(sess):
        raise deps.http_error(404, "upload_not_found", "upload session not found")

    return {
        "index": index,
        "received": sess.received_sorted(),
        "bytes_received": written,
    }


@router.get("/{upload_id}/status")
def status(upload_id: str, user: str = Depends(deps.require_session)) -> dict:
    sess = _owned_upload(user, upload_id)
    return {
        "received": sess.received_sorted(),
        "missing": sess.missing(),
        "total_chunks": sess.total_chunks,
        "complete": sess.complete,
    }


@router.post("/{upload_id}/complete")
def complete(upload_id: str, user: str = Depends(deps.require_session)) -> dict:
    sess = _owned_upload(user, upload_id)

    if not sess.complete:
        raise deps.http_error(
            409, "incomplete", "missing chunks",
            detail={"missing": sess.missing()},
        )

    try:
        out_path = sess.assemble()
    except ValueError as exc:
        # Permanent: missing chunk or size mismatch — discard parts + session.
        uploads.registry.remove(upload_id)
        raise deps.http_error(409, "incomplete", str(exc))
    except OSError as exc:
        # Possibly transient (AV/indexer lock on the dest, network-drive hiccup).
        # Leave the parts + session intact so /complete can be retried without
        # forcing the client to re-upload the whole (up to 8 GiB) file (BUG-18).
        raise deps.http_error(500, "assemble_failed", f"could not assemble file: {exc}")

    # Success: assemble() already removed the part dir — just free the registry
    # slot (no destructive cleanup).
    uploads.registry.forget(upload_id)

    # A completed upload is activity on the session — reset its stale clock.
    sessions.touch(user, sess.session_id)

    try:
        size = out_path.stat().st_size
    except OSError:
        size = sess.size_bytes

    return {"ok": True, "path": str(out_path), "size_bytes": size}


@router.delete("/{upload_id}")
def abort(upload_id: str, user: str = Depends(deps.require_session)) -> dict:
    # Only the owner may abort; an unknown/cross-user id is a silent no-op success
    # (DELETE is idempotent and must not reveal whether the id exists).
    # registry.remove TOMBSTONES the upload_id first (atomically with the pop),
    # then deletes the part dir ON THE SPOT with a brief bounded retry — the
    # no-writer case is reclaimed instantly, and the retry stays sub-second by
    # design (never seconds of handler latency). When the cancel races a chunk
    # PUT that is STILL streaming, that writer's open .part.tmp handle makes
    # the rmtree fail on Windows for the whole duration of its write (an 8 MB
    # chunk on a slow link outlasts any sane retry): the tombstone makes the
    # WRITER finish the job — it refuses to commit, sweeps the dir itself once
    # its handle closes, and answers 404 upload_not_found ("last writer
    # sweeps", see _sweep_cancelled). The 48 h boot GC remains the last-resort
    # backstop only. This is a sync handler (threadpool), so the retry sleeps
    # never block the event loop. Transient failures (499 / retryable
    # assemble) never call remove — resume semantics unchanged.
    sess = uploads.registry.get(upload_id)
    if sess is not None and sessions.resolve_dir(user, sess.session_id) is not None:
        uploads.registry.remove(upload_id)
    return {"ok": True}
