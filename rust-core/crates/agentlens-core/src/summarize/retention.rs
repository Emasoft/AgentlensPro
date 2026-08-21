//! Port of the src/timelineRetention.ts slice the summarizer consumes (TRDD-DMWOBWFH P4d):
//! the entry/byte caps and the boot-restore/merge trimmer. The push-time bounded append
//! (pushBounded/attachFullResult) belongs to the log-scan path and is NOT needed here.
//!
//! Parity traps: `entryCost` measures JS `.length` — UTF-16 code units, never bytes — and the
//! env knobs fail FAST on a malformed value (the TS module throws at boot; running unbounded
//! silently is the failure mode both guard against).

use super::helpers::utf16_len;
use serde_json::Value;
use std::sync::OnceLock;

pub const DEFAULT_TIMELINE_MAX_ENTRIES: usize = 2000;
pub const DEFAULT_TIMELINE_MAX_BYTES: usize = 2 * 1024 * 1024;
const MIN_FLOOR: usize = 50;
const MIN_BYTES_FLOOR: usize = 64 * 1024;

fn resolve_positive_int(key: &str, default: usize, floor: usize) -> usize {
    let Ok(raw) = std::env::var(key) else { return default };
    let raw = raw.trim();
    if raw.is_empty() {
        return default;
    }
    let n: f64 = raw.parse().unwrap_or(f64::NAN);
    if !(n.is_finite() && n.fract() == 0.0 && n > 0.0) {
        panic!("{key}={raw:?} is not a positive integer");
    }
    (n as usize).max(floor)
}

/// AGENTLENS_TIMELINE_MAX_ENTRIES → default 2000, floor 50. Memoized like the TS module.
pub fn timeline_max_entries() -> usize {
    static V: OnceLock<usize> = OnceLock::new();
    *V.get_or_init(|| resolve_positive_int("AGENTLENS_TIMELINE_MAX_ENTRIES", DEFAULT_TIMELINE_MAX_ENTRIES, MIN_FLOOR))
}

/// AGENTLENS_TIMELINE_MAX_BYTES → default 2MB, floor 64KB. Memoized.
pub fn timeline_max_bytes() -> usize {
    static V: OnceLock<usize> = OnceLock::new();
    *V.get_or_init(|| resolve_positive_int("AGENTLENS_TIMELINE_MAX_BYTES", DEFAULT_TIMELINE_MAX_BYTES, MIN_BYTES_FLOOR))
}

/// AGENTLENS_TIMELINE_HOT_AGE_HOURS → default 24h, floor 1h, as epoch-delta ms. Memoized. A card
/// whose last activity is older than this leaves the log reader WITHOUT a timeline (P5b strip).
pub fn timeline_hot_age_ms() -> i64 {
    static V: OnceLock<i64> = OnceLock::new();
    *V.get_or_init(|| resolve_positive_int("AGENTLENS_TIMELINE_HOT_AGE_HOURS", 24, 1) as i64 * 3_600_000)
}

/// AGENTLENS_TIMELINE_HOT_CARDS → default 50, floor 1 (server.ts TIMELINE_HOT_CARDS): the GLOBAL
/// tier — only the K most-recently-active log cards keep timelines in RAM. Memoized.
pub fn timeline_hot_cards() -> usize {
    static V: OnceLock<usize> = OnceLock::new();
    *V.get_or_init(|| resolve_positive_int("AGENTLENS_TIMELINE_HOT_CARDS", 50, 1))
}

/// entryCost — the heavy text fields a transcript can inflate, in UTF-16 units (JS `.length`).
pub fn entry_cost(e: &Value) -> usize {
    ["fullResult", "responseText", "thinking", "toolInput", "resultSummary", "errorMessage", "label"]
        .iter()
        .map(|k| e.get(*k).and_then(Value::as_str).map_or(0, utf16_len))
        .sum()
}

/// capTimeline — trim to the retention bounds keeping the NEWEST tail; at least the newest entry
/// survives even when it alone busts the byte budget. Returns the evicted count.
pub fn cap_timeline(timeline: &mut Vec<Value>, max_entries: usize, max_bytes: usize) -> usize {
    let len = timeline.len() as i64;
    let keep_start = (len - max_entries as i64).max(0);
    let mut bytes = 0usize;
    let mut i = len - 1;
    while i >= keep_start {
        bytes = bytes.saturating_add(entry_cost(&timeline[i as usize]));
        if bytes > max_bytes {
            break; // timeline[i] overflows the budget → keep only (i+1 .. end)
        }
        i -= 1;
    }
    let mut start = if i >= keep_start { i + 1 } else { keep_start };
    if len > 0 && start >= len {
        start = len - 1;
    }
    if start > 0 {
        timeline.drain(0..start as usize);
    }
    start as usize
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(label: &str) -> Value {
        json!({"type": "tool", "label": label, "isError": false, "timestamp": ""})
    }

    #[test]
    fn cap_by_entries_keeps_newest_tail() {
        let mut tl: Vec<Value> = (0..10).map(|i| entry(&format!("e{i}"))).collect();
        let evicted = cap_timeline(&mut tl, 4, usize::MAX);
        assert_eq!(evicted, 6);
        assert_eq!(tl.len(), 4);
        assert_eq!(tl[0]["label"], "e6");
    }

    #[test]
    fn cap_by_bytes_keeps_at_least_the_newest_entry() {
        // Three 100-unit entries against a 150-unit budget: only the newest survives.
        let mut tl = vec![entry(&"x".repeat(100)), entry(&"y".repeat(100)), entry(&"z".repeat(100))];
        assert_eq!(cap_timeline(&mut tl, 100, 150), 2);
        assert_eq!(tl.len(), 1);
        assert_eq!(tl[0]["label"].as_str().unwrap().as_bytes()[0], b'z');
        // A single entry over the budget still survives (the keep-newest law).
        let mut one = vec![entry(&"w".repeat(500))];
        assert_eq!(cap_timeline(&mut one, 100, 10), 0);
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn entry_cost_counts_utf16_units_not_bytes() {
        // '🚀' is 4 UTF-8 bytes but 2 UTF-16 units — JS '🚀'.length === 2.
        let e = json!({"label": "🚀", "toolInput": "ab"});
        assert_eq!(entry_cost(&e), 4);
    }
}
