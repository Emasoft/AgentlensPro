//! Hard memory ceiling — owner directive: "alcore must not use more than 2 gb of ram. if it ever
//! uses more than that, it must exit with error and a log that will allow us to identify the
//! culprit, so we will fix the code." This is FAIL-FAST, not a valve: `lib.rs::rss_budget_bytes`
//! (default 4096 MB) already narrows the summarization window as RSS climbs — a soft mitigation
//! that can fail to bring memory back down (a leak outside the window, or growth in the card
//! store / span store / a non-Rust allocator). This module is the backstop.
//!
//! TRDD-WKLD508O correction: the cheap counters alone (span count, card rows, uptime) do NOT
//! identify a culprit — a measured live process held 397 spans at 5.4 GB footprint, so "397
//! spans, 5.4 GB" tells nobody what to fix. Two things actually attribute the memory:
//!
//! 1. **mimalloc's own stats** (`mi_process_info`) — alcore.rs sets `mimalloc::MiMalloc` as the
//!    global allocator, so this is the Rust heap, separated from non-Rust growth (DuckDB, which
//!    allocates through its own C allocator, not through Rust's global one).
//! 2. **Physical footprint** — on macOS this is what jetsam charges and what Activity Monitor
//!    shows (`proc_pid_rusage` `ri_phys_footprint`); plain RSS includes resident-but-clean pages
//!    the OS reclaims for free, so an RSS-keyed cap can kill a healthy process and indict pages
//!    nobody needs to fix. Linux has no footprint equivalent, so RSS is the correct key there —
//!    the diagnostic always states which counter the cap decision was keyed on.

use std::io::Write;
use std::path::Path;

/// Hard ceiling in bytes. `AGENTLENS_RSS_HARD_CAP_MB` overrides; default 2048 MB per the owner
/// directive. A non-positive or unparseable override is ignored (never disables the cap by
/// accident) — parse failures fall back to the default rather than turning the guard off.
pub fn rss_hard_cap_bytes() -> u64 {
    std::env::var("AGENTLENS_RSS_HARD_CAP_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(2048)
        * 1024
        * 1024
}

/// mimalloc's own bookkeeping for the process (`mi_process_info` — always available once the
/// `libmimalloc-sys` "extended" feature is linked in, regardless of whether MiMalloc is actually
/// the active global allocator; if it isn't, every field reads ~0, which is itself informative).
pub struct MimallocInfo {
    pub current_rss_bytes: u64,
    pub peak_rss_bytes: u64,
    pub current_commit_bytes: u64,
    pub page_faults: u64,
}

pub fn mimalloc_info() -> MimallocInfo {
    let (mut current_rss, mut peak_rss, mut current_commit, mut page_faults) = (0usize, 0usize, 0usize, 0usize);
    unsafe {
        libmimalloc_sys::mi_process_info(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut current_rss,
            &mut peak_rss,
            &mut current_commit,
            std::ptr::null_mut(),
            &mut page_faults,
        );
    }
    MimallocInfo {
        current_rss_bytes: current_rss as u64,
        peak_rss_bytes: peak_rss as u64,
        current_commit_bytes: current_commit as u64,
        page_faults: page_faults as u64,
    }
}

/// macOS physical footprint (`proc_pid_rusage` `RUSAGE_INFO_V0`, `ri_phys_footprint`) — dirty +
/// swapped, the number jetsam and Activity Monitor use. `None` on any other platform, or if the
/// syscall itself fails (never a fabricated 0 — a missing counter must say so, not lie low).
/// V0 (not V2+) deliberately: it is the SMALLEST struct that already carries `ri_phys_footprint`,
/// which minimizes the risk of the libc crate's struct layout disagreeing with the kernel's
/// idea of that flavor's size — a real V2 attempt SIGSEGV'd here (TRDD-WKLD508O), consistent
/// with exactly that kind of size/layout mismatch.
#[cfg(target_os = "macos")]
pub fn phys_footprint_bytes() -> Option<u64> {
    // `rusage_info_t` is itself `*mut c_void` — the kernel fills the buffer THAT pointer
    // addresses, so the argument here is a pointer TO that pointer (`*mut *mut c_void`), not a
    // direct pointer to `info`.
    let mut info: libc::rusage_info_v0 = unsafe { std::mem::zeroed() };
    let mut buf: *mut libc::c_void = &mut info as *mut _ as *mut libc::c_void;
    let rc = unsafe {
        libc::proc_pid_rusage(std::process::id() as libc::c_int, libc::RUSAGE_INFO_V0, &mut buf as *mut *mut libc::c_void)
    };
    if rc != 0 {
        return None;
    }
    Some(info.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
pub fn phys_footprint_bytes() -> Option<u64> {
    None
}

/// The metric the cap decision is keyed on, and its name for the log — macOS uses physical
/// footprint (falling back to RSS only if the footprint syscall itself failed); every other
/// platform uses RSS, because there is no footprint equivalent there.
pub fn primary_metric(fallback_rss_bytes: u64) -> (&'static str, u64) {
    match phys_footprint_bytes() {
        Some(fp) => ("phys_footprint", fp),
        None => ("rss", fallback_rss_bytes),
    }
}

/// Everything the breach diagnostic needs, gathered from counters the caller already tracks —
/// this module does no expensive computation of its own beyond the two syscalls above, because
/// by the time it runs the process is already over budget and must exit promptly.
pub struct CulpritSnapshot {
    pub cap_bytes: u64,
    pub resident_spans: Option<usize>,
    pub window_effective_ms: Option<i64>,
    pub window_configured_ms: Option<i64>,
    pub card_count: Option<usize>,
    pub span_store_segments: Option<usize>,
    pub span_store_total_spans: Option<u64>,
    pub span_store_total_bytes: Option<u64>,
    pub uptime_ms: Option<i64>,
}

/// Render the culprit diagnostic. `None` fields print as "unavailable" instead of being omitted —
/// a missing counter is itself information (which subsystem's state wasn't reachable at breach
/// time), never silently dropped.
pub fn format_diagnostic(metric_name: &str, metric_bytes: u64, mi: &MimallocInfo, s: &CulpritSnapshot) -> String {
    fn opt<T: std::fmt::Display>(v: &Option<T>) -> String {
        match v {
            Some(x) => x.to_string(),
            None => "unavailable".to_string(),
        }
    }
    let non_mimalloc_approx = metric_bytes.saturating_sub(mi.current_rss_bytes) / 1024 / 1024;
    format!(
        "alcore: RSS HARD CAP — {metric_name} {measured_mb} MB > cap {cap_mb} MB, exiting\n\
         alcore: RSS HARD CAP — mimalloc (Rust heap): current {mi_cur} MB, peak {mi_peak} MB, commit {mi_commit} MB, page faults {mi_pf}\n\
         alcore: RSS HARD CAP — non-mimalloc (approx, e.g. DuckDB's own allocator): {non_mimalloc} MB\n\
         alcore: RSS HARD CAP — resident spans: {spans}\n\
         alcore: RSS HARD CAP — summarization window: effective {eff} ms / configured {cfg} ms\n\
         alcore: RSS HARD CAP — card store rows: {cards}\n\
         alcore: RSS HARD CAP — span store: {segs} segments, {sspans} spans, {sbytes} bytes\n\
         alcore: RSS HARD CAP — uptime: {uptime} ms",
        metric_name = metric_name,
        measured_mb = metric_bytes / 1024 / 1024,
        cap_mb = s.cap_bytes / 1024 / 1024,
        mi_cur = mi.current_rss_bytes / 1024 / 1024,
        mi_peak = mi.peak_rss_bytes / 1024 / 1024,
        mi_commit = mi.current_commit_bytes / 1024 / 1024,
        mi_pf = mi.page_faults,
        non_mimalloc = non_mimalloc_approx,
        spans = opt(&s.resident_spans),
        eff = opt(&s.window_effective_ms),
        cfg = opt(&s.window_configured_ms),
        cards = opt(&s.card_count),
        segs = opt(&s.span_store_segments),
        sspans = opt(&s.span_store_total_spans),
        sbytes = opt(&s.span_store_total_bytes),
        uptime = opt(&s.uptime_ms),
    )
}

/// Write the diagnostic to a KNOWN file path, flushed and fsync'd, before anything else — a
/// startup crash on this project once left `server.log` completely empty, which is exactly the
/// failure that makes this whole guard useless at the moment it fires. Best-effort: a failure to
/// write the file must not stop the exit (the process is over its memory cap either way), but it
/// is reported on stderr so the omission itself is visible.
fn write_log_file(log_path: &Path, diagnostic: &str) {
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log_path)?;
        writeln!(f, "{diagnostic}")?;
        f.flush()?;
        f.sync_all()
    })();
    if let Err(e) = result {
        eprintln!("alcore: RSS HARD CAP — could NOT write diagnostic to {}: {e}", log_path.display());
    }
}

/// Check the primary metric against the hard cap and, on breach, write + print the diagnostic and
/// exit(1). No-op under the cap. `fallback_rss_bytes` is the RSS the caller already computed
/// (`server_stats::rss_bytes()`) — used as the primary metric on non-macOS, and as the fallback if
/// the macOS footprint syscall itself fails.
pub fn check_and_enforce(fallback_rss_bytes: u64, log_path: &Path, snapshot: CulpritSnapshot) {
    let (metric_name, metric_bytes) = primary_metric(fallback_rss_bytes);
    if metric_bytes <= snapshot.cap_bytes {
        return;
    }
    let mi = mimalloc_info();
    let diagnostic = format_diagnostic(metric_name, metric_bytes, &mi, &snapshot);
    write_log_file(log_path, &diagnostic);
    eprintln!("{diagnostic}");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mi(current_rss: u64) -> MimallocInfo {
        MimallocInfo { current_rss_bytes: current_rss, peak_rss_bytes: current_rss, current_commit_bytes: current_rss, page_faults: 1 }
    }

    fn snap(cap_bytes: u64) -> CulpritSnapshot {
        CulpritSnapshot {
            cap_bytes,
            resident_spans: Some(397),
            window_effective_ms: Some(60_000),
            window_configured_ms: Some(86_400_000),
            card_count: Some(3),
            span_store_segments: Some(1),
            span_store_total_spans: Some(10),
            span_store_total_bytes: Some(2048),
            uptime_ms: Some(5000),
        }
    }

    #[test]
    fn under_cap_is_a_no_op() {
        let tmp = std::env::temp_dir().join(format!("al-rss-guard-noop-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        check_and_enforce(1024 * 1024 * 1024, &tmp, snap(2 * 1024 * 1024 * 1024));
        assert!(!tmp.exists(), "no log should be written when under cap");
    }

    #[test]
    fn default_cap_is_2048_mb() {
        std::env::remove_var("AGENTLENS_RSS_HARD_CAP_MB");
        assert_eq!(rss_hard_cap_bytes(), 2048 * 1024 * 1024);
    }

    #[test]
    fn diagnostic_separates_mimalloc_heap_from_non_mimalloc_growth() {
        // The measured incident this guard exists for: a tiny window (397 spans) at a 5.4 GB
        // footprint. The old cheap-counters-only log would have said "397 spans, 5.4 GB" and
        // named nothing — this asserts the split that actually attributes it.
        let d = format_diagnostic("phys_footprint", 5_400 * 1024 * 1024, &mi(400 * 1024 * 1024), &snap(2048 * 1024 * 1024));
        assert!(d.contains("phys_footprint 5400 MB > cap 2048 MB"));
        assert!(d.contains("mimalloc (Rust heap): current 400 MB"));
        assert!(d.contains("non-mimalloc (approx, e.g. DuckDB's own allocator): 5000 MB"));
        assert!(d.contains("resident spans: 397"));
        for line in d.lines() {
            assert!(line.starts_with("alcore: RSS HARD CAP —"), "line not prefixed for grep: {line}");
        }
    }
}
