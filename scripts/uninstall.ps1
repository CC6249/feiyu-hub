# Feiyu Hub - Windows uninstaller
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1            # stop + remove autostart, keep files
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge     # also delete the install folder
#
# ASCII only on purpose (see install.ps1 header).

[CmdletBinding()]
param(
  [string]$Prefix = "",
  [switch]$Purge
)

$ErrorActionPreference = 'Continue'

function Say([string]$msg) { Write-Host $msg }

if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'FeiyuHub' }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($ScriptDir) {
  $maybe = Split-Path -Parent $ScriptDir
  if ((Test-Path (Join-Path $maybe 'server.mjs')) -and (-not (Test-Path (Join-Path $Prefix 'server.mjs')))) {
    $Prefix = $maybe
  }
}

Say "target: $Prefix"

$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$Prefix*server.mjs*" }
if ($procs) {
  Say "stopping running instance(s)"
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} else {
  Say "no running instance found"
}

$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$val = Get-ItemProperty -Path $RunKey -Name 'FeiyuHub' -ErrorAction SilentlyContinue
if ($val) {
  Remove-ItemProperty -Path $RunKey -Name 'FeiyuHub' -Force -ErrorAction SilentlyContinue
  Say "autostart entry removed"
}

$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Feiyu Hub.lnk'
if (Test-Path $lnkPath) {
  Remove-Item -Path $lnkPath -Force -ErrorAction SilentlyContinue
  Say "desktop shortcut removed"
}

if ($Purge) {
  if (Test-Path $Prefix) {
    Remove-Item -Path $Prefix -Recurse -Force -ErrorAction SilentlyContinue
    Say "install folder deleted: $Prefix"
  }
} else {
  Say "files kept at: $Prefix"
  Say "to delete everything: uninstall.ps1 -Purge"
}

Say "done"
