use std::path::PathBuf;
use std::sync::OnceLock;
use tracing::{info};
use tracing_subscriber::{fmt, EnvFilter, prelude::*};
use tracing_appender::non_blocking::WorkerGuard;

static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

pub fn init() -> Result<(), Box<dyn std::error::Error>> {
    let log_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("diskraptor")
        .join("logs");

    std::fs::create_dir_all(&log_dir)?;

    let file_appender = tracing_appender::rolling::daily(&log_dir, "diskraptor.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .json()
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_file(true)
        .with_line_number(true);

    let console_layer = fmt::layer()
        .with_writer(std::io::stdout)
        .with_ansi(cfg!(debug_assertions))
        .with_thread_ids(true)
        .with_thread_names(true);

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,diskraptor=debug,tauri=warn"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(console_layer)
        .init();

    LOG_GUARD.set(guard).ok();

    info!("Logging initialized");
    info!(log_dir = %log_dir.display(), "Log directory");
    Ok(())
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {
        error!($($arg)*);
        eprintln!("[ERROR] {}", format!($($arg)*));
    };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {
        warn!($($arg)*);
        eprintln!("[WARN] {}", format!($($arg)*));
    };
}

