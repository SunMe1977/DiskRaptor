cd C:\dev\DiskRaptor
git add -A
git commit -m "Fix: only copy final installer files"
git push origin main
gh release delete v0.2.2 --yes 2>nul
git tag -d v0.2.2 2>nul
git push origin --delete v0.2.2 2>nul
git tag v0.2.2
git push origin v0.2.2
echo DONE
