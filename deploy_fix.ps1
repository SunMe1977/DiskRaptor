$Src = "C:\dev\DiskRaptor\qt-app\build_qt\install\bin"
$Dst = "C:\Program Files\DiskRaptor5"

Write-Host "=== Killing DiskRaptor processes ==="
Get-Process DiskRaptor -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process DiskRaptorLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "=== Removing old deploy ==="
Remove-Item "$Dst\*" -Recurse -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "=== Copying from install/bin ==="
New-Item -Path $Dst -ItemType Directory -Force | Out-Null
Copy-Item "$Src\*" $Dst -Recurse -Force

# Create runtime dir with WebEngine DLLs (launcher expects this)
New-Item -Path "$Dst\runtime" -ItemType Directory -Force | Out-Null
$runtimeDlls = @(
    "Qt6WebEngineCore.dll","Qt6WebEngineWidgets.dll","Qt6WebChannel.dll",
    "Qt6Quick.dll","Qt6QuickWidgets.dll","Qt6Qml.dll","Qt6QmlMeta.dll",
    "Qt6QmlModels.dll","Qt6QmlWorkerScript.dll","Qt6OpenGL.dll",
    "Qt6OpenGLWidgets.dll","Qt6Svg.dll","Qt6Positioning.dll","Qt6Network.dll",
    "Qt6SerialPort.dll","QtWebEngineProcess.exe","d3dcompiler_47.dll",
    "dxcompiler.dll","dxil.dll","opengl32sw.dll","icuuc.dll"
)
foreach ($dll in $runtimeDlls) {
    $src = "$Dst\$dll"
    if (Test-Path $src) { Copy-Item $src "$Dst\runtime\$dll" -Force }
}
foreach ($sub in @("resources","translations","qmltooling","qml")) {
    if (Test-Path "$Dst\$sub") {
        New-Item -Path "$Dst\runtime\$sub" -ItemType Directory -Force | Out-Null
        Copy-Item "$Dst\$sub\*" "$Dst\runtime\$sub" -Recurse -Force
    }
}
if (Test-Path "$Dst\translations\qtwebengine_locales") {
    New-Item -Path "$Dst\runtime\qtwebengine_locales" -ItemType Directory -Force | Out-Null
    Copy-Item "$Dst\translations\qtwebengine_locales\*" "$Dst\runtime\qtwebengine_locales" -Recurse -Force
}
Set-Content -Path "$Dst\runtime\runtime_ready.marker" -Value "runtime_ready`r`n"

# frontend + modules
Copy-Item "C:\dev\DiskRaptor\frontend\*" "$Dst\frontend" -Recurse -Force -ErrorAction Continue
Copy-Item "C:\dev\DiskRaptor\modulesPro\*" "$Dst\modulesPro" -Recurse -Force -ErrorAction Continue

$exe = Get-Item "$Dst\DiskRaptor.exe" -ErrorAction SilentlyContinue
$core = Get-Item "$Dst\Qt6Core.dll" -ErrorAction SilentlyContinue
$rt = Get-Item "$Dst\runtime\runtime_ready.marker" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== DEPLOY STATUS ==="
if ($exe) { Write-Host "DiskRaptor.exe: $($exe.LastWriteTime) - $($exe.Length) bytes" }
if ($core) { Write-Host "Qt6Core.dll: v$($core.VersionInfo.FileVersionRaw)" }
if ($rt) { Write-Host "runtime_ready.marker: created" }
