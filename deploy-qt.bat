@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

echo Detecting Qt version...
set QT_DIR=
for %%v in (6.10.3 6.11.1 6.12.0) do (
  if exist "C:\Qt\%%v\msvc2022_64\bin\windeployqt.exe" if exist "C:\Qt\%%v\msvc2022_64\bin\Qt6Core.dll" (
    set QT_DIR=C:\Qt\%%v\msvc2022_64
    goto :qt_found
  )
)
echo ERROR: No complete Qt msvc2022_64 install found.
exit /b 1

:qt_found
echo Using Qt from %QT_DIR%
echo Deploying Qt DLLs...
%QT_DIR%\bin\windeployqt.exe C:\dev\DiskRaptor\qt-app\build\DiskRaptor.exe --no-translations --no-opengl
echo Done.
dir C:\dev\DiskRaptor\qt-app\build\*.dll 2>nul
