<#
.SYNOPSIS
  Build an (unsigned) MSIX package for the Microsoft Store from the silent MSI.

.DESCRIPTION
  Extracts the app files from the Tauri MSI, generates the AppxManifest +
  logo assets and packs everything with MakeAppx (Windows SDK). Microsoft
  re-signs the package on submission, so no code-signing certificate is
  needed here. Optionally self-signs the result for local testing.

  Run from the repo root. Example:
    powershell -ExecutionPolicy Bypass -File msix\pack-msix.ps1 `
      -MsiPath src-tauri\target\release\bundle\msi\DiskRaptor_1.0.14_x64_en-US.msi `
      -Version 1.0.14.0
#>
param(
  [Parameter(Mandatory=$true)][string]$MsiPath,
  [string]$Version = "1.0.14.0",
  [string]$PackageName = "DiskRaptor.DiskRaptor",
  [string]$Publisher = "CN=Hansjoerg Hofer",
  [string]$DisplayName = "DiskRaptor",
  [string]$PublisherDisplayName = "Hansjoerg Hofer",
  [string]$OutFile = "release-assets\DiskRaptor-windows-x64.msix",
  [switch]$SelfSign
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$work = Join-Path $env:TEMP ("diskraptor_msix_" + [guid]::NewGuid().ToString("N"))

function Find-MakeAppx {
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "$env:ProgramFiles\Windows Kits\10\bin"
  )
  foreach ($root in $roots) {
    if (Test-Path $root) {
      $exe = Get-ChildItem -Path $root -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
      if ($exe) { return $exe.FullName }
    }
  }
  throw "makeappx.exe not found. Install the Windows SDK (Windows Kits 10)."
}

function Get-AppPayload($msi, $destRoot) {
  $extract = Join-Path $destRoot "extract"
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Write-Host "  Extracting MSI (administrative install)..."
  $p = Start-Process msiexec.exe -ArgumentList "/a `"$msi`" /qn TARGETDIR=`"$extract`"" -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "msiexec /a failed with exit code $($p.ExitCode)" }
  $payload = Get-ChildItem -Path $extract -Recurse -Filter "diskraptor.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $payload) { throw "Could not find diskraptor.exe in the extracted MSI" }
  return $payload.Directory.FullName
}

function Write-Utf8NoBom($path, $content) {
  # PS 5.1 `Set-Content -Encoding UTF8` writes a BOM; XML manifests must not
  # carry one (store validation is stricter than makeappx).
  [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-AppxManifest($dir, $name, $version, $pub, $disp, $pubDisp) {
  $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:mp="http://schemas.microsoft.com/appx/2014/phone/manifest"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap mp rescap">
  <Identity Name="$name" Publisher="$pub" Version="$version" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>$disp</DisplayName>
    <PublisherDisplayName>$pubDisp</PublisherDisplayName>
    <Description>Ultra-fast disk space analyzer</Description>
    <Logo>Assets\Logo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-US" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.19041.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="$disp" Executable="diskraptor.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="$disp"
        Description="Ultra-fast disk space analyzer"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png" />
    </Application>
  </Applications>
</Package>
"@
  Write-Utf8NoBom (Join-Path $dir "AppxManifest.xml") $manifest
}

function Write-ContentTypes($dir) {
  $ct = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="exe" ContentType="application/octet-stream" />
  <Default Extension="dll" ContentType="application/octet-stream" />
  <Default Extension="png" ContentType="image/png" />
  <Default Extension="xml" ContentType="application/xml" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="js" ContentType="text/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="woff2" ContentType="font/woff2" />
  <Default Extension="woff" ContentType="font/woff" />
  <Default Extension="ttf" ContentType="font/ttf" />
  <Default Extension="otf" ContentType="font/otf" />
  <Default Extension="mp4" ContentType="video/mp4" />
  <Default Extension="webp" ContentType="image/webp" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="ico" ContentType="image/x-icon" />
  <Default Extension="icns" ContentType="application/octet-stream" />
  <Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml" />
</Types>
"@
  Write-Utf8NoBom (Join-Path $dir "[Content_Types].xml") $ct
}

try {
  Write-Host "=== Packing MSIX ==="
  Write-Host "  MSI:  $MsiPath"
  Write-Host "  Out:  $OutFile"
  $makeappx = Find-MakeAppx
  Write-Host "  makeappx: $makeappx"
  if (-not (Test-Path $MsiPath)) { throw "MSI not found: $MsiPath" }

  New-Item -ItemType Directory -Force -Path $work | Out-Null

  # 1. Payload from the MSI
  $payloadDir = Get-AppPayload $MsiPath $work
  Write-Host "  Payload: $payloadDir"

  # 2. Assemble package dir
  $pkgDir = Join-Path $work "pkg"
  Copy-Item -Path (Join-Path $payloadDir "*") -Destination $pkgDir -Recurse -Force
  $assets = Join-Path $pkgDir "Assets"
  New-Item -ItemType Directory -Force -Path $assets | Out-Null

  # 3. Logos from the master icon
  $icon = Join-Path $repoRoot "src-tauri\icons\icon.png"
  Write-Host "  Generating logos from $icon ..."
  python (Join-Path $PSScriptRoot "generate_logos.py") $icon $assets
  if ($LASTEXITCODE -ne 0) { throw "Logo generation failed" }

  # 4. Manifest + content types
  Write-AppxManifest $pkgDir $PackageName $Version $Publisher $DisplayName $PublisherDisplayName
  Write-ContentTypes $pkgDir
  Write-Host "  AppxManifest.xml written (Publisher=$Publisher, Version=$Version)"

  # 5. Pack
  $outDir = Split-Path -Parent (Join-Path $repoRoot $OutFile)
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $outAbs = Join-Path $repoRoot $OutFile
  if (Test-Path $outAbs) { Remove-Item $outAbs -Force }
  Write-Host "  Running makeappx pack ..."
  & $makeappx pack /d $pkgDir /p $outAbs /o | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed with exit code $LASTEXITCODE" }

  # 6. Optional self-sign (local testing only; the Store re-signs with the real publisher cert)
  if ($SelfSign) {
    Write-Host "  Self-signing with a temporary certificate..."
    $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -FriendlyName "DiskRaptor MSIX test" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3") -NotAfter (Get-Date).AddYears(3)
    $pfx = Join-Path $work "test.pfx"
    $pfxPassword = ConvertTo-SecureString -String "diskraptor-test" -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pfxPassword | Out-Null
    $signtool = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $signtool) { throw "signtool.exe not found for -SelfSign" }
    & $signtool.FullName sign /f $pfx /p "diskraptor-test" /fd SHA256 $outAbs
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed" }
    Remove-Item -Path "cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
  }

  Write-Host ""
  Write-Host "MSIX created: $outAbs"
  Write-Host "Submit this file to Partner Center (Microsoft signs it on submission)."
}
finally {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
