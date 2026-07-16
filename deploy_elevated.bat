@echo off
setlocal enabledelayedexpansion

echo === DiskRaptor Elevated Deploy ===
echo.

:: Kill any running DiskRaptor processes
echo [1/4] Killing running DiskRaptor processes...
taskkill /f /im DiskRaptor.exe 2>nul
taskkill /f /im DiskRaptorLauncher.exe 2>nul
timeout /t 2 /nobreak >nul

:: Source files
set SRC_EXE=C:\dev\DiskRaptor\qt-app\build_qt\DiskRaptor.exe
set SRC_LAUNCHER=C:\dev\DiskRaptor\qt-app\build_qt\DiskRaptorLauncher.exe
set SRC_RUNTIME=C:\dev\DiskRaptor\qt-app\build_qt\runtime

:: Target directory
set TARGET=C:\Program Files\DiskRaptor5

echo [2/4] Copying binaries to %TARGET%...
copy /y "%SRC_EXE%" "%TARGET%\DiskRaptor.exe"
copy /y "%SRC_LAUNCHER%" "%TARGET%\DiskRaptorLauncher.exe"

echo [3/4] Ensuring runtime marker exists...
if not exist "%TARGET%\runtime\runtime_ready.marker" (
    echo runtime_ready > "%TARGET%\runtime\runtime_ready.marker"
)

echo [4/4] Verifying deployed files...
for %%F in ("%TARGET%\DiskRaptor.exe" "%TARGET%\DiskRaptorLauncher.exe") do (
    echo   %%~nxF: %%~zF bytes, last modified %%~tF
)

echo.
echo === Deploy complete ===
echo.
pause
