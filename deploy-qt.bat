@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
echo Deploying Qt DLLs...
C:\Qt\6.12.0\msvc2022_64\bin\windeployqt.exe C:\dev\DiskRaptor\qt-app\build\DiskRaptor.exe --no-translations --no-opengl
echo Done.
dir C:\dev\DiskRaptor\qt-app\build\*.dll 2>nul
