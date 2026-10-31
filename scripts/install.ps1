# Feiyu Hub - Windows installer
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Port 18800
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Prefix "D:\apps\feiyu-hub"
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AutoStart      # register autostart
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NoStart        # install only
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Force          # overwrite config.json
#
# Requires Node.js 18+. Everything else is zero-dependency.
# This file is intentionally ASCII-only: Windows PowerShell 5.1 reads
# BOM-less files as ANSI and would garble non-ASCII text.

[CmdletBinding()]
param(
  [string]$Prefix = "",
  [int]$Port = 0,
  [switch]$Force,
  [switch]$AutoStart,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Version = '1.0.1'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcDir = Split-Path -Parent $ScriptDir

function Say([string]$msg) { Write-Host $msg }
function Step([string]$msg) { Write-Host ""; Write-Host "== $msg ==" }
function Fail([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $SrcDir 'server.mjs'))) {
  Fail "server.mjs not found in $SrcDir. Run this script from the extracted release folder."
}

# ---------------------------------------------------------------- 1. Node
Step "1/6 Looking for Node.js"

function Find-Node {
  $cands = New-Object System.Collections.ArrayList
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { [void]$cands.Add($cmd.Source) }
  [void]$cands.Add("$env:ProgramFiles\nodejs\node.exe")
  [void]$cands.Add("${env:ProgramFiles(x86)}\nodejs\node.exe")
  [void]$cands.Add("$env:LOCALAPPDATA\nodejs\node.exe")
  [void]$cands.Add("$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  [void]$cands.Add("$env:APPDATA\npm\node.exe")
  foreach ($c in $cands) {
    if (-not $c) { continue }
    if (-not (Test-Path $c)) { continue }
    try {
      $v = & $c -v 2>$null
      if ($v -match '^v(\d+)\.') {
        if ([int]$Matches[1] -ge 18) { return $c }
      }
    } catch { }
  }
  return $null
}

$Node = Find-Node
if (-not $Node) {
  Say "Node.js 18+ was not found."
  Say "Install it from https://nodejs.org/ (LTS build), reopen this terminal, then run this script again."
  Say "Or with winget:  winget install OpenJS.NodeJS.LTS"
  Fail "Node.js is required."
}
$NodeVersion = (& $Node -v).Trim()
Say "node: $Node ($NodeVersion)"

# -------------------------------------------------------------- 2. prefix
Step "2/6 Install location"

if (-not $Prefix) { $Prefix = Join-Path $env:LOCALAPPDATA 'FeiyuHub' }
Say "target: $Prefix"
New-Item -ItemType Directory -Path $Prefix -Force | Out-Null

# ---------------------------------------------------------------- 3. copy
Step "3/6 Copying files"

$items = @('server.mjs', 'public', 'scripts', 'config.example.json', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'VERSION', 'LICENSE', 'skills')
foreach ($i in $items) {
  $p = Join-Path $SrcDir $i
  if (Test-Path $p) {
    Copy-Item -Path $p -Destination $Prefix -Recurse -Force
    Say "  + $i"
  }
}

if (Test-Path (Join-Path $Prefix 'HubServer.exe')) {
  Say "  ! this folder also holds an older exe-based install (HubServer.exe)"
  Say "    the two coexist fine, but they use different config.json formats"
}

# --------------------------------------------------------------- 4. config
Step "4/6 Preparing config.json"

$CfgPath = Join-Path $Prefix 'config.json'
$ExamplePath = Join-Path $Prefix 'config.example.json'

if (-not (Test-Path $ExamplePath)) { Fail "config.example.json missing from release folder" }

# 判断某个 config.json 是不是本产品的：带 services 数组才算。
# 老版本（exe 版控制中心）的 config.json 里是 serverIp / sshUser 之类的字段，格式不兼容。
function Test-HubConfig {
  param([string]$Path)
  try {
    $obj = [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
    return ($obj.PSObject.Properties.Name -contains 'services')
  } catch {
    return $false
  }
}

if (Test-Path $CfgPath) {
  if (Test-HubConfig -Path $CfgPath) {
    if ($Force) {
      Copy-Item -Path $ExamplePath -Destination $CfgPath -Force
      Say "config.json overwritten (-Force)"
    } else {
      Say "config.json already exists, keeping it (use -Force to overwrite)"
    }
  } else {
    $bak = $CfgPath + '.legacy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -Path $CfgPath -Destination $bak -Force
    Copy-Item -Path $ExamplePath -Destination $CfgPath -Force
    Say "existing config.json is not a Feiyu Hub config; backed up as $(Split-Path -Leaf $bak)"
    Say "  (an older exe-based install would have used that format)"
  }
} else {
  Copy-Item -Path $ExamplePath -Destination $CfgPath -Force
  Say "config.json created from the example"
}

function Get-PanelPort {
  param([string]$Path)
  try {
    $raw = [System.IO.File]::ReadAllText($Path)
    $obj = $raw | ConvertFrom-Json
    if ($obj.port) { return [int]$obj.port }
  } catch { }
  return 18765
}

if ($Port -gt 0) {
  # 不能直接 node -e：PowerShell 5.1 会把内联脚本里的双引号吃掉。
  # 落一个临时 js 文件再执行，顺便避免 BOM 和数组被压成对象的问题。
  $jsPath = Join-Path $env:TEMP ('fh-setport-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.js')
  $lines = @(
    "const fs = require('fs');",
    "const p = process.argv[2], port = Number(process.argv[3]);",
    "const c = JSON.parse(fs.readFileSync(p, 'utf8'));",
    "c.port = port;",
    "fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');"
  )
  [System.IO.File]::WriteAllText($jsPath, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  & $Node $jsPath $CfgPath $Port
  $rcSetPort = $LASTEXITCODE
  Remove-Item -Path $jsPath -Force -ErrorAction SilentlyContinue
  if ($rcSetPort -ne 0) { Fail "failed to set port in config.json" }
  Say "panel port set to $Port"
}

$PanelPort = Get-PanelPort -Path $CfgPath
Say "panel port: $PanelPort"

# ------------------------------------------------------------- 5. launcher
Step "5/6 Creating launcher"

$CmdPath = Join-Path $Prefix 'start-hub.cmd'
$cmdBody = "@echo off`r`ncd /d `"%~dp0`"`r`n`"$Node`" `"%~dp0server.mjs`"`r`npause`r`n"
[System.IO.File]::WriteAllText($CmdPath, $cmdBody, (New-Object System.Text.ASCIIEncoding))
Say "  + start-hub.cmd"

$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Feiyu Hub.lnk'
try {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $sc.TargetPath = $CmdPath
  $sc.WorkingDirectory = $Prefix
  $sc.WindowStyle = 7
  $sc.Description = 'Feiyu Hub dashboard'
  $sc.Save()
  Say "  + Desktop shortcut: $lnkPath"
} catch {
  Say "  ! could not create desktop shortcut: $($_.Exception.Message)"
}

$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($AutoStart) {
  New-Item -Path $RunKey -Force | Out-Null
  Set-ItemProperty -Path $RunKey -Name 'FeiyuHub' -Value ('"' + $CmdPath + '"')
  Say "  + autostart registered (HKCU Run)"
} else {
  Say "  - autostart not enabled (add -AutoStart if you want it)"
}

# --------------------------------------------------------------- 6. start
Step "6/6 Starting and self-checking"

if ($NoStart) {
  Say "skipped (-NoStart). Run: $CmdPath"
  exit 0
}

$existing = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$Prefix*server.mjs*" }
if ($existing) {
  Say "an instance is already running (pid $($existing.ProcessId -join ',')), restarting it"
  $existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
}

Start-Process -FilePath $Node -ArgumentList ('"' + (Join-Path $Prefix 'server.mjs') + '"') -WorkingDirectory $Prefix -WindowStyle Hidden | Out-Null
Start-Sleep -Seconds 3

& $Node (Join-Path $Prefix 'scripts\verify.mjs') --url "http://127.0.0.1:$PanelPort"
$rc = $LASTEXITCODE

Say ""
Say "------------------------------------------------------------"
Say "  Dashboard : http://127.0.0.1:$PanelPort"
Say "  Config    : $CfgPath"
Say "  Launcher  : $CmdPath"
Say "  Logs      : run start-hub.cmd in a terminal to see output"
Say "------------------------------------------------------------"

if ($rc -ne 0) { Exit $rc }
