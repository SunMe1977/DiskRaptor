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

# ── Delete old release ──
Write-Host ""
Write-Host "  Deleting old release $TAG (if any)..."
gh release delete $TAG --yes 2>$null | Out-Null

# ── Create fresh release (auto-creates tag) ──
Write-Host ""
Write-Host "  Creating release $TAG..."
gh release create $TAG --title "DiskRaptor v$VERSION" --notes "" 2>$null | Out-Null

# ── Get upload URL ──
Write-Host ""
Write-Host "  Getting upload URL..."
$uploadUrl = gh release view $TAG --json "uploadUrl" --jq ".uploadUrl"
$uploadUrl = $uploadUrl -replace '\{.*', ''
if (-not $uploadUrl) {
    Write-Host "  ERROR: Could not get upload URL for release $TAG"
    exit 1
}

# ── Get token ──
$token = $env:GH_TOKEN
if (-not $token) { $token = $env:GITHUB_TOKEN }
if (-not $token) {
    $token = gh auth token 2>$null
}
if (-not $token) {
    Write-Host "  WARNING: No token found. Set GH_TOKEN or GITHUB_TOKEN env var."
    Write-Host "  Will try gh CLI for upload (may hang)..."
}

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
    if ($token) {
        Write-Host "    (using curl)"
        $result = curl.exe -L -X POST "${uploadUrl}?name=$NAME" `
            -H "Authorization: token $token" `
            -H "Content-Type: application/octet-stream" `
            --data-binary "@`"$FILE`"" --connect-timeout 30 --max-time 600 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "      `u{2713} Done"
        } else {
            Write-Host "      `u{26A0} curl upload failed"
        }
    } else {
        Write-Host "    (using gh — set GH_TOKEN for curl instead)"
        $result = gh release upload $TAG "`"$FILE`"" --clobber 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "      `u{2713} Done"
        } else {
            Write-Host "      `u{26A0} gh upload failed"
        }
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
