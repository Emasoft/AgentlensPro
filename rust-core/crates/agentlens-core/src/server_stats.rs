//! `GET /api/server-stats` (TRDD-DMWOBWFH) — the frozen §1.4 body of the wire freeze
//! (`reports/p4-wire-freeze/20260818_200921+0200-frozen-wire-surface.md`), key order EXACT,
//! ported from server.ts's handler. Every value the Rust core owns is real (process, ports,
//! the span window + store, the log-session map, the persistence counters + delta-log sizes,
//! the resource sample, the hook runtime config, the bucket/archive disk usage). Subsystems
//! NOT ported yet report the TS server's own idle/empty value for that key — never an invented
//! one — each marked `// NOT PORTED:` below so the gap is greppable:
//!   - `memory.heapUsedMb/heapLimitMb` — there is no V8 heap; 0/0 ("no heap"), rss is real.
//!   - hook-event / log-event / statusline ingestion, the body archive + spool, the admission
//!     controller, the OTLP log-event gate, the fallback counters — counters 0, maps `{}`,
//!     `spool` null (SPOOL_MODE off), disk usage REAL (read from the same on-disk layout).
//!
//! The TS heap-pressure halving is not ported either, so `spans.windowMs == configuredWindowMs`.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::retention_config::{resolve_knob, LOG_EVENTS_RETENTION_DAYS, SPANS_RETENTION_DAYS};
use crate::summarize::helpers::{iso_from_ms, num};
use crate::CoreState;

/// server.ts `persistStats` — the write counters this process owns. Only the span/offsets/cards
/// rows move in the Rust core today; the rest exist so the frozen shape is served unchanged.
#[derive(Clone, Copy, Debug, Default)]
pub struct PersistStats {
    pub span_append_writes: u64,
    pub span_append_bytes: u64,
    pub offsets_writes: u64,
    pub offsets_bytes: u64,
    pub cards_writes: u64,
    pub cards_bytes: u64,
    pub hook_event_writes: u64,
    pub hook_event_bytes: u64,
    /// The log-event sink (TRDD-AMEA4O4Z): every gate-rejected OTEL log event persisted to
    /// `<data>/log-events/`, counted where it is written.
    pub log_event_writes: u64,
    pub log_event_bytes: u64,
    /// The burn gate's counters (P4r.5): every POST /api/agent-gate that built a state is a
    /// check; denies/warns/advisories count what actually went back to a model.
    pub gate_checks: u64,
    pub gate_denies: u64,
    pub gate_warns: u64,
    pub gate_advisories: u64,
    /// Row 5: samples accepted into the statusline store (both routes — the dedicated endpoint
    /// and the legacy hook-events divert).
    pub statusline_samples: u64,
    /// spool_backpressure::tick's transition count — how many times the RAM-disk spool has
    /// crossed into its back-pressure floor since boot.
    pub spool_backpressure_spills: u64,
    /// spool_backpressure::tick's current reading — is the spool over its floor RIGHT NOW.
    pub spool_backpressure_active: bool,
}

/// The bound listeners (server.ts UI_PORT / MCP_PORT / OTLP_PORT). All three are now really
/// bound — `alcore serve` sets `mcp` from `--mcp-port` after `serve_mcp` claims it (C1). Until
/// then this field carried the env default (4316) while nothing listened on it, so the server
/// stated a port about itself that a client would find dead.
#[derive(Clone, Copy, Debug)]
pub struct Ports {
    pub ui: u16,
    pub mcp: u16,
    pub otlp: u16,
}

impl Default for Ports {
    fn default() -> Ports {
        let mcp = std::env::var("MCP_PORT").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(4316);
        Ports { ui: 3001, mcp, otlp: 4319 }
    }
}

/// `package.json` `version`, resolved once — the build that is answering (server.ts
/// SERVER_VERSION). Embedded at compile time: the binary cannot read the repo at run time.
pub fn package_version() -> &'static str {
    static V: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        serde_json::from_str::<Value>(include_str!("../../../../package.json"))
            .ok()
            .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
            .expect("package.json carries a version")
    })
}

/// src/hookRuntimeConfig.ts — `<data-dir>/hook-config.json`, precedence for gateMode: file >
/// AGENTLENS_GATE_MODE env > 'enforce'; booleans file > default true. Absent/unparseable = defaults.
/// Held on CoreState once loaded (the TS `hookRuntime` let): a POST /api/hook-config replaces it;
/// an external edit of the file is NOT picked up until restart, as in TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookRuntime {
    pub capture_enabled: bool,
    pub gate_enabled: bool,
    pub gate_mode: &'static str,
    pub advisor_enabled: bool,
    pub cache_guard_enabled: bool,
}

impl HookRuntime {
    /// The wire object, in the TS `coerce` key order.
    pub fn to_value(self) -> Value {
        json!({
            "captureEnabled": self.capture_enabled,
            "gateEnabled": self.gate_enabled,
            "gateMode": self.gate_mode,
            "advisorEnabled": self.advisor_enabled,
            "cacheGuardEnabled": self.cache_guard_enabled,
        })
    }
}

/// coerce(raw, envMode): booleans keep their default on a non-boolean; gateMode file > env >
/// 'enforce'. `env_mode` None = ignore the env (the save path).
fn coerce_hook_runtime(o: &Map<String, Value>, env_mode: Option<&str>) -> HookRuntime {
    let b = |k: &str| o.get(k).and_then(Value::as_bool).unwrap_or(true);
    let gate_mode = match o.get("gateMode").and_then(Value::as_str) {
        Some("warn") => "warn",
        Some("enforce") => "enforce",
        _ => {
            if env_mode == Some("warn") {
                "warn"
            } else {
                "enforce"
            }
        }
    };
    HookRuntime {
        capture_enabled: b("captureEnabled"),
        gate_enabled: b("gateEnabled"),
        gate_mode,
        advisor_enabled: b("advisorEnabled"),
        cache_guard_enabled: b("cacheGuardEnabled"),
    }
}

pub fn hook_config_file(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("hook-config.json")
}

/// loadHookRuntimeConfig — absent or unparseable: defaults (+ the env), never a crash.
pub fn hook_runtime_config(data_dir: &Path) -> HookRuntime {
    let o = std::fs::read_to_string(hook_config_file(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let env = std::env::var("AGENTLENS_GATE_MODE").ok();
    coerce_hook_runtime(&o, env.as_deref())
}

/// saveHookRuntimeConfig — merge a partial update over the current config, persist atomically
/// (tmp + rename, 2-space JSON + newline), return the applied config. Unknown keys are ignored
/// (a typo must not brick the hooks); an invalid value falls back to the CURRENT one — coerce
/// would turn a junk gateMode into 'enforce', so that case keeps the current mode explicitly.
pub fn save_hook_runtime_config(data_dir: &Path, current: HookRuntime, patch: &Map<String, Value>) -> Result<HookRuntime, String> {
    let mut merged_obj = current.to_value().as_object().cloned().unwrap_or_default();
    for (k, v) in patch {
        merged_obj.insert(k.clone(), v.clone());
    }
    let mut merged = coerce_hook_runtime(&merged_obj, None);
    if let Some(gm) = patch.get("gateMode") {
        if gm.as_str() != Some("warn") && gm.as_str() != Some("enforce") {
            merged.gate_mode = current.gate_mode;
        }
    }
    let file = hook_config_file(data_dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = file.with_file_name(format!("hook-config.json.tmp-{}", std::process::id()));
    let text = format!("{}\n", serde_json::to_string_pretty(&merged.to_value()).map_err(|e| e.to_string())?);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(merged)
}

/// src/ndjsonBuckets.ts bucketsDiskUsage — `YYYY-MM-DD.ndjsonl` daily buckets only
/// (calendar-real dates, the same round-trip check the span segments use).
pub fn buckets_disk_usage(dir: &Path) -> (u64, u64) {
    let (mut files, mut bytes) = (0u64, 0u64);
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0) };
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".ndjsonl") else { continue };
        if agentlens_spanstore::segment_day_ms(&format!("{stem}.ndjson")).is_none() {
            continue;
        }
        if let Ok(m) = e.metadata() {
            bytes += m.len();
            files += 1;
        }
    }
    (files, bytes)
}

/// src/bodyArchive.ts archiveDiskUsage — `bodies-YYYY-MM.wad` volumes + their `.idx`, entries =
/// index lines that parse (a torn tail line is skipped, as in loadVolumeIndex).
pub fn archive_disk_usage(dir: &Path) -> (u64, u64, u64) {
    let (mut volumes, mut bytes, mut entries) = (0u64, 0u64, 0u64);
    let Ok(rd) = std::fs::read_dir(dir) else { return (0, 0, 0) };
    for e in rd.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if !crate::body_archive::is_volume_name(name) {
            continue;
        }
        volumes += 1;
        let volume = dir.join(name);
        let idx = dir.join(format!("{name}.idx"));
        for f in [&volume, &idx] {
            bytes += std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        }
        if let Ok(raw) = std::fs::read_to_string(&idx) {
            entries += raw.split('\n').filter(|l| !l.is_empty() && serde_json::from_str::<Value>(l).is_ok()).count() as u64;
        }
    }
    (volumes, bytes, entries)
}

/// src/bodyArchive.ts `liveBodiesLiveness`, generalized over every readable capture dir (spool +
/// legacy — `burn::guard::resolve_bodies_read_scope`) rather than the TS's single
/// `PRIMARY_BODIES_DIR`: alcore has both dirs live during a spool drain and the TS's single-dir
/// read would under-count exactly then. `newestMs` is `None` for an empty/absent scope — an
/// ABSENT reading, never 0, which would render as "captured just now" (TRDD-ZIWEB0UW).
pub fn live_bodies_liveness(dirs: &[std::path::PathBuf]) -> (u64, Option<f64>) {
    let (mut files, mut newest_ms) = (0u64, None::<f64>);
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.ends_with(".request.json") && !name.ends_with(".response.json") {
                continue;
            }
            files += 1;
            let Ok(meta) = e.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) else { continue };
            let ms = since_epoch.as_secs_f64() * 1000.0;
            if newest_ms.is_none_or(|n| ms > n) {
                newest_ms = Some(ms);
            }
        }
    }
    (files, newest_ms)
}

/// src/rustStorePass.ts `parkedBodiesGauge` — cross-references the pass's persisted
/// `strandedNames` (TRDD-8TM7I49X: bodies whose store row failed verify and were never deleted)
/// against the live capture dirs. `None` = pass-state file missing/corrupt ("could not look" —
/// the CLI renders this as `unknown`, never as zero). `Some((files, bytes, onDisk))` mirrors the
/// TS shape: `files` is the persisted stranded-name count, `bytes`/`onDisk` only what is still
/// found on disk (a name can outlive its file — the `onDisk < files` "ghost" case).
///
/// ponytail: no mtime/readdir-count cache like the TS's `parkedCache` — this endpoint is
/// admission-exempt and dashboards poll it, so add the cache if a profile ever shows this stat
/// path hot enough to matter (TS added its cache after measuring 14.7ms/call at ~1000 names).
pub fn parked_bodies_gauge(store_dir: &Path, live_dirs: &[std::path::PathBuf]) -> Option<(u64, u64, u64)> {
    let raw = std::fs::read_to_string(store_dir.join(agentlens_store::pass::PASS_STATE_FILE)).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let names = parsed.get("strandedNames")?.as_array()?;
    let mut remaining: std::collections::HashSet<String> =
        names.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    let files = remaining.len() as u64;
    let (mut bytes, mut on_disk) = (0u64, 0u64);
    for dir in live_dirs {
        if remaining.is_empty() {
            break;
        }
        for name in remaining.clone() {
            if let Ok(meta) = std::fs::metadata(dir.join(&name)) {
                bytes += meta.len();
                on_disk += 1;
                remaining.remove(&name);
            }
        }
    }
    Some((files, bytes, on_disk))
}

/// Physical RAM of the host, bytes. macOS: sysctl `hw.memsize`; Linux: /proc/meminfo MemTotal;
/// elsewhere (or on any read failure) 0 = unknown, never a guess — callers must treat 0 as
/// "no RAM-relative default available" and keep their absolute floor.
pub fn total_memory_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut size: u64 = 0;
        let mut len = std::mem::size_of::<u64>() as libc::size_t;
        let name = b"hw.memsize\0";
        // SAFETY: `name` is NUL-terminated, `size` is a valid out-buffer of exactly `len` bytes.
        let rc = unsafe {
            libc::sysctlbyname(name.as_ptr() as *const libc::c_char, &mut size as *mut u64 as *mut libc::c_void, &mut len, std::ptr::null_mut(), 0)
        };
        return if rc == 0 { size } else { 0 };
    }
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|s| {
                let line = s.lines().find(|l| l.starts_with("MemTotal:"))?;
                let kb = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
                Some(kb * 1024)
            })
            .unwrap_or(0);
    }
    #[allow(unreachable_code)]
    0
}

/// Resident set size of this process, bytes. macOS: proc_pidinfo(PROC_PIDTASKINFO); Linux:
/// /proc/self/statm × page size; elsewhere 0 (unknown, not a guess).
pub fn rss_bytes() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: a zeroed proc_taskinfo is a valid out-buffer of exactly `size` bytes.
        let n = unsafe {
            libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTASKINFO, 0, &mut info as *mut libc::proc_taskinfo as *mut libc::c_void, size)
        };
        if n == size {
            return info.pti_resident_size;
        }
        0
    }
    #[cfg(target_os = "linux")]
    {
        let pages = std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok())
            .unwrap_or(0);
        // SAFETY: sysconf has no preconditions.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        pages * (if page > 0 { page as u64 } else { 4096 })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        0
    }
}

/// src/resourceMonitor.ts sample(): `{rssMb, loadPerCore, freeDiskMb, cpuCount}` — unrounded;
/// loadPerCore 0 where loadavg is unavailable; freeDiskMb None (→ null, TS Infinity) where
/// statvfs fails.
pub fn resource_sample(data_dir: &Path) -> Value {
    let cpu_count = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1);
    let rss_mb = rss_bytes() as f64 / 1_048_576.0;
    let load1 = {
        #[cfg(unix)]
        {
            let mut l = [0f64; 3];
            // SAFETY: a 3-slot out-buffer for up to 3 samples.
            let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
            if n >= 1 {
                l[0]
            } else {
                0.0
            }
        }
        #[cfg(not(unix))]
        {
            0.0
        }
    };
    let load_per_core = load1 / cpu_count as f64;
    let free_disk_mb = free_disk_bytes(data_dir).map(|b| num(b as f64 / 1_048_576.0)).unwrap_or(Value::Null);
    json!({ "rssMb": num(rss_mb), "loadPerCore": num(load_per_core), "freeDiskMb": free_disk_mb, "cpuCount": cpu_count })
}

/// `bodies.spool` (TRDD-ZW4APOPI box 3): the RAM-disk spool as an operator would read it with
/// `df` + `ls`, so "the spool is 100% full and capture is silently losing bodies" is visible in
/// `/api/server-stats` instead of needing a shell on the box. `null` when no spool is configured
/// (the legacy single-dir install).
///
/// TWO booleans, because "the path exists" is NOT "the RAM disk is there" (adversarial review):
/// the configured path sits INSIDE the mount (`/Volumes/AgentLensSpool/otel-bodies`), and after
/// a reboot, an unclean eject, or a leaked twin mount (`/Volumes/AgentLensSpool 1` appears only
/// when the primary path was already OCCUPIED at attach time) it can resolve to a plain
/// directory on the boot volume — then a path check reports a healthy spool with the SSD's
/// terabyte of free space while bodies land on the disk the spool exists to protect. The
/// discriminator is the device id: `ownVolume` is `dev(dir) != dev(data_dir)`. `exists: false`
/// is the `spool ensure` LaunchAgent's case. Free/total are `null` when statvfs cannot answer,
/// never a fabricated 0 (a 0 here would read as "full"); they are `df`'s Size and Avail columns
/// (`f_blocks`/`f_bavail` × `f_frsize`). Back-pressure figures are the chore's own controller
/// state, passed in. `files` and `stagedBytes` use the same `*.request.json`/`*.response.json`
/// filter (`live_bodies_liveness` / `staged_body_bytes`), so the two never disagree over a
/// half-written temp file.
pub fn spool_gauge(data_dir: &Path, backpressure_active: bool, backpressure_spills: u64) -> Value {
    let Some(dir) = crate::burn::guard::spool_dir_configured(data_dir) else { return Value::Null };
    let exists = std::fs::metadata(&dir).is_ok_and(|m| m.is_dir());
    let own_volume = exists && device_id(&dir).zip(device_id(data_dir)).is_some_and(|(a, b)| a != b);
    let (files, staged_bytes, free, total) = if exists {
        let (files, _) = live_bodies_liveness(std::slice::from_ref(&dir));
        (files, crate::chores::staged_body_bytes(&dir), free_disk_bytes(&dir), total_disk_bytes(&dir))
    } else {
        (0, 0, None, None)
    };
    let vars: std::collections::HashMap<String, String> = std::env::vars().collect();
    json!({
        "dir": dir.to_string_lossy(),
        "exists": exists,
        "ownVolume": own_volume,
        "files": files,
        "stagedBytes": staged_bytes,
        "freeBytes": free.map(|b| json!(b)).unwrap_or(Value::Null),
        "totalBytes": total.map(|b| json!(b)).unwrap_or(Value::Null),
        "floorBytes": crate::spool_backpressure::spool_floor_bytes(&vars),
        "backpressure": { "active": backpressure_active, "spills": backpressure_spills },
    })
}

/// The device id a path lives on (`st_dev`); None when it cannot be stat'ed. Two paths on
/// different ids are on different volumes — the only honest "is this a mount" a userland reader
/// has without parsing `mount`.
fn device_id(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|m| m.dev())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// statvfs(path): blocks × frsize — the volume's size, the denominator `df` prints; None when unknown.
pub fn total_disk_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: valid NUL-terminated path, zeroed out-struct.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(st.f_blocks as u64 * st.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// statvfs(dataDir): bavail × frsize (Node's statfsSync bavail × bsize); None when unknown.
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: valid NUL-terminated path, zeroed out-struct.
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// The frozen §1.4 body over the live state. `now_ms` is the request clock.
pub fn server_stats(st: &CoreState, now_ms: i64) -> Value {
    // Read from the ONE process-wide controller the HTTP handlers admit through, so these counters
    // describe the sheds that actually happened rather than a second, separately-kept tally.
    let adm = crate::ui::admission_controller().stats();
    // src/shared/fallbackCounters.ts `fallbackTotals()` — every counter that FIRED since boot,
    // name-sorted. A name that never fired is ABSENT, deliberately: honest absence beats zero-noise
    // for paths that never degraded, and it is what lets a reader tell "this never happened" from
    // "this is not instrumented" (TRDD-465EXTJ6).
    //
    // alcore already counted the event — `counters.parse_errors`, incremented on exactly the path
    // the TS calls `countFallback('standalone.otlpIngestError')` on: an OTLP payload that could not
    // be parsed, ACKed 200 (fail-open — an exporter must never error-loop on us) and then dropped.
    // It just never surfaced it, so every swallowed payload was invisible.
    let degradations = {
        let mut d = Map::new();
        if st.counters.parse_errors > 0 {
            d.insert("standalone.otlpIngestError".into(), Value::from(st.counters.parse_errors));
        }
        d
    };
    let data_dir = st.data_dir.as_path();
    let (segments, total_spans, total_bytes) = st.writer.stats();
    let p = st.persist;
    // Math.round(mem.rss / 1048576) / Math.round(elapsed / 1000): integers on the wire.
    let rss_mb = (rss_bytes() + 524_288) / 1_048_576;
    let uptime_sec = ((now_ms - st.started_at_ms).max(0) + 500) / 1000;
    let spans_retention_days = num(resolve_knob(data_dir, &SPANS_RETENTION_DAYS));
    let log_events_retention_days = num(resolve_knob(data_dir, &LOG_EVENTS_RETENTION_DAYS));
    let (hook_files, hook_bytes) = buckets_disk_usage(&data_dir.join("hook-events"));
    let (log_ev_files, log_ev_bytes) = buckets_disk_usage(&data_dir.join("log-events"));
    let (volumes, archive_bytes, entries) = archive_disk_usage(&data_dir.join("otel-bodies-archive"));
    // TRDD-ZIWEB0UW: capture WORKS (bodies land on disk) but this endpoint never said so — the CLI
    // rendered "capture: unknown (server predates capture reporting)" for every alcore boot because
    // `bodies.live` was absent. Every readable capture dir (spool + legacy), same low-frequency
    // scan cost as the TS's single-dir version this mirrors (bodyArchive.ts `liveBodiesLiveness`).
    let bodies_scope = crate::burn::guard::resolve_bodies_read_scope(data_dir, &std::env::vars().collect());
    let (live_files, live_newest_ms) = live_bodies_liveness(&bodies_scope.dirs);
    // TRDD-ZIWEB0UW remainder: the `live` gauge above shipped without its `parked` sibling, so
    // `server status` silently dropped the PARKED suffix that warns of TRDD-8TM7I49X bodies
    // pinned forever. Both live dirs are scanned — a parked name can belong to either.
    let parked = parked_bodies_gauge(&data_dir.join("store"), &bodies_scope.dirs);
    let hook_spooled = std::fs::read_dir(data_dir.join("hook-spool"))
        .map(|rd| rd.flatten().filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json"))).count())
        .unwrap_or(0);
    let offsets_bytes_on_disk = crate::delta_log::DeltaLog::new(data_dir, "log-offsets").disk_bytes();
    let cards_bytes_on_disk = crate::delta_log::DeltaLog::new(data_dir, "log-sessions").disk_bytes();
    let hook = st.hook_runtime;
    let sl = st.statusline.stats();
    // statusline retentionDays: src/statuslineStore.ts retentionDays() — env, else 90.
    let statusline_retention_days = num(
        std::env::var("AGENTLENS_STATUSLINE_RETENTION_DAYS")
            .ok()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(90.0),
    );

    json!({
        "pid": std::process::id(),
        "version": package_version(),
        "startedAt": iso_from_ms(st.started_at_ms as f64),
        "uptimeSec": uptime_sec,
        "ports": { "ui": st.ports.ui, "mcp": st.ports.mcp, "otlp": st.ports.otlp },
        "canonical": st.ports.otlp == 4318,
        "dataDir": data_dir.to_string_lossy(),
        // NOT PORTED: V8 heap — rss is real, heapUsedMb/heapLimitMb are 0 ("no heap"), never a
        // number that looks like one.
        "memory": { "rssMb": rss_mb, "heapUsedMb": 0, "heapLimitMb": 0 },
        "spans": {
            "inMemory": st.window.spans.len(),
            "windowMs": st.window.effective_ms,
            "configuredWindowMs": st.window.configured_ms,
            "retentionDays": spans_retention_days,
            "pendingAppends": st.writer.pending_appends(),
            // Spans lost to the failing-disk failsafe. MUST stay exposed: the writer's contract
            // promises drops are "counted, never silently", and for the whole life of that comment
            // nothing read the counter — so an operator who lost 42% of their telemetry
            // (TRDD-YU8QPU89) could not discover it from the HTTP response, from here, or from a
            // log line. Non-zero means a real disk fault, not a burst.
            "droppedOnFailure": st.writer.dropped_on_failure(),
            "store": { "segments": segments, "totalSpans": total_spans, "totalBytes": total_bytes },
        },
        "logSessions": st.log_sessions.len(),
        "persistence": {
            "spanAppendWrites": p.span_append_writes, "spanAppendBytes": p.span_append_bytes,
            "offsetsWrites": p.offsets_writes, "offsetsBytes": p.offsets_bytes,
            "cardsWrites": p.cards_writes, "cardsBytes": p.cards_bytes,
            "hookEventWrites": p.hook_event_writes, "hookEventBytes": p.hook_event_bytes,
            // The log-event sink IS ported now (C2b). These two are the SAME counters the
            // `logEvents` row reports as persistedSinceBoot/Bytes — the TS spreads the whole
            // persistStats object here (`...p`), so both places carry them and a reader may
            // legitimately use either. NOT PORTED, still: the bodies purge and the spool below.
            "logEventWrites": p.log_event_writes, "logEventBytes": p.log_event_bytes,
            "statuslineSamples": p.statusline_samples,
            "gateChecks": p.gate_checks, "gateDenies": p.gate_denies, "gateWarns": p.gate_warns, "gateAdvisories": p.gate_advisories,
            "bodiesLastPurge": { "at": 0, "removedFiles": 0, "freedBytes": 0, "keptFiles": 0, "keptBytes": 0 },
            "spoolBackpressureSpills": p.spool_backpressure_spills,
            "spoolBackpressureActive": p.spool_backpressure_active,
            "totalBytesWritten": p.span_append_bytes + p.offsets_bytes + p.cards_bytes + p.hook_event_bytes,
            "files": { "spans": total_bytes, "offsets": offsets_bytes_on_disk, "cards": cards_bytes_on_disk },
        },
        "bodies": {
            "archive": { "volumes": volumes, "bytes": archive_bytes, "entries": entries },
            "lastPass": { "at": 0, "removedFiles": 0, "freedBytes": 0, "keptFiles": 0, "keptBytes": 0 },
            "live": { "files": live_files, "newestMs": live_newest_ms.map(num).unwrap_or(Value::Null) },
            "parked": match parked {
                Some((files, bytes, on_disk)) => json!({ "files": files, "bytes": bytes, "onDisk": on_disk }),
                None => Value::Null,
            },
            // TRDD-ZW4APOPI box 3: null only when no spool is configured; a configured path that
            // is absent, or present but NOT its own volume, is reported as such (see `spool_gauge`).
            "spool": spool_gauge(data_dir, p.spool_backpressure_active, p.spool_backpressure_spills),
        },
        "hookEvents": { "files": hook_files, "bytes": hook_bytes, "receivedSinceBoot": p.hook_event_writes, "spooled": hook_spooled },
        "statusline": {
            "parts": sl["parts"], "partBytes": sl["partBytes"], "walBytes": sl["walBytes"],
            "bufferedRows": sl["bufferedRows"], "sealedParts": sl["sealedParts"],
            "droppedRows": sl["droppedRows"], "corruptWals": sl["corruptWals"],
            "receivedSinceBoot": p.statusline_samples, "retentionDays": statusline_retention_days,
        },
        "logEvents": { "files": log_ev_files, "bytes": log_ev_bytes, "persistedSinceBoot": p.log_event_writes, "persistedBytesSinceBoot": p.log_event_bytes, "retentionDays": log_events_retention_days },
        // The LIVE admission counters (TRDD-465EXTJ6). These were hard-coded zeros while the
        // controller existed only in the TypeScript server — which meant a shipped alcore reported
        // "no backpressure ever" whether or not any occurred, and there was no way to tell an
        // idle server from one shedding every request.
        "admission": { "inflight": adm.0, "queued": adm.1, "admittedTotal": adm.2, "shedTotal": adm.3 },
        "resources": resource_sample(data_dir),
        "gate": {
            "mode": hook.gate_mode, "enabled": hook.gate_enabled,
            "captureEnabled": hook.capture_enabled, "advisorEnabled": hook.advisor_enabled,
            "checks": p.gate_checks, "denies": p.gate_denies, "warns": p.gate_warns, "advisories": p.gate_advisories,
        },
        // The gate IS ported and HAS been counting all along — `IngestState::dropped_log_events`,
        // `(other)` overflow bucket included. This line reported `{}` behind a "NOT PORTED"
        // comment that had gone stale, so a real rejection count was computed on every ingest and
        // then thrown away one field from where it was needed. Insertion order is preserved
        // (IndexMap + serde_json preserve_order), so the wire order matches the TS's object.
        "otlpDroppedLogEvents": st.ingest.dropped_log_events.iter()
            .map(|(k, v)| (k.clone(), Value::from(*v)))
            .collect::<Map<String, Value>>(),
        // NOT PORTED: src/shared/fallbackCounters.ts — counters that never fired are absent ⇒ {}.
        // src/shared/fallbackCounters.ts `fallbackTotals()` — every counter that FIRED since boot,
        // name-sorted. A name that never fired is ABSENT, deliberately: honest absence beats
        // zero-noise for paths that never degraded, and it is what lets a reader tell "this never
        // happened" from "this is not instrumented" (TRDD-465EXTJ6).
        //
        // alcore already counted the event — `counters.parse_errors`, incremented on exactly the
        // path the TS calls `countFallback('standalone.otlpIngestError')` on: an OTLP payload that
        // could not be parsed, ACKed 200 (fail-open, an exporter must never error-loop on us) and
        // then dropped. It just never surfaced it, so a swallowed payload was invisible.
        "degradations": degradations,
    })
}

#[cfg(test)]
mod capture_block_tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// TRDD-ZIWEB0UW: `bodies.live` must report the real file count and newest mtime — a zeroed
    /// count (empty dir) must NOT report the same `files`/`newestMs` as a populated one, which is
    /// exactly what a stub returning constants would fail to catch.
    #[test]
    fn live_bodies_liveness_counts_request_response_files_and_finds_the_newest() {
        let dir = std::env::temp_dir().join(format!("alcore-capture-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.request.json"), b"{}").unwrap();
        std::fs::write(dir.join("a.response.json"), b"{}").unwrap();
        std::fs::write(dir.join("ignored.txt"), b"not a body").unwrap();
        // Backdate the first pair so the second write is unambiguously the newest even on a
        // coarse-granularity filesystem clock.
        let old = SystemTime::now() - Duration::from_secs(3600);
        filetime::set_file_mtime(dir.join("a.request.json"), filetime::FileTime::from_system_time(old)).unwrap();
        filetime::set_file_mtime(dir.join("a.response.json"), filetime::FileTime::from_system_time(old)).unwrap();
        std::fs::write(dir.join("b.request.json"), b"{}").unwrap();

        let (files, newest_ms) = live_bodies_liveness(std::slice::from_ref(&dir));
        assert_eq!(files, 3, "counts only *.request.json/*.response.json, not the .txt file");
        let newest_ms = newest_ms.expect("non-empty dir must report a newest mtime");
        let b_mtime_ms = std::fs::metadata(dir.join("b.request.json")).unwrap().modified().unwrap()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0;
        assert!((newest_ms - b_mtime_ms).abs() < 1.0, "newest must be b.request.json's mtime, not a.*'s backdated one");

        // Mutation check: an empty dir must report ZERO files and NO newest reading — not the same
        // numbers as the populated case above, which is what proves the counter is really counting.
        let empty_dir = std::env::temp_dir().join(format!("alcore-capture-test-empty-{}", std::process::id()));
        std::fs::create_dir_all(&empty_dir).unwrap();
        let (empty_files, empty_newest) = live_bodies_liveness(std::slice::from_ref(&empty_dir));
        assert_eq!(empty_files, 0);
        assert!(empty_newest.is_none());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty_dir).ok();
    }

    /// TRDD-ZIWEB0UW remainder: `bodies.parked` must distinguish "no pass-state file" (`None` —
    /// renders `unknown`) from "a real, populated stranded set" — a stub returning `None` always,
    /// or `Some((0,0,0))` always, would pass a same-shape-only check.
    #[test]
    fn parked_bodies_gauge_reads_stranded_names_and_reports_ghosts() {
        let store_dir = std::env::temp_dir().join(format!("alcore-parked-test-{}", std::process::id()));
        let live_dir = std::env::temp_dir().join(format!("alcore-parked-test-live-{}", std::process::id()));
        std::fs::create_dir_all(&store_dir).unwrap();
        std::fs::create_dir_all(&live_dir).unwrap();

        // No pass-state file yet ⇒ None ("could not look"), never a fabricated zero.
        assert!(parked_bodies_gauge(&store_dir, std::slice::from_ref(&live_dir)).is_none());

        // One stranded name present on disk, one whose file already vanished (a "ghost").
        std::fs::write(live_dir.join("a.request.json"), b"12345").unwrap();
        agentlens_store::pass::save_pass_state(
            &store_dir.join(agentlens_store::pass::PASS_STATE_FILE),
            &std::collections::HashSet::new(),
            &["a.request.json".to_string(), "gone.request.json".to_string()].into_iter().collect(),
        );

        let (files, bytes, on_disk) = parked_bodies_gauge(&store_dir, std::slice::from_ref(&live_dir)).unwrap();
        assert_eq!(files, 2, "files counts the persisted stranded-name set, not just what's on disk");
        assert_eq!(bytes, 5, "bytes sums only the names actually found on disk");
        assert_eq!(on_disk, 1, "onDisk < files is the ghost case — the missing name must not count");

        std::fs::remove_dir_all(&store_dir).ok();
        std::fs::remove_dir_all(&live_dir).ok();
    }

    /// TRDD-ZW4APOPI box 3: `bodies.spool` must distinguish "no spool configured" (null) from
    /// "configured but absent" from "present but a plain directory on the data volume" from a
    /// live spool with real file/byte/df figures — a stub returning null always (what shipped)
    /// passed every same-shape check while the RAM disk sat at 100%, and a path-exists check
    /// would pass the leaked-twin-mount case with the boot volume's figures.
    #[test]
    fn spool_gauge_null_absent_same_volume_and_live_are_different_answers() {
        let data_dir = std::env::temp_dir().join(format!("alcore-spool-gauge-{}", std::process::id()));
        let spool = data_dir.join("spool");
        std::fs::create_dir_all(&data_dir).unwrap();

        // No config ⇒ no spool ⇒ null, the legacy single-dir install.
        assert!(spool_gauge(&data_dir, false, 0).is_null());

        // Configured but the dir is gone (a reboot dropped the RAM disk): its own state, no numbers.
        std::fs::write(
            data_dir.join("config.json"),
            format!(r#"{{"capture":{{"spoolDir":"{}"}}}}"#, spool.to_string_lossy()),
        )
        .unwrap();
        let g = spool_gauge(&data_dir, true, 3);
        assert_eq!(g["exists"], false);
        assert_eq!(g["ownVolume"], false);
        assert_eq!(g["files"], 0);
        assert!(g["freeBytes"].is_null() && g["totalBytes"].is_null(), "never a fabricated 0 for an absent volume");
        assert_eq!(g["backpressure"]["active"], true);
        assert_eq!(g["backpressure"]["spills"], 3);

        // Present with one body — but a temp dir under the SAME device as the data dir, which is
        // exactly the lying case: the path exists, the df figures are the data volume's, and
        // `ownVolume` must say so. (A real RAM disk reads `ownVolume: true`; measured live on the
        // reference machine: dev 16777285 vs 16777234.)
        std::fs::create_dir_all(&spool).unwrap();
        std::fs::write(spool.join("a.request.json"), b"12345").unwrap();
        let g = spool_gauge(&data_dir, false, 3);
        assert_eq!(g["exists"], true);
        assert_eq!(g["ownVolume"], false, "a directory on the data volume is not a spool volume");
        assert_eq!(g["files"], 1);
        assert_eq!(g["stagedBytes"], 5);
        assert!(g["freeBytes"].as_u64().is_some() && g["totalBytes"].as_u64().is_some());
        assert!(g["totalBytes"].as_u64() >= g["freeBytes"].as_u64());
        assert_eq!(g["floorBytes"], crate::spool_backpressure::DEFAULT_SPOOL_FLOOR_BYTES);

        std::fs::remove_dir_all(&data_dir).ok();
    }
}
