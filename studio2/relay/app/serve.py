"""Dual-listener launcher for the Studio v2 relay — direct adaptation of v1
``studio/app/serve.py`` (the field-hardened Secure Studio pattern).

``python -m app.serve`` (cwd = ``studio2/relay/`` — exactly how ``start.bat``
/ ``start.sh`` invoke it) runs TWO programmatic ``uvicorn.Server`` instances
over the SAME ``app.main:app`` in ONE asyncio loop / ONE process:

* **HTTP**  on ``settings.HOST:settings.PORT``  (:8520) — lifespan ON
  ("auto"): the .runtime warmup + banner run here, exactly once.
* **HTTPS** on ``settings.HOST:settings.TLS_PORT`` (:8543) —
  ``ssl_certfile`` / ``ssl_keyfile`` from :func:`app.core.tls.ensure_certs`
  (v2's OWN leaf, signed by the SHARED v1 CA), ``lifespan="off"`` so startup
  logic never runs twice.

ONE process is load-bearing: the session secret, the TLS state, the log
handler — and, from Step 3, the bridge connection registry, the pending-
command Future registry and the turn buffers — are all in-memory singletons;
two processes would split them.

Fallbacks (TLS can NEVER block boot — the applog invariant):
* ``STUDIO2_TLS=0`` (or ``[server] tls=false``) → single HTTP server.
* ``ensure_certs()`` → ``None`` (shared CA missing/damaged, or any cert
  failure) → same HTTP-only fallback, loudly logged with the "run Studio v1
  once or set STUDIO2_CA_DIR" instruction.
* The HTTPS listener failing at runtime (e.g. ``:8543`` already bound) is
  contained: the HTTP server keeps serving and ``/api/tls/info`` flips to
  ``enabled:false``.

Signals / Ctrl+C (Windows-verified in v1): uvicorn's own ``Server.serve()``
wraps itself in ``capture_signals()``, and two Servers in one loop would each
install + restore handlers around the other — the LAST one to start would own
Ctrl+C and only stop itself. So :class:`_QuietSignalServer` disables uvicorn's
capture entirely and ``main()`` installs ONE process-wide handler (SIGINT /
SIGTERM / SIGBREAK) that sets ``should_exit`` on BOTH servers — both tick
loops then drain and the process exits. A second Ctrl+C sets ``force_exit``
(uvicorn's own semantics) so a hung connection (e.g. a long-lived SSE stream)
cannot block shutdown.

Logging order matters: ``logging.config.dictConfig(uvicorn LOGGING_CONFIG)``
first (the same console setup the uvicorn CLI performs), THEN
``applog.init_logging()`` (attaches the rotating file handler to
``studio2.*`` + ``uvicorn.*``), and both ``uvicorn.Config``s are built with
``log_config=None`` so they cannot re-apply dictConfig and wipe the file
handler off the uvicorn loggers.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import logging.config
import signal
import sys
from typing import Iterator

import uvicorn

from . import settings
from .core import applog
from .core import tls as tls_core

_log = logging.getLogger("studio2.serve")

_APP = "app.main:app"  # import string; resolved once — both servers share the object


class _QuietSignalServer(uvicorn.Server):
    """uvicorn Server that never installs its own signal handlers.

    With two Servers in one loop, uvicorn's per-server ``capture_signals()``
    would chain-install/restore handlers and Ctrl+C would reach only one of
    them. ``main()`` owns the (single) process-wide handler instead.
    """

    @contextlib.contextmanager
    def capture_signals(self) -> Iterator[None]:
        yield


def _install_signal_handlers(servers: list[uvicorn.Server]) -> None:
    """One handler for SIGINT/SIGTERM (+SIGBREAK on Windows) stopping ALL servers.

    Mirrors uvicorn's own ``handle_exit``: first signal → graceful
    ``should_exit``; a second SIGINT → ``force_exit`` (skip waiting on open
    connections, e.g. a long-lived SSE stream). Plain ``signal.signal`` works
    on Windows where ``loop.add_signal_handler`` does not; the servers' 0.1 s
    tick loops notice the flag promptly.
    """
    handled: list[signal.Signals] = [signal.SIGINT, signal.SIGTERM]
    if sys.platform == "win32":
        handled.append(signal.SIGBREAK)

    def _handle(sig: int, frame) -> None:  # noqa: ANN001 - signal callback shape
        for server in servers:
            if server.should_exit and sig == signal.SIGINT:
                server.force_exit = True
            else:
                server.should_exit = True

    for sig in handled:
        try:
            signal.signal(sig, _handle)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            pass


def _build_config(port: int, *, lifespan: str, ssl_certfile: str | None = None,
                  ssl_keyfile: str | None = None) -> uvicorn.Config:
    # log_config=None is REQUIRED here: dictConfig already ran in main() and a
    # second application would wipe applog's file handler off uvicorn.access/
    # uvicorn.error (dictConfig replaces handlers for the loggers it names).
    return uvicorn.Config(
        _APP,
        host=settings.HOST,
        port=port,
        lifespan=lifespan,
        log_config=None,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )


async def _serve_https_guarded(server: uvicorn.Server) -> None:
    """Run the HTTPS listener; contain EVERY failure so HTTP keeps serving.

    uvicorn calls ``sys.exit(1)`` on a bind failure (SystemExit, a
    BaseException) — under ``asyncio.gather`` that would tear down the HTTP
    server too. Cancellation (loop shutdown) is re-raised; everything else is
    logged and flips the advertised TLS state off.
    """
    try:
        await server.serve()
    except asyncio.CancelledError:
        raise
    except BaseException as exc:  # noqa: BLE001 - TLS must never kill HTTP
        tls_core.set_serving(False)
        _log.error(
            "https listener failed (%s: %s) — continuing HTTP-only on port %s",
            type(exc).__name__, exc, settings.PORT,
        )


async def _serve_all(http_server: uvicorn.Server,
                     https_server: uvicorn.Server | None) -> None:
    tasks = [asyncio.ensure_future(http_server.serve())]
    if https_server is not None:
        tasks.append(asyncio.ensure_future(_serve_https_guarded(https_server)))
    try:
        await asyncio.gather(*tasks)
    finally:
        # If one listener died (e.g. HTTP port already bound -> SystemExit),
        # don't leave the sibling running headless: ask it to exit and let
        # asyncio.run's task-cancellation finish the job.
        for task in tasks:
            if not task.done():
                task.cancel()


def main() -> None:
    # 1. Console logging exactly as the uvicorn CLI would set it up.
    try:
        logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)
    except Exception:  # noqa: BLE001 - console logging is best-effort
        pass
    # 2. Rotating file log AFTER dictConfig (so the file handler attached to
    #    uvicorn.access/uvicorn.error survives — see module docstring).
    applog.init_logging()

    # 3. TLS material (best-effort; never blocks boot). The CA is the SHARED
    #    v1 anchor (read-only); the leaf is v2's own (relay/.runtime/tls/).
    tls_paths = None
    if settings.TLS_ENABLED:
        tls_paths = tls_core.ensure_certs()
        if tls_paths is None:
            _log.warning(
                "tls unavailable — serving HTTP only on %s:%s (see earlier "
                "tls log lines for the reason; usually: %s)",
                settings.HOST, settings.PORT, tls_core.CA_MISSING_INSTRUCTION,
            )
    else:
        _log.info("tls disabled by configuration (STUDIO2_TLS=0 / [server] tls=false)")

    # 4. Servers. HTTP runs the lifespan (auto -> on); HTTPS adds TLS with
    #    lifespan off so startup logic runs exactly once.
    http_server = _QuietSignalServer(_build_config(settings.PORT, lifespan="auto"))
    https_server: uvicorn.Server | None = None
    if tls_paths is not None:
        https_server = _QuietSignalServer(
            _build_config(
                settings.TLS_PORT,
                lifespan="off",
                ssl_certfile=str(tls_paths.leaf_cert),
                ssl_keyfile=str(tls_paths.leaf_key),
            )
        )
        tls_core.set_serving(True)
        _log.info(
            "listeners starting: http=%s:%s https=%s:%s (leaf signed by the "
            "shared v1 CA at %s)",
            settings.HOST, settings.PORT, settings.HOST, settings.TLS_PORT,
            settings.CA_DIR,
        )
    else:
        tls_core.set_serving(False)
        _log.info("listener starting: http=%s:%s (https off)", settings.HOST, settings.PORT)

    servers: list[uvicorn.Server] = [http_server]
    if https_server is not None:
        servers.append(https_server)
    _install_signal_handlers(servers)

    try:
        asyncio.run(_serve_all(http_server, https_server))
    except KeyboardInterrupt:  # pragma: no cover - belt-and-suspenders
        pass  # a Ctrl+C that slipped past the handler still exits cleanly


if __name__ == "__main__":
    main()
