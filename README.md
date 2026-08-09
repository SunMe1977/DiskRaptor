<p align="center">
  <img src="images/logo6_transparent.webp" alt="DiskRaptor Logo" width="400px">
</p>

<p align="center">
  <a href="https://www.diskraptor.com"><img src="https://img.shields.io/badge/Website-diskraptor.com-2ea043?style=for-the-badge" alt="DiskRaptor Website"></a>
  <a href="https://github.com/SunMe1977/DiskRaptor/releases"><img src="https://img.shields.io/github/v/release/SunMe1977/DiskRaptor?style=for-the-badge" alt="Latest Release"></a>
  <a href="https://github.com/SunMe1977/DiskRaptor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/SunMe1977/DiskRaptor?style=for-the-badge" alt="License"></a>
</p>

# DiskRaptor

**Ultra-fast disk space analyzer** -- A modern, cross-platform successor to WinDirStat / DaisyDisk, built with **Rust + Tauri 2**.

Visit the official website: **[https://www.diskraptor.com](https://www.diskraptor.com)** — documentation, screenshots and download links.

<p align="center">
  <img src="images/demo.gif" alt="DiskRaptor Demo" style="width:100%;max-width:800px">
</p>

DiskRaptor scans directories using a **parallel jwalk engine** (macOS), **walkdir** (Windows/Linux) and renders results in a **virtual tree view** capable of handling **20+ million files** without UI lag.

---

## Architecture

```
┌──────────────────────────────┐
│  Tauri 2 (Rust)              │ ← Window, menus, native dialogs, IPC
│  ┌────────────────────────┐  │
│  │  System WebView        │  │ ← WKWebView (macOS) / WebView2 (Win) /
│  │  (frontend/index.html) │  │    WebKitGTK (Linux)
│  │  ┌──────────────────┐  │  │
│  │  │  Frontend (JS)    │  │  │ ← DOM-based virtual tree, diagrams,
│  │  │  app.js, scan.js, │  │  │    galaxy 3D view, i18n
│  │  │  diagrams.js, ... │  │  │
│  │  └──────────────────┘  │  │
│  │         ↕ tauri invoke  │  │ ← JSON IPC (Rust commands)
│  │  ┌──────────────────┐  │  │
│  │  │  Rust Commands    │  │  │ ← scan, file_ops, settings, trash,
│  │  │  (main.rs)        │  │  │    SMART, browser cleanup
│  │  └──────────────────┘  │  │
│  └────────────────────────┘  │
│              ↕ crate         │
│  ┌────────────────────────┐  │
│  │  diskraptor_scanner     │  │ ← Parallel directory walker (Rust)
│  └────────────────────────┘  │
└──────────────────────────────┘
```

The UI is **pure JavaScript** rendered in the system webview (no bundled Chromium — Tauri uses the OS webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Communication with the native layer uses **Tauri's IPC** (`window.__TAURI__.invoke`). The scanner is a Rust crate (`diskraptor_scanner`).

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

Pre-built binaries are available on the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page, or grab the latest version directly from the official website: **[https://www.diskraptor.com](https://www.diskraptor.com)**.

| Platform | Format |
|----------|--------|
| **macOS** | `.dmg` (signed + notarized) or `.pkg` |
| **Uninstall** | `bash installer/uninstall.sh` (macOS) |
| **Windows** | `.exe` (NSIS Installer) |
| **Linux** | `.deb` (Debian/Ubuntu) |
| **Website** | [www.diskraptor.com](https://www.diskraptor.com) |

### Homebrew (macOS & Linux)

Install the cask directly from a local checkout:

```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
brew install --cask ./homebrew/Casks/diskraptor.rb
```

The cask installs the `.dmg` (macOS) or `.deb` (Linux) from the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page. You can also download pre-built installers from the official website: [www.diskraptor.com](https://www.diskraptor.com).

To install as `brew install diskraptor` (no tap, no path), the cask must first be merged into the official [homebrew/homebrew-cask](https://github.com/Homebrew/homebrew-cask) repository (macOS only) — submit a PR against `Casks/d/diskraptor.rb` once the macOS `.dmg` with a fixed SHA256 is published. Linux has no official cask repo.

---

## Build from Source

### Prerequisites
- **Rust** (latest stable) -- `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js** 18+ (for the Tauri CLI)
- Linux: **WebKitGTK 4.1** (`sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev`)

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
# Build the Tauri app
cd src-tauri
cargo build --release
cd ..

# Build the Windows installer (NSIS)
npx tauri build --bundles nsis --ci
```

---

## Testing

```bash
# Rust unit tests (scanner tree, chunking, file accumulators)
cd src-tauri && cargo test

# JS syntax check
for f in frontend/*.js; do node --check "$f"; done

# Full UI test via CDP (requires the app built with the `test-server` feature)
node tests/test_ui.mjs
```

---

## Project Structure

```
├── src-tauri/               # Rust scanner + Tauri commands
│   ├── src/
│   │   ├── scanner/         # Tree data structures, directory walker, duplicates
│   │   ├── streaming/       # Tree chunking for UI streaming
│   │   ├── menu.rs          # Native menu builder
│   │   ├── smart.rs         # S.M.A.R.T. disk health (native APIs)
│   │   ├── trash.rs         # Trash listing / restore / empty
│   │   ├── browser.rs       # Browser cache / cookie cleanup
│   │   └── main.rs          # Tauri command layer
│   └── Cargo.toml
├── frontend/                # JS UI rendered in the system WebView
│   ├── app.js               # Main app logic
│   ├── app-modules/         # Scan, drives, settings, tools, export
│   ├── galaxyview/          # 3D galaxy visualization
│   ├── format.js            # Shared human-readable size formatting
│   └── index.html
├── installer/               # Packaging scripts
│   ├── nsis/                # Windows NSIS installer
│   ├── build.sh             # macOS/Linux build + packaging
│   └── build.cmd            # Windows build + packaging
├── homebrew/               # Homebrew cask (macOS + Linux)
│   └── Casks/diskraptor.rb
├── test_*.mjs               # UI integration tests (CDP)
└── .github/workflows/       # CI pipelines
```

---

## License

MIT License -- see [LICENSE](LICENSE) for details.

---

<p align="center">
  <a href="https://www.diskraptor.com">www.diskraptor.com</a> &nbsp;·&nbsp;
  <a href="https://github.com/SunMe1977/DiskRaptor">GitHub</a> &nbsp;·&nbsp;
  <a href="https://github.com/SunMe1977/DiskRaptor/releases">Releases</a>
</p>
