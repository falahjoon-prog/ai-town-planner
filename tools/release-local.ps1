# Build, sign and publish an AI Town Planner update from this PC (no GitHub Actions minutes).
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File tools\release-local.ps1 [-Notes "what changed"]
# Needs: Node, Rust (cargo), Visual Studio Build Tools (C++), WebView2, and the GitHub CLI signed in (gh auth login).
# Before releasing, raise "version" in src-tauri/tauri.conf.json: the app only offers an update to a HIGHER version.
param([string]$Notes = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$repo = "falahjoon-prog/ai-town-planner"
$conf = "src-tauri\tauri.conf.json"
$keyDir = Join-Path $env:USERPROFILE ".tauri"; $key = Join-Path $keyDir "townplanner_updater.key"
# 1) Signing key: created once and kept on this PC only. KEEP A BACKUP: without it users can never receive an update again.
if (-not (Test-Path $key)) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  npx tauri signer generate -w $key -p "" --ci
  if ($LASTEXITCODE) { throw "Key creation failed" }
  Write-Host "New signing key created: $key  (copy it somewhere safe)" -ForegroundColor Yellow
}
$pub = (Get-Content "$key.pub" -Raw).Trim()
$c = Get-Content $conf -Raw
if ($c -notmatch [regex]::Escape($pub)) {
  $c = [regex]::Replace($c, '"pubkey":\s*"[^"]*"', '"pubkey": "' + $pub + '"')
  Set-Content $conf $c -NoNewline -Encoding utf8
  Write-Host "Public key written into $conf: commit that change." -ForegroundColor Yellow
}
$V = (Get-Content $conf -Raw | ConvertFrom-Json).version
gh auth status | Out-Null; if ($LASTEXITCODE) { throw "Run 'gh auth login' first" }
# 2) Check and build
npm install; if ($LASTEXITCODE) { throw "npm install failed" }
npx tauri icon app-icon.png | Out-Null
npm test; if ($LASTEXITCODE) { throw "Tests failed: not releasing" }
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $key -Raw)
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":true}}'
if ($LASTEXITCODE) { throw "Build failed" }
# 3) Publish: installer on app-v<version>, latest.json on the fixed "updates" release the app reads
$exe = Get-ChildItem "src-tauri\target\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$sig = Get-Content "$($exe.FullName).sig" -Raw
$asset = "AI-Town-Planner_${V}_x64-setup.exe"
Copy-Item $exe.FullName (Join-Path $env:TEMP $asset) -Force
$tag = "app-v$V"
gh release view $tag --repo $repo 2>$null | Out-Null
if ($LASTEXITCODE) { gh release create $tag --repo $repo --title "AI Town Planner v$V" --prerelease --notes "Desktop installer." }
gh release upload $tag (Join-Path $env:TEMP $asset) --repo $repo --clobber
if ($LASTEXITCODE) { throw "Upload failed" }
$json = [ordered]@{ version = $V; notes = $Notes; pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ");
  platforms = @{ "windows-x86_64" = @{ signature = $sig.Trim(); url = "https://github.com/$repo/releases/download/$tag/$asset" } } } | ConvertTo-Json -Depth 5
$lj = Join-Path $env:TEMP "latest.json"; Set-Content $lj $json -Encoding utf8
gh release view updates --repo $repo 2>$null | Out-Null
if ($LASTEXITCODE) { gh release create updates --repo $repo --title "App update feed" --prerelease --notes "latest.json read by the app. Do not delete." }
gh release upload updates $lj --repo $repo --clobber
if ($LASTEXITCODE) { throw "latest.json upload failed" }
Write-Host "Published version $V. Users get it from Settings > App updates (checked at start-up too)." -ForegroundColor Green
