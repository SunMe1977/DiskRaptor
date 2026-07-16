@echo off
set SRC=C:\dev\DiskRaptor\qt-app\build_qt\install\bin
set RUST=C:\dev\DiskRaptor\src-tauri\target\release
set FE=C:\dev\DiskRaptor\frontend
set MP=C:\dev\DiskRaptor\modulesPro
set DST=C:\Program Files\DiskRaptor6

rmdir /s /q "%DST%" 2>nul
mkdir "%DST%"

xcopy "%SRC%\*" "%DST%\" /e /i /q /y
copy "%RUST%\diskraptor_scanner.dll" "%DST%\" /y
xcopy "%FE%\*" "%DST%\frontend\" /e /i /q /y
xcopy "%MP%\*" "%DST%\modulesPro\" /e /i /q /y

mkdir "%DST%\runtime"
for %%f in (Qt6WebEngineCore.dll Qt6WebEngineWidgets.dll Qt6WebChannel.dll Qt6Quick.dll Qt6QuickWidgets.dll Qt6Qml.dll Qt6QmlMeta.dll Qt6QmlModels.dll Qt6QmlWorkerScript.dll Qt6OpenGL.dll Qt6OpenGLWidgets.dll Qt6Svg.dll Qt6Positioning.dll Qt6Network.dll Qt6SerialPort.dll QtWebEngineProcess.exe d3dcompiler_47.dll dxcompiler.dll dxil.dll opengl32sw.dll icuuc.dll icudtl.dat v8_context_snapshot.bin) do if exist "%DST%\%%f" copy "%DST%\%%f" "%DST%\runtime\" /y >nul
for %%d in (resources translations qmltooling qml) do if exist "%DST%\%%d" xcopy "%DST%\%%d\*" "%DST%\runtime\%%d\" /e /i /q /y
if exist "%DST%\translations\qtwebengine_locales" xcopy "%DST%\translations\qtwebengine_locales\*" "%DST%\runtime\qtwebengine_locales\" /e /i /q /y
echo runtime_ready>"%DST%\runtime\runtime_ready.marker"
del "%DST%\qtwebengine_runtime.zip" 2>nul

echo DONE
