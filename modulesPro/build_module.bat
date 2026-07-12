@echo off
REM Build the Pro Module directly (no CMake needed)
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

set SRC=C:\dev\DiskRaptor\modulesPro\duplicateScan
set OUT=C:\dev\DiskRaptor\modulesPro

echo Building duplicateScan module...
cl.exe /nologo /O2 /EHsc /MT /std:c++17 /LD ^
  /I"%SRC%/../include" ^
  /Fe"%OUT%/duplicateScan.dll" ^
  "%SRC%/duplicate_scan.cpp" ^
  /link /NOLOGO /DLL /OUT:"%OUT%/duplicateScan.dll"

if %errorlevel% equ 0 (
  echo ✅ Module built: %OUT%/duplicateScan.dll
  dir "%OUT%/duplicateScan.dll"
) else (
  echo ❌ Build failed
  exit /b 1
)
