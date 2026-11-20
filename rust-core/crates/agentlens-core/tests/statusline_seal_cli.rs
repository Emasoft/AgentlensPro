//! TRDD-VS1FCUMU — `alcore statusline-seal --data-dir DIR` compacts the status-line store with
//! NO server. Owner order 2026-11-18: the status line is digested at all times, with no need for
//! the full server to be online.
//!
//! Each test builds its own store under the system temp dir and runs the real binary. The pairs
//! are built so that each rule can fail:
//! - today's small CLI file is left alone, the same file over the byte threshold is sealed;
//! - a per-pid file is left alone when the pidfile names a live owner, sealed when it does not;
//! - a sealer seals nothing while the lock is held, and seals once it is free.

#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use fs2::FileExt;

const PAST: &str = "2020-01-01";

struct Store {
    base: PathBuf,
}

impl Store {
    fn new(tag: &str) -> Store {
        // The system temp dir, never the cargo target tmp dir: the test-data cap redirects TMPDIR.
        let base = std::env::temp_dir().join(format!("sl-seal-{tag}-{}-{}", std::process::id(), agentlens_core::now_ms()));
        std::fs::create_dir_all(base.join("statusline")).unwrap();
        Store { base }
    }

    fn root(&self) -> PathBuf {
        self.base.join("statusline")
    }

    fn day_dir(&self, day: &str) -> PathBuf {
        let d = self.root().join("main").join(day);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Run the real binary on this store. Returns (exit code, stdout).
    fn seal(&self, env: &[(&str, &str)]) -> (i32, String) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_alcore"));
        cmd.arg("statusline-seal").arg("--data-dir").arg(&self.base);
        // The knobs under test are set per call; an ambient value must not leak in.
        for k in ["AGENTLENS_STATUSLINE_CLI_SEAL_BYTES", "AGENTLENS_STATUSLINE_SEAL_BUDGET_MS", "AGENTLENS_STATUSLINE_SEAL_ROWS", "AGENTLENS_STATUSLINE_SEAL_TEST_HOLD_MS", "AGENTLENS_STATUSLINE_SEAL_TEST_DEFAULT_SAMPLE", "AGENTLENS_STATUSLINE_SEAL_RETRY_BASE_MS"] {
            cmd.env_remove(k);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Rows the store's own reader returns for the `main` stream (parts and write-ahead files).
    fn rows(&self) -> f64 {
        let rows = agentlens_core::statusline_store::query_statusline(
            &self.root(),
            "main",
            "SELECT count(*) AS n FROM samples",
            None,
            None,
            &HashMap::new(),
        )
        .unwrap()
        .expect("the store holds data");
        rows[0]["n"].as_f64().unwrap()
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

fn lines(n: usize) -> String {
    (0..n)
        .map(|i| format!("{{\"ts\":{},\"session_id\":\"s{}\",\"statusline_stream\":\"main\",\"n\":{i}}}\n", 1_577_836_800_000u64 + i as u64, i % 2))
        .collect()
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

fn today() -> String {
    agentlens_core::statusline_store::day_key(agentlens_core::now_ms() as f64)
}

#[test]
fn past_day_cli_file_becomes_one_part_and_no_write_ahead_file_is_left() {
    let s = Store::new("past");
    let d = s.day_dir(PAST);
    std::fs::write(d.join("wal-cli.ndjson"), lines(3)).unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert_eq!(names(&d, "part-", ".parquet").len(), 1, "one parquet part");
    assert!(names(&d, "wal-", ".ndjson").is_empty(), "no write-ahead file and no renamed one is left");
    assert_eq!(s.rows(), 3.0, "every row is in the part");
}

#[test]
fn todays_small_cli_file_is_left_alone() {
    let s = Store::new("small");
    let d = s.day_dir(&today());
    let body = lines(3);
    std::fs::write(d.join("wal-cli.ndjson"), &body).unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 0 WAL"), "{out}");
    assert_eq!(std::fs::read_to_string(d.join("wal-cli.ndjson")).unwrap(), body, "the file is byte-identical");
    assert!(names(&d, "part-", ".parquet").is_empty(), "no part");
}

#[test]
fn todays_cli_file_over_the_byte_threshold_is_sealed() {
    let s = Store::new("big");
    let d = s.day_dir(&today());
    std::fs::write(d.join("wal-cli.ndjson"), lines(3)).unwrap();
    let (code, out) = s.seal(&[("AGENTLENS_STATUSLINE_CLI_SEAL_BYTES", "64")]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert_eq!(names(&d, "part-", ".parquet").len(), 1);
    assert!(names(&d, "wal-", ".ndjson").is_empty());
    assert_eq!(s.rows(), 3.0);
}

#[test]
fn the_live_servers_own_file_is_never_touched() {
    let s = Store::new("live");
    let d = s.day_dir(PAST);
    // This test process plays the live server: the pidfile names it, and so does the file.
    let me = std::process::id();
    std::fs::write(s.base.join("server.pid"), agentlens_core::pid_lock::format_pid_lock(me, None)).unwrap();
    let wal = d.join(format!("wal-{me}.ndjson"));
    let body = lines(3);
    std::fs::write(&wal, &body).unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 0 WAL"), "{out}");
    assert_eq!(std::fs::read_to_string(&wal).unwrap(), body, "the live server's file is byte-identical");
    assert!(names(&d, "part-", ".parquet").is_empty(), "no part");
}

#[test]
fn a_per_pid_file_with_no_live_owner_is_sealed() {
    // The same file name as the test above, but no pidfile: nobody owns the data dir, so the
    // file is a dead server's and is sealed in place.
    let s = Store::new("orphan");
    let d = s.day_dir(PAST);
    std::fs::write(d.join(format!("wal-{}.ndjson", std::process::id())), lines(3)).unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert!(names(&d, "wal-", ".ndjson").is_empty());
    assert_eq!(s.rows(), 3.0);
}

#[test]
fn a_second_sealer_seals_nothing_while_the_lock_is_held() {
    let s = Store::new("lock");
    let d = s.day_dir(PAST);
    std::fs::write(d.join("wal-cli.ndjson"), lines(3)).unwrap();
    let lock = std::fs::OpenOptions::new().create(true).append(true).open(s.root().join(".seal.lock")).unwrap();
    lock.lock_exclusive().unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 0 WAL"), "{out}");
    assert_eq!(names(&d, "wal-", ".ndjson"), vec!["wal-cli.ndjson".to_owned()], "untouched, not even renamed");
    drop(lock);
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert_eq!(s.rows(), 3.0);
}

#[test]
fn a_missing_data_dir_argument_exits_64_and_a_missing_store_exits_0() {
    let out = Command::new(env!("CARGO_BIN_EXE_alcore")).arg("statusline-seal").output().unwrap();
    assert_eq!(out.status.code(), Some(64), "no --data-dir is a usage error");
    let empty = std::env::temp_dir().join(format!("sl-seal-nostore-{}-{}", std::process::id(), agentlens_core::now_ms()));
    std::fs::create_dir_all(&empty).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_alcore")).arg("statusline-seal").arg("--data-dir").arg(&empty).output().unwrap();
    let _ = std::fs::remove_dir_all(&empty);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("no store at"));
}

#[test]
fn a_line_appended_after_the_part_was_written_is_not_deleted_with_the_file() {
    // A status-line hook process that opened `wal-cli.ndjson` before the sealer renamed it writes
    // its line late: after the sealer read the file into the part. This test plays that hook
    // with a file handle opened before the sealer starts. The sealer must drop its part and keep
    // the file, and the next run seals all four lines.
    use std::io::Write;
    let s = Store::new("late");
    let d = s.day_dir(PAST);
    std::fs::write(d.join("wal-cli.ndjson"), lines(3)).unwrap();
    let mut late = std::fs::OpenOptions::new().append(true).open(d.join("wal-cli.ndjson")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_alcore"))
        .arg("statusline-seal")
        .arg("--data-dir")
        .arg(&s.base)
        .env_remove("AGENTLENS_STATUSLINE_SEAL_BUDGET_MS")
        .env("AGENTLENS_STATUSLINE_SEAL_TEST_HOLD_MS", "3000")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // The part file appears when the COPY starts. Half a second later the COPY and its row-count
    // check are over (three lines) and the sealer sits in the 3 s hold before the delete.
    let t0 = std::time::Instant::now();
    while names(&d, "part-", ".parquet").is_empty() {
        assert!(t0.elapsed() < std::time::Duration::from_secs(60), "the sealer never wrote a part");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    late.write_all(b"{\"ts\":1577836800999,\"session_id\":\"s9\",\"statusline_stream\":\"main\",\"n\":99}\n").unwrap();
    drop(late);
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    assert_eq!(out.status.code(), Some(0), "{text}");
    assert!(text.contains("sealed 0 WAL"), "the grown file must not be sealed: {text}");
    assert!(text.contains("refused 0"), "a length change is kept, not refused: {text}");
    assert!(names(&d, "sealfail-", ".json").is_empty(), "a length change is kept, not refused, so it leaves no marker");
    assert!(names(&d, "part-", ".parquet").is_empty(), "the part that misses the late line is removed");
    assert_eq!(names(&d, "wal-", ".ndjson").len(), 1, "the renamed write-ahead file is kept");
    assert_eq!(s.rows(), 4.0, "all four lines are still readable");
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert!(names(&d, "wal-", ".ndjson").is_empty(), "nothing is left to seal");
    assert_eq!(s.rows(), 4.0, "the late line is in the part");
}

/// 30,000 lines, past the reader's default schema sample: the LAST line adds the key `late_key`
/// and turns the integer `n` into 1.5.
fn late_key_file() -> String {
    let mut body = lines(29_999);
    body.push_str("{\"ts\":1577836900000,\"session_id\":\"s0\",\"statusline_stream\":\"main\",\"n\":1.5,\"late_key\":7}\n");
    body
}

/// (rows, rows with late_key, max late_key, sum of n) as the store's own reader returns them.
fn late_key_stats(s: &Store) -> (f64, f64, f64, f64) {
    let rows = agentlens_core::statusline_store::query_statusline(
        &s.root(),
        "main",
        "SELECT count(*) AS total, count(late_key) AS c, max(late_key) AS m, sum(n) AS s FROM samples",
        None,
        None,
        &HashMap::new(),
    )
    .unwrap()
    .expect("the store holds data");
    let f = |k: &str| rows[0][k].as_f64().unwrap();
    (f("total"), f("c"), f("m"), f("s"))
}

#[test]
fn a_key_first_seen_after_the_schema_sample_is_kept_and_a_late_fraction_is_not_rounded() {
    let s = Store::new("latekey");
    let d = s.day_dir(PAST);
    std::fs::write(d.join("wal-cli.ndjson"), late_key_file()).unwrap();
    let (code, out) = s.seal(&[]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 1 WAL"), "{out}");
    assert!(names(&d, "wal-", ".ndjson").is_empty(), "the numbers below are read from the part alone");
    assert_eq!(late_key_stats(&s), (30_000.0, 1.0, 7.0, 449_955_002.5), "rows, rows with late_key, its value, the sum of n with its fraction");
}

#[test]
fn a_part_that_lacks_a_key_of_the_file_is_dropped_and_the_file_is_kept() {
    // The debug-only knob restores the reader's default schema sample, so the part of this file
    // lacks `late_key` while its row count matches: the case the key check exists for.
    let s = Store::new("keygate");
    let d = s.day_dir(PAST);
    std::fs::write(d.join("wal-cli.ndjson"), late_key_file()).unwrap();
    let (code, out) = s.seal(&[("AGENTLENS_STATUSLINE_SEAL_TEST_DEFAULT_SAMPLE", "1")]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("sealed 0 WAL(s), refused 1"), "{out}");
    assert!(names(&d, "part-", ".parquet").is_empty(), "the part that lacks the key is removed");
    assert_eq!(names(&d, "wal-", ".ndjson").len(), 1, "the file is kept");
    assert_eq!(s.rows(), 30_000.0, "every row is still readable from the kept file");
    assert_eq!(names(&d, "sealfail-", ".json").len(), 1, "the refusal left one marker beside the file");
    // Without the knob the same file seals whole. TRDD-RTHA7EWK item 5: the refusal above left a
    // marker with the default 5 minute backoff, which would skip the file now; a base of 0 turns the
    // backoff off, so this second call attempts it at once.
    let (code, out) = s.seal(&[("AGENTLENS_STATUSLINE_SEAL_RETRY_BASE_MS", "0")]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(names(&d, "part-", ".parquet").len(), 1, "one part");
    assert!(names(&d, "wal-", ".ndjson").is_empty(), "no write-ahead file is left");
    assert!(names(&d, "sealfail-", ".json").is_empty(), "the seal removed the marker");
    assert_eq!(late_key_stats(&s), (30_000.0, 1.0, 7.0, 449_955_002.5));
}
