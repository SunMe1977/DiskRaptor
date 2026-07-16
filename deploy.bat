@echo off
setlocal enabledelayedexpansion

echo === DiskRaptor Qt-only — Deploy ===
echo.

REM Kill any running DiskRaptor processes
echo Killing running DiskRaptor processes...
taskkill /f /im DiskRaptor.exe 2>nul
taskkill /f /im DiskRaptorLauncher.exe 2>nul
timeout /t 2 /nobreak >nul

REM Set paths
set SRC=C:\dev\DiskRaptor\qt-app\build_qt
set DST=C:\Program Files\DiskRaptor5

REM Create fresh target directory
echo Cleaning %DST% ...
if exist "%DST%" rmdir /s /q "%DST%"
mkdir "%DST%"
if %ERRORLEVEL% neq 0 (
    echo FAILED: Cannot create %DST%. Run this script as Administrator.
    echo Right-click ^> "Run as administrator"
    pause
    exit /b 1
)

REM Copy main exes
echo Copying executables...
copy /Y "%SRC%\DiskRaptor.exe" "%DST%\" || echo FAILED: DiskRaptor.exe
copy /Y "%SRC%\DiskRaptorLauncher.exe" "%DST%\" || echo FAILED: DiskRaptorLauncher.exe

REM Copy all DLLs from build root
echo Copying DLLs...
for %%f in ("%SRC%\*.dll") do copy /Y "%%f" "%DST%\" >nul 2>&1

REM Copy plugin directories
echo Copying plugins...
if exist "%SRC%\install\bin" (
    set SRC=%SRC%\install\bin
) else (
    echo Using build_qt root as source
)

for %%d in (platforms styles imageformats iconengines generic position qmltooling networkinformation tls) do (
    if exist "%SRC%\%%d" (
        if not exist "%DST%\%%d" mkdir "%DST%\%%d"
        xcopy /E /Y "%SRC%\%%d\*" "%DST%\%%d\" >nul 2>&1
    )
)

REM Copy WebEngine runtime
if exist "%SRC%\qml" (
    if not exist "%DST%\qml" mkdir "%DST%\qml"
    xcopy /E /Y "%SRC%\qml" "%DST%\qml\" >nul 2>&1
)

REM Copy runtime directory
if exist "%SRC%\runtime" (
    xcopy /E /Y "%SRC%\runtime" "%DST%\runtime\" >nul 2>&1
)

REM Copy share dir
if exist "%SRC%\share" (
    xcopy /E /Y "%SRC%\share" "%DST%\" >nul 2>&1
)

REM Copy resources
if exist "%SRC%\resources" (
    xcopy /E /Y "%SRC%\resources\*" "%DST%\resources\" >nul 2>&1
)

REM Copy translation Paks
if exist "%SRC%\translations" (
    if not exist "%DST%\translations" mkdir "%DST%\translations"
    copy /Y "%SRC%\translations\*.pak" "%DST%\translations\" >nul 2>&1
)

REM Copy standalone top-level files
copy /Y "%SRC%\*.pak" "%DST%\" >nul 2>&1
copy /Y "%SRC%\*.dat" "%DST%\" >nul 2>&1
copy /Y "%SRC%\*.bin" "%DST%\" >nul 2>&1
copy /Y "%SRC%\*.zip" "%DST%\" >nul 2>&1
copy /Y "%SRC%\*.exe" "%DST%\" >nul 2>&1

REM Copy frontend
echo Copying frontend...
if exist "C:\dev\DiskRaptor\frontend" (
    if not exist "%DST%\frontend" mkdir "%DST%\frontend"
    xcopy /E /Y "C:\dev\DiskRaptor\frontend" "%DST%\frontend\" >nul 2>&1
)

REM Copy modulesPro
echo Copying modulesPro...
if exist "C:\dev\DiskRaptor\modulesPro" (
    if not exist "%DST%\modulesPro" mkdir "%DST%\modulesPro"
    xcopy /E /Y "C:\dev\DiskRaptor\modulesPro" "%DST%\modulesPro\" >nul 2>&1
)

REM Copy install.log if present
copy /Y "%SRC%\install.log" "%DST%\" >nul 2>&1

echo.
echo === DEPLOYMENT COMPLETE ===
echo Target: %DST%
dir "%DST%\*.exe"
echo.
echo Total files copied:
dir "%DST%" /s | find "File"

echo DONE > C:\dev\DiskRaptor\DEPLOY_DONE.txt
