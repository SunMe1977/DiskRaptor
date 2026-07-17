@echo off
chcp 65001 >nul
REM DiskRaptor build — sets up MSVC + Qt 6.8.3 environment directly

echo === Configuring MSVC 2022 + Qt 6.8.3 ===

set "MSVC_ROOT=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.51.36231"
set "WIN10_KIT=C:\Program Files (x86)\Windows Kits\10"

set "PATH=%MSVC_ROOT%\bin\Hostx64\x64;%PATH%"
set "PATH=C:\Qt\Tools\CMake_64\bin;%PATH%"
set "PATH=C:\Qt\Tools\Ninja;%PATH%"

set "INCLUDE=%MSVC_ROOT%\include"
set "INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\ucrt"
set "INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\shared"
set "INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\um"
set "INCLUDE=%INCLUDE%;%WIN10_KIT%\Include\10.0.26100.0\winrt"

set "LIB=%MSVC_ROOT%\lib\x64"
set "LIB=%LIB%;%WIN10_KIT%\Lib\10.0.26100.0\ucrt\x64"
set "LIB=%LIB%;%WIN10_KIT%\Lib\10.0.26100.0\um\x64"

REM Add Windows SDK bin (rc.exe, mt.exe)
set "PATH=%WIN10_KIT%\bin\10.0.26100.0\x64;%PATH%"

set "Qt6_DIR=C:\Qt\6.10.3\msvc2022_64\lib\cmake\Qt6"
set "CMAKE_PREFIX_PATH=C:\Qt\6.10.3\msvc2022_64"

echo Compiler: %MSVC_ROOT%\bin\Hostx64\x64\cl.exe
echo Qt: %Qt6_DIR%
echo.

cmake --version
ninja --version

echo.
echo === Configuring CMake with Qt 6.8.3 ===

cd /d "%~dp0"
if exist build_msi rmdir /s /q build_msi 2>nul
mkdir build_msi
cd build_msi

cmake .. -G Ninja ^
    -DCMAKE_BUILD_TYPE=Release ^
    -DCMAKE_C_COMPILER="%MSVC_ROOT%\bin\Hostx64\x64\cl.exe" ^
    -DCMAKE_CXX_COMPILER="%MSVC_ROOT%\bin\Hostx64\x64\cl.exe" ^
    -DQt6_DIR="%Qt6_DIR%" ^
    -DCMAKE_PREFIX_PATH="%CMAKE_PREFIX_PATH%"
if %ERRORLEVEL% neq 0 (
    echo === CMake FAILED ===
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo === Building ===
cmake --build . --config Release
if %ERRORLEVEL% neq 0 (
    echo === Build FAILED ===
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo === Build OK ===
dir *.exe

echo.
echo === Creating MSI ===

REM Add WiX to PATH if installed
if exist "C:\Program Files (x86)\WiX Toolset v3.14\bin" (
    set "PATH=C:\Program Files (x86)\WiX Toolset v3.14\bin;%PATH%"
) else if exist "C:\Program Files (x86)\WiX Toolset v3.11\bin" (
    set "PATH=C:\Program Files (x86)\WiX Toolset v3.11\bin;%PATH%"
)

cpack -G WIX 2>nul
if %ERRORLEVEL% neq 0 (
    echo MSI skipped - WiX not found in PATH
) else (
    echo MSI created!
    for /r %%f in (*.msi) do echo Installer: %%f
)

echo.
echo === DONE ===
pause
