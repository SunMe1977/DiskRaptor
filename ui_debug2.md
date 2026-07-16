# DiskRaptor UI Debug Report 2

## Root Cause: NSIS installer only copies `index.html`, not the full frontend

**Bug location:** `C:\dev\DiskRaptor\setup.nsi` — Section "DiskRaptor Core" → Frontend block

### Before fix:
```nsis
File "${FRONTEND_DIR}\index.html"
```

Only `index.html` was copied to the install target. All other required frontend assets were missing.

### Effect:
When the installed app loads `index.html` in Qt WebEngine, every `<script>` and `<link>` tag 404s:
- `style.css` → not found → no styling (UI looks scrambled/unstyled)
- `qt-bridge.js` → not found → no Qt WebChannel bridge → no IPC
- `i18n.js`, `iconcache.js`, `virtualscroll.js`, `chunkloader.js` → not found → all JS modules fail
- `treeview.js`, `topfiles.js`, `stats.js`, `diagrams.js`, `splitter.js` → not found → UI components don't render
- `galaxyview/config.js`, `spatial-index.js`, etc. → not found → galaxy view fails

**Result:** Page loads but every script fails. The page is a broken HTML skeleton — "scrambled/broken UI."

### Why local builds work:
The CMake POST_BUILD command correctly copies the entire frontend directory:
```cmake
COMMAND ${CMAKE_COMMAND} -E copy_directory "${CMAKE_SOURCE_DIR}/../frontend" "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend"
```
And the CMake install step correctly preserves all files:
```cmake
install(DIRECTORY ../frontend/ DESTINATION share/${PROJECT_NAME}/frontend)
```

Running from the build output directly works — only the NSIS-packaged installer is broken.

### CI pipeline (`build.yml`):
1. CMake builds and installs to `qt-app/build/install/`
2. `cmake --install` outputs frontend files to `install/share/DiskRaptor/frontend/`
3. NSIS runs from `qt-app/build/`, referencing `install/share/DiskRaptor/frontend/index.html`
4. **NSIS only fetches `index.html`** → rest of frontend is lost

## Findings Summary

| Issue | Severity | File |
|-------|----------|------|
| NSIS only copies `index.html` | **CRITICAL** — breaks all installed releases | `setup.nsi` |
| `diagnostic.html` references non-existent `tauri-api-bridge.js` | **Medium** — diagnostic page broken | `frontend/diagnostic.html` |

## Fixes Applied

### 1. `setup.nsi` — Copy ALL frontend files
Changes:
```
File "${FRONTEND_DIR}\index.html"              # was: only this
File "${FRONTEND_DIR}\style.css"               # NEW
File "${FRONTEND_DIR}\qt-bridge.js"            # NEW
File "${FRONTEND_DIR}\app.js"                  # NEW
File "${FRONTEND_DIR}\chunkloader.js"          # NEW
File "${FRONTEND_DIR}\diagrams.js"             # NEW
File "${FRONTEND_DIR}\galaxyview.js"           # NEW
File "${FRONTEND_DIR}\i18n.js"                 # NEW
File "${FRONTEND_DIR}\iconcache.js"            # NEW
File "${FRONTEND_DIR}\splitter.js"             # NEW
File "${FRONTEND_DIR}\stats.js"                # NEW
File "${FRONTEND_DIR}\topfiles.js"             # NEW
File "${FRONTEND_DIR}\treeview.js"             # NEW
File "${FRONTEND_DIR}\virtualscroll.js"        # NEW
File "${FRONTEND_DIR}\diagnostic.html"         # NEW
File /r "${FRONTEND_DIR}\galaxyview\*.js"      # NEW — galaxyview subdirectory
File /r "${FRONTEND_DIR}\modules\*.js"         # NEW — modules subdirectory
```

### 2. `frontend/diagnostic.html` — Fix script references
Changed `tauri-api-bridge.js` (doesn't exist) to `qt-bridge.js` (the actual WebChannel bridge).

## Frontend files in `frontend/` (17 files + 2 subdirectories):
```
app.js              galaxyview/ (11 files)     qt-bridge.js
chunkloader.js      galaxyview.js              splitter.js
diagnostic.html     i18n.js                    stats.js
diagrams.js         iconcache.js               style.css
                    index.html                 tests.html
                                               topfiles.js
modules/ (2 files)                             treeview.js
                                               virtualscroll.js
```

## Files NOT affected:
- `tests.html` — references files that all exist in `frontend/`; no broken refs
- `index.html` — uses `qt-bridge.js` which exists; no Tauri references
- `qt-bridge.js` — comment mentions `tauri-api-bridge.js` but this is a preservative comment, not a functional reference
