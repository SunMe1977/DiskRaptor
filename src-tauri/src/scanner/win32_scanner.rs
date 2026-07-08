// DiskRaptor - Win32 directory scanner using FindFirstFileW / FindNextFileW
// Uses \\?\ prefix for long paths (>260 chars).
// Returns (file_count, dir_count) - call scan_dir(path).

use std::collections::HashSet;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::Mutex;
use windows::Win32::Foundation::*;
use windows::Win32::Storage::FileSystem::*;

fn lp(path: &str) -> String {
    if path.starts_with("\\\\?\\") {
        path.into()
    } else {
        format!("\\\\?\\{}", path)
    }
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

pub fn scan_dir(root: &str) -> (u64, u64) {
    let mut files: u64 = 0;
    let mut dirs: u64 = 0;
    let visited: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
    let stack: Mutex<Vec<String>> = Mutex::new(Vec::new());
    stack.lock().unwrap().push(lp(root));

    while let Some(current) = stack.lock().unwrap().pop() {
        if files + dirs > 5_000_000 {
            break;
        }
        let key = current.trim_start_matches("\\\\?\\").to_string();
        if !visited.lock().unwrap().insert(key) {
            continue;
        }

        unsafe {
            let mut fd = WIN32_FIND_DATAW::default();
            let search = format!("{}\\*", current);
            let h = match FindFirstFileW(
                windows::core::PCWSTR::from_raw(wide(&search).as_ptr()),
                &mut fd,
            ) {
                Ok(h) => h,
                Err(_) => continue,
            };
            let hh = HANDLE(h.0);

            loop {
                let nlen = fd.cFileName.iter().position(|&c| c == 0).unwrap_or(260);
                if nlen == 0 {
                    break;
                }
                let name = String::from_utf16_lossy(&fd.cFileName[..nlen]);
                if name == "." || name == ".." {
                    let mut nd = WIN32_FIND_DATAW::default();
                    if FindNextFileW(hh, &mut nd).as_bool() {
                        fd = nd;
                        continue;
                    } else {
                        break;
                    }
                }

                let is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0;
                let is_reparse = (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0) != 0;
                // Skip reparse points (junctions, symlinks) to avoid infinite loops
                if is_dir && is_reparse {
                    let mut nd = WIN32_FIND_DATAW::default();
                    if FindNextFileW(hh, &mut nd).as_bool() {
                        fd = nd;
                        continue;
                    } else {
                        break;
                    }
                }
                if is_dir {
                    dirs += 1;
                    let child = format!("{}\\{}", current, name);
                    stack.lock().unwrap().push(child);
                } else {
                    files += 1;
                }

                let mut nd = WIN32_FIND_DATAW::default();
                if FindNextFileW(hh, &mut nd).as_bool() {
                    fd = nd;
                } else {
                    break;
                }
            }
            let _ = FindClose(h);
        }
        #[allow(clippy::manual_is_multiple_of)]
        if (files + dirs) > 0 && (files + dirs) % 50000 == 0 {
            eprintln!("[progress] files={} dirs={}", files, dirs);
        }
    }
    (files, dirs)
}

#[test]
fn test_small() {
    let dir = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();
    eprintln!("Scanning: {}", dir);
    let (f, d) = scan_dir(&dir);
    eprintln!("Result: files={} dirs={}", f, d);
    assert!(f > 0 || d > 0, "Expected at least some files or dirs");
}
