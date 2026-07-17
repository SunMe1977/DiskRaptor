@echo off
chcp 65001 >nul
title DiskRaptor Bootstrap Setup

echo ==========================================
echo   DiskRaptor - Bootstrap Package
echo ==========================================
echo.

REM -- Step 1: Build release first
cd /d "%~dp0"
echo [1/3] Running release build...
call release.cmd
if %ERRORLEVEL% neq 0 exit /b 1

REM -- Step 2: Strip runtime DLLs from dist/
echo.
echo [2/3] Creating bootstrap dist...

REM Backup frontend (keep it)
xcopy /e /i /y dist\frontend dist_bootstrap\frontend >nul 2>&1

REM Remove runtime files (Qt DLLs, plugins, resources)
del dist\*.dll 2>nul
del dist\QtWebEngineProcess.exe 2>nul
for %%d in (iconengines imageformats platforms styles tls generic networkinformation position resources translations) do (
    if exist dist\%%d rmdir /s /q dist\%%d 2>nul
)

REM Restore bootstrapper-required files
copy dist_bootstrap\DiskRaptorLauncher.exe dist\ 2>nul
copy dist_bootstrap\DiskRaptor.exe dist\ 2>nul
copy dist_bootstrap\diskraptor_scanner.dll dist\ 2>nul

REM Keep frontend
xcopy /e /i /y dist_bootstrap\frontend dist\frontend >nul 2>&1

REM Cleanup temp
rmdir /s /q dist_bootstrap 2>nul

echo OK

REM -- Step 3: Show final bootstrap size
echo.
echo [3/3] Bootstrap size:
dir /s dist\ 2>nul
echo.
echo ==========================================
echo   BOOTSTRAP READY
echo ==========================================
echo.
echo  dist\DiskRaptorLauncher.exe  - Bootstrapper (downloads Qt runtime)
echo  dist\DiskRaptor.exe          - Main application
echo  dist\diskraptor_scanner.dll  - Rust scanner
echo  dist\frontend\               - Web UI
echo.
echo  Qt runtime must be downloaded from GitHub releases:
echo    https://github.com/SunMe1977/DiskRaptor/releases/latest
echo.
pause
