# DiskRaptor Test Results

**Date:** 2026-07-16  
**Environment:** Windows 10.0.26200, Node.js v26.4.0, Playwright v1.61.1  
**Installed EXE:** `C:\Program Files\DiskRaptor5\DiskRaptor.exe`  
**Qt WebEngine:** v0.0.7 (CDP debug enabled)

---

## Test Suite 1: Frontend JS Unit Tests (Mocked)

**Runner:** `scripts/run-tests.mjs` — serves `frontend/tests.html` in headless Playwright  
**Result: ✅ All 58 tests PASSED**

### Test Categories:
| Module | Tests | Status |
|--------|-------|--------|
| VirtualScroll | 6 | ✅ All passed |
| ChunkLoader | 14 | ✅ All passed |
| TreeView | 8 | ✅ All passed |
| TopFilesPanel | 2 | ✅ All passed |
| StatsPanel | 6 | ✅ All passed |
| BrowseButton | 3 | ✅ All passed |
| ScanFlow | 13 | ✅ All passed |
| CamelCase Args | 1 | ✅ All passed |
| Format Helpers | 5 | ✅ All passed |

### Issues Found & Fixed:
- None — all tests passed on first run.

---

## Test Suite 2: E2E Tests Against Installed EXE

**Runner:** `scripts/run-installed-test.mjs` — raw CDP WebSocket (Qt WebEngine)  
**Binary:** `C:\Program Files\DiskRaptor5\DiskRaptor.exe`  
**Result: ✅ All 16 tests PASSED**

### Section 1: Page & UI Tests (6/6 ✅)
| Test | Detail | Status |
|------|--------|--------|
| Page has visible content | 328 chars body, 14,296 HTML | ✅ |
| UI toolbar and controls | 15 buttons (Scan, Browse, etc.), 2 inputs | ✅ |
| Core HTML structure | toolbar, tree-panel, topfiles, stats all present | ✅ |
| JS modules loaded | VirtualScroll, ChunkLoader, TreeView, TopFilesPanel, StatsPanel + Tauri bridge | ✅ |
| Page title is "DiskRaptor" | ✅ |
| Screenshot captured | `01-initial.png` saved | ✅ |

### Section 2: Tauri Bridge / IPC Tests (10/10 ✅)
| Test | Output | Status |
|------|--------|--------|
| list_drives returns drives | 1 drive: `C:/` | ✅ |
| start_scan works | `{"status":"started"}` | ✅ |
| scan shows progress | 5,333 files, 1,127 dirs found | ✅ |
| scan completes | Scan completed in ~1s | ✅ |
| get_scan_result returns stats | Files: 5,333, Dirs: 1,127, Size: 2.12 GB | ✅ |
| get_home_dir returns path | `C:/Users/hansj` | ✅ |
| find_duplicates responds | `[]` (placeholder, no duplicates found in test dir) | ✅ |
| Event system available | `window.__TAURI__.event.listen` is a function | ✅ |
| Final screenshot after tests | `02-after-tests.png` saved | ✅ |
| App still running after tests | Process alive throughout | ✅ |

### Issues Found & Fixed During Testing:
1. **Missing test dependencies:** `playwright` and `ws` npm packages were not installed. Installed them (`npm install playwright ws`).
2. **Environment setup for CDP:** The installed EXE requires `DISKraptor_CDP_PORT` env var for Qt WebEngine remote debugging. Also requires `PATH` to include the runtime DLL directory (`C:\Program Files\DiskRaptor5\runtime`).
3. **Qt bridge response field names:** Scan progress uses snake_case (`is_running`, `files_found`, `dirs_found`). `get_scan_result` nests stats under `result.stats` with fields `total_files`, `total_dirs`, `total_size` (snake_case). Fixed test to handle both naming conventions and nested structure.
4. **Playwright CDP incompatibility:** Qt WebEngine CDP doesn't fully support Playwright's `connectOverCDP()`. Workaround: use raw CDP WebSocket via the `ws` package.

---

## Test Summary

| Suite | Passed | Failed | Total |
|-------|--------|--------|-------|
| Frontend Unit Tests | 58 | 0 | 58 |
| E2E Against Installed EXE | 16 | 0 | 16 |
| **Total** | **74** | **0** | **74** |

**Overall: ✅ ALL TESTS PASSED**

---

## Running Tests (for future reference)

```bash
# Frontend unit tests (headless Playwright, mock backend)
cd C:\dev\DiskRaptor
node scripts/run-tests.mjs

# E2E tests against installed EXE
cd C:\dev\DiskRaptor
node scripts/run-installed-test.mjs

# E2E tests against Qt build (requires env setup)
$env:DISKraptor_BINARY = "C:\Program Files\DiskRaptor5\DiskRaptor.exe"
node scripts/playwright-qt-e2e.mjs   # needs ws package
```
