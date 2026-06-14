<#
.SYNOPSIS
    Open the Windows firewall for video-use Studio (inbound TCP 8420 + 8443).

.DESCRIPTION
    Adds inbound "allow" rules for TCP ports 8420 (HTTP) and 8443 (HTTPS —
    Secure Studio) so phones and other devices on the same Wi-Fi can reach
    Studio at http://<this-pc-lan-ip>:8420/ and, after the one-time Secure
    Setup (/setup), at https://<this-pc-lan-ip>:8443/.
    Idempotent: rules that already exist are left untouched, so re-running
    after an upgrade only adds whatever is missing.

    This is a ONE-TIME step and MUST be run from an ELEVATED (Administrator)
    PowerShell terminal. Studio binds 0.0.0.0 for the LAN only - it is NOT
    exposed to the internet (no tunnel, no port forwarding). See README.md §9.

.EXAMPLE
    # From an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\open-firewall.ps1

.NOTES
    To remove the rules later:
        netsh advfirewall firewall delete rule name="video-use Studio 8420"
        netsh advfirewall firewall delete rule name="video-use Studio 8443"
#>

$ErrorActionPreference = 'Stop'

# HTTP + HTTPS (Secure Studio, 2026-06-11). Rule names are load-bearing for
# idempotency and for the removal commands documented above.
$rules = @(
    @{ Name = 'video-use Studio 8420'; Port = 8420 },
    @{ Name = 'video-use Studio 8443'; Port = 8443 }
)

# Require elevation - adding firewall rules needs admin rights.
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[error] This script must be run as Administrator." -ForegroundColor Red
    Write-Host "        Right-click PowerShell -> 'Run as administrator', then re-run:"
    Write-Host "        powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit 1
}

$failed = 0
foreach ($rule in $rules) {
    $ruleName = $rule.Name
    $port     = $rule.Port

    # Idempotency check - look for an existing rule with this exact name.
    $exists = $false
    $show = netsh advfirewall firewall show rule name="$ruleName" 2>$null
    if ($LASTEXITCODE -eq 0 -and $show -match 'Rule Name:') {
        $exists = $true
    }

    if ($exists) {
        Write-Host "[ok] Firewall rule '$ruleName' already exists. Nothing to do." -ForegroundColor Green
        continue
    }

    Write-Host "[setup] Adding inbound firewall rule '$ruleName' for TCP $port ..."
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port | Out-Null

    if ($LASTEXITCODE -eq 0) {
        Write-Host "[ok] Rule '$ruleName' added (TCP $port)." -ForegroundColor Green
    } else {
        Write-Host "[error] Failed to add rule '$ruleName' (netsh exit $LASTEXITCODE)." -ForegroundColor Red
        $failed++
    }
}

if ($failed -gt 0) {
    exit 1
}
Write-Host "[ok] Done. Devices on your Wi-Fi can now reach Studio on TCP 8420 (http) and 8443 (https)." -ForegroundColor Green
