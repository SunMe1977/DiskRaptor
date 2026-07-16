@echo off
title DiskRaptor6 Deploy
cd /d "%~dp0"

:: Check if running as admin, if not relaunch
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo === Deploying DiskRaptor6 ===

:: Kill old processes
taskkill /f /im DiskRaptor.exe 2>nul
taskkill /f /im DiskRaptorLauncher.exe 2>nul
timeout /t 2 /nobreak >nul

:: Remove and recreate target
rmdir /s /q "C:\Program Files\DiskRaptor6" 2>nul
mkdir "C:\Program Files\DiskRaptor6" 2>nul

:: Copy Qt binaries
xcopy "C:\dev\DiskRaptor\qt-app\build_qt\install\bin\*" "C:\Program Files\DiskRaptor6\" /e /i /q /y

:: Copy Rust scanner DLL
copy /y "C:\dev\DiskRaptor\src-tauri\target\release\diskraptor_scanner.dll" "C:\Program Files\DiskRaptor6\" >nul

:: Copy frontend
xcopy "C:\dev\DiskRaptor\frontend\*" "C:\Program Files\DiskRaptor6\frontend\" /e /i /q /y

:: Copy modulesPro
xcopy "C:\dev\DiskRaptor\modulesPro\*" "C:\Program Files\DiskRaptor6\modulesPro\" /e /i /q /y

:: Create runtime directory from root DLLs
mkdir "C:\Program Files\DiskRaptor6\runtime" 2>nul

:: Key WebEngine DLLs
for %%f in (
    Qt6WebEngineCore.dll Qt6WebEngineWidgets.dll Qt6WebChannel.dll
    Qt6Quick.dll Qt6QuickWidgets.dll Qt6Qml.dll Qt6QmlMeta.dll
    Qt6QmlModels.dll Qt6QmlWorkerScript.dll Qt6OpenGL.dll Qt6OpenGLWidgets.dll
    Qt6Svg.dll Qt6Positioning.dll Qt6Network.dll Qt6SerialPort.dll
    QtWebEngineProcess.exe d3dcompiler_47.dll dxcompiler.dll dxil.dll
    opengl32sw.dll icuuc.dll icudtl.dat v8_context_snapshot.bin
) do (
    if exist "C:\Program Files\DiskRaptor6\%%f" (
        copy /y "C:\Program Files\DiskRaptor6\%%f" "C:\Program Files\DiskRaptor6\runtime\" >nul
    )
)

:: Subdirs
for %%d in (resources translations qmltooling qml) do (
    if exist "C:\Program Files\DiskRaptor6\%%d" (
        xcopy "C:\Program Files\DiskRaptor6\%%d\*" "C:\Program Files\DiskRaptor6\runtime\%%d\" /e /i /q /y
    )
)

:: qtwebengine_locales
if exist "C:\Program Files\DiskRaptor6\translations\qtwebengine_locales" (
    xcopy "C:\Program Files\DiskRaptor6\translations\qtwebengine_locales\*" "C:\Program Files\DiskRaptor6\runtime\qtwebengine_locales\" /e /i /q /y
)

:: Marker
echo runtime_ready > "C:\Program Files\DiskRaptor6\runtime\runtime_ready.marker"

:: Verify
echo.
echo === Verification ===
for %%f in (
    DiskRaptor.exe
    DiskRaptorLauncher.exe
    diskraptor_scanner.dll
    frontend\index.html
    runtime\Qt6WebEngineCore.dll
    runtime\runtime_ready.marker
) do (
    if exist "C:\Program Files\DiskRaptor6\%%f" (
        echo OK: %%f
    ) else (
        echo MISSING: %%f
    )
)

:: Show version info
for /f "tokens=2 delims==" %%v in (
    'wmic datafile where name^="C:\\Program Files\\DiskRaptor6\\Qt6Core.dll" get Version /value 2^>nul'
) do set CORE_VER=%%v
for /f "tokens=2 delims==" %%v in (
    'wmic datafile where name^="C:\\Program Files\\DiskRaptor6\\runtime\\Qt6WebEngineCore.dll" get Version /value 2^>nul'
) do set RUNTIME_VER=%%v
echo Qt6Core.dll: %CORE_VER%
echo Runtime:     %RUNTIME_VER%

echo.
echo === DONE ===
pause
