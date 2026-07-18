@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 exit /b 1
pushd qt-app\build
cmake .. -DCMAKE_BUILD_TYPE=Release -DQt6_DIR="C:\Qt\6.10.3\msvc2022_64\lib\cmake\Qt6" 2>&1
if errorlevel 1 exit /b 1
cmake --build . --config Release 2>&1
if errorlevel 1 exit /b 1
popd
echo "=== QT BUILD OK ==="
