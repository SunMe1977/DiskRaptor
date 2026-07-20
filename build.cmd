@echo off
chcp 65001 >nul
title DiskRaptor Build

echo ==========================================
echo   DiskRaptor - Build EXE Only
echo ==========================================
echo.

setlocal

REM -- Find tool paths ----------------------------
set MSVC_ROOT=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207
set WIN10_KIT=C:\Program Files (x86)\Windows Kits\10
set QT_DIR=C:\Qt\6.10.3\msvc2022_64
set CMAKE_DIR=C:\Qt\Tools\CMake_64
set NINJA_DIR=C:\Qt\Tools\Ninja

set PATH=%MSVC_ROOT%\bin\Hostx64\x64;%PATH%
set PATH=%WIN10_KIT%\bin\10.0.26100.0\x64;%PATH%
set PATH=%CMAKE_DIR%\bin;%PATH%
set PATH=%NINJA_DIR%;%PATH%

set INCLUDE=%MSVC_ROOT%\include
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\ucrt
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\shared
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\um
set INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\winrt

set LIB=%MSVC_ROOT%\lib\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\10.0.26100.0\ucrt\x64
set LIB=%LIB%;%WIN10_KIT%\Lib\10.0.26100.0\um\x64

set Qt6_DIR=%QT_DIR%\lib\cmake\Qt6
set CMAKE_PREFIX_PATH=%QT_DIR%

REM -- Step 1: Build Rust DLL --------------------
echo [1/4] Building Rust scanner DLL...
cd /d "%~dp0src-tauri"
call cargo build --release
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust build failed
    pause
    exit /b 1
)
echo OK

REM -- Step 2: Configure CMake -------------------
echo.
echo [2/4] Configuring CMake...
cd /d "%~dp0qt-app"
if exist build rmdir /s /q build
mkdir build
cd build
cmake .. -G Ninja ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DQt6_DIR="%Qt6_DIR%" ^
    -DCMAKE_PREFIX_PATH="%CMAKE_PREFIX_PATH%" ^
    -DCMAKE_C_COMPILER="%MSVC_ROOT%\bin\Hostx64\x64\cl.exe" ^
    -DCMAKE_CXX_COMPILER="%MSVC_ROOT%\bin\Hostx64\x64\cl.exe" ^
    -DCMAKE_MT="%WIN10_KIT%\bin\10.0.26100.0\x64\mt.exe"
if %ERRORLEVEL% neq 0 (
    echo ERROR: CMake configuration failed
    pause
    exit /b 1
)
echo OK

REM -- Step 3: Build ----------------------------
echo.
echo [3/4] Building Qt app...
cmake --build . --config Release
if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    pause
    exit /b 1
)
echo OK

REM -- Step 4: Create dist package --------------
echo.
echo [4/4] Packaging dist...
cd /d "%~dp0"
if exist dist rmdir /s /q dist
mkdir dist

REM Core EXEs + DLLs
copy qt-app\build\DiskRaptor.exe dist\ >nul
copy qt-app\build\QtWebEngineProcess.exe dist\ >nul 2>nul
copy src-tauri\target\release\diskraptor_scanner.dll dist\ >nul
copy qt-app\build\*.dll dist\ >nul 2>nul

REM Qt plugins
if exist qt-app\build\platforms  xcopy /e /i /y qt-app\build\platforms  dist\platforms  >nul
if exist qt-app\build\styles      xcopy /e /i /y qt-app\build\styles      dist\styles      >nul
if exist qt-app\build\imageformats xcopy /e /i /y qt-app\build\imageformats dist\imageformats >nul
if exist qt-app\build\tls         xcopy /e /i /y qt-app\build\tls         dist\tls         >nul
if exist qt-app\build\iconengines xcopy /e /i /y qt-app\build\iconengines dist\iconengines >nul
if exist qt-app\build\networkinformation xcopy /e /i /y qt-app\build\networkinformation dist\networkinformation >nul
if exist qt-app\build\position    xcopy /e /i /y qt-app\build\position    dist\position    >nul
if exist qt-app\build\generic     xcopy /e /i /y qt-app\build\generic     dist\generic     >nul

REM WebEngine resources
if exist qt-app\build\resources    xcopy /e /i /y qt-app\build\resources    dist\resources\    >nul
if exist qt-app\build\resources\*.pak copy /y qt-app\build\resources\*.pak dist\resources\ >nul
if exist qt-app\build\translations xcopy /e /i /y qt-app\build\translations dist\translations >nul

REM Frontend
xcopy /e /i /y frontend dist\frontend\ >nul

REM Images
if exist images xcopy /e /i /y images dist\images\ >nul

echo OK - dist\DiskRaptor.exe

echo.
echo ==========================================
echo   BUILD COMPLETE
echo ==========================================
echo.
echo  EXE: dist\DiskRaptor.exe
echo.

REM -- Create NSIS installer if makensis is available
where makensis >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo [EXTRA] Creating NSIS installer...
    cd /d "%~dp0installer\nsis"
    makensis DiskRaptor.nsi
    if %ERRORLEVEL% equ 0 (
        copy DiskRaptor_*.exe "%~dp0dist\" >nul
        echo  OK - NSIS installer created
    ) else (
        echo  WARNING: NSIS installer creation failed
    )
    cd /d "%~dp0"
) else (
    echo  NSIS not found - skipping installer creation
    echo  Install NSIS from https://nsis.sourceforge.io to create setup.exe
)
echo.
pause
