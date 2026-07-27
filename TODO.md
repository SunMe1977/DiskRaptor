# DiskRaptor — Improvements Log

## Phase 1 — Completed (`1a1a876`)

- [x] **Version consistency** — All files standardized to `1.0.0`
- [x] **`var` → `let`/`const`** — 0 `var` remaining across 35 JS files
- [x] **CSP** — Content-Security-Policy meta tag added to `index.html`
- [x] **Toast system** — `frontend/toast.js` replaces 7 `alert()` calls
- [x] **Hidden file consistency** — macOS no longer skips dotfiles
- [x] **xxhash3 dedup** — Weak custom hash → `xxhash_rust::xxh3::xxh3_64`
- [x] **Build paths parameterized** — `build.cmd` uses 6 env var overrides
- [x] **Unit tests** — 3 Rust integration tests in `src-tauri/tests/`
- [x] **Linux frontend paths** — 7 additional FHS search paths in `main.cpp`
- [x] **Inline styles → CSS** — 19 utility classes (`.overlay-base`, `.btn-primary`, etc.)
- [x] **Split `app.js`** — 1972 → 703 lines, 7 modules in `frontend/app-modules/`

## Phase 2 — Completed (`c9bbb95`)

- [x] **`LocalContentCanAccessRemoteUrls` disabled** — Security hardening
- [x] **Remove C++ duplicate scanner** — Rust impl is now the only one
- [x] **Split `ipcbridge.cpp`** — 1367 → 87 lines, 4 handler modules in `qt-app/src/commands/`
- [x] **Dynamic arena sizing** — `with_estimated_capacity(path)` replaces magic numbers
- [x] **`build.sh` parameterized** — 7 env var overrides for macOS/Linux build
- [x] **`vcpkg.json`** — Qt6 dependency pinning
- [x] **Defer galaxy scripts** — 11 `<script>` tags moved from `<head>` to `</body>`
- [x] **JSDoc annotations** — Added to `toast.js`, `chunkloader.js`, `treeview.js`

## Potential Future Work

- [ ] TypeScript migration (or at least strict JSDoc across all modules)
- [ ] Event-driven progress (replace 30-min busy-polling loop)
- [ ] Lazy-load Galaxy view via dynamic `import()`
- [ ] Remove hardcoded version/branding from welcome page (star/fork appeal)
- [ ] Add C++ unit tests (Qt Test framework)
- [ ] macOS: automatically detect Qt path instead of hardcoded `/usr/local/opt/qt`
- [ ] Flatpak/AppImage packaging for Linux
- [ ] CI: add `cargo test` and `node --check` to GitHub Actions
