"""Local CA + leaf TLS certificates (Secure Studio plan, 2026-06-11).

Pure certificate logic — NO FastAPI imports. ``app/serve.py`` calls
:func:`ensure_certs` before starting the HTTPS listener; ``routers/tls.py`` and
``net.startup_banner`` read the parsed state lazily via :func:`get_state`.

Why an app-generated CA (and not a bare self-signed leaf): iOS only grants the
Screen Wake Lock API in a secure context, and the ONLY way a home-LAN origin
becomes secure on an iPhone is a certificate the phone explicitly trusts. A
stable local CA lets the phone trust ONCE — the short-lived leaf can then be
re-issued every time the DHCP IP changes without any phone interaction.

Cert spec (plan §2 — verbatim):

* Keys: EC P-256, PKCS8 PEM. ``ca.key`` / ``leaf.key`` in ``.runtime/tls/``,
  0600 on POSIX.
* CA cert: ``basicConstraints CA:true`` (critical); ``keyUsage
  keyCertSign,cRLSign`` (critical); SKI; **nameConstraints (critical)**
  permitting dNSName ``.local`` + ``localhost`` and iPAddress
  ``192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 127.0.0.0/8``; validity 10
  years, notBefore −48 h (clock-skew tolerance); CN ``video-use Studio CA
  <hostname> <8-hex-fp>`` (fp = first 8 hex of the SHA-256 of the public key
  SPKI, so a regenerated CA is visually distinguishable in trust stores);
  random 128-bit serial.
* Leaf: SANs ``DNS:localhost``, ``DNS:<hostname>.local``, ``IP:127.0.0.1``,
  ``IP:<every current private IPv4>``; EKU serverAuth; keyUsage
  digitalSignature; validity 397 days (≤ Apple's 398-day cap), notBefore
  −48 h; random 128-bit serial; signed by the CA (ECDSA-SHA256).

Regen rules (every launch, :func:`ensure_certs`):

* **CA — stable.** Regenerated ONLY when missing / unparseable / key-mismatch
  (or when :data:`CA_NAME_CONSTRAINTS` no longer matches the cert on disk —
  the documented escape hatch below). Damaged files are moved aside to
  ``<name>.bad-<ts>`` (never deleted — forensics) and the regen is logged
  LOUDLY because every phone must redo the Secure Setup.
* **Leaf — disposable.** Silently re-issued under the SAME CA whenever it is
  missing / unparseable / key-mismatched / not signed by the current CA /
  expiring in < 30 days / the current ``lan_ip()`` is not in its IP SANs /
  ``<hostname>.local`` is not in its DNS SANs. No phone interaction needed.
* No metadata sidecar — everything is re-derived by parsing the certs.
* :func:`ensure_certs` NEVER raises (same best-effort discipline as
  ``core/applog.py``): any failure returns ``None`` and the caller serves
  HTTP-only, exactly like today.

Fallback flag — :data:`CA_NAME_CONSTRAINTS`:
    The nameConstraints extension confines what this CA can ever vouch for
    (the four RFC1918/loopback ranges + ``.local``/``localhost``), minimizing
    the blast radius if ``ca.key`` ever leaked. iOS 18 / modern OpenSSL
    enforce constraints correctly, but if some device in the household
    REJECTS the constrained chain, set this constant to ``False``: the next
    launch detects the mismatch, regenerates the CA WITHOUT nameConstraints
    (loud — phones must redo Secure Setup once), and everything else is
    unchanged.

Security: private keys are never logged, never served, and never leave
``.runtime/tls/``. Log lines carry paths/fingerprints/reasons only.
"""

from __future__ import annotations

import datetime
import hashlib
import ipaddress
import logging
import os
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from .. import net, settings

_log = logging.getLogger("studio.tls")

# --- the documented fallback flag (see module docstring) --------------------
# True  -> the CA carries a critical nameConstraints extension (default).
# False -> the CA is regenerated WITHOUT nameConstraints on the next launch
#          (use only if a device rejects the constrained chain).
CA_NAME_CONSTRAINTS: bool = True

# Plan §2 constants.
CA_VALIDITY_DAYS = 3650          # 10 years
LEAF_VALIDITY_DAYS = 397         # ≤ Apple's 398-day public-TLS cap
BACKDATE_HOURS = 48              # notBefore −48h (phone clock skew)
LEAF_RENEW_BEFORE_DAYS = 30      # silently re-issue when expiring sooner

CA_CERT_NAME = "ca.pem"
CA_KEY_NAME = "ca.key"
LEAF_CERT_NAME = "leaf.pem"
LEAF_KEY_NAME = "leaf.key"

# The ONLY address space this CA may ever vouch for (nameConstraints) — and
# the filter applied to collected interface addresses for the leaf SANs (a
# SAN outside the permitted set would break the chain on constraint-enforcing
# platforms). Order mirrors the plan table.
_PERMITTED_NETS: tuple[ipaddress.IPv4Network, ...] = (
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("127.0.0.0/8"),
)


@dataclass(frozen=True)
class TlsPaths:
    """Where the (now guaranteed-valid) cert material lives on disk."""

    ca_cert: Path
    ca_key: Path
    leaf_cert: Path
    leaf_key: Path
    ca_regenerated: bool  # True -> phones must redo the Secure Setup


@dataclass(frozen=True)
class TlsState:
    """Parsed, public-only facts about the certs on disk (for /api/tls/info
    and the startup banner). Contains NOTHING secret."""

    available: bool                 # both certs parse and the leaf is in-validity
    ca_sha256: str | None           # hex SHA-256 fingerprint of the CA cert (DER)
    leaf_expires: str | None        # ISO 8601 notAfter of the leaf
    leaf_dns_sans: tuple[str, ...]
    leaf_ip_sans: tuple[str, ...]


_EMPTY_STATE = TlsState(False, None, None, (), ())

_LOCK = threading.Lock()
_ca_regenerated_this_boot = False

# serve.py stashes its TLS decision here (see set_serving / is_enabled): the
# router can then answer truthfully even when serve.py decided HTTP-only.
_serving: bool | None = None

# get_state() cache: (ca mtime_ns, leaf mtime_ns) -> TlsState. Re-parsed only
# when either file changes, so steady-state /api/tls/info costs two stat()s.
_state_cache: tuple[tuple[int, int], TlsState] | None = None


# ============================================================================
# Host facts (hostname / private IPv4 collection)
# ============================================================================

def _hostname_label() -> str | None:
    """The machine's first hostname label, lowercased — or None if unusable
    as a DNS label (non-ASCII, empty, illegal chars). Delegates the
    validation to ``net.hostname_local`` so banner/SAN/URL all agree."""
    local = net.hostname_local()
    return local[: -len(".local")] if local else None


def _private_ipv4s() -> list[ipaddress.IPv4Address]:
    """Every current private IPv4 on this host, deduped and sorted.

    psutil is not a dependency, so two best-effort sources are merged:
    ``socket.getaddrinfo(socket.gethostname())`` (all registered interface
    addresses) and ``net.lan_ip()`` (the default-route interface — catches
    setups where the hostname does not resolve to the active NIC). The result
    is filtered to RFC1918 + loopback ONLY: anything else (e.g. a 169.254
    link-local) would fall outside the CA's nameConstraints and poison the
    chain. 127.0.0.1 is always present (plan §2 lists it explicitly).
    """
    found: set[str] = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addr = info[4][0]
            if isinstance(addr, str):
                found.add(addr)
    except OSError:
        pass
    try:
        found.add(net.lan_ip())
    except Exception:  # noqa: BLE001 - lan_ip is already best-effort
        pass

    out: list[ipaddress.IPv4Address] = []
    for raw in found:
        try:
            addr = ipaddress.IPv4Address(raw)
        except ValueError:
            continue
        if any(addr in network for network in _PERMITTED_NETS):
            out.append(addr)
    return sorted(out)


# ============================================================================
# Building blocks
# ============================================================================

def _random_serial() -> int:
    """Random 128-bit serial (plan §2), positive and non-zero."""
    return int.from_bytes(os.urandom(16), "big") or 1


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _spki_fp8(public_key) -> str:
    """First 8 hex chars of the SHA-256 of the public key SPKI (CN suffix)."""
    spki = public_key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(spki).hexdigest()[:8]


def _same_public_key(cert: x509.Certificate, key: ec.EllipticCurvePrivateKey) -> bool:
    a = cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    b = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return a == b


def _write_private_key(path: Path, key: ec.EllipticCurvePrivateKey) -> None:
    """PKCS8 PEM, written atomically, 0600 on POSIX (plan §2)."""
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    _atomic_write(path, pem)
    if os.name != "nt":
        os.chmod(path, 0o600)


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _load_cert(path: Path) -> x509.Certificate | None:
    try:
        return x509.load_pem_x509_certificate(path.read_bytes())
    except (OSError, ValueError):
        return None


def _load_key(path: Path) -> ec.EllipticCurvePrivateKey | None:
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except (OSError, ValueError, TypeError):
        return None
    return key if isinstance(key, ec.EllipticCurvePrivateKey) else None


def _move_aside(path: Path, stamp: str) -> None:
    """Preserve a damaged file as ``<name>.bad-<ts>`` (never delete it)."""
    if not path.exists():
        return
    target = path.with_name(f"{path.name}.bad-{stamp}")
    try:
        os.replace(path, target)
    except OSError:
        # Last resort (e.g. target collision on a same-second double regen):
        # the new material overwrites in place; the old bytes are lost but
        # the regen itself must not fail over forensics.
        pass


def _ca_has_name_constraints(cert: x509.Certificate) -> bool:
    try:
        cert.extensions.get_extension_for_class(x509.NameConstraints)
        return True
    except x509.ExtensionNotFound:
        return False


# ============================================================================
# Cert builders (plan §2 verbatim)
# ============================================================================

def _build_ca(key: ec.EllipticCurvePrivateKey) -> x509.Certificate:
    public_key = key.public_key()
    hostname = _hostname_label() or "studio"
    cn = f"video-use Studio CA {hostname} {_spki_fp8(public_key)}"
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])
    now = _now()

    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(public_key)
        .serial_number(_random_serial())
        .not_valid_before(now - datetime.timedelta(hours=BACKDATE_HOURS))
        .not_valid_after(now + datetime.timedelta(days=CA_VALIDITY_DAYS))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False
        )
    )
    if CA_NAME_CONSTRAINTS:
        builder = builder.add_extension(
            x509.NameConstraints(
                permitted_subtrees=[
                    x509.DNSName(".local"),
                    x509.DNSName("localhost"),
                    *(x509.IPAddress(network) for network in _PERMITTED_NETS),
                ],
                excluded_subtrees=None,
            ),
            critical=True,
        )
    return builder.sign(key, hashes.SHA256())


def _leaf_sans() -> tuple[list[x509.GeneralName], str | None]:
    """The leaf SAN list for THIS launch + the ``<hostname>.local`` name."""
    sans: list[x509.GeneralName] = [x509.DNSName("localhost")]
    host_local = net.hostname_local()
    if host_local:
        sans.append(x509.DNSName(host_local))
    for addr in _private_ipv4s():  # always includes 127.0.0.1
        sans.append(x509.IPAddress(addr))
    return sans, host_local


def _build_leaf(
    key: ec.EllipticCurvePrivateKey,
    ca_cert: x509.Certificate,
    ca_key: ec.EllipticCurvePrivateKey,
) -> x509.Certificate:
    public_key = key.public_key()
    sans, host_local = _leaf_sans()
    cn = host_local or "localhost"
    now = _now()
    return (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
        .issuer_name(ca_cert.subject)
        .public_key(public_key)
        .serial_number(_random_serial())
        .not_valid_before(now - datetime.timedelta(hours=BACKDATE_HOURS))
        .not_valid_after(now + datetime.timedelta(days=LEAF_VALIDITY_DAYS))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=False,
        )
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False
        )
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )


# ============================================================================
# Regen-decision helpers
# ============================================================================

def _leaf_regen_reason(
    leaf: x509.Certificate | None,
    leaf_key: ec.EllipticCurvePrivateKey | None,
    ca_cert: x509.Certificate,
) -> str | None:
    """Why the leaf must be re-issued, or None when it is still good.

    Mirrors the plan §2 leaf rules: missing/unparseable, key-mismatch,
    expiring < 30 days, current ``lan_ip()`` not in the IP SANs,
    ``<hostname>.local`` not in the DNS SANs — plus "not signed by the
    current CA" (mandatory after any CA regen, or the chain breaks).
    """
    if leaf is None or leaf_key is None:
        return "missing or unparseable"
    if not _same_public_key(leaf, leaf_key):
        return "cert/key mismatch"
    if leaf.issuer != ca_cert.subject:
        return "not issued by the current CA"
    try:
        ca_cert.public_key().verify(
            leaf.signature,
            leaf.tbs_certificate_bytes,
            ec.ECDSA(leaf.signature_hash_algorithm),
        )
    except Exception:  # noqa: BLE001 - any verify failure means re-sign
        return "signature does not verify against the current CA"
    if leaf.not_valid_after_utc - _now() < datetime.timedelta(days=LEAF_RENEW_BEFORE_DAYS):
        return f"expiring within {LEAF_RENEW_BEFORE_DAYS} days"

    try:
        san = leaf.extensions.get_extension_for_class(
            x509.SubjectAlternativeName
        ).value
        ip_sans = {str(ip) for ip in san.get_values_for_type(x509.IPAddress)}
        dns_sans = {d.lower() for d in san.get_values_for_type(x509.DNSName)}
    except x509.ExtensionNotFound:
        return "no SAN extension"

    try:
        current_ip = net.lan_ip()
    except Exception:  # noqa: BLE001
        current_ip = "127.0.0.1"
    if current_ip not in ip_sans:
        return f"current lan_ip {current_ip} not in IP SANs"

    host_local = net.hostname_local()
    if host_local and host_local not in dns_sans:
        return f"{host_local} not in DNS SANs"
    return None


# ============================================================================
# Public API
# ============================================================================

def ensure_certs() -> TlsPaths | None:
    """Make ``.runtime/tls/`` hold a valid CA + leaf; return their paths.

    Returns ``None`` when TLS material cannot be provided (any unexpected
    failure) — the caller then serves HTTP-only. NEVER raises.
    """
    global _ca_regenerated_this_boot, _state_cache
    try:
        with _LOCK:
            tls_dir = settings.TLS_DIR
            tls_dir.mkdir(parents=True, exist_ok=True)

            # Sweep stale *.tmp leftovers from a crashed/interrupted
            # _atomic_write (a key tmp may hold private-key bytes; none is
            # ever reused). Scoped to .runtime/tls/ and *.tmp ONLY — the
            # forensic *.bad-<ts> files don't match and are never touched.
            for stale in tls_dir.glob("*.tmp"):
                try:
                    stale.unlink()
                except OSError:
                    pass  # best-effort: a locked tmp must not block boot

            ca_cert_path = tls_dir / CA_CERT_NAME
            ca_key_path = tls_dir / CA_KEY_NAME
            leaf_cert_path = tls_dir / LEAF_CERT_NAME
            leaf_key_path = tls_dir / LEAF_KEY_NAME

            # ---- CA: stable; regenerated only when damaged ----------------
            ca_cert = _load_cert(ca_cert_path)
            ca_key = _load_key(ca_key_path)
            ca_existed = ca_cert_path.exists() or ca_key_path.exists()
            ca_problem: str | None = None
            if ca_cert is None or ca_key is None:
                ca_problem = "missing or unparseable"
            elif not _same_public_key(ca_cert, ca_key):
                ca_problem = "cert/key mismatch"
            elif _ca_has_name_constraints(ca_cert) != CA_NAME_CONSTRAINTS:
                ca_problem = (
                    "nameConstraints flag changed "
                    f"(CA_NAME_CONSTRAINTS={CA_NAME_CONSTRAINTS})"
                )

            ca_regenerated = False
            if ca_problem is not None:
                stamp = time.strftime("%Y%m%d-%H%M%S")
                if ca_existed:
                    for p in (ca_cert_path, ca_key_path):
                        _move_aside(p, stamp)
                ca_key = ec.generate_private_key(ec.SECP256R1())
                ca_cert = _build_ca(ca_key)
                _write_private_key(ca_key_path, ca_key)
                _atomic_write(
                    ca_cert_path, ca_cert.public_bytes(serialization.Encoding.PEM)
                )
                if ca_existed:
                    # LOUD by design: every phone's trust anchor just changed.
                    ca_regenerated = True
                    _ca_regenerated_this_boot = True
                    _log.warning(
                        "tls CA REGENERATED (%s) — damaged files preserved as "
                        "*.bad-%s; NEW certificate authority generated "
                        "(fingerprint=%s). Phones must redo the Secure Setup "
                        "(/setup) to trust the new certificate.",
                        ca_problem, stamp,
                        ca_cert.fingerprint(hashes.SHA256()).hex()[:16],
                    )
                else:
                    # First run: nothing to re-trust yet — informational only.
                    _log.info(
                        "tls CA created (first run) fingerprint=%s",
                        ca_cert.fingerprint(hashes.SHA256()).hex()[:16],
                    )

            # ---- Leaf: disposable; silently re-issued under the same CA ---
            leaf_cert = _load_cert(leaf_cert_path)
            leaf_key = _load_key(leaf_key_path)
            reason = _leaf_regen_reason(leaf_cert, leaf_key, ca_cert)
            if reason is not None:
                leaf_key = ec.generate_private_key(ec.SECP256R1())
                leaf_cert = _build_leaf(leaf_key, ca_cert, ca_key)
                _write_private_key(leaf_key_path, leaf_key)
                _atomic_write(
                    leaf_cert_path, leaf_cert.public_bytes(serialization.Encoding.PEM)
                )
                san = leaf_cert.extensions.get_extension_for_class(
                    x509.SubjectAlternativeName
                ).value
                _log.info(
                    "tls leaf certificate issued (%s) — sans_dns=%s sans_ip=%s "
                    "expires=%s ca_stable=%s",
                    reason,
                    ",".join(san.get_values_for_type(x509.DNSName)),
                    ",".join(str(ip) for ip in san.get_values_for_type(x509.IPAddress)),
                    leaf_cert.not_valid_after_utc.date().isoformat(),
                    not ca_regenerated,
                )

            _state_cache = None  # files may have changed; drop the parse cache
            return TlsPaths(
                ca_cert=ca_cert_path,
                ca_key=ca_key_path,
                leaf_cert=leaf_cert_path,
                leaf_key=leaf_key_path,
                ca_regenerated=ca_regenerated,
            )
    except Exception as exc:  # noqa: BLE001 - TLS can NEVER block boot
        _log.warning(
            "tls ensure_certs failed (%s: %s) — HTTPS unavailable this run, "
            "serving HTTP only",
            type(exc).__name__, exc,
        )
        return None


def get_state() -> TlsState:
    """Parsed public facts about the certs on disk. Never raises.

    Lazily re-parses only when either PEM's mtime changes, so the public
    ``/api/tls/info`` endpoint stays cheap under polling. Works in EVERY run
    mode — including the legacy ``python -m uvicorn app.main:app`` path where
    ``ensure_certs()`` never ran (it just reports what is on disk).
    """
    global _state_cache
    try:
        ca_path = settings.TLS_DIR / CA_CERT_NAME
        leaf_path = settings.TLS_DIR / LEAF_CERT_NAME
        try:
            key = (ca_path.stat().st_mtime_ns, leaf_path.stat().st_mtime_ns)
        except OSError:
            _state_cache = None
            return _EMPTY_STATE
        if _state_cache is not None and _state_cache[0] == key:
            return _state_cache[1]

        ca_cert = _load_cert(ca_path)
        leaf_cert = _load_cert(leaf_path)
        if ca_cert is None or leaf_cert is None:
            state = _EMPTY_STATE
        else:
            now = _now()
            in_validity = (
                leaf_cert.not_valid_before_utc <= now <= leaf_cert.not_valid_after_utc
            )
            try:
                san = leaf_cert.extensions.get_extension_for_class(
                    x509.SubjectAlternativeName
                ).value
                dns_sans = tuple(san.get_values_for_type(x509.DNSName))
                ip_sans = tuple(str(ip) for ip in san.get_values_for_type(x509.IPAddress))
            except x509.ExtensionNotFound:
                dns_sans, ip_sans = (), ()
            state = TlsState(
                available=in_validity,
                ca_sha256=ca_cert.fingerprint(hashes.SHA256()).hex(),
                leaf_expires=leaf_cert.not_valid_after_utc.isoformat(),
                leaf_dns_sans=dns_sans,
                leaf_ip_sans=ip_sans,
            )
        _state_cache = (key, state)
        return state
    except Exception:  # noqa: BLE001 - state probing must never break a caller
        return _EMPTY_STATE


def ca_der() -> bytes | None:
    """The CA certificate as DER bytes (for ``GET /ca.crt``), or None."""
    try:
        cert = _load_cert(settings.TLS_DIR / CA_CERT_NAME)
        if cert is None:
            return None
        return cert.public_bytes(serialization.Encoding.DER)
    except Exception:  # noqa: BLE001 - serving the CA is best-effort
        return None


def set_serving(active: bool) -> None:
    """``app/serve.py`` records whether the HTTPS listener is actually up.

    Under the legacy ``python -m uvicorn`` entrypoint this is never called
    and :func:`is_enabled` falls back to "configured AND cert files valid"
    (the documented nuance: whether a port answers is unknowable from here).
    """
    global _serving
    _serving = active


def is_enabled() -> bool:
    """Whether HTTPS should be advertised (banner, /api/tls/info, secure_url).

    * serve.py ran: its explicit decision wins (a TLS startup failure or
      STUDIO_TLS=0 reports False even if valid cert files sit on disk).
    * Legacy entrypoint (serve.py never ran): TLS configured on AND the cert
      files on disk parse + are in-validity. The HTTPS port itself may not be
      listening in that mode — accepted + documented (plan/architecture).
    Never raises.
    """
    try:
        if _serving is not None:
            return _serving and get_state().available
        return settings.TLS_ENABLED and get_state().available
    except Exception:  # noqa: BLE001
        return False


def ca_regenerated_this_boot() -> bool:
    """True when this process regenerated the CA (banner warning hook)."""
    return _ca_regenerated_this_boot
