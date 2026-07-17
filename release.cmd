@echo off
chcp 65001 >nul
title DiskRaptor Release Build

echo ==========================================
echo   DiskRaptor - Release Package Builder
echo ==========================================
echo.

setlocal
cd /d "%~dp0"

REM -- Build everything first
echo [1/4] Building...
call build.cmd
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)

REM -- Create release directory
echo.
echo [2/4] Creating release packages...
if exist release rmdir /s /q release
mkdir release

REM -- Package 1: Qt Runtime Bundle (for bootstrapper download)
echo   Creating qtwebengine_runtime.zip...
if exist "%ProgramFiles%\7-Zip\7z.exe" (
    "%ProgramFiles%\7-Zip\7z.exe" a -tzip -mx=5 release\qtwebengine_runtime.zip ^
        dist\*.dll ^
        dist\QtWebEngineProcess.exe ^
        dist\iconengines ^
        dist\imageformats ^
        dist\platforms ^
        dist\styles ^
        dist\tls ^
        dist\generic ^
        dist\networkinformation ^
        dist\position ^
        dist\resources ^
        dist\translations ^
        >nul
) else (
    echo   WARNING: 7-Zip not found. Install 7-Zip or manually create qtwebengine_runtime.zip
    echo   Required files: all .dll, QtWebEngineProcess.exe, platforms/, styles/, etc.
)

REM -- Package 2: Bootstrapper (small, for initial download)
echo   Creating DiskRaptor_Bootstrap_v0.0.1.zip...
if exist "%ProgramFiles%\7-Zip\7z.exe" (
    "%ProgramFiles%\7-Zip\7z.exe" a -tzip -mx=9 release\DiskRaptor_Bootstrap_v0.0.1.zip ^
        dist\DiskRaptorLauncher.exe ^
        dist\DiskRaptor.exe ^
        dist\diskraptor_scanner.dll ^
        dist\frontend ^
        >nul
) else (
    echo   WARNING: Cannot create bootstrap zip
)

echo OK

REM -- Show results
echo.
echo ==========================================
echo   RELEASE BUILD COMPLETE
echo ==========================================
echo.
dir /s /b release\ 2>nul
echo.
for %%f in (release\*.zip) do (
    for /f "usebackq" %%s in ('%%~zf') do (
        call :size2str %%s size_str
        echo   %%~nxf - %%size_str%%
    )
)
goto :eof

:size2str
setlocal enabledelayedexpansion
set bytes=%~1
if %bytes% geq 1073741824 (
    set /a "gb=%bytes%/1073741824"
    set /a "mb=(%bytes% %% 1073741824)/1048576"
    echo %gb%.%mb% GB
) else if %bytes% geq 1048576 (
    set /a "mb=%bytes%/1048576"
    set /a "kb=(%bytes% %% 1048576)/1024"
    echo %mb%.%kb% MB
) else (
    set /a "kb=%bytes%/1024"
    echo %kb% KB
)
endlocal
goto :eof
