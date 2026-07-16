$Dst = "C:\Program Files\DiskRaptor6"
$QtBuild = "C:\dev\DiskRaptor\qt-app\build_qt"
$RustSrc = "C:\dev\DiskRaptor\src-tauri"

Write-Host "=== Killing old processes ==="
Get-Process DiskRaptor, DiskRaptorLauncher -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "=== Step 1: Build Rust scanner DLL ==="
Set-Location $RustSrc
cargo build --release 2>&1
$rustDll = "$RustSrc\target\release\diskraptor_scanner.dll"
if (-not (Test-Path $rustDll)) {
    Write-Host "FAILED to build Rust DLL!" -ForegroundColor Red
    exit 1
}
Write-Host "Rust DLL built: $((Get-Item $rustDll).Length) bytes"

Write-Host "=== Step 2: Copy Rust DLL to Qt build dir ==="
Copy-Item $rustDll "$QtBuild\install\bin\diskraptor_scanner.dll" -Force

Write-Host "=== Step 3: Build Qt app ==="
Set-Location "C:\dev\DiskRaptor\qt-app"
cmake --build $QtBuild --config Release 2>&1
$qtExe = "$QtBuild\install\bin\DiskRaptor.exe"
if (-not (Test-Path $qtExe)) {
    Write-Host "FAILED to build Qt app!" -ForegroundColor Red
    exit 1
}

Write-Host "=== Step 4: Deploy to DiskRaptor6 ==="
Remove-Item "$Dst\*" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -Path $Dst -ItemType Directory -Force | Out-Null

# Copy all binaries
Copy-Item "$QtBuild\install\bin\*" $Dst -Recurse -Force

# Copy frontend
Copy-Item "C:\dev\DiskRaptor\frontend\*" "$Dst\frontend" -Recurse -Force -ErrorAction Continue

# Copy modulesPro
Copy-Item "C:\dev\DiskRaptor\modulesPro\*" "$Dst\modulesPro" -Recurse -Force -ErrorAction Continue

# Create runtime dir
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
Set-Content -Path "$Dst\runtime\runtime_ready.marker" -Value "runtime_ready"

Write-Host "=== Verification ==="
$exe = Get-Item "$Dst\DiskRaptor.exe"
$html = Get-Item "$Dst\frontend\index.html" -ErrorAction SilentlyContinue
$rust = Get-Item "$Dst\diskraptor_scanner.dll" -ErrorAction SilentlyContinue
$launcher = Get-Item "$Dst\DiskRaptorLauncher.exe" -ErrorAction SilentlyContinue

Write-Host "DiskRaptor.exe: $($exe.LastWriteTime) - $($exe.Length) bytes"
if ($rust) { Write-Host "Rust scanner DLL: $($rust.LastWriteTime) - $($rust.Length) bytes" }
if ($html) { Write-Host "Frontend index.html: $($html.LastWriteTime)" }
if ($launcher) { Write-Host "Launcher: $($launcher.LastWriteTime) - $($launcher.Length) bytes" }

Write-Host "=== DONE ===" -ForegroundColor Green
