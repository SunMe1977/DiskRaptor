$Dst = "C:\Program Files\DiskRaptor6"

Write-Host "=== Kill launcher ==="
Get-Process DiskRaptorLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "=== Recreate runtime directory from current app DLLs ==="
Remove-Item "$Dst\runtime\*" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path "$Dst\runtime" -ItemType Directory -Force | Out-Null

# Copy ALL WebEngine/Quick/QML DLLs into runtime
$runtimeDlls = @(
    "Qt6WebEngineCore.dll","Qt6WebEngineWidgets.dll","Qt6WebChannel.dll",
    "Qt6Quick.dll","Qt6QuickWidgets.dll","Qt6Qml.dll","Qt6QmlMeta.dll",
    "Qt6QmlModels.dll","Qt6QmlWorkerScript.dll","Qt6OpenGL.dll",
    "Qt6OpenGLWidgets.dll","Qt6Svg.dll","Qt6Positioning.dll","Qt6Network.dll",
    "Qt6SerialPort.dll","QtWebEngineProcess.exe","d3dcompiler_47.dll",
    "dxcompiler.dll","dxil.dll","opengl32sw.dll","icuuc.dll",
    "icudtl.dat","v8_context_snapshot.bin"
)
foreach ($dll in $runtimeDlls) {
    if (Test-Path "$Dst\$dll") {
        Copy-Item "$Dst\$dll" "$Dst\runtime\$dll" -Force
    }
}

# Copy subdirectories into runtime
foreach ($sub in @("resources","translations","qmltooling","qml")) {
    if (Test-Path "$Dst\$sub") {
        New-Item -Path "$Dst\runtime\$sub" -ItemType Directory -Force | Out-Null
        Copy-Item "$Dst\$sub\*" "$Dst\runtime\$sub" -Recurse -Force
    }
}

# Copy qtwebengine_locales from translations
if (Test-Path "$Dst\translations\qtwebengine_locales") {
    New-Item -Path "$Dst\runtime\qtwebengine_locales" -ItemType Directory -Force | Out-Null
    Copy-Item "$Dst\translations\qtwebengine_locales\*" "$Dst\runtime\qtwebengine_locales" -Recurse -Force
}

# Create marker file
Set-Content -Path "$Dst\runtime\runtime_ready.marker" -Value "runtime_ready"

# Verify versions match
$core = (Get-Item "$Dst\Qt6Core.dll").VersionInfo
$we = (Get-Item "$Dst\runtime\Qt6WebEngineCore.dll").VersionInfo
Write-Host "Qt6Core.dll:           v$($core.FileVersionRaw)"
Write-Host "runtime\Qt6WebEngineCore: v$($we.FileVersionRaw)"

if ($core.FileVersionRaw -eq $we.FileVersionRaw) {
    Write-Host "VERSIONS MATCH" -ForegroundColor Green
} else {
    Write-Host "VERSIONS MISMATCH!" -ForegroundColor Red
}

Write-Host "=== DONE ==="
