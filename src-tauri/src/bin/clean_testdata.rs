// DiskRaptor Test Data Cleanup
// Fast deletion of test data using raw filesystem operations.
// Usage: cargo run --release --bin clean-testdata

use std::fs;
use std::path::PathBuf;

fn main() {
    let base = PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| "C:\\Users\\default".into()),
    )
    .join("diskraptor-test");

    if !base.exists() {
        println!("Path does not exist: {}", base.display());
        return;
    }

    println!("Deleting: {}", base.display());
    let start = std::time::Instant::now();

    // First delete all files (fast using walkdir)
    let mut file_count = 0u64;
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                delete_dir(&path, &mut file_count);
            } else {
                let _ = fs::remove_file(&path);
                file_count += 1;
            }
        }
    }

    // Delete root
    let _ = fs::remove_dir_all(&base);

    let elapsed = start.elapsed().as_secs_f64();
    println!("Deleted {} files in {:.1}s", file_count, elapsed);
    println!("Done.");
}

fn delete_dir(dir: &std::path::Path, count: &mut u64) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                delete_dir(&path, count);
            } else {
                let _ = fs::remove_file(&path);
                *count += 1;
            }
        }
    }
    let _ = fs::remove_dir(dir);
}
