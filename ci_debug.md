# DiskRaptor CI Debug — v0.0.9 Failure Analysis

## Summary

The v0.0.9 CI run (ID: 29488936109) failed in the **"Build NSIS Installer"** step of the `build-app` job.

## Root Cause

Commit `53a0338` ("scan flow fixes - scan_id, progress UI, admin startup") **deleted `setup.nsi`** from the repo root. The CI workflow at `.github/workflows/build.yml` expects this file to build the Windows NSIS installer.

### Evidence

- `git diff --name-status HEAD~1..HEAD -- setup.nsi` → `D  setup.nsi`
- GitHub Actions job 87590059309: step 12 "Build NSIS Installer" → **failure**
- All prior steps (Qt install, CMake, build, UPX, NSIS install) succeeded
- The workflow runs: `cd qt-app\build && copy /y "..\..\setup.nsi" .` — this copies `setup.nsi` from the repo root into the build directory for makensis

## Other Files Checked

| File | Exists | Needed? |
|------|--------|---------|
| `setup.nsi` | ❌ → ✅ Restored | Yes — NSIS installer |
| `images/icon.ico` | ✅ | Yes — NSIS installer icon |
| `qt-app/CMakeLists.txt` | ✅ | Yes — CMake build |
| `Cargo.toml` | ❌ (not a Rust project) | No — Qt-based |
| `Dockerfile.linux` | ❌ | No — Linux build disabled (`if: false`) |
| `.cargo/config.toml` | ❌ | No |
| `build-appimage.sh` | ❌ | No — Linux build disabled |

## Fix Applied

1. **Restored `setup.nsi`** from git history (`git show 298dcf4:setup.nsi`)
2. **Staged** `setup.nsi` for commit
3. Commit message: "fix: restore setup.nsi deleted in scan flow commit, fixes CI NSIS installer build"

## Verification

- `setup.nsi` references `..\..\images\icon.ico` (relative from `qt-app/build/`) — ✅ points to repo root
- CI passes `/DVERSION=` and `/DMUI_ICON=` overrides — ✅
- The NSIS script handles version substitution (`!ifdef VERSION`) — ✅
- All other CI artifacts (exe, launcher, runtime zip) should be generated successfully with this fix

## Future Prevention

- Add a pre-commit hook or CI check that verifies `setup.nsi` exists before tagging
- Consider adding an explicit check in the NSIS step to give a clearer error message if `setup.nsi` is missing
