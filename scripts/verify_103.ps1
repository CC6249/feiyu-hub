$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dist = 'C:\Users\GigaByte\Desktop\ds\feiyu-hub-dist'
$dir  = 'C:\Users\GigaByte\AppData\Local\Temp\fh-verify'

# 1) stage clean copy + config that includes a credentialed custom service
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Copy-Item (Join-Path $dist 'server.mjs') $dir
Copy-Item (Join-Path $dist 'public') $dir -Recurse
$cfg = @'
{
  "site": { "name": "T", "shortName": "T", "subtitle": "", "footer": "", "orientation": "portrait" },
  "bind": "127.0.0.1",
  "port": 18799,
  "auth": { "user": "admin", "password": "", "realm": "T" },
  "tokens": {},
  "services": [
    { "id": "nas", "name": "NAS-5099", "desc": "x", "group": "G", "accent": "blue", "badge": "N", "type": "direct", "port": 5099, "path": "/" },
    { "id": "custom-8080", "name": "LoginApp", "desc": "port 8080", "group": "Custom", "accent": "teal", "badge": "8080", "type": "direct", "port": 8080, "custom": true, "user": "admin", "pass": "s3cret!" }
  ]
}
'@
[System.IO.File]::WriteAllText((Join-Path $dir 'config.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))

# 2) start server
$p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
Write-Output ('server pid=' + $p.Id + ' alive=' + (-not $p.HasExited))

# 3) assert needsAuth is now exposed on the credentialed card
$svc = Invoke-RestMethod -Uri 'http://127.0.0.1:18799/api/services' -TimeoutSec 10
$c = $svc.services | Where-Object { $_.id -eq 'custom-8080' }
Write-Output ('card needsAuth=' + $c.needsAuth + ' autocopy=' + $c.autocopy + ' secretLabel=' + $c.secretLabel + ' secret=' + $c.secret)

# 4) run the dist's own verify.mjs against the temp instance
$env:FEIYU_CONFIG = Join-Path $dir 'config.json'
node (Join-Path $dist 'scripts\verify.mjs') 2>&1 | Select-Object -Last 12
Remove-Item Env:FEIYU_CONFIG -ErrorAction SilentlyContinue

# 5) cleanup
if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Output 'done'
