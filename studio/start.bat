@echo off
REM ===========================================================================
REM  video-use Studio - native launcher (Windows)
REM
REM  Run path: NATIVE (Claude MAX plan). This launcher deliberately does NOT set
REM  ANTHROPIC_API_KEY, so the Claude Agent SDK authenticates via your local
REM  Claude Code login (your MAX subscription) instead of pay-as-you-go billing.
REM  (The Docker run path is the one that uses an API key - see README.md.)
REM
REM  What it does:
REM    1. Creates studio\.venv with Python 3.14 (py -3.14) if missing.
REM    2. pip install -r requirements.txt only on first run / when deps change
REM       (the download is ~90 MB+; subsequent launches skip it).
REM    3. Detects the PC LAN IPv4, prints localhost + LAN URLs, and a scannable
REM       QR of the LAN URL in the terminal.
REM    4. Opens the default browser to the localhost URL.
REM    5. Binds uvicorn to 0.0.0.0:8420.
REM
REM  Auth: the server prints a startup banner with the login username + password
REM  (from studio\config.toml [users]). Open the URL / scan the QR, then sign in
REM  with those credentials. A signed httpOnly studio_session cookie is issued on
REM  login; there is no token-in-URL.
REM
REM  Re-runnable and robust to spaces in the install path.
REM ===========================================================================

setlocal EnableExtensions EnableDelayedExpansion

REM --- name the window so the log console is self-identifying ----------------
title video-use Studio

REM --- anchor the working dir to this script's folder so a double-click from
REM     Explorer (cwd = C:\Windows\System32) still resolves .venv / app / reqs.
REM     %~dp0 is the script dir and always ends with a backslash.
cd /d "%~dp0"

REM --- switch the console to UTF-8 so the QR block characters render ---------
REM (the default cp1252 codepage cannot encode the QR's Unicode blocks).
chcp 65001 >nul 2>&1
set "PYTHONIOENCODING=utf-8"

REM --- locate this script's folder (studio\) ; %~dp0 ends with a backslash ---
set "STUDIO_DIR=%~dp0"
if "%STUDIO_DIR:~-1%"=="\" set "STUDIO_DIR=%STUDIO_DIR:~0,-1%"

set "VENV_DIR=%STUDIO_DIR%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "REQ=%STUDIO_DIR%\requirements.txt"
set "DEPS_MARKER=%VENV_DIR%\.deps-installed"
set "PORT=8420"

echo(
echo  ============================================
echo   video-use Studio  -  native launch
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
REM     A wrong-base / corrupt venv (e.g. a 3.11 venv left behind from an older
REM     run) is the exact failure that made helpers crash with
REM     ModuleNotFoundError: the server ran one python while the deps lived in a
REM     different one. We do NOT fall back to system python -- abort here so the
REM     venv gets rebuilt cleanly (delete studio\.venv and re-run start.bat).
if not exist "%VENV_PY%" (
    echo [error] venv python missing at "%VENV_PY%".
    echo         Delete studio\.venv and re-run start.bat to rebuild it.
    goto :fail
)
"%VENV_PY%" -c "import sys" >nul 2>&1
if errorlevel 1 (
    echo [error] venv python at "%VENV_PY%" is not runnable ^(corrupt venv^).
    echo         Delete studio\.venv and re-run start.bat to rebuild it.
    goto :fail
)

REM --- 2. install deps once (first run / when requirements.txt changes) ------
set "NEED_INSTALL=0"
if not exist "%DEPS_MARKER%" set "NEED_INSTALL=1"

REM Reinstall when requirements.txt is newer than the marker. `dir /o-d` lists
REM newest-first, so the first name emitted is the more recently modified file.
REM This MUST stay out of a parenthesised ( ... ) block: a :label inside parens
REM is a cmd parse error (") was unexpected at this time"), which is exactly
REM what aborted the launcher on double-click before it could reach :end/pause.
if exist "%DEPS_MARKER%" if exist "%REQ%" (
    set "NEWEST="
    for /f "delims=" %%A in ('dir /b /o-d "%REQ%" "%DEPS_MARKER%" 2^>nul') do if not defined NEWEST set "NEWEST=%%A"
    if /i "!NEWEST!"=="requirements.txt" set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
    echo [setup] Installing dependencies ^(first run, ~90MB, one-time^)...
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

REM --- 3. detect LAN IPv4 (prefer a private 192/10/172 address) --------------
set "LANIP="
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "$a=Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and ($_.PrefixOrigin -eq 'Dhcp' -or $_.PrefixOrigin -eq 'Manual') } | Sort-Object { if ($_.IPAddress -like '192.168.*') {0} elseif ($_.IPAddress -like '10.*') {1} elseif ($_.IPAddress -like '172.*') {2} else {3} } | Select-Object -First 1 -ExpandProperty IPAddress; if ($a) { $a }"`) do set "LANIP=%%I"
if not defined LANIP set "LANIP=127.0.0.1"

set "LOCAL_URL=http://127.0.0.1:%PORT%/"
set "LAN_URL=http://%LANIP%:%PORT%/"

echo(
echo  ------------------------------------------------------------
echo   Local : %LOCAL_URL%
echo   LAN   : %LAN_URL%
echo   Port  : %PORT%   ^(bind 0.0.0.0 - reachable on your Wi-Fi^)
echo  ------------------------------------------------------------
echo(
echo   Scan this QR on your phone ^(same Wi-Fi^) to open Studio, then sign in
echo   with the username/password shown in the server startup banner below.
echo(

REM --- print a terminal QR of the LAN URL using the installed qrcode lib -----
REM stdout is forced to UTF-8 in-process so the block glyphs encode regardless
REM of the active console codepage.
"%VENV_PY%" -c "import io,sys;sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8');import qrcode;qr=qrcode.QRCode(border=2);qr.add_data('%LAN_URL%');qr.make(fit=True);qr.print_ascii(out=sys.stdout,invert=True)"
echo(
echo   First time on the LAN? Open the firewall port once ^(admin terminal^):
echo     powershell -ExecutionPolicy Bypass -File "%STUDIO_DIR%\open-firewall.ps1"
echo(

REM --- 4. open the default browser to the localhost URL ----------------------
start "" "%LOCAL_URL%"

REM --- 4b. helper-dependency self-check (FAIL LOUD before serving) -----------
REM     runner.py launches helpers/*.py with THIS interpreter (sys.executable),
REM     so the helper deps must be importable HERE. If they are not, the server
REM     would boot fine and then crash EVERY helper with ModuleNotFoundError
REM     (the recurring numpy/requests bug). Verify up front and abort with the
REM     exact remedy instead of shipping a half-working server.
"%VENV_PY%" -c "import requests, numpy, matplotlib, PIL, librosa" >nul 2>&1
if errorlevel 1 (
    echo [error] Helper dependencies are not importable in the venv python:
    echo           "%VENV_PY%"
    echo         The helpers ^(transcribe / timeline_view / render / grade^) would
    echo         crash with ModuleNotFoundError. Reinstall them with:
    echo           "%VENV_PY%" -m pip install -r "%REQ%"
    echo         If that still fails, delete studio\.venv and re-run start.bat.
    goto :fail
)

REM --- 5. run uvicorn on 0.0.0.0:8420 (no ANTHROPIC_API_KEY set => MAX plan) -
REM     Runs in the FOREGROUND of this console: the startup banner (with the
REM     login username + password to sign in with) stays visible and uvicorn's
REM     request logs / tracebacks / subprocess output stream live into this
REM     window. This call blocks until the server exits.
echo  [run] Starting server on 0.0.0.0:%PORT%  ^(Ctrl+C to stop^)
echo(
"%VENV_PY%" -m uvicorn app.main:app --host 0.0.0.0 --port %PORT%

echo(
echo  ------------------------------------------------------------
echo   Server stopped ^(exit code %ERRORLEVEL%^).
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
