param([switch]$Personal)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
& node (Join-Path $PSScriptRoot "check-public.mjs")
if ($LASTEXITCODE -ne 0) { throw "Public packaging checks failed; no archive was created." }
$files = @(
    "manifest.json", "core.js", "rules.js", "background.js", "sync.js", "install-defaults.js", "insights.js",
    "pause.html", "pause.js", "expiry.js", "timer.js",
    "journal.html", "journal.js", "site-editor.js", "reviews.js", "review-editor.js", "style.css", "privacy.html", "assets",
    "README.md", "HANDOFF.md", "PRODUCT.md", "PILOT.md", "LIVE_TEST.md", "STORE.md", "vendor"
) | ForEach-Object { Join-Path $root $_ }
$output = Join-Path $root "artifacts"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "pause-before-scroll-$($manifest.version).zip"
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
if ($Personal) {
    if (!$env:BTF_WEBDAV_URL -or !$env:BTF_WEBDAV_USERNAME -or !$env:BTF_WEBDAV_PASSWORD) {
        throw "Personal packaging requires BTF_WEBDAV_URL, BTF_WEBDAV_USERNAME and BTF_WEBDAV_PASSWORD."
    }
    $uri = [Uri]$env:BTF_WEBDAV_URL
    if (!$uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw "Personal WebDAV URL must be HTTPS without embedded credentials, query or fragment."
    }
    $preset = [ordered]@{
        enabled = $true
        url = $uri.AbsoluteUri.TrimEnd('/') + '/'
        username = $env:BTF_WEBDAV_USERNAME
        password = $env:BTF_WEBDAV_PASSWORD
        syncRecords = $true
    }
    $privateArchive = Join-Path $output "pause-before-scroll-$($manifest.version)-personal.zip"
    Copy-Item -LiteralPath $archive -Destination $privateArchive -Force
    $zip = [IO.Compression.ZipFile]::Open($privateArchive, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $manifest.host_permissions = @(@($manifest.host_permissions) + "https://$($uri.Host)/*" | Select-Object -Unique)
        $personalReadme = @"
# Personal build

This ZIP contains your preconfigured WebDAV credentials in plaintext. Keep it private.
On a fresh install, settings and completed-record sync start automatically.
Existing saved connections take precedence. Removing the local connection disables
sync but does not erase credentials embedded in these installation files.

"@ + (Get-Content -LiteralPath (Join-Path $root 'README.md') -Raw -Encoding UTF8)
        $replacements = @{
            'manifest.json' = ($manifest | ConvertTo-Json -Depth 20)
            'install-defaults.js' = "export default $($preset | ConvertTo-Json -Compress);"
            'README.md' = $personalReadme
        }
        foreach ($name in $replacements.Keys) {
            $zip.GetEntry($name).Delete()
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write($replacements[$name]) } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    $archive = $privateArchive
}
Write-Output $archive
