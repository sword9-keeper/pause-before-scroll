$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @(
    "manifest.json", "core.js", "background.js",
    "pause.html", "pause.js", "timer.js",
    "journal.html", "journal.js", "style.css",
    "README.md", "HANDOFF.md"
) | ForEach-Object { Join-Path $root $_ }
$output = Join-Path $root "artifacts"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "pause-before-scroll-$($manifest.version).zip"
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
Write-Output $archive
