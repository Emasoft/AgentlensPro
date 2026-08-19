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
}

/// The bound listeners (server.ts UI_PORT / MCP_PORT / OTLP_PORT). `mcp` is the configured
/// port only: the core has no MCP listener yet (freeze §3 is a later slice), so it reports what
/// the TS server would — env MCP_PORT, default 4316.
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
        let Some(stem) = name.strip_prefix("bodies-").and_then(|s| s.strip_suffix(".wad")) else { continue };
        let b = stem.as_bytes();
        if b.len() != 7 || b[4] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit()) {
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
    let hook_spooled = std::fs::read_dir(data_dir.join("hook-spool"))
        .map(|rd| rd.flatten().filter(|e| e.file_name().to_str().is_some_and(|n| n.ends_with(".json"))).count())
        .unwrap_or(0);
    let offsets_bytes_on_disk = crate::delta_log::DeltaLog::new(data_dir, "log-offsets").disk_bytes();
    let cards_bytes_on_disk = crate::delta_log::DeltaLog::new(data_dir, "log-sessions").disk_bytes();
    let hook = st.hook_runtime;
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
            "store": { "segments": segments, "totalSpans": total_spans, "totalBytes": total_bytes },
        },
        "logSessions": st.log_sessions.len(),
        "persistence": {
            "spanAppendWrites": p.span_append_writes, "spanAppendBytes": p.span_append_bytes,
            "offsetsWrites": p.offsets_writes, "offsetsBytes": p.offsets_bytes,
            "cardsWrites": p.cards_writes, "cardsBytes": p.cards_bytes,
            "hookEventWrites": p.hook_event_writes, "hookEventBytes": p.hook_event_bytes,
            // NOT PORTED: the log-event / statusline sinks, the gate, the bodies purge, the
            // spool — the TS boot values (all zero / false).
            "logEventWrites": 0, "logEventBytes": 0,
            "statuslineSamples": 0,
            "gateChecks": 0, "gateDenies": 0, "gateWarns": 0, "gateAdvisories": 0,
            "bodiesLastPurge": { "at": 0, "removedFiles": 0, "freedBytes": 0, "keptFiles": 0, "keptBytes": 0 },
            "spoolBackpressureSpills": 0,
            "spoolBackpressureActive": false,
            "totalBytesWritten": p.span_append_bytes + p.offsets_bytes + p.cards_bytes + p.hook_event_bytes,
            "files": { "spans": total_bytes, "offsets": offsets_bytes_on_disk, "cards": cards_bytes_on_disk },
        },
        "bodies": {
            "archive": { "volumes": volumes, "bytes": archive_bytes, "entries": entries },
            "lastPass": { "at": 0, "removedFiles": 0, "freedBytes": 0, "keptFiles": 0, "keptBytes": 0 },
            // NOT PORTED: the spool (TRDD-KB17X5G2) — SPOOL_MODE off ⇒ null, as the TS server
            // reports on a machine without a spool mount.
            "spool": Value::Null,
        },
        "hookEvents": { "files": hook_files, "bytes": hook_bytes, "receivedSinceBoot": p.hook_event_writes, "spooled": hook_spooled },
        // NOT PORTED: the statusline store — its stats() idle shape, all zero.
        "statusline": { "parts": 0, "partBytes": 0, "walBytes": 0, "bufferedRows": 0, "sealedParts": 0, "droppedRows": 0, "corruptWals": 0,
                         "receivedSinceBoot": 0, "retentionDays": statusline_retention_days },
        "logEvents": { "files": log_ev_files, "bytes": log_ev_bytes, "persistedSinceBoot": 0, "persistedBytesSinceBoot": 0, "retentionDays": log_events_retention_days },
        // NOT PORTED: the admission controller — idle stats.
        "admission": { "inflight": 0, "queued": 0, "admittedTotal": 0, "shedTotal": 0 },
        "resources": resource_sample(data_dir),
        "gate": {
            "mode": hook.gate_mode, "enabled": hook.gate_enabled,
            "captureEnabled": hook.capture_enabled, "advisorEnabled": hook.advisor_enabled,
            "checks": 0, "denies": 0, "warns": 0, "advisories": 0,
        },
        // NOT PORTED: the OTLP log-event ingest gate — nothing rejected yet ⇒ {}.
        "otlpDroppedLogEvents": Map::new(),
        // NOT PORTED: src/shared/fallbackCounters.ts — counters that never fired are absent ⇒ {}.
        "degradations": Map::new(),
    })
}
