<#
.SYNOPSIS
  Build the fully-silent DiskRaptor installer EXE for the Microsoft Store.

.DESCRIPTION
  Compiles installer\nsis\DiskRaptor-silent.nsi with makensis. The installer
  payload (diskraptor.exe + diskraptor_scanner.dll + _up_\frontend) is taken
  from the freshly built silent MSI, so the EXE ships exactly the same files
  as the package that gets submitted to the Store. The WebView2 Evergreen
  Standalone installer is downloaded automatically if missing and embedded,
  so the install never needs network access.

  Prerequisites: silent MSI built (npx tauri build --bundles msi
  --config src-tauri/tauri.silent.conf.json --ci), makensis on disk.

  Run from the repo root:
    powershell -ExecutionPolicy Bypass -File installer\nsis\build-silent.ps1
#>
param(
  [string]$Version = "",
  [string]$MsiPath = ""
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Version) { $Version = (Get-Content (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version }
if (-not $MsiPath) { $MsiPath = Join-Path $repoRoot "src-tauri\target\release\bundle\msi\DiskRaptor_${Version}_x64_en-US.msi" }
$MsiPath = (Resolve-Path $MsiPath -ErrorAction Stop).Path

$wv2Dir = Join-Path $repoRoot "installer\webview2"
$wv2 = Join-Path $wv2Dir "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
if (-not (Test-Path $wv2)) {
  New-Item -ItemType Directory -Force -Path $wv2Dir | Out-Null
  Write-Host "Downloading WebView2 Evergreen Standalone (x64)..."
  Invoke-WebRequest -Uri "https://go.microsoft.com/fwlink/p/?LinkId=2124701" -OutFile $wv2 -UseBasicParsing
}

$msi = $MsiPath
if (-not (Test-Path $msi)) {
  throw "Silent MSI not found: $msi`nBuild it first: npx tauri build --bundles msi --config src-tauri/tauri.silent.conf.json --ci"
}

$work = Join-Path $env:TEMP ("dr_silent_" + [guid]::NewGuid().ToString("N"))
try {
  $extract = Join-Path $work "extract"
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Write-Host "Extracting silent MSI payload (msiexec /a)..."
  $p = Start-Process msiexec.exe -ArgumentList "/a `"$msi`" /qn TARGETDIR=`"$extract`"" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($p.ExitCode)" }
  $exe = Get-ChildItem -Path $extract -Recurse -Filter "diskraptor.exe" | Select-Object -First 1
  if (-not $exe) { throw "Could not find diskraptor.exe in the extracted MSI" }
  $payloadDir = $exe.Directory.FullName
  Write-Host "Payload: $payloadDir"

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
  Write-Host "Building DiskRaptor $Version silent installer EXE..."
  & $makensis /V2 "/DPRODUCT_VERSION=$Version" "/DPAYLOAD_DIR=$payloadDir" $script
  if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

  $out = Join-Path $repoRoot "release-assets\DiskRaptor-${Version}-windows-x64-silent.exe"
  Get-Item $out | Select-Object FullName, Length
}
finally {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
