# PowerShell script to fix and retag DiskRaptor v0.2.2
cd C:\dev\DiskRaptor

Write-Host "=== Step 1: Status ==="
git status

Write-Host "=== Step 2: Commit ==="
git add -A
git commit -m "Fix: only copy final installer files, not bundle internals"

Write-Host "=== Step 3: Push ==="
git push origin main

Write-Host "=== Step 4: Retag v0.2.2 ==="
gh release delete v0.2.2 --yes 2>$null
git tag -d v0.2.2 2>$null
git push origin --delete v0.2.2 2>$null
git tag v0.2.2
git push origin v0.2.2

Write-Host "=== Step 5: Check CI ==="
gh run list --branch v0.2.2 --limit 1 --json name,status,conclusion,databaseId,createdAt

Write-Host "=== Done ==="
