# DiskRaptor UI Diagnostic — Local vs CI Build

**Generated:** 2026-07-16 13:51 UTC+2
**HEAD SHA:** `582cfd6c4a89b171add2ecd5f1ca09c90aa8b5e9`
**Last frontend commit:** `53a03388ca0a0794c859d3d3306aaea7b5a946ef` ("scan flow fixes - scan_id, progress UI, admin startup")

---

## Summary

**Local frontend files and git-tracked frontend files are IDENTICAL.** There are zero differences — no modified files, no untracked files, no deleted files. The UI difference reported between local and CI builds is **not caused by missing/uncommitted frontend files**.

---

## Finding 1: `git status` is completely clean for frontend/

```
git status --short -- frontend/  →  (no output)
```

Every file tracked in git exists on disk in the same state. No files were modified, added, or deleted locally without being staged/committed.

### Files tracked in git (match local exactly)

frontend/app.js
frontend/chunkloader.js
frontend/diagnostic.html
frontend/diagrams.js
frontend/galaxyview.js
frontend/galaxyview/animation.js
frontend/galaxyview/config.js
frontend/galaxyview/data-mapper.js
frontend/galaxyview/effects.js
frontend/galaxyview/insights.js
frontend/galaxyview/interaction.js
frontend/galaxyview/lod.js
frontend/galaxyview/live-scan.js
frontend/galaxyview/plugin-api.js
frontend/galaxyview/spatial-index.js
frontend/galaxyview/timeline.js
frontend/i18n.js
frontend/iconcache.js
frontend/index.html
frontend/modules/emptyfolders.js
frontend/modules/recentchanges.js
frontend/qt-bridge.js
frontend/splitter.js
frontend/stats.js
frontend/style.css
frontend/tests.html
frontend/topfiles.js
frontend/treeview.js
frontend/virtualscroll.js

**No untracked files exist in `frontend/`.**

---

## Finding 2: `frontend/tauri-api-bridge.js` was deleted from git but still referenced in HTML

### File status
- **Deleted from git** in commit `53a0338` (`D	frontend/tauri-api-bridge.js`)
- **Does NOT exist locally** (`Test-Path` returned `False`)
- **Not in git** (`git ls-files frontend/tauri-api-bridge.js` → no output)

### Referenced in 2 HTML files

**`frontend/index.html` line 259:**
```html
<script src="tauri-api-bridge.js"></script>
```

**`frontend/diagnostic.html` line 28:**
```html
<script src="tauri-api-bridge.js"></script>
```

### Impact

Both local and CI builds will get a **404** for these script references. In a Qt WebEngine context:

1. `index.html` load order:
   ```
   line 258: <script src="qrc:///qtwebchannel/qwebchannel.js"></script>   ← OK (Qt built-in)
   line 259: <script src="tauri-api-bridge.js"></script>                   ← 404
   line 260: <script src="qt-bridge.js"></script>                          ← loads after 404
   line 270+: <script src="app.js"></script>                               ← loads after 404
   ```

2. The 404 is **non-fatal in standard browsers** — subsequent scripts still load. However, if the Qt WebEngine's Chromium treats script-load failures as fatal (depending on CSP/error handling), **`qt-bridge.js` and `app.js` may not execute**, causing the entire app to fail.

3. The `qt-bridge.js` file (line 201) has a comment: `// Preserve existing properties (like invoke from tauri-api-bridge.js)` — indicating the two bridges were designed to coexist. With `tauri-api-bridge.js` gone, `qt-bridge.js` must provide full functionality alone, which it does.

---

## Finding 3: `frontend/style.css` has encoding artifacts

The file header contains Unicode-rendering artifacts:
```
/* ?????????????????...
   DiskRaptor ? Modern Dark/Light UI
```

The `?` characters replace original Unicode/emoji characters. This exists in both git and local copies (matched), so it doesn't explain a local-vs-CI difference, but may affect rendering in environments that handle encoding differently.

---

## Finding 4: How the build copies frontend files

From `qt-app/CMakeLists.txt`:
```cmake
# Copy frontend + modules after build
add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CMAKE_SOURCE_DIR}/../frontend"
    "$<TARGET_FILE_DIR:${PROJECT_NAME}>/frontend")
```

The Qt build copies the **entire** local `frontend/` directory into the build output. CI does a clean `git checkout` first, so CI build output reflects only git-tracked files. Since local and git match, the copied output is identical.

---

## Finding 5: No commits after `53a0338` touched frontend/

```
HEAD:  582cfd6 restore setup.nsi - NSIS installer script was missing
       97b1de5 fix: restore setup.nsi deleted in scan flow commit
       53a0338 scan flow fixes - scan_id, progress UI, admin startup   ← last frontend change
```

The two commits after `53a0338` only restore `setup.nsi` (NSIS installer script). No frontend files were modified.

---

## Root Cause Analysis

### The primary bug: Orphaned script reference
Commit `53a0338` removed `frontend/tauri-api-bridge.js` from the repository **but did not remove the `<script>` tags referencing it** from `frontend/index.html` (line 259) and `frontend/diagnostic.html` (line 28).

This causes a 404 that may affect script execution order, especially in production Qt WebEngine builds where resource loading can be stricter than a local dev environment.

### UI difference — likely explanations

Since frontend files are identical locally and in git, the UI difference is **not caused by diverging frontend file sets**. Possible causes:

1. **Script 404 breaks execution chain** — If Qt WebEngine in release mode treats the 404 as fatal, the app fails silently vs. running in dev mode where it's ignored.

2. **Build artifact differences** — CI might use a different Qt/WebEngine version or build configuration that handles missing resources differently.

3. **Cached dev build vs fresh CI build** — The user may be running a locally-cached older binary that still has `tauri-api-bridge.js`, while the CI build is fresh without it.

### Recommended fixes

1. **Remove or restore** — Either restore `frontend/tauri-api-bridge.js` (revert the deletion) OR remove the `<script src="tauri-api-bridge.js">` lines from:
   - `frontend/index.html` line 259
   - `frontend/diagnostic.html` line 28

2. **Verify `qt-bridge.js` provides full coverage** — Confirm that `qt-bridge.js` handles all IPC calls previously provided by `tauri-api-bridge.js` (`invoke`, `dialog.open`, etc.).

3. **Check `style.css` encoding** — The Unicode/emoji characters in the CSS comment header may not render correctly. Consider using ASCII-only comments or checking file encoding (UTF-8 without BOM).
