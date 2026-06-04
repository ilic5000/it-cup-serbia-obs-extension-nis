# ─────────────────────────────────────────────────────────────────────────────
#  Build & push to GitHub Container Registry (ghcr.io)
#
#  FIRST-TIME SETUP (once per machine):
#    1. Create a GitHub Personal Access Token at:
#       https://github.com/settings/tokens  → "Generate new token (classic)"
#       Required scope: write:packages  (includes read:packages + delete:packages)
#    2. Run in a terminal (paste your token when prompted):
#       $env:CR_PAT = "ghp_xxxxxxxxxxxxxxxxxxxx"
#       echo $env:CR_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
#       That's it — Docker stores the credentials; you never need to log in again.
#
#  USAGE:
#    .\docker-push.ps1                          # patch bump:  1.0.0 → 1.0.1
#    .\docker-push.ps1 -Bump minor             # minor bump:  1.0.0 → 1.1.0
#    .\docker-push.ps1 -Bump major             # major bump:  1.0.0 → 2.0.0
#    .\docker-push.ps1 -Version 2.3.0          # exact version
# ─────────────────────────────────────────────────────────────────────────────

param(
    [ValidateSet('patch','minor','major')]
    [string]$Bump = 'patch',

    [string]$Version = ''   # override: skip auto-bump and use this exact version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Config — edit these two lines ────────────────────────────────────────────
$GITHUB_USER  = 'YOUR_GITHUB_USERNAME'   # <── replace with your GitHub username
$IMAGE_NAME   = 'it-cup-obs-extension'   # image name (all lowercase)
# ─────────────────────────────────────────────────────────────────────────────

$REGISTRY     = 'ghcr.io'
$FULL_IMAGE   = "$REGISTRY/$GITHUB_USER/$IMAGE_NAME"
$PKG_JSON     = Join-Path $PSScriptRoot 'package.json'

# ── Read current version from package.json ───────────────────────────────────
$pkg = Get-Content $PKG_JSON -Raw | ConvertFrom-Json
$currentVersion = $pkg.version

if ($Version -ne '') {
    $newVersion = $Version
} else {
    $parts = $currentVersion -split '\.'
    $maj = [int]$parts[0]
    $min = [int]$parts[1]
    $pat = [int]$parts[2]

    switch ($Bump) {
        'major' { $maj++; $min = 0; $pat = 0 }
        'minor' { $min++; $pat = 0 }
        'patch' { $pat++ }
    }
    $newVersion = "$maj.$min.$pat"
}

Write-Host ""
Write-Host "  Current version : $currentVersion"
Write-Host "  New version     : $newVersion"
Write-Host "  Image           : ${FULL_IMAGE}:${newVersion}"
Write-Host ""

$confirm = Read-Host "  Proceed? [Y/n]"
if ($confirm -match '^[nN]') {
    Write-Host "  Aborted." -ForegroundColor Yellow
    exit 0
}

# ── Bump version in package.json ─────────────────────────────────────────────
$raw = Get-Content $PKG_JSON -Raw
$raw = $raw -replace '"version"\s*:\s*"[^"]+"', """version"": ""$newVersion"""
Set-Content $PKG_JSON $raw -NoNewline
Write-Host "  ✓ package.json updated → $newVersion" -ForegroundColor Green

# ── Build ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Building $FULL_IMAGE ..." -ForegroundColor Cyan
docker build `
    --label "org.opencontainers.image.version=$newVersion" `
    --label "org.opencontainers.image.source=https://github.com/$GITHUB_USER/$IMAGE_NAME" `
    -t "${FULL_IMAGE}:${newVersion}" `
    -t "${FULL_IMAGE}:latest" `
    $PSScriptRoot

if ($LASTEXITCODE -ne 0) { Write-Host "  ✗ Build failed." -ForegroundColor Red; exit 1 }
Write-Host "  ✓ Build done." -ForegroundColor Green

# ── Push ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Pushing ${FULL_IMAGE}:${newVersion} ..." -ForegroundColor Cyan
docker push "${FULL_IMAGE}:${newVersion}"
if ($LASTEXITCODE -ne 0) { Write-Host "  ✗ Push failed." -ForegroundColor Red; exit 1 }

Write-Host "  Pushing ${FULL_IMAGE}:latest ..." -ForegroundColor Cyan
docker push "${FULL_IMAGE}:latest"
if ($LASTEXITCODE -ne 0) { Write-Host "  ✗ Push failed." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ✓ Published successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  ghcr.io image  : ${FULL_IMAGE}:${newVersion}" -ForegroundColor White
Write-Host "  Pull command   : docker pull ${FULL_IMAGE}:${newVersion}" -ForegroundColor White
Write-Host ""
