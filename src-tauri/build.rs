fn main() {
    println!("cargo:warning=TAURI_BUILD starting");
    println!("cargo:warning=CWD: {:?}", std::env::current_dir());
    println!("cargo:warning=FRONTEND_DIST: {}/../frontend", std::env::current_dir().unwrap_or_default().display());
    println!("cargo:warning=FRONTEND_EXISTS: {}", std::path::Path::new("../frontend/index.html").exists());
    tauri_build::build();
    println!("cargo:warning=TAURI_BUILD done");
    // Check what files were created
    let out_dir = std::env::var("OUT_DIR").unwrap_or_default();
    println!("cargo:warning=OUT_DIR: {}", out_dir);
    if let Ok(entries) = std::fs::read_dir(&out_dir) {
        for entry in entries.flatten() {
            println!("cargo:warning=OUT: {}", entry.path().display());
        }
    }
}
