# Hybrid WKWebView Migration Plan

**Goal:** Replace QtWebEngine (QWebEngineView + QWebChannel) with macOS native WKWebView, keeping QtCore/QtWidgets for windowing, menus, tray, settings, and command handlers.

**Why Hybrid (not full Tauri):** 3-5 days vs 2-4 weeks. Eliminates all Chromium private APIs without rewriting the entire native layer. JS frontend, command handlers, Rust scanner, and Pro modules stay unchanged.

---

## Phase 1 — WKWebView Wrapper Widget

**Files to create:**
- `qt-app/src/wkwebview_wrapper.h` — WKWebViewWrapper class (QWidget subclass)
- `qt-app/src/wkwebview_wrapper.mm` — Objective-C++ implementation

**What it does:**
- Embeds a WKWebView as a native NSView child of the QWidget
- Exposes `loadURL()`, `evaluateJS()`, and a message handler registration API
- Handles IPC via `WKScriptMessageHandler` instead of QWebChannel
- Fires a callback when page load completes

**Status:** ⬜

---

## Phase 2 — Update MainWindow

**Files to modify:**
- `qt-app/src/webviewwindow.h` — Replace `WebView : QWebEngineView` with `WKWebViewWrapper`, remove `QWebChannel`, `QWebEnginePage`, `QWebEngineView` includes
- `qt-app/src/webviewwindow.cpp` — Replace `setupWebEngine()` with `setupWebView()`, update `runJS()` to use WKWebViewWrapper, keep all menus/tray/statusbar unchanged

**What changes:**
- `m_webView` type changes from `WebView*` to `WKWebViewWrapper*`
- `m_webChannel` removed (no longer needed)
- `setupWebEngine()` simplified to `setupWebView()`
- `runJS()` delegates to `m_webView->evaluateJS()`
- All menu actions, tray icon, status bar stay identical
- `setupTrayIcon()` unchanged

**Status:** ⬜

---

## Phase 3 — Simplify main.cpp

**Files to modify:**
- `qt-app/src/main.cpp`

**Changes:**
- Remove `#include <QtWebEngineWidgets/...>`, `#include <QWebEngineSettings>`, `#include <QWebEngineProfile>`
- Remove all `QWebEngineProfile` / `QWebEngineSettings` init block
- Remove macOS Chromium flag workaround (`QTWEBENGINE_CHROMIUM_FLAGS`)
- Keep: `QApplication`, app metadata, icon loading, frontend search, admin check
- Remove `QTWEBENGINE_REMOTE_DEBUGGING` env var (CDP is WebEngine-specific)

**Status:** ⬜

---

## Phase 4 — Update CMakeLists.txt

**Files to modify:**
- `qt-app/CMakeLists.txt`

**Changes:**
- Remove `Qt6::WebEngineWidgets` and `Qt6::WebChannel` from `find_package` and `target_link_libraries`
- Add `find_library(WebKit)` for `WebKit.framework` and `WebKitWidgets.framework` (macOS only)
- Add `.mm` files to sources for Objective-C++ compilation
- Set `LANGUAGE` property for `.mm` files to `CXX` (they're Objective-C++)
- Simplify Windows/Linux build (no WebEngine alternative needed for now)

**Status:** ⬜

---

## Phase 5 — Update JS Bridge

**Files to modify:**
- `frontend/qt-bridge.js`

**Changes:**
- Replace QWebChannel init with WKWebView message handler init
- New init: check for `window.webkit.messageHandlers.bridge`
- IPC flow: `postMessage({id, cmd, args})` → native handles → callback via `evaluateJavaScript`
- Event flow: native calls `window.__TAURI__.events.dispatchEvent({type, detail})` via `evaluateJavaScript`
- Keep Tauri fallback (same as before)
- Keep pending invoke queue (same as before)

**Status:** ⬜

---

## Phase 6 — Update build.sh

**Files to modify:**
- `build.sh`

**Changes:**
- Remove `-appstore-compliant` flag from macdeployqt (not needed without WebEngine)
- Remove unused framework stripping for WebEngine-specific frameworks
- Remove QtSvg bundling (no longer needed without WebEngine plugins)
- Simplify Qt framework deployment (only Core, Gui, Widgets, Network needed)
- Possibly switch to `macdeployqt -no-plugins` (fewer plugins needed)

**Status:** ⬜

---

## Phase 7 — Update vcpkg.json

**Files to modify:**
- `vcpkg.json`

**Changes:**
- Remove `qt6-webengine` dependency
- Remove `qt6-websockets` (if no longer needed)
- Keep only `qt6` (Core, Gui, Widgets, Network)

**Status:** ⬜

---

## Phase 8 — Test & Verify

- Build and run the app on macOS
- Verify all JS frontend features work (scan, browse, delete, galaxy view, etc.)
- Verify menus, tray icon, status bar work
- Verify no private API references in the bundle:
  ```
  nm -m DiskRaptor.app/Contents/MacOS/DiskRaptor | grep -E "_SQL|_CG|_sandbox|CAContext|CALayerHost|NSAccessibility|NSNextStep|NSThemeFrame|_AudioDeviceDuck|_SetApplicationIsDaemon|__CFCopySystemVersion|__LSSetApplication|__NS.*KillRing|_responsibility|_IOBluetooth"
  ```
- Verify app launches and scanner (Rust + C++ fallback) works

**Status:** ⬜

---

## Phase 9 — Mac App Store Build

- Build with `./build.sh`
- Create MAS PKG
- Submit to App Store Connect
- If rejected, the remaining Qt modules (Core, Gui, Widgets) are MAS-compatible with `-appstore-compliant`

**Status:** ⬜
