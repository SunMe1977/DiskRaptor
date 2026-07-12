@echo off
REM DiskRaptor Qt 6 Build Script (Windows)
REM Requires: Visual Studio 2022, Qt 6.5+, CMake 3.20+, Ninja

setlocal enabledelayedexpansion
set SCRIPT_DIR=%~dp0
set BUILD_TYPE=%1
if "%BUILD_TYPE%"=="" set BUILD_TYPE=release

echo === DiskRaptor Qt 6 Build (Windows) ===
echo   Type: %BUILD_TYPE%
echo.

REM Find Qt (adjust path as needed)
if not defined Qt6_DIR (
  for /d %%i in ("C:\Qt\6.*\msvc*") do (
    if exist "%%i\bin\qmake.exe" set "Qt6_DIR=%%i"
  )
)
if not defined Qt6_DIR (
  echo Qt 6 not found. Install Qt 6.5+ or set Qt6_DIR.
  exit /b 1
)
echo   Qt6: %Qt6_DIR%

REM Setup Visual Studio environment
if not defined VSCMD_ARG_TGT_ARCH (
  for /f "tokens=*" %%i in ('"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath') do (
    call "%%i\VC\Auxiliary\Build\vcvars64.bat" 2>nul
  )
)

set BUILD_DIR=%SCRIPT_DIR%qt-app\build
rmdir /s /q "%BUILD_DIR%" 2>nul
mkdir "%BUILD_DIR%"
cd /d "%BUILD_DIR%"

echo [1/3] Configuring...
cmake "%SCRIPT_DIR%qt-app" ^
  -DCMAKE_BUILD_TYPE=%BUILD_TYPE% ^
  -DCMAKE_INSTALL_PREFIX="%BUILD_DIR%\install" ^
  -DBUILD_SHARED_LIBS=OFF ^
  -GNinja

echo [2/3] Building...
cmake --build . --config %BUILD_TYPE%

echo [3/3] Copying runtime DLLs...
if exist "%Qt6_DIR%\bin\Qt6WebEngineProcess.exe" (
  copy "%Qt6_DIR%\bin\Qt6WebEngineProcess.exe" "%BUILD_DIR%\install\bin\" 2>nul
  xcopy /s /i /y "%Qt6_DIR%\plugins" "%BUILD_DIR%\install\bin\plugins\" 2>nul
  xcopy /s /i /y "%Qt6_DIR%\resources" "%BUILD_DIR%\install\bin\resources\" 2>nul
  xcopy /s /i /y "%Qt6_DIR%\qml" "%BUILD_DIR%\install\bin\qml\" 2>nul
)

echo.
echo === Build Complete ===
echo Binary: %BUILD_DIR%\install\bin\DiskRaptor.exe
echo.
echo Run: %BUILD_DIR%\install\bin\DiskRaptor.exe
