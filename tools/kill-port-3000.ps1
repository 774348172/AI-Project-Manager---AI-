$ErrorActionPreference = 'Continue'
$ids = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
if ($ids) {
  $ids | Sort-Object -Unique | ForEach-Object {
    Write-Host ("Killing PID=" + $_)
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  Write-Host "DONE"
} else {
  Write-Host "No process on port 3000"
}
