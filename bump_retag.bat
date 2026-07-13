@echo off
setlocal enabledelayedexpansion

echo === DiskRaptor Auto Bump/Retag ===

set TARGET_TAG=%~1
set MESSAGE=%~2
if "%MESSAGE%"=="" set MESSAGE=ci: bump tag and trigger release build

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo This script must run inside a git repository.
  exit /b 1
)

echo Syncing tags from origin...
git fetch --tags --prune origin >nul 2>&1

if "%TARGET_TAG%"=="" (
  for /f "tokens=*" %%a in ('git tag --list "v*" --sort=-v:refname ^| findstr /r /c:"^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$"') do (
    set LATEST_TAG=%%a
    goto :found
  )

  if not defined LATEST_TAG (
    set TARGET_TAG=v0.1.0
  ) else (
    set TAG_NO_V=!LATEST_TAG:v=!
    for /f "tokens=1,2,3 delims=." %%m in ("!TAG_NO_V!") do (
      set MAJOR=%%m
      set MINOR=%%n
      set PATCH=%%o
    )
    set /a PATCH+=1
    set TARGET_TAG=v!MAJOR!.!MINOR!.!PATCH!
  )
)

:found
echo Target tag: %TARGET_TAG%

git status --porcelain >nul 2>&1
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set CHANGED=%%c
if not "%CHANGED%"=="0" (
  echo Working tree has changes. Committing all tracked and untracked files...
  git add -A
  git commit -m "%MESSAGE%" >nul 2>&1
  if errorlevel 1 (
    echo Commit did not complete. Resolve git issues and retry.
    exit /b 1
  )
) else (
  echo No file changes detected. Using current HEAD for tag.
)

echo Checking if tag exists locally or on origin...
set TAG_EXISTS=0
git rev-parse "%TARGET_TAG%" >nul 2>&1 && set TAG_EXISTS=1
git ls-remote --tags origin %TARGET_TAG% | findstr /c:"refs/tags/%TARGET_TAG%" >nul 2>&1 && set TAG_EXISTS=1

if "%TAG_EXISTS%"=="1" (
  echo Tag %TARGET_TAG% already exists. Re-tagging at current HEAD...
  git tag -d %TARGET_TAG% >nul 2>&1
  git push origin :refs/tags/%TARGET_TAG% >nul 2>&1
)

git tag %TARGET_TAG%
if errorlevel 1 (
  echo Failed to create tag %TARGET_TAG%.
  exit /b 1
)

echo Pushing current branch and tag...
git push origin HEAD
if errorlevel 1 (
  echo Failed to push branch HEAD.
  exit /b 1
)

git push origin %TARGET_TAG%
if errorlevel 1 (
  echo Failed to push tag %TARGET_TAG%.
  exit /b 1
)

echo.
echo === Done. Pushed %TARGET_TAG%. GitHub Actions release CI should start now. ===
echo Usage:
echo   bump_retag.bat
echo   bump_retag.bat v0.2.4
echo   bump_retag.bat v0.2.4 "ci: retag after build.yml fixes"
