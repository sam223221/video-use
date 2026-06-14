"""Secure-setup public endpoints — v1 ``routers/tls.py`` behavior, v2 paths.

* ``GET /ca.crt``       — the SHARED v1 CA certificate, DER,
  ``application/x-x509-ca-cert``, ``Content-Disposition: inline`` (iOS must
  OPEN the file to offer profile installation — an attachment download would
  dead-end in the Files app). Byte-identical to v1's ``/ca.crt`` (same PEM,
  same deterministic DER re-encoding) — one trust anchor, two apps. 404
  ``tls_disabled`` envelope when TLS is off/unavailable.
* ``GET /setup``        — the standalone, login-free onboarding page
  (``pwa/setup.html``, owned by the PWA engineer — Step 2, built in
  parallel), served on BOTH schemes with ``Cache-Control: no-cache``. While
  the PWA is not deployed yet the route degrades to a clean 404
  ``setup_unavailable`` envelope (graceful partial-deploy fallback — the
  brief's explicit contract for Step 1).
* ``GET /api/tls/info`` — live URLs + cert facts for the setup page/banner:
  ``{enabled, https_url, host_local_url, http_url, ca_sha256, leaf_expires}``
  — nulls on failure, NEVER a 5xx (the setup page must always render).

Why these are public (v1 plan §6, unchanged): everything served here is
public material — the CA *certificate* (not key), the LAN IP/hostname already
printed in the startup banner, and a static how-to page. The routes take zero
user input. Private keys are never readable through any route.

State source: ``core/tls.py`` is read lazily per request (``get_state()``
parses the PEMs on demand with an mtime cache; ``is_enabled()`` folds in the
``serve.py`` decision when available).
"""

from __future__ import annotations

from fastapi import APIRouter, Response
from fastapi.responses import FileResponse, JSONResponse

from .. import net, settings
from ..core import tls as tls_core
from . import deps

router = APIRouter(tags=["tls"])


@router.get("/ca.crt")
def ca_crt() -> Response:
    """The shared CA certificate (DER). Public; 404 envelope when TLS is off."""
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
            # offer "Install profile"; the filename guides desktop saves. The
            # v1 filename is kept on purpose — it IS the same certificate.
            "Content-Disposition": 'inline; filename="video-use-studio-ca.crt"',
            "Cache-Control": "no-cache",
        },
    )


@router.get("/setup")
def setup_page() -> FileResponse:
    """The login-free Secure Setup walkthrough. Served on both schemes."""
    page = settings.PWA_DIR / "setup.html"
    if not page.is_file():
        # Graceful partial-deploy fallback: the PWA (Step 2) is built in
        # parallel and may not be on disk yet. A clean enveloped 404 — never
        # a raw 500 — until pwa/setup.html lands.
        raise deps.http_error(
            404, "setup_unavailable",
            "the setup page is not deployed yet (pwa/setup.html missing)",
        )
    return FileResponse(page, headers={"Cache-Control": "no-cache"})


@router.get("/api/tls/info")
def tls_info() -> JSONResponse:
    """Public TLS facts for the setup page. v1 plan-§5 shape; never 5xx."""
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
