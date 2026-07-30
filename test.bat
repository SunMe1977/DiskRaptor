@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  DiskRaptor -- Cross-Platform Test Suite
echo ========================================
echo.

set "DIST_EXE=%~dp0dist\DiskRaptor.exe"
set "TAURI_RELEASE=%~dp0src-tauri\target\release\diskraptor.exe"
set "TAURI_DEBUG=%~dp0src-tauri\target\debug\diskraptor.exe"

if not exist "%DIST_EXE%" if not exist "%TAURI_RELEASE%" if not exist "%TAURI_DEBUG%" (
  echo ERROR: No runnable application binary found.
  echo Expected one of:
  echo   dist\DiskRaptor.exe
  echo   src-tauri\target\release\diskraptor.exe
  echo   src-tauri\target\debug\diskraptor.exe
  echo Run 'cargo build --release --bin diskraptor' or 'build.sh' first
  exit /b 1
)

if exist "%TAURI_RELEASE%" (
  echo Using Tauri binary: %TAURI_RELEASE%
) else if exist "%TAURI_DEBUG%" (
  echo Using Tauri binary: %TAURI_DEBUG%
) else (
  echo Using dist binary: %DIST_EXE%
)

if "%1"=="--quick" goto :quick
if "%1"=="--list" goto :list
if "%1"=="--help" goto :help

echo Using unified runner: tests/run_tests.mjs
echo.
node tests/run_tests.mjs %*
if !errorlevel! neq 0 exit /b !errorlevel!
goto :eof

:quick
node tests/run_tests.mjs --quick
exit /b

:list
node tests/run_tests.mjs --list
exit /b

:help
echo Usage: test.bat [options] [test-name...]
echo.
echo Options:
echo   --quick     Run a quick smoke test subset
echo   --list      List all available tests
echo   --help      Show this help
echo.
echo Examples:
echo   test.bat                    # Run all 22 cross-platform tests
echo   test.bat --quick            # Quick smoke test
echo   test.bat test_scan_ui.mjs   # Run a specific test (in tests/)
echo.
exit /b
