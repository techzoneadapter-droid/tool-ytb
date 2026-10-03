$ErrorActionPreference = "Stop"

if (-not (Get-Command modal -ErrorAction SilentlyContinue)) {
  throw "Chưa có Modal CLI. Chạy scripts/setup-modal.ps1 trước."
}

Write-Host "Deploy VieNeu Cloud..."
modal deploy cloud/modal/tts_app.py

Write-Host ""
Write-Host "Deploy Story AI Cloud..."
modal deploy cloud/modal/image_app.py

Write-Host ""
Write-Host "Hoàn tất deploy. Chép hai endpoint HTTPS vào .env.local."
