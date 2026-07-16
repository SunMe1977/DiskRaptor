@echo off
setlocal enabledelayedexpansion

echo ================================
echo DiskRaptor Qt-only Rebuild
echo ================================

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if %ERRORLEVEL% neq 0 (
    echo FAILED: vcvars64.bat
    exit /b 1
)

set QT_DIR=
for %%v in (6.12.0 6.11.1 6.10.3) do (
  if exist "C:\Qt\%%v\msvc2022_64\bin\windeployqt.exe" if exist "C:\Qt\%%v\msvc2022_64\bin\Qt6Core.dll" (
    set QT_DIR=C:\Qt\%%v\msvc2022_64
    goto qt_ok
  )
)
echo FAILED: No Qt 6 msvc2022 found
exit /b 1

:qt_ok
echo Using Qt: %QT_DIR%
set PATH=C:\Qt\Tools\CMake_64\bin;C:\Qt\Tools\Ninja;%QT_DIR%\bin;%PATH%

cd /d C:\dev\DiskRaptor\qt-app
if exist build_qt rmdir /s /q build_qt

echo.
echo === Step 1: CMake Configure ===
echo.

cmake -B build_qt -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=build_qt/install -DCMAKE_PREFIX_PATH="%QT_DIR%"
if %ERRORLEVEL% neq 0 (
    echo FAILED: cmake configure
    exit /b 1
)

echo.
echo === Step 2: CMake Build ===
echo.

cmake --build build_qt --config Release --parallel
if %ERRORLEVEL% neq 0 (
    echo FAILED: cmake build
    exit /b 1
)

echo.
echo === BUILD SUCCESS ===
echo.

echo === Step 3: Deploy Qt DLLs ===

if not exist "build_qt\install\bin" mkdir build_qt\install\bin
copy /y "build_qt\DiskRaptor.exe" "build_qt\install\bin\" >nul
copy /y "build_qt\DiskRaptorLauncher.exe" "build_qt\install\bin\" >nul
windeployqt --release --no-translations --dir "build_qt\install\bin" "build_qt\install\bin\DiskRaptor.exe"

echo.
echo === Step 4: Copy to C:\Program Files\DiskRaptor5 ===
echo.

set DST=C:\Program Files\DiskRaptor5
set SRC=C:\dev\DiskRaptor\qt-app\build_qt

if not exist "%DST%" mkdir "%DST%"

copy /Y "%SRC%\DiskRaptor.exe" "%DST%\" >nul || echo FAILED: DiskRaptor.exe
copy /Y "%SRC%\DiskRaptorLauncher.exe" "%DST%\" >nul || echo FAILED: DiskRaptorLauncher.exe

for %%f in ("%SRC%\*.dll") do copy /Y "%%f" "%DST%\" >nul

if exist "%SRC%\platforms" (
    if not exist "%DST%\platforms" mkdir "%DST%\platforms"
    copy /Y "%SRC%\platforms\*.dll" "%DST%\platforms\" >nul 2>nul
)
if exist "%SRC%\styles" (
    if not exist "%DST%\styles" mkdir "%DST%\styles"
    copy /Y "%SRC%\styles\*.dll" "%DST%\styles\" >nul 2>nul
)
if exist "%SRC%\imageformats" (
    if not exist "%DST%\imageformats" mkdir "%DST%\imageformats"
    copy /Y "%SRC%\imageformats\*.dll" "%DST%\imageformats\" >nul 2>nul
)
if exist "%SRC%\iconengines" (
    if not exist "%DST%\iconengines" mkdir "%DST%\iconengines"
    copy /Y "%SRC%\iconengines\*.dll" "%DST%\iconengines\" >nul 2>nul
)

echo Copying frontend...
if exist "..\frontend" (
    if not exist "%DST%\frontend" mkdir "%DST%\frontend"
    xcopy /E /Y "..\frontend" "%DST%\frontend\" >nul
)

if exist "..\modulesPro" (
    if not exist "%DST%\modulesPro" mkdir "%DST%\modulesPro"
    xcopy /E /Y "..\modulesPro" "%DST%\modulesPro\" >nul
)

echo.
echo === COMPLETE ===
dir "%DST%"

echo.
echo Output file written: C:\dev\DiskRaptor\BUILD_DONE.txt
echo DONE > C:\dev\DiskRaptor\BUILD_DONE.txt
