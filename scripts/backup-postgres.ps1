param(
  [string]$OutputDir = "backups",
  [string]$DatabaseUrl = $env:DATABASE_URL
)

if (-not $DatabaseUrl) {
  Write-Error "DATABASE_URL is required."
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputFile = Join-Path $OutputDir "onshell-cloud-$timestamp.dump"

$uri = [System.Uri]$DatabaseUrl
$userInfo = $uri.UserInfo.Split(":")
$env:PGPASSWORD = [System.Uri]::UnescapeDataString($userInfo[1])
$database = $uri.AbsolutePath.TrimStart("/")
$hostName = $uri.Host
$port = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
$user = [System.Uri]::UnescapeDataString($userInfo[0])

pg_dump -h $hostName -p $port -U $user -d $database -Fc -f $outputFile

if ($LASTEXITCODE -ne 0) {
  Write-Error "Backup failed."
  exit $LASTEXITCODE
}

Write-Output "Backup written to $outputFile"

