"""Settings & path resolution for the Studio v2 relay.

Single source of truth for every path, port, limit and credential the relay
needs. Everything is derived from this file's location so it works regardless
of the CWD or where the venv lives. Adapted from v1 ``studio/app/settings.py``
(field-hardened patterns kept; the upload/session/helper machinery does not
exist in v2 and is deliberately absent).

Path layout::

    <repo_root>/
    ├── studio/                   <- v1 (byte-untouched; its .runtime/tls/ is
    │                                the SHARED trust anchor — read-only)
    └── studio2/
        ├── pwa/                  <- PWA_DIR (served at /static/*, owned by
        │                            the frontend engineers — Steps 2/4/5)
        └── relay/
            ├── app/              <- this package (PACKAGE_DIR)
            ├── config.toml       <- optional config (env vars take precedence)
            └── .runtime/         <- RUNTIME_DIR (session secret, own TLS leaf,
                                     logs) — gitignored

Auth model (arch §8.2): a username/password login mints a signed, httpOnly
session cookie. v2 MUST use its own cookie names (``studio2_session`` /
``__Host-studio2_session``) and its OWN signing secret: cookies are
host-scoped, not port-scoped, so v1 (:8443) and v2 (:8543) on the same host
share a cookie jar — name reuse with a different secret would clobber the
other app's login. Nothing secret is ever logged.

TLS model (arch §8.4): v2 reads v1's certificate authority READ-ONLY from
``CA_DIR`` and issues its OWN leaf into ``relay/.runtime/tls/``. v2 never
writes to or regenerates the CA — phones that completed v1's Secure Setup
trust v2 immediately, with zero re-trust.
"""

from __future__ import annotations

import os
import secrets
from pathlib import Path

try:  # Python 3.11+ stdlib TOML reader.
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - defensive only
    tomllib = None  # type: ignore[assignment]


# --- core paths -----------------------------------------------------------
# studio2/relay/app/settings.py -> app -> relay -> studio2 -> repo root
PACKAGE_DIR: Path = Path(__file__).resolve().parent
RELAY_DIR: Path = PACKAGE_DIR.parent
STUDIO2_DIR: Path = RELAY_DIR.parent
REPO_ROOT: Path = STUDIO2_DIR.parent

# The PWA (served at /static/* + the / shell + /setup). Owned by the frontend
# engineers; may not exist yet during a partial deploy — every consumer
# tolerates its absence (clean 4xx/5xx, never a crash).
PWA_DIR: Path = STUDIO2_DIR / "pwa"

RUNTIME_DIR: Path = RELAY_DIR / ".runtime"
# v2's OWN leaf certificate lives here (signed by the shared v1 CA).
TLS_DIR: Path = RUNTIME_DIR / "tls"
CONFIG_FILE: Path = RELAY_DIR / "config.toml"

VERSION: str = "studio2 0.1.0"

# Session cookie configuration (arch §8.2 — names MUST differ from v1).
SESSION_COOKIE_NAME: str = "studio2_session"
# HTTPS logins issue the __Host- prefixed cookie instead: the browser only
# ACCEPTS a __Host-* Set-Cookie when it carries Secure + Path=/ + no Domain,
# so an insecure (http) origin can never plant or overwrite it. HTTP logins
# keep the plain name; deps.current_user reads the __Host- cookie first.
SECURE_SESSION_COOKIE_NAME: str = "__Host-studio2_session"
SESSION_TTL_SECONDS: int = 7 * 24 * 3600  # ~7 days ("remember me" checked)
# "Remember me" unchecked: the cookie is a session cookie (no Max-Age) but the
# signed token still needs a finite TTL so a cookie restored from a crashed /
# re-opened browser cannot be replayed indefinitely.
UNREMEMBERED_TTL_SECONDS: int = 12 * 3600


# --- optional config.toml loading -----------------------------------------
def _load_config() -> dict:
    """Read ``config.toml`` if present. Env vars always take precedence.

    Never raises: a malformed/missing config falls back to an empty dict.
    """
    if tomllib is None or not CONFIG_FILE.exists():
        return {}
    try:
        with CONFIG_FILE.open("rb") as fh:
            return tomllib.load(fh)
    except Exception:  # noqa: BLE001 - config is best-effort
        return {}


_CONFIG: dict = _load_config()


def _cfg(section: str, key: str, default=None):
    sect = _CONFIG.get(section)
    if isinstance(sect, dict) and key in sect:
        return sect[key]
    return default


# --- server binding (arch §1.1: HTTP :8520 / HTTPS :8543) ------------------
# 0.0.0.0 so a phone can reach the relay on the LAN. v1 keeps 8420/8443 —
# both stacks run simultaneously on one host.
HOST: str = os.environ.get("STUDIO2_HOST") or str(_cfg("server", "host", "0.0.0.0"))
PORT: int = int(os.environ.get("STUDIO2_PORT") or _cfg("server", "port", 8520))


# --- TLS / HTTPS -----------------------------------------------------------
def _env_bool(name: str) -> bool | None:
    """Parse a boolean env var; None when unset/empty (fall through to config)."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    return raw.strip().lower() not in ("0", "false", "no", "off")


_TLS_ENV = _env_bool("STUDIO2_TLS")
TLS_ENABLED: bool = _TLS_ENV if _TLS_ENV is not None else bool(_cfg("server", "tls", True))
TLS_PORT: int = int(os.environ.get("STUDIO2_TLS_PORT") or _cfg("server", "tls_port", 8543))


def _resolve_ca_dir() -> Path:
    """Where the SHARED v1 certificate authority lives (READ-ONLY).

    Resolution order: ``STUDIO2_CA_DIR`` env -> ``[server] ca_dir`` in
    config.toml -> the default ``../../studio/.runtime/tls`` relative to the
    relay root (computed from this file's location, so it is correct no
    matter the CWD). A relative configured value resolves against the relay
    root (``RELAY_DIR``) for the same CWD-independence. Never raises — a
    malformed value falls back to the default and the TLS layer reports the
    (then probably missing) CA loudly at boot.
    """
    default = REPO_ROOT / "studio" / ".runtime" / "tls"
    raw = os.environ.get("STUDIO2_CA_DIR") or _cfg("server", "ca_dir")
    if not raw:
        return default
    try:
        p = Path(str(raw)).expanduser()
        if not p.is_absolute():
            p = RELAY_DIR / p
        return Path(os.path.normpath(str(p)))
    except (OSError, ValueError):
        return default


CA_DIR: Path = _resolve_ca_dir()


# --- auth / credentials (multi-user — v1 model, v2 namespace) ---------------
# Credentials are loaded as a username -> password map from merged sources,
# in increasing precedence:
#
#   1. The ``[users]`` table in studio2/relay/config.toml (the real accounts).
#   2. The legacy single pair STUDIO2_USERNAME / STUDIO2_PASSWORD env (or an
#      [auth] table) — kept for env-only deployments and test harnesses.
#   3. If NO account is configured at all, a single ``admin`` account with an
#      auto-generated password (first-run convenience; printed once).
#
# Passwords are never logged. The compare itself (constant time) lives in
# security.py; this module only exposes the resolved map.
_GENERATED_PASSWORD: str | None = None


def _legacy_single_user() -> tuple[str, str] | None:
    """The ``[auth]`` / ``STUDIO2_*`` single account, if explicitly set."""
    user = os.environ.get("STUDIO2_USERNAME") or _cfg("auth", "username")
    pw = os.environ.get("STUDIO2_PASSWORD") or _cfg("auth", "password")
    if user and pw:
        return str(user), str(pw)
    return None


def _config_users() -> dict[str, str]:
    """The ``[users]`` table from config.toml as a username -> password map.

    Non-string values are coerced to ``str``. A missing/malformed table yields
    an empty map. Usernames are kept verbatim (case-sensitive).
    """
    section = _CONFIG.get("users")
    if not isinstance(section, dict):
        return {}
    out: dict[str, str] = {}
    for name, pw in section.items():
        if isinstance(name, str) and pw is not None:
            out[name] = str(pw)
    return out


def users() -> dict[str, str]:
    """Resolved username -> password map for all valid login accounts.

    Merge order (later wins on key collision): config ``[users]`` table, then
    the single ``[auth]``/``STUDIO2_*`` account. If the result is empty,
    fall back to a single ``admin`` account whose password is auto-generated
    once per process and surfaced via ``generated_password()`` for the
    startup banner.
    """
    global _GENERATED_PASSWORD
    merged: dict[str, str] = {}
    merged.update(_config_users())

    legacy = _legacy_single_user()
    if legacy is not None:
        merged[legacy[0]] = legacy[1]

    if merged:
        return merged

    if _GENERATED_PASSWORD is None:
        _GENERATED_PASSWORD = secrets.token_urlsafe(12)
    return {"admin": _GENERATED_PASSWORD}


def username() -> str:
    """A representative login username (the first configured account).

    Multi-user logins record their own username in the session cookie; this
    helper exists only for the startup banner and as a sensible default.
    """
    configured = list(users().keys())
    return configured[0] if configured else "admin"


def generated_password() -> str | None:
    """The auto-generated password if one was generated, else None.

    None means at least one account was explicitly configured (never print a
    configured secret). A value is returned only on the no-config fallback.
    """
    users()  # ensures the fallback password is generated if needed
    return _GENERATED_PASSWORD


# --- session signing secret (arch §8.2: v2 has its OWN secret) ---------------
_SESSION_SECRET: bytes | None = None
_SECRET_FILE: Path = RUNTIME_DIR / "session_secret"


def session_secret() -> bytes:
    """HMAC signing secret for v2 session cookies.

    Resolution order:
      1. ``STUDIO2_SECRET`` env.
      2. Persisted ``relay/.runtime/session_secret`` (survives restarts).
      3. A freshly generated 32-byte secret, persisted to (2), 0600 on POSIX.

    The secret value is never logged. It is deliberately INDEPENDENT of v1's
    secret — the two apps share a host cookie jar and must never be able to
    validate each other's tokens.
    """
    global _SESSION_SECRET
    if _SESSION_SECRET is not None:
        return _SESSION_SECRET

    env_secret = os.environ.get("STUDIO2_SECRET")
    if env_secret:
        _SESSION_SECRET = env_secret.encode("utf-8")
        return _SESSION_SECRET

    try:
        if _SECRET_FILE.exists():
            data = _SECRET_FILE.read_bytes()
            if data:
                _SESSION_SECRET = data
                return _SESSION_SECRET
    except OSError:
        pass

    _SESSION_SECRET = secrets.token_bytes(32)
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        _SECRET_FILE.write_bytes(_SESSION_SECRET)
        if os.name != "nt":  # restrict perms on POSIX
            os.chmod(_SECRET_FILE, 0o600)
    except OSError:
        pass  # ephemeral secret is acceptable if we can't persist
    return _SESSION_SECRET


def secret_source() -> str:
    """Where the session secret came from (for diagnostics, never the value)."""
    if os.environ.get("STUDIO2_SECRET"):
        return "env"
    if _SECRET_FILE.exists():
        return "runtime_file"
    return "generated"


# --- transcription / ElevenLabs Scribe (M2, arch §3.5) ----------------------
# The relay's ONE outbound integration: it calls ElevenLabs Speech-to-Text on
# the device's behalf so the API key NEVER reaches the browser (M0 verified
# EL's CORS is ``*`` — a browser COULD call EL directly, which is exactly why
# the key must stay home). Everything here is read once at import; the key is
# resolved lazily by ``elevenlabs_api_key()`` so an env-only deployment and a
# config-only deployment both work, and the value is NEVER logged or surfaced.
#
# The transient audio spool for in-flight jobs lives under RUNTIME_DIR so it is
# gitignored and swept; ``core/transcribe.py`` owns its lifecycle.
TRANSCRIBE_SPOOL_DIR: Path = RUNTIME_DIR / "transcribe"

# Scribe defaults (arch §3.4). ``scribe_v2`` is the current batch model
# (verified live 2026-06-13); ``scribe_v1`` is deprecated upstream. The config
# can pin a different one (``core/transcribe.py`` still upgrades a legacy
# ``scribe_v1`` pin to v2 and honors any other explicit pin verbatim).
_TRANSCRIBE_DEFAULT_MODEL_ID = "scribe_v2"
_TRANSCRIBE_DEFAULT_MAX_AUDIO_MIB = 256       # hard per-upload byte cap
_TRANSCRIBE_DEFAULT_MAX_DURATION_MIN = 180    # soft per-call declared-duration cap
_TRANSCRIBE_DEFAULT_DAILY_CALL_CAP = 24       # per-process daily call guard
_TRANSCRIBE_DEFAULT_DAILY_AUDIO_MIB_CAP = 1024  # per-process daily audio guard (1 GiB)


def _cfg_bool(section: str, key: str, default: bool) -> bool:
    """Read a boolean from config.toml, tolerating string/int spellings."""
    raw = _cfg(section, key, None)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return bool(raw)
    if isinstance(raw, str):
        return raw.strip().lower() not in ("0", "false", "no", "off", "")
    return default


def _cfg_int(section: str, key: str, default: int) -> int:
    """Read a positive int from config.toml, falling back on anything odd."""
    raw = _cfg(section, key, None)
    try:
        if isinstance(raw, bool) or raw is None:
            return default
        val = int(raw)
        return val if val > 0 else default
    except (TypeError, ValueError):
        return default


# Master switch (arch §3.5): false -> 403 transcribe_disabled regardless of key.
TRANSCRIBE_ENABLED: bool = _cfg_bool("transcribe", "enabled", True)

# Scribe model id + optional pinned language (empty string = auto-detect, the
# household's mixed Faroese/English path — PM resolution §0.2).
TRANSCRIBE_MODEL_ID: str = str(_cfg("transcribe", "model_id", _TRANSCRIBE_DEFAULT_MODEL_ID)).strip() \
    or _TRANSCRIBE_DEFAULT_MODEL_ID
TRANSCRIBE_LANGUAGE: str = str(_cfg("transcribe", "language", "") or "").strip()

# Diarization flag (arch §13.4 — default OFF in M2; PM resolution §0.4).
TRANSCRIBE_DIARIZE: bool = _cfg_bool("transcribe", "diarize", False)

# Cost-abuse guards (arch §8.5). Bytes are the HARD guard; the declared
# duration is only a soft sanity cap (the device controls it).
TRANSCRIBE_MAX_AUDIO_MIB: int = _cfg_int(
    "transcribe", "max_audio_mib", _TRANSCRIBE_DEFAULT_MAX_AUDIO_MIB
)
TRANSCRIBE_MAX_AUDIO_BYTES: int = TRANSCRIBE_MAX_AUDIO_MIB * 1024 * 1024
TRANSCRIBE_MAX_DURATION_MIN: int = _cfg_int(
    "transcribe", "max_duration_min", _TRANSCRIBE_DEFAULT_MAX_DURATION_MIN
)
TRANSCRIBE_MAX_DURATION_S: float = float(TRANSCRIBE_MAX_DURATION_MIN * 60)
TRANSCRIBE_DAILY_CALL_CAP: int = _cfg_int(
    "transcribe", "daily_call_cap", _TRANSCRIBE_DEFAULT_DAILY_CALL_CAP
)
TRANSCRIBE_DAILY_AUDIO_MIB_CAP: int = _cfg_int(
    "transcribe", "daily_audio_mib_cap", _TRANSCRIBE_DEFAULT_DAILY_AUDIO_MIB_CAP
)
TRANSCRIBE_DAILY_AUDIO_BYTES_CAP: int = TRANSCRIBE_DAILY_AUDIO_MIB_CAP * 1024 * 1024


def elevenlabs_api_key() -> str | None:
    """The ElevenLabs Scribe key, or None when none is configured (arch §8.2).

    Resolution order (env wins so a secret never has to touch the tracked
    tree): ``STUDIO2_ELEVENLABS_API_KEY`` env -> ``ELEVENLABS_API_KEY`` env
    (the pre-existing v1-era var, kept for continuity) -> ``[transcribe]
    api_key`` in the gitignored config.toml. The value is NEVER logged, NEVER
    echoed in an error, and NEVER surfaced by ``/api/status`` (presence only).
    Read lazily (not cached at import) so a freshly-edited env/config is picked
    up on the next call without a restart-time snapshot lying.
    """
    env_key = os.environ.get("STUDIO2_ELEVENLABS_API_KEY") or os.environ.get(
        "ELEVENLABS_API_KEY"
    )
    if env_key and env_key.strip():
        return env_key.strip()
    cfg_key = _cfg("transcribe", "api_key", None)
    if isinstance(cfg_key, str) and cfg_key.strip():
        return cfg_key.strip()
    return None


def transcribe_configured() -> bool:
    """True when transcription can actually run: master switch on AND a key is
    present. Drives ``/api/status -> transcribe.configured`` (presence only,
    never the key) and the 403 ``transcribe_disabled`` gate."""
    return TRANSCRIBE_ENABLED and elevenlabs_api_key() is not None


# --- M3 render tier (the dormant-behind-a-flag deploy gate) -----------------
# The M3 render-tier AGENT TOOLS (set_output_format, set_clip_fit,
# list_music_library, add_music, update_music, remove_music) plus the prompt's
# format/music sections ship BEHIND this flag, DEFAULT OFF. The relay deploys
# the already-built Agent Vision + M2 features (which need a restart) WITHOUT
# prematurely exposing the M3 tools — whose DEVICE executors (pwa/bridge.js)
# do not exist yet, so the tools are dead at runtime and the prompt would make
# the agent OFFER format/music it cannot deliver. While OFF:
#   * agent/tools.py registers 9 tools (M2 + vision + base), NOT the 6 M3 ones;
#   * agent/prompt.py omits the §7 (format) + §8 (music) sections;
#   * core/bridge.py's _BRIDGE_TOOLS allowlist excludes the 6 M3 names.
# Flip it ON (config or env) only once the M3 frontend executors land.
#
# Read LAZILY (not snapshotted at import) so a freshly-edited config/env is
# honored on the next call without a restart-time snapshot lying — the same
# discipline as ``elevenlabs_api_key()``. Never raises; defaults False.
def render_enabled() -> bool:
    """True when the M3 render tier is turned on (``[render] enabled`` or the
    ``STUDIO2_RENDER_ENABLED`` env var). Default FALSE — the render tier stays
    dormant until the M3 device executors ship. Env wins over config; an
    unset/empty env falls through to config, and a missing/malformed config
    falls back to False (never raises)."""
    env = _env_bool("STUDIO2_RENDER_ENABLED")
    if env is not None:
        return env
    return _cfg_bool("render", "enabled", False)
