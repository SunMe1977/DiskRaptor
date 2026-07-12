@echo off
REM DiskRaptor Qt 6 Build + Runtime Separation
REM Produces: Core binaries for NSIS + WebEngine runtime archive

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Qt\Tools\CMake_64\bin;C:\Qt\Tools\Ninja;C:\Qt\6.11.1\msvc2022_64\bin;%PATH%

cd /d C:\dev\DiskRaptor\qt-app
set B=build_qt
if exist %B% rmdir /s /q %B%
mkdir %B%
cd %B%

echo [1/4] Configuring CMake...
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%cd%\install" -DBUILD_SHARED_LIBS=OFF -DQt6_DIR=C:\Qt\6.11.1\msvc2022_64
if %errorlevel% neq 0 exit /b %errorlevel%

echo [2/4] Building...
cmake --build . --config Release
if %errorlevel% neq 0 exit /b %errorlevel%

echo [3/4] Deploying Qt DLLs + installing...
if not exist "%cd%\install\bin" mkdir "%cd%\install\bin"
copy /y "%cd%\DiskRaptor.exe" "%cd%\install\bin\" >nul
copy /y "%cd%\DiskRaptorLauncher.exe" "%cd%\install\bin\" >nul

REM Deploy ALL Qt DLLs first (including WebEngine)
windeployqt --release --no-translations --no-opengl --dir "%cd%\install\bin" "%cd%\install\bin\DiskRaptor.exe"

REM Copy VC++ runtime
if exist C:\Windows\System32\downlevel\api-ms-win-crt-*.dll (
  copy /y C:\Windows\System32\downlevel\api-ms-win-crt-*.dll "%cd%\install\bin\" >nul
)
cmake --install . --config Release --prefix "%cd%\install" 2>nul

REM ── Separate WebEngine runtime from core ──
echo.
echo === Separating WebEngine Runtime ===
set RUNTIME_DIR=%cd%\qtwebengine_runtime
set CORE_DIR=%cd%\install\bin

mkdir "%RUNTIME_DIR%" 2>nul

REM Move WebEngine DLLs to runtime package
for %%f in (
  Qt6WebEngineCore.dll
  Qt6WebEngineWidgets.dll
  Qt6WebEngineQuick.dll
  Qt6WebEngineQuickDelegatesQml.dll
  QtWebEngineProcess.exe
) do (
  if exist "%CORE_DIR%\%%f" (
    move /y "%CORE_DIR%\%%f" "%RUNTIME_DIR%\" >nul
    echo   Moved %%f to runtime
  )
)

REM Move Qt6Quick and Qt6Qml DLLs (needed by WebEngine)
for %%f in ("%CORE_DIR%\Qt6Quick*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6Qml*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6OpenGL*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6Svg*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6ShaderTools*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6BundledProtocol*.dll") do if exist %%f move /y "%%f" "%RUNTIME_DIR%\" >nul

REM Move QML directory
if exist "%CORE_DIR%\qml" (
  move /y "%CORE_DIR%\qml" "%RUNTIME_DIR%\qml" >nul
  echo   Moved qml/ to runtime
)

REM Package runtime as ZIP
echo.
echo === Packaging WebEngine Runtime ===
if exist "%RUNTIME_DIR%\Qt6WebEngineCore.dll" (
  "C:\Program Files\7-Zip\7z.exe" a -tzip "%cd%\qtwebengine_runtime.zip" "%RUNTIME_DIR%\*" >nul
  echo   Runtime ZIP: %cd%\qtwebengine_runtime.zip

  dir "%RUNTIME_DIR%" | find "Qt6WebEngineCore"
  echo ✅ WebEngine runtime packaged successfully
) else (
  echo ⚠ No WebEngine DLLs found — runtime package not created
)

REM ── Create NSIS installer ──
echo.
echo === Creating NSIS Installer ===
copy /y "C:\dev\DiskRaptor\setup.nsi" "%cd%\" >nul
if exist "C:\dev\DiskRaptor\tools\nsis\nsis-3.09\makensis.exe" (
  "C:\dev\DiskRaptor\tools\nsis\nsis-3.09\makensis.exe" /DVERSION=0.2.7 "%cd%\setup.nsi" 2>&1
  if exist "DiskRaptor_*.exe" (
    for %%f in ("DiskRaptor_*.exe") do echo ✅ NSIS Setup: %%f
  ) else (
    echo NSIS installer failed — creating portable ZIP instead
  )
) else (
  echo NSIS not found — creating portable ZIP
  "C:\Program Files\7-Zip\7z.exe" a -tzip "%cd%\diskraptor_core_portable.zip" "%CORE_DIR%\*" >nul
  echo ✅ Core ZIP: %cd%\diskraptor_core_portable.zip
)

echo.
echo === Build Summary ===
echo Binary: %CORE_DIR%\DiskRaptor.exe
echo Launcher: %CORE_DIR%\DiskRaptorLauncher.exe
for %%f in ("%cd%\DiskRaptor_*.exe" "%cd%\diskraptor_*.zip" "%cd%\qtwebengine_runtime.zip") do if exist %%f echo Artifact: %%f
echo.
echo === Done ===
