"""GET /api/file — safe, range-aware media/image serving (contract §16).

Serves only files inside the allowed roots, only an allowlist of extensions, with
HTTP Range (206) support so the preview player can scrub. Path is realpath-checked
(symlinks resolved). Cookie-auth like every other endpoint — the browser sends the
session cookie automatically on a ``<video src>``.

Per-user ownership (per-user session model): root-confinement to
``USER_SESSIONS_ROOT`` alone would still let one user stream ANOTHER user's media
(both live under ``.runtime/users/``). So after the realpath root check, the
resolved path is ALSO confined to the AUTHENTICATED caller's own
``users/<username>/`` subtree (``security.is_within_root``). A path outside the
caller's own tree is a 403 — indistinguishable from any other forbidden path so
it never confirms another user's file exists.

``?download=1`` adds ``Content-Disposition: attachment`` (sanitized, RFC 5987
encoded basename — no header injection possible) for save-as semantics; without
the param the response is byte-identical to the streaming behavior above.
"""

from __future__ import annotations

import mimetypes
import os
import re
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .. import security, settings
from . import deps

router = APIRouter(prefix="/api", tags=["files"])

# Allowlist of served extensions (contract §16). .mov is served as mp4 container.
_CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".mov": "video/mp4",
    ".m4v": "video/mp4",
    ".mkv": "video/x-matroska",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".srt": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".md": "text/markdown; charset=utf-8",
}

_CHUNK = 1024 * 1024  # 1 MiB streaming window


def _content_type(path: Path) -> str:
    ct = _CONTENT_TYPES.get(path.suffix.lower())
    if ct:
        return ct
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "application/octet-stream"


_CD_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_CD_ASCII_SAFE_RE = re.compile(r"[^A-Za-z0-9._ -]")


def _attachment_disposition(name: str) -> str:
    """Build a download ``Content-Disposition`` value (header-injection-safe).

    Control characters (incl. CR/LF) are stripped outright, so no byte that
    could terminate or split the header survives. The RFC 5987 ``filename*``
    form percent-encodes EVERYTHING outside the unreserved set (quotes,
    separators, all non-ASCII), and the plain ``filename=`` ASCII fallback for
    old clients is reduced to a conservative ``[A-Za-z0-9._ -]`` charset (so it
    can never contain a quote either).
    """
    clean = _CD_CONTROL_RE.sub("", name).strip() or "download"
    ascii_fallback = _CD_ASCII_SAFE_RE.sub("_", clean)[:150].strip() or "download"
    encoded = quote(clean, safe="")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}"


@router.get("/file")
def serve_file(
    request: Request,
    path: str = Query(...),
    download: bool = Query(False),
    user: str = Depends(deps.require_session),
):
    try:
        target = security.resolve_in_roots(path)
    except security.PathOutsideRoots:
        raise deps.http_error(403, "forbidden", "path is outside the allowed roots")

    # Per-user ownership: confine to the caller's own users/<username>/ subtree so
    # one user can never stream another user's media (same 403 either way).
    try:
        user_root = settings.USER_SESSIONS_ROOT / security.sanitize_name(user)
    except ValueError:
        raise deps.http_error(403, "forbidden", "path is outside the allowed roots")
    if not security.is_within_root(target, user_root):
        raise deps.http_error(403, "forbidden", "path is outside the allowed roots")

    if not target.is_file():
        raise deps.http_error(404, "not_found", "file not found")
    if target.suffix.lower() not in _CONTENT_TYPES:
        raise deps.http_error(403, "forbidden", "file type is not served")

    content_type = _content_type(target)
    try:
        file_size = target.stat().st_size
    except OSError:
        raise deps.http_error(404, "not_found", "file not found")

    # ?download=1 -> save-as semantics. WITHOUT the param the response is
    # byte-identical to before (no extra header; Range/206 playback untouched).
    extra_headers: dict[str, str] = (
        {"Content-Disposition": _attachment_disposition(target.name)} if download else {}
    )

    range_header = request.headers.get("range") or request.headers.get("Range")
    if not range_header:
        return FileResponse(
            str(target),
            media_type=content_type,
            headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache", **extra_headers},
        )

    # Parse "bytes=START-END" (single range only).
    start, end = _parse_range(range_header, file_size)
    if start is None:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    length = end - start + 1

    def iter_file():
        with open(target, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-cache",
        **extra_headers,
    }
    return StreamingResponse(
        iter_file(), status_code=206, media_type=content_type, headers=headers
    )


def _parse_range(range_header: str, file_size: int) -> tuple[int | None, int]:
    """Parse a single ``bytes=start-end`` header. Returns (start, end) or
    (None, 0) for an unsatisfiable range.
    """
    try:
        units, _, rng = range_header.partition("=")
        if units.strip() != "bytes":
            return None, 0
        start_s, _, end_s = rng.strip().partition("-")
        if start_s == "":
            # suffix range: last N bytes
            n = int(end_s)
            if n <= 0:
                return None, 0
            start = max(0, file_size - n)
            end = file_size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start >= file_size:
            return None, 0
        return start, end
    except (ValueError, AttributeError):
        return None, 0
