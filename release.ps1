param()
$VERSION = "0.0.2"
$TAG = "v$VERSION"

Write-Host "=========================================="
Write-Host "  DiskRaptor Release Upload v$VERSION"
Write-Host "=========================================="
Write-Host ""
Write-Host "  Note: Large files may take several minutes to upload."
Write-Host ""

# ── Check gh CLI ──
$gh = Get-Command "gh" -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Host "ERROR: GitHub CLI (gh) not found."
    Write-Host "  Install: winget install GitHub.cli && gh auth login"
    exit 1
}
Write-Host "  gh: $($gh.Source)"

$auth = gh auth status 2>&1 | Select-String "active account" | Select-String "true"
if (-not $auth) {
    Write-Host "ERROR: Not authenticated. Run: gh auth login"
    exit 1
}
Write-Host "  `u{2713} gh CLI authenticated"

# ── Find assets ──
$ASSETS = @()
$zip = "dist/DiskRaptor-$VERSION-win64.zip"
if (Test-Path $zip) { $ASSETS += $zip }
Get-ChildItem "dist/DiskRaptor_*_Setup.exe" -ErrorAction SilentlyContinue | ForEach-Object { $ASSETS += $_.FullName }

# ── Ensure release exists ──
Write-Host ""
Write-Host "  Ensuring release $TAG exists..."
gh release create $TAG --title "DiskRaptor v$VERSION" --notes "" 2>$null | Out-Null

# ── Upload assets ──
Write-Host ""
Write-Host "  Uploading artifacts..."
$count = 0
foreach ($FILE in $ASSETS) {
    if (-not (Test-Path $FILE)) {
        Write-Host "    SKIP (not found): $FILE"
        continue
    }
    $count++
    $NAME = Split-Path $FILE -Leaf
    $SIZE = (Get-Item $FILE).Length / 1MB
    Write-Host "    Uploading: $NAME ($([math]::Round($SIZE, 1)) MB)..."
    $result = gh release upload $TAG "`"$FILE`"" --clobber 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "      `u{2713} Done"
    } else {
        Write-Host "      `u{26A0} Upload failed (exit code: $LASTEXITCODE)"
        Write-Host "      Try manual: gh release upload $TAG `"$FILE`" --clobber"
    }
}

if ($count -eq 0) {
    Write-Host "  No files found in dist/."
    Write-Host "  Make sure you ran: build.cmd"
    Write-Host "  Expected files:"
    Write-Host "    - dist/DiskRaptor-$VERSION-win64.zip"
    Write-Host "    - dist/DiskRaptor_*_Setup.exe"
}

Write-Host ""
Write-Host "=========================================="
Write-Host "  UPLOAD COMPLETE"
Write-Host "=========================================="
Write-Host ""
Write-Host "  View: https://github.com/SunMe1977/DiskRaptor/releases/tag/$TAG"
Write-Host ""
