@echo off
chcp 65001 >nul
REM DiskRaptor — Full Build with MSI (Qt 6.8.3)
REM Run from qt-app directory

setlocal

echo === DiskRaptor MSI Build ===
echo.

REM ── Build Rust DLL first ──────────────────────────────────
echo [1/4] Building Rust scanner DLL...
cd /d "%~dp0..\src-tauri"
call cargo build --release
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust build failed
    exit /b %ERRORLEVEL%
)
echo OK

REM ── Set up MSVC + Qt 6.8.3 environment ────────────────────
echo.
echo [2/4] Setting up build environment (Qt 6.8.3, MSVC 2022)...

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if %ERRORLEVEL% neq 0 (
    echo WARNING: vcvars64.bat had issues, trying manual setup
    set "PATH=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64;%PATH%"
    set "INCLUDE=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um"
)

set "CMAKE_PREFIX_PATH=C:\Qt\6.10.3\msvc2022_64"
set "Qt6_DIR=C:\Qt\6.10.3\msvc2022_64\lib\cmake\Qt6"
set "PATH=C:\Qt\Tools\CMake_64\bin;C:\Qt\Tools\Ninja;%PATH%"

REM ── Configure CMake ───────────────────────────────────────
echo.
echo [3/4] Configuring CMake with Qt 6.8.3...

cd /d "%~dp0"
if exist build_msi rmdir /s /q build_msi
mkdir build_msi
cd build_msi

cmake .. -G Ninja ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DCMAKE_PREFIX_PATH="C:\Qt\6.8.3\msvc2022_64" ^
    -DQt6_DIR="C:\Qt\6.8.3\msvc2022_64\lib\cmake\Qt6"
if %ERRORLEVEL% neq 0 (
    echo ERROR: CMake configuration failed
    exit /b %ERRORLEVEL%
)
echo OK

REM ── Build ─────────────────────────────────────────────────
echo.
echo [4/4] Building...
cmake --build . --config Release
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    exit /b %ERRORLEVEL%
)

echo.
echo === Build Complete! ===
echo Binary: %~dp0build_msi\DiskRaptor.exe

REM ── Create MSI ────────────────────────────────────────────
echo.
echo Creating MSI installer with CPack...
cpack -G WIX
if %ERRORLEVEL% eq 0 (
    echo MSI created in: %~dp0build_msi\_CPack_Packages\win64\WIX\
    for %%f in ("%~dp0build_msi\_CPack_Packages\win64\WIX\*.msi") do (
        echo Installer: %%f
    )
) else (
    echo NOTE: MSI creation failed (WiX may not be installed)
    echo The binary is ready at: %~dp0build_msi\DiskRaptor.exe
)

echo.
pause
