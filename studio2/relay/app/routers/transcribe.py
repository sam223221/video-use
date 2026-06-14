"""The transcription HTTP surface (arch §3 + §8.1) — THE one media exception.

Three cookie-authenticated routes, all on the v1 error envelope
(``{detail:{error:{code,message}}}``) and the never-500 discipline:

* ``POST /api/transcribe`` — the device streams the clip's audio-only ``.m4a``
  as a RAW body (arch §3.1). NO multipart parsing server-side: the body is
  read in chunks straight to a job-named spool file, counted against the hard
  256 MiB cap as it arrives, and a 413 is raised the MOMENT the cap is crossed
  (the partial spool deleted) — the M1 §8.5 "no parsing surface" property is
  preserved VERBATIM (no ``UploadFile``/``Form``/``File``/``request.form()``,
  python-multipart stays out of requirements). Query params validated; on
  acceptance the EL call is launched as a DETACHED task and a 202
  ``{job_id, est_cost_usd}`` returns immediately — the work now survives the
  phone locking (arch §2.1). The EL multipart is built OUTBOUND by httpx in
  ``core/transcribe.py``; this route never sees a multipart byte.

* ``GET /api/transcribe/{job_id}`` — the lock-proof poll (arch §3.2):
  ``transcribing`` / ``done`` (with the §4.2 transcript) / ``error``. Jobs are
  keyed to the authenticated user; a foreign/unknown/expired/post-restart id
  is a uniform 404 ``job_not_found`` (the §8.7 anti-IDOR posture). The first
  ``done`` fetch marks the job delivered; a 120 s grace covers a re-poll, then
  the relay forgets.

* ``DELETE /api/transcribe/{job_id}`` — best-effort cancel (arch §3.3):
  aborts the detached task, deletes the spool, ``200 {cancelled:bool}``; same
  uniform 404 rules. (Honest UI copy: a cancel after the audio reached EL may
  still be billed.)

Streaming + manual-cap + never-500 mirror ``client_log.py`` / ``bridge.py``
exactly. A ``ClientDisconnect`` mid-upload is a clean 499 with NO EL call and
NO cost (the job slot is released, the partial spool deleted).
"""

from __future__ import annotations

import logging
import math
import re

from fastapi import APIRouter, Depends, Query, Request
from starlette.requests import ClientDisconnect

from .. import settings
from ..core import transcribe as svc
from . import deps

router = APIRouter(prefix="/api", tags=["transcribe"])

_log = logging.getLogger("studio2.transcribe")

# Id + param validators (arch §3.1/§3.2). Same regex discipline as bridge.py.
_PROJECT_ID_RE = re.compile(r"^prj_[0-9a-f]{12}$")
_CLIP_ID_RE = re.compile(r"^clip_[0-9a-f]{8}$")
_JOB_ID_RE = re.compile(r"^tr_[0-9a-f]{12}$")
_LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")

# Only this content-type is accepted (arch §3.1) — the device controls the
# header, so strictness is free. A bare ``audio/mp4`` or one with parameters
# (``audio/mp4; codecs=...``) both pass; anything else is 400.
_ALLOWED_CONTENT_TYPE = "audio/mp4"

# Read the streamed body in this granularity. The cap is enforced against the
# RAW bytes as they arrive (arch §8.1) so an oversized body is rejected after
# at most cap + one chunk has touched disk — never fully buffered.
_SPOOL_CHUNK_BYTES = 1024 * 1024  # informational; httpx/uvicorn pick the size


def _validate_accept_params(
    project_id: str, clip_id: str, duration_s: float, language: str | None
) -> tuple[str, str, float, str | None]:
    """Validate the POST query params (arch §3.1). Raises 400 ``invalid_request``
    on anything malformed — BEFORE a single body byte is read or a job slot is
    reserved."""
    if not _PROJECT_ID_RE.match(project_id or ""):
        raise deps.http_error(
            400, "invalid_request", "project_id must match prj_<12 hex chars>"
        )
    if not _CLIP_ID_RE.match(clip_id or ""):
        raise deps.http_error(
            400, "invalid_request", "clip_id must match clip_<8 hex chars>"
        )
    # duration_s: finite, 0 < d <= the soft per-call cap. DEVICE-DECLARED — the
    # cost estimate basis only; the HARD guard is the byte cap below.
    try:
        dur = float(duration_s)
    except (TypeError, ValueError):
        raise deps.http_error(400, "invalid_request", "duration_s must be a number")
    if math.isnan(dur) or math.isinf(dur) or dur <= 0:
        raise deps.http_error(
            400, "invalid_request", "duration_s must be a positive, finite number"
        )
    if dur > settings.TRANSCRIBE_MAX_DURATION_S:
        raise deps.http_error(
            400, "invalid_request",
            f"this clip is longer than the {settings.TRANSCRIBE_MAX_DURATION_MIN}-"
            "minute transcription limit",
        )
    lang: str | None = None
    if language is not None and language != "":
        if not _LANGUAGE_RE.match(language):
            raise deps.http_error(
                400, "invalid_request",
                "language must be a 2- or 3-letter lowercase ISO code",
            )
        lang = language
    return project_id, clip_id, dur, lang


def _content_type_ok(request: Request) -> bool:
    """True when the request's Content-Type is ``audio/mp4`` (bare or with
    parameters). The media subtype is matched case-insensitively; any
    parameters (``; codecs=...``) are ignored."""
    raw = request.headers.get("content-type", "")
    base = raw.split(";", 1)[0].strip().lower()
    return base == _ALLOWED_CONTENT_TYPE


async def _spool_body_capped(request: Request, job: "svc._Job") -> int:
    """Stream the raw request body to the job's spool file, enforcing the hard
    byte cap as bytes arrive (arch §3.1/§8.1).

    Returns the total bytes written. Raises:
      * 413 ``audio_too_large`` the instant the cap is crossed (partial spool
        deleted, job slot released) — the body is NEVER fully buffered,
      * 499 ``client_disconnected`` on a mid-upload drop (spool deleted, slot
        released, NO EL call, NO cost),
      * 400 ``invalid_request`` on an empty body.

    The spool is written incrementally to disk (never RAM): a 256 MiB upload
    costs ~one chunk of RAM at a time.
    """
    cap = settings.TRANSCRIBE_MAX_AUDIO_BYTES
    path = svc.spool_path(job.job_id)
    total = 0
    try:
        # ``xb`` would reject a stale same-name spool; the job_id is fresh so
        # ``wb`` is correct and avoids a spurious collision after a boot sweep
        # miss. Truncate-on-open keeps a retry clean.
        with path.open("wb") as fh:
            async for chunk in request.stream():
                if not chunk:
                    continue
                total += len(chunk)
                if total > cap:
                    # Stop BEFORE buffering past the cap: we've written at most
                    # cap + this chunk; abandon and reject. The body is not
                    # drained further (the connection is closed by the 413).
                    fh.close()
                    svc.abort_unstarted(job, code="audio_too_large")
                    raise deps.http_error(
                        413, "audio_too_large",
                        f"the audio exceeds the {settings.TRANSCRIBE_MAX_AUDIO_MIB} "
                        "MiB limit",
                    )
                fh.write(chunk)
    except ClientDisconnect:
        svc.abort_unstarted(job, code="client_disconnected")
        raise deps.http_error(
            499, "client_disconnected",
            "the upload was interrupted before it finished — no transcription "
            "was started and nothing was charged",
        )
    except OSError as exc:
        # A disk failure spooling the body. Release the slot; never a 500.
        svc.abort_unstarted(job, code="storage_error")
        _log.warning("transcribe spool write failed job_id=%s err=%s", job.job_id, exc)
        raise deps.http_error(
            502, "provider_error", "couldn't stage the audio for transcription"
        )

    if total == 0:
        svc.abort_unstarted(job, code="empty_body")
        raise deps.http_error(400, "invalid_request", "the request body was empty")
    return total


@router.post("/transcribe", status_code=202)
async def transcribe_start(
    request: Request,
    project_id: str = Query(...),
    clip_id: str = Query(...),
    duration_s: float = Query(...),
    language: str | None = Query(default=None),
    user: str = Depends(deps.require_session),
) -> dict:
    """Accept a clip's audio and launch a transcription job (arch §3.1).

    Returns 202 ``{job_id, est_cost_usd}`` on acceptance (the decorator's
    default status). Every error path raises an ``HTTPException`` whose own
    status (400/401/403/409/413/429/499/502) wins over the 202 default.
    """
    # Content-type allowlist BEFORE anything else (cheap, header-only).
    if not _content_type_ok(request):
        raise deps.http_error(
            400, "invalid_request",
            f"Content-Type must be {_ALLOWED_CONTENT_TYPE}",
        )
    project_id, clip_id, dur, lang = _validate_accept_params(
        project_id, clip_id, duration_s, language
    )

    # Reserve the job slot (403/409/429 cost guards). This MUST precede the body
    # read so an over-cap household burst is rejected without spooling bytes.
    try:
        job = svc.register(user, project_id, clip_id, dur, lang)
    except svc.TranscribeError as exc:
        raise deps.http_error(exc.http_status, exc.code, exc.message)

    # Stream the body to the spool (hard byte cap enforced on the fly). Any
    # failure here releases the slot and never makes an EL call.
    audio_bytes = await _spool_body_capped(request, job)

    # Body fully received -> launch the detached EL call and return 202. The
    # phone can lock now; the job runs to completion relay-side.
    svc.start(job, audio_bytes)
    return {"job_id": job.job_id, "est_cost_usd": job.est_cost_usd}


def _validate_job_id(job_id: str) -> str:
    if not _JOB_ID_RE.match(job_id or ""):
        # A malformed id can't belong to anyone -> the same uniform 404 a
        # foreign/unknown id gets (no shape oracle).
        raise deps.http_error(404, "job_not_found", "no such transcription job")
    return job_id


@router.get("/transcribe/{job_id}")
def transcribe_poll(
    job_id: str, user: str = Depends(deps.require_session)
) -> dict:
    """Poll a transcription job (arch §3.2). Uniform 404 for
    unknown/foreign/expired/post-restart."""
    _validate_job_id(job_id)
    payload = svc.poll(user, job_id)
    if payload is None:
        raise deps.http_error(
            404, "job_not_found",
            "this transcription job is gone — if the studio brain restarted, "
            "start the transcription again",
        )
    return payload


@router.delete("/transcribe/{job_id}")
def transcribe_cancel(
    job_id: str, user: str = Depends(deps.require_session)
) -> dict:
    """Best-effort cancel (arch §3.3). Uniform 404 for unknown/foreign."""
    _validate_job_id(job_id)
    payload = svc.cancel(user, job_id)
    if payload is None:
        raise deps.http_error(
            404, "job_not_found", "this transcription job is gone"
        )
    return payload
