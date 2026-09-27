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
    let mut info: libc::rusage_info_v0 = unsafe { std::mem::zeroed() };
    // PASS THE STRUCT'S OWN ADDRESS. `rusage_info_t` is `*mut c_void`, so the parameter spells
    // `*mut *mut c_void` — but that is an OPAQUE HANDLE type, not a real double indirection. XNU's
    // own callers write `proc_pid_rusage(pid, flavor, (rusage_info_t *)&struct)` and the kernel
    // writes the flavor's struct AT that address. Passing `&pointer_to_info` instead makes the
    // kernel write 96 bytes over an 8-byte stack local, leaving `info` zeroed — so this returned
    // `Some(0)`, `primary_metric` took the `Some` branch (never calling the RSS fallback), and
    // `0 <= cap` held at EVERY threshold: the hard cap could not fire on macOS at all. Measured
    // 2026-09-07 (TRDD-WKLD508O) with a C program running both shapes in one process after
    // dirtying 300 MB — correct form 301 MB, as-coded form 0 MB — and confirmed live by two
    // probes of the deployed binary at 512 MB and 1 MB, both of which ran to timeout.
    //
    // The kernel returns SUCCESS for the wrong shape (measured `rc=0`), which is why this was
    // silent for its whole life — there was never an error to notice.
    //
    // Leave the V2-SIGSEGV note above alone: a separate, unmeasured concern, not this bug.
    //
    // A SMALL READING HERE IS NOT A SYMPTOM. `phys_footprint` excludes clean file-backed pages, so
    // the mapped binary costs ~0 and a quiet process reads single-digit MB — a release unittest
    // binary measured 2.44 MB. That is the counter's advertised behaviour and the whole reason it
    // was chosen over RSS. Assert on a DELTA, never on a floor. TRDD-WKLD508O.
    let rc = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as libc::c_int,
            libc::RUSAGE_INFO_V0,
            &mut info as *mut libc::rusage_info_v0 as *mut libc::rusage_info_t,
        )
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
///
/// The fallback is a CLOSURE, not a value, and that is load-bearing rather than stylistic. The
/// caller samples RSS once BEFORE running the soft valve (it has to — the valve's own decision
/// needs that reading). Handing that same number here would key the hard cap on a pre-valve
/// measurement, so on the RSS path the guard could not observe the one thing that makes it
/// meaningful: that memory is STILL over the cap after the window was narrowed. A closure defers
/// the read to breach-check time. On macOS it is never called at all, because the footprint
/// syscall answers first — so the fresh read costs nothing on the platform that does not need it.
pub fn primary_metric(fallback_rss: impl FnOnce() -> u64) -> (&'static str, u64) {
    match phys_footprint_bytes() {
        Some(fp) => ("phys_footprint", fp),
        None => ("rss", fallback_rss()),
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

/// Write the culprit diagnostic straight to `w` — `writeln!` formats each field directly into
/// the sink via `Display`, so this builds no intermediate `String`/`Vec` for the whole body. That
/// matters here specifically: this runs ON THE BREACH PATH, after the process is already
/// confirmed over its memory cap, so a large speculative allocation right before logging why the
/// process is out of memory is exactly the wrong place to put one.
///
/// `None` fields print as "unavailable" instead of being omitted — a missing counter is itself
/// information (which subsystem's state wasn't reachable at breach time), never silently dropped.
pub fn write_diagnostic<W: std::io::Write>(
    w: &mut W,
    metric_name: &str,
    metric_bytes: u64,
    mi: &MimallocInfo,
    s: &CulpritSnapshot,
) -> std::io::Result<()> {
    fn opt(w: &mut impl std::io::Write, v: Option<impl std::fmt::Display>) -> std::io::Result<()> {
        match v {
            Some(x) => write!(w, "{x}"),
            None => write!(w, "unavailable"),
        }
    }
    let non_mimalloc_approx = metric_bytes.saturating_sub(mi.current_rss_bytes) / 1024 / 1024;
    writeln!(w, "alcore: RSS HARD CAP — {metric_name} {} MB > cap {} MB, exiting", metric_bytes / 1024 / 1024, s.cap_bytes / 1024 / 1024)?;
    writeln!(
        w,
        "alcore: RSS HARD CAP — mimalloc (Rust heap): current {} MB, peak {} MB, commit {} MB, page faults {}",
        mi.current_rss_bytes / 1024 / 1024,
        mi.peak_rss_bytes / 1024 / 1024,
        mi.current_commit_bytes / 1024 / 1024,
        mi.page_faults,
    )?;
    writeln!(
        w,
        "alcore: RSS HARD CAP — non-mimalloc LOWER BOUND (= {metric_name} minus mimalloc current_rss; mimalloc's counter \
         is RSS-like and carries clean pages the footprint never charged, so the true non-mimalloc share is LARGER — \
         read this as a floor, never as the answer): {non_mimalloc_approx} MB",
    )?;
    write!(w, "alcore: RSS HARD CAP — resident spans: ")?;
    opt(w, s.resident_spans)?;
    writeln!(w)?;
    write!(w, "alcore: RSS HARD CAP — summarization window: effective ")?;
    opt(w, s.window_effective_ms)?;
    write!(w, " ms / configured ")?;
    opt(w, s.window_configured_ms)?;
    writeln!(w, " ms")?;
    write!(w, "alcore: RSS HARD CAP — card store rows: ")?;
    opt(w, s.card_count)?;
    writeln!(w)?;
    write!(w, "alcore: RSS HARD CAP — span store: ")?;
    opt(w, s.span_store_segments)?;
    write!(w, " segments, ")?;
    opt(w, s.span_store_total_spans)?;
    write!(w, " spans, ")?;
    opt(w, s.span_store_total_bytes)?;
    writeln!(w, " bytes")?;
    write!(w, "alcore: RSS HARD CAP — uptime: ")?;
    opt(w, s.uptime_ms)?;
    writeln!(w, " ms")
}

/// Test/reporting convenience — allocates, so ONLY for callers that already accept an
/// allocation (tests, or a cold path). The real breach path (`check_and_enforce`) never calls
/// this; it calls `write_diagnostic` straight into the file and stderr sinks. Not `#[cfg(test)]`:
/// the integration test binary (`tests/rss_hard_cap.rs`) links this crate as an ordinary
/// dependency, where `cfg(test)` never applies — gating it would make that suite fail to build.
pub fn format_diagnostic(metric_name: &str, metric_bytes: u64, mi: &MimallocInfo, s: &CulpritSnapshot) -> String {
    let mut buf = Vec::new();
    write_diagnostic(&mut buf, metric_name, metric_bytes, mi, s).expect("writing to a Vec<u8> cannot fail");
    String::from_utf8(buf).expect("diagnostic is ASCII")
}

/// Write the diagnostic to a KNOWN file path, flushed and fsync'd, before anything else — a
/// startup crash on this project once left `server.log` completely empty, which is exactly the
/// failure that makes this whole guard useless at the moment it fires. Best-effort: a failure to
/// write the file must not stop the exit (the process is over its memory cap either way), but it
/// is reported on stderr so the omission itself is visible.
fn write_log_file(log_path: &Path, metric_name: &str, metric_bytes: u64, mi: &MimallocInfo, s: &CulpritSnapshot) {
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log_path)?;
        write_diagnostic(&mut f, metric_name, metric_bytes, mi, s)?;
        f.flush()?;
        f.sync_all()
    })();
    if let Err(e) = result {
        eprintln!("{} alcore: RSS HARD CAP — could NOT write diagnostic to {}: {e}", crate::log_ts(), log_path.display());
    }
}

/// Check the primary metric against the hard cap and, on breach, write + print the diagnostic and
/// exit(1). No-op under the cap. `fallback_rss` is called ONLY on the RSS path (non-macOS, or a
/// failed footprint syscall) and is called HERE rather than by the caller, so the reading is taken
/// after the soft valve has run — see `primary_metric`.
///
/// `flush_before_exit` runs ONLY on breach, right before the log is written — `exit()` skips
/// destructors, so anything buffered (span-store appends not yet flushed to disk) would be lost
/// silently at the exact moment this guard exists to prevent silent loss. It is a closure, not a
/// call made here directly, because this module has no handle on the caller's writer/store.
pub fn check_and_enforce(
    fallback_rss: impl FnOnce() -> u64,
    flush_before_exit: impl FnOnce(),
    log_path: &Path,
    snapshot: CulpritSnapshot,
) {
    let (metric_name, metric_bytes) = primary_metric(fallback_rss);
    if metric_bytes <= snapshot.cap_bytes {
        return;
    }
    flush_before_exit();
    let mi = mimalloc_info();
    write_log_file(log_path, metric_name, metric_bytes, &mi, &snapshot);
    let mut stderr = std::io::stderr();
    let _ = write_diagnostic(&mut stderr, metric_name, metric_bytes, &mi, &snapshot);
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
    fn primary_metric_reports_a_real_measurement_never_zero() {
        // THE TEST THAT WAS MISSING. Every other test here covers the env parser or the format
        // string; nothing ever called the measurement, so a metric that always read 0 shipped and
        // silently disabled the cap at every threshold (TRDD-WKLD508O, measured 2026-09-07 — two
        // probes at 512 MB and 1 MB both ran to timeout with no guard output).
        //
        // IT ASSERTS ON A DELTA, NOT ON AN ABSOLUTE FLOOR — and that is the whole design. My first
        // version asserted `> 8 MB` against whatever the binary happened to weigh, which cannot
        // tell "the metric works" from "the binary is bigger than the floor". It then failed at
        // 2,556,336 bytes, and an absolute floor gives no way to decide whether that is a broken
        // metric or an honest reading of a small test binary. Dirtying a KNOWN amount first makes
        // the two predict opposite results: a working metric must rise by roughly what was
        // touched, a broken one cannot.
        //
        // WHAT THIS DOES **NOT** PROVE, stated here because I claimed it did: rising with dirtied
        // memory does NOT prove the right FIELD is being read. `ri_resident_size` sits directly
        // before `ri_phys_footprint` in the struct, so an off-by-one-field read tracks real memory
        // just as faithfully and passes this test — while silently giving back RSS, the very
        // counter the module's header rejects. `rusage_fields_agree_with_an_independent_syscall`
        // is what pins the offset; this test only shows the counter is LIVE.
        //
        // `vec![1u8; N]` must memset every byte, so every page is faulted in — no volatile loop is
        // needed and an earlier version's one was dead weight justified by a comment about
        // `vec![0u8; N]`, which can take a zero-page path and is not what this writes.
        const DIRTY: usize = 64 * 1024 * 1024;
        let (_, before) = primary_metric(crate::server_stats::rss_bytes);
        let ballast: Vec<u8> = vec![1u8; DIRTY];
        let (name, after) = primary_metric(crate::server_stats::rss_bytes);
        std::hint::black_box(&ballast);

        // `after > before` FIRST, with its own message. Folding this into a `saturating_sub` prints
        // "moved 0 bytes" for a SHRINKING metric, which reads as "static" and hides the direction —
        // the reader at 3am then chases the wrong failure.
        assert!(
            after > before,
            "{name} did not rise after dirtying {DIRTY} bytes: {before} -> {after} (it FELL or held)",
        );
        // Half of what was dirtied, so a concurrent test thread's frees cannot make this flaky,
        // while a metric reading an unrelated field (user time in ns, page-in counts) cannot pass.
        let grew = after - before;
        assert!(
            grew > (DIRTY / 2) as u64,
            "{name} moved only {grew} bytes ({before} -> {after}) after dirtying {DIRTY} — a counter \
             that does not track real memory cannot key a hard cap",
        );
    }

    /// THE OFFSET ORACLE, and the reason the `size_of` check it replaced was theatre: that check
    /// compared `libc`'s struct against a number I typed, i.e. the crate against itself, and every
    /// field after the UUID is a `u64` — so any permutation preserves 96 bytes and passes.
    ///
    /// This asks a DIFFERENT KERNEL CALL the same question. `proc_pid_rusage`'s `ri_resident_size`
    /// and `proc_pidinfo(PROC_PIDTASKINFO)`'s `pti_resident_size` (what `server_stats::rss_bytes`
    /// reads) are independent paths to one quantity, so agreement pins the field offsets and a
    /// shifted read shows up as two numbers that are not the same size at all.
    #[cfg(target_os = "macos")]
    #[test]
    fn rusage_fields_agree_with_an_independent_syscall() {
        let mut info: libc::rusage_info_v0 = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::proc_pid_rusage(
                std::process::id() as libc::c_int,
                libc::RUSAGE_INFO_V0,
                &mut info as *mut libc::rusage_info_v0 as *mut libc::rusage_info_t,
            )
        };
        assert_eq!(rc, 0, "proc_pid_rusage failed; the guard's metric is unavailable");

        let rss = crate::server_stats::rss_bytes();
        let resident = info.ri_resident_size;
        // 25%: the two syscalls are sampled microseconds apart on a live process, so they need not
        // be identical — but a WRONG FIELD is off by orders of magnitude (nanoseconds of user time,
        // or a page-in count), never by a quarter.
        let (lo, hi) = (resident.min(rss), resident.max(rss));
        assert!(
            lo > 0 && hi <= lo + lo / 4,
            "rusage ri_resident_size {resident} and proc_pidinfo pti_resident_size {rss} disagree \
             beyond sampling skew — libc's rusage_info_v0 field offsets do not match the kernel's, \
             so ri_phys_footprint is reading some other field",
        );
        // And the footprint must be a plausible sibling of resident, not a nanosecond counter.
        let fp = info.ri_phys_footprint;
        assert!(
            fp > 0 && fp < hi * 4,
            "ri_phys_footprint {fp} is not the same order as resident {resident} — a shifted read",
        );
    }

    /// Restores the coverage the fallback swap in the test above DROPPED, and settles an open
    /// question rather than carrying it forward. That test now passes a real RSS reader as the
    /// fallback, so on macOS a `None` from `phys_footprint_bytes` — the syscall failing, or
    /// returning non-zero `rc` — makes it report a healthy RSS number and pass GREEN while the cap
    /// has silently degraded to keying on RSS, which this module's own header documents as the
    /// wrong key ("an RSS-keyed cap can kill a healthy process and indict pages nobody needs to
    /// fix"). DO NOT DELETE THIS AS REDUNDANT: the delta test discards the metric name
    /// (`let (_, before)`), so a `None` there sails through green on the fallback and nothing in it
    /// objects. This is the only assertion in the file covering that case.
    #[cfg(target_os = "macos")]
    #[test]
    fn phys_footprint_is_present_on_macos_not_silently_none() {
        phys_footprint_bytes().expect(
            "proc_pid_rusage returned non-zero — phys_footprint_bytes is None, so the hard cap \
             would silently key on RSS instead of the footprint macOS actually charges",
        );
    }

    /// A SIZE-DRIFT guard, NOT a layout falsifier — I first called it the latter and that
    /// over-claimed by exactly the amount that matters. Both sides of this comparison come from
    /// `libc`, so it cannot detect the crate disagreeing with the kernel; and every field after the
    /// UUID is a `u64`, so any REORDERING preserves 96 bytes and passes. It catches one real thing:
    /// the struct's size changing under a crate upgrade. The offsets are pinned by
    /// `rusage_fields_agree_with_an_independent_syscall`, which asks a different syscall.
    #[cfg(target_os = "macos")]
    #[test]
    fn rusage_info_v0_layout_matches_the_kernel_record() {
        assert_eq!(
            std::mem::size_of::<libc::rusage_info_v0>(),
            96,
            "libc's rusage_info_v0 is not the kernel's 96-byte V0 record — every field read out of \
             it is at the wrong offset",
        );
    }

    #[test]
    fn under_cap_is_a_no_op() {
        let tmp = std::env::temp_dir().join(format!("al-rss-guard-noop-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        check_and_enforce(|| 1024 * 1024 * 1024, || {}, &tmp, snap(2 * 1024 * 1024 * 1024));
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
        // The label must name its METHOD, not a suspect. Naming DuckDB here was measurably
        // premature: a live vmmap on 2026-09-07 put the mimalloc side ahead on RESIDENT (3.4 G vs
        // 2.3 G) but well behind on DIRTY (876 M vs ~2.7 G), so a log asserting "DuckDB" would
        // have been read as a finding when nothing had measured DuckDB. The subtraction also
        // mixes counters — phys_footprint minus mimalloc's RSS — which is why it says bisection.
        // Measured on the live collector 2026-09-07: footprint 6265 MB, mimalloc RSS ~3481 MB, so
        // this subtraction prints 2784 MB — while dirty+swapped per region puts the real
        // non-mimalloc share near 5208 MB. It is low by ~47%, in the direction that HIDES the
        // culprit, because it subtracts an RSS-like counter (clean pages included) from footprint
        // (clean pages excluded). There is no mimalloc footprint equivalent to subtract instead,
        // so the number stays and the label carries the direction of its error.
        assert!(d.contains("non-mimalloc LOWER BOUND"));
        assert!(d.contains("read this as a floor, never as the answer): 5000 MB"));
        assert!(!d.contains("e.g. DuckDB"), "the diagnostic must not name a suspect it did not measure");
        assert!(d.contains("resident spans: 397"));
        for line in d.lines() {
            assert!(line.starts_with("alcore: RSS HARD CAP —"), "line not prefixed for grep: {line}");
        }
    }
}
