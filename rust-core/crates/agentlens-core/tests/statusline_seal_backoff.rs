//! TRDD-RTHA7EWK item 5 — a refused status-line write-ahead file leaves a `sealfail-<file>.json`
//! marker beside it and is not attempted again before its backoff window has passed (base, doubling
//! per refusal); a successful seal removes the marker.
//!
//! In-process, stepping the `now_ms` argument of `maybe_seal`, so no test sleeps for a window. The
//! refusal is real: a past-day file whose only line is the bare number 42 makes DuckDB read it as
//! ONE opaque `json` column, which the seal refuses (the same input as tests/statusline_parity.rs).
//! The tests share the process-wide heavy DuckDB slot with each other, so they run one at a time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Mutex;

use agentlens_core::statusline_store::{maybe_seal, seal_marker_name, SealCounters};
use serde_json::Value;

/// The backoff base the tests set through the environment variable (ms).
const BASE_MS: u64 = 10_000;

static SERIAL: Mutex<()> = Mutex::new(());

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    day: PathBuf,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        // The system temp dir, never the cargo target tmp dir: the test-data cap redirects TMPDIR.
        let base = std::env::temp_dir().join(format!("sl-backoff-{tag}-{}-{}", std::process::id(), agentlens_core::now_ms()));
        let root = base.join("statusline");
        let day = root.join("main").join("2020-01-02");
        std::fs::create_dir_all(&day).unwrap();
        Fixture { base, root, day }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn vars() -> HashMap<String, String> {
    HashMap::from([("AGENTLENS_STATUSLINE_SEAL_RETRY_BASE_MS".to_owned(), BASE_MS.to_string())])
}

/// One maybe_seal call at `now_ms`; returns (sealed, refused_files, backoff_skips) of that call.
fn call(f: &Fixture, now_ms: f64) -> (u64, u64, u64) {
    let counters = SealCounters::default();
    let sealed = maybe_seal(&f.root, &counters, &vars(), now_ms);
    (sealed, counters.refused_files.load(Relaxed), counters.backoff_skips.load(Relaxed))
}

fn names(dir: &Path, prefix: &str, suffix: &str) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(prefix) && n.ends_with(suffix))
        .collect();
    out.sort();
    out
}

fn marker(f: &Fixture, file: &str) -> Value {
    let text = std::fs::read_to_string(f.day.join(seal_marker_name(file))).unwrap_or_else(|e| panic!("no marker for {file}: {e}"));
    serde_json::from_str(&text).unwrap()
}

fn valid_lines(n: usize) -> String {
    (0..n).map(|i| format!("{{\"ts\":{},\"session_id\":\"s{}\",\"statusline_stream\":\"main\",\"n\":{i}}}\n", 1_577_836_800_000u64 + i as u64, i % 2)).collect()
}

/// Calls 2-5 after a first refusal at `t0` of `file`: inside the window nothing is attempted, at its
/// edge exactly one attempt, and the next window is twice as long.
fn assert_doubling_windows(f: &Fixture, file: &str, t0: f64) {
    let base = BASE_MS as f64;
    assert_eq!(marker(f, file)["attempts"], 1);
    // One millisecond inside the window: skipped, no attempt, attempts unchanged.
    assert_eq!(call(f, t0 + base - 1.0), (0, 0, 1), "inside the first window");
    assert_eq!(marker(f, file)["attempts"], 1);
    // At the edge: exactly one attempt.
    assert_eq!(call(f, t0 + base), (0, 1, 0), "at the edge of the first window");
    let m = marker(f, file);
    assert_eq!(m["attempts"], 2);
    assert_eq!(m["firstFailMs"], t0 as i64, "firstFailMs stays the first failure");
    assert_eq!(m["lastFailMs"], (t0 + base) as i64);
    // The second window is twice as long: one millisecond before 2 x base it is still closed.
    assert_eq!(call(f, t0 + base + 2.0 * base - 1.0), (0, 0, 1), "inside the second window");
    assert_eq!(marker(f, file)["attempts"], 2);
    assert_eq!(call(f, t0 + base + 2.0 * base), (0, 1, 0), "at the edge of the second window");
    assert_eq!(marker(f, file)["attempts"], 3);
}

#[test]
/// A bare-scalar `wal-cli.ndjson` is renamed, refused and marked; the retries follow base, 2 x base.
fn a_refused_cli_file_is_retried_only_after_a_doubling_window() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("cli");
    std::fs::write(f.day.join("wal-cli.ndjson"), "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    assert_eq!(call(&f, t0), (0, 1, 0), "the first attempt is refused");
    // The file went through the rename: the marker is on the .rot- name, which never changes again.
    assert!(!f.day.join("wal-cli.ndjson").exists());
    let rotated = names(&f.day, "wal-cli.rot-", ".ndjson");
    assert_eq!(rotated.len(), 1, "{rotated:?}");
    let m = marker(&f, &rotated[0]);
    assert_eq!(m["file"], rotated[0].as_str());
    assert_eq!(m["firstFailMs"], t0 as i64);
    assert_eq!(m["lastFailMs"], t0 as i64);
    let reason = m["reason"].as_str().unwrap();
    assert!(!reason.is_empty() && reason.chars().count() <= 500, "{reason}");
    assert_eq!(names(&f.day, "sealfail-", ".json"), vec![format!("sealfail-{}.json", rotated[0])]);
    assert_doubling_windows(&f, &rotated[0], t0);
    assert_eq!(names(&f.day, "wal-cli.rot-", ".ndjson"), rotated, "the same file throughout, never renamed again");
}

#[test]
/// A dead-pid `wal-1.ndjson` (an Orphan, never renamed) is refused and marked; the retries follow base, 2 x base.
fn a_refused_dead_pid_file_is_retried_only_after_a_doubling_window() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("deadpid");
    std::fs::write(f.day.join("wal-1.ndjson"), "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    assert_eq!(call(&f, t0), (0, 1, 0), "the first attempt is refused");
    assert_eq!(marker(&f, "wal-1.ndjson")["file"], "wal-1.ndjson");
    assert_doubling_windows(&f, "wal-1.ndjson", t0);
}

#[test]
/// A file refused once and then fixed is sealed at the window edge and its marker is removed.
fn the_marker_is_removed_after_a_successful_seal() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("success");
    let wal = f.day.join("wal-1.ndjson");
    std::fs::write(&wal, "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    assert_eq!(call(&f, t0), (0, 1, 0));
    assert_eq!(names(&f.day, "sealfail-", ".json").len(), 1);
    // The cause is fixed (the file now holds real samples), but the window is still closed: it waits.
    std::fs::write(&wal, valid_lines(3)).unwrap();
    assert_eq!(call(&f, t0 + BASE_MS as f64 - 1.0), (0, 0, 1));
    assert!(wal.exists());
    assert_eq!(names(&f.day, "sealfail-", ".json").len(), 1, "still marked inside the window");
    // At the edge the seal succeeds and the marker goes with the file.
    assert_eq!(call(&f, t0 + BASE_MS as f64), (1, 0, 0));
    assert!(!wal.exists());
    assert_eq!(names(&f.day, "part-", ".parquet").len(), 1);
    assert!(names(&f.day, "sealfail-", ".json").is_empty(), "the marker is removed after the seal");
}

#[test]
/// A marker without its file is removed on the next visit of its day; a marker with its file stays.
fn a_marker_whose_file_is_gone_is_removed_when_its_day_is_visited() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("ghost");
    std::fs::write(f.day.join("wal-1.ndjson"), "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    assert_eq!(call(&f, t0), (0, 1, 0));
    // A marker for a file that does not exist; the marker of the file that does exist is kept.
    let ghost = f.day.join(seal_marker_name("wal-9.ndjson"));
    std::fs::write(&ghost, "{\"file\":\"wal-9.ndjson\",\"firstFailMs\":1,\"lastFailMs\":1,\"attempts\":1,\"reason\":\"x\"}").unwrap();
    assert_eq!(call(&f, t0 + 1.0), (0, 0, 1));
    assert!(!ghost.exists(), "the marker of a missing file is removed");
    assert!(f.day.join(seal_marker_name("wal-1.ndjson")).exists(), "the marker of an existing file stays");
}

/// One refusal of `wal-1.ndjson` at `t0` under the given environment; returns the marker it wrote.
fn refuse_once_with(tag: &str, env: HashMap<String, String>) -> (Value, f64) {
    let f = Fixture::new(tag);
    std::fs::write(f.day.join("wal-1.ndjson"), "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    let counters = SealCounters::default();
    assert_eq!(maybe_seal(&f.root, &counters, &env, t0), 0);
    assert_eq!(counters.refused_files.load(Relaxed), 1);
    (marker(&f, "wal-1.ndjson"), t0)
}

#[test]
/// With the default base the marker names the sealer's own next retry: lastFailMs + 300000.
fn the_marker_names_the_next_retry_with_the_default_base() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (m, t0) = refuse_once_with("nextdefault", HashMap::new());
    assert_eq!(m["lastFailMs"], t0 as i64);
    assert_eq!(m["nextRetryMs"].as_i64().unwrap(), m["lastFailMs"].as_i64().unwrap() + 300_000);
}

#[test]
/// With the base 0 (no backoff) the marker's next retry is its last failure.
fn the_marker_names_the_next_retry_as_the_last_failure_with_base_zero() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let env = HashMap::from([("AGENTLENS_STATUSLINE_SEAL_RETRY_BASE_MS".to_owned(), "0".to_owned())]);
    let (m, t0) = refuse_once_with("nextzero", env);
    assert_eq!(m["lastFailMs"], t0 as i64);
    assert_eq!(m["nextRetryMs"], m["lastFailMs"]);
}

#[test]
/// A file refused for the 100th time names a next retry capped at 6 hours after its last failure.
fn the_marker_caps_the_next_retry_at_six_hours() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("nextcap");
    std::fs::write(f.day.join("wal-1.ndjson"), "42\n").unwrap();
    // 99 earlier refusals, long ago: the old window has passed, so this call attempts the file again.
    std::fs::write(f.day.join(seal_marker_name("wal-1.ndjson")), "{\"file\":\"wal-1.ndjson\",\"firstFailMs\":1,\"lastFailMs\":1,\"attempts\":99,\"reason\":\"x\"}").unwrap();
    let counters = SealCounters::default();
    assert_eq!(maybe_seal(&f.root, &counters, &HashMap::new(), agentlens_core::now_ms() as f64), 0);
    assert_eq!(counters.refused_files.load(Relaxed), 1);
    let m = marker(&f, "wal-1.ndjson");
    assert_eq!(m["attempts"], 100);
    assert_eq!(m["nextRetryMs"].as_i64().unwrap(), m["lastFailMs"].as_i64().unwrap() + 21_600_000);
}

#[test]
/// A marker stamped in the future (the clock was stepped back since) is not honoured: the file is attempted at once.
fn a_marker_stamped_in_the_future_does_not_pause_the_file() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("future");
    std::fs::write(f.day.join("wal-1.ndjson"), "42\n").unwrap();
    let t0 = agentlens_core::now_ms() as f64;
    // One refusal recorded one hour ahead of this call's clock.
    let ahead = (t0 as i64) + 3_600_000;
    std::fs::write(f.day.join(seal_marker_name("wal-1.ndjson")), format!("{{\"file\":\"wal-1.ndjson\",\"firstFailMs\":{ahead},\"lastFailMs\":{ahead},\"attempts\":1,\"reason\":\"x\"}}")).unwrap();
    assert_eq!(call(&f, t0), (0, 1, 0), "attempted, not skipped");
    assert_eq!(marker(&f, "wal-1.ndjson")["attempts"], 2);
}
