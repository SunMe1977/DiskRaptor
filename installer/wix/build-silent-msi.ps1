<#
.SYNOPSIS
  Build the silent, per-user MSI that is submitted to the Microsoft Store.

.DESCRIPTION
  Compiles installer\wix\silent-peruser.wxs with the WiX toolset that ships
  with Tauri (or one found on PATH / in %WIX%). The package installs to
  %LOCALAPPDATA%\DiskRaptor and needs no elevation, so the Store can install it
  in the background.

  Run after the app binaries exist (npx tauri build --no-bundle ...):

    powershell -ExecutionPolicy Bypass -File installer\wix\build-silent-msi.ps1

  Result: src-tauri\target\release\bundle\msi\DiskRaptor_<version>_x64_en-US.msi
#>
param(
  [string]$Version = "",
  [string]$PayloadDir = "",
  [string]$OutputDir = "",
  [string]$WixTools = ""
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not $Version) { $Version = (Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version }
if (-not $PayloadDir) { $PayloadDir = Join-Path $repoRoot "src-tauri\target\release" }
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot "src-tauri\target\release\bundle\msi" }

if (-not (Test-Path (Join-Path $PayloadDir "diskraptor.exe"))) {
  throw "diskraptor.exe not found in $PayloadDir - build the app first (npx tauri build --no-bundle --features store)"
}
if (-not (Test-Path (Join-Path $PayloadDir "diskraptor_scanner.dll"))) {
  throw "diskraptor_scanner.dll not found in $PayloadDir"
}

# Locate candle.exe / light.exe
if (-not $WixTools) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "tauri\WixTools314"),
    (Join-Path $env:LOCALAPPDATA "tauri\WixTools"),
    $env:WIX
  ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "candle.exe")) }
  if ($candidates) { $WixTools = @($candidates)[0] }
}
if (-not $WixTools) {
  $cmd = Get-Command candle.exe -ErrorAction SilentlyContinue
  if ($cmd) { $WixTools = Split-Path -Parent $cmd.Source }
}
if (-not $WixTools) { throw "candle.exe not found (expected in %LOCALAPPDATA%\tauri\WixTools314)" }

$candle = Join-Path $WixTools "candle.exe"
$light = Join-Path $WixTools "light.exe"
$icon = Join-Path $repoRoot "src-tauri\icons\icon.ico"
$wxs = Join-Path $PSScriptRoot "silent-peruser.wxs"
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$work = Join-Path ([IO.Path]::GetTempPath()) ("diskraptor_msi_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $wixobj = Join-Path $work "main.wixobj"
  $msi = Join-Path $OutputDir "DiskRaptor_${Version}_x64_en-US.msi"
  Remove-Item $msi -Force -ErrorAction SilentlyContinue

  Write-Host "  Building per-user silent MSI (WiX: $WixTools)"
  & $candle -nologo -arch x64 "-dVersion=$Version" "-dPayloadDir=$PayloadDir" "-dIconPath=$icon" -out $wixobj $wxs
  if ($LASTEXITCODE -ne 0) { throw "candle failed with exit code $LASTEXITCODE" }

  & $light -nologo -out $msi $wixobj
  if ($LASTEXITCODE -ne 0) { throw "light failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path $msi)) { throw "MSI was not created: $msi" }

  Get-Item $msi | Select-Object FullName, Length
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
