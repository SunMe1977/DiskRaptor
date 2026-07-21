@echo off
chcp 65001 >nul
title DiskRaptor Release Upload

setlocal enabledelayedexpansion

set VERSION=0.0.2
set TAG=v%VERSION%

echo ==========================================
echo   DiskRaptor Release Upload v%VERSION%
echo ==========================================
echo.

REM -- Check gh CLI --
where gh >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: GitHub CLI (gh) not found.
    echo   Install: winget install GitHub.cli ^&^& gh auth login
    exit /b 1
)
echo   gh: found

gh auth status 2>&1 | findstr /i "active account" >nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Not authenticated. Run: gh auth login
    exit /b 1
)
echo   Yes, gh CLI authenticated

REM -- Find assets --
set ASSETS=
if exist dist\DiskRaptor-%VERSION%-win64.zip set ASSETS=dist\DiskRaptor-%VERSION%-win64.zip
for %%f in (dist\DiskRaptor_*_Setup.exe) do if exist %%f set ASSETS=!ASSETS! %%f
echo   Assets: !ASSETS!

REM -- Delete old release --
echo.
echo   Deleting old release %TAG% (if any)...
gh release delete %TAG% --yes >nul 2>nul

REM -- Create fresh release --
echo.
echo   Creating release %TAG%...
gh release create %TAG% --title "DiskRaptor v%VERSION%" --notes "" >nul 2>nul

REM -- Get upload URL --
echo.
echo   Getting upload URL...
set UPLOAD_URL=
for /f "delims=" %%u in ('gh release view %TAG% --json "uploadUrl" --jq ".uploadUrl" 2^>nul') do set UPLOAD_URL=%%u
if "!UPLOAD_URL!"=="" (
    echo   ERROR: Could not get upload URL for release %TAG%
    exit /b 1
)
REM Remove {?name,label} suffix
set UPLOAD_URL=!UPLOAD_URL:{?name,label}=!
echo   Upload URL: !UPLOAD_URL!

REM -- Get token --
set TOKEN=%GH_TOKEN%
if "!TOKEN!"=="" set TOKEN=%GITHUB_TOKEN%
if "!TOKEN!"=="" (
    for /f "delims=" %%t in ('gh auth token 2^>nul') do set TOKEN=%%t
)
if "!TOKEN!"=="" (
    echo   WARNING: No token found. Set GH_TOKEN or GITHUB_TOKEN.
    echo   Will try gh CLI for upload (may hang)...
)

REM -- Upload assets --
echo.
echo   Uploading artifacts...
set COUNT=0
for %%f in (!ASSETS!) do (
    if exist %%f (
        set /a COUNT+=1
        set NAME=%%~nxf
        for %%s in (%%f) do set SIZE=%%~zs
        set /a SIZE_MB=!SIZE! / 1048576
        echo     Uploading: !NAME! (!SIZE_MB! MB)...
        if not "!TOKEN!"=="" (
            echo     (using curl)
            curl -L -X POST "!UPLOAD_URL!?name=!NAME!" ^
                -H "Authorization: token !TOKEN!" ^
                -H "Content-Type: application/octet-stream" ^
                --data-binary "@%%f" --connect-timeout 30 --max-time 600 >nul 2>&1
            if !ERRORLEVEL! equ 0 (
                echo       Done
            ) else (
                echo       curl upload failed
            )
        ) else (
            echo     (using gh)
            gh release upload %TAG% "%%f" --clobber >nul 2>&1
            if !ERRORLEVEL! equ 0 (
                echo       Done
            ) else (
                echo       gh upload failed
            )
        )
    ) else (
        echo     SKIP (not found): %%f
    )
)

if %COUNT% equ 0 (
    echo   No files found in dist/.
    echo   Make sure you ran: build.cmd
)

echo.
echo ==========================================
echo   UPLOAD COMPLETE
echo ==========================================
echo.
echo   View: https://github.com/SunMe1977/DiskRaptor/releases/tag/%TAG%

endlocal
