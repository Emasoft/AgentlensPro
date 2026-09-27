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
    check_and_enforce, format_diagnostic, mimalloc_info, rss_hard_cap_bytes, CulpritSnapshot, MimallocInfo,
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
    MimallocInfo { current_rss_bytes, peak_rss_bytes: current_rss_bytes, current_commit_bytes: current_rss_bytes, page_faults: 9 }
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
/// Also platform-scoped: on non-macOS the metric comes from the constant fallback closure below,
/// so the breach BRANCH is exercised everywhere but the real memory reading only on macOS.
///
/// THE OWNER DIRECTIVE'S DELIVERABLE, WHICH HAD NEVER EXECUTED ONCE: on breach, flush, write a
/// culprit log, and exit non-zero. Every other test here covers the env parser, the pure string
/// builder (`format_diagnostic`), or the NO-OP branch — so the breach branch of the shipped
/// function had no coverage whatsoever.
///
/// Runs the real `check_and_enforce` in a re-exec of this test binary, NOT a reimplementation of
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
        // cap 0 => breaches on every platform: macOS reads a real non-zero footprint, and the
        // non-macOS fallback below returns a GB-scale value. So the test never depends on
        // allocating a specific amount. The sentinel's EXISTENCE after the child dies is the
        // proof the closure ran BEFORE exit() — `exit` skips destructors, so a flush ordered
        // after it would lose buffered spans at exactly the moment this guard fires.
        //
        // Deliberately NOT `.unwrap()` in the closure: a panic here would abort inside
        // check_and_enforce, skip the log write, and fail three assertions at once with exit 101
        // and no obvious cause. Letting the write fail silently fails ONE assertion, precisely.
        check_and_enforce(
            || 4 * 1024 * 1024 * 1024,
            || { let _ = std::fs::write(&sentinel, b"1"); },
            &log,
            snap(0),
        );
        unreachable!("check_and_enforce must never return on breach");
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

/// THE `<=` BOUNDARY — the one input no other test in this file supplies. `check_and_enforce`
/// returns when `metric_bytes <= cap`, so the cap is INCLUSIVE: sitting exactly AT it is not a
/// breach. Flipping that to `<` changes behaviour for exactly ONE value, `metric == cap`, and
/// measured 2026-09-08 all six other tests stay green under that flip. Testing "closer to the cap"
/// would not have helped — only the exact value discriminates.
///
/// The detector is the flush closure panicking, not the log assertion: `flush_before_exit()` runs
/// FIRST on the breach path, so under the mutation this fails by unwinding with a clear message
/// rather than reaching `std::process::exit(1)` and killing the whole test runner.
///
/// **NOT COMPILED ON macOS, and that gate is load-bearing — MEASURED, not assumed.** Ungated, this
/// test passes on macOS *under the mutation* (verified 2026-09-08: `<=`→`<`, boundary test green).
/// `primary_metric` reads the process's real phys_footprint there and IGNORES the fallback closure,
/// so the metric is ~2.4 MB against a 4 GiB cap — under the cap, never AT it, and the test silently
/// degrades into a duplicate of `under_cap_is_a_no_op_and_writes_no_log`. On the fallback path the
/// closure IS the metric, so `cap == fallback` is exact and the assertion discriminates.
///
/// Consequence worth stating plainly: this test has NEVER RUN in its discriminating form on the
/// development machine. Its first real execution is Linux CI. Gating it is still right — a test
/// that is green-but-blind on the platform you develop on is worse than one that is absent there,
/// because the green is mistaken for coverage.
#[cfg(not(target_os = "macos"))]
#[test]
fn cap_boundary_is_inclusive_metric_equal_to_cap_is_a_no_op() {
    let log = tmp_log("boundary");
    const AT_CAP: u64 = 4 * 1024 * 1024 * 1024;
    check_and_enforce(
        || AT_CAP,
        || panic!("flush must NOT run when the metric merely EQUALS the cap — the cap is inclusive"),
        &log,
        snap(AT_CAP),
    );
    assert!(!log.exists(), "metric == cap is not a breach; no culprit log may be written");
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
    let mi = fake_mimalloc(400 * 1024 * 1024);
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
    assert!(d.contains(": 2672 MB"), "floor arithmetic (3072-400) must be exact; got:\n{d}");
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
