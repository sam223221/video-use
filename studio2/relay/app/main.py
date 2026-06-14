"""Studio v2 relay — FastAPI application factory.

Adapted from v1 ``studio/app/main.py``, minus everything on the v2 kill list
(arch §1.2): NO migration, NO upload GC, NO session husk sweep, NO server-side
sessions — none of those exist in v2. The lifespan is exactly: applog init +
``.runtime`` dir warmup + session-secret warmup + startup facts + banner.

* Session-cookie auth is the SINGLE auth mechanism. Login/me + the PWA shell
  at ``/`` (plus the root-scope ``/sw.js`` / ``/manifest.webmanifest``
  aliases) and ``/static/*`` + the setup endpoints are PUBLIC; everything
  else under ``/api/*`` is gated by the per-router ``require_session``
  dependency (so a missing/invalid cookie -> 401, including the Step-3 SSE
  endpoints — the browser sends the cookie automatically).
* All 8 routers are mounted here (Step 1: auth/status/client_log/tls;
  Step 3: bridge/chat; M2: transcribe; model picker: agent).
* ``openapi_url=None`` (and docs/redoc) — no unauthenticated schema.
* The PWA lives in ``studio2/pwa/`` (owned by the frontend engineers, built
  in parallel) and is served as static assets with ``Cache-Control:
  no-cache`` (the v1 ``_RevalidatingStaticFiles`` pattern — returning phones
  must revalidate, so frontend fixes land without a manual hard-reload).
  Every PWA-serving path tolerates the directory/file not existing yet.
"""

from __future__ import annotations

import logging
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from . import net, settings
from .core import applog
from .core import transcribe as transcribe_svc
from .routers import agent, auth, bridge, chat, client_log, status, tls, transcribe

logger = logging.getLogger("studio2")


class _EffectiveBindLogger:
    """Pure-ASGI middleware that logs the EFFECTIVE local bind exactly once.

    The lifespan "startup" facts line can only report the CONFIGURED
    host/port from settings — if uvicorn were launched with explicit flags
    those would win and the configured values would lie. The ASGI
    ``scope["server"]`` two-tuple on an http request IS ground truth: uvicorn
    fills it from the accepted socket's local address.

    One log line on the first http request, then pure pass-through (a single
    cheap bool check per request). Zero-risk by construction: the log attempt
    is wrapped so no scope shape can ever break request handling.
    """

    def __init__(self, app) -> None:
        self.app = app
        self._logged = False

    async def __call__(self, scope, receive, send) -> None:
        if not self._logged and scope.get("type") == "http":
            self._logged = True
            try:
                server = scope.get("server") or (None, None)
                logger.info(
                    "effective bind host=%s port=%s (from first request's ASGI "
                    "scope; configured values may differ if uvicorn flags "
                    "overrode settings)",
                    server[0], server[1],
                )
            except Exception:  # noqa: BLE001 - logging must never break a request
                pass
        await self.app(scope, receive, send)


class _RevalidatingStaticFiles(StaticFiles):
    """StaticFiles that tells the browser to always revalidate before reusing
    a cached asset (v1 pattern, verbatim).

    ``Cache-Control: no-cache`` on every static response: the browser MAY
    cache the bytes but MUST revalidate via the conditional ETag /
    Last-Modified handshake on every load. This is NOT ``no-store`` — assets
    still get cheap ``304 Not Modified`` responses when unchanged; only the
    freshness check is forced. (The PWA's service worker adds its own
    version-keyed cache on top; these headers govern the SW's own fetches and
    any non-SW load.)

    Implemented by overriding ``file_response`` (Starlette's single funnel
    for every static file response, including the ``304`` path).
    """

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    # File logging FIRST (idempotent — create_app/serve already initialized
    # it; this is the belt-and-suspenders for exotic entrypoints).
    applog.init_logging()

    # .runtime warmup: ensure the runtime dir exists and the session secret is
    # initialized (so cookies survive restarts) before serving. This is the
    # ENTIRE v2 lifespan body — no migration, no GC (arch §1.2).
    settings.RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    settings.session_secret()  # warms + persists the signing secret

    # Sweep any transcription audio spool a crashed process stranded (arch
    # §7.3 boot sweep). Best-effort — never blocks boot. (The in-memory job
    # registry is gone after a restart by design, so a mid-job restart surfaces
    # as an honest 404 on the device's next poll; only the orphaned bytes need
    # cleaning here.)
    transcribe_svc.boot_sweep()

    # Structured startup facts for the file log (one greppable line answering
    # "what exactly was running?"). The keys say "configured_" because
    # settings are all this process can cheaply know at lifespan time; the
    # EFFECTIVE bind is logged once by _EffectiveBindLogger on the first
    # request. Best-effort.
    try:
        logger.info(
            "startup version=%s asset_version=%s configured_host=%s "
            "configured_port=%s configured_tls_port=%s ca_dir=%s lan_ip=%s "
            "secret_source=%s log_file=%s",
            settings.VERSION,
            auth.asset_version() or "unknown",
            settings.HOST,
            settings.PORT,
            settings.TLS_PORT,
            settings.CA_DIR,
            net.lan_ip(),
            settings.secret_source(),
            applog.log_file_path() or "unavailable",
        )
    except Exception:  # noqa: BLE001 - a startup log line must never block boot
        pass

    # Print the startup banner (URLs, credentials, QR, firewall hint). This is
    # the ONLY place a generated password is surfaced — so it MUST reach
    # stdout even on a non-UTF-8 console. The banner can embed Unicode QR
    # block glyphs, so:
    #   1. reconfigure stdout to UTF-8 (errors='replace') when possible, and
    #   2. on any failure, write the raw UTF-8 bytes directly so the
    #      credentials block is never silently lost.
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
        except Exception:  # noqa: BLE001 - last resort: at least log the bind
            logger.info(
                "Studio v2 relay listening on %s:%s", settings.HOST, settings.PORT
            )

    yield


def create_app() -> FastAPI:
    # Rotating file logging BEFORE anything else can log. create_app() runs at
    # module import — after uvicorn configured its console logging but before
    # any request or lifespan logic. Idempotent + best-effort.
    applog.init_logging()

    app = FastAPI(
        title="Studio v2 relay",
        version=settings.VERSION,
        docs_url=None,    # no public API docs for a household LAN tool
        redoc_url=None,
        openapi_url=None,  # also hide the unauthenticated /openapi.json schema
        lifespan=lifespan,
    )

    # One-shot effective-bind logging (see _EffectiveBindLogger).
    app.add_middleware(_EffectiveBindLogger)

    # --- API routers (each gates itself with require_session except the
    # public auth/tls surfaces). ---------------------------------------------
    app.include_router(auth.router)        # /api/login, /api/logout, /api/me
    app.include_router(status.router)      # /api/status
    app.include_router(client_log.router)  # /api/client-log (phone diagnostics)
    app.include_router(tls.router)         # /ca.crt, /setup, /api/tls/info (public)
    app.include_router(bridge.router)      # /api/bridge/events, /api/bridge/result (Step 3)
    app.include_router(chat.router)        # /api/chat, /api/chat/attach, /api/chat/cancel (Step 3)
    app.include_router(transcribe.router)  # /api/transcribe (POST/GET/DELETE) (M2)
    app.include_router(agent.router)       # /api/agent/model (GET/POST) — model picker

    # --- PWA shell + static assets (ungated) -------------------------------
    @app.get("/")
    def index() -> FileResponse:
        index_file = settings.PWA_DIR / "index.html"
        if not index_file.is_file():
            # Partial deploy (the PWA is built in parallel — Step 2): fail
            # fast with a clean 503 instead of letting Starlette raise at
            # send time (which surfaces as an obscure 500). Same graceful
            # guard + status as v1's SPA index.
            raise HTTPException(
                status_code=503, detail="pwa assets not deployed yet"
            )
        # The shell MUST always be revalidated: the cache-busting ``?v=N``
        # query lives INSIDE index.html, so a stale shell means the browser
        # never even requests new versioned assets. ``no-cache`` (NOT
        # ``no-store``) — an unchanged shell still returns a cheap 304.
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})

    # --- root-scope PWA files (service-worker contract) ---------------------
    # The service worker MUST be served from the origin root: a SW's maximum
    # scope is the directory of its script URL, so ``/static/sw.js`` could
    # only ever control ``/static/*`` and the offline shell at ``/`` would
    # break (Step-2 finding). The manifest rides along for the same reason
    # (``start_url: "/"`` resolves against the document, but serving both
    # from root keeps the install surface coherent). These are read-only
    # aliases onto the SAME files ``/static`` serves — FileResponse +
    # ``no-cache``, exactly like the ``index()`` shell above.
    #
    # Explicit media types, never mimetypes guessing: ``.webmanifest`` is
    # absent from many platform MIME registries, and on Windows the registry
    # can remap ``.js`` (text/plain has been observed) — a wrong type makes
    # the browser refuse SW registration / manifest parsing outright.
    def _pwa_root_file(name: str, media_type: str) -> FileResponse:
        file_path = settings.PWA_DIR / name
        if not file_path.is_file():
            # Partial deploy: same graceful guard + status as index() above.
            raise HTTPException(
                status_code=503, detail="pwa assets not deployed yet"
            )
        # ``no-cache`` (NOT ``no-store``) is load-bearing here too: browsers
        # apply the HTTP cache to service-worker script fetches, so without
        # forced revalidation a stale sw.js can pin a phone to an old shell
        # for up to 24h. Unchanged files still get cheap 304s.
        return FileResponse(
            file_path, media_type=media_type,
            headers={"Cache-Control": "no-cache"},
        )

    @app.get("/sw.js")
    def service_worker() -> FileResponse:
        return _pwa_root_file("sw.js", "text/javascript")

    @app.get("/manifest.webmanifest")
    def manifest() -> FileResponse:
        return _pwa_root_file("manifest.webmanifest", "application/manifest+json")

    if settings.PWA_DIR.is_dir():
        app.mount(
            "/static",
            _RevalidatingStaticFiles(directory=str(settings.PWA_DIR)),
            name="static",
        )
    else:
        # The mount is skipped when the PWA tree is absent (mounting a
        # missing directory raises at startup). Once Step 2 lands the files,
        # a relay restart picks them up. Loud enough to never be a mystery.
        logger.warning(
            "pwa directory missing at %s — /static not mounted (deploy the "
            "PWA and restart the relay)", settings.PWA_DIR,
        )

    return app


app = create_app()
