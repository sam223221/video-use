"""Secure Studio public endpoints (plan 2026-06-11) — 3 routes, NO auth.

* ``GET /ca.crt``       — the local CA certificate, DER,
  ``application/x-x509-ca-cert``, ``Content-Disposition: inline`` (iOS must
  OPEN the file to offer profile installation — an attachment download would
  dead-end in the Files app). 404 ``tls_disabled`` envelope when TLS is off.
* ``GET /setup``        — the standalone, login-free onboarding page
  (``frontend/setup.html``, owned by the Frontend Engineer), served on BOTH
  schemes with ``Cache-Control: no-cache``; 503 if the file is missing
  (same partial-deploy guard as the SPA index).
* ``GET /api/tls/info`` — live URLs + cert facts for the setup page/banner:
  ``{enabled, https_url, host_local_url, http_url, ca_sha256, leaf_expires}``
  — nulls on failure, NEVER a 5xx (the setup page must always render).

Why these are public (plan §6): everything served here is public material —
the CA *certificate* (not key), the LAN IP/hostname already printed in the
startup banner, and a static how-to page. The routes take zero user input.
Private keys are never readable through any route.

State source: ``core/tls.py`` is read lazily per request (``get_state()``
parses the PEMs on demand with an mtime cache; ``is_enabled()`` folds in the
``serve.py`` decision when available). Documented nuance: under the legacy
``python -m uvicorn app.main:app`` entrypoint serve.py never ran, so whether
the TLS port actually answers is unknowable — ``enabled`` then reports
"TLS configured AND cert files on disk are valid".
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse, JSONResponse

from .. import net, settings
from ..core import tls as tls_core
from . import deps

router = APIRouter(tags=["tls"])


@router.get("/ca.crt")
def ca_crt() -> Response:
    """The local CA certificate (DER). Public; 404 envelope when TLS is off."""
    if not tls_core.is_enabled():
        raise deps.http_error(404, "tls_disabled", "HTTPS is not enabled")
    der = tls_core.ca_der()
    if der is None:
        # Configured-on but the file vanished/corrupted between checks —
        # treat as disabled (the setup page tells the user to retry).
        raise deps.http_error(404, "tls_disabled", "HTTPS is not enabled")
    return Response(
        content=der,
        media_type="application/x-x509-ca-cert",
        headers={
            # inline NOT attachment: iOS Safari must open the certificate to
            # offer "Install profile"; the filename guides desktop saves.
            "Content-Disposition": 'inline; filename="video-use-studio-ca.crt"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/setup")
def setup_page() -> FileResponse:
    """The login-free Secure Setup walkthrough. Served on both schemes."""
    page = settings.FRONTEND_DIR / "setup.html"
    if not page.is_file():
        # Same partial-deploy guard (and same 503 shape) as the SPA index.
        raise HTTPException(status_code=503, detail="frontend assets not built")
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


@router.get("/api/tls/info")
def tls_info() -> JSONResponse:
    """Public TLS facts for the setup page. Exact plan-§5 shape; never 5xx."""
    enabled = False
    https_url: str | None = None
    host_local_url: str | None = None
    http_url = f"http://127.0.0.1:{settings.PORT}/"
    ca_sha256: str | None = None
    leaf_expires: str | None = None
    try:
        try:
            ip = net.lan_ip()
        except Exception:  # noqa: BLE001 - lan_ip is already best-effort
            ip = "127.0.0.1"
        http_url = f"http://{ip}:{settings.PORT}/"
        enabled = tls_core.is_enabled()
        if enabled:
            state = tls_core.get_state()
            https_url = f"https://{ip}:{settings.TLS_PORT}/"
            host_local = net.hostname_local()
            if host_local:
                host_local_url = f"https://{host_local}:{settings.TLS_PORT}/"
            ca_sha256 = state.ca_sha256
            leaf_expires = state.leaf_expires
    except Exception:  # noqa: BLE001 - nulls on failure, never a 5xx
        enabled, https_url, host_local_url = False, None, None
        ca_sha256, leaf_expires = None, None
    return JSONResponse(
        content={
            "enabled": enabled,
            "https_url": https_url,
            "host_local_url": host_local_url,
            "http_url": http_url,
            "ca_sha256": ca_sha256,
            "leaf_expires": leaf_expires,
        }
    )
