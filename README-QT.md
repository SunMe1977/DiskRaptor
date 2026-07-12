# DiskRaptor — Qt 6 + QtWebEngine Port

## Architecture

After migrating from Tauri (Rust + WebKitGTK/WebView2) to **Qt 6 + QtWebEngine**:

| Component | Before (Tauri) | After (Qt 6) |
|-----------|---------------|--------------|
| **UI Framework** | Tauri v1.8 (Rust) | Qt 6.5+ (C++17) |
| **WebView** | WebView2 (Win) / WebKitGTK (Linux) | **QtWebEngine** (Chromium) |
| **IPC Bridge** | Tauri IPC (Rust → JS) | **QWebChannel** (C++ ↔ JS) |
| **Renderer** | Platform WebView | Chromium 120+ (GPU accelerated) |
| **Dependencies** | Rust, WebKitGTK, GLib, GObject | **None** (Qt is self-contained) |
| **Sandbox** | OS WebView sandbox | Chromium sandbox |

## Directory Structure

```
qt-app/
├── CMakeLists.txt          # Build system (cross-platform)
├── cmake/                  # CMake modules
├── resources/
│   ├── resources.qrc       # Qt resource file
│   └── icons/              # Application icons
└── src/
    ├── main.cpp            # Entry point
    ├── webviewwindow.h/cpp # Main window + QWebEngineView
    ├── ipcbridge.h/cpp     # IPC bridge (replaces Tauri)
    ├── scanner.h/cpp       # Directory scanner (C++17)
    └── platform_utils.h/cpp # OS-specific utilities

frontend/
├── index.html              # Galaxy UI (unchanged)
├── qt-bridge.js            # QWebChannel bridge (replaces tauri-api-bridge.js)
├── style.css               # (unchanged)
├── app.js                  # (unchanged)
└── ...                     # (all existing frontend files)
```

## Prerequisites

### Linux (Ubuntu 24.04)
```bash
sudo apt install build-essential cmake ninja-build \
  qt6-base-dev qt6-webengine-dev qt6-webchannel-dev \
  libqt6webenginewidgets6 qt6-webengine-dev-tools
```

### Windows (Visual Studio 2022)
1. Install [Qt 6.5+](https://www.qt.io/download-qt-installer) with:
   - Qt WebEngine
   - Qt WebChannel
   - MSVC 2022 64-bit
2. Install [CMake 3.20+](https://cmake.org/download/)
3. Install [Ninja](https://ninja-build.org/)
4. Install [Visual Studio 2022](https://visualstudio.microsoft.com/) with "Desktop development with C++"

## Build

### Linux
```bash
bash build-qt.sh release
./qt-app/build/install/bin/DiskRaptor
```

### Windows
```batch
build-qt.bat release
qt-app\build\install\bin\DiskRaptor.exe
```

## No GTK/WebKitGTK/GLib

This port contains **zero** dependencies on:
- `libgtk-3` / `libgtk-4`
- `libwebkit2gtk-4.0` / `libwebkit2gtk-4.1`
- `libglib` / `libgobject`
- `librsvg`
- `libsoup`
- `libayatana-appindicator`

The only UI dependency is **Qt 6** with `QtWebEngine` (Chromium-based).

## Frontend Compatibility

The existing frontend (`frontend/`) works **unchanged**. The `qt-bridge.js` file provides the same `window.__TAURI__` API that the frontend expects, routing calls through `QWebChannel` to C++.

No modifications needed to:
- `app.js`
- `style.css`
- `index.html` (except adding the bridge script)
- Any other frontend files

## Key Improvements

1. **Chromium-based WebView** — GPU accelerated, modern JS engine
2. **No OS-specific WebView** — Same Chromium on all platforms
3. **Stable Sandbox** — Chromium's built-in sandbox
4. **Single binary** — Statically linked on Linux, DLLs on Windows
5. **C++17 filesystem** — Fast directory traversal without Rust
