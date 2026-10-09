$ErrorActionPreference = "Stop"
$bin = Join-Path $PSScriptRoot "../.desktop-payload/runtime/bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$temp = Join-Path $env:RUNNER_TEMP "storyflow-ffmpeg"
if (!$env:RUNNER_TEMP) { $temp = Join-Path $env:TEMP "storyflow-ffmpeg" }
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$zip = Join-Path $temp "ffmpeg.zip"
Invoke-WebRequest $url -OutFile $zip
$expected = ((Invoke-WebRequest "$url.sha256").Content.Trim() -split '\s+')[0]
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw "FFmpeg SHA256 mismatch" }
Expand-Archive $zip -DestinationPath $temp -Force
$ffmpeg = Get-ChildItem $temp -Filter ffmpeg.exe -Recurse | Select-Object -First 1
$ffprobe = Get-ChildItem $temp -Filter ffprobe.exe -Recurse | Select-Object -First 1
Copy-Item $ffmpeg.FullName (Join-Path $bin "ffmpeg.exe") -Force
Copy-Item $ffprobe.FullName (Join-Path $bin "ffprobe.exe") -Force
Copy-Item (Get-Command node.exe).Source (Join-Path $bin "node.exe") -Force
$notices = Join-Path $bin "licenses"
New-Item -ItemType Directory -Force -Path $notices | Out-Null
Get-ChildItem $temp -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } | ForEach-Object { Copy-Item $_.FullName $notices -Force }
Invoke-WebRequest "https://raw.githubusercontent.com/nodejs/node/$(node -p process.version)/LICENSE" -OutFile (Join-Path $notices "Node-LICENSE.txt")
"FFmpeg source/build information: https://www.gyan.dev/ffmpeg/builds/`nSHA256 $actual`nBundled separately under GPLv3." | Out-File (Join-Path $notices "FFmpeg-source.txt") -Encoding utf8
& (Join-Path $bin "node.exe") -e "require('node:sqlite'); console.log(process.version)"
& (Join-Path $bin "ffmpeg.exe") -version | Select-Object -First 1
if ($env:GITHUB_PATH) { (Resolve-Path $bin).Path | Out-File $env:GITHUB_PATH -Append -Encoding utf8 }
