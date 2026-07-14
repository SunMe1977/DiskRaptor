@echo off
cd /d C:\dev\DiskRaptor

echo === Current branch ===
git branch --show-current

echo === Creating PR branch ===
git checkout -b release-v0.3.22-e2e-tests

echo === Adding files ===
git add .github/workflows/build.yml
git add frontend/qt-bridge.js
git add qt-app/src/main.cpp
git add qt-app/src/webviewwindow.cpp
git add qt-app/src/webviewwindow.h
git add scripts/playwright-qt-e2e.mjs
git add scripts/deploy-and-test.ps1
git add scripts/deploy-fix.ps1
git add qt-app/resources/windows/app.rc.in
git add qt-app/resources/windows/launcher.rc.in

echo === Committing ===
git commit -m "feat: add E2E tests + native menus + bridge fix for CI release pipeline

Changes:
- Qt bridge: queue invoke() calls until bridge is ready (fixes 'Bridge not ready' race)
- Native menus: QMenuBar with View (Pie/Treemap), Tools (Duplicates), Help (About/Updates)
- Browser context menu disabled (Qt::NoContextMenu)
- CDP debugging via DISKraptor_CDP_PORT env var for Playwright
- Playwright E2E test suite for Qt WebEngine build
- CI workflow: build -> e2e-test -> release pipeline with precommit checks
- Deploy scripts for local testing"

echo === Pushing ===
git push origin release-v0.3.22-e2e-tests

echo === Done ===
echo Open PR at: https://github.com/SunMe1977/DiskRaptor/pull/new/release-v0.3.22-e2e-tests
