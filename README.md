<p align="center">
  <img src="images/logo6_transparent.webp" alt="DiskRaptor Logo" width="400px">
</p>

# 🦖 DiskRaptor

**Ultra-fast directory scanner** — A modern, high-performance successor to JDiskReport, built with **Rust + Qt 6 + QtWebEngine**.

<p align="center">
  <img src="images/demo.gif" alt="DiskRaptor Demo" style="width:100%;max-width:800px">
</p>

DiskRaptor scans directories using a **parallel Win32 traversal engine** (Windows) or **walkdir** (macOS/Linux) and renders results in a **virtual tree view** capable of handling **20+ million files** without UI lag.

---

## ⚡ Features

### Scanning
- **Parallel Win32 engine** — 4–8 worker threads for 2–6× faster scanning
- **Exact file counts** — Follows NTFS junctions (reparse points), matches `dir /s`
- **Long path support** — `\\?\` prefix for paths >260 characters
- **Permission resilience** — Gracefully handles access-denied folders, logs errors, continues scanning
- **20M node limit** — Scans entire drives with millions of files

### Visualization
- **Virtual TreeView** — Renders only 50–200 visible DOM nodes, handles 10M+ files
- **Pie Chart + Squarified Treemap** — Top 50 largest files, hover tooltip, click menu
- **Live progress** — Files found, current directory, elapsed time
- **Real Windows icons** — Native shell icons via `SHGetFileInfoW`

### Interaction
- **Context menus** — Right-click anywhere (Tree, Top 50, Diagram): Open in Explorer, Open Terminal, Properties, Copy Path, Delete, Jump in Tree
- **Resizable splitters** — Drag to resize tree, diagram, detail panel, and top 50 section
- **Dark / Light mode** — Toggle with ☾/☀ button, persists in `localStorage`
- **System tray** — Icon with Open and Quit

### Data
- **Live statistics** — Files, directories, total size, scan time
- **Top 50 files** — Largest files with file-type badges (ISO, VHDX, ZIP, EXE, PDF…)
- **JSON export** — Full scan results as JSON
- **Chunk streaming** — 10k-node chunks for instant UI responsiveness

---

## 🔧 Backend (Rust)

| Module | Purpose |
|--------|---------|
| Module | Purpose |
|--------|---------|
| `scanner/tree.rs` | Arena-allocated `TreeNode` (~56 bytes/node) |
| `scanner/walker.rs` | Parallel Win32 scanner + walkdir fallback |
| `scanner/win32_scanner.rs` | Standalone Win32 scanner |
| `streaming/chunker.rs` | BFS chunk splitting (10k nodes/chunk) |
| `scanner_api.rs` | C FFI bridge for Qt integration |

### Key Technical Decisions

- **Two-phase parallel scan**: Phase 1 = N worker threads scan directories independently. Phase 2 = single-threaded tree building from collected entries. No arena locking during scan.
- **Squarified treemap**: Recursive subdivision algorithm — full area fill, no gaps, professional look.
- **Native Windows icons**: Extracted via `SHGetFileInfoW` + raw GDI (`CreateDIBSection` + `DrawIconEx`), returned as base64 RGBA to frontend.
- **Qt WebChannel IPC**: Rust scanner loaded as DLL via `QLibrary`, JSON bridge to JavaScript frontend.


---

## 🎨 Frontend (JavaScript)

| Module | Purpose |
|--------|---------|
| `virtualscroll.js` | DOM recycling engine (only 50–200 rows rendered) |
| `chunkloader.js` | Chunked data loading with parallel batch fetching |
| `treeview.js` | Expand/collapse tree, jump-to-path from diagram |
| `diagrams.js` | Pie chart + squarified treemap with hit regions |
| `stats.js` | Statistics panel |
| `topfiles.js` | Largest files table with file-type badges |
| `iconcache.js` | Real Windows shell icons via C++ bridge |
| `splitter.js` | 3 resizable splitters (vertical, horizontal x2) |
| `app.js` | Main controller, scan flow, theme toggle |
| `qt-bridge.js` | Qt WebChannel IPC bridge |

---

## 🚀 Getting Started

### Prerequisites

- Rust ≥ 1.70
- Qt 6.10+ (WebEngine, WebChannel, Widgets)
- CMake ≥ 3.20 + Ninja
- Visual Studio 2022 Build Tools (Windows) or Xcode (macOS)

### Quick Start (Windows)

```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
build.cmd
# Binary: dist/DiskRaptor.exe
```

### Quick Start (macOS/Linux)

```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
chmod +x build.sh
./build.sh
# Binary: dist/DiskRaptor  (Linux) or dist/DiskRaptor.app (macOS)
```

### NSIS Installer (Windows)

```bash
# Install NSIS from https://nsis.sourceforge.io
build.cmd  # builds EXE + runs makensis automatically
# Installer: installer/nsis/DiskRaptor_*_Setup.exe
```

---

## 🧪 Running Tests

```bash
# Rust tests
cd src-tauri && cargo test -- --nocapture

# UI test with Playwright (requires running EXE with CDP port)
node test_scan.mjs
```

---

## ⚡ Performance

| Metric | Value | Details |
|--------|-------|---------|
| Scan speed | ~12M files in 3 min | `C:\Users\hansj` on NVMe SSD (100k dirs) |
| Parallel workers | 4–8 threads | Auto-detected from CPU cores |
| Max nodes | 30,000,000+ | Arena-allocated, auto-grows |
| Memory per node | ~56 bytes | Arena-allocated `Vec<TreeNode>` |
| UI nodes rendered | 50–200 | VirtualScroll with DOM recycling |
| Chunk size | 10,000 nodes | ~1–2 MB JSON per chunk |
| Arena capacity | 2,000,000 (initial) | Auto-grows as needed |

---

## 🖱️ Interaction Reference

| Action | TreeView | Top 50 Files | Diagram |
|--------|----------|-------------|---------|
| Left click | Select node | — | Context menu |
| Right click | Context menu | Context menu | Context menu |
| Hover | Highlight + accent | Highlight | Tooltip + slice highlight |
| Drag splitter | Resize panel | Resize panel | Resize panel |

### Context Menu Items

| Item | Shortcut | Description |
|------|----------|-------------|
| 📂 Open in Explorer | — | Opens folder / selects file |
| 💻 Open Terminal | — | Opens cmd in parent directory |
| ⚙️ Properties | — | Native Windows properties dialog |
| 📋 Copy Path | — | Copies full path to clipboard |
| 🗑️ Delete | — | Deletes file/directory |
| 🌲 Jump in Tree | — | (Diagram only) Navigates tree to this file |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Start scan |
| `⌘/Ctrl+1` | Pie Chart |
| `⌘/Ctrl+2` | Treemap |
| `⌘/Ctrl+3` | Galaxy View |
| `⌘/Ctrl+I` | About dialog |
| `⌘/Ctrl+Q` | Exit

---

## 📦 Download

Pre-built binaries for each release are available on the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page:

| Platform | Format |
|----------|--------|
| **Windows** | `.exe` (NSIS Installer) or `.zip` (Portable) |
| **macOS** | `.dmg` bundle or `.zip` (unsigned) |
| **Linux** | `.deb` (Debian/Ubuntu) or `.zip` (Portable) |

> ⚠️ macOS & Linux builds are unsigned. On macOS: right-click → Open. On Linux: `sudo dpkg -i *.deb` or `chmod +x DiskRaptor.sh && ./DiskRaptor.sh`.

---

## 📌 Current Status

- [x] Win32 parallel scanner with junction following
- [x] Cross-platform (macOS/Linux via walkdir)
- [x] Arena-allocated tree (20M+ nodes)
- [x] Chunk streaming (10k-node batches)
- [x] Virtual TreeView with expand/collapse
- [x] Live scan progress
- [x] Native directory picker
- [x] Top 50 files with file-type badges
- [x] Pie Chart + Squarified Treemap
- [x] Real Windows shell icons
- [x] Dark / Light mode toggle
- [x] Resizable splitters
- [x] Context menus (Tree, Top 50, Diagram)
- [x] Native Windows properties dialog
- [x] System tray
- [x] Admin elevation (optional)
- [x] JSON export
- [x] Rust integration tests
- [x] UI unit tests (58 tests)
- [x] E2E tests

---

## 📄 License

MIT

---

## 💡 About This Project

This is my first major Rust project. Coming from a Java background, I used AI as a development assistant to learn Rust and speed up implementation.
