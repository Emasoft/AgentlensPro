//! `rss_guard` — hard memory ceiling (owner directive: alcore must exit(1) with a culprit
//! diagnostic past AGENTLENS_RSS_HARD_CAP_MB, default 2048).
//!
//! This header used to say the real `exit(1)` path could not be tested here because it would kill
//! the test process, and that the no-op branch was "the only branch safe to call directly". That
//! was true of an IN-PROCESS call and false of the path itself: re-exec this binary as a child and
//! the exit becomes an ordinary observable outcome. The consequence of believing it was that
//! `write_log_file` was executed by no test at all, `flush_before_exit` was never shown to run,
//! and the exit code was never asserted — i.e. the guard's whole reason to exist was the one
//! unmeasured thing. `breach_flushes_writes_the_culprit_log_and_exits_1` closes that.
//!
//! TRDD-WKLD508O: the diagnostic must separate whole-process RSS from mimalloc's own commit
//! counter (`mi_process_info`) and from non-Rust growth (e.g. DuckDB) — a log naming only cheap
//! counters (span/card counts) does not identify a culprit when those structures are small but
//! the process is not.

use agentlens_core::rss_guard::{
    check_and_enforce, check_and_enforce_with, format_diagnostic, mimalloc_info, rss_hard_cap_bytes, CulpritSnapshot, MimallocInfo,
};

fn snap(cap_bytes: u64) -> CulpritSnapshot {
    CulpritSnapshot {
        cap_bytes,
        resident_spans: Some(42),
        window_effective_ms: Some(60_000),
        window_configured_ms: Some(86_400_000),
        card_count: Some(7),
        span_store_segments: Some(3),
        span_store_total_spans: Some(1000),
        span_store_total_bytes: Some(500_000),
        uptime_ms: Some(123_456),
    }
}

fn fake_mimalloc(current_rss_bytes: u64) -> MimallocInfo {
    MimallocInfo {
        current_rss_bytes,
        peak_rss_bytes: current_rss_bytes,
        current_commit_bytes: current_rss_bytes,
        page_faults: 9,
        pages_abandoned: 0,
        pages_abandoned_peak: 0,
        committed_current_bytes: current_rss_bytes,
        reset_total_bytes: 0,
        purged_total_bytes: 0,
    }
}

fn tmp_log(tag: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(format!("al-rss-hard-cap-{}-{tag}.log", std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

/// WHAT THIS TEST DOES **NOT** COVER — read before trusting its name. It asserts a CONJUNCTION
/// (flush happened, log written, exit 1), NOT a SEQUENCE, and two real regressions pass it:
///
///  - **flush vs. log-write ordering.** Moving `flush_before_exit()` to after `write_log_file()`
///    keeps every assertion green. (The sentinel DOES prove the flush ran before `exit` — a flush
///    ordered after `exit` never runs at all — but nothing here pins it before the log write.)
///  - ~~**the cap boundary.**~~ CLOSED by `cap_boundary_is_inclusive_metric_equal_to_cap_is_a_no_op`
///    below. The note that stood here was measured-true but explained wrong, so it is kept as a
///    warning: it said the `<=`→`<` flip survives because neither test "sits near the boundary",
///    implying the fix was to test CLOSER to the cap. That is false and would have produced
///    another blind test — the flip changes behaviour for exactly ONE input, `metric == cap`, so a
///    test at `cap - 1` is as blind as one at `cap / 2`. Distance is irrelevant; only the exact
///    value discriminates.
///
/// The commit reading is injected below, so the breach BRANCH runs on every platform. No test drives
/// the real `mi_commit_bytes` reader to a breach: a test binary's commit reads ~0.
///
/// THE OWNER DIRECTIVE'S DELIVERABLE, WHICH HAD NEVER EXECUTED ONCE: on breach, flush, write a
/// culprit log, and exit non-zero. Every other test here covers the env parser, the pure string
/// builder (`format_diagnostic`), or the NO-OP branch — so the breach branch of the shipped
/// function had no coverage whatsoever.
///
/// Runs the real `check_and_enforce_with` in a re-exec of this test binary, NOT a reimplementation of
/// its logic, which would test a copy and prove nothing about the shipped path. The subprocess
/// also buys the property an in-process refactor could not: it proves the log survives the
/// process's actual death, which is the historical failure this guard exists for — a startup
/// crash on this project once left `server.log` completely empty.
#[test]
fn breach_flushes_writes_the_culprit_log_and_exits_1() {
    const MARKER: &str = "AGENTLENS_RSS_GUARD_BREACH_CHILD";

    if let Ok(child_log) = std::env::var(MARKER) {
        let log = std::path::PathBuf::from(&child_log);
        let sentinel = log.with_extension("flushed");
        // cap 0 with an injected commit of 4 GB breaches on every platform. The commit is injected
        // because test binaries do not run mimalloc as their global allocator, so the real reading is
        // ~0 here. The sentinel's EXISTENCE after the child dies is the proof the closure ran BEFORE
        // exit() — `exit` skips destructors, so a flush ordered after it would lose buffered spans at
        // exactly the moment this guard fires.
        //
        // Deliberately NOT `.unwrap()` in the closure: a panic here would abort inside
        // check_and_enforce_with, skip the log write, and fail three assertions at once with exit 101
        // and no obvious cause. Letting the write fail silently fails ONE assertion, precisely.
        check_and_enforce_with(
            || 4 * 1024 * 1024 * 1024,
            || 4 * 1024 * 1024 * 1024,
            || { let _ = std::fs::write(&sentinel, b"1"); },
            &log,
            snap(0),
        );
        unreachable!("check_and_enforce_with must never return on breach");
    }

    let log = tmp_log("breach"); // embeds this process's pid, and unlinks any leftover
    let sentinel = log.with_extension("flushed");
    let _ = std::fs::remove_file(&sentinel);
    // GROUND STATE, ASSERTED NOT ASSUMED. write_log_file opens append+create and the checks below
    // are `contains`, so a file left by an earlier run would satisfy every one of them even if
    // this child wrote nothing — the assertions would pass vacuously on stale evidence. tmp_log
    // and the unlink above both DISCARD their errors, so this is the only thing standing between
    // a failed unlink and a green test that measured nothing.
    assert!(!log.exists() && !sentinel.exists(), "stale fixtures: the assertions below would pass vacuously");

    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["breach_flushes_writes_the_culprit_log_and_exits_1", "--exact", "--nocapture"])
        .env(MARKER, &log)
        .output()
        .expect("re-exec this test binary as a child");

    // The hint BRANCHES ON THE OBSERVED CODE. An earlier version stated the 101 explanation
    // unconditionally, so an exit(0) failure printed "the metric probably read 0" directly above
    // `left: Some(0)` and a stderr full of the diagnostic that had plainly just run — a
    // wrong-culprit message inside the test whose own subject is a wrong-culprit guard.
    let hint = match out.status.code() {
        Some(101) => "the child PANICKED, almost certainly on the `unreachable!` above — meaning \
                      check_and_enforce RETURNED, so no breach was detected. That is the historical \
                      defect: the metric read 0 and silently disabled the cap at every threshold",
        Some(0) => "the child exited 0 — the guard ran but did not exit with ERROR, which is the \
                    directive's actual requirement",
        Some(_) => "the child exited with an unexpected non-zero code — not the guard's exit(1)",
        None => "the child was killed by a signal (see stderr) — SIGKILL under memory pressure, or \
                 a crash inside the guard itself",
    };
    assert_eq!(
        out.status.code(), Some(1),
        "breach must exit(1): {hint}. stderr:\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(sentinel.exists(), "flush_before_exit must run BEFORE exit(1)");

    let body = std::fs::read_to_string(&log).expect("culprit log must exist on disk after the child exits");
    // Assert EXECUTION and that real culprit data reached the file — not the format, which
    // `diagnostic_names_the_culprit_counters_on_breach` already locks via format_diagnostic.
    // Duplicating all eight lines here would just fail in two places on any wording change.
    // "resident spans: 42" is the load-bearing one: 42 comes from snap(), so it proves the
    // caller's snapshot was threaded through to disk rather than some default being printed.
    assert!(body.contains("RSS HARD CAP"), "log must be the guard diagnostic; got:\n{body}");
    assert!(body.contains("process RSS") && body.contains("mimalloc commit"), "TRDD-WKLD508O: the log must separate process RSS from the mimalloc heap (commit counter); got:\n{body}");
    assert!(body.contains("resident spans: 42"), "the caller's snapshot must reach the log, or it names no culprit; got:\n{body}");

    let _ = std::fs::remove_file(&log);
    let _ = std::fs::remove_file(&sentinel);
}

/// THE `<=` BOUNDARY — the one input no other test in this file supplies. `check_and_enforce_with`
/// returns when the commit reading is `<=` the cap, so the cap is INCLUSIVE: sitting exactly AT it is
/// not a breach. Flipping that to `<` changes behaviour for exactly ONE value, `commit == cap`, and no
/// other test here supplies it. Testing "closer to the cap" would not help — only the exact value
/// discriminates.
///
/// The commit reading is injected, so this runs on every platform and the decision is always the
/// injected value.
///
/// The detector is the flush closure panicking: `flush_before_exit()` runs FIRST on the breach path,
/// so under the mutation this fails by unwinding with a clear message rather than reaching
/// `std::process::exit(1)` and killing the whole test runner.
#[test]
fn cap_boundary_is_inclusive_metric_equal_to_cap_is_a_no_op() {
    let log = tmp_log("boundary");
    const AT_CAP: u64 = 4 * 1024 * 1024 * 1024;
    check_and_enforce_with(
        || AT_CAP,
        || AT_CAP,
        || panic!("flush must NOT run when the commit merely EQUALS the cap — the cap is inclusive"),
        &log,
        snap(AT_CAP),
    );
    assert!(!log.exists(), "commit == cap is not a breach; no culprit log may be written");
}

#[test]
fn under_cap_is_a_no_op_and_writes_no_log() {
    let log = tmp_log("noop");
    // Would exit(1) on breach; calling it under-cap must return normally and touch nothing.
    check_and_enforce(|| 1024 * 1024 * 1024, || {}, &log, snap(2048 * 1024 * 1024));
    assert!(!log.exists(), "no diagnostic should be written when under the cap");
}

#[test]
fn diagnostic_names_the_culprit_counters_on_breach() {
    let cap = 2048u64 * 1024 * 1024;
    let rss = 3 * 1024 * 1024 * 1024; // 3 GB, over the 2 GB cap
    let mut mi = fake_mimalloc(400 * 1024 * 1024);
    mi.current_commit_bytes = 2_600 * 1024 * 1024; // the decision counter, over the 2048 MB cap
    let d = format_diagnostic("rss", rss, &mi, &snap(cap));
    for line in d.lines() {
        assert!(line.starts_with("alcore: RSS HARD CAP —"), "line not prefixed for grep: {line}");
    }
    assert!(d.contains("3072 MB"), "measured value in MB missing: {d}");
    assert!(d.contains("2048 MB"), "cap in MB missing: {d}");
    assert!(d.contains("process RSS 400 MB"), "current_rss must be labelled process RSS, not mimalloc heap: {d}");
    assert!(d.contains("non-mimalloc"), "must separate non-Rust growth: {d}");
    assert!(d.contains("non-mimalloc-dirty floor"), "floor must be computed from mimalloc commit, not process RSS: {d}");
    assert!(d.contains("non-mimalloc-dirty floor (= rss minus mimalloc commit"), "floor header must interpolate the metric name; got:\n{d}");
    assert!(d.contains("mimalloc commit 2600 MB > cap 2048 MB"), "the breach line must lead with the decision counter; got:\n{d}");
    assert!(d.contains(": 472 MB"), "floor arithmetic (3072-2600) must be exact; got:\n{d}");
    assert!(d.contains("resident spans: 42"));
    assert!(d.contains("effective 60000 ms / configured 86400000 ms"));
    assert!(d.contains("card store rows: 7"));
    assert!(d.contains("3 segments, 1000 spans, 500000 bytes"));
    assert!(d.contains("uptime: 123456 ms"));
}

#[test]
fn floor_saturates_to_zero_when_commit_meets_the_metric() {
    // Real-kill shape: commit >= footprint (mimalloc has committed pages the metric never
    // charged). saturating_sub must yield 0, never wrap.
    let cap = 2048u64 * 1024 * 1024;
    let d = format_diagnostic("rss", 400 * 1024 * 1024, &fake_mimalloc(400 * 1024 * 1024), &snap(cap));
    assert!(d.contains(": 0 MB"), "floor must saturate to 0 MB when commit >= metric; got:\n{d}");
}

#[test]
fn diagnostic_reports_missing_counters_instead_of_omitting_them() {
    let mut s = snap(2048 * 1024 * 1024);
    s.resident_spans = None;
    s.card_count = None;
    s.span_store_segments = None;
    s.span_store_total_spans = None;
    s.span_store_total_bytes = None;
    s.uptime_ms = None;
    let d = format_diagnostic("rss", 3 * 1024 * 1024 * 1024, &fake_mimalloc(0), &s);
    assert!(d.contains("resident spans: unavailable"));
    assert!(d.contains("card store rows: unavailable"));
    assert!(d.contains("uptime: unavailable"));
}

#[test]
fn mimalloc_info_returns_without_crashing() {
    // Not asserting on the values: the test binary may or may not have MiMalloc as its global
    // allocator, so current_rss can legitimately read near-zero. The point is the FFI call is
    // wired correctly and doesn't panic/segfault.
    let mi = mimalloc_info();
    assert!(mi.current_rss_bytes < u64::MAX);
}

// Both env-var cases live in ONE test: cargo runs tests in a binary as parallel threads by
// default, and two tests mutating the same process-wide env var concurrently would race.
#[test]
fn env_override_parses_valid_rejects_zero_and_garbage() {
    std::env::set_var("AGENTLENS_RSS_HARD_CAP_MB", "512");
    assert_eq!(rss_hard_cap_bytes(), 512 * 1024 * 1024);

    std::env::set_var("AGENTLENS_RSS_HARD_CAP_MB", "0");
    assert_eq!(rss_hard_cap_bytes(), 2048 * 1024 * 1024);

    std::env::set_var("AGENTLENS_RSS_HARD_CAP_MB", "not-a-number");
    assert_eq!(rss_hard_cap_bytes(), 2048 * 1024 * 1024);

    std::env::remove_var("AGENTLENS_RSS_HARD_CAP_MB");
}

/// Kills the spawned alcore when the test ends, pass or fail, so a failed assertion cannot leak a server.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Ok(None) = self.0.try_wait() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

/// Parses the breach line of the culprit log, `alcore: RSS HARD CAP — mimalloc commit N MB > cap 1 MB, exiting (evidence: NAME M MB)`,
/// into `(commit_mb, NAME, M)`. Plain string parsing: write_diagnostic fixes the format, and a line that does not match returns None,
/// so the caller fails rather than passing on missing evidence.
fn parse_breach_evidence(log: &str) -> Option<(u64, &str, u64)> {
    let rest = log.lines().find_map(|line| line.split_once("RSS HARD CAP — mimalloc commit ").map(|(_, rest)| rest))?;
    let (commit, rest) = rest.split_once(" MB > cap 1 MB, exiting (evidence: ")?;
    let (name, rest) = rest.split_once(" ")?;
    let evidence = rest.strip_suffix(" MB)")?;
    Some((commit.parse().ok()?, name, evidence.parse().ok()?))
}

/// THE REAL READER THROUGH THE SHIPPED BINARY. The other tests here inject the commit reading; this one
/// starts `alcore serve` with a 1 MB cap and lets the real `mi_commit_bytes` reader breach it. The exit
/// code alone proves nothing: a panic also exits 1 (`install_exit_on_panic`), so the test asserts that the
/// culprit log was written and that its breach line reports a commit which is positive and at or below the
/// footprint evidence. Whole-process RSS or another mi_process_info slot would also breach a 1 MB cap, and
/// the commit-not-above-evidence bound is what catches that. The Apple Silicon linker ad-hoc signs cargo output,
/// (codesign -dvv reads linker-signed), so the test runs the binary as built and never re-signs it.
#[test]
fn real_alcore_binary_breaches_a_1mb_cap_on_mimalloc_commit() {
    let bin = std::path::PathBuf::from(env!("CARGO_BIN_EXE_alcore"));

    let root = std::env::temp_dir().join(format!("al-rss-real-breach-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (data, home) = (root.join("data"), root.join("home"));
    std::fs::create_dir_all(&data).expect("create the isolated data dir");
    std::fs::create_dir_all(&home).expect("create the isolated HOME");
    let media = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../media");
    let stderr_path = root.join("stderr.txt");

    // Free ports, picked at runtime: fixed ports collide with other runs. The listeners stay bound until
    // every port is read, so the OS cannot hand the same ephemeral port out twice.
    let listeners: Vec<std::net::TcpListener> =
        (0..3).map(|_| std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port")).collect();
    let ports: Vec<String> = listeners
        .iter()
        .map(|l| l.local_addr().expect("read the ephemeral port").port().to_string())
        .collect();
    drop(listeners);

    let child = std::process::Command::new(&bin)
        .arg("serve")
        .arg("--data-dir")
        .arg(&data)
        .arg("--media-dir")
        .arg(&media)
        .args(["--bind", "127.0.0.1", "--ui-port", ports[0].as_str(), "--mcp-port", ports[1].as_str(), "--otlp-port", ports[2].as_str(), "--no-log-scan"])
        .env("AGENTLENS_RSS_HARD_CAP_MB", "1")
        .env("HOME", &home)
        .stdout(std::fs::File::create(root.join("stdout.txt")).expect("create the stdout file"))
        .stderr(std::fs::File::create(&stderr_path).expect("create the stderr file"))
        .spawn()
        .expect("spawn alcore");
    let mut server = KillOnDrop(child);

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let status = loop {
        if let Some(status) = server.0.try_wait().expect("poll alcore") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "alcore did not exit within 60 s; stderr:\n{}",
            std::fs::read_to_string(&stderr_path).unwrap_or_default()
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    };

    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    assert_eq!(status.code(), Some(1), "alcore must exit 1 on breach; stderr:\n{stderr}");
    assert!(!stderr.contains("panicked"), "exit 1 came from a panic, not the guard; stderr:\n{stderr}");
    let log = std::fs::read_to_string(data.join("rss-hard-cap.log")).expect("the breach must write the culprit log");
    // The log prints whole MB, so commit and evidence can print equal: the bound is non-strict on purpose.
    let (commit_mb, evidence, evidence_mb) =
        parse_breach_evidence(&log).unwrap_or_else(|| panic!("the culprit log must carry the breach line; got:\n{log}"));
    assert!(commit_mb > 0, "mimalloc commit must be positive on a real breach; got:\n{log}");
    assert!(
        commit_mb <= evidence_mb,
        "mimalloc commit ({commit_mb} MB) must not exceed the {evidence} evidence ({evidence_mb} MB); got:\n{log}"
    );
    let _ = std::fs::remove_dir_all(&root);
}
