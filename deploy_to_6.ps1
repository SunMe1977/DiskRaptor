$Dst = "C:\Program Files\DiskRaptor6"
$QtBuild = "C:\dev\DiskRaptor\qt-app\build_qt"
$RustTarget = "C:\dev\DiskRaptor\src-tauri\target\release"
$Frontend = "C:\dev\DiskRaptor\frontend"
$ModulesPro = "C:\dev\DiskRaptor\modulesPro"

Write-Host "=== Kill old processes ==="
Get-Process DiskRaptor, DiskRaptorLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

Write-Host "=== Create target directory ==="
Remove-Item "$Dst\*" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path $Dst -ItemType Directory -Force | Out-Null

Write-Host "=== Copy Qt binaries ==="
Copy-Item "$QtBuild\install\bin\*" $Dst -Recurse -Force

Write-Host "=== Copy Rust scanner DLL ==="
if (Test-Path "$RustTarget\diskraptor_scanner.dll") {
    Copy-Item "$RustTarget\diskraptor_scanner.dll" $Dst -Force
    Write-Host "Rust DLL copied: $((Get-Item "$Dst\diskraptor_scanner.dll").Length) bytes"
} else {
    Write-Host "Rust DLL NOT FOUND at $RustTarget" -ForegroundColor Red
}

Write-Host "=== Copy frontend ==="
Copy-Item "$Frontend\*" "$Dst\frontend" -Recurse -Force -ErrorAction Continue

Write-Host "=== Copy modulesPro ==="
Copy-Item "$ModulesPro\*" "$Dst\modulesPro" -Recurse -Force -ErrorAction Continue

Write-Host "=== Create runtime directory ==="
New-Item -Path "$Dst\runtime" -ItemType Directory -Force | Out-Null
$runtimeDlls = @("Qt6WebEngineCore.dll","Qt6WebEngineWidgets.dll","Qt6WebChannel.dll","Qt6Quick.dll","Qt6QuickWidgets.dll","Qt6Qml.dll","Qt6QmlMeta.dll","Qt6QmlModels.dll","Qt6QmlWorkerScript.dll","Qt6OpenGL.dll","Qt6OpenGLWidgets.dll","Qt6Svg.dll","Qt6Positioning.dll","Qt6Network.dll","Qt6SerialPort.dll","QtWebEngineProcess.exe","d3dcompiler_47.dll","dxcompiler.dll","dxil.dll","opengl32sw.dll","icuuc.dll")
foreach ($dll in $runtimeDlls) { if (Test-Path "$Dst\$dll") { Copy-Item "$Dst\$dll" "$Dst\runtime\$dll" -Force } }
foreach ($sub in @("resources","translations","qmltooling","qml")) { if (Test-Path "$Dst\$sub") { Copy-Item "$Dst\$sub\*" "$Dst\runtime\$sub" -Recurse -Force } }
if (Test-Path "$Dst\translations\qtwebengine_locales") { Copy-Item "$Dst\translations\qtwebengine_locales\*" "$Dst\runtime\qtwebengine_locales" -Recurse -Force }
Set-Content -Path "$Dst\runtime\runtime_ready.marker" -Value "runtime_ready"

Write-Host "=== Verification ==="
$files = @("DiskRaptor.exe","DiskRaptorLauncher.exe","diskraptor_scanner.dll","frontend/index.html","runtime/runtime_ready.marker")
foreach ($f in $files) {
    $p = "$Dst\$f"
    if (Test-Path $p) {
        $item = Get-Item $p
        Write-Host "  $f - $(if($item.Length){$item.Length}else{"dir"}) bytes - $($item.LastWriteTime)"
    } else {
        Write-Host "  $f - MISSING!" -ForegroundColor Red
    }
}
Write-Host "=== DONE ===" -ForegroundColor Green
