# build-local.ps1 — fast local dev build for DiskRaptor.
#
# Builds the frontend + Rust binary and drops the exe into dist\DiskRaptor.exe.
# No code signing, no NSIS/MSIX bundling, no prompt — use build.cmd for a full
# release build.
#
# The exe is self-contained (single file): Rust 1.99+ ships a dynamically
# linked std on Windows, which would add a std-<hash>.dll next to the exe, so
# this script pins the build to the last toolchain that still links std
# statically (see $toolchain below).
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
#
#    Toolchain: Rust 1.99 links std as an import library on Windows (the exe
#    then needs std-<hash>.dll beside it). 1.98.0 still embeds std statically,
#    so the local build is pinned to it to keep dist\DiskRaptor.exe a single
#    file like the official release. Remove the pin once a stable release
#    links std statically again.
$toolchain = "1.98.0"
if (-not (rustup toolchain list 2>$null | Select-String -SimpleMatch $toolchain)) {
    Write-Host "Installing Rust $toolchain (one-time, ~250 MB)..." -ForegroundColor Yellow
    rustup toolchain install $toolchain --profile minimal
    if ($LASTEXITCODE -ne 0) { throw "Could not install Rust $toolchain" }
}
$env:RUSTUP_TOOLCHAIN = $toolchain

$profile = if ($DebugBuild) { "debug" } else { "release" }
Write-Host "[2/3] Building Rust binary ($profile)..." -ForegroundColor Yellow
Set-Location "$root\src-tauri"
if ($DebugBuild) {
    npx tauri build --no-bundle --debug --ci
} else {
    npx tauri build --no-bundle --ci
}
if ($LASTEXITCODE -ne 0) { throw "Rust/Tauri build failed" }
Remove-Item Env:\RUSTUP_TOOLCHAIN -ErrorAction SilentlyContinue
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
    $dstExe = Join-Path $dist "DiskRaptor.exe"
    Copy-Item -LiteralPath $srcExe -Destination $dstExe -Force

    # Safety net: only ship a std DLL if this exe actually imports one. The
    # pinned toolchain links std statically (a single exe), but if a future
    # toolchain regresses to dynamic std, the app would fail to start with
    # STATUS_DLL_NOT_FOUND unless the DLL sits next to it.
    $exeText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($dstExe))
    $stdDllName = [regex]::Match($exeText, "std-[0-9a-f]{16}\.dll").Value
    if ($stdDllName) {
        $stdDll = Get-ChildItem (Join-Path $root "src-tauri\target\$profile\deps") -Filter $stdDllName -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $stdDll) {
            $stdDll = Get-ChildItem (Join-Path (rustup run $toolchain rustc --print sysroot) "lib\rustlib\x86_64-pc-windows-msvc\lib") -Filter $stdDllName -ErrorAction SilentlyContinue | Select-Object -First 1
        }
        if ($stdDll) {
            Copy-Item -LiteralPath $stdDll.FullName -Destination (Join-Path $dist $stdDllName) -Force
            Write-Warning "exe imports $stdDllName - copied it next to the exe (dist is not single-file)"
        } else {
            Write-Warning "exe imports $stdDllName but the DLL was not found - the app will not start"
        }
    }
    Write-Host ""
    Write-Host "  OK: dist\DiskRaptor.exe" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Warning "Could not copy exe into dist (is the app running from dist?)."
    Write-Warning "Build succeeded, binary is at: $srcExe"
    Write-Host ""
    exit 1
}
