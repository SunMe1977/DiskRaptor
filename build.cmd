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

REM -- Override paths via env vars: DISKRAptor_MSVC_ROOT, DISKRAptor_WIN10_KIT, DISKRAptor_WIN10_KIT_VER

REM -- Find tool paths (override via environment variables) ------
set "MSVC_ROOT=%DISKRAptor_MSVC_ROOT%"
if "%MSVC_ROOT%"=="" set "MSVC_ROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"

set "WIN10_KIT=%DISKRAptor_WIN10_KIT%"
if "%WIN10_KIT%"=="" set "WIN10_KIT=C:\Program Files (x86)\Windows Kits\10"

set "WIN10_KIT_VER=%DISKRAptor_WIN10_KIT_VER%"
if "%WIN10_KIT_VER%"=="" set "WIN10_KIT_VER=10.0.26100.0"

set PATH=%MSVC_ROOT%\bin\Hostx64\x64;%PATH%
set PATH=%WIN10_KIT%\bin\%WIN10_KIT_VER%\x64;%PATH%

set INCLUDE=%MSVC_ROOT%\include
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\ucrt
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\shared
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\um
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\%WIN10_KIT_VER%\winrt

set LIB=%MSVC_ROOT%\lib\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\%WIN10_KIT_VER%\ucrt\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\%WIN10_KIT_VER%\um\x64

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

REM -- Step 2: Bundle Tauri app -------------------
echo.
echo [2/3] Bundling Tauri app...
cd /d "%~dp0"
call npx tauri build --bundles nsis --ci
if %ERRORLEVEL% neq 0 (
    echo ERROR: Tauri build failed
    pause
    exit /b 1
)
echo OKREM -- Step 3: Create dist package --------------
echo.
echo [3/3] Packaging dist...
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

REM -- Create NSIS installer if makensis is available
set MAKENSIS=
if not exist "%MAKENSIS%" set MAKENSIS=%ProgramFiles%\NSIS\makensis.exe
if not exist "%MAKENSIS%" set MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe
if not exist "%MAKENSIS%" for /f "delims=" %%i in ('where makensis 2^>nul') do set MAKENSIS=%%i
if exist "%MAKENSIS%" (
    echo [EXTRA] Creating NSIS installer...
    cd /d "%~dp0installer\nsis"
    "%MAKENSIS%" DiskRaptor.nsi
    if %ERRORLEVEL% equ 0 (
        copy DiskRaptor-*.exe "%~dp0dist\" >nul
        echo  OK - NSIS installer created
        if defined SIGNTOOL (
            echo  [SIGN] Signing installer...
            "%SIGNTOOL%" sign /fd SHA256 /a /tr http://timestamp.digicert.com /td SHA256 "%~dp0dist\DiskRaptor-*.exe"
            echo  OK - Installer signed
        )
    ) else (
        echo  WARNING: NSIS installer creation failed
    )
    cd /d "%~dp0"
) else (
    echo  NSIS not found - skipping installer creation
    echo  Install NSIS from https://nsis.sourceforge.io to create setup.exe
)

REM -- Step 4: MSIX (Microsoft Store) package ------------
echo.
echo [MSIX] Building MSIX package...
set "MSIX_CERT=%SIGNTOOL_CERT_PATH%"
if not exist "%MSIX_CERT%" set "MSIX_CERT=%~dp0certs\DiskRaptor.pfx"
if exist "%MSIX_CERT%" (
    REM Build MSIX with the same signing cert used for signtool.
    call npx tauri build --bundles msix --ci
    if %ERRORLEVEL% equ 0 (
        echo  OK - MSIX package built
        echo  Upload it via Partner Center: https://partner.microsoft.com/dashboard
    ) else (
        echo  WARNING: MSIX build failed (check tauri msix prerequisites)
    )
) else (
    echo  SKIP MSIX: no signing certificate found.
    echo  Set SIGNTOOL_CERT_PATH or place a .pfx at certs\DiskRaptor.pfx
    echo  Microsoft Store requires an MSIX signed with a cert from your
    echo  Partner Center account (not the signtool/EV cert).
)

echo.
echo ==========================================
echo   BUILD COMPLETE
echo ==========================================
echo.
echo  EXE: dist\DiskRaptor.exe
echo  MSIX: src-tauri\target\release\bundle\msix\*
echo.

pause
