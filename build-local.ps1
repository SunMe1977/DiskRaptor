# build-local.ps1 — fast local dev build for DiskRaptor.
#
# Builds the frontend + Rust binary and drops the exe into dist\DiskRaptor.exe.
# No code signing, no NSIS/MSIX bundling, no prompt — use build.cmd for a full
# release build.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File build-local.ps1
#   powershell -ExecutionPolicy Bypass -File build-local.ps1 -DebugBuild   # debug binary
#   powershell -ExecutionPolicy Bypass -File build-local.ps1 -SkipFrontend # reuse frontend-dist

param(
    [switch]$DebugBuild,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  DiskRaptor $version - Local Dev Build" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 0) Version consistency (cheap safety net)
node scripts/check-version.mjs
if ($LASTEXITCODE -ne 0) { throw "Version consistency check failed" }

# 1) Frontend -> frontend-dist
if (-not $SkipFrontend) {
    Write-Host "[1/3] Building frontend..." -ForegroundColor Yellow
    npm run build:frontend
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }
} else {
    Write-Host "[1/3] Skipping frontend build (-SkipFrontend)" -ForegroundColor DarkGray
}

# 2) Rust binary. Use `tauri build --no-bundle` (not a bare `cargo build`) so
#    the frontend assets are embedded via the tauri/custom-protocol feature —
#    a plain `cargo build` produces a slim exe that is missing the UI.
$profile = if ($DebugBuild) { "debug" } else { "release" }
Write-Host "[2/3] Building Rust binary ($profile)..." -ForegroundColor Yellow
Set-Location "$root\src-tauri"
if ($DebugBuild) {
    npx tauri build --no-bundle --debug --ci
} else {
    npx tauri build --no-bundle --ci
}
if ($LASTEXITCODE -ne 0) { throw "Rust/Tauri build failed" }
Set-Location $root

# 3) Package into dist\
Write-Host "[3/3] Packaging dist\DiskRaptor.exe..." -ForegroundColor Yellow
$srcExe = Join-Path $root "src-tauri\target\$profile\diskraptor.exe"
if (-not (Test-Path -LiteralPath $srcExe)) {
    throw "Binary not found: $srcExe"
}

$dist = Join-Path $root "dist"
if (Test-Path -LiteralPath $dist) {
    Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $dist) {
        Write-Warning "dist is in use (app still running?) - reusing existing folder"
    }
}
if (-not (Test-Path -LiteralPath $dist)) {
    New-Item -ItemType Directory -Path $dist | Out-Null
}

try {
    Copy-Item -LiteralPath $srcExe -Destination (Join-Path $dist "DiskRaptor.exe") -Force
    Write-Host ""
    Write-Host "  OK: dist\DiskRaptor.exe" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Warning "Could not copy exe into dist (is the app running from dist?)."
    Write-Warning "Build succeeded, binary is at: $srcExe"
    Write-Host ""
    exit 1
}
