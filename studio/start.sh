#!/usr/bin/env bash
# ===========================================================================
#  video-use Studio - native launcher (POSIX parity for start.bat)
#
#  Run path: NATIVE (Claude MAX plan). Deliberately does NOT export
#  ANTHROPIC_API_KEY, so the Claude Agent SDK uses your local Claude Code login
#  (MAX subscription) rather than pay-as-you-go billing. (Docker is the API-key
#  path - see README.md.)
#
#  Steps mirror start.bat: ensure venv (Python 3.14) -> install deps once ->
#  detect LAN IP -> print URLs/QR -> open browser -> uvicorn on 0.0.0.0:8420.
#  Robust to spaces in the path.
#
#  Auth: the server prints a startup banner with the login username + password
#  (from studio/config.toml [users]). Open the URL / scan the QR, then sign in
#  with those credentials. A signed httpOnly studio_session cookie is issued on
#  login; there is no token-in-URL.
# ===========================================================================
set -euo pipefail

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$STUDIO_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
REQ="$STUDIO_DIR/requirements.txt"
DEPS_MARKER="$VENV_DIR/.deps-installed"
PORT=8420

echo
echo " ============================================"
echo "  video-use Studio  -  native launch"
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
  echo "[setup] Installing dependencies (~90 MB+ on first run, please wait)..."
  "$VENV_PY" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "$VENV_PY" -m pip install -r "$REQ"
  echo "installed" > "$DEPS_MARKER"
else
  echo "[setup] Dependencies already installed (skipping)."
fi

# --- 3. detect LAN IPv4 ----------------------------------------------------
detect_lan_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}'
  elif command -v ipconfig >/dev/null 2>&1; then
    # Git Bash on Windows
    ipconfig 2>/dev/null | grep -i "IPv4" | grep -oE '([0-9]+\.){3}[0-9]+' | grep -vE '^127\.' | head -1
  else
    hostname -I 2>/dev/null | awk '{print $1}'
  fi
}
LANIP="$(detect_lan_ip || true)"
[ -z "$LANIP" ] && LANIP="127.0.0.1"

LOCAL_URL="http://127.0.0.1:$PORT/"
LAN_URL="http://$LANIP:$PORT/"

echo
echo " ------------------------------------------------------------"
echo "  Local : $LOCAL_URL"
echo "  LAN   : $LAN_URL"
echo "  Port  : $PORT   (bind 0.0.0.0 - reachable on your Wi-Fi)"
echo " ------------------------------------------------------------"
echo
echo "  Scan this QR on your phone (same Wi-Fi) to open Studio, then sign in"
echo "  with the username/password shown in the server startup banner below."
echo
"$VENV_PY" -c "import io,sys;sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8');import qrcode;qr=qrcode.QRCode(border=2);qr.add_data('$LAN_URL');qr.make(fit=True);qr.print_ascii(out=sys.stdout,invert=True)"
echo

# --- 4. open the default browser to the localhost URL ----------------------
( command -v xdg-open >/dev/null 2>&1 && xdg-open "$LOCAL_URL" >/dev/null 2>&1 ) || \
( command -v open     >/dev/null 2>&1 && open     "$LOCAL_URL" >/dev/null 2>&1 ) || \
( command -v start    >/dev/null 2>&1 && start    "$LOCAL_URL" >/dev/null 2>&1 ) || true

# --- 5. run uvicorn on 0.0.0.0:8420 (no ANTHROPIC_API_KEY => MAX plan) ------
echo " [run] Starting server on 0.0.0.0:$PORT  (Ctrl+C to stop)"
echo
cd "$STUDIO_DIR"
exec "$VENV_PY" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
