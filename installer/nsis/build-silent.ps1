<#
.SYNOPSIS
  Build the fully-silent DiskRaptor installer EXE for the Microsoft Store.

.DESCRIPTION
  Compiles installer\nsis\DiskRaptor-silent.nsi with makensis. Requires the
  Tauri release build (src-tauri\target\release) and the WebView2 Evergreen
  Standalone installer, which is downloaded automatically if missing.

  Run from the repo root:
    powershell -ExecutionPolicy Bypass -File installer\nsis\build-silent.ps1
#>
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$ver = (Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version

$wv2Dir = Join-Path $repoRoot "installer\webview2"
$wv2 = Join-Path $wv2Dir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
if (-not (Test-Path $wv2)) {
  New-Item -ItemType Directory -Force -Path $wv2Dir | Out-Null
  Write-Host "Downloading WebView2 Evergreen Standalone (x64)..."
  Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124701" -OutFile $wv2 -UseBasicParsing
}

$makensis = @(
  "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
  "$env:ProgramFiles\NSIS\makensis.exe",
  "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
  throw "makensis.exe not found - install NSIS (the Tauri bundler normally provides it)"
}

$script = Join-Path $PSScriptRoot "DiskRaptor-silent.nsi"
Write-Host "makensis: $makensis"
Write-Host "Building DiskRaptor $ver silent installer EXE..."
& $makensis /V2 "/DPRODUCT_VERSION=$ver" $script
if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

$out = Join-Path $repoRoot "release-assets\DiskRaptor-${ver}-windows-x64-silent.exe"
Get-Item $out | Select-Object FullName, Length
