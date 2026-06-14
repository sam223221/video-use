"""Networking / launcher helpers (ARCHITECTURE.md §2.4).

Pure process/network concerns: detect the LAN IP, render a terminal QR for the
LAN URL, build the startup banner (URLs + login credentials + firewall hint).
Imports nothing from the agent or helpers.

Login model (brief Delta 1 + Delta 3 multi-user): the app is reached at
``http://<host>:<port>/`` and the user logs in with one of the configured
accounts (the ``[users]`` table in config.toml, plus the legacy
``STUDIO_USERNAME`` / ``STUDIO_PASSWORD`` pair). The banner shows a representative
username. If NO account is configured and a password was auto-generated (native
first run), it is printed ONCE here for convenience — never persisted, never
re-logged elsewhere.
"""

from __future__ import annotations

import re
import socket
import sys

from . import settings

# Single DNS label: ASCII letters/digits/hyphens, no leading/trailing hyphen,
# max 63 chars (RFC 1035 syntax — what mDNS responders will actually answer).
_HOSTNAME_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


def _stdout_is_utf8() -> bool:
    """True when stdout can encode the QR's Unicode block glyphs.

    The terminal QR uses U+2580/2584/2588, which a non-UTF-8 console (cp1252
    redirect, Windows service, some Docker log pipes) cannot represent. When in
    doubt we treat stdout as non-UTF-8 and skip the QR block so the credentials
    banner still prints cleanly.
    """
    enc = getattr(sys.stdout, "encoding", None)
    if not enc:
        return False
    return enc.replace("-", "").lower().startswith("utf8")


def lan_ip() -> str:
    """Best-effort primary LAN IPv4. Falls back to 127.0.0.1."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # No packet is actually sent; this picks the default-route interface.
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def hostname_local() -> str | None:
    """This machine's stable mDNS name ``<hostname>.local``, or None.

    Lowercases the first label of ``socket.gethostname()`` and validates it as
    a plain-ASCII DNS label — a non-ASCII / malformed hostname yields None so
    callers (cert SANs, banner, /api/tls/info) simply omit the ``.local`` name
    rather than minting one that mDNS can never answer.
    """
    try:
        name = socket.gethostname()
    except OSError:
        return None
    label = name.split(".", 1)[0].strip()
    if not label or not label.isascii():
        return None
    label = label.lower()
    if not _HOSTNAME_LABEL_RE.match(label):
        return None
    return f"{label}.local"


def firewall_hint(*ports: int) -> str:
    """One ``netsh`` allow-rule command per port (newline-joined).

    Secure Studio (2026-06-11): callers pass BOTH the http and https ports so
    the banner hint covers the full surface; ``open-firewall.ps1`` adds the
    same two rules idempotently.
    """
    return "\n".join(
        f'netsh advfirewall firewall add rule name="video-use Studio {port}" '
        f"dir=in action=allow protocol=TCP localport={port}"
        for port in ports
    )


def _terminal_qr(url: str) -> str | None:
    """Render an ASCII QR for ``url`` to a string, or None if qrcode is missing."""
    try:
        import io

        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        buf = io.StringIO()
        qr.print_ascii(out=buf, invert=True)
        return buf.getvalue()
    except Exception:  # noqa: BLE001
        return None


def _tls_banner_facts() -> tuple[bool, bool]:
    """(tls_enabled, ca_regenerated_this_boot) — best-effort, never raises.

    Imported lazily to keep the module graph acyclic (``core/tls.py`` imports
    this module at module level for ``lan_ip``/``hostname_local``).
    """
    try:
        from .core import tls as tls_core

        return tls_core.is_enabled(), tls_core.ca_regenerated_this_boot()
    except Exception:  # noqa: BLE001 - the banner must always print
        return False, False


def startup_banner(host: str, port: int) -> str:
    """Build the multi-line startup banner string (printed by main on startup).

    Secure Studio (2026-06-11): now the SINGLE source of URLs/QR (the bat-side
    IP/QR block was removed). The QR + LAN line stay **http** deliberately —
    first contact must be scare-screen-free; the Secure block + the ``/setup``
    hint are the upgrade path once the phone trusts the local CA.
    """
    ip = lan_ip()
    bind_host = "localhost" if host in ("127.0.0.1", "localhost") else host
    local_url = f"http://localhost:{port}/"
    lan_url = f"http://{ip}:{port}/"
    tls_enabled, ca_regenerated = _tls_banner_facts()

    lines: list[str] = []
    lines.append("")
    lines.append("=" * 64)
    lines.append("  video-use Studio")
    lines.append("=" * 64)
    lines.append(f"  Local:   {local_url}")
    lines.append(f"  LAN:     {lan_url}   (open on your phone)")
    if tls_enabled:
        host_local = hostname_local()
        lines.append(f"  Secure:  https://{ip}:{settings.TLS_PORT}/   (after one-time setup)")
        if host_local:
            lines.append(f"           https://{host_local}:{settings.TLS_PORT}/   (survives IP changes)")
        lines.append("")
        lines.append(f"  First time on a phone? Open {lan_url.rstrip('/')}/setup")
        lines.append("  for the 2-minute secure setup (uploads survive a locked screen).")
    if ca_regenerated:
        lines.append("")
        lines.append("  !! The secure certificate authority was REGENERATED this run.")
        lines.append("  !! Phones must redo the Secure Setup before https works again:")
        lines.append(f"  !!   {lan_url.rstrip('/')}/setup")
    lines.append("")
    lines.append("  Sign in with:")
    lines.append(f"    username: {settings.username()}")
    gen = settings.generated_password()
    if gen is not None:
        lines.append(f"    password: {gen}   (auto-generated this run)")
    else:
        lines.append("    password: (from STUDIO_PASSWORD / config)")
    lines.append("")

    qr = _terminal_qr(lan_url) if _stdout_is_utf8() else None
    if qr:
        lines.append("  Scan to open on your phone (then sign in):")
        for q_line in qr.rstrip("\n").splitlines():
            lines.append("  " + q_line)
        lines.append("")

    if bind_host == "0.0.0.0":
        ports = (port, settings.TLS_PORT) if tls_enabled else (port,)
        lines.append("  If the phone can't connect, allow the port(s) through the firewall")
        lines.append("  (or run open-firewall.ps1 once as Administrator):")
        for hint_line in firewall_hint(*ports).splitlines():
            lines.append("    " + hint_line)
        lines.append("")
    lines.append("=" * 64)
    lines.append("")
    return "\n".join(lines)
