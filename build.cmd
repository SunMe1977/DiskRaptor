@echo off
chcp 65001 >nul
title DiskRaptor Build

echo ==========================================
echo   DiskRaptor - Build EXE Only
echo ==========================================
echo.

setlocal

for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "try { (Get-Content package.json | ConvertFrom-Json).version } catch { '' }" 2^>nul`) do set VERSION=%%v
if "%VERSION%"=="" set VERSION=0.0.2

REM -- Override paths via env vars: DISKRAptor_MSVC_ROOT, DISKRAptor_WIN10_KIT, DISKRAptor_WIN10_KIT_VER, DISKRAptor_QT_DIR, DISKRAptor_CMAKE_DIR, DISKRAptor_NINJA_DIR

REM -- Find tool paths (override via environment variables) ------
set "MSVC_ROOT=%DISKRAptor_MSVC_ROOT%"
if "%MSVC_ROOT%"=="" set "MSVC_ROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"

set "WIN10_KIT=%DISKRAptor_WIN10_KIT%"
if "%WIN10_KIT%"=="" set "WIN10_KIT=C:\Program Files (x86)\Windows Kits\10"

set "WIN10_KIT_VER=%DISKRAptor_WIN10_KIT_VER%"
if "%WIN10_KIT_VER%"=="" set "WIN10_KIT_VER=10.0.26100.0"

set "QT_DIR=%DISKRAptor_QT_DIR%"
if "%QT_DIR%"=="" set "QT_DIR=C:\Qt\6.10.3\msvc2022_64"

set "CMAKE_DIR=%DISKRAptor_CMAKE_DIR%"
if "%CMAKE_DIR%"=="" set "CMAKE_DIR=C:\Qt\Tools\CMake_64"

set "NINJA_DIR=%DISKRAptor_NINJA_DIR%"
if "%NINJA_DIR%"=="" set "NINJA_DIR=C:\Qt\Tools\Ninja"

set PATH=%MSVC_ROOT%\bin\Hostx64\x64;%PATH%
set PATH=%WIN10_KIT%\bin\%WIN10_KIT_VER%\x64;%PATH%
set PATH=%CMAKE_DIR%\bin;%PATH%
set PATH=%NINJA_DIR%;%PATH%

set INCLUDE=%MSVC_ROOT%\include
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\ucrt
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\shared
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\um
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\winrt

set LIB=%MSVC_ROOT%\lib\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\%WIN10_KIT_VER%\ucrt\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\%WIN10_KIT_VER%\um\x64

set Qt6_DIR=%QT_DIR%\lib\cmake\Qt6
set CMAKE_PREFIX_PATH=%QT_DIR%

REM -- Step 1: Build Rust app --------------------
echo [1/3] Building Tauri app...
cd /d "%~dp0src-tauri"
call cargo build --release
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust build failed
    pause
    exit /b 1
)
echo OK

REM -- Step 2: Copy assets into frontend for Tauri bundle
echo.
echo [2/4] Copying assets to frontend/...
cd /d "%~dp0"
if exist images xcopy /e /i /y images frontend\images\ >nul 2>nul
if exist src-tauri\icons xcopy /e /i /y src-tauri\icons frontend\icons\ >nul 2>nul
if exist modulesPro xcopy /e /i /y modulesPro frontend\modulesPro\ >nul 2>nul
echo  OK

REM -- Step 3: Bundle Tauri app -------------------
echo.
echo [3/4] Bundling Tauri app...
cd /d "%~dp0"
call npx tauri build --bundles nsis --ci
if %ERRORLEVEL% neq 0 (
    echo ERROR: Tauri build failed
    pause
    exit /b 1
)
echo OK

REM -- Step 3: Create dist package --------------
echo.
echo [4/4] Packaging dist...
cd /d "%~dp0"
if exist dist rmdir /s /q dist
mkdir dist

if exist "src-tauri\target\release\diskraptor.exe" (
    copy "src-tauri\target\release\diskraptor.exe" dist\DiskRaptor.exe >nul
) else if exist "src-tauri\target\release\bundle\windows\DiskRaptor.exe" (
    copy "src-tauri\target\release\bundle\windows\DiskRaptor.exe" dist\DiskRaptor.exe >nul
) else (
    echo WARNING: No Tauri executable found in target output
)

xcopy /e /i /y frontend dist\frontend\ >nul
if exist images xcopy /e /i /y images dist\images\ >nul

echo  OK - dist\DiskRaptor.exe

REM -- Code Signing (optional) -------------------
echo.
echo [SIGN] Signing executables...
set SIGNTOOL=
if exist "%WIN10_KIT%\bin\%WIN10_KIT_VER%\x64\signtool.exe" set SIGNTOOL=%WIN10_KIT%\bin\%WIN10_KIT_VER%\x64\signtool.exe
if not defined SIGNTOOL for /f "delims=" %%i in ('where signtool 2^>nul') do set SIGNTOOL=%%i
if defined SIGNTOOL (
    "%SIGNTOOL%" sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "%~dp0dist\DiskRaptor.exe"
    "%SIGNTOOL%" sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "%~dp0dist\QtWebEngineProcess.exe"
    "%SIGNTOOL%" sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "%~dp0dist\diskraptor_scanner.dll"
    echo  OK - Files signed
) else (
    echo  WARNING: signtool not found - skipping code signing
)

echo.
echo ==========================================
echo   BUILD COMPLETE
echo ==========================================
echo.
echo  EXE: dist\DiskRaptor.exe
echo.

REM -- Create organized NSIS installer
echo.
echo [EXTRA] Creating NSIS installer (organized folders)...
set MAKENSIS=
if not exist "%MAKENSIS%" set "MAKENSIS=%ProgramFiles%\NSIS\makensis.exe"
if not exist "%MAKENSIS%" set "MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not exist "%MAKENSIS%" for /f "delims=" %%i in ('where makensis 2^>nul') do set "MAKENSIS=%%i"
if exist "%MAKENSIS%" (
    cd /d "%~dp0installer\nsis"
    "%MAKENSIS%" DiskRaptor.nsi
    if %ERRORLEVEL% equ 0 (
        copy DiskRaptor_%VERSION%_Setup.exe "%~dp0dist\" >nul
        if defined SIGNTOOL (
            echo  [SIGN] Signing installer...
            "%SIGNTOOL%" sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "%~dp0dist\DiskRaptor_%VERSION%_Setup.exe"
        )
        echo  OK - Organized installer created
    ) else (
        echo  WARNING: NSIS installer creation failed
    )
    cd /d "%~dp0"
) else (
    echo  NSIS not found - skipping installer creation
    echo  Install NSIS from https://nsis.sourceforge.io to create setup.exe
)

pause
