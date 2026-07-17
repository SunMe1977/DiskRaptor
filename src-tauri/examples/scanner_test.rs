// DiskRaptor scanner test — run with: cargo run --example scanner_test -- PATH
// Tests the scanner FFI directly without the Qt app.

use std::ffi::CString;
use std::time::Duration;

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

    println!("DiskRaptor Scanner Test");
    println!("========================");
    println!("Scanning: {}", scan_path);
    println!();

    let cpath = CString::new(scan_path.as_str()).unwrap();
    let result_ptr = unsafe { diskraptor_scanner::scanner_api::dr_start_scan(cpath.as_ptr()) };
    if result_ptr.is_null() {
        eprintln!("ERROR: dr_start_scan returned null");
        std::process::exit(1);
    }
    let result_str = unsafe { std::ffi::CStr::from_ptr(result_ptr) }
        .to_str()
        .unwrap()
        .to_owned();
    unsafe { diskraptor_scanner::scanner_api::dr_free_string(result_ptr) };
    println!("start_scan: {}", result_str);

    let result_json: serde_json::Value = serde_json::from_str(&result_str).unwrap();
    if !result_json["success"].as_bool().unwrap_or(false) {
        eprintln!(
            "ERROR: {}",
            result_json["error"].as_str().unwrap_or("unknown")
        );
        std::process::exit(1);
    }
    let scan_id = result_json["scan_id"].as_u64().unwrap_or(0);
    println!("Scan ID: {}", scan_id);

    // Poll progress
    println!("\nPolling progress...");
    let max_polls = 1200;
    let mut completed = false;

    for i in 0..max_polls {
        std::thread::sleep(Duration::from_millis(500));

        let prog_ptr = unsafe { diskraptor_scanner::scanner_api::dr_get_progress() };
        if prog_ptr.is_null() {
            continue;
        }
        let prog_str = unsafe { std::ffi::CStr::from_ptr(prog_ptr) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { diskraptor_scanner::scanner_api::dr_free_string(prog_ptr) };

        let prog: serde_json::Value = serde_json::from_str(&prog_str).unwrap();
        let files = prog["files_found"].as_u64().unwrap_or(0);
        let dirs = prog["dirs_found"].as_u64().unwrap_or(0);
        let is_running = prog["is_running"].as_bool().unwrap_or(false);
        let phase = prog["phase"].as_u64().unwrap_or(0);
        let elapsed = prog["elapsed_secs"].as_u64().unwrap_or(0);
        let current_dir = prog["current_dir"].as_str().unwrap_or("");

        if i % 10 == 0 || !is_running || phase == 3 {
            let rate = if elapsed > 0 { files / elapsed } else { 0 };
            println!(
                "  [{:3}] files={:>9} dirs={:>6} running={} phase={} elapsed={}s rate={}/s",
                i, files, dirs, is_running, phase, elapsed, rate
            );
        }

        if !is_running || phase == 3 {
            completed = true;
            println!("  Scan complete");
            break;
        }
    }

    if !completed {
        eprintln!("ERROR: Scan did not complete");
        std::process::exit(1);
    }

    // Get result
    let res_ptr = unsafe { diskraptor_scanner::scanner_api::dr_get_result() };
    if res_ptr.is_null() {
        eprintln!("ERROR: dr_get_result returned null");
        std::process::exit(1);
    }
    let res_str = unsafe { std::ffi::CStr::from_ptr(res_ptr) }
        .to_str()
        .unwrap()
        .to_owned();
    unsafe { diskraptor_scanner::scanner_api::dr_free_string(res_ptr) };

    let res: serde_json::Value = serde_json::from_str(&res_str).unwrap();

    if let Some(stats) = res["stats"].as_object() {
        let files = stats["total_files"].as_u64().unwrap_or(0);
        let dirs = stats["total_dirs"].as_u64().unwrap_or(0);
        let size = stats["size_human"].as_str().unwrap_or("?");
        let time = stats["time_human"].as_str().unwrap_or("?");
        println!(
            "\nResult: {} files, {} dirs, {} in {}",
            files, dirs, size, time
        );
    }

    // Get chunk 0
    let chunk_ptr = unsafe { diskraptor_scanner::scanner_api::dr_get_chunk(0) };
    if !chunk_ptr.is_null() {
        let chunk_str = unsafe { std::ffi::CStr::from_ptr(chunk_ptr) }
            .to_str()
            .unwrap()
            .to_owned();
        unsafe { diskraptor_scanner::scanner_api::dr_free_string(chunk_ptr) };
        let chunk: serde_json::Value = serde_json::from_str(&chunk_str).unwrap();
        let node_count = chunk["nodes"].as_array().map(|a| a.len()).unwrap_or(0);
        println!("chunk 0: {} nodes", node_count);
    }

    println!("\nScanner test PASSED");
}
