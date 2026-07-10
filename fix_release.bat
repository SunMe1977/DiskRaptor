cd /d C:\dev\DiskRaptor
git add -A
git commit -m "Fix: only copy final installer files, not bundle internals"
git push origin main
gh release delete v0.2.2 --yes
git tag -d v0.2.2
git push origin --delete v0.2.2
git tag v0.2.2
git push origin v0.2.2
echo ALL_DONE
