"""Shared-CA TLS for the Studio v2 relay — ADAPTED from v1 ``studio/app/core/tls.py``.

Pure certificate logic — NO FastAPI imports. ``app/serve.py`` calls
:func:`ensure_certs` before starting the HTTPS listener; ``routers/tls.py``
and the startup banner read the parsed state lazily via :func:`get_state`.

The trust model (arch §8.4 — the load-bearing differences from v1):

* **The CA is v1's CA, read-only, forever.** It is loaded from
  ``settings.CA_DIR`` (default ``studio/.runtime/tls/`` — the v1 trust
  anchor) and is NEVER written, regenerated, quarantined, or repaired by v2.
  Phones that completed v1's Secure Setup trust v2 immediately — same
  anchor, zero re-trust. A missing/damaged CA means **HTTP-only** plus a
  loud, actionable log line ("run Studio v1 once or set STUDIO2_CA_DIR") —
  never a fresh CA (regenerating someone else's trust anchor would break v1
  and force every phone through Secure Setup again).
* **v2 issues its OWN leaf** into ``relay/.runtime/tls/`` (leaf.pem /
  leaf.key), signed by the shared CA. No dual-writer on v1's leaf files;
  v1 stays byte-untouched; v2's HTTPS survives v1 being stopped.
* **Leaf SANs are filtered by the CA's OWN parsed nameConstraints.** The
  production v1 CA carries critical nameConstraints permitting only
  ``.local``/``localhost`` + RFC1918/loopback — a SAN outside that set (e.g.
  a Tailscale CGNAT address) would break chain validation entirely on
  constraint-enforcing platforms (RFC 5280). So the candidate pool here
  (:data:`_PERMITTED_NETS`) DOES include 100.64.0.0/10, and the
  constraint filter keeps CGNAT out until a CA that permits it appears —
  at which point the SANs grow automatically, no code change.

Leaf rules (every launch, :func:`ensure_certs`) — v1's disposable-leaf model:
silently re-issued when missing / unparseable / key-mismatched / not signed
by the current CA / expiring in < 30 days / the DESIRED (constraint-filtered)
SAN set is not fully covered by the SANs on disk. The desired-set drift check
generalizes v1's lan_ip/hostname drift rules: it also grows the SANs when a
newly permitted address appears, and it cannot regen-loop on an address the
CA refuses (a candidate the filter drops is never "desired").

Cert spec for the leaf (v1 plan §2 verbatim): EC P-256, PKCS8 key (0600 on
POSIX), SANs ``DNS:localhost`` + ``DNS:<hostname>.local`` + ``IP:127.0.0.1``
+ permitted private IPv4s, EKU serverAuth, keyUsage digitalSignature,
validity 397 days (≤ Apple's 398-day cap), notBefore −48 h, random 128-bit
serial, ECDSA-SHA256 by the CA.

:func:`ensure_certs` NEVER raises (the applog invariant): any failure returns
``None`` and the caller serves HTTP-only. Private keys are never logged,
never served, and never leave their directories. Log lines carry
paths/fingerprints/reasons only.
"""

from __future__ import annotations

import datetime
import ipaddress
import logging
import os
import socket
import threading
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from .. import net, settings

_log = logging.getLogger("studio2.tls")

# v1 plan §2 leaf constants (unchanged).
LEAF_VALIDITY_DAYS = 397         # ≤ Apple's 398-day public-TLS cap
BACKDATE_HOURS = 48              # notBefore −48h (phone clock skew)
LEAF_RENEW_BEFORE_DAYS = 30      # silently re-issue when expiring sooner

CA_CERT_NAME = "ca.pem"
CA_KEY_NAME = "ca.key"
LEAF_CERT_NAME = "leaf.pem"
LEAF_KEY_NAME = "leaf.key"

# The CANDIDATE address pool for leaf IP SANs. Unlike v1, this INCLUDES the
# CGNAT range (Tailscale) — arch §8.4: candidates are then filtered against
# the CA's own parsed nameConstraints, so under the production v1 CA
# (RFC1918+loopback only) CGNAT addresses are dropped, and under a future
# widened CA they ride in automatically.
_PERMITTED_NETS: tuple[ipaddress.IPv4Network, ...] = (
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("127.0.0.0/8"),
    ipaddress.IPv4Network("100.64.0.0/10"),  # CGNAT (Tailscale) — see above
)

# The fixed instruction printed whenever the shared CA cannot be used. One
# string so the log, the banner and DOCUMENT.md all say the same thing.
CA_MISSING_INSTRUCTION = (
    "Studio v2 shares Studio v1's certificate authority and NEVER creates its "
    "own. Run Studio v1 once (its first launch generates the CA at "
    "studio/.runtime/tls/) or set STUDIO2_CA_DIR / [server] ca_dir to a "
    "directory containing ca.pem + ca.key. Serving HTTP only until then."
)


@dataclass(frozen=True)
class TlsPaths:
    """Where the (now guaranteed-valid) cert material lives on disk."""

    ca_cert: Path    # the SHARED v1 CA (read-only)
    leaf_cert: Path  # v2's own leaf (relay/.runtime/tls/)
    leaf_key: Path


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
    as a DNS label. Delegates validation to ``net.hostname_local`` so
    banner/SAN/URL all agree."""
    local = net.hostname_local()
    return local[: -len(".local")] if local else None


def _candidate_ipv4s() -> list[ipaddress.IPv4Address]:
    """Every current candidate IPv4 on this host, deduped and sorted.

    Two best-effort sources are merged: ``socket.getaddrinfo`` over the
    hostname (all registered interface addresses) and ``net.lan_ip()`` (the
    default-route interface). The result is filtered to the CANDIDATE pool
    :data:`_PERMITTED_NETS` only — anything else (e.g. a 169.254 link-local
    or a public address) is never even a candidate. The CA-constraint filter
    in :func:`_leaf_sans` then decides what actually becomes a SAN.
    127.0.0.1 is always a candidate.
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
# CA nameConstraints parsing + SAN filtering (the v2-specific machinery)
# ============================================================================

@dataclass(frozen=True)
class _CaConstraints:
    """The CA's parsed nameConstraints, normalized for filtering.

    ``permitted_dns`` / ``permitted_nets`` are ``None`` when the CA places NO
    restriction on that name TYPE (RFC 5280: constraints apply per type; a
    type with no entries in permittedSubtrees — or no permittedSubtrees at
    all — is unrestricted). Excluded subtrees always apply when present.
    """

    permitted_dns: tuple[str, ...] | None
    permitted_nets: tuple[ipaddress.IPv4Network, ...] | None
    excluded_dns: tuple[str, ...]
    excluded_nets: tuple[ipaddress.IPv4Network, ...]


_UNCONSTRAINED = _CaConstraints(None, None, (), ())


def _split_general_names(
    names,
) -> tuple[list[str], list[ipaddress.IPv4Network]]:
    """(dns_constraints, ipv4_network_constraints) from a GeneralName list.

    In a nameConstraints extension, ``x509.IPAddress`` wraps a NETWORK (not a
    single address). Non-IPv4 / unrecognized name types are ignored — we only
    ever mint DNS + IPv4 SANs, so constraints on other types cannot affect
    the leaf we build.
    """
    dns: list[str] = []
    nets: list[ipaddress.IPv4Network] = []
    for gn in names or ():
        if isinstance(gn, x509.DNSName):
            dns.append(gn.value)
        elif isinstance(gn, x509.IPAddress) and isinstance(
            gn.value, ipaddress.IPv4Network
        ):
            nets.append(gn.value)
    return dns, nets


def _ca_constraints(ca_cert: x509.Certificate) -> _CaConstraints:
    """Parse the CA's nameConstraints. No extension -> unconstrained."""
    try:
        nc = ca_cert.extensions.get_extension_for_class(x509.NameConstraints).value
    except x509.ExtensionNotFound:
        return _UNCONSTRAINED

    perm_dns, perm_nets = _split_general_names(nc.permitted_subtrees)
    excl_dns, excl_nets = _split_general_names(nc.excluded_subtrees)
    return _CaConstraints(
        # Per-type: an empty permitted list for a type means UNRESTRICTED for
        # that type (only listed types are constrained).
        permitted_dns=tuple(perm_dns) if perm_dns else None,
        permitted_nets=tuple(perm_nets) if perm_nets else None,
        excluded_dns=tuple(excl_dns),
        excluded_nets=tuple(excl_nets),
    )


def _dns_matches(name: str, constraint: str) -> bool:
    """RFC 5280 dNSName constraint match (left-label extension).

    A constraint ``example.com`` matches ``example.com`` and
    ``foo.example.com``; the common leading-dot form ``.local`` matches any
    name ENDING in ``.local`` (this is exactly how the v1 CA expresses its
    mDNS constraint, and how OpenSSL/Apple interpret it).
    """
    n = name.lower().rstrip(".")
    c = constraint.lower().rstrip(".")
    if not c:
        return True  # an empty constraint matches everything (RFC 5280)
    if c.startswith("."):
        return n.endswith(c)
    return n == c or n.endswith("." + c)


def _dns_allowed(name: str, cons: _CaConstraints) -> bool:
    if any(_dns_matches(name, c) for c in cons.excluded_dns):
        return False
    if cons.permitted_dns is None:
        return True
    return any(_dns_matches(name, c) for c in cons.permitted_dns)


def _ip_allowed(addr: ipaddress.IPv4Address, cons: _CaConstraints) -> bool:
    if any(addr in network for network in cons.excluded_nets):
        return False
    if cons.permitted_nets is None:
        return True
    return any(addr in network for network in cons.permitted_nets)


def _desired_sans(
    ca_cert: x509.Certificate,
) -> tuple[list[str], list[ipaddress.IPv4Address], str | None]:
    """(dns_sans, ip_sans, hostname_local) the leaf SHOULD carry right now.

    Candidates (localhost, ``<hostname>.local``, 127.0.0.1, every candidate
    private/CGNAT IPv4) filtered by the CA's parsed nameConstraints — a SAN
    the CA cannot vouch for would poison the whole chain on
    constraint-enforcing platforms, so it is silently (well, loggedly)
    dropped instead.
    """
    cons = _ca_constraints(ca_cert)

    host_local = net.hostname_local()
    dns_candidates = ["localhost"] + ([host_local] if host_local else [])
    ip_candidates = _candidate_ipv4s()

    dns = [d for d in dns_candidates if _dns_allowed(d, cons)]
    ips = [a for a in ip_candidates if _ip_allowed(a, cons)]

    dropped_dns = sorted(set(dns_candidates) - set(dns))
    dropped_ips = sorted(set(ip_candidates) - set(ips), key=int)
    if dropped_dns or dropped_ips:
        # INFO, not WARNING: dropping CGNAT under the constrained v1 CA is
        # the designed steady state (arch §8.4 Option A — Tailscale subnet
        # routing reaches the relay via a LAN-IP SAN that IS permitted).
        _log.info(
            "tls leaf SAN candidates filtered by CA nameConstraints: "
            "dropped_dns=%s dropped_ip=%s (a CA that permits them would "
            "include them automatically)",
            ",".join(dropped_dns) or "-",
            ",".join(str(a) for a in dropped_ips) or "-",
        )
    return dns, ips, host_local


# ============================================================================
# Building blocks (v1 verbatim)
# ============================================================================

def _random_serial() -> int:
    """Random 128-bit serial, positive and non-zero."""
    return int.from_bytes(os.urandom(16), "big") or 1


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _same_public_key(cert: x509.Certificate, key: ec.EllipticCurvePrivateKey) -> bool:
    a = cert.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    b = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return a == b


def _write_private_key(path: Path, key: ec.EllipticCurvePrivateKey) -> None:
    """PKCS8 PEM, written atomically, 0600 on POSIX."""
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


# ============================================================================
# Leaf builder (v1 plan §2 verbatim, SANs from _desired_sans)
# ============================================================================

def _build_leaf(
    key: ec.EllipticCurvePrivateKey,
    ca_cert: x509.Certificate,
    ca_key: ec.EllipticCurvePrivateKey,
    dns_sans: list[str],
    ip_sans: list[ipaddress.IPv4Address],
    host_local: str | None,
) -> x509.Certificate:
    public_key = key.public_key()
    sans: list[x509.GeneralName] = [x509.DNSName(d) for d in dns_sans]
    sans.extend(x509.IPAddress(a) for a in ip_sans)
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
# Regen decision (leaf ONLY — the CA is never v2's to regenerate)
# ============================================================================

def _leaf_regen_reason(
    leaf: x509.Certificate | None,
    leaf_key: ec.EllipticCurvePrivateKey | None,
    ca_cert: x509.Certificate,
    desired_dns: list[str],
    desired_ips: list[ipaddress.IPv4Address],
) -> str | None:
    """Why the leaf must be re-issued, or None when it is still good.

    v1's rules, with the lan_ip/hostname drift checks generalized to "the
    desired (constraint-filtered) SAN set must be covered by the SANs on
    disk" — which both detects the classic DHCP IP drift AND grows the SANs
    when a newly permitted address appears (e.g. CGNAT under a widened CA),
    while never regen-looping on an address the CA refuses (a dropped
    candidate is never desired).
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

    missing_dns = [d for d in desired_dns if d.lower() not in dns_sans]
    if missing_dns:
        return f"desired DNS SAN(s) missing: {','.join(missing_dns)}"
    missing_ips = [str(a) for a in desired_ips if str(a) not in ip_sans]
    if missing_ips:
        return f"desired IP SAN(s) missing: {','.join(missing_ips)}"
    return None


# ============================================================================
# Public API
# ============================================================================

def ensure_certs() -> TlsPaths | None:
    """Load the shared CA (read-only) and make ``relay/.runtime/tls/`` hold a
    valid leaf signed by it; return the paths.

    Returns ``None`` when TLS material cannot be provided — the caller then
    serves HTTP-only. NEVER raises, NEVER writes outside ``settings.TLS_DIR``,
    and NEVER creates or modifies anything in ``settings.CA_DIR``.
    """
    global _state_cache
    try:
        with _LOCK:
            ca_cert_path = settings.CA_DIR / CA_CERT_NAME
            ca_key_path = settings.CA_DIR / CA_KEY_NAME

            # ---- CA: shared, READ-ONLY, never regenerated ------------------
            ca_cert = _load_cert(ca_cert_path)
            ca_key = _load_key(ca_key_path)
            if ca_cert is None or ca_key is None:
                _log.error(
                    "tls shared CA missing or unparseable at %s — %s",
                    settings.CA_DIR, CA_MISSING_INSTRUCTION,
                )
                return None
            if not _same_public_key(ca_cert, ca_key):
                _log.error(
                    "tls shared CA cert/key mismatch at %s — the CA is NOT "
                    "repaired by Studio v2 (it belongs to Studio v1). %s",
                    settings.CA_DIR, CA_MISSING_INSTRUCTION,
                )
                return None

            # ---- v2's own leaf dir ----------------------------------------
            tls_dir = settings.TLS_DIR
            tls_dir.mkdir(parents=True, exist_ok=True)
            # Sweep stale *.tmp leftovers from a crashed/interrupted
            # _atomic_write (a key tmp may hold private-key bytes; none is
            # ever reused). Scoped to v2's OWN tls dir and *.tmp ONLY.
            for stale in tls_dir.glob("*.tmp"):
                try:
                    stale.unlink()
                except OSError:
                    pass  # best-effort: a locked tmp must not block boot

            leaf_cert_path = tls_dir / LEAF_CERT_NAME
            leaf_key_path = tls_dir / LEAF_KEY_NAME

            # ---- Leaf: disposable; silently re-issued under the shared CA --
            desired_dns, desired_ips, host_local = _desired_sans(ca_cert)
            if not desired_dns and not desired_ips:
                # A pathological CA that permits NOTHING we can carry — a
                # SAN-less leaf would be unusable, so fall back loudly.
                _log.error(
                    "tls CA nameConstraints permit no usable SAN for this "
                    "host — %s", CA_MISSING_INSTRUCTION,
                )
                return None

            leaf_cert = _load_cert(leaf_cert_path)
            leaf_key = _load_key(leaf_key_path)
            reason = _leaf_regen_reason(
                leaf_cert, leaf_key, ca_cert, desired_dns, desired_ips
            )
            if reason is not None:
                leaf_key = ec.generate_private_key(ec.SECP256R1())
                leaf_cert = _build_leaf(
                    leaf_key, ca_cert, ca_key, desired_dns, desired_ips, host_local
                )
                _write_private_key(leaf_key_path, leaf_key)
                _atomic_write(
                    leaf_cert_path, leaf_cert.public_bytes(serialization.Encoding.PEM)
                )
                san = leaf_cert.extensions.get_extension_for_class(
                    x509.SubjectAlternativeName
                ).value
                _log.info(
                    "tls leaf certificate issued (%s) — sans_dns=%s sans_ip=%s "
                    "expires=%s signed_by_shared_ca=%s",
                    reason,
                    ",".join(san.get_values_for_type(x509.DNSName)),
                    ",".join(str(ip) for ip in san.get_values_for_type(x509.IPAddress)),
                    leaf_cert.not_valid_after_utc.date().isoformat(),
                    ca_cert.fingerprint(hashes.SHA256()).hex()[:16],
                )

            _state_cache = None  # files may have changed; drop the parse cache
            return TlsPaths(
                ca_cert=ca_cert_path,
                leaf_cert=leaf_cert_path,
                leaf_key=leaf_key_path,
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

    CA from ``settings.CA_DIR`` (shared, v1's), leaf from ``settings.TLS_DIR``
    (v2's own). Lazily re-parses only when either PEM's mtime changes, so the
    public ``/api/tls/info`` endpoint stays cheap under polling.
    """
    global _state_cache
    try:
        ca_path = settings.CA_DIR / CA_CERT_NAME
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
    """The SHARED CA certificate as DER bytes (for ``GET /ca.crt``), or None.

    Byte-identical to what v1's ``/ca.crt`` serves (same PEM, same
    deterministic DER re-encoding) — one anchor, two apps.
    """
    try:
        cert = _load_cert(settings.CA_DIR / CA_CERT_NAME)
        if cert is None:
            return None
        return cert.public_bytes(serialization.Encoding.DER)
    except Exception:  # noqa: BLE001 - serving the CA is best-effort
        return None


def set_serving(active: bool) -> None:
    """``app/serve.py`` records whether the HTTPS listener is actually up."""
    global _serving
    _serving = active


def is_enabled() -> bool:
    """Whether HTTPS should be advertised (banner, /api/tls/info, secure_url).

    * serve.py ran: its explicit decision wins (a TLS startup failure or
      STUDIO2_TLS=0 reports False even if valid cert files sit on disk).
    * serve.py never ran (exotic entrypoint): TLS configured on AND the cert
      files on disk parse + are in-validity. Whether the port answers is
      unknowable in that mode — accepted + documented (v1 nuance carried).
    Never raises.
    """
    try:
        if _serving is not None:
            return _serving and get_state().available
        return settings.TLS_ENABLED and get_state().available
    except Exception:  # noqa: BLE001
        return False


# Kept import-compatible with v1 callers that ask about CA regeneration: v2
# NEVER regenerates the CA, so this is a constant truth, not a stub.
def ca_regenerated_this_boot() -> bool:
    """Always False — v2 never regenerates the shared CA (arch §8.4)."""
    return False
