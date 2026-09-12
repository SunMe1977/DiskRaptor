//! Per-scan diagnostics. Starting an operation is not evidence of progress;
//! only work actually completed by a scanner advances the watchdog.
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::ThreadId;
use std::time::Instant;

pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
const ACTIVE_CAP: usize = 16;
const ERROR_CAP: usize = 100;

pub struct ScanActivity {
    /// Monotonic origin: `last_progress_ms` counts milliseconds since `base`.
    base: Instant,
    /// Last heartbeat of completed work (ms since `base`). Lock-free so the
    /// per-entry progress calls of a multi-threaded walk never serialize on a
    /// single mutex.
    last_progress_ms: AtomicU64,
    /// Diagnostics for slow/blocked operations (per thread). Only touched at
    /// directory granularity, never per file entry.
    active: Mutex<HashMap<ThreadId, (String, &'static str, Instant)>>,
}

impl Default for ScanActivity {
    fn default() -> Self {
        Self {
            base: Instant::now(),
            last_progress_ms: AtomicU64::new(0),
            active: Mutex::new(HashMap::new()),
        }
    }
}

impl ScanActivity {
    #[inline]
    pub fn progress(&self) {
        self.last_progress_ms
            .store(self.base.elapsed().as_millis() as u64, Ordering::Relaxed);
    }

    pub fn operation(self: &Arc<Self>, path: &str, operation: &'static str) -> ActiveOperation {
        let id = std::thread::current().id();
        let mut active = self.active.lock();
        if active.len() < ACTIVE_CAP || active.contains_key(&id) {
            active.insert(id, (path.to_owned(), operation, Instant::now()));
        }
        ActiveOperation { activity: self.clone(), id }
    }

    pub fn timeout_message(&self, timeout_secs: u64, root: &str) -> Option<String> {
        self.timeout_at(timeout_secs, root, Instant::now())
    }

    pub(crate) fn timeout_at(&self, timeout_secs: u64, root: &str, now: Instant) -> Option<String> {
        if timeout_secs == 0 {
            return None;
        }
        // Same clock as `progress()`: last heartbeat in ms since `base`.
        let last_ms = self.last_progress_ms.load(Ordering::Relaxed);
        let now_ms = now.saturating_duration_since(self.base).as_millis() as u64;
        if now_ms.saturating_sub(last_ms) < timeout_secs * 1000 {
            return None;
        }
        let active = self.active.lock();
        let mut active: Vec<_> = active.values().map(|(path, op, since)| {
            format!("{} at {:?} ({}s in operation)", op, path, now.saturating_duration_since(*since).as_secs())
        }).collect();
        active.sort();
        let detail = if active.is_empty() {
            format!("No active native operation recorded; scan root {:?}", root)
        } else {
            format!("Active operations: {}", active.join("; "))
        };
        Some(format!("TIMEOUT: scan made no progress for {}s and was stopped. {}. Directory enumeration does not identify an exact blocked file. A pending UAC prompt cannot be determined from these diagnostics. An underlying OS call may remain pending until it returns.", timeout_secs, detail))
    }
}

pub struct ActiveOperation {
    activity: Arc<ScanActivity>,
    id: ThreadId,
}

impl ActiveOperation {
    #[allow(dead_code)]
    pub fn set(&self, operation: &'static str) {
        let mut active = self.activity.active.lock();
        if let Some((_, op, since)) = active.get_mut(&self.id) {
            *op = operation;
            *since = Instant::now();
        }
    }
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        self.activity.active.lock().remove(&self.id);
    }
}

/// Keep the most recent actual errors, not just the first inaccessible paths.
pub fn record_error(errors: &Mutex<Vec<String>>, message: String) {
    let mut errors = errors.lock();
    if errors.len() >= ERROR_CAP {
        errors.remove(0);
    }
    errors.push(message);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn watchdog_uses_completed_work_and_zero_disables_it() {
        let activity = Arc::new(ScanActivity::default());
        let start = activity.base;
        let op = activity.operation("slow-directory", "FindFirstFileW (enumerating directory)");
        assert!(activity.timeout_at(0, "root", start + Duration::from_secs(10000)).is_none());
        assert!(activity.timeout_at(2, "root", start + Duration::from_secs(1)).is_none());
        let message = activity.timeout_at(2, "root", start + Duration::from_secs(2)).unwrap();
        assert!(message.contains("slow-directory") && message.contains("FindFirstFileW"));
        op.set("FindNextFileW (enumerating directory)");
        assert!(activity.timeout_at(2, "root", start + Duration::from_secs(2)).is_some());
        // Simulate a long directory yielding an entry every second, without sleeping.
        for second in 1..100 {
            activity.last_progress_ms.store(second * 1000, Ordering::Relaxed);
            let now = start + Duration::from_secs(second + 1);
            assert!(activity.timeout_at(2, "root", now).is_none());
        }
        drop(op);
        assert!(activity.active.lock().is_empty());
    }

    #[test]
    fn errors_are_bounded_and_retain_most_recent() {
        let errors = Mutex::new(Vec::new());
        for n in 0..110 { record_error(&errors, format!("OS error {n}")); }
        let errors = errors.lock();
        assert_eq!(errors.len(), 100);
        assert_eq!(errors[0], "OS error 10");
        assert_eq!(errors[99], "OS error 109");
    }

    #[test]
    fn timeout_zero_disables_watchdog() {
        let activity = ScanActivity::default();
        // Zero timeout means never time out, regardless of staleness.
        assert!(activity.timeout_message(0, "root").is_none());
    }

    #[test]
    fn progress_resets_watchdog() {
        let activity = Arc::new(ScanActivity::default());
        let start = activity.base;
        // Simulate 5 seconds of inactivity.
        activity.progress();
        // Should not time out with a 10s threshold right after progress.
        assert!(activity.timeout_at(10, "root", start + Duration::from_secs(5)).is_none());
    }

    #[test]
    fn error_count_is_bounded_at_capacity() {
        let errors = Mutex::new(Vec::new());
        for n in 0..ERROR_CAP + 50 {
            record_error(&errors, format!("error {n}"));
        }
        let errors = errors.lock();
        assert_eq!(errors.len(), ERROR_CAP);
        // The oldest 50 errors should have been evicted.
        assert_eq!(errors[0], "error 50".to_string());
        assert_eq!(errors[ERROR_CAP - 1], format!("error {}", ERROR_CAP + 50 - 1));
    }

    #[test]
    fn error_messages_are_retained_in_order() {
        let errors = Mutex::new(Vec::new());
        record_error(&errors, "first".into());
        record_error(&errors, "second".into());
        record_error(&errors, "third".into());
        let errors = errors.lock();
        assert_eq!(errors.len(), 3);
        assert_eq!(errors[0], "first");
        assert_eq!(errors[1], "second");
        assert_eq!(errors[2], "third");
    }
}
