//! Benchmark harness for the scanner.
//! Run with: cargo bench --features ffi
#![cfg(feature = "ffi")]

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use diskraptor_scanner::scanner::walker::{ScanConfig, scan_directory_with_progress};

fn bench_scan_empty(c: &mut Criterion) {
    let temp_dir = std::env::temp_dir().join("diskraptor_bench_empty");
    let _ = std::fs::create_dir_all(&temp_dir);
    
    let mut group = c.benchmark_group("scan_empty");
    group.bench_function("empty_dir", |b| {
        b.iter(|| {
            let config = ScanConfig {
                root_path: temp_dir.to_string_lossy().to_string(),
                ..Default::default()
            };
            let progress = Box::new(|_, _, _, _| {});
            let _ = scan_directory_with_progress(config, progress);
        });
    });
    group.finish();
    
    let _ = std::fs::remove_dir_all(&temp_dir);
}

fn bench_scan_small(c: &mut Criterion) {
    let temp_dir = std::env::temp_dir().join("diskraptor_bench_small");
    let _ = std::fs::remove_dir_all(&temp_dir);
    std::fs::create_dir_all(&temp_dir).unwrap();
    
    // Create 1000 files in nested directories
    for i in 0..1000 {
        let subdir = temp_dir.join(format!("dir_{}", i / 100));
        std::fs::create_dir_all(&subdir).unwrap();
        std::fs::write(sub_dir.join(format!("file_{}.txt", i)), vec![0u8; 1024]).unwrap();
    }
    
    let mut group = c.benchmark_group("scan_small");
    group.bench_function("1k_files", |b| {
        b.iter(|| {
            let config = ScanConfig {
                root_path: temp_dir.to_string_lossy().to_string(),
                ..Default::default()
            };
            let progress = Box::new(|_, _, _, _| {});
            let _ = scan_directory_with_progress(config, progress);
        });
    });
    group.finish();
    
    let _ = std::fs::remove_dir_all(&temp_dir);
}

fn bench_top_files(c: &mut Criterion) {
    use diskraptor_scanner::scanner::walker::TopFilesAccum;
    
    let mut group = c.benchmark_group("top_files");
    for size in [100, 1000, 10000].iter() {
        group.bench_with_input(BenchmarkId::new("insert", size), size, |b, &size| {
            b.iter(|| {
                let accum = TopFilesAccum::default();
                for i in 0..size {
                    accum.insert(&format!("file_{}.txt", i), i as u64 * 1024, 100);
                }
                black_box(accum.into_inner());
            });
        });
    }
    group.finish();
}

fn bench_file_type_accum(c: &mut Criterion) {
    use diskraptor_scanner::scanner::walker::FileTypeAccum;
    
    let mut group = c.benchmark_group("file_type_accum");
    for size in [100, 1000, 10000].iter() {
        group.bench_with_input(BenchmarkId::new("add", size), size, |b, &size| {
            b.iter(|| {
                let accum = FileTypeAccum::default();
                for i in 0..size {
                    let ext = match i % 5 {
                        0 => "txt",
                        1 => "jpg",
                        2 => "pdf",
                        3 => "mp4",
                        _ => "zip",
                    };
                    accum.add(&format!("file_{}.{}", i, ext), i as u64 * 1024);
                }
                black_box(accum.into_sorted());
            });
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_scan_empty,
    bench_scan_small,
    bench_top_files,
    bench_file_type_accum
);
criterion_main!(benches);