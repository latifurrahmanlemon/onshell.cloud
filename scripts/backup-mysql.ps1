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
$outputFile = Join-Path $OutputDir "onshell-cloud-$timestamp.sql"

$uri = [System.Uri]$DatabaseUrl
$userInfo = $uri.UserInfo.Split(":")
$user = [System.Uri]::UnescapeDataString($userInfo[0])
$password = [System.Uri]::UnescapeDataString($userInfo[1])
$database = $uri.AbsolutePath.TrimStart("/")
$hostName = $uri.Host
$port = if ($uri.Port -gt 0) { $uri.Port } else { 3306 }

mysqldump --host=$hostName --port=$port --user=$user --password=$password --single-transaction --routines --triggers $database > $outputFile

if ($LASTEXITCODE -ne 0) {
  Write-Error "Backup failed."
  exit $LASTEXITCODE
}

Write-Output "Backup written to $outputFile"
