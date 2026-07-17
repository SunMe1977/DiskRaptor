// Test loading diskraptor_scanner.dll dynamically and calling dr_start_scan
// This simulates what the Qt C++ app does via LoadLibrary/GetProcAddress.
//
// Run with: cargo run --release --example dll_test -- "C:\some\path"

use std::ffi::{CStr, CString};
use std::time::Duration;

type FnStartScan = unsafe extern "C" fn(*const std::ffi::c_char) -> *mut std::ffi::c_char;
type FnGetProgress = unsafe extern "C" fn() -> *mut std::ffi::c_char;
type FnGetResult = unsafe extern "C" fn() -> *mut std::ffi::c_char;
type FnGetChunk = unsafe extern "C" fn(u32) -> *mut std::ffi::c_char;
type FnCancelScan = unsafe extern "C" fn() -> bool;
type FnIsRunning = unsafe extern "C" fn() -> bool;
type FnFreeString = unsafe extern "C" fn(*mut std::ffi::c_char);

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scan_path = if args.len() > 1 {
        args[1].clone()
    } else {
        std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string()
    };

    println!("DLL Test - Loading diskraptor_scanner.dll");
    println!("==========================================");
    println!("Scan path: {}", scan_path);
    println!();

    // Load the DLL
    let dll_path = if cfg!(target_os = "windows") {
        "diskraptor_scanner.dll"
    } else {
        "libdiskraptor_scanner.so"
    };

    let lib = unsafe { libloading::Library::new(dll_path) };
    let lib = match lib {
        Ok(l) => l,
        Err(e) => {
            eprintln!("ERROR: Failed to load {}: {}", dll_path, e);
            std::process::exit(1);
        }
    };
    println!("DLL loaded successfully");

    // Get function pointers
    unsafe {
        let start_scan: libloading::Symbol<FnStartScan> = lib.get(b"dr_start_scan").unwrap();
        let get_progress: libloading::Symbol<FnGetProgress> = lib.get(b"dr_get_progress").unwrap();
        let get_result: libloading::Symbol<FnGetResult> = lib.get(b"dr_get_result").unwrap();
        let get_chunk: libloading::Symbol<FnGetChunk> = lib.get(b"dr_get_chunk").unwrap();
        let is_running: libloading::Symbol<FnIsRunning> = lib.get(b"dr_is_running").unwrap();
        let free_string: libloading::Symbol<FnFreeString> = lib.get(b"dr_free_string").unwrap();

        println!("All 6 symbols resolved");

        // Call dr_start_scan
        let cpath = CString::new(scan_path.as_str()).unwrap();
        let result_ptr = start_scan(cpath.as_ptr());
        if result_ptr.is_null() {
            eprintln!("ERROR: dr_start_scan returned null");
            std::process::exit(1);
        }
        let result_str = CStr::from_ptr(result_ptr).to_str().unwrap().to_owned();
        free_string(result_ptr);
        println!("start_scan: {}", result_str);

        let result_json: serde_json::Value = serde_json::from_str(&result_str).unwrap();
        if !result_json["success"].as_bool().unwrap_or(false) {
            eprintln!("ERROR: scan start failed: {}", result_json["error"]);
            std::process::exit(1);
        }

        // Poll progress
        println!("\nPolling...");
        let max_polls = 100;
        for i in 0..max_polls {
            std::thread::sleep(Duration::from_millis(500));

            let prog_ptr = get_progress();
            let prog_str = CStr::from_ptr(prog_ptr).to_str().unwrap().to_owned();
            free_string(prog_ptr);

            let prog: serde_json::Value = serde_json::from_str(&prog_str).unwrap();
            let files = prog["files_found"].as_u64().unwrap_or(0);
            let dir_count = prog["dirs_found"].as_u64().unwrap_or(0);
            let running = prog["is_running"].as_bool().unwrap_or(false);
            let phase = prog["phase"].as_u64().unwrap_or(0);
            let elapsed = prog["elapsed_secs"].as_u64().unwrap_or(0);

            if i % 10 == 0 || !running || phase == 3 {
                let rate = if elapsed > 0 { files / elapsed } else { 0 };
                println!(
                    "  [{:3}] files={:>9} dirs={:>6} running={} phase={} elapsed={}s rate={}/s",
                    i, files, dir_count, running, phase, elapsed, rate
                );
            }

            if !running || phase == 3 {
                println!("  Scan complete");
                break;
            }
        }

        // Get result
        let res_ptr = get_result();
        let res_str = CStr::from_ptr(res_ptr).to_str().unwrap().to_owned();
        free_string(res_ptr);

        let res: serde_json::Value = serde_json::from_str(&res_str).unwrap();
        if let Some(stats) = res["stats"].as_object() {
            let f = stats["total_files"].as_u64().unwrap_or(0);
            let d = stats["total_dirs"].as_u64().unwrap_or(0);
            let s = stats["size_human"].as_str().unwrap_or("?");
            let t = stats["time_human"].as_str().unwrap_or("?");
            println!("\nResult: {} files, {} dirs, {} in {}", f, d, s, t);

            if f == 0 {
                eprintln!("\nERROR: 0 files found - scan produced no results!");
                std::process::exit(1);
            }
        } else {
            eprintln!("\nERROR: no stats in result: {}", res_str);
            std::process::exit(1);
        }

        // Get chunk
        let chunk_ptr = get_chunk(0);
        if !chunk_ptr.is_null() {
            let chunk_str = CStr::from_ptr(chunk_ptr).to_str().unwrap().to_owned();
            free_string(chunk_ptr);
            let chunk: serde_json::Value = serde_json::from_str(&chunk_str).unwrap();
            let n = chunk["nodes"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("chunk 0: {} nodes", n);
        }

        println!("\nDLL test PASSED");
    }
}
