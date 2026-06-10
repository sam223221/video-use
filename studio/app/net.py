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

import socket
import sys

from . import settings


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


def firewall_hint(port: int) -> str:
    return (
        f'netsh advfirewall firewall add rule name="video-use Studio {port}" '
        f"dir=in action=allow protocol=TCP localport={port}"
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


def startup_banner(host: str, port: int) -> str:
    """Build the multi-line startup banner string (printed by main on startup)."""
    ip = lan_ip()
    bind_host = "localhost" if host in ("127.0.0.1", "localhost") else host
    local_url = f"http://localhost:{port}/"
    lan_url = f"http://{ip}:{port}/"

    lines: list[str] = []
    lines.append("")
    lines.append("=" * 64)
    lines.append("  video-use Studio")
    lines.append("=" * 64)
    lines.append(f"  Local:   {local_url}")
    lines.append(f"  LAN:     {lan_url}   (open on your phone)")
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
        lines.append("  If the phone can't connect, allow the port through the firewall:")
        lines.append("    " + firewall_hint(port))
        lines.append("")
    lines.append("=" * 64)
    lines.append("")
    return "\n".join(lines)
