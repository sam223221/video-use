<#
.SYNOPSIS
    Open the Windows firewall for video-use Studio (inbound TCP 8420).

.DESCRIPTION
    Adds an inbound "allow" rule for TCP port 8420 so phones and other devices
    on the same Wi-Fi can reach Studio at http://<this-pc-lan-ip>:8420/.
    Idempotent: if the rule already exists it does nothing.

    This is a ONE-TIME step and MUST be run from an ELEVATED (Administrator)
    PowerShell terminal. Studio binds 0.0.0.0 for the LAN only - it is NOT
    exposed to the internet (no tunnel, no port forwarding). See README.md §9.

.EXAMPLE
    # From an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\open-firewall.ps1

.NOTES
    To remove the rule later:
        netsh advfirewall firewall delete rule name="video-use Studio 8420"
#>

$ErrorActionPreference = 'Stop'

$ruleName = 'video-use Studio 8420'
$port     = 8420

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

# Idempotency check - look for an existing rule with this exact name.
$exists = $false
$show = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($LASTEXITCODE -eq 0 -and $show -match 'Rule Name:') {
    $exists = $true
}

if ($exists) {
    Write-Host "[ok] Firewall rule '$ruleName' already exists. Nothing to do." -ForegroundColor Green
    exit 0
}

Write-Host "[setup] Adding inbound firewall rule '$ruleName' for TCP $port ..."
netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port | Out-Null

if ($LASTEXITCODE -eq 0) {
    Write-Host "[ok] Done. Devices on your Wi-Fi can now reach Studio on TCP $port." -ForegroundColor Green
} else {
    Write-Host "[error] Failed to add the rule (netsh exit $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}
