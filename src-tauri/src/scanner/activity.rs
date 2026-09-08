//! Per-scan diagnostics. Starting an operation is not evidence of progress;
//! only work actually completed by a scanner advances the watchdog.
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;
use std::thread::ThreadId;
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
const ACTIVE_CAP: usize = 16;
const ERROR_CAP: usize = 100;

pub struct ScanActivity {
    state: Mutex<ActivityState>,
}

struct ActivityState {
    last_progress: Instant,
    active: HashMap<ThreadId, (String, &'static str, Instant)>,
}

impl Default for ScanActivity {
    fn default() -> Self {
        Self { state: Mutex::new(ActivityState {
            last_progress: Instant::now(),
            active: HashMap::new(),
        }) }
    }
}

impl ScanActivity {
    pub fn progress(&self) {
        self.state.lock().last_progress = Instant::now();
    }

    pub fn operation(self: &Arc<Self>, path: &str, operation: &'static str) -> ActiveOperation {
        let id = std::thread::current().id();
        let mut state = self.state.lock();
        if state.active.len() < ACTIVE_CAP || state.active.contains_key(&id) {
            state.active.insert(id, (path.to_owned(), operation, Instant::now()));
        }
        ActiveOperation { activity: self.clone(), id }
    }

    pub fn timeout_message(&self, timeout_secs: u64, root: &str) -> Option<String> {
        self.timeout_at(timeout_secs, root, Instant::now())
    }

    pub(crate) fn timeout_at(&self, timeout_secs: u64, root: &str, now: Instant) -> Option<String> {
        let state = self.state.lock();
        if timeout_secs == 0 || now.saturating_duration_since(state.last_progress) < Duration::from_secs(timeout_secs) {
            return None;
        }
        let mut active: Vec<_> = state.active.values().map(|(path, op, since)| {
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
    pub fn set(&self, operation: &'static str) {
        if let Some((_, op, since)) = self.activity.state.lock().active.get_mut(&self.id) {
            *op = operation;
            *since = Instant::now();
        }
    }
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        self.activity.state.lock().active.remove(&self.id);
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

    #[test]
    fn watchdog_uses_completed_work_and_zero_disables_it() {
        let activity = Arc::new(ScanActivity::default());
        let start = activity.state.lock().last_progress;
        let op = activity.operation("slow-directory", "FindFirstFileW (enumerating directory)");
        assert!(activity.timeout_at(0, "root", start + Duration::from_secs(10000)).is_none());
        assert!(activity.timeout_at(2, "root", start + Duration::from_secs(1)).is_none());
        let message = activity.timeout_at(2, "root", start + Duration::from_secs(2)).unwrap();
        assert!(message.contains("slow-directory") && message.contains("FindFirstFileW"));
        op.set("FindNextFileW (enumerating directory)");
        assert!(activity.timeout_at(2, "root", start + Duration::from_secs(2)).is_some());
        // Simulate a long directory yielding an entry every second, without sleeping.
        for second in 1..100 {
            activity.state.lock().last_progress = start + Duration::from_secs(second);
            assert!(activity.timeout_at(2, "root", start + Duration::from_secs(second + 1)).is_none());
        }
        drop(op);
        assert!(activity.state.lock().active.is_empty());
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
}
