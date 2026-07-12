@echo off
REM DiskRaptor Qt 6 MSI Builder — vollautomatisch

call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Qt\Tools\CMake_64\bin;C:\Qt\Tools\Ninja;C:\Qt\6.12.0\msvc2022_64\bin;C:\dev\DiskRaptor\tools\wix_full;%PATH%

cd /d C:\dev\DiskRaptor\qt-app
if exist build_qt rmdir /s /q build_qt
mkdir build_qt
cd build_qt

echo [1/5] Configuring...
cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%cd%\install" -DBUILD_SHARED_LIBS=OFF -DQt6_DIR=C:\Qt\6.12.0\msvc2022_64
if %errorlevel% neq 0 exit /b %errorlevel%

echo [2/5] Building...
cmake --build . --config Release
if %errorlevel% neq 0 exit /b %errorlevel%

echo [3/5] Deploying Qt DLLs...
if not exist "%cd%\install\bin" mkdir "%cd%\install\bin"
copy /y "%cd%\DiskRaptor.exe" "%cd%\install\bin\" >nul
windeployqt --release --no-translations --no-opengl --dir "%cd%\install\bin" "%cd%\install\bin\DiskRaptor.exe"
if exist C:\Windows\System32\downlevel\api-ms-win-crt-*.dll (
  copy /y C:\Windows\System32\downlevel\api-ms-win-crt-*.dll "%cd%\install\bin\" >nul
)

echo [4/5] Creating MSI...
cpack -G WIX -C Release -D CPACK_PACKAGE_FILE_NAME="DiskRaptor_0.2.6_x64_Qt"
if %errorlevel% equ 0 (
  echo ✅ MSI: %cd%\DiskRaptor_0.2.6_x64_Qt.msi
) else (
  echo MSI generation failed
)

echo [5/5] Done!
echo Binary: %cd%\install\bin\DiskRaptor.exe
for %%f in ("%cd%\DiskRaptor_*.msi") do if exist %%f echo MSI: %%f
