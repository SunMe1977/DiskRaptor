# DiskRaptor Qt 6 Rebuild Script
# Removes Tauri, builds Qt, copies to C:\Program Files\DiskRaptor5

$ErrorActionPreference = "Stop"
$ProjectRoot = "C:\dev\DiskRaptor"
$QtAppDir = Join-Path $ProjectRoot "qt-app"
$InstallDir = "C:\Program Files\DiskRaptor5"

Write-Host "=== DiskRaptor Qt 6 Rebuild ===" -ForegroundColor Cyan

# ── Step 1: Remove remaining Tauri artifacts ──
Write-Host "[1/5] Removing Tauri artifacts..." -ForegroundColor Yellow
$tauriCleanup = @(
    "src-tauri", "node_modules", ".cargo",
    "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json",
    "Dockerfile.linux", "build-appimage.sh",
    "frontend\tauri-api-bridge.js"
)
foreach ($item in $tauriCleanup) {
    $path = Join-Path $ProjectRoot $item
    if (Test-Path $path) {
        if ((Get-Item $path) -is [System.IO.DirectoryInfo]) {
            Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  Removed dir: $item"
        } else {
            Remove-Item -Path $path -Force -ErrorAction SilentlyContinue
            Write-Host "  Removed file: $item"
        }
    } else {
        Write-Host "  Already gone: $item"
    }
}

# ── Step 2: Detect Visual Studio ──
Write-Host "[2/5] Detecting Visual Studio..." -ForegroundColor Yellow
$vsPaths = @(
    "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
)
# Also check VS 17/18 build tools
for ($i = 14; $i -le 22; $i++) {
    $vsPaths += "C:\Program Files (x86)\Microsoft Visual Studio\$i\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    $vsPaths += "C:\Program Files (x86)\Microsoft Visual Studio\$i\Community\VC\Auxiliary\Build\vcvars64.bat"
    $vsPaths += "C:\Program Files (x86)\Microsoft Visual Studio\$i\Professional\VC\Auxiliary\Build\vcvars64.bat"
}
$vsFound = $null
foreach ($p in $vsPaths) {
    if (Test-Path $p) { $vsFound = $p; break }
}
if (-not $vsFound) {
    Write-Host "  VS not found via paths, trying vswhere..." -ForegroundColor Gray
    try {
        $vswhere = &{&"${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null}
        if ($vswhere) {
            $vsFound = Join-Path $vswhere.Trim() "VC\Auxiliary\Build\vcvars64.bat"
            if (-not (Test-Path $vsFound)) { $vsFound = $null }
        }
    } catch { }
}
if (-not $vsFound) {
    Write-Host "  VS not found, trying MSVC from PATH..." -ForegroundColor Gray
    # Check if cl.exe exists in PATH
    $cl = Get-Command "cl.exe" -ErrorAction SilentlyContinue
    if ($cl) { Write-Host "  Found cl.exe in PATH: $($cl.Source)" }
}

# ── Step 3: Detect Qt ──
Write-Host "[3/5] Detecting Qt 6..." -ForegroundColor Yellow
$qtDirs = @()
if (Test-Path "C:\Qt") {
    $qtDirs = Get-ChildItem "C:\Qt" -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object Name -Descending
}
$qtInstall = $null
foreach ($q in $qtDirs) {
    $msvcPath = Join-Path $q.FullName "msvc2022_64"
    if (Test-Path (Join-Path $msvcPath "bin\Qt6Core.dll")) {
        $qtInstall = $msvcPath
        break
    }
    # Also try msvc2019_64
    $msvcPath2 = Join-Path $q.FullName "msvc2019_64"
    if (Test-Path (Join-Path $msvcPath2 "bin\Qt6Core.dll")) {
        $qtInstall = $msvcPath2
        break
    }
}
if (-not $qtInstall) {
    Write-Host "  No Qt 6 msvc2022 found. Checking any Qt dir..." -ForegroundColor Gray
    foreach ($q in $qtDirs) {
        $subdirs = Get-ChildItem $q.FullName -Directory
        foreach ($sd in $subdirs) {
            if (Test-Path (Join-Path $sd.FullName "bin\Qt6Core.dll")) {
                $qtInstall = $sd.FullName
                break
            }
        }
        if ($qtInstall) { break }
    }
}

if (-not $qtInstall) {
    Write-Host "  ERROR: Qt 6 installation not found at C:\Qt\" -ForegroundColor Red
    exit 1
}
Write-Host "  Found Qt at: $qtInstall" -ForegroundColor Green

# ── Step 4: Build the Qt app ──
Write-Host "[4/5] Building Qt 6 app..." -ForegroundColor Yellow

# Set up environment
if ($vsFound) {
    Write-Host "  Using VS: $vsFound" -ForegroundColor Gray
    # We need to call vcvars64 to set up the environment
    $env:VSCMD_ARG_TGT_ARCH = "x64"
    $env:VSCMD_VER = ""
    # Load VS env from vcvars
    cmd /c "`"$vsFound`" > nul 2>&1 && set" | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)') {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

# Ensure Ninja is in PATH
$ninjaPaths = @(
    Join-Path (Split-Path $qtInstall -Parent) "..\Tools\Ninja",
    "C:\Qt\Tools\Ninja",
    "C:\Program Files\CMake\bin",
    "C:\Program Files\Ninja"
)
foreach ($np in $ninjaPaths) {
    if (Test-Path $np) {
        $env:PATH = "$np;$env:PATH"
    }
}

# Ensure CMake is available
$cmake = Get-Command "cmake" -ErrorAction SilentlyContinue
if (-not $cmake) {
    $cmakePaths = @("C:\Program Files\CMake\bin\cmake.exe", "C:\Qt\Tools\CMake_64\bin\cmake.exe")
    foreach ($cp in $cmakePaths) {
        if (Test-Path $cp) {
            $env:PATH = "$(Split-Path $cp);$env:PATH"
            break
        }
    }
}

# Check if we can find cl.exe now
$clCheck = Get-Command "cl.exe" -ErrorAction SilentlyContinue
$ninjaCheck = Get-Command "ninja" -ErrorAction SilentlyContinue
$cmakeCheck = Get-Command "cmake" -ErrorAction SilentlyContinue

Write-Host "  cl.exe: $($clCheck.Source)" -ForegroundColor Gray
Write-Host "  ninja: $($ninjaCheck.Source)" -ForegroundColor Gray
Write-Host "  cmake: $($cmakeCheck.Source)" -ForegroundColor Gray

# Build
Push-Location $QtAppDir
try {
    $buildDir = Join-Path $QtAppDir "build_qt"
    if (Test-Path $buildDir) { Remove-Item -Path $buildDir -Recurse -Force }
    
    Write-Host "  Running cmake configure..." -ForegroundColor Gray
    & cmake -B build_qt -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="build_qt/install" -DCMAKE_PREFIX_PATH="$qtInstall"
    if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
    
    Write-Host "  Running cmake build..." -ForegroundColor Gray
    & cmake --build build_qt --config Release -j
    if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
    
    Write-Host "  Installing..." -ForegroundColor Gray
    & cmake --install build_qt --config Release
    if ($LASTEXITCODE -ne 0) { throw "cmake install failed" }
    
    Write-Host "  Running windeployqt..." -ForegroundColor Gray
    $windeployqt = Join-Path $qtInstall "bin\windeployqt.exe"
    if (Test-Path $windeployqt) {
        $installBin = Join-Path $buildDir "install\bin"
        & $windeployqt --release --no-translations --dir "$installBin" (Join-Path $installBin "DiskRaptor.exe")
        Write-Host "  windeployqt done" -ForegroundColor Green
    }
}
finally {
    Pop-Location
}

# Verify build
$qtExe = Join-Path $QtAppDir "build_qt\install\bin\DiskRaptor.exe"
if (-not (Test-Path $qtExe)) {
    Write-Host "  ERROR: DiskRaptor.exe not built!" -ForegroundColor Red
    exit 1
}
Write-Host "  Build complete: $qtExe" -ForegroundColor Green

# ── Step 5: Copy to C:\Program Files\DiskRaptor5 ──
Write-Host "[5/5] Copying to $InstallDir ..." -ForegroundColor Yellow

if (Test-Path $InstallDir) {
    Remove-Item -Path "$InstallDir\*" -Recurse -Force -ErrorAction SilentlyContinue
} else {
    New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null
}

$sourceBin = Join-Path $QtAppDir "build_qt\install\bin"
$sourceFrontend = Join-Path $QtAppDir "..\frontend"

# Copy all DLLs, EXEs, and runtime files
Copy-Item -Path "$sourceBin\*" -Destination $InstallDir -Recurse -Force

# Copy frontend files
$frontendDest = Join-Path $InstallDir "frontend"
if (-not (Test-Path $frontendDest)) { New-Item -Path $frontendDest -ItemType Directory -Force | Out-Null }
Copy-Item -Path "$sourceFrontend\*" -Destination $frontendDest -Recurse -Force

# Copy modulesPro if they exist
$modulesSrc = Join-Path $ProjectRoot "modulesPro"
$modulesDest = Join-Path $InstallDir "modulesPro"
if (Test-Path $modulesSrc) {
    New-Item -Path $modulesDest -ItemType Directory -Force | Out-Null
    Copy-Item -Path "$modulesSrc\*" -Destination $modulesDest -Recurse -Force
}

Write-Host ""
Write-Host "=== ✅ DiskRaptor Qt 6 rebuild complete! ===" -ForegroundColor Cyan
Write-Host "Installed to: $InstallDir" -ForegroundColor Green
Write-Host "Binary: $(Join-Path $InstallDir "DiskRaptor.exe")" -ForegroundColor Green
Write-Host "Launcher: $(Join-Path $InstallDir "DiskRaptorLauncher.exe")" -ForegroundColor Green

# Show contents
Write-Host "`nInstallation contents:" -ForegroundColor Cyan
Get-ChildItem $InstallDir | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
