<p align="center">
  <img src="images/logo6_transparent.webp" alt="DiskRaptor Logo" width="400px">
</p>

# DiskRaptor

**Ultra-fast disk space analyzer** -- A modern, cross-platform successor to WinDirStat / DaisyDisk, built with **Rust + Qt 6 (WebEngine)**.

<p align="center">
  <img src="images/demo.gif" alt="DiskRaptor Demo" style="width:100%;max-width:800px">
</p>

DiskRaptor scans directories using a **parallel jwalk engine** (macOS), **walkdir** (Windows/Linux) and renders results in a **virtual tree view** capable of handling **20+ million files** without UI lag.

---

## Architecture

```
┌──────────────────────────────┐
│  Qt 6 WebEngine (C++/QML)    │ ← Window, menus, native file dialogs
│  ┌────────────────────────┐  │
│  │  WebEngineView         │  │ ← Chromium renderer hosting the UI
│  │  ┌──────────────────┐  │  │
│  │  │  Frontend (JS)    │  │  │ ← DOM-based virtual tree, diagrams,
│  │  │  app.js, scan.js, │  │  │    galaxy 3D view, i18n
│  │  │  diagrams.js, ... │  │  │
│  │  └──────────────────┘  │  │
│  │         ↕ QWebChannel    │  │ ← Bidirectional JSON bridge
│  │  ┌──────────────────┐  │  │
│  │  │  C++ Bridge       │  │  │ ← IpcBridge dispatches commands
│  │  │  (ipcbridge.cpp)  │  │  │    to scanner, file_ops, settings
│  │  └──────────────────┘  │  │
│  └────────────────────────┘  │
│              ↕ FFI (extern C) │ ← C ABI: dr_start_scan, dr_get_progress, ...
│  ┌────────────────────────┐  │
│  │  Rust Scanner DLL      │  │ ← Parallel directory walker
│  │  (diskraptor_scanner)  │  │    compiled as cdylib
│  └────────────────────────┘  │
└──────────────────────────────┘
```

The UI is **pure JavaScript** rendered in Qt WebEngine. Communication with the native layer happens through **QWebChannel** (Qt's built-in IPC) which exposes a `bridge` object with `invoke()` for RPC calls and `eventEmitted` for push events. The Rust scanner is loaded as a dynamic library (`.so`/`.dylib`/`.dll`) at runtime via `QLibrary`. When the Rust library is unavailable, a C++ fallback scanner handles the scan.

---

## Features

### Scanning
- **Parallel jwalk engine** (macOS) -- Multi-threaded directory traversal, 2-6x faster than single-threaded
- **walkdir engine** (Windows/Linux) -- Reliable cross-platform scanning
- **Permission resilience** -- Gracefully handles access-denied folders, logs errors, continues scanning
- **20M node limit** -- Scans entire drives with millions of files
- **Multi-path scan** -- Scan multiple paths sequentially (`path1; path2; path3`)

### Visualization
- **Virtual TreeView** -- Renders only visible DOM nodes, handles 10M+ files
- **Pie Chart + Squarified Treemap + Bar Chart + Galaxy 3D View** -- Top 50 largest files, hover tooltip, click to jump to tree
- **File type icons** -- Emoji icons per file type (images, video, audio, archives, code, etc.)
- **Percentage bars** -- Colored gradient bars per tree row showing size relative to parent
- **File age column** -- Last modification date, sortable

### Interaction
- **Context menus** -- Right-click anywhere (Tree, Top 50, Diagram): Open in Explorer, Open Terminal, Properties, Copy Path, Copy Size, Move to Trash, Jump in Tree, Scan this Folder
- **Keyboard navigation** -- Arrow keys to navigate tree, Enter to open files
- **Drag & drop** -- Drag folders from Finder/Explorer onto the app to scan
- **Resizable panels** -- Drag to resize tree, diagram, detail panel
- **Dark / Light mode** -- Toggle with moon/sun button, persists in settings
- **25 languages** -- Full i18n with auto-detection and language switcher

### Tools
- **Find Duplicates** -- Detect duplicate files by content hash (xxhash3)
- **Trash Recovery** -- Browse, restore, or permanently delete trashed files
- **Empty Folders** -- List empty directories, click to jump to them
- **Find Files** -- Search by filename pattern in scanned results
- **File type filter** -- Show only images, video, audio, archives, or PDFs
- **Export HTML Report** -- Standalone shareable report with stats + chart
- **Export CSV/JSON** -- Export tree data or raw stats
- **Clear Scan** -- Reset all results without reloading

### Cross-Platform
- **macOS** -- Universal binary (x86_64 + arm64), Apple Silicon native
- **Windows** -- NSIS installer, native Windows icons via `SHGetFileInfoW`
- **Linux** -- DEB package (Debian/Ubuntu)

---

## Download

Pre-built binaries are available on the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page.

| Platform | Format |
|----------|--------|
| **macOS** | `.dmg` (signed + notarized) or `.pkg` |
| **Uninstall** | `bash installer/uninstall.sh` (macOS) |
| **Windows** | `.exe` (NSIS Installer) |
| **Linux** | `.deb` (Debian/Ubuntu) |

### Homebrew (macOS & Linux)

Install the cask directly from a local checkout:

```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
brew install --cask ./Casks/diskraptor.rb
```

The cask installs the `.dmg` (macOS) or `.deb` (Linux) from the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page.

---

## Build from Source

### Prerequisites
- **Rust** (latest stable) -- `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Qt 6.5+** with WebEngine module
- **CMake 3.20+** and **Ninja**

### macOS
```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
chmod +x build.sh
./build.sh
```

### Windows
```powershell
build.cmd
```

### Linux
```bash
./build.sh
# Output: dist/DiskRaptor-*.deb
```

### Manual Build (all platforms)
```bash
# 1. Build Rust scanner DLL
cargo build --release --manifest-path src-tauri/Cargo.toml

# 2. Build Qt app
cmake -B qt-app/build -G Ninja -DCMAKE_BUILD_TYPE=Release qt-app
cmake --build qt-app/build --config Release

# 3. Run (or package with build.sh)
./qt-app/build/DiskRaptor
```

---

## Testing

```bash
# Rust unit tests (scanner tree, chunking, file accumulators)
cd src-tauri && cargo test

# JS syntax check
for f in frontend/*.js; do node --check "$f"; done

# Full UI test via CDP (requires Qt WebEngine debug port)
node tests/test_ui.mjs
```

---

## Project Structure

```
├── qt-app/                  # C++ Qt 6 application
│   ├── src/
│   │   ├── commands/        # IPC command handlers (scanner, file_ops, ...)
│   │   ├── ipcbridge.cpp    # QWebChannel bridge dispatcher
│   │   └── webviewwindow    # Main window with WebEngineView
│   └── CMakeLists.txt
├── src-tauri/               # Rust scanner (shared library)
│   ├── src/
│   │   ├── scanner/         # Tree data structures, directory walker
│   │   ├── streaming/       # Tree chunking for UI streaming
│   │   ├── scanner_api.rs   # C FFI surface
│   │   └── lib.rs
│   └── Cargo.toml
├── frontend/                # JS UI rendered in WebEngine
│   ├── app.js               # Main app logic
│   ├── app-modules/         # Scan, drives, settings, tools, export
│   ├── galaxyview/          # 3D galaxy visualization
│   ├── qt-bridge.js         # QWebChannel <-> window.__TAURI__ bridge
│   └── index.html
├── installer/               # Packaging scripts
│   ├── nsis/                # Windows NSIS installer
│   ├── build.sh             # macOS/Linux build + packaging
│   └── build.cmd            # Windows build + packaging
├── test_*.mjs               # UI integration tests (CDP)
└── .github/workflows/       # CI pipelines
```

---

## License

MIT License -- see [LICENSE](LICENSE) for details.
