![alt text](path/to/image.png)

# 🦖 DiskRaptor

**Ultra-fast directory scanner** — A modern, high-performance successor to JDiskReport, built with **Rust + Tauri**.

DiskRaptor scans directories using a **parallel Win32 traversal engine** (Windows) or **walkdir** (macOS/Linux) and renders results in a **virtual tree view** capable of handling **20+ million files** without UI lag.

---

## ⚡ Features

### Scanning
- **Parallel Win32 engine** — 4–8 worker threads for 2–6× faster scanning
- **Exact file counts** — Follows NTFS junctions (reparse points), matches `dir /s`
- **Long path support** — `\\?\` prefix for paths >260 characters
- **Admin elevation** — Optional restart as Administrator for full system folder access
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

## 🖼️ UI Overview

```
┌──────────────────────────────────────────────────────────────┐
│  🦖 DiskRaptor  [📁 Browse] [🔍 Scan] [✖ Cancel] [☾]    │
├──────────────────────────────┬───────────────────────────────┤
│  ┌─ Top 50 Files ─────────┐  │  ┌─ Scan Summary ──────────┐  │
│  │  [Pie] [Treemap]       │  │  │ Files         1,196,643 │  │
│  │   🍰 Diagram           │  │  │ Directories     153,199 │  │
│  ├─ (resizable splitter) ─┤  │  │ Total Size    538.64 GB│  │
│  │  ┌─ Directory Tree ───┐│  │  │ Scan Time        20.06s│  │
│  │  │ 📁 C:\              ││  │  ├─ Selection ───────────┤  │
│  │  │  📁 Users           ││  │  │ 📄 Name  (selected)   │  │
│  │  │   📁 hansj          ││  │  │ 💾 Size  1.2 GB       │  │
│  │  │    📄 file.txt       ││  │  │ 📂 Files 5,432       │  │
│  │  │    📁 AppData        ││  │  │ 🏷️ Type Directory    │  │
│  │  │    ...               ││  │  │ [📂][💻][⚙️][📋][🗑️] │  │
│  │  └─────────────────────┘│  │  ├─ (resizable) ────────┤  │
│  └─────────────────────────┘  │  │ ┌─ Top 50 Files ────┐ │  │
│                                │  │ │ #  Path       Size│ │  │
│                                │  │ │ 1  big.iso 4.2 GB│ │  │
│                                │  │ │ 2  data.zip 2.1GB│ │  │
│                                │  │ │ 3  doc.pdf  1.9MB│ │  │
│                                │  │ └──────────────────┘ │  │
│                                └─────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔧 Backend (Rust)

| Module | Purpose |
|--------|---------|
| `scanner/tree.rs` | Arena-allocated `TreeNode` (~56 bytes/node) |
| `scanner/walker.rs` | Parallel Win32 scanner + walkdir fallback |
| `scanner/win32_scanner.rs` | Standalone Win32 scanner |
| `streaming/chunker.rs` | BFS chunk splitting (10k nodes/chunk) |
| `commands.rs` | Tauri IPC bridge (18 commands) |
| `main.rs` | App entry, native menus, system tray, window maximize |

### Key Technical Decisions

- **Two-phase parallel scan**: Phase 1 = N worker threads scan directories independently. Phase 2 = single-threaded tree building from collected entries. No arena locking during scan.
- **Squarified treemap**: Recursive subdivision algorithm — full area fill, no gaps, professional look.
- **Native Windows icons**: Extracted via `SHGetFileInfoW` + raw GDI (`CreateDIBSection` + `DrawIconEx`), returned as base64 RGBA to frontend.
- **Admin elevation**: `ShellExecuteW` with `"runas"` verb — optional, user-initiated UAC prompt.

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
| `iconcache.js` | Real Windows shell icons via Tauri IPC |
| `splitter.js` | 3 resizable splitters (vertical, horizontal x2) |
| `app.js` | Main controller, scan flow, theme toggle |
| `tauri-api-bridge.js` | Custom IPC bridge for Tauri v1 |

---

## 🚀 Getting Started

### Prerequisites

- Rust ≥ 1.70
- Node.js ≥ 18
- Tauri v1 toolchain

### Quick Start (Development)

```bash
git clone https://github.com/SunMe1977/DiskRaptor.git
cd DiskRaptor
npm install
npm run tauri dev
```

### Build Release

```bash
cd src-tauri && cargo build --release
# Binary: src-tauri/target/release/diskraptor.exe
```

### MSI Installer (Windows)

```bash
cd src-tauri && npx tauri build --bundles msi --ci
# MSI: target/release/bundle/msi/DiskRaptor_0.1.0_x64_en-US.msi
```

---

## 🧪 Running Tests

```bash
# Rust integration tests
cd src-tauri && cargo test --test scanner_test -- --nocapture

# UI unit tests (headless Playwright)
node run-tests.mjs

# E2E test (requires release build + WebView2 debugging port)
cd src-tauri && cargo build --release && cd ..
node e2e-test.mjs
```

---

## ⚡ Performance

| Metric | Value | Details |
|--------|-------|---------|
| Scan speed | ~1.35M files in 20s | `C:\Users\hansj` on NVMe SSD |
| Parallel workers | 4–8 threads | Auto-detected from CPU cores |
| Max nodes | 20,000,000 | Safety limit (configurable) |
| Memory per node | ~56 bytes | Arena-allocated `Vec<TreeNode>` |
| UI nodes rendered | 50–200 | VirtualScroll with DOM recycling |
| Chunk size | 10,000 nodes | ~1–2 MB JSON per chunk |
| Arena capacity | 2,000,000 (initial) | Auto-grows as needed |

### Expected Speedup

| Drive Type | vs Single-Threaded |
|------------|-------------------|
| NVMe SSD | 4–6× faster |
| SATA SSD | 3–4× faster |
| HDD | 2–3× faster |

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
| `⌘/Ctrl+I` | About dialog |

---

## 📦 Download

Pre-built binaries for each release are available on the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page:

| Platform | Format |
|----------|--------|
| **Windows** | `.msi` installer or `.exe` standalone |
| **macOS** | `.dmg` bundle (unsigned) or raw binary |
| **Linux** | `.AppImage` (unsigned) or raw binary |

> ⚠️ macOS & Linux builds are unsigned. On macOS: right-click → Open. On Linux: `chmod +x`.

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
