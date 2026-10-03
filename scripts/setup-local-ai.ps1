param([switch]$DownloadModel)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$python = Join-Path (Get-Location) '.ai-venv\Scripts\python.exe'
function Checked { param([string]$Exe, [string[]]$Arguments) & $Exe @Arguments; if ($LASTEXITCODE -ne 0) { throw "Command failed: $Exe ($LASTEXITCODE)" } }
if (-not (Test-Path -LiteralPath $python)) {
    Checked 'py' @('-3.10', '-m', 'venv', '.ai-venv')
}
Checked $python @('-m', 'pip', 'install', '--upgrade', 'pip')
# cu118 retains Pascal (GTX 1050) support. Separate from the TTS environment.
& $python -c "import torch; assert torch.__version__ == '2.7.1+cu118'"
if ($LASTEXITCODE -ne 0) {
    Checked $python @('workers/download_torch.py')
    Checked $python @('-m', 'pip', 'install', 'data/setup-cache/torch-2.7.1+cu118-cp310-cp310-win_amd64.whl')
}
Checked $python @('-m', 'pip', 'install', 'torchvision==0.22.1', '--index-url', 'https://download.pytorch.org/whl/cu118')
Checked $python @('-m', 'pip', 'install', '-r', 'workers/requirements.txt', 'diffusers>=0.36,<1')
Checked $python @('workers/check_ai.py')
if ($DownloadModel) {
    Write-Output 'Downloading SD-Turbo after explicit confirmation (approximately 2.6 GB).'
    Checked $python @('workers/download_model.py', '--confirmed')
}
Write-Output 'Local AI environment checks passed. Model availability is checked separately.'
