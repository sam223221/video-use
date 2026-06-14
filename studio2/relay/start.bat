@echo off
REM ===========================================================================
REM  Studio v2 relay - native launcher (Windows)
REM
REM  Run path: NATIVE (Claude MAX plan). This launcher deliberately does NOT
REM  set ANTHROPIC_API_KEY, so the Claude Agent SDK authenticates via your
REM  local Claude Code login (your MAX subscription) instead of pay-as-you-go
REM  billing - exactly like Studio v1.
REM
REM  What it does:
REM    1. Creates studio2\relay\.venv with Python 3.14 (py -3.14) if missing.
REM    2. pip install -r requirements.txt only on first run / when deps change.
REM    3. Opens the default browser to the localhost URL.
REM    4. Runs `python -m app.serve` - HTTP on 0.0.0.0:8520 AND HTTPS on
REM       0.0.0.0:8543. The https certificate is v2's own, signed by Studio
REM       v1's certificate authority (read-only - run Studio v1 once first,
REM       or set STUDIO2_CA_DIR). The server's startup banner prints the
REM       URLs + a scannable QR (the /setup page) + the login credentials -
REM       it is the SINGLE source of IP/URL truth (v1 convention).
REM
REM  Auth: sign in with an account from studio2\relay\config.toml [users]
REM  (or the auto-generated one in the banner). A signed httpOnly
REM  studio2_session cookie is issued on login; there is no token-in-URL.
REM
REM  Re-runnable and robust to spaces in the install path.
REM ===========================================================================

setlocal EnableExtensions EnableDelayedExpansion

REM --- name the window so the log console is self-identifying ----------------
title Studio v2 relay

REM --- anchor the working dir to this script's folder so a double-click from
REM     Explorer (cwd = C:\Windows\System32) still resolves .venv / app / reqs.
cd /d "%~dp0"

REM --- switch the console to UTF-8 so the QR block characters render ---------
chcp 65001 >nul 2>&1
set "PYTHONIOENCODING=utf-8"

REM --- locate this script's folder (studio2\relay\) ---------------------------
set "RELAY_DIR=%~dp0"
if "%RELAY_DIR:~-1%"=="\" set "RELAY_DIR=%RELAY_DIR:~0,-1%"

set "VENV_DIR=%RELAY_DIR%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "REQ=%RELAY_DIR%\requirements.txt"
set "DEPS_MARKER=%VENV_DIR%\.deps-installed"
set "PORT=8520"
set "TLS_PORT=8543"

echo(
echo  ============================================
echo   Studio v2 relay  -  native launch
echo  ============================================
echo(

REM --- 1. ensure venv (Python 3.14) -----------------------------------------
if not exist "%VENV_PY%" (
    echo [setup] Creating Python 3.14 virtual environment...
    py -3.14 -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [error] Could not create the venv. Is Python 3.14 installed?
        echo         Try:  py -3.14 --version
        goto :fail
    )
)

REM --- 1b. FAIL LOUD if the venv python is missing or not runnable -----------
REM     A wrong-base / corrupt venv is the v1-documented failure mode where the
REM     server runs one python while the deps live in another. We do NOT fall
REM     back to system python -- abort here so the venv gets rebuilt cleanly
REM     (delete studio2\relay\.venv and re-run start.bat).
if not exist "%VENV_PY%" (
    echo [error] venv python missing at "%VENV_PY%".
    echo         Delete studio2\relay\.venv and re-run start.bat to rebuild it.
    goto :fail
)
"%VENV_PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [error] venv python at "%VENV_PY%" is not runnable ^(corrupt venv^).
    echo         Delete studio2\relay\.venv and re-run start.bat to rebuild it.
    goto :fail
)

REM --- 2. install deps once (first run / when requirements.txt changes) ------
set "NEED_INSTALL=0"
if not exist "%DEPS_MARKER%" set "NEED_INSTALL=1"

REM Reinstall when requirements.txt is newer than the marker. `dir /o-d` lists
REM newest-first, so the first name emitted is the more recently modified file.
REM This MUST stay out of a parenthesised ( ... ) block: a :label inside parens
REM is a cmd parse error (v1-documented launcher trap).
if exist "%DEPS_MARKER%" if exist "%REQ%" (
    set "NEWEST="
    for /f "delims=" %%A in ('dir /b /o-d "%REQ%" "%DEPS_MARKER%" 2^>nul') do if not defined NEWEST set "NEWEST=%%A"
    if /i "!NEWEST!"=="requirements.txt" set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
    echo [setup] Installing dependencies ^(first run, one-time^)...
    "%VENV_PY%" -m pip install --upgrade pip >nul 2>&1
    "%VENV_PY%" -m pip install -r "%REQ%"
    if errorlevel 1 (
        echo [error] pip install failed. See the output above.
        goto :fail
    )
    > "%DEPS_MARKER%" echo installed
) else (
    echo [setup] Dependencies already installed ^(skipping^).
)

REM --- 3. open the default browser to the localhost URL -----------------------
REM     (LAN IP/URL detection + the terminal QR live INSIDE the server: the
REM      startup banner is the single source of IP truth - v1 convention.)
set "LOCAL_URL=http://127.0.0.1:%PORT%/"
echo(
echo   First time on the LAN? Open the firewall ports once ^(admin terminal^):
echo     powershell -ExecutionPolicy Bypass -File "%RELAY_DIR%\open-firewall.ps1"
echo(
start "" "%LOCAL_URL%"

REM --- 4. dependency self-check (FAIL LOUD before serving) --------------------
REM     `cryptography` is load-bearing: app/core/tls.py imports it at module
REM     level and BOTH entrypoints import tls.py, so a broken install would
REM     block ALL boot - even with STUDIO2_TLS=0 - with a raw stack trace
REM     instead of this message. fastapi/uvicorn are the server itself;
REM     qrcode/PIL render the banner QR; claude_agent_sdk is the agent
REM     runtime (Step 3 - pinned and verified now so its arrival cannot be
REM     blocked by a half-installed venv). Verify up front and abort with the
REM     exact remedy instead of shipping a half-working server.
"%VENV_PY%" -c "import fastapi, uvicorn, cryptography, qrcode, PIL, claude_agent_sdk" >nul 2>&1
if errorlevel 1 (
    echo [error] Required dependencies are not importable in the venv python:
    echo           "%VENV_PY%"
    echo         The server would fail to boot. Reinstall them with:
    echo           "%VENV_PY%" -m pip install -r "%REQ%"
    echo         If that still fails, delete studio2\relay\.venv and re-run
    echo         start.bat.
    goto :fail
)

REM --- 5. run the dual-listener server (no ANTHROPIC_API_KEY set => MAX plan) -
REM     app.serve runs HTTP on 0.0.0.0:%PORT% AND HTTPS on 0.0.0.0:%TLS_PORT%
REM     (v2 leaf signed by the shared v1 CA). STUDIO2_TLS=0, a missing v1 CA,
REM     or any TLS failure falls back to HTTP-only and never blocks boot.
REM     Runs in the FOREGROUND of this console: the startup banner (URLs + QR
REM     + the login credentials) stays visible and request logs / tracebacks
REM     stream live into this window. Ctrl+C stops BOTH listeners.
echo  [run] Starting relay on 0.0.0.0:%PORT% ^(+ https on %TLS_PORT%^)  ^(Ctrl+C to stop^)
echo(
"%VENV_PY%" -m app.serve

echo(
echo  ------------------------------------------------------------
echo   Relay stopped ^(exit code %ERRORLEVEL%^).
echo  ------------------------------------------------------------
goto :end

:fail
echo(
echo  Launch aborted - see the error above.

REM --- keep this window open on EVERY path (normal stop, crash, early exit) so
REM     a double-click user can always read the final output before it closes --
:end
echo(
pause
endlocal
exit /b
