// DiskRaptor Test Data Generator
// Creates empty files at maximum speed for scan performance testing.
// Usage: cargo run --release --bin gen-testdata [FILE_COUNT]
//
// Default: 1.000.000 files
// For 100M: cargo run --release --bin gen-testdata 100000000
// Warning: 100M files takes ~2-3 hours and ~100GB of metadata space.

use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let count: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let base = PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "C:\\Users\\default".into()),
    )
    .join("diskraptor-test");

    let dir_count = (count / 1000).max(100).min(10_000) as usize;
    let files_per_dir = (count / dir_count as u64).max(1);

    println!("============================================");
    println!("  DiskRaptor Test Data Generator (Rust)");
    println!("============================================");
    println!("");
    println!("Path:  {}", base.display());
    println!("Files: {}", count);
    println!("Dirs:  {}", dir_count);
    println!("");

    // Clean & create root
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(&base).expect("Failed to create root dir");

    // Create directories
    print!("Creating {} dirs... ", dir_count);
    io::stdout().flush().ok();
    let mut dirs: Vec<PathBuf> = Vec::with_capacity(dir_count + 1);
    dirs.push(base.clone());
    for d in 1..=dir_count {
        dirs.push(base.join(format!("dir_{}", d)));
    }
    // Actually create them
    for d in &dirs {
        fs::create_dir_all(d).expect("Failed to create dir");
    }
    println!("done");

    // Create files
    println!("Creating {} files...", count);
    let start = Instant::now();
    let mut total: u64 = 0;
    let mut last_report = Instant::now();
    let mut file_count_in_dir: u64;

    for di in 0..dirs.len() {
        if total >= count {
            break;
        }
        let remaining = count - total;
        file_count_in_dir = files_per_dir.min(remaining);

        for _fi in 0..file_count_in_dir {
            let file_path = dirs[di].join(format!("f_{}.dat", total));
            let _ = fs::File::create(&file_path);
            total += 1;
        }

        if last_report.elapsed().as_secs_f64() >= 2.0 {
            let elapsed = start.elapsed().as_secs_f64().max(0.1);
            let rate = (total as f64 / elapsed) as u64;
            println!("  {} files @ {}/s", total, rate);
            last_report = Instant::now();
        }
    }

    let elapsed = start.elapsed().as_secs_f64().max(0.1);
    let rate = (total as f64 / elapsed) as u64;
    println!("");
    println!("============================================");
    println!("  COMPLETE");
    println!("  Files:  {}", total);
    println!("  Dirs:   {}", dirs.len());
    println!("  Time:   {:.1}s", elapsed);
    println!("  Speed:  {} files/sec", rate);
    println!("============================================");
    println!("");
    println!("Scan path: {}", base.display());
    println!("");
    println!("Delete with:");
    println!("  rm -rf '{}'", base.display());
    println!("  Remove-Item -Recurse -Force '{}'", base.display());
}
