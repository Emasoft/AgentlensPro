//! `rss_guard` — hard memory ceiling (owner directive: alcore must exit(1) with a culprit
//! diagnostic past AGENTLENS_RSS_HARD_CAP_MB, default 2048). We never exercise the real
//! `exit(1)` path here (it would kill the test process) — we test the pure formatting/parsing
//! functions instead, plus `check_and_enforce`'s no-op branch, which is the only branch safe to
//! call directly.
//!
//! TRDD-WKLD508O: the diagnostic must separate the Rust heap (mimalloc, via `mi_process_info`)
//! from non-Rust growth (e.g. DuckDB) — a log naming only cheap counters (span/card counts) does
//! not identify a culprit when those structures are small but the process is not.

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

#[test]
fn under_cap_is_a_no_op_and_writes_no_log() {
    let log = tmp_log("noop");
    // Would exit(1) on breach; calling it under-cap must return normally and touch nothing.
    check_and_enforce(1024 * 1024 * 1024, &log, snap(2048 * 1024 * 1024));
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
    assert!(d.contains("mimalloc (Rust heap): current 400 MB"));
    assert!(d.contains("non-mimalloc"), "must separate non-Rust growth: {d}");
    assert!(d.contains("resident spans: 42"));
    assert!(d.contains("effective 60000 ms / configured 86400000 ms"));
    assert!(d.contains("card store rows: 7"));
    assert!(d.contains("3 segments, 1000 spans, 500000 bytes"));
    assert!(d.contains("uptime: 123456 ms"));
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
