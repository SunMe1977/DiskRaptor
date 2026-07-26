<p align="center">
  <img src="images/logo6_transparent.webp" alt="DiskRaptor Logo" width="400px">
</p>

# 🦖 DiskRaptor

**Ultra-fast disk space analyzer** — A modern, cross-platform successor to WinDirStat / DaisyDisk, built with **Rust + Qt 6 (WebEngine)**.

<p align="center">
  <img src="images/demo.gif" alt="DiskRaptor Demo" style="width:100%;max-width:800px">
</p>

DiskRaptor scans directories using a **parallel jwalk engine** (macOS), **walkdir** (Windows/Linux) and renders results in a **virtual tree view** capable of handling **20+ million files** without UI lag.

---

## ⚡ Features

### Scanning
- **Parallel jwalk engine** (macOS) — Multi-threaded directory traversal, 2–6× faster than single-threaded
- **walkdir engine** (Windows/Linux) — Reliable cross-platform scanning
- **Permission resilience** — Gracefully handles access-denied folders, logs errors, continues scanning
- **20M node limit** — Scans entire drives with millions of files
- **Multi-path scan** — Scan multiple paths sequentially (`path1; path2; path3`)

### Visualization
- **Virtual TreeView** — Renders only visible DOM nodes, handles 10M+ files
- **Pie Chart + Squarified Treemap + Bar Chart + Galaxy 3D View** — Top 50 largest files, hover tooltip, click to jump to tree
- **File type icons** — Emoji icons per file type (images, video, audio, archives, code, etc.)
- **Percentage bars** — Colored gradient bars per tree row showing size relative to parent
- **File age column** — Last modification date, sortable

### Interaction
- **Context menus** — Right-click anywhere (Tree, Top 50, Diagram): Open in Explorer, Open Terminal, Properties, Copy Path, Copy Size, Move to Trash, Jump in Tree, Scan this Folder
- **Keyboard navigation** — Arrow keys to navigate tree, Enter to open files
- **Drag & drop** — Drag folders from Finder/Explorer onto the app to scan
- **Resizable panels** — Drag to resize tree, diagram, detail panel
- **Dark / Light mode** — Toggle with ☾/☀ button, persists in settings
- **25 languages** — Full i18n with auto-detection and language switcher

### Tools
- **Find Duplicates** — Detect duplicate files by content hash
- **Trash Recovery** — Browse, restore, or permanently delete trashed files
- **Empty Folders** — List empty directories, click to jump to them
- **Find Files** — Search by filename pattern in scanned results
- **File type filter** — Show only images, video, audio, archives, or PDFs
- **Export HTML Report** — Standalone shareable report with stats + chart
- **Export CSV/JSON** — Export tree data or raw stats
- **Clear Scan** — Reset all results without reloading

### Cross-Platform
- **macOS** — Universal binary (x86_64 + arm64), Apple Silicon native
- **Windows** — NSIS installer, native Windows icons via `SHGetFileInfoW`
- **Linux** — DEB package, AppImage-style portable

---

## 📦 Download

Pre-built binaries are available on the [Releases](https://github.com/SunMe1977/DiskRaptor/releases) page.

| Platform | Format |
|----------|--------|
| **macOS** | `.dmg` (signed + notarized) or `.pkg` |
| **Windows** | `.exe` (NSIS Installer) |
| **Linux** | `.deb` (Debian/Ubuntu) |

---

## 🛠 Build from Source

### Prerequisites
- **Rust** (latest stable) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
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

---

## 🧪 Testing

```bash
# Scanner unit test (no GUI needed)
cd src-tauri && cargo run --example scanner_test -- /path/to/scan

# Full UI test (requires DISKraptor_CDP_PORT env)
node test_ui.mjs
```

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

