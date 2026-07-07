# 🦅 DiskRaptor

**Ultra-fast directory scanner** — A modern, high-performance successor to JDiskReport, written in Rust + Tauri.

DiskRaptor scans directories with **Win32 API traversal** (Windows) or **walkdir** (macOS/Linux) and displays results in a **virtual tree view** capable of handling **10 million+ files** without UI lag.

## Features

- ⚡ **Blazingly fast scanning** — Uses `FindFirstFileW`/`FindNextFileW` with `\\?\` long-path prefix (Windows) or `walkdir` (macOS/Linux)
- 🌳 **Virtual TreeView** — Renders only visible nodes (50–200 at a time) via DOM recycling
- 📊 **Live statistics** — File counts, directory counts, total size, scan time
- 🏆 **Top 100 files** — Largest files sorted by size, with delete buttons
- 📂 **File type breakdown** — Aggregated by extension
- 📥 **JSON export** — Export scan results
- 🌙 **Dark mode UI** — Modern, clean design inspired by GitHub Dark
- 🔄 **Chunk streaming** — Tree data delivered in 10,000-node chunks
- 🗜️ **Minimal memory** — Arena-allocated tree structure (~56 bytes/node + name)
- ✅ **Matches `dir /s` counts** — Win32 scanner matches Windows CMD file/dir counts exactly

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Shell                        │
│  ┌─────────────────┐     ┌────────────────────────┐ │
│  │   Rust Backend   │     │   WebView2 Frontend    │ │
│  │                  │     │                        │ │
│  │  Win32 FindFirst │────▶│  ChunkLoader           │ │
│  │  Arena Tree      │     │  VirtualScroll         │ │
│  │  Chunk Streaming │◀────│  TreeView              │ │
│  │  Tauri Commands  │     │  Stats / TopFiles      │ │
│  └─────────────────┘     └────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### Backend (Rust)

| Module | Purpose |
|--------|---------|
| `scanner/tree.rs` | Arena-allocated `TreeNode` (compact, contiguous memory) |
| `scanner/walker.rs` | Win32 `FindFirstFileW` + `\\?\` scanner (Windows) or `walkdir` (macOS/Linux) |
| `scanner/win32_scanner.rs` | Standalone Win32 scanner for unit tests |
| `streaming/chunker.rs` | BFS-based chunk splitting (10k nodes/chunk) |
| `commands.rs` | Tauri IPC bridge (start_scan, get_chunk, get_children, etc.) |

### Frontend (JavaScript)

| Module | Purpose |
|--------|---------|
| `virtualscroll.js` | Virtual scrolling engine with DOM element recycling |
| `chunkloader.js` | Chunked data loading from Tauri commands |
| `treeview.js` | Expand/collapse tree with lazy child loading |
| `stats.js` | Scan summary statistics panel |
| `topfiles.js` | Top 100 files table with delete buttons |
| `app.js` | Main controller wiring everything together |
| `tauri-api-bridge.js` | Custom Tauri IPC bridge for platforms without auto-injection |

## Getting Started

### Prerequisites

- **Rust** (≥ 1.70) — [rustup.rs](https://rustup.rs/)
- **Node.js** (≥ 18) — [nodejs.org](https://nodejs.org/)
- **Tauri prerequisites** — See [Tauri setup guide](https://tauri.app/v1/guides/getting-started/prerequisites)

### Quick Start

```bash
# 1. Install npm dependencies
npm install

# 2. Build the Rust backend
cd src-tauri && cargo build --release && cd ..

# 3. Run in development mode (frontend served live)
npm run tauri dev

# 4. Or run the release binary directly
./target/release/diskraptor.exe
```

### Build for Release

```bash
cd src-tauri && cargo build --release
```

The binary will be at `target/release/diskraptor.exe`.

## Running Tests

### Rust unit tests
```bash
cargo test --release -- --nocapture
```

### E2E tests (Playwright)
Tests browse and scan in the real Tauri app:

```bash
# Build first
cd src-tauri && cargo build --release && cd ..

# Run e2e tests
node playwright-e2e.mjs
```

## Performance

| Metric | Target | Notes |
|--------|--------|-------|
| Scan speed (C: drive) | ~1.65M files in 90s | Win32 `FindFirstFileW` on modern NVMe |
| Max files | 10,000,000+ | 5M safety limit prevents OOM |
| Memory/node | ~56 bytes + name | Arena-allocated, no per-node `Box`/`Rc` |
| UI nodes rendered | 50–200 | Only visible rows, DOM recycled |
| Chunk size | 10,000 nodes | ~1–2 MB per JSON chunk |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Start scan |
| `↑/↓` | Navigate tree (TODO) |
| `→` | Expand directory (TODO) |
| `←` | Collapse directory (TODO) |

## Status

- [x] Win32 `FindFirstFileW` scanner with `\\?\` long-path prefix
- [x] Cross-platform (Windows + macOS/Linux via `walkdir`)
- [x] Arena-allocated tree structure
- [x] Chunked streaming to UI
- [x] Virtual TreeView with expand/collapse
- [x] Live progress overlay (files, directory, elapsed time)
- [x] Browse button (native directory picker)
- [x] Top 100 files with delete buttons
- [x] JSON export
- [x] Playwright E2E tests (browse + scan + data access)

## License

MIT
