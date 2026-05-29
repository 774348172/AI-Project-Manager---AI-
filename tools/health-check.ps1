$ErrorActionPreference = 'Continue'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/health' -UseBasicParsing -TimeoutSec 5
  Write-Host ("STATUS: " + $r.StatusCode)
  Write-Host ("BODY: " + $r.Content)
  if ($r.StatusCode -eq 200) { exit 0 } else { exit 2 }
} catch {
  Write-Host ("REQUEST FAILED: " + $_.Exception.Message)
  exit 1
}
