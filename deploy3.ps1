$Dst = "C:\Program Files\DiskRaptor5"

# Kill running instances
Get-Process DiskRaptor, DiskRaptorLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Copy all binaries from install\bin
Copy-Item "C:\dev\DiskRaptor\qt-app\build_qt\install\bin\*" $Dst -Recurse -Force

# Copy frontend from the source (not installed to install\bin by POST_BUILD)
Copy-Item "C:\dev\DiskRaptor\frontend\*" "$Dst\frontend" -Recurse -Force -ErrorAction Continue

# Copy modulesPro
Copy-Item "C:\dev\DiskRaptor\modulesPro\*" "$Dst\modulesPro" -Recurse -Force -ErrorAction Continue

# Ensure runtime dir with marker still exists
if (-not (Test-Path "$Dst\runtime\runtime_ready.marker")) {
    New-Item -Path "$Dst\runtime" -ItemType Directory -Force | Out-Null
    foreach ($dll in @("Qt6WebEngineCore.dll","Qt6WebEngineWidgets.dll","Qt6WebChannel.dll","Qt6Quick.dll","Qt6QuickWidgets.dll","Qt6Qml.dll","Qt6QmlMeta.dll","Qt6QmlModels.dll","Qt6QmlWorkerScript.dll","Qt6OpenGL.dll","Qt6OpenGLWidgets.dll","Qt6Svg.dll","Qt6Positioning.dll","Qt6Network.dll","Qt6SerialPort.dll","QtWebEngineProcess.exe","d3dcompiler_47.dll","dxcompiler.dll","dxil.dll","opengl32sw.dll","icuuc.dll")) {
        if (Test-Path "$Dst\$dll") { Copy-Item "$Dst\$dll" "$Dst\runtime\$dll" -Force }
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
}

# Verify
$exe = Get-Item "$Dst\DiskRaptor.exe"
$html = Get-Item "$Dst\frontend\index.html"
Write-Host "Exe: $($exe.LastWriteTime) - $($exe.Length) bytes"
Write-Host "Frontend index.html: $($html.LastWriteTime)"
Write-Host "Done"
