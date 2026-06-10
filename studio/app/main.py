"""video-use Studio — FastAPI application factory.

Wires the full backend (brief Delta 1/2/3):

* Session-cookie auth is the SINGLE auth mechanism. Login/logout/me + the SPA at
  ``/`` and ``/static/*`` are PUBLIC; everything else under ``/api/*`` is gated by
  the per-router ``require_session`` dependency (so a missing/invalid cookie ->
  401, including SSE and media endpoints — the browser sends the cookie
  automatically).
* All routers are mounted here.
* The startup banner (URLs + login credentials + QR + firewall hint) is printed
  once on startup via ``net.startup_banner``.

The SPA itself lives in ``studio/frontend/`` (owned by the Frontend Engineer) and
is served as static assets; this module never touches it beyond serving it.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from . import net, settings
from .core import sessions as sessions_store
from .core import uploads as uploads_store
from .routers import (
    auth,
    chat,
    files,
    inventory,
    outputs,
    sessions,
    status,
    transcribe,
    transcripts,
    upload,
)

logger = logging.getLogger("studio")

# The owner that imported legacy (pre-v2) data is assigned to. Locked decision.
_LEGACY_OWNER = "Sam"
_LEGACY_IMPORT_NAME = "Imported footage"


def _is_inside(child: Path, parent: Path) -> bool:
    """True if ``child`` is ``parent`` or a descendant (lexical, case-folded NT)."""
    try:
        c = os.path.normcase(os.path.normpath(str(child)))
        p = os.path.normcase(os.path.normpath(str(parent)))
    except (ValueError, OSError):
        return False
    return c == p or c.startswith(p + os.sep)


def _legacy_active_folder() -> str | None:
    """Read the legacy ``state.json`` active_folder, or None (best-effort)."""
    try:
        data = json.loads(settings.STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    folder = data.get("active_folder")
    return folder if isinstance(folder, str) and folder else None


def _import_legacy_transcript(legacy_folder: str, session_dir: Path) -> bool:
    """Import the legacy ``.runtime/sessions/<hash>.json`` transcript, if present.

    The legacy transcript was keyed by a hash of the (lower-cased on NT) folder
    path. Mirror that hashing to find it and write its ``messages`` into the new
    session's ``transcript.json``. Returns True if a transcript was imported.
    """
    import hashlib

    norm = legacy_folder.lower() if os.name == "nt" else legacy_folder
    digest = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]
    legacy_path = settings.SESSIONS_DIR / f"{digest}.json"
    if not legacy_path.is_file():
        return False
    try:
        data = json.loads(legacy_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    messages = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(messages, list):
        return False
    out = sessions_store.transcript_path(session_dir)
    tmp = out.with_suffix(out.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps({"messages": messages}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, out)
    except OSError as exc:
        # A failed transcript import is NON-FATAL: the videos matter more than
        # the chat history. Log it and leave the marker logic to the caller (the
        # video moves decide whether the migration is "done"). Best-effort clean
        # up the temp file so a retry is not blocked by a stale .tmp.
        logger.warning("migrate_v2: could not import legacy transcript: %s", exc)
        try:
            tmp.unlink()
        except OSError:
            pass
        return False
    return True


def _find_prior_import_session(session_dir_of) -> str | None:
    """Return the id of a pre-existing Sam-owned "Imported footage" session, or None.

    A previous boot may have created the import session and then died mid-move
    (transient Windows lock) without writing the ``migrated_v2`` marker. On the
    next boot we MUST reuse that session rather than create a second one. We
    detect it by scanning Sam's sessions for one named ``_LEGACY_IMPORT_NAME``;
    the newest such session is reused. ``session_dir_of`` is injected for testing
    but defaults to the real resolver. Best-effort: any error -> None (so we fall
    back to creating a fresh session, which is still correct, just not dedup'd).
    """
    try:
        existing = sessions_store.list_for(_LEGACY_OWNER)
    except Exception:  # noqa: BLE001 - detection is best-effort
        return None
    # list_for returns newest-touched first; reuse the most recent legacy import.
    for sess in existing:
        if sess.name == _LEGACY_IMPORT_NAME and session_dir_of(sess.id) is not None:
            return sess.id
    return None


def _merge_edit_dir(legacy_edit: Path, dest_edit: Path) -> int:
    """Move the CHILDREN of ``legacy_edit`` into ``dest_edit``; return failure count.

    ``create()`` already made an empty ``dest_edit``; the legacy ``edit/`` carries
    the imported transcripts/outputs that outputs.py / transcripts.py / relay only
    ever read from ``<session_dir>/edit/``. So we MERGE the legacy children INTO
    ``dest_edit`` (rather than relocating the whole dir to ``edit_imported/``,
    which would hide those outputs). Idempotent + non-destructive:

      * a child whose destination already exists is skipped (already migrated),
      * a per-child move failure (lock/collision) is counted and left in place,
      * the now-(maybe-)empty legacy ``edit/`` is removed only if it ends empty.

    Returns the number of children that FAILED to move (0 == clean merge).
    """
    failed = 0
    dest_edit.mkdir(parents=True, exist_ok=True)
    try:
        children = sorted(legacy_edit.iterdir())
    except OSError as exc:
        logger.warning("migrate_v2: could not read legacy edit/ dir: %s", exc)
        return 1
    for child in children:
        target = dest_edit / child.name
        if target.exists():
            # Already merged on a prior partial run — leave it, drop the source so
            # the legacy edit/ can eventually be emptied + removed.
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            except OSError as exc:
                failed += 1
                logger.warning(
                    "migrate_v2: edit/ child %s already present but source not "
                    "removable: %s", child.name, exc,
                )
            continue
        try:
            shutil.move(str(child), str(target))
        except OSError as exc:
            failed += 1
            logger.warning("migrate_v2: could not merge edit/%s: %s", child.name, exc)
    # Remove the legacy edit/ only when it is fully drained (rmdir fails if not).
    try:
        legacy_edit.rmdir()
    except OSError:
        pass  # not empty (a child failed to move) or a transient lock — harmless
    return failed


def _migrate_v2() -> None:
    """One-time, idempotent migration to the per-user session model.

    Guarded by the ``.runtime/migrated_v2`` marker — if present, this is a no-op.
    Otherwise:

    * If the legacy ``state.json`` ``active_folder`` EXISTS and is INSIDE
      ``.runtime`` (the live case: it points at ``.runtime/uploads`` holding the
      user's videos + an ``edit/`` dir), use ONE "Imported footage" session owned
      by ``Sam`` — REUSING a prior partial-import session if one exists (so a
      retry never creates a duplicate), else creating it (created_at/
      last_touched_at = now, so it is not instantly stale). MOVE the videos into
      the session dir and MERGE the legacy ``edit/`` children into the session's
      ``edit/`` (outputs/transcripts/relay only read ``<session_dir>/edit/``). A
      move within ``.runtime`` is same-volume + atomic and NON-DESTRUCTIVE —
      ``shutil.move`` only removes the source on success, so an error never
      deletes an original. Finally, import the legacy transcript (NON-FATAL).
    * If ``active_folder`` is OUTSIDE ``.runtime`` (a real on-disk footage dir),
      MOVE NOTHING (never relocate a user's real footage) and skip the import.
    * If there is nothing to migrate, just write the marker.

    The ``migrated_v2`` marker is written ONLY when every video + every edit/
    child moved cleanly (``failed == 0``). If ANY entry could not be moved (a
    transient Windows lock from AV/indexer/open handle, or a merge collision) the
    marker is LEFT UNWRITTEN so the next clean boot retries the stragglers and
    REUSES the same session — no footage is ever stranded-and-forgotten and no
    duplicate session is created. A failed transcript import does NOT block the
    marker (the videos matter more). Migration never blocks boot — any unexpected
    exception is logged, not raised, and also leaves the marker unwritten.
    """
    if settings.MIGRATED_MARKER.exists():
        return

    try:
        settings.USER_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)

        legacy = _legacy_active_folder()
        if not legacy:
            logger.info("migrate_v2: nothing to migrate (no legacy active_folder)")
            settings.MIGRATED_MARKER.write_text(
                json.dumps({"migrated_at": int(time.time()), "imported": False}),
                encoding="utf-8",
            )
            return

        legacy_path = Path(legacy)
        if not legacy_path.is_dir():
            logger.info("migrate_v2: legacy active_folder does not exist — marker only")
            settings.MIGRATED_MARKER.write_text(
                json.dumps({"migrated_at": int(time.time()), "imported": False}),
                encoding="utf-8",
            )
            return

        if not _is_inside(legacy_path, settings.RUNTIME_DIR):
            # A real on-disk footage dir — never relocate the user's footage.
            logger.info(
                "migrate_v2: legacy active_folder is outside .runtime — not moving "
                "real footage; skipping import"
            )
            settings.MIGRATED_MARKER.write_text(
                json.dumps({"migrated_at": int(time.time()), "imported": False}),
                encoding="utf-8",
            )
            return

        # Live case: REUSE a prior partial import session if one exists (a previous
        # boot created it then died mid-move without writing the marker), else
        # create the Sam-owned "Imported footage" session. This guarantees a retry
        # never produces a second "Imported footage" session.
        def _resolve(session_id: str) -> Path | None:
            return sessions_store.resolve_dir(_LEGACY_OWNER, session_id)

        reused_id = _find_prior_import_session(_resolve)
        if reused_id is not None:
            session_id = reused_id
            logger.info("migrate_v2: reusing prior import session %s", session_id)
        else:
            session_id = sessions_store.create(_LEGACY_OWNER, _LEGACY_IMPORT_NAME).id

        session_dir = _resolve(session_id)
        if session_dir is None:  # pragma: no cover - just created/resolved it
            raise RuntimeError("could not resolve the import session")

        # ``failed`` counts every entry we could NOT move (transient lock, merge
        # collision, unreadable edit/). If it ends > 0 we do NOT write the marker,
        # so the next clean boot retries the stragglers (the ``dest.exists()`` /
        # reuse guards make the re-run idempotent — nothing already moved is
        # touched again, and no duplicate session is created).
        moved_media = 0
        moved_edit = False
        failed = 0
        for entry in sorted(legacy_path.iterdir()):
            if entry.is_file() and entry.suffix in settings.VIDEO_EXTS:
                dest = session_dir / entry.name
                if dest.exists():
                    continue  # already moved on a prior partial run — idempotent
                try:
                    shutil.move(str(entry), str(dest))
                    moved_media += 1
                except OSError as exc:  # noqa: PERF203 - per-entry isolation
                    # Non-destructive: shutil.move only removes the source on
                    # success, so the original stays put. Count it and keep going.
                    failed += 1
                    logger.warning("migrate_v2: could not move %s: %s", entry.name, exc)
            elif entry.is_dir() and entry.name == "edit":
                # MERGE the legacy edit/ children into the created session's edit/
                # (outputs/transcripts/relay only read <session_dir>/edit/). A
                # merge failure is counted so the marker is withheld (fail loud,
                # retry next boot) rather than silently stranding outputs.
                edit_failures = _merge_edit_dir(entry, session_dir / "edit")
                failed += edit_failures
                if edit_failures == 0:
                    moved_edit = True

        # The transcript import is NON-FATAL: the videos matter more than the
        # chat history. The helper already swallows + logs an OSError on the write
        # itself; this outer guard additionally ensures NOTHING in the import path
        # (read/parse/anything) can propagate out of _migrate_v2 — which would hit
        # the outer except, leave the marker unwritten, and cause a duplicate
        # session on the next boot. A failure here never adds to ``failed``.
        try:
            imported_transcript = _import_legacy_transcript(legacy, session_dir)
        except Exception as exc:  # noqa: BLE001 - transcript import is best-effort
            imported_transcript = False
            logger.warning("migrate_v2: legacy transcript import failed: %s", exc)

        logger.info(
            "migrate_v2: import session %s (owner=%s) — %d media moved, "
            "edit/ merged=%s, transcript imported=%s, failed=%d",
            session_id, _LEGACY_OWNER, moved_media, moved_edit,
            imported_transcript, failed,
        )

        if failed > 0:
            # Footage / outputs were left behind (transient lock or collision).
            # Do NOT write the marker so a clean restart retries the stragglers
            # and reuses THIS session (detected via _find_prior_import_session).
            logger.warning(
                "migrate_v2: %d entr%s could not be moved — marker NOT written; "
                "will retry on next boot (session %s reused)",
                failed, "y" if failed == 1 else "ies", session_id,
            )
            return

        settings.MIGRATED_MARKER.write_text(
            json.dumps(
                {
                    "migrated_at": int(time.time()),
                    "imported": True,
                    "session_id": session_id,
                    "owner": _LEGACY_OWNER,
                    "media_moved": moved_media,
                    "edit_moved": moved_edit,
                    "transcript_imported": imported_transcript,
                }
            ),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - migration must never block boot
        logger.error("migrate_v2 failed (will retry next boot): %s", exc)


class _RevalidatingStaticFiles(StaticFiles):
    """StaticFiles that tells the browser to always revalidate before reusing a
    cached asset.

    Returning clients (especially phones) were serving STALE cached assets
    without revalidating, so frontend fixes never reached them until a manual
    hard-reload. We attach ``Cache-Control: no-cache`` to every static file
    response: the browser MAY cache the bytes but MUST revalidate them via the
    conditional ETag / Last-Modified handshake on every load. This is NOT
    ``no-store`` — big assets still get cheap ``304 Not Modified`` responses
    when unchanged; only the freshness check is forced.

    Implemented by overriding ``file_response`` (Starlette's single funnel for
    every static file response, including the ``304`` path it builds for
    ``If-None-Match`` / ``If-Modified-Since``) and setting the header on the
    response Starlette already constructed. Range/206 partial responses for
    media are NOT served by this mount (they live in routers/files.py), so this
    only touches the SPA's JS/CSS/static assets.
    """

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure runtime dirs exist and the session secret is initialized (so cookies
    # work across restarts) before serving.
    settings.RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    settings.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    settings.USER_SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    settings.session_secret()  # warms + persists the signing secret

    # One-time, idempotent migration to the per-user session model (guarded by
    # the .runtime/migrated_v2 marker). Never blocks boot.
    _migrate_v2()

    # Sweep orphaned upload part dirs (.runtime/uploads/up_*) left behind by
    # uploads that never completed before a restart. The in-memory registry is
    # EMPTY at startup, so any pre-existing part dir is by definition not live;
    # the >48 h mtime guard inside gc_orphan_part_dirs is belt-and-suspenders so
    # nothing plausibly active (e.g. a fast dev restart mid-upload) is ever
    # touched. Best-effort — never blocks boot. Runs AFTER _migrate_v2 so the
    # migration sees an unchanged tree (it only reads files/edit/, never up_*).
    try:
        removed = uploads_store.gc_orphan_part_dirs()
        if removed:
            logger.info(
                "upload gc: removed %d orphaned part dir(s): %s",
                len(removed), ", ".join(sorted(removed)),
            )
    except Exception as exc:  # noqa: BLE001 - GC is housekeeping, never fatal
        logger.warning("upload gc failed: %s", exc)

    # Sweep session-delete husks: empty ses_* dirs with no meta.json, left when
    # a Windows handle (typically the agent subprocess cwd) outlived a
    # DELETE /api/sessions in the PREVIOUS server process. That handle died
    # with the old process, so the husks are removable now. Conservative —
    # only truly-empty trees with no meta.json are removed (never user data,
    # never a meta-bearing session) — and best-effort: never blocks boot.
    try:
        swept = sessions_store.sweep_session_husks()
        if swept:
            logger.info(
                "session sweep: removed %d husk dir(s): %s",
                len(swept), ", ".join(sorted(swept)),
            )
    except Exception as exc:  # noqa: BLE001 - housekeeping, never fatal
        logger.warning("session husk sweep failed: %s", exc)

    # Warm the frontend asset_version cache (READ-ONLY regex parse of
    # frontend/app.js for /api/me stale-tab detection). auth.asset_version()
    # never raises and lazily re-reads on mtime change, so a frontend bump
    # reaches /api/me without a backend restart.
    logger.info("frontend asset_version: %s", auth.asset_version() or "unknown")

    # Print the startup banner (URLs, credentials, QR, firewall hint). This is
    # the ONLY place a generated password is surfaced — so it MUST reach stdout
    # even on a non-UTF-8 console (redirected log, Windows service, cp1252 Docker
    # logs). The banner can embed Unicode QR block glyphs (U+2580/2584/2588), so:
    #   1. reconfigure stdout to UTF-8 (errors='replace') when possible, and
    #   2. on any failure, write the raw UTF-8 bytes directly so the credentials
    #      block is never silently lost (logger fallback has no handlers yet).
    banner = net.startup_banner(settings.HOST, settings.PORT)
    try:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass  # stream may not support reconfigure (e.g. wrapped/piped)
        print(banner, flush=True)
    except Exception:  # noqa: BLE001 - banner is best-effort; never block boot
        try:
            sys.stdout.buffer.write(banner.encode("utf-8", "replace"))
            sys.stdout.buffer.flush()
        except Exception:  # noqa: BLE001 - last resort: at least log the bind addr
            logger.info(
                "video-use Studio listening on %s:%s", settings.HOST, settings.PORT
            )

    yield


def create_app() -> FastAPI:
    app = FastAPI(
        title="video-use Studio",
        version=settings.VERSION,
        docs_url=None,   # no public API docs for a single-user LAN tool
        redoc_url=None,
        openapi_url=None,  # also hide the unauthenticated /openapi.json schema
        lifespan=lifespan,
    )

    # --- API routers (each gates itself with require_session except auth) ---
    app.include_router(auth.router)         # /api/login, /api/logout, /api/me (public)
    app.include_router(status.router)       # /api/status
    app.include_router(sessions.router)     # /api/sessions*
    app.include_router(inventory.router)    # /api/inventory
    app.include_router(transcribe.router)   # /api/transcribe*
    app.include_router(transcripts.router)  # /api/transcripts*, /api/packed
    app.include_router(chat.router)         # /api/chat*
    app.include_router(files.router)        # /api/file
    app.include_router(outputs.router)      # /api/outputs
    app.include_router(upload.router)       # /api/upload/*

    # --- SPA shell + static assets (ungated) -------------------------------
    @app.get("/")
    def index() -> FileResponse:
        index_file = settings.FRONTEND_DIR / "index.html"
        if not index_file.is_file():
            # Partial deploy: fail fast with a clean 503 instead of letting
            # Starlette raise at send time (which surfaces as an obscure 500).
            raise HTTPException(
                status_code=503, detail="frontend assets not built"
            )
        # The SPA shell MUST always be revalidated. The cache-busting ``?v=N``
        # query lives INSIDE index.html (on app.js/styles.css), so a stale
        # index.html means the browser never even requests the new versioned
        # assets and keeps running old code. ``no-cache`` lets the browser
        # cache the shell but forces an ETag revalidation on every load, so the
        # asset version bumps reliably reach returning clients (phones) without
        # a manual hard-reload. This is NOT ``no-store`` — an unchanged shell
        # still returns a cheap 304.
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})

    if settings.FRONTEND_DIR.is_dir():
        app.mount(
            "/static",
            _RevalidatingStaticFiles(directory=str(settings.FRONTEND_DIR)),
            name="static",
        )

    return app


app = create_app()
