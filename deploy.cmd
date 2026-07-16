@echo off
taskkill /f /im DiskRaptor.exe 2>nul
taskkill /f /im DiskRaptorLauncher.exe 2>nul
timeout /t 2 /nobreak >nul
rmdir /s /q "C:\Program Files\DiskRaptor5" 2>nul
mkdir "C:\Program Files\DiskRaptor5"
xcopy "C:\dev\DiskRaptor\qt-app\build_qt\install\bin\*" "C:\Program Files\DiskRaptor5\" /e /i /q /y
echo DEPLOYED
