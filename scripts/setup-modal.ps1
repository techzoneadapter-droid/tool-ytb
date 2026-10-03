$ErrorActionPreference = "Stop"

Write-Host "StoryFlow - Modal setup"
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python chưa được cài hoặc chưa có trong PATH."
}

python -m pip install --upgrade modal
modal setup

Write-Host ""
Write-Host "Đã đăng nhập Modal."
Write-Host "Deploy TTS:"
Write-Host "  modal deploy cloud/modal/tts_app.py"
Write-Host "Deploy Image:"
Write-Host "  modal deploy cloud/modal/image_app.py"
Write-Host ""
Write-Host "Sau đó chép endpoint vào .env.local:"
Write-Host "MODAL_TTS_URL=https://..."
Write-Host "MODAL_IMAGE_URL=https://..."
