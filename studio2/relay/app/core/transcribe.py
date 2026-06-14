"""THE TRANSCRIPTION SERVICE — server half (arch §3 + §4, the authoritative
contract).

The relay's ONE outbound integration and its ONE media-byte exception. A
user-gesture-only flow (never model-callable — the human tap on the consent
sheet IS the cost control, arch §2.3): the device uploads a small audio-only
``.m4a`` over the raw-body route in ``routers/transcribe.py``, this module
spools it to disk, calls ElevenLabs Scribe (key never leaves the relay,
multipart built OUTBOUND by httpx — the inbound route has zero parsing
surface), normalizes the response into the arch §4.2 transcript schema, and
holds the result in memory until the device polls it once (+ a short grace),
then forgets. Video never touches the relay; the audio bytes live at most
minutes in a gitignored spool dir and are deleted in ``finally`` on every path.

Data structures (all in-memory, all on the ONE event loop / ONE process — the
serve.py invariant, same philosophy as ``core/bridge.py``):

* ``_jobs`` — the job registry keyed by ``job_id`` (``tr_<hex12>``). Each
  record owns its ``user`` (the §8.7 IDOR guard: a poll can only ever see its
  OWN user's jobs — anything else is a uniform 404), the detached
  ``asyncio.Task`` running the EL call, a status machine
  (``transcribing`` -> ``done`` | ``error`` | ``cancelled``), and the
  delivered/created timestamps that drive the forget cycle.
* ``_usage`` — the per-process daily cost counters (date + calls + audio
  bytes), reset at local-midnight rollover AND on restart (household scale,
  arch §8.5). Concurrency is derived from ``_jobs`` (one live job per user).

Lifecycle (arch §7.3): ``register`` (caps checked, job_id minted, status
``transcribing``) -> the route streams the body to ``spool_path(job_id)`` ->
``start`` launches the detached task -> the task posts to EL, normalizes,
sets ``done``/``error`` -> the spool is deleted in ``finally`` -> the first
``done`` poll marks the job delivered; it survives ``DELIVERED_GRACE_S`` more
(covers a device that crashed between fetch and OPFS write) then is dropped; a
lazy sweeper also drops any job older than ``JOB_TTL_S``. Boot: ``boot_sweep``
clears orphaned spool files from a crashed process. Restart mid-job: the
registry is gone -> the device poll 404s -> honest restart copy (the route).

Error taxonomy (arch §3.2) — stored on the job, rendered by the poll route:
``provider_error`` (EL non-2xx, sanitized excerpt — never the key, never EL's
raw body in bulk), ``provider_unreachable`` (network), ``provider_auth`` (EL
401), ``provider_quota`` (EL 429), ``transcribe_timeout`` (watchdog),
``cancelled``. NO automatic retry — a failed EL call must never silently
double-charge; the user retries from the UI (arch §10.10).

Logging (``studio2.transcribe``): job start/end with ids, bytes, declared
duration, outcome, elapsed — NEVER the transcript content, NEVER the key,
NEVER EL's raw body beyond a short sanitized excerpt on error.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from .. import settings
from . import applog

_log = logging.getLogger("studio2.transcribe")

# --- lifecycle constants (arch §3.2) ----------------------------------------
DELIVERED_GRACE_S = 120.0       # keep a delivered job this long (re-poll safety)
JOB_TTL_S = 30 * 60.0           # absolute job lifetime (lazy sweeper drops older)
JOB_WATCHDOG_S = 15 * 60.0      # a hung EL call becomes transcribe_timeout

# --- ElevenLabs Scribe call (arch §3.4) -------------------------------------
EL_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text"
# Per-phase httpx timeouts; the job watchdog is the hard backstop above these.
EL_CONNECT_TIMEOUT_S = 10.0
EL_WRITE_TIMEOUT_S = 120.0
EL_READ_TIMEOUT_S = 600.0
# The EL response is untrusted JSON — cap the body read so a hostile/huge
# response can never exhaust memory (arch §8.7). 32 MiB is enormous for a
# word-timestamped transcript (a 30-min clip is ~hundreds of KB).
EL_RESPONSE_MAX_BYTES = 32 * 1024 * 1024
# An error excerpt from EL's body is capped + sanitized before it reaches a
# log line or the job's user-facing message.
_EL_ERROR_EXCERPT_MAX = 300

# Cost-estimate basis (arch §3.1): ≈ $0.40 per audio-hour. ElevenLabs bills
# Scribe per audio-hour at a PLAN-TIER rate (≈$0.40 on Creator/Pro, lower on
# Scale/Business) and v2 is priced IDENTICALLY to v1 — the v1→v2 migration is
# cost-neutral. $0.40/hr is the conservative high-tier figure; this is an
# honest UPPER-bound estimate surfaced on the consent sheet, never a bill.
_COST_USD_PER_HOUR = 0.40

# --- Scribe model id resolution (the v1→v2 migration, arch §3.4) ------------
# scribe_v1 is DEPRECATED upstream and slated for removal; scribe_v2 is the
# current batch model on the SAME endpoint, with better WER and the same 90+
# language coverage and the same request/response contract (probe-verified at
# build time — see core/DOCUMENT.md). The model id flows in from settings
# (config-pinnable), but the legacy default must MIGRATE without touching
# settings.py: a setting that still carries the retired ``scribe_v1`` default
# is upgraded to ``scribe_v2`` here, while any explicit non-legacy pin is
# honored verbatim (so a deliberate scribe_v1 or a future scribe_v2 pin both
# pass through). The provider stamp + the outbound model_id share this one
# resolved value so the transcript's audit trail never lies.
_LEGACY_MODEL_ID = "scribe_v1"
_DEFAULT_MODEL_ID = "scribe_v2"


def _resolved_model_id() -> str:
    """The Scribe model id actually sent to EL and stamped on the transcript.

    Upgrades the retired ``scribe_v1`` value (the settings.py default) to the
    current ``scribe_v2``; an empty/blank setting also resolves to v2; any
    other explicit pin is passed through untouched."""
    pinned = (settings.TRANSCRIBE_MODEL_ID or "").strip()
    if not pinned or pinned == _LEGACY_MODEL_ID:
        return _DEFAULT_MODEL_ID
    return pinned


# ============================================================================
# Job records & registry
# ============================================================================

@dataclass
class _Job:
    """One transcription job, owned by exactly one authenticated user."""

    job_id: str
    user: str
    project_id: str
    clip_id: str
    duration_s: float
    language: str | None              # per-request override (None = config/auto)
    est_cost_usd: float
    created_at: float = field(default_factory=time.monotonic)
    status: str = "transcribing"      # transcribing | done | error | cancelled
    stage: str = "provider"           # informational, arch §3.2
    transcript: dict[str, Any] | None = None
    error: dict[str, str] | None = None  # {code, message} on the error path
    audio_bytes: int = 0              # spool size once the body is fully received
    delivered_at: float | None = None  # monotonic ts of the FIRST done fetch
    task: asyncio.Task | None = None  # the detached EL-call task

    def elapsed_s(self) -> int:
        return int(time.monotonic() - self.created_at)


@dataclass
class _DailyUsage:
    """Per-process daily cost counters (arch §8.5). Reset on local-date
    rollover and on restart — household scale; not a billing ledger."""

    day: date = field(default_factory=date.today)
    calls: int = 0
    audio_bytes: int = 0

    def roll(self) -> None:
        today = date.today()
        if today != self.day:
            self.day = today
            self.calls = 0
            self.audio_bytes = 0


_jobs: dict[str, _Job] = {}
_usage = _DailyUsage()


class TranscribeError(Exception):
    """A route-visible failure with an HTTP status + coded envelope. Raised by
    ``register`` (the synchronous accept path); the poll route renders job-side
    failures from ``_Job.error`` instead."""

    def __init__(self, http_status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.http_status = http_status
        self.code = code
        self.message = message


# ============================================================================
# Spool management (the transient audio bytes)
# ============================================================================

def _spool_dir() -> Path:
    settings.TRANSCRIBE_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    return settings.TRANSCRIBE_SPOOL_DIR


def spool_path(job_id: str) -> Path:
    """The on-disk spool for ``job_id``. The filename derives ONLY from the
    server-generated job_id — zero client-influenced path components (arch
    §8.1 path-traversal bullet)."""
    return _spool_dir() / f"{job_id}.m4a"


def _delete_spool(job_id: str) -> None:
    """Best-effort spool deletion — called in ``finally`` on every path so the
    relay never hoards audio (arch §7.3)."""
    try:
        spool_path(job_id).unlink(missing_ok=True)
    except OSError as exc:  # noqa: BLE001 - cleanup must never raise
        _log.warning("spool delete failed job_id=%s err=%s", job_id, exc)


def boot_sweep() -> int:
    """Delete every orphaned ``*.m4a`` spool at startup (a crash before
    ``finally`` could strand one). Returns the count swept. Never raises."""
    swept = 0
    try:
        d = settings.TRANSCRIBE_SPOOL_DIR
        if not d.is_dir():
            return 0
        for p in d.glob("*.m4a"):
            try:
                p.unlink()
                swept += 1
            except OSError:
                pass
        if swept:
            _log.info("transcribe boot sweep removed %d orphaned spool(s)", swept)
    except Exception:  # noqa: BLE001 - a boot sweep must never block startup
        pass
    return swept


# ============================================================================
# Accept path (called by routers/transcribe.py BEFORE the body is streamed)
# ============================================================================

def estimate_cost_usd(duration_s: float) -> float:
    """The honest cost estimate surfaced on the 202 + consent sheet."""
    return round(max(0.0, duration_s) / 3600.0 * _COST_USD_PER_HOUR, 2)


def _live_job_for_user(user: str) -> _Job | None:
    """The user's single in-flight job, if any (concurrency cap = 1)."""
    for job in _jobs.values():
        if job.user == user and job.status == "transcribing":
            return job
    return None


def register(
    user: str,
    project_id: str,
    clip_id: str,
    duration_s: float,
    language: str | None,
) -> _Job:
    """Reserve a job slot, enforcing the accept-time cost guards (arch §8.5).

    Raises :class:`TranscribeError` for every guard:
      * 403 ``transcribe_disabled`` — master switch off or no key,
      * 409 ``transcribe_busy``     — the user already has a live job,
      * 429 ``daily_cap_reached``   — the daily call/audio guards tripped.

    The byte cap is NOT checked here (the body hasn't arrived) — the route
    enforces it on the fly while streaming. On success the job is registered
    in ``transcribing`` status; the caller then streams the body to
    ``spool_path(job.job_id)`` and calls :func:`start`. If the stream fails,
    the caller MUST call :func:`abort_unstarted` to release the slot.
    """
    if not settings.transcribe_configured():
        raise TranscribeError(
            403, "transcribe_disabled",
            "transcription isn't set up on the studio brain",
        )

    _usage.roll()
    if _usage.calls >= settings.TRANSCRIBE_DAILY_CALL_CAP:
        raise TranscribeError(
            429, "daily_cap_reached",
            f"the daily transcription limit ({settings.TRANSCRIBE_DAILY_CALL_CAP} "
            "clips) has been reached — it resets at midnight",
        )
    if _usage.audio_bytes >= settings.TRANSCRIBE_DAILY_AUDIO_BYTES_CAP:
        raise TranscribeError(
            429, "daily_cap_reached",
            f"the daily transcription audio limit "
            f"({settings.TRANSCRIBE_DAILY_AUDIO_MIB_CAP} MiB) has been reached — "
            "it resets at midnight",
        )

    if _live_job_for_user(user) is not None:
        raise TranscribeError(
            409, "transcribe_busy",
            "a transcription is already running on this account — wait for it "
            "to finish before starting another",
        )

    job_id = f"tr_{secrets.token_hex(6)}"
    job = _Job(
        job_id=job_id,
        user=user,
        project_id=project_id,
        clip_id=clip_id,
        duration_s=duration_s,
        language=language,
        est_cost_usd=estimate_cost_usd(duration_s),
    )
    _jobs[job_id] = job
    _log.info(
        "transcribe register job_id=%s user=%s project_id=%s clip_id=%s "
        "duration_s=%.1f est_cost_usd=%.2f",
        job_id, applog.sanitize_log_value(user, 64), project_id, clip_id,
        duration_s, job.est_cost_usd,
    )
    return job


def abort_unstarted(job: _Job, *, code: str = "client_disconnected") -> None:
    """Release a registered-but-never-started job (the body stream failed or
    overflowed the byte cap). Drops the registry slot and the spool; counts
    NOTHING against the daily caps and makes NO EL call — so a mid-upload drop
    or an over-cap body is free (arch §3.1 499 / 413)."""
    _jobs.pop(job.job_id, None)
    _delete_spool(job.job_id)
    _log.info(
        "transcribe aborted (unstarted) job_id=%s reason=%s", job.job_id, code
    )


# ============================================================================
# Run path (the detached EL call)
# ============================================================================

def start(job: _Job, audio_bytes: int) -> None:
    """Launch the detached EL-call task for a fully-received job and count it
    against the daily guards (arch §7.3). The 202 is returned by the route the
    instant this returns — the work now survives the phone locking."""
    job.audio_bytes = audio_bytes
    _usage.roll()
    _usage.calls += 1
    _usage.audio_bytes += max(0, audio_bytes)
    job.task = asyncio.ensure_future(_run(job))
    _log.info(
        "transcribe start job_id=%s audio_bytes=%d daily_calls=%d daily_audio_mib=%d",
        job.job_id, audio_bytes, _usage.calls, _usage.audio_bytes // (1024 * 1024),
    )


async def _run(job: _Job) -> None:
    """The detached task: call EL under a watchdog, normalize, set the outcome.

    Never raises out (a detached task's exception would be a silent log noise);
    every failure becomes a coded job error. The spool is deleted in
    ``finally`` on success, error, cancel, or timeout.
    """
    t0 = time.monotonic()
    try:
        try:
            raw = await asyncio.wait_for(
                _call_elevenlabs(job), timeout=JOB_WATCHDOG_S
            )
        except asyncio.TimeoutError:
            _set_error(
                job, "transcribe_timeout",
                "transcription took too long and was stopped — try again, or "
                "try a shorter clip",
            )
            _log.warning(
                "transcribe timeout job_id=%s after_s=%.0f", job.job_id,
                JOB_WATCHDOG_S,
            )
            return

        transcript = normalize_transcript(
            raw, clip_id=job.clip_id, duration_s=job.duration_s,
            model_id=_resolved_model_id(),
        )
        if job.status == "cancelled":  # a DELETE landed mid-normalize — honor it
            return
        job.transcript = transcript
        job.status = "done"
        job.stage = "done"
        _log.info(
            "transcribe done job_id=%s elapsed_ms=%d words=%d language=%s",
            job.job_id, int((time.monotonic() - t0) * 1000),
            len(transcript.get("words", [])),
            applog.sanitize_log_value(transcript.get("language_code"), 16),
        )
    except asyncio.CancelledError:
        # A DELETE cancel (or shutdown) tore the task down. Mark cancelled if it
        # hasn't already resolved; re-raise so the loop accounts the cancel.
        if job.status == "transcribing":
            job.status = "cancelled"
            job.error = {"code": "cancelled", "message": "transcription cancelled"}
            job.stage = "cancelled"
        raise
    except _ProviderError as exc:
        _set_error(job, exc.code, exc.message)
        _log.warning(
            "transcribe provider error job_id=%s code=%s", job.job_id, exc.code
        )
    except Exception as exc:  # noqa: BLE001 - a detached task must never escape
        _set_error(
            job, "provider_error",
            "transcription failed unexpectedly — try again",
        )
        _log.warning(
            "transcribe unexpected error job_id=%s err_type=%s", job.job_id,
            type(exc).__name__,
        )
    finally:
        _delete_spool(job.job_id)


def _set_error(job: _Job, code: str, message: str) -> None:
    if job.status == "cancelled":
        return  # a cancel already won the race; don't overwrite it
    job.status = "error"
    job.stage = "error"
    job.error = {"code": code, "message": message}


class _ProviderError(Exception):
    """Internal: an EL-side failure carrying a job error code + safe message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


async def _call_elevenlabs(job: _Job) -> dict[str, Any]:
    """POST the spooled audio to ElevenLabs Scribe and return the parsed JSON.

    httpx builds the OUTBOUND multipart natively and streams the spool file
    (never buffering it into RAM — arch §9). The inbound route has NO multipart
    surface; this is the only multipart in the system and it is ours.

    Raises :class:`_ProviderError` with the arch §3.2 codes for every EL
    failure. The key rides in the ``xi-api-key`` header and appears in NO log
    line and NO error message.
    """
    import httpx  # local import: a broken httpx breaks transcription, not boot

    api_key = settings.elevenlabs_api_key()
    if not api_key:  # the master gate passed at register; key pulled at last moment
        raise _ProviderError(
            "provider_auth",
            "the transcription key is missing — check the relay's config",
        )

    # Multipart form fields (arch §3.4). language_code is forwarded ONLY when a
    # concrete code exists: the per-request override wins, else the config pin,
    # else it is omitted so EL auto-detects (the household's mixed-language path).
    language_code = job.language or settings.TRANSCRIBE_LANGUAGE or ""
    data: dict[str, str] = {
        "model_id": _resolved_model_id(),
        "timestamps_granularity": "word",
        "tag_audio_events": "true",
        "diarize": "true" if settings.TRANSCRIBE_DIARIZE else "false",
    }
    if language_code:
        data["language_code"] = language_code

    timeout = httpx.Timeout(
        connect=EL_CONNECT_TIMEOUT_S,
        write=EL_WRITE_TIMEOUT_S,
        read=EL_READ_TIMEOUT_S,
        pool=EL_CONNECT_TIMEOUT_S,
    )
    spool = spool_path(job.job_id)

    try:
        # The spool file handle is streamed as the multipart body; httpx reads
        # it incrementally so a 256 MiB upload never lands in RAM.
        with spool.open("rb") as fh:
            files = {"file": (f"{job.job_id}.m4a", fh, "audio/mp4")}
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    EL_ENDPOINT,
                    headers={"xi-api-key": api_key},
                    data=data,
                    files=files,
                )
    except FileNotFoundError:
        # The spool vanished (cancel race / disk issue) — treat as unreachable.
        raise _ProviderError(
            "provider_error", "the audio could not be read for transcription"
        )
    except httpx.HTTPError as exc:
        # Connect/read/write/network failures all land here. Never leak the
        # underlying message (it can carry the URL/host); a typed code + safe
        # copy only.
        _log.warning(
            "transcribe EL transport error job_id=%s err_type=%s",
            job.job_id, type(exc).__name__,
        )
        raise _ProviderError(
            "provider_unreachable",
            "couldn't reach the transcription service — check the relay's "
            "internet connection and try again",
        )

    return _read_el_response(job, resp)


def _read_el_response(job: "_Job", resp) -> dict[str, Any]:
    """Map an EL HTTP response to parsed JSON or a coded :class:`_ProviderError`.

    Status mapping (arch §3.2): 401 -> ``provider_auth``, 429 ->
    ``provider_quota``, any other non-2xx -> ``provider_error`` with a SHORT
    sanitized excerpt of EL's body (never the full body, never the key). The
    success body is size-bounded and JSON-parsed defensively — a malformed
    response is ``provider_error``, never a crash (arch §8.7).
    """
    import json

    status = resp.status_code
    if status == 401:
        raise _ProviderError(
            "provider_auth",
            "the transcription key was rejected — check the relay's config",
        )
    if status == 429:
        raise _ProviderError(
            "provider_quota",
            "the transcription service is rate-limited or out of quota — try "
            "again later",
        )
    if status >= 400:
        excerpt = applog.sanitize_log_value(
            (resp.text or "")[:_EL_ERROR_EXCERPT_MAX], _EL_ERROR_EXCERPT_MAX
        )
        _log.warning(
            "transcribe EL non-2xx job_id=%s status=%d excerpt=%s",
            job.job_id, status, excerpt,
        )
        raise _ProviderError(
            "provider_error",
            f"the transcription service returned an error (HTTP {status})",
        )

    body = resp.content or b""
    if len(body) > EL_RESPONSE_MAX_BYTES:
        raise _ProviderError(
            "provider_error", "the transcription response was implausibly large"
        )
    try:
        parsed = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, RecursionError):
        raise _ProviderError(
            "provider_error", "the transcription response could not be read"
        )
    if not isinstance(parsed, dict):
        raise _ProviderError(
            "provider_error", "the transcription response had an unexpected shape"
        )
    return parsed


# ============================================================================
# Normalization (arch §4.2) — EL's response -> the device transcript schema
# ============================================================================

def _round2(value: Any) -> float | None:
    """Coerce to a finite, non-negative, 2-dp float, or None."""
    try:
        if isinstance(value, bool) or value is None:
            return None
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return round(max(0.0, f), 2)


def _confidence(logprob: Any) -> float | None:
    """``c`` = exp(logprob), clamped to 0..1 and 2-dp, or None when absent.

    Scribe gives a log-probability per word; the schema stores a friendly
    confidence. Defensive: a non-numeric/odd logprob simply omits ``c``."""
    import math

    try:
        if isinstance(logprob, bool) or logprob is None:
            return None
        lp = float(logprob)
        if lp != lp or lp == float("inf") or lp == float("-inf"):
            return None
        c = math.exp(min(0.0, lp))  # logprob ≤ 0; clamp guards a bad positive
    except (TypeError, ValueError, OverflowError):
        return None
    return round(max(0.0, min(1.0, c)), 2)


def normalize_transcript(
    raw: dict[str, Any],
    *,
    clip_id: str,
    duration_s: float,
    model_id: str,
) -> dict[str, Any]:
    """Turn an EL Scribe response into the arch §4.2 device transcript schema.

    TOLERANT by contract (arch §3.4): unknown fields ignored, absent optional
    fields omitted, a provider drift degrades gracefully and never raises. The
    EL field mapping (verified against current EL docs AND a live scribe_v2
    batch probe at build time — see core/DOCUMENT.md; scribe_v2's response is
    schema-identical to v1's, so this mapping is unchanged across the v1→v2
    migration):

        EL top-level                -> schema
        ----------------------------------------------------------------
        language_code               -> language_code        (str, "" fallback)
        language_probability        -> language_probability (float|null)
        text                        -> text                 (str, joined if absent)
        words: [ {text,type,start,end,logprob,speaker_id,...} ]
        transcription_id            -> IGNORED (v2 audit id; we don't store it)
        audio_duration_secs         -> IGNORED (we keep the device-declared dur.)

        EL word entry by type:
          type == "word"            -> words[]      {w, s, e, c?}
          type == "spacing"         -> DROPPED      (whitespace tokens)
          type == "audio_event"     -> audio_events[] {label, s, e}
          (any other / missing type, but with start+end+text)
                                    -> treated as a word (defensive)

        w = text, s = round2(start), e = round2(end),
        c = exp(logprob) clamped 0..1 (omitted when logprob absent),
        label = text (audio events), s/e same.

    The transcript is stamped with ``provider = "elevenlabs.<model_id>"`` and a
    UTC ``transcribed_at`` for the device's audit trail.
    """
    from datetime import datetime, timezone

    language_code = raw.get("language_code")
    language_code = language_code if isinstance(language_code, str) else ""

    lang_prob = _round2(raw.get("language_probability"))

    words_out: list[dict[str, Any]] = []
    events_out: list[dict[str, Any]] = []
    raw_words = raw.get("words")
    if isinstance(raw_words, list):
        for entry in raw_words:
            if not isinstance(entry, dict):
                continue
            wtype = entry.get("type")
            text = entry.get("text")
            text = text if isinstance(text, str) else ""
            s = _round2(entry.get("start"))
            e = _round2(entry.get("end"))

            if wtype == "spacing":
                continue
            if wtype == "audio_event":
                if s is None or e is None:
                    continue
                events_out.append({"label": text, "s": s, "e": e})
                continue
            # type == "word" OR an unknown/missing type that still looks like a
            # word (has times + text). Anything timeless is dropped.
            if s is None or e is None or text == "":
                continue
            word: dict[str, Any] = {"w": text, "s": s, "e": e}
            c = _confidence(entry.get("logprob"))
            if c is not None:
                word["c"] = c
            words_out.append(word)

    # ``text``: prefer EL's joined transcript; reconstruct from words if absent.
    text_val = raw.get("text")
    if not isinstance(text_val, str) or text_val == "":
        text_val = " ".join(w["w"] for w in words_out)

    return {
        "schema": 1,
        "clip_id": clip_id,
        "provider": f"elevenlabs.{model_id}",
        "transcribed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "language_code": language_code,
        "language_probability": lang_prob,
        "audio_duration_s": round(max(0.0, float(duration_s)), 1),
        "text": text_val,
        "words": words_out,
        "audio_events": events_out,
    }


# ============================================================================
# Poll / cancel path (called by routers/transcribe.py)
# ============================================================================

def _sweep_expired() -> None:
    """Drop jobs past their forget window (arch §3.2). Lazy: called on every
    poll/cancel/register so the registry self-cleans without a background task.

    Two reasons a job is dropped:
      * delivered + ``DELIVERED_GRACE_S`` elapsed (the device fetched it),
      * absolute age > ``JOB_TTL_S`` (the relay forgets, structurally).
    """
    now = time.monotonic()
    for job_id in [
        jid for jid, j in _jobs.items()
        if (j.delivered_at is not None and now - j.delivered_at > DELIVERED_GRACE_S)
        or (now - j.created_at > JOB_TTL_S)
    ]:
        _jobs.pop(job_id, None)


def _owned_job(user: str, job_id: str) -> _Job | None:
    """The job IFF it exists AND belongs to ``user`` — else None (the §8.7
    anti-IDOR posture: a foreign/unknown/expired id is indistinguishable to
    the caller, which maps None to a uniform 404)."""
    _sweep_expired()
    job = _jobs.get(job_id)
    if job is None or job.user != user:
        return None
    return job


def poll(user: str, job_id: str) -> dict[str, Any] | None:
    """The poll payload for ``GET /api/transcribe/{job_id}`` (arch §3.2), or
    None when the job is unknown/foreign/expired (-> 404).

    Marks the job delivered on the FIRST ``done`` fetch so the forget cycle can
    start; subsequent fetches within the grace window still succeed (the
    crashed-write re-poll case).
    """
    job = _owned_job(user, job_id)
    if job is None:
        return None

    if job.status == "transcribing":
        return {"status": "transcribing", "stage": job.stage, "elapsed_s": job.elapsed_s()}

    if job.status == "done":
        if job.delivered_at is None:
            job.delivered_at = time.monotonic()
            _log.info("transcribe delivered job_id=%s", job_id)
        return {
            "status": "done",
            "transcript": job.transcript or {},
            "est_cost_usd": job.est_cost_usd,
        }

    # error | cancelled — both render as a status:"error" envelope with the
    # stored {code, message} (a cancelled job carries code "cancelled").
    err = job.error or {"code": "provider_error", "message": "transcription failed"}
    return {"status": "error", "error": err}


def cancel(user: str, job_id: str) -> dict[str, Any] | None:
    """Best-effort cancel for ``DELETE /api/transcribe/{job_id}`` (arch §3.3),
    or None when unknown/foreign (-> 404).

    Cancels the detached task (the httpx request is aborted), marks the job
    ``cancelled``, and deletes the spool (the task's ``finally`` also does, but
    we don't depend on it landing). Honest UI copy warns that audio already at
    EL may still be billed. Returns ``{"cancelled": bool}`` — ``cancelled`` is
    True when this call moved a still-running job to cancelled.
    """
    job = _owned_job(user, job_id)
    if job is None:
        return None

    if job.status != "transcribing":
        # Already done/errored/cancelled — nothing live to stop.
        return {"cancelled": False}

    job.status = "cancelled"
    job.stage = "cancelled"
    job.error = {
        "code": "cancelled",
        "message": "transcription cancelled — if the audio had already reached "
        "the service it may still be billed",
    }
    if job.task is not None and not job.task.done():
        job.task.cancel()
    _delete_spool(job_id)
    _log.info("transcribe cancel job_id=%s", job_id)
    return {"cancelled": True}


# ============================================================================
# Status surface (called by routers/status.py)
# ============================================================================

def status_summary() -> dict[str, Any]:
    """The ``/api/status -> transcribe`` block (arch §3.5). Presence only, the
    daily remaining counters for the PWA's gate — NEVER the key.

    Shape: ``{configured, enabled, daily_remaining:{calls, audio_mib}}``. A
    keyless/disabled relay reports ``configured:false`` so the PWA disables the
    Transcribe affordance with honest copy.
    """
    _usage.roll()
    calls_left = max(0, settings.TRANSCRIBE_DAILY_CALL_CAP - _usage.calls)
    audio_bytes_left = max(
        0, settings.TRANSCRIBE_DAILY_AUDIO_BYTES_CAP - _usage.audio_bytes
    )
    return {
        "configured": settings.transcribe_configured(),
        "enabled": settings.TRANSCRIBE_ENABLED,
        "daily_remaining": {
            "calls": calls_left,
            "audio_mib": audio_bytes_left // (1024 * 1024),
        },
    }
