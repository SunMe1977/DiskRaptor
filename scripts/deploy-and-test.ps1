<#
.SYNOPSIS
  Deploy fixed DiskRaptor to Program Files and run test suite.
  Must be run as Administrator.

.DESCRIPTION
  1. Stops any running DiskRaptor
  2. Backs up current installation
  3. Copies rebuilt DiskRaptor.exe + fixed frontend files
  4. Runs a basic smoke test by starting the app
  5. If Playwright is available, runs the E2E test suite
#>

param(
    [string]$SourceDir = "C:\dev\DiskRaptor\qt-app\build_qt",
    [string]$InstallDir = "C:\Program Files\DiskRaptor",
    [switch]$SkipE2E,
    [switch]$SkipBackup
)

$ErrorActionPreference = "Stop"
$Script:ExitCode = 0

function Step($msg, $color = "Cyan") {
    Write-Host ""
    Write-Host "=== $msg ===" -ForegroundColor $color
}

function Warn($msg) {
    Write-Host "  ⚠ $msg" -ForegroundColor Yellow
}

function Info($msg) {
    Write-Host "  ℹ $msg" -ForegroundColor Gray
}

function Ok($msg) {
    Write-Host "  ✅ $msg" -ForegroundColor Green
}

function Fail($msg) {
    Write-Host "  ❌ $msg" -ForegroundColor Red
    $Script:ExitCode = 1
}

# ────────────── Admin Check ──────────────────────────────────
Step "Admin Check"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Fail "This script must be run as Administrator."
    Write-Host "  Right-click PowerShell → 'Run as Administrator'" -ForegroundColor Yellow
    exit 1
}
Ok "Running as Administrator"

# ────────────── Source check ─────────────────────────────────
Step "Checking build artifacts"
if (-not (Test-Path "$SourceDir\DiskRaptor.exe")) {
    Fail "Rebuilt DiskRaptor.exe not found at $SourceDir"
    Info "Run: cd C:\dev\DiskRaptor\qt-app && cmake --build build_qt --config Release"
    exit 1
}
Ok "DiskRaptor.exe found at $SourceDir"

if (-not (Test-Path "$SourceDir\frontend\index.html")) {
    Fail "Frontend not found in build output"
    exit 1
}
Ok "Frontend files found"

# ────────────── Backup ───────────────────────────────────────
if (-not $SkipBackup) {
    Step "Backing up current installation"
    $backupDir = "$env:TEMP\DiskRaptor_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    Copy-Item "$InstallDir\DiskRaptor.exe" "$backupDir\DiskRaptor.exe" -Force
    Copy-Item "$InstallDir\qt-bridge.js" "$backupDir\qt-bridge.js" -Force
    Copy-Item "$InstallDir\app.js" "$backupDir\app.js" -Force
    Copy-Item "$InstallDir\index.html" "$backupDir\index.html" -Force
    Copy-Item "$InstallDir\style.css" "$backupDir\style.css" -Force

    Ok "Backup saved to: $backupDir"
}

# ────────────── Stop running app ─────────────────────────────
Step "Stopping running DiskRaptor"
Get-Process -Name "DiskRaptor" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Ok "Stopped"

# ────────────── Deploy ───────────────────────────────────────
Step "Deploying fixes"
try {
    Copy-Item "$SourceDir\DiskRaptor.exe" "$InstallDir\DiskRaptor.exe" -Force
    Ok "DiskRaptor.exe deployed"

    # Only frontend files that changed
    $frontendFiles = @("qt-bridge.js", "app.js", "index.html", "style.css", "i18n.js")
    foreach ($f in $frontendFiles) {
        $src = "$SourceDir\frontend\$f"
        $dst = "$InstallDir\$f"
        if (Test-Path $src) {
            Copy-Item $src $dst -Force
            Ok "$f deployed"
        }
    }

    # Copy modules
    if (Test-Path "$SourceDir\frontend\modules") {
        Copy-Item "$SourceDir\frontend\modules\*" "$InstallDir\modules\" -Force -Recurse
        Ok "Modules deployed"
    }
} catch {
    Fail "Deploy failed: $_"
    exit 1
}

# ────────────── Smoke test ───────────────────────────────────
Step "Smoke test — launching app"
try {
    $proc = Start-Process -FilePath "$InstallDir\DiskRaptor.exe" -PassThru
    Start-Sleep -Seconds 5

    if ($proc.HasExited) {
        Fail "App exited immediately (exit code: $($proc.ExitCode))"
        Info "Check the app logs and event viewer for details"
    } else {
        Ok "App launched successfully (PID: $($proc.Id))"
        # Let it run a bit longer to confirm stability
        Start-Sleep -Seconds 5
        $stillRunning = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
        if ($stillRunning) {
            Ok "App still running after 5s — smoke test passed"
        } else {
            Fail "App crashed after 5 seconds"
        }
        # Kill it
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
} catch {
    Fail "Smoke test failed: $_"
}

# ────────────── E2E Playwright tests ─────────────────────────
if (-not $SkipE2E) {
    Step "E2E Tests (Playwright)"
    
    # Check if Playwright is available
    $pwPath = "C:\dev\DiskRaptor\node_modules\.bin\playwright"
    if (-not (Test-Path "$pwPath.cmd") -and -not (Test-Path "$pwPath.ps1")) {
        Warn "Playwright not found at $pwPath"
        Info "Run: cd C:\dev\DiskRaptor && npm install"
        $Script:ExitCode = 1
    } else {
        Info "Starting E2E test suite..."
        try {
            $env:DISKraptor_CDP_PORT = "9222"
            $result = & "node" "C:\dev\DiskRaptor\scripts\playwright-qt-e2e.mjs" 2>&1
            Write-Host $result
            if ($LASTEXITCODE -eq 0) {
                Ok "All E2E tests passed"
            } else {
                Fail "Some E2E tests failed (exit code: $LASTEXITCODE)"
            }
        } catch {
            Fail "E2E test runner error: $_"
        }
    }
}

# ────────────── Summary ──────────────────────────────────────
Step "Summary"
if ($Script:ExitCode -eq 0) {
    Ok "All checks passed! DiskRaptor is ready."
} else {
    Warn "Some checks failed. Review the messages above."
}
Info "You can now start DiskRaptor from Start Menu or run '$InstallDir\DiskRaptor.exe'"

exit $Script:ExitCode
