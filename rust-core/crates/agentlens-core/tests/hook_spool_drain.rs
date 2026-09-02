//! `drain_hook_spool`'s `max_files` bound (TRDD-L6V1UUW0) — the periodic drain tick must never
//! process an unbounded backlog, or it holds the state lock across every request in flight.

use agentlens_core::hook_events::drain_hook_spool;
use agentlens_core::{now_ms, CoreState};
use serde_json::json;

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-hookspool-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Spool `n` valid hook payloads with strictly increasing filenames (`drain_hook_spool` sorts
/// lexically, so the leading counter IS the chronological order it relies on).
fn spool_n(dir: &std::path::Path, n: usize) {
    let spool = dir.join("hook-spool");
    std::fs::create_dir_all(&spool).unwrap();
    for i in 0..n {
        let payload = json!({ "hook_event_name": "PreToolUse", "session_id": format!("s{i}") });
        std::fs::write(spool.join(format!("{i:04}-x.json")), payload.to_string()).unwrap();
    }
}

fn spool_names(dir: &std::path::Path) -> Vec<String> {
    let spool = dir.join("hook-spool");
    let mut names: Vec<String> = std::fs::read_dir(&spool)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// `max_files` caps a single drain pass — 5 spooled, cap of 2, drains exactly the oldest 2 and
/// leaves the other 3 for the next tick.
#[test]
fn max_files_bounds_one_drain_pass() {
    let data = tmp("bound");
    spool_n(&data, 5);
    let mut st = CoreState::open(&data);
    let d = drain_hook_spool(&mut st, now_ms(), 2);
    assert_eq!(d.drained, 2, "exactly the capped count should drain: {d:?}");
    let remaining = spool_names(&data);
    assert_eq!(remaining.len(), 3, "the other 3 must stay spooled: {remaining:?}");
    // The two drained were the oldest (lowest-numbered) — the ones left are 0002..0004.
    assert_eq!(remaining, vec!["0002-x.json", "0003-x.json", "0004-x.json"]);
}

/// `usize::MAX` (the boot-path value) drains the whole backlog in one pass — unchanged behaviour.
#[test]
fn unbounded_drains_everything() {
    let data = tmp("unbounded");
    spool_n(&data, 5);
    let mut st = CoreState::open(&data);
    let d = drain_hook_spool(&mut st, now_ms(), usize::MAX);
    assert_eq!(d.drained, 5);
    assert!(spool_names(&data).is_empty());
}
