@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  DiskRaptor -- Cross-Platform Test Suite
echo ========================================
echo.

if not exist "dist\DiskRaptor.exe" (
  echo ERROR: Binary not found: dist\DiskRaptor.exe
  echo Run 'build.bat' first
  exit /b 1
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
