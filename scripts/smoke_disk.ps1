$ErrorActionPreference = 'SilentlyContinue'
$dist = 'C:\Users\GigaByte\Desktop\ds\feiyu-hub-dist'
$dir = 'C:\Users\GigaByte\AppData\Local\Temp\fh-test2'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Copy-Item (Join-Path $dist 'server.mjs') $dir -Force
Copy-Item (Join-Path $dist 'public') $dir -Recurse -Force
$cfg = @'
{
  "site": { "name": "T", "shortName": "T", "subtitle": "", "footer": "", "orientation": "portrait" },
  "bind": "127.0.0.1",
  "port": 18798,
  "auth": { "user": "admin", "password": "", "realm": "T" },
  "tokens": {},
  "services": [ { "id": "nas", "name": "NAS", "desc": "x", "group": "G", "accent": "blue", "badge": "N", "type": "direct", "port": 5099, "path": "/" } ]
}
'@
[System.IO.File]::WriteAllText((Join-Path $dir 'config.json'), $cfg, (New-Object System.Text.UTF8Encoding($false)))

$p = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3
$B = 'http://127.0.0.1:18798'

$b1 = @{ port = 23456; name = 'T-Login'; user = 'admin'; pass = 'p@ss w&x' } | ConvertTo-Json
$r1 = Invoke-RestMethod -Uri ($B + '/api/services/add') -Method Post -ContentType 'application/json' -Body $b1 -TimeoutSec 8
Write-Output ('1. add ok=' + $r1.ok)

Write-Output '--- disk after add (node reads, no PS encoding issue) ---'
& node -e "const j=JSON.parse(require('fs').readFileSync('C:/Users/GigaByte/AppData/Local/Temp/fh-test2/config.json','utf8'));const c=j.services.find(s=>String(s.id).startsWith('custom-23456'));console.log(c?JSON.stringify({id:c.id,custom:c.custom,user:c.user,pass:c.pass}):'NOT FOUND')"

$b2 = @{ port = 23456; name = 'Renamed' } | ConvertTo-Json
$null = Invoke-RestMethod -Uri ($B + '/api/services/add') -Method Post -ContentType 'application/json' -Body $b2 -TimeoutSec 8
Write-Output '--- disk after rename ---'
& node -e "const j=JSON.parse(require('fs').readFileSync('C:/Users/GigaByte/AppData/Local/Temp/fh-test2/config.json','utf8'));const c=j.services.find(s=>String(s.id).startsWith('custom-23456'));console.log(c?JSON.stringify({name:c.name,user:c.user,pass:c.pass}):'NOT FOUND')"

$b3 = @{ port = 23456 } | ConvertTo-Json
$null = Invoke-RestMethod -Uri ($B + '/api/services/remove') -Method Post -ContentType 'application/json' -Body $b3 -TimeoutSec 8
Write-Output '--- disk after remove ---'
& node -e "const j=JSON.parse(require('fs').readFileSync('C:/Users/GigaByte/AppData/Local/Temp/fh-test2/config.json','utf8'));const c=j.services.find(s=>String(s.id).startsWith('custom-23456'));console.log(c?'STILL THERE':'clean')"

try { $p.Kill() } catch { }
Write-Output ('server killed, alive=' + (-not $p.HasExited))
