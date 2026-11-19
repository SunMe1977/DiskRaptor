# DiskRaptor — TODO

Focused backlog. Priorities: harden the **core file operations** (delete / trash /
permanent delete) with more tests, and make the **UI refresh** after every
mutation provably consistent across tree / stats / diagram.

## 1. Core file operations — safety checks & tests (`src-tauri/src/cmds/path_ops.rs`)

- [ ] 1. Unit-test `delete_path_checked` for all four shapes: regular file, directory, **symlink (removes the link, not the target)**, and missing path (must return `Err`, never claim success).
- [ ] 2. End-to-end test for `delete_path` (move to trash): create a temp file, call the command, assert the file is gone from disk **and** the frontend tree/stats refresh without a rescan.
- [ ] 3. Test `delete_permanent` refuses **protected folders** (from a real temp `settings.json`) and filesystem roots.
- [ ] 4. Extend `PathSnapshot::still_matches` coverage to detect a **symlink swapped in place of a regular file** (today only content-change and delete are covered).
- [ ] 5. Windows case-insensitive test for `path_is_protected` with verbatim/UNC paths (`\\?\C:\...`), including nested folders.
- [ ] 6. Test `validate_system_path` rejects control characters and `..`-style traversal on **Windows** (currently only covered on the Linux/unit path).
- [ ] 7. Property-style test for `sanitize_delete_path`: iterate a list of dangerous targets (roots, home, `.`, `..`, empty) and assert every one is rejected.
- [ ] 8. Test `protected_delete_error` **with** a populated `protectedFolders` settings file in a temp config dir (currently only the "no file" case is covered).
- [ ] 9. Add a regression test for `strip_verbatim_prefix` (`\\?\C:\...` → `C:\...` and `\\?\UNC\server\share`).

## 2. UI refresh correctness (`frontend/app.js`, `frontend/app-modules/*`)

- [ ] 10. Extend `tests/test_delete_refresh_ui.mjs`: after delete, assert **tree, stats panel, diagram, and Top-Files table** all agree (no stale bytes/rows).
- [ ] 11. Add UI test for refresh after **single file vs folder vs multi-select** move-to-trash (the delta bookkeeping differs per shape).
- [ ] 12. Add UI test that **trash recovery / undo** restores the tree without a full rescan and re-adds the correct size delta.
- [ ] 13. Add UI test for **empty trash (permanent delete)** updating stats and removing rows, not leaving ghosts.
- [ ] 14. Add UI test that the **status bar** reflects a failed delete (e.g. protected folder) and never shows "done" on failure.
- [ ] 15. Add UI test for refresh after **rename / copy / move** if those are introduced (currently only delete/trash exist).

## 3. Scanner correctness (`src-tauri/src/scanner/*`)

- [ ] 16. Test scan **resume/restart** doesn't duplicate or drop entries (idempotent totals).
- [ ] 17. Test **symlink handling during scan** matches delete semantics (follow/no-follow is consistent with what `delete_path_checked` would remove).
- [ ] 18. Test that totals (`total_files` / `total_dirs` / `total_size`) stay accurate after **filter + delete** applied in sequence.

## 4. Cross-platform & hardening

- [ ] 19. Test `open_url` scheme allowlist (blocks `file://`, `javascript:`, custom protocols; allows `https`/`http`/`mailto`).
- [ ] 20. Test `get_file_preview` rejects symlinks, oversized files (>2 MB), and non-image extensions without touching disk.
