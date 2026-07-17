# Stop local development services while retaining MySQL/Redis volumes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

foreach ($port in 8089, 8090, 8091, 9000) {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

Set-Location $root
docker compose -f docker-compose.dev.yml stop mysql redis
Write-Host 'Development services stopped; Docker volumes retained.'
