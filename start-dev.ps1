# 本地开发一键启动：不会登录账号，也会关闭所有定时任务。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Start-LocalProcess {
    param(
        [int]$Port,
        [string]$FilePath,
        [string[]]$ProcessArgs,
        [string]$WorkingDirectory
    )
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
        Start-Process -FilePath $FilePath -ArgumentList $ProcessArgs -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
    }
}

docker compose -f docker-compose.dev.yml up -d mysql redis

$deadline = (Get-Date).AddSeconds(90)
do {
    $mysqlState = docker inspect --format '{{.State.Health.Status}}' xianyu-dev-mysql 2>$null
    Start-Sleep -Seconds 2
} while ($mysqlState -ne 'healthy' -and (Get-Date) -lt $deadline)

if ($mysqlState -ne 'healthy') { throw 'MySQL did not become healthy within 90 seconds.' }

$backendPython = Join-Path $root 'backend-web\.venv\Scripts\python.exe'
$backendDir = Join-Path $root 'backend-web'
Start-LocalProcess -Port 8089 -FilePath $backendPython -ProcessArgs @('main.py') -WorkingDirectory $backendDir

$deadline = (Get-Date).AddSeconds(75)
do {
    try { $backendReady = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8089/health' -TimeoutSec 3).StatusCode -eq 200 } catch { $backendReady = $false }
    Start-Sleep -Seconds 2
} while (-not $backendReady -and (Get-Date) -lt $deadline)

if (-not $backendReady) { throw 'backend-web did not start.' }

# 新库会生成默认任务；每次启动前均将它们关掉，避免自动发货、订单与定时操作。
docker exec xianyu-dev-mysql mysql -uroot -Dxianyu_data -e "UPDATE xy_scheduled_tasks SET enabled = 0 WHERE enabled <> 0;"

$websocketPython = Join-Path $root 'websocket\.venv\Scripts\python.exe'
$websocketDir = Join-Path $root 'websocket'
$schedulerPython = Join-Path $root 'scheduler\.venv\Scripts\python.exe'
$schedulerDir = Join-Path $root 'scheduler'
$frontendDir = Join-Path $root 'frontend'
$node = (Get-Command node).Source
# 本地开发必须由用户在页面中手动点击“连接”；即使 .env 被误改，也禁止启动时自动连接真实账号。
$env:AUTO_START_WEBSOCKET = 'false'
Start-LocalProcess -Port 8090 -FilePath $websocketPython -ProcessArgs @('main.py') -WorkingDirectory $websocketDir
Start-LocalProcess -Port 8091 -FilePath $schedulerPython -ProcessArgs @('main.py') -WorkingDirectory $schedulerDir
Start-LocalProcess -Port 9000 -FilePath $node -ProcessArgs @('node_modules\vite\bin\vite.js', '--host', '0.0.0.0') -WorkingDirectory $frontendDir

Write-Host 'Development environment started: http://localhost:9000'
