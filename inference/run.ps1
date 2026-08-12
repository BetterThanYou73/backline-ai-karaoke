# Start the Backline Inference API server.
#   .\run.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv")) {
    Write-Host "No .venv found. Create one first:" -ForegroundColor Yellow
    Write-Host "  py -3.11 -m venv .venv"
    Write-Host "  .venv\Scripts\Activate.ps1"
    Write-Host "  pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example (STUB_MODE=1)." -ForegroundColor Cyan
}

& ".venv\Scripts\python.exe" -m app.main
