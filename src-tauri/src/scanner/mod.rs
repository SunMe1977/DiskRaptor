pub mod tree;
pub mod walker;
pub mod duplicates;
#[cfg(target_os = "windows")]
pub mod ntfs_fast;
#[cfg(target_os = "macos")]
pub mod macos_fast;
