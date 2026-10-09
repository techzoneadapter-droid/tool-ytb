param([Parameter(Mandatory=$true)][string]$Workspace)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$tools = Join-Path $Workspace 'data\ai\tools'
$engine = Join-Path $Workspace 'data\ai\vieneu'
New-Item -ItemType Directory -Force -Path $tools,$engine | Out-Null
Set-Location -LiteralPath $Workspace
function Checked { param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Exe" }
}
$uv = Join-Path $tools 'uv.exe'
Write-Output 'STORYFLOW_SETUP:python'
if (-not (Test-Path -LiteralPath $uv)) {
  $zip = Join-Path $tools 'uv-0.12.24.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/astral-sh/uv/releases/download/0.12.24/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '7c38608c8a18ee137d748a1773053b07ec8f3a30fab49aebaa6f4e4efeceb019') { throw 'UV checksum mismatch' }
  $extract = Join-Path $tools 'uv-extract'
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $downloaded = Get-ChildItem -LiteralPath $extract -Filter uv.exe -Recurse | Select-Object -First 1
  if (-not $downloaded) { throw 'UV executable missing' }
  Copy-Item -LiteralPath $downloaded.FullName -Destination $uv -Force
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $tools 'python'
$env:UV_CACHE_DIR = Join-Path $tools 'cache'
Checked $uv @('python','install','3.11')
$venv = Join-Path $engine '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  Checked $uv @('venv','--python','3.11','--managed-python',$venv)
}
Write-Output 'STORYFLOW_SETUP:dependencies'
Checked $uv @('pip','install','--python',$python,'vieneu==3.8.3','fastapi>=0.115,<1','uvicorn>=0.30,<1','python-multipart>=0.0.20,<1')
Checked $python @('-c','import vieneu, apps.openai_speech, onnxruntime; print("VIENEU_DEPENDENCIES_READY")')
'{"version":"3.8.3"}' | Set-Content -LiteralPath (Join-Path $engine 'installed.json') -Encoding UTF8
Write-Output 'STORYFLOW_SETUP:model'
