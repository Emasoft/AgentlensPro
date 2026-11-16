//! Hard memory ceiling — owner directive: "alcore must not use more than 2 gb of ram. if it ever
//! uses more than that, it must exit with error and a log that will allow us to identify the
//! culprit, so we will fix the code." This is FAIL-FAST, not a valve: `lib.rs`'s staged pressure
//! ladder (`pressure_fracs` of this cap) already sheds caches then narrows the window — a soft mitigation
//! that can fail to bring memory back down (a leak outside the window, or growth in the card
//! store / span store / a non-Rust allocator). This module is the backstop.
//!
//! TRDD-WKLD508O correction: the cheap counters alone (span count, card rows, uptime) do NOT
//! identify a culprit — a measured live process held 397 spans at 5.4 GB footprint, so "397
//! spans, 5.4 GB" tells nobody what to fix. Two things actually attribute the memory:
//!
//! 1. **`mi_process_info` counters** — on macOS `current_rss` is WHOLE-PROCESS resident memory
//!    (mach `task_info` overwrites the commit-derived init, prim/unix/prim.c:766); mimalloc's OWN
//!    counter is `current_commit` (decremented on decommit). The two are separated from non-Rust
//!    growth (DuckDB, which allocates through its own C allocator, not through Rust's global one).
//! 2. **The cap decision is keyed on mimalloc's committed bytes** (`mi_commit_bytes`), not on
//!    physical footprint or RSS. Owner directive 2026-10-22: "it cannot use more memory than 2gb.
//!    but duckdb on the other hand can." Footprint and RSS both include DuckDB's system-malloc
//!    allocations, so keying the cap on them charged alcore for memory it does not own. On breach
//!    the log still records physical footprint (`proc_pid_rusage` `ri_phys_footprint`, what jetsam
//!    charges) and RSS as evidence; RSS also counts resident-but-clean pages the OS reclaims free.
//!    The breach label stays "RSS HARD CAP" so existing greps keep matching, although the decision is no longer RSS.

use std::io::Write;
use std::path::Path;

/// Hard ceiling in bytes. `AGENTLENS_RSS_HARD_CAP_MB` overrides; default 2048 MB per the owner
/// directive. A non-positive or unparseable override is ignored (never disables the cap by
/// accident) — parse failures fall back to the default rather than turning the guard off.
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

/// Counters from `mi_process_info` (always available once the `libmimalloc-sys` "extended" feature
/// is linked in, regardless of whether MiMalloc is the active global allocator; if it isn't, every
/// field reads ~0, which is itself informative). TRUE semantics, vendored mimalloc v3
/// (libmimalloc-sys-0.1.49): `current_rss_bytes` is WHOLE-PROCESS resident memory on macOS —
/// stats.c:555 initializes it from the commit counter, then prim/unix/prim.c:766 OVERWRITES it
/// with mach `task_info` `resident_size` — so it is NOT mimalloc heap accounting.
/// `current_commit_bytes` is mimalloc's OWN committed-pages counter (decremented on decommit),
/// the closest thing to "Rust heap dirty + freed-undecommitted". `peak_rss_bytes` is the process
/// peak (ru_maxrss). On non-macOS prim may leave the RSS fields commit-derived.
/// TRDD-2JOIAH2G deviation note: the card expected `pages_abandoned` to be an extra
/// `mi_process_info` out-param. It is not — stats.c:544-568 writes ONLY elapsed/user/system/
/// rss/peak_rss/commit/peak_commit/page_faults; the count lives in `mi_stats_t.pages_abandoned.
/// current` and the only surface libmimalloc-sys 0.1.49 binds for it is `mi_stats_get_json`
/// (extended.rs, same "extended" feature). See `pages_abandoned_current`.
pub struct MimallocInfo {
    pub current_rss_bytes: u64,
    pub peak_rss_bytes: u64,
    pub current_commit_bytes: u64,
    pub page_faults: u64,
    /// Abandoned mimalloc pages (pages whose owning thread died; reclaimable by any thread via
    /// the reclaim path). 0 also means "could not read" — a missing counter says so once on
    /// stderr rather than lying low, see `mimalloc_stats_fields`.
    pub pages_abandoned: u64,
    /// Peak of the abandoned-pages counter (mi_stat_count_t.peak of `pages_abandoned`). The
    /// exit-dump reading (TRDD-2JOIAH2G round-98) showed abandoned peak 19.6K vs current 146 —
    /// the pool drained BY EXIT (teardown included; live-operation drain unproven by this reading) —
    /// so the peak is the number that answers "how big did it get", carried here on every read
    /// so no instrument has to re-derive it.
    pub pages_abandoned_peak: u64,
    /// `committed.current` from the stats JSON. Parity twin of `current_commit_bytes` (which
    /// comes from `mi_process_info`): two read paths, one quantity — a disagreement between them
    /// is a bug in one of the paths, which is exactly what a discriminator instrument is for.
    pub committed_current_bytes: u64,
    /// Cumulative bytes mimalloc has RESET (decommitted-in-place, os.c reset path) since boot —
    /// `MI_STAT_COUNTER(reset)`, serialized as a bare integer by the JSON writer (stats.c
    /// mi_json_buf_print_counter_value). Answers "does mimalloc decommit under pressure".
    pub reset_total_bytes: u64,
    /// Cumulative bytes mimalloc has PURGED (madvise/msync discard) since boot — same shape as
    /// `reset_total_bytes`.
    pub purged_total_bytes: u64,
}

/// One read of the mimalloc stats JSON — the fields this module's instruments need, parsed in a
/// single `mi_stats_get_json` call (each call allocates the JSON buffer + parses it, so callers
/// that need several fields must NOT make several calls). 0 on any parse failure; a missing
/// counter says so once on stderr rather than lying low (the WARNED contract below).
struct MimallocStatsFields {
    pages_abandoned: u64,
    pages_abandoned_peak: u64,
    committed_current_bytes: u64,
    reset_total_bytes: u64,
    purged_total_bytes: u64,
}

/// Read the stats fields from `mi_stats_get_json`. The binding allocates the JSON via
/// mimalloc's own allocator and hands it back for `mi_free` — copy the bytes out, free the
/// buffer, then parse the named fields. Hand-mirroring `mi_stats_t` (74-bin arrays in macro
/// order) to call `mi_subproc_stats_get` directly would be a layout-drift trap; here the C side
/// validates size+version and a parse failure is loud (one-time stderr warn, reading 0).
///
/// PAYLOAD SHAPE (verified against the vendored writer, stats.c `mi_stats_get_json_from`,
/// libmimalloc-sys-0.1.49): `MI_STAT_COUNT` fields serialize as objects
/// `{ "total": N, "peak": N, "current": N }` (mi_json_buf_print_count_value) — so
/// `committed` and `pages_abandoned` are objects; `MI_STAT_COUNTER` fields serialize as BARE
/// INTEGERS (mi_json_buf_print_counter_value → mi_json_buf_print_value) — so `reset` and
/// `purged` are plain numbers with no `.total` suffix in the JSON. Reading them as objects
/// would parse to 0 forever.
fn mimalloc_stats_fields() -> MimallocStatsFields {
    static WARNED: std::sync::Once = std::sync::Once::new();
    // M5 discriminator (TRDD-2JOIAH2G): log the payload's stat_version once per process, on
    // successful parses only — the UNAVAILABLE warn below already covers parse failure.
    static VERSION_LOGGED: std::sync::Once = std::sync::Once::new();
    let mut unavailable = false;
    let read = unsafe {
        let raw = libmimalloc_sys::mi_stats_get_json(0, std::ptr::null_mut());
        if raw.is_null() {
            unavailable = true;
            None
        } else {
            let bytes = std::ffi::CStr::from_ptr(raw).to_bytes().to_vec();
            libmimalloc_sys::mi_free(raw.cast());
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .map(|v| {
                    VERSION_LOGGED.call_once(|| {
                        eprintln!(
                            "{} alcore: mimalloc stats payload stat_version {} (counter shape bare-integer, pinned to libmimalloc-sys-0.1.49's writer — a binding bump must re-verify)",
                            crate::log_ts(),
                            get_u64(&v, &["stat_version"])
                        );
                    });
                    MimallocStatsFields {
                        pages_abandoned: get_u64(&v, &["pages_abandoned", "current"]),
                        pages_abandoned_peak: get_u64(&v, &["pages_abandoned", "peak"]),
                        committed_current_bytes: get_u64(&v, &["committed", "current"]),
                        // COUNTERS are bare integers in the JSON — `v["reset"]` IS the total.
                        reset_total_bytes: get_u64(&v, &["reset"]),
                        purged_total_bytes: get_u64(&v, &["purged"]),
                    }
                })
        }
    };
    let value = match read {
        Some(v) => v,
        None => {
            unavailable = true;
            MimallocStatsFields {
                pages_abandoned: 0,
                pages_abandoned_peak: 0,
                committed_current_bytes: 0,
                reset_total_bytes: 0,
                purged_total_bytes: 0,
            }
        }
    };
    if unavailable {
        WARNED.call_once(|| {
            eprintln!(
                "{} alcore: mimalloc stats UNAVAILABLE (mi_stats_get_json/parse failed) — abandoned/committed/reset/purged readings report 0",
                crate::log_ts()
            );
        });
    }
    value
}

/// Path-lookup helper: walk `keys` down the JSON value, returning 0 when any hop is missing or
/// not a u64. (serde_json's `.pointer()` needs a `/`-joined pointer string; explicit hops keep
/// the failure mode obvious.) 0 on parse failure is the module's existing contract — the
/// one-time stderr warn above is the loud half.
fn get_u64(v: &serde_json::Value, keys: &[&str]) -> u64 {
    let mut cur = v;
    for k in keys {
        match cur.get(k) {
            Some(next) => cur = next,
            None => return 0,
        }
    }
    cur.as_u64().unwrap_or(0)
}

// ---- TRDD-9VX3WTGU Phase 0: byte-level live instrument ------------------------------------
//
// The binding surface actually available (verified against the vendored sources AND the compiled
// static lib on this machine, libmimalloc-sys-0.1.49):
//
//   * The crate enables only the `extended` feature, and build.rs selects the vendored
//     **v3** C tree when `v2` is absent (build.rs:7-11; target/debug/build output confirms
//     `cargo:INCLUDE_DIR=.../v3/include`). v3's `mi_heap_get_backing`/`mi_heap_get_default`
//     do not exist at all (v2-only, heap.c:200-211) — the compiled lib has zero
//     `mi_heap_get_backing` symbols.
//   * v3 DOES expose a heap-enumeration surface: `mi_subproc_visit_heaps` (init.c:586) walks
//     the `subproc->heaps` linked list under `heaps_lock`; `subproc_main.heaps = &heap_main`
//     at init (init.c:283), and every `mi_heap_new` registers itself (heap.c:127-133). Rust's
//     mimalloc never calls `mi_heap_new`, so in practice the list is just `heap_main` — but
//     the walk is the correct, future-proof form.
//   * v3's `mi_heap_visit_blocks` (arena.c:2287) visits every page REGISTERED TO ONE HEAP via
//     the per-heap arena-page bitmaps plus the heap's `os_abandoned_pages` list. Ordinary
//     thread allocations run through theaps whose pages register under their owning heap
//     (`_mi_theap_heap(theap)`, arena.c:753-769), and all theaps default to `heap_main`
//     (init.c:618), so walking every heap in the subproc covers every page.
//   * With `visit_all_blocks = false` the visitor fires once per page area; `_mi_heap_area_init`
//     (theap.c:538) fills `area.used` = `page->used` (live block count) and `area.block_size` =
//     usable block size — so `used * block_size` is the live-bytes total WITHOUT touching
//     individual blocks. `nm` confirms all four symbols are in the linked static lib.
//
// The `mi_subproc_visit_heaps` + `mi_subproc_current` pair is NOT in the Rust binding
// (extended.rs has no `mi_subproc_*`), so those two are declared here against the same static
// lib — signatures from v3's mimalloc.h:350-358 (`mi_subproc_id_t` is a 1-pointer struct).
unsafe extern "C" {
    fn mi_subproc_current() -> MiSubprocId;
    fn mi_subproc_visit_heaps(
        subproc: MiSubprocId,
        visitor: mi_heap_visit_fun,
        arg: *mut std::ffi::c_void,
    ) -> bool;
}

/// `mi_subproc_id_t` — abstract 1-pointer handle (v3 mimalloc.h:350).
#[repr(C)]
struct MiSubprocId(*mut std::ffi::c_void);

/// `mi_heap_visit_fun` — per-heap visitor (v3 mimalloc.h:357). Return false to stop.
#[allow(non_camel_case_types)] // mirrors the C typedef name verbatim — the mimalloc surface
type mi_heap_visit_fun = unsafe extern "C" fn(heap: *mut libmimalloc_sys::mi_heap_t, arg: *mut std::ffi::c_void) -> bool;

/// Visitor state: sums `area.used * area.block_size` over every page area. With
/// `visit_all_blocks = false` the C side calls the BLOCK visitor exactly once per area with a
/// null block (arena.c:2226), passing the area — so this one extern fn serves both the heap
/// walk (via a shim) and the per-page accumulation.
struct LiveBytesAcc {
    live_bytes: u64,
    heaps_visited: u32,
}

/// Per-page-area accumulator, the `mi_block_visit_fun` handed to `mi_heap_visit_blocks`.
unsafe extern "C" fn live_bytes_block_visitor(
    _heap: *const libmimalloc_sys::mi_heap_t,
    area: *const libmimalloc_sys::mi_heap_area_t,
    _block: *mut std::ffi::c_void,
    _block_size: usize,
    arg: *mut std::ffi::c_void,
) -> bool {
    let acc = &mut *(arg as *mut LiveBytesAcc);
    if !area.is_null() {
        let a = unsafe { &*area };
        acc.live_bytes = acc.live_bytes.saturating_add(a.used as u64 * a.block_size as u64);
    }
    true
}

/// Per-heap shim, the `mi_heap_visit_fun` handed to `mi_subproc_visit_heaps`: runs
/// `mi_heap_visit_blocks` on this heap with the same accumulator. A `false` return from the
/// block visitor (never ours) or a failed visit aborts the heap walk.
unsafe extern "C" fn live_bytes_heap_visitor(
    heap: *mut libmimalloc_sys::mi_heap_t,
    arg: *mut std::ffi::c_void,
) -> bool {
    let acc = &mut *(arg as *mut LiveBytesAcc);
    let ok = unsafe {
        libmimalloc_sys::mi_heap_visit_blocks(heap, false, Some(live_bytes_block_visitor), arg)
    };
    if ok {
        acc.heaps_visited += 1;
    }
    ok
}

/// Total bytes of LIVE (allocated) blocks across every heap in the current subprocess —
/// TRDD-9VX3WTGU Phase 0's byte-level instrument. `None` only when the walk itself fails (no
/// subprocess handle, or a heap visit errored): a working walk with 0 live bytes is a real
/// reading, not a failure.
///
/// Runs on the 60s composition tick. Allocation cost: the two visitor state structs live on
/// the caller's stack (passed by `&mut` through `arg`), and `mi_heap_visit_blocks` with
/// `visit_all_blocks = false` reads page metadata only — it never walks individual blocks —
/// so the walk allocates ~nothing. Concurrency: mimalloc's own caveat (arena.c:2249) is that
/// the visit assumes it is the only thread running with the heap; the read takes
/// `heaps_lock` inside the C side for the heap list but page counts can shift under a
/// concurrent free — the composition line is a diagnostic, a ±few-MB skew between `live` and
/// `committed` sampled microseconds apart is acceptable, and the number is never used for a
/// kill decision (the hard cap keys on `mi_commit_bytes`, not this).
pub fn mi_live_bytes() -> Option<u64> {
    let mut acc = LiveBytesAcc { live_bytes: 0, heaps_visited: 0 };
    let arg = &mut acc as *mut LiveBytesAcc as *mut std::ffi::c_void;
    let ok = unsafe {
        let subproc = mi_subproc_current();
        if subproc.0.is_null() {
            false
        } else {
            mi_subproc_visit_heaps(subproc, live_bytes_heap_visitor, arg)
        }
    };
    if ok {
        Some(acc.live_bytes)
    } else {
        None
    }
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
    let stats = mimalloc_stats_fields();
    MimallocInfo {
        current_rss_bytes: current_rss as u64,
        peak_rss_bytes: peak_rss as u64,
        current_commit_bytes: current_commit as u64,
        page_faults: page_faults as u64,
        pages_abandoned: stats.pages_abandoned,
        pages_abandoned_peak: stats.pages_abandoned_peak,
        committed_current_bytes: stats.committed_current_bytes,
        reset_total_bytes: stats.reset_total_bytes,
        purged_total_bytes: stats.purged_total_bytes,
    }
}

/// Mimalloc's committed bytes, read through `mi_process_info` alone: no JSON buffer, no parse, so it
/// is cheap enough to read on every tick. It is the same counter `mimalloc_info` reports as
/// `current_commit_bytes` and the diagnostic prints as "mimalloc commit".
pub fn mi_commit_bytes() -> u64 {
    let mut current_commit: usize = 0;
    unsafe {
        libmimalloc_sys::mi_process_info(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut current_commit,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
    }
    current_commit as u64
}

/// `(current, peak)` mimalloc commit from ONE `mi_process_info` call, so the two numbers are consistent.
/// The current value is the same counter `mi_commit_bytes` reads. Own fn (not a new `MimallocInfo`
/// field) so the boot probe allocates no stats-JSON buffer between phases.
fn mi_commit_and_peak_bytes() -> (u64, u64) {
    let (mut current_commit, mut peak_commit) = (0usize, 0usize);
    unsafe {
        libmimalloc_sys::mi_process_info(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut current_commit,
            &mut peak_commit,
            std::ptr::null_mut(),
        );
    }
    (current_commit as u64, peak_commit as u64)
}

/// Boot-phase reading (TRDD-2HRA270Y): ONE stderr line with the NET mimalloc commit, its peak and the
/// macOS physical footprint at a named boot point. It is a reading of net commit per window, NOT an
/// allocation attribution: a phase that allocates and frees inside its window shows only the
/// residue in `mi_commit`, and shows the transient only if `mi_peak_commit` jumped. `t_open` is
/// seconds since `open_store` began (`-` outside it). `up` is seconds since the FIRST call of this
/// fn (alcore calls it with `boot_start` at the top of `main`), NOT the lazily seeded `[up Ns]`
/// stamp of `uptime_prefix`, so the two clocks differ by the boot work done before that first stamp.
/// The leading wall-clock stamp lets a line be matched against the footprint sampler.
pub fn log_boot_phase(phase: &str, t_open: Option<f64>) {
    static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let up = BOOT.get_or_init(std::time::Instant::now).elapsed().as_secs_f64();
    let (commit, peak) = mi_commit_and_peak_bytes();
    let mb = |b: u64| b as f64 / 1_048_576.0;
    let t_open = t_open.map_or_else(|| "-".to_owned(), |t| format!("{t:.2}"));
    let footprint = phys_footprint_bytes().map_or_else(|| "na".to_owned(), |b| format!("{:.1}", mb(b)));
    eprintln!(
        "{} [info] boot-phase phase={phase} t_open={t_open} up={up:.2} mi_commit={:.1} mi_peak_commit={:.1} phys_footprint={footprint}",
        crate::log_ts(),
        mb(commit),
        mb(peak)
    );
}

/// Install `log_boot_phase` as the `open_store` probe (the slot is set once per process; a second
/// set is a bug, so it fails loudly).
pub fn install_open_phase_probe() {
    agentlens_store::OPEN_PHASE_PROBE
        .set(|name, t_open| log_boot_phase(name, Some(t_open)))
        .expect("OPEN_PHASE_PROBE set twice");
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

/// The footprint-or-RSS reading and its name, used only as evidence in the breach log. Neither the
/// pressure ladder nor the hard-cap decision uses it: both key on `mi_commit_bytes`. macOS uses
/// physical footprint (falling back to RSS only if the footprint syscall itself failed); every other
/// platform uses RSS, because there is no footprint equivalent there.
///
/// The fallback is a CLOSURE, not a value, so that on macOS it is never called at all: the footprint
/// syscall answers first, and the RSS read costs nothing on the platform that does not need it.
pub fn primary_metric(fallback_rss: impl FnOnce() -> u64) -> (&'static str, u64) {
    match phys_footprint_bytes() {
        Some(fp) => ("phys_footprint", fp),
        None => ("rss", fallback_rss()),
    }
}


/// Pressure-ladder stage fractions of the hard cap: (stage 1, stage 2, stage 3).
/// The ladder keys on `mi_commit_bytes`, the same counter as the hard cap, so a stage can only fire on
/// memory the cap charges. These fractions were tuned against footprint (macOS) or RSS (elsewhere), not
/// commit, so they are to re-tune in soak. No Windows binary ships (src/rustBinResolve.ts SHIPPED_TARGETS).
pub const fn pressure_fracs() -> (f64, f64, f64) {
    if cfg!(target_os = "macos") {
        (0.70, 0.80, 0.90)
    } else {
        (0.75, 0.85, 0.92)
    }
}

// Hot knobs (env > config.json `.retention.<key>` > per-OS default), re-read each tick.
const PRESSURE_STAGE1: crate::retention_config::Knob = crate::retention_config::Knob {
    key: "pressureStage1Frac", env: "AGENTLENS_PRESSURE_STAGE1_FRAC", def: pressure_fracs().0, min: 0.05,
};
const PRESSURE_STAGE2: crate::retention_config::Knob = crate::retention_config::Knob {
    key: "pressureStage2Frac", env: "AGENTLENS_PRESSURE_STAGE2_FRAC", def: pressure_fracs().1, min: 0.05,
};
const PRESSURE_STAGE3: crate::retention_config::Knob = crate::retention_config::Knob {
    key: "pressureStage3Frac", env: "AGENTLENS_PRESSURE_STAGE3_FRAC", def: pressure_fracs().2, min: 0.05,
};

/// Absolute byte thresholds of stages 1..=3 for `cap` bytes, with hot overrides applied.
pub fn pressure_thresholds(data_dir: &Path, cap: u64) -> [u64; 3] {
    use crate::retention_config::resolve_knob;
    [PRESSURE_STAGE1, PRESSURE_STAGE2, PRESSURE_STAGE3]
        .map(|k| (resolve_knob(data_dir, &k) * cap as f64) as u64)
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
    writeln!(
        w,
        "alcore: RSS HARD CAP — mimalloc commit {} MB > cap {} MB, exiting (evidence: {metric_name} {} MB)",
        mi.current_commit_bytes / 1024 / 1024,
        s.cap_bytes / 1024 / 1024,
        metric_bytes / 1024 / 1024,
    )?;
    writeln!(
        w,
        "alcore: RSS HARD CAP — process RSS {} MB (macOS: whole-process resident; other OS: commit-derived), mimalloc commit {} MB (Rust allocator's committed pages), process peak {} MB, page faults {}",
        mi.current_rss_bytes / 1024 / 1024,
        mi.current_commit_bytes / 1024 / 1024,
        mi.peak_rss_bytes / 1024 / 1024,
        mi.page_faults,
    )?;
    // process-RSS minus footprint is resident-CLEAN (libs, mapped files) — knowably useless as a
    // non-mimalloc measure, saturating to ~0 in real kills. Commit is the mimalloc-owned counter,
    // so footprint − commit bounds the non-mimalloc dirty share from below.
    let footprint_minus_commit = metric_bytes.saturating_sub(mi.current_commit_bytes) / 1024 / 1024;
    writeln!(
        w,
        "alcore: RSS HARD CAP — non-mimalloc-dirty floor (= {metric_name} minus mimalloc commit; footprint-style metrics charge dirty+compressed, commit counts mimalloc committed incl. freed-undecommitted): {footprint_minus_commit} MB",
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

/// Check mimalloc's committed bytes against the hard cap and, on breach, write + print the
/// diagnostic and exit(1). No-op at or under the cap. This is the production entry point: it reads
/// `mi_commit_bytes`. See `check_and_enforce_with` for the logic and the reason it is not footprint.
pub fn check_and_enforce(
    fallback_rss: impl FnOnce() -> u64,
    flush_before_exit: impl FnOnce(),
    log_path: &Path,
    snapshot: CulpritSnapshot,
) {
    check_and_enforce_with(mi_commit_bytes, fallback_rss, flush_before_exit, log_path, snapshot);
}

/// The hard-cap check with the commit reading injected. Production passes `mi_commit_bytes` (via
/// `check_and_enforce`); the injection exists because test binaries do not run mimalloc as their
/// global allocator, so their real commit reads ~0 and a breach can only be staged this way.
///
/// WHY the decision is mimalloc commit and not physical footprint or RSS — owner directive
/// 2026-10-22, verbatim: "it cannot use more memory than 2gb. but duckdb on the other hand can."
/// Footprint and RSS include DuckDB's C++ allocations, which go through the system malloc, not
/// mimalloc. DuckDB is governed by its own memory_limit, which was measured not to bound process RSS
/// (512 MB limit gave 1,150 MiB RSS, TRDD-2HRA270Y); the cap deliberately does not charge it. alcore's
/// own heap is mimalloc (see `.claude/project/memory/vmmap-ioaccelerator-is-the-mimalloc-heap.md`), so
/// commit is the number the cap is about. Footprint and RSS are still read on breach and logged, so the
/// evidence stays complete.
///
/// `fallback_rss` is evidence only: it is called on breach, never on the decision path.
/// `flush_before_exit` runs ONLY on breach, right before the log is written — `exit()` skips
/// destructors, so anything buffered (span-store appends not yet flushed to disk) would be lost
/// silently at the exact moment this guard exists to prevent silent loss. It is a closure, not a
/// call made here directly, because this module has no handle on the caller's writer/store.
pub fn check_and_enforce_with(
    read_commit: impl FnOnce() -> u64,
    fallback_rss: impl FnOnce() -> u64,
    flush_before_exit: impl FnOnce(),
    log_path: &Path,
    snapshot: CulpritSnapshot,
) {
    let commit = read_commit();
    if commit <= snapshot.cap_bytes {
        return;
    }
    let (metric_name, metric_bytes) = primary_metric(fallback_rss);
    flush_before_exit();
    // The log must print the commit value that decided the breach, not a second read of the counter.
    let mut mi = mimalloc_info();
    mi.current_commit_bytes = commit;
    write_log_file(log_path, metric_name, metric_bytes, &mi, &snapshot);
    let mut stderr = std::io::stderr();
    let _ = write_diagnostic(&mut stderr, metric_name, metric_bytes, &mi, &snapshot);
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mi(current_rss: u64) -> MimallocInfo {
        MimallocInfo {
            current_rss_bytes: current_rss,
            peak_rss_bytes: current_rss,
            current_commit_bytes: current_rss,
            page_faults: 1,
            pages_abandoned: 0,
            pages_abandoned_peak: 0,
            committed_current_bytes: current_rss,
            reset_total_bytes: 0,
            purged_total_bytes: 0,
        }
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

    // primary_metric_reports_a_real_measurement_never_zero lives in tests/rss_guard_metric.rs: it measures a process-wide memory counter, so it must run alone in its own process (TRDD-10NGH2BR).
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
    /// question rather than carrying it forward. That test passes a real RSS reader as the fallback,
    /// so on macOS a `None` from `phys_footprint_bytes` — the syscall failing, or returning non-zero
    /// `rc` — makes it report a healthy RSS number and pass GREEN while the breach log's evidence has
    /// silently become RSS. Footprint is the number jetsam charges and the header documents RSS as the
    /// wrong number to indict, so that substitution must fail loudly. DO NOT DELETE THIS AS REDUNDANT:
    /// the delta test discards the metric name (`let (_, before)`), so a `None` there sails through green
    /// on the fallback and nothing in it objects. This is the only assertion in the file covering that case.
    #[cfg(target_os = "macos")]
    #[test]
    fn phys_footprint_is_present_on_macos_not_silently_none() {
        phys_footprint_bytes().expect(
            "proc_pid_rusage returned non-zero — phys_footprint_bytes is None, so the breach log's evidence \
             would silently be RSS instead of the footprint macOS actually charges",
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

    /// THE DECISION READS MIMALLOC COMMIT, NOT THE FALLBACK. Commit is 3 GB, over the 2 GB cap, while
    /// the fallback reads 1 GB, under it. A decision keyed on the fallback returns without flushing,
    /// so the `should_panic` never fires and the test fails. Not gated by platform: the commit is
    /// injected, so the decision is observed on every platform. (On macOS a fallback-keyed mutant
    /// would read the real footprint, a few MB, and also miss the breach.)
    #[test]
    #[should_panic(expected = "BREACH")]
    fn hard_cap_breaches_on_commit_even_when_the_fallback_is_under_cap() {
        let log = std::env::temp_dir().join(format!("al-rss-guard-commit-breach-{}.log", std::process::id()));
        check_and_enforce_with(
            || 3 * 1024 * 1024 * 1024,
            || 1024 * 1024 * 1024,
            || panic!("BREACH"),
            &log,
            snap(2 * 1024 * 1024 * 1024),
        );
    }

    /// THE OWNER'S CASE: commit 1 GB is under the 2 GB cap while RSS reads 4 GB — DuckDB's memory,
    /// which the cap must not charge. A decision keyed on the fallback breaches here and the flush
    /// closure panics. This discriminates only on the RSS path: on macOS a fallback-keyed mutant reads
    /// the real footprint instead, which is under the cap, so this test passes there under the
    /// mutation; `hard_cap_breaches_on_commit_even_when_the_fallback_is_under_cap` is the one that
    /// catches it on macOS.
    #[test]
    fn owner_case_commit_under_cap_with_rss_over_cap_is_no_breach() {
        let log = std::env::temp_dir().join(format!("al-rss-guard-duckdb-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&log);
        check_and_enforce_with(
            || 1024 * 1024 * 1024,
            || 4 * 1024 * 1024 * 1024,
            || panic!("commit is under the cap: the flush must not run"),
            &log,
            snap(2 * 1024 * 1024 * 1024),
        );
        assert!(!log.exists(), "an under-cap commit must not write a culprit log");
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
        let mut m = mi(400 * 1024 * 1024);
        m.current_commit_bytes = 2_600 * 1024 * 1024; // the decision counter, over the 2048 MB cap
        let d = format_diagnostic("phys_footprint", 5_400 * 1024 * 1024, &m, &snap(2048 * 1024 * 1024));
        assert!(d.contains("mimalloc commit 2600 MB > cap 2048 MB"), "the decision counter must lead the breach line; got:\n{d}");
        assert!(d.contains("evidence: phys_footprint 5400 MB"), "the footprint must still be logged as evidence; got:\n{d}");
        assert!(d.contains("process RSS 400 MB"), "current_rss must be labelled process RSS, not mimalloc heap; got:\n{d}");
        assert!(d.contains("mimalloc commit"), "the log must separate mimalloc's own commit counter from whole-process RSS; got:\n{d}");
        // The label must name its METHOD, not a suspect. Naming DuckDB here was measurably
        // premature: a live vmmap on 2026-09-07 put the mimalloc side ahead on RESIDENT (3.4 G vs
        // 2.3 G) but well behind on DIRTY (876 M vs ~2.7 G), so a log asserting "DuckDB" would
        // have been read as a finding when nothing had measured DuckDB. The floor subtracts
        // mimalloc COMMIT, not process RSS: footprint − process-RSS is resident-clean (libs,
        // mapped files) and saturates to ~0 in real kills, while commit is the mimalloc-owned
        // counter (decremented on decommit), so footprint − commit bounds the non-mimalloc dirty
        // share from below (5400 − 2600 = 2800 MB here).
        assert!(d.contains("non-mimalloc-dirty floor"));
        assert!(d.contains("): 2800 MB"));
        assert!(!d.contains("e.g. DuckDB"), "the diagnostic must not name a suspect it did not measure");
        assert!(d.contains("resident spans: 397"));
        for line in d.lines() {
            assert!(line.starts_with("alcore: RSS HARD CAP —"), "line not prefixed for grep: {line}");
        }
    }

    #[test]
    fn stats_fields_parse_counts_as_objects_and_counters_as_bare_integers() {
        // TRDD-2JOIAH2G round-98: the parse extension for committed/reset/purged/peak. The JSON
        // shape is pinned by the vendored writer (stats.c mi_stats_get_json_from):
        // MI_STAT_COUNT fields are OBJECTS {total, peak, current}, MI_STAT_COUNTER fields are
        // BARE INTEGERS — so `reset`/`purged` must NOT be read with a `.total` hop (the payload
        // has no such key; reading it would parse to 0 forever and silently gut the
        // decommit-policy instrument). The fixture below mirrors the writer's exact emission.
        let json = serde_json::json!({
            "stat_version": 5,
            "pages": { "total": 10, "peak": 12, "current": 8 },
            "committed": { "total": 2147483648u64, "peak": 2201170432u64, "current": 2097152000u64 },
            "reset": 4294967296u64,
            "purged": 1073741824u64,
            "pages_abandoned": { "total": 20000, "peak": 19600, "current": 146 }
        });
        assert_eq!(get_u64(&json, &["committed", "current"]), 2_097_152_000);
        assert_eq!(get_u64(&json, &["pages_abandoned", "current"]), 146);
        assert_eq!(get_u64(&json, &["pages_abandoned", "peak"]), 19_600);
        // The counter shape is the load-bearing assertion: a `.total` hop on these keys returns 0.
        assert_eq!(get_u64(&json, &["reset"]), 4_294_967_296);
        assert_eq!(get_u64(&json, &["purged"]), 1_073_741_824);
        // Missing keys / non-u64 shapes degrade to 0 — the module's existing contract.
        // M5 (TRDD-2JOIAH2G): the payload's own stat_version is the runtime discriminator the
        // once-per-process stderr line reads — pin its parse here too.
        assert_eq!(get_u64(&json, &["stat_version"]), 5);
        assert_eq!(get_u64(&json, &["nope"]), 0);
        assert_eq!(get_u64(&json, &["committed", "nope", "deeper"]), 0);
        assert_eq!(get_u64(&json, &["committed", "total"]), 2_147_483_648);
        let mut s = json.clone();
        s["reset"] = serde_json::Value::String("not a number".into());
        assert_eq!(get_u64(&s, &["reset"]), 0);
    }
}
