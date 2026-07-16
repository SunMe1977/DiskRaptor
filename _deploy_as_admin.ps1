# DiskRaptor - Deploy to Program Files (Run as Admin)
$ErrorActionPreference = "Stop"

$Src = "C:\dev\DiskRaptor\qt-app\build_qt"
$Dst = "C:\Program Files\DiskRaptor5"

Write-Host "Deploying DiskRaptor to: $Dst" -ForegroundColor Cyan

# Clean target
if (Test-Path $Dst) {
    Remove-Item "$Dst\*" -Recurse -Force
} else {
    New-Item -Path $Dst -ItemType Directory -Force | Out-Null
}

# Copy main binary + launcher
Copy-Item "$Src\DiskRaptor.exe" $Dst -Force
Copy-Item "$Src\DiskRaptorLauncher.exe" $Dst -Force

# Copy all DLLs from root
Get-ChildItem "$Src\*.dll" | Copy-Item -Destination $Dst -Force
Get-ChildItem "$Src\*.pak" | Copy-Item -Destination $Dst -Force
Copy-Item "$Src\QtWebEngineProcess.exe" $Dst -Force -ErrorAction Continue

# Copy plugin directories
$pluginDirs = @("platforms", "styles", "imageformats", "iconengines", "generic", 
                "networkinformation", "tls", "qmltooling", "position", "translations", "resources")
foreach ($dir in $pluginDirs) {
    $srcDir = "$Src\$dir"
    $dstDir = "$Dst\$dir"
    if (Test-Path $srcDir) {
        New-Item -Path $dstDir -ItemType Directory -Force | Out-Null
        Copy-Item "$srcDir\*" $dstDir -Recurse -Force
    }
}

# Copy runtime directory
if (Test-Path "$Src\qtwebengine_runtime") {
    New-Item -Path "$Dst\runtime" -ItemType Directory -Force | Out-Null
    Copy-Item "$Src\qtwebengine_runtime\*" "$Dst\runtime" -Recurse -Force
}

# Copy frontend files
$frontendSrc = "C:\dev\DiskRaptor\frontend"
$frontendDst = "$Dst\frontend"
if (Test-Path $frontendSrc) {
    New-Item -Path $frontendDst -ItemType Directory -Force | Out-Null
    Copy-Item "$frontendSrc\*" $frontendDst -Recurse -Force
}

# Copy modulesPro
$modSrc = "C:\dev\DiskRaptor\modulesPro"
$modDst = "$Dst\modulesPro"
if (Test-Path $modSrc) {
    New-Item -Path $modDst -ItemType Directory -Force | Out-Null
    Copy-Item "$modSrc\*" $modDst -Recurse -Force
}

Write-Host ""
Write-Host "=== DEPLOY COMPLETE ===" -ForegroundColor Green
Get-ChildItem $Dst | Select-Object Name, Length | Format-Table -AutoSize
