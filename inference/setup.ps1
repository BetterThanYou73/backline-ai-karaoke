# One-time setup for the Backline Inference API server.
#
#   .\setup.ps1          # base tier only, runs in STUB_MODE
#   .\setup.ps1 -Gpu     # adds torch + audiocraft + faster-whisper (~4-5 GB)

param([switch]$Gpu)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Norton (and most TLS-inspecting AV) re-signs HTTPS with a local root that pip
# does not trust by default, which shows up as CERTIFICATE_VERIFY_FAILED
# against pypi.org. Node already gets this via NODE_EXTRA_CA_CERTS; pip needs
# to be told separately.
$pipArgs = @()
$nortonCert = "C:\ProgramData\Norton\Antivirus\wscert.pem"
if (Test-Path $nortonCert) {
    Write-Host "Using local TLS-inspection certificate: $nortonCert" -ForegroundColor Cyan
    $pipArgs += @("--cert", $nortonCert)
}

if (-not (Test-Path ".venv")) {
    Write-Host "Creating .venv (Python 3.11)..." -ForegroundColor Cyan
    py -3.11 -m venv .venv
}
$python = ".venv\Scripts\python.exe"

Write-Host "Installing base requirements..." -ForegroundColor Cyan
& $python -m pip install @pipArgs -r requirements.txt

if ($Gpu) {
    Write-Host "Installing torch (CUDA 12.1)..." -ForegroundColor Cyan
    & $python -m pip install @pipArgs --index-url https://download.pytorch.org/whl/cu121 torch==2.1.0 torchaudio==2.1.0

    Write-Host "Installing audiocraft + faster-whisper..." -ForegroundColor Cyan
    & $python -m pip install @pipArgs -r requirements-gpu.txt

    Write-Host ""
    Write-Host "GPU tier installed. Set STUB_MODE=0 in inference\.env to use it." -ForegroundColor Green
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example." -ForegroundColor Cyan
}

Write-Host "Done. Start the server with: .\run.ps1" -ForegroundColor Green
