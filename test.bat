@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  DiskRaptor -- Run All Windows UI Tests
echo ========================================
echo.

if not exist "dist\DiskRaptor.exe" (
  echo ERROR: Binary not found: dist\DiskRaptor.exe
  echo Run 'build.bat' first
  exit /b 1
)

echo Binary: dist\DiskRaptor.exe
echo Frontend: dist\frontend\
echo.

set "TESTS="
set TESTS=!TESTS! test_scan.mjs
set TESTS=!TESTS! test_rescan.mjs
set TESTS=!TESTS! test_welcome.mjs
set TESTS=!TESTS! test_settings.mjs
set TESTS=!TESTS! test_tree.mjs
set TESTS=!TESTS! test_topfiles.mjs
set TESTS=!TESTS! test_theme.mjs
set TESTS=!TESTS! test_export.mjs
set TESTS=!TESTS! test_favorites.mjs
set TESTS=!TESTS! test_filters.mjs
set TESTS=!TESTS! test_trash.mjs
set TESTS=!TESTS! test_ui_all.mjs
set TESTS=!TESTS! test_find.mjs
set TESTS=!TESTS! test_duplicates.mjs
set TESTS=!TESTS! test_trash_recovery.mjs
set TESTS=!TESTS! test_i18n.mjs
set TESTS=!TESTS! test_tauri.mjs
set TESTS=!TESTS! test_fileops.mjs
set TESTS=!TESTS! test_galaxy.mjs
set TESTS=!TESTS! test_progress.mjs
set TESTS=!TESTS! test_context_menu.mjs
set TESTS=!TESTS! tests\downloads-cleanup.spec.mjs

set PASSED=0
set FAILED=0
set SKIPPED=0
set RESULTS=

for %%t in (%TESTS%) do (
  echo ----------------------------------------
  echo Running: %%t
  echo ----------------------------------------
  if exist "%%t" (
    node "%%t"
    if !errorlevel! equ 0 (
      echo   PASSED: %%t
      set /a PASSED+=1
    ) else (
      echo   FAILED: %%t exit_code=!errorlevel!
      set /a FAILED+=1
      set "RESULTS=!RESULTS!FAIL: %%t\n"
    )
  ) else (
    echo   SKIPPED: %%t not found
    set /a SKIPPED+=1
  )
  echo.
  timeout /t 2 /nobreak >nul
)

echo ========================================
echo  RESULTS
echo ========================================
echo   Passed: !PASSED!
echo   Failed: !FAILED!
echo   Skipped: !SKIPPED!
echo   Total:  19
echo.
if not "!RESULTS!"=="" (
  echo --- Failed Tests ---
  echo !RESULTS!
)

if !FAILED! gtr 0 (
  exit /b 1
)
echo All tests passed!