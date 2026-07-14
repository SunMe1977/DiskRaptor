# DiskRaptor Fix Deploy Script
# Run this as Administrator to deploy fixes to the installed app

param(
    [string]$InstallDir = "C:\Program Files\DiskRaptor",
    [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

Write-Host "=== DiskRaptor Fix Deploy ===" -ForegroundColor Cyan
Write-Host ""

# Backup existing files
$backupDir = "$env:TEMP\DiskRaptor_backup_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
if (-not $NoBackup) {
    Write-Host "Creating backup at: $backupDir" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Copy-Item "$InstallDir\qt-bridge.js" "$backupDir\qt-bridge.js" -Force
    Copy-Item "$InstallDir\DiskRaptor.exe" "$backupDir\DiskRaptor.exe" -Force
    Write-Host "Backup done." -ForegroundColor Green
}

# 1. Fix qt-bridge.js (queue invoke calls instead of immediate reject)
Write-Host ""
Write-Host "[1/2] Updating qt-bridge.js..." -ForegroundColor Cyan
Copy-Item "C:\dev\DiskRaptor\frontend\qt-bridge.js" "$InstallDir\qt-bridge.js" -Force
Write-Host "  ✅ qt-bridge.js updated" -ForegroundColor Green

# 2. Rebuild Qt app if a new binary exists
$buildExe = "C:\dev\DiskRaptor\qt-app\build_qt\DiskRaptor.exe"
if (Test-Path $buildExe) {
    Write-Host "[2/2] Deploying rebuilt DiskRaptor.exe..." -ForegroundColor Cyan
    
    # Stop the running app if it's running
    Get-Process -Name "DiskRaptor" -ErrorAction SilentlyContinue | Stop-Process -Force
    
    Copy-Item $buildExe "$InstallDir\DiskRaptor.exe" -Force
    Write-Host "  ✅ DiskRaptor.exe updated" -ForegroundColor Green
} else {
    Write-Host "[2/2] No rebuilt exe found at $buildExe — skipping." -ForegroundColor Yellow
    Write-Host "  ℹ️  Rebuild first with: cd C:\dev\DiskRaptor\qt-app && cmake --build build_qt --config Release" -ForegroundColor Gray
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "Start DiskRaptor to test the fixes." -ForegroundColor Green
