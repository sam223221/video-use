#!/usr/bin/env bash
# ===========================================================================
#  Studio v2 relay - native launcher (POSIX parity for start.bat)
#
#  Run path: NATIVE (Claude MAX plan). Deliberately does NOT export
#  ANTHROPIC_API_KEY, so the Claude Agent SDK uses your local Claude Code
#  login (MAX subscription) rather than pay-as-you-go billing - exactly like
#  Studio v1.
#
#  Steps mirror start.bat: ensure venv (Python 3.14) -> install deps once ->
#  open browser -> dependency self-check -> `python -m app.serve` (HTTP on
#  0.0.0.0:8520 AND HTTPS on 0.0.0.0:8543; the https certificate is v2's own,
#  signed by Studio v1's certificate authority - run Studio v1 once first, or
#  set STUDIO2_CA_DIR). The server's startup banner is the single source of
#  IP/URL/QR truth. Robust to spaces in the path.
#
#  NOTE: unlike v1's start.sh, this script INCLUDES the dependency self-check
#  (v1's omission was a documented gap - closed here for parity).
#
#  Auth: sign in with an account from studio2/relay/config.toml [users] (or
#  the auto-generated one in the banner). A signed httpOnly studio2_session
#  cookie is issued on login; there is no token-in-URL.
# ===========================================================================
set -euo pipefail

RELAY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$RELAY_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
REQ="$RELAY_DIR/requirements.txt"
DEPS_MARKER="$VENV_DIR/.deps-installed"
PORT=8520
TLS_PORT=8543

echo
echo " ============================================"
echo "  Studio v2 relay  -  native launch"
echo " ============================================"
echo

# --- choose a Python 3.14 interpreter for venv creation --------------------
pick_python() {
  if command -v python3.14 >/dev/null 2>&1; then echo "python3.14"; return; fi
  if command -v py >/dev/null 2>&1; then echo "py -3.14"; return; fi
  echo ""
}

# --- 1. ensure venv (Python 3.14) -----------------------------------------
if [ ! -x "$VENV_PY" ]; then
  PYBOOT="$(pick_python)"
  if [ -z "$PYBOOT" ]; then
    echo "[error] Python 3.14 not found (need python3.14 or the 'py' launcher)."
    exit 1
  fi
  echo "[setup] Creating Python 3.14 virtual environment..."
  # shellcheck disable=SC2086
  $PYBOOT -m venv "$VENV_DIR"
fi

# --- 2. install deps once (first run / when requirements.txt changes) ------
need_install=0
if [ ! -f "$DEPS_MARKER" ]; then
  need_install=1
elif [ "$REQ" -nt "$DEPS_MARKER" ]; then
  need_install=1
fi

if [ "$need_install" -eq 1 ]; then
  echo "[setup] Installing dependencies (first run, please wait)..."
  "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "$VENV_PY" -m pip install -r "$REQ"
  echo "installed" > "$DEPS_MARKER"
else
  echo "[setup] Dependencies already installed (skipping)."
fi

# --- 3. open the default browser to the localhost URL ----------------------
# (LAN-IP/URL detection + the terminal QR live INSIDE the server: the startup
#  banner is the single source of IP truth - v1 convention.)
LOCAL_URL="http://127.0.0.1:$PORT/"
( command -v xdg-open >/dev/null 2>&1 && xdg-open "$LOCAL_URL" >/dev/null 2>&1 ) || \
( command -v open     >/dev/null 2>&1 && open     "$LOCAL_URL" >/dev/null 2>&1 ) || \
( command -v start    >/dev/null 2>&1 && start    "$LOCAL_URL" >/dev/null 2>&1 ) || true

# --- 4. dependency self-check (FAIL LOUD before serving) -------------------
# `cryptography` is load-bearing: app/core/tls.py imports it at module level
# and BOTH entrypoints import tls.py, so a broken install would block ALL
# boot - even with STUDIO2_TLS=0 - with a raw stack trace instead of this
# message. fastapi/uvicorn are the server itself; qrcode/PIL render the
# banner QR; claude_agent_sdk is the agent runtime (Step 3 - pinned and
# verified now). Verify up front and abort with the exact remedy instead of
# shipping a half-working server. (v1's start.sh lacked this check - a
# documented gap, closed here.)
if ! "$VENV_PY" -c "import fastapi, uvicorn, cryptography, qrcode, PIL, claude_agent_sdk" >/dev/null 2>&1; then
  echo "[error] Required dependencies are not importable in the venv python:"
  echo "          $VENV_PY"
  echo "        The server would fail to boot. Reinstall them with:"
  echo "          \"$VENV_PY\" -m pip install -r \"$REQ\""
  echo "        If that still fails, delete studio2/relay/.venv and re-run"
  echo "        start.sh."
  exit 1
fi

# --- 5. run the dual-listener server (no ANTHROPIC_API_KEY => MAX plan) ----
# app.serve runs HTTP on 0.0.0.0:$PORT AND HTTPS on 0.0.0.0:$TLS_PORT (v2
# leaf signed by the shared v1 CA). STUDIO2_TLS=0, a missing v1 CA, or any
# TLS failure falls back to HTTP-only and never blocks boot.
echo " [run] Starting relay on 0.0.0.0:$PORT (+ https on $TLS_PORT)  (Ctrl+C to stop)"
echo
cd "$RELAY_DIR"
exec "$VENV_PY" -m app.serve
