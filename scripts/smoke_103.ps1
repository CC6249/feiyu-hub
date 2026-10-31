$ErrorActionPreference = 'SilentlyContinue'
$dist = 'C:\Users\GigaByte\Desktop\ds\feiyu-hub-dist'
$dir = 'C:\Users\GigaByte\AppData\Local\Temp\fh-test'

# 1) stage a clean copy with its own config
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
    { "id": "nas", "name": "NAS-5099", "desc": "x", "group": "G", "accent": "blue", "badge": "N", "type": "direct", "port": 5099, "path": "/" }
  ]
}
'@
[System.IO.File]::WriteAllText((Join-Path $dir 'config.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))

# 2) start server
$p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
Write-Output ('server pid=' + $p.Id + ' alive=' + (-not $p.HasExited))
$B = 'http://127.0.0.1:18799'

Write-Output '=== ping ==='
try { $r = Invoke-RestMethod -Uri ($B + '/api/ping') -TimeoutSec 6; Write-Output ('  ok=' + $r.ok + ' version=' + $r.version) } catch { Write-Output ('  FAIL ' + $_.Exception.Message) }

Write-Output '=== add custom with credentials ==='
$b1 = @{ port = 23456; name = 'T-Login'; user = 'admin'; pass = 'p@ss w&x' } | ConvertTo-Json
$r1 = Invoke-RestMethod -Uri ($B + '/api/services/add') -Method Post -ContentType 'application/json' -Body $b1 -TimeoutSec 8
Write-Output ('  ok=' + $r1.ok)

Write-Output '=== config.json on disk ==='
$raw = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
$c = $raw.services | Where-Object { $_.id -like 'custom-23456*' }
Write-Output ('  id=' + $c.id + ' custom=' + $c.custom + ' user=' + $c.user + ' pass=' + $c.pass)
Write-Output ('  desc=' + $c.desc)

Write-Output '=== card json ==='
$svc = Invoke-RestMethod -Uri ($B + '/api/services') -TimeoutSec 10
$x = $svc.services | Where-Object { $_.id -like 'custom-23456*' }
Write-Output ('  autocopy=' + $x.autocopy + ' needsAuth=' + $x.needsAuth + ' secretLen=' + $x.secret.Length + ' label=' + $x.secretLabel)

Write-Output '=== rename keeps credentials ==='
$b2 = @{ port = 23456; name = 'Renamed' } | ConvertTo-Json
$null = Invoke-RestMethod -Uri ($B + '/api/services/add') -Method Post -ContentType 'application/json' -Body $b2 -TimeoutSec 8
$raw2 = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
$c2 = $raw2.services | Where-Object { $_.id -like 'custom-23456*' }
Write-Output ('  name=' + $c2.name + ' user=' + $c2.user + ' pass=' + $c2.pass)

Write-Output '=== builtin entry untouched by credentials logic ==='
$nas = $svc.services | Where-Object { $_.id -eq 'nas' }
Write-Output ('  nas autocopy=' + $nas.autocopy + ' needsAuth=' + $nas.needsAuth + ' secret=' + $nas.secret)

Write-Output '=== remove ==='
$b3 = @{ port = 23456 } | ConvertTo-Json
$r3 = Invoke-RestMethod -Uri ($B + '/api/services/remove') -Method Post -ContentType 'application/json' -Body $b3 -TimeoutSec 8
$raw3 = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json
$left = @($raw3.services | Where-Object { $_.id -like 'custom-23456*' }).Count
Write-Output ('  ok=' + $r3.ok + ' leftover=' + $left)

Write-Output '=== scan auth field present ==='
$sc = Invoke-RestMethod -Uri ($B + '/api/scan') -Method Post -TimeoutSec 90
Write-Output ('  ports=' + $sc.ports + ' found=' + $sc.found)
$authCount = @($sc.items | Where-Object { $_.auth }).Count
Write-Output ('  items with auth=true = ' + $authCount)
$sc.items | Select-Object -First 12 | ForEach-Object { Write-Output ('    ' + $_.port + ' ' + $_.title + ' state=' + $_.state + ' auth=' + $_.auth) }

Write-Output '=== verify.mjs ==='
$env:FEIYU_CONFIG = Join-Path $dir 'config.json'
& node (Join-Path $dist 'scripts\verify.mjs') --url $B 2>&1 | Select-Object -Last 6

try { $p.Kill() } catch { }
Write-Output ('killed test server, alive=' + (-not $p.HasExited))
