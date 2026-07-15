@echo off
REM DiskRaptor Qt 6 Build + Runtime Separation
REM Produces: Core binaries for NSIS + WebEngine runtime archive

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set QT_DIR=
REM Order: try common versions, pick the first complete install
for %%v in (6.12.0 6.11.1 6.10.3) do (
  if exist "C:\Qt\%%v\msvc2022_64\bin\windeployqt.exe" if exist "C:\Qt\%%v\msvc2022_64\bin\Qt6Core.dll" (
    set QT_DIR=C:\Qt\%%v\msvc2022_64
    goto :qt_found
  )
)
echo ERROR: No complete Qt msvc2022_64 install found (need windeployqt + Qt6Core.dll).
exit /b 1

:qt_found
echo Using Qt from %QT_DIR%
set PATH=C:\Qt\Tools\CMake_64\bin;C:\Qt\Tools\Ninja;%QT_DIR%\bin;%PATH%

cd /d C:\dev\DiskRaptor\qt-app
set B=build_qt
if exist %B% rmdir /s /q %B%
mkdir %B%
cd %B%

echo [1/4] Configuring CMake...
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%cd%\install" -DCMAKE_PREFIX_PATH="%QT_DIR%"
if %errorlevel% neq 0 exit /b %errorlevel%

echo [2/4] Building...
cmake --build . --config Release
if %errorlevel% neq 0 exit /b %errorlevel%

echo [3/4] Deploying Qt DLLs + installing...
if not exist "%cd%\install\bin" mkdir "%cd%\install\bin"
copy /y "%cd%\DiskRaptor.exe" "%cd%\install\bin\" >nul
copy /y "%cd%\DiskRaptorLauncher.exe" "%cd%\install\bin\" >nul

REM Deploy ALL Qt DLLs first (including WebEngine)
windeployqt --release --no-translations --dir "%cd%\install\bin" "%cd%\install\bin\DiskRaptor.exe"

REM Clean up stray plugin DLLs that windeployqt sometimes drops at root level
REM These belong in platforms/, imageformats/, etc. — not the app root
del /q "%cd%\install\bin\qwindows.dll" 2>nul
del /q "%cd%\install\bin\qgif.dll" 2>nul
del /q "%cd%\install\bin\qico.dll" 2>nul
del /q "%cd%\install\bin\qjpeg.dll" 2>nul
del /q "%cd%\install\bin\qsvg.dll" 2>nul
del /q "%cd%\install\bin\qsvgicon.dll" 2>nul
del /q "%cd%\install\bin\qmodernwindowsstyle.dll" 2>nul
del /q "%cd%\install\bin\qstylekitstyle.dll" 2>nul
del /q "%cd%\install\bin\qtuiotouchplugin.dll" 2>nul
del /q "%cd%\install\bin\qnetworklistmanager.dll" 2>nul
del /q "%cd%\install\bin\qcertonlybackend.dll" 2>nul
del /q "%cd%\install\bin\qschannelbackend.dll" 2>nul

REM Ensure OpenGL DLLs are present even if windeployqt skips them on some setups
if exist "%QT_DIR%\bin\Qt6OpenGL.dll" copy /y "%QT_DIR%\bin\Qt6OpenGL.dll" "%cd%\install\bin\" >nul
if exist "%QT_DIR%\bin\Qt6OpenGLWidgets.dll" copy /y "%QT_DIR%\bin\Qt6OpenGLWidgets.dll" "%cd%\install\bin\" >nul

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
    copy /y "%CORE_DIR%\%%f" "%RUNTIME_DIR%\" >nul
    echo   Moved %%f to runtime
  )
)

REM Move Qt6Quick and Qt6Qml DLLs (needed by WebEngine)
for %%f in ("%CORE_DIR%\Qt6Quick*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6Qml*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6OpenGL*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6Svg*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6ShaderTools*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul
for %%f in ("%CORE_DIR%\Qt6BundledProtocol*.dll") do if exist %%f copy /y "%%f" "%RUNTIME_DIR%\" >nul

REM Copy QML directory
if exist "%CORE_DIR%\qml" (
  xcopy /e /i /y "%CORE_DIR%\qml" "%RUNTIME_DIR%\qml" >nul
  echo   Copied qml/ to runtime
)

REM Copy WebEngine locales to runtime
if exist "%CORE_DIR%\translations\qtwebengine_locales" (
  xcopy /e /i /y "%CORE_DIR%\translations\qtwebengine_locales" "%RUNTIME_DIR%\qtwebengine_locales" >nul
  echo   Copied qtwebengine_locales/ to runtime
)

REM Package runtime as ZIP
echo.
echo === Packaging WebEngine Runtime ===
if exist "%RUNTIME_DIR%\Qt6WebEngineCore.dll" (
  if exist "%cd%\qtwebengine_runtime.zip" del /q "%cd%\qtwebengine_runtime.zip"
  if exist "C:\Program Files\7-Zip\7z.exe" (
    "C:\Program Files\7-Zip\7z.exe" a -tzip "%cd%\qtwebengine_runtime.zip" "%RUNTIME_DIR%\*" >nul
  ) else (
    powershell -Command "Compress-Archive -Path '%RUNTIME_DIR%\*' -DestinationPath '%cd%\qtwebengine_runtime.zip' -Force"
  )
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
set MAKENSIS=
if exist "C:\Program Files (x86)\NSIS\makensis.exe" set MAKENSIS=C:\Program Files (x86)\NSIS\makensis.exe
if exist "C:\dev\DiskRaptor\tools\nsis\nsis-3.09\makensis.exe" set MAKENSIS=C:\dev\DiskRaptor\tools\nsis\nsis-3.09\makensis.exe
if defined MAKENSIS (
  "%MAKENSIS%" /DVERSION=0.0.5 "/DFRONTEND_DIR=%cd%\install\share\DiskRaptor\frontend" "%cd%\setup.nsi" 2>&1
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
