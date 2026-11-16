//! Port of src/burnInvestigator.ts SLICE 1 (TRDD-DMWOBWFH P4x.2e): the corpus SCAN half —
//! everything that turns a bodies directory + a time window into measured facts, stopping at
//! the seam before the detectors. Slice 2 ports the detectors and composes `findings`/`verdict`
//! on top of the `ScanOutcome` this produces.
//!
//! The split is at the same seam cacheCreationForensics used (scan → report): 632 lines does not
//! fit one context alongside a TS oracle and a parity test.
//!
//! Three traps this file exists to reproduce faithfully, each of which cost a real incident:
//!
//!  1. `WS_RE` is GLOBAL on purpose. A transcript QUOTES "Primary working directory:" whenever the
//!     conversation is about this code — a session that read burnInvestigator.ts made the scanner
//!     capture the regex's own source and report it as the machine's top-burning workspace. Scan
//!     EVERY hit and take the first that is shaped like an absolute path.
//!  2. A chunk boundary splits a multi-byte character and Node's `Buffer.toString('utf-8')` emits
//!     U+FFFD. `String::from_utf8_lossy` is the faithful port — do NOT re-join the boundary to
//!     "fix" it, or the fingerprints diverge from the oracle.
//!  3. Every string index here is a UTF-16 code unit, never a byte: `.slice(-256)`, `.slice(i, i+2600)`,
//!     `.length`, and `charCodeAt` in djb2. Byte indices silently differ the moment a transcript
//!     contains an emoji.
//!
//! `resolveBodiesReadScope` and `dataDir` stay UNPORTED by design — they are the documented
//! parameter pattern: the caller resolves them and passes the result in.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::hook_events::{read_hook_events, HookEventFilter};
use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers::{
    find_session_id, iso_from_ms, js_math_round, js_slice, js_slice_from, js_to_fixed_num, num, utf16_len,
};

/// A cache_creation this large is a full-prefix (re)write. Shared with slice 2's detectors.
pub const SPIKE_CC: f64 = 100_000.0;
/// Spikes within 10 min belong to one event (a fan-out wave). Shared with slice 2's detectors.
pub const CLUSTER_MS: f64 = 10.0 * 60_000.0;

/// equivOf — input-equivalents, the window-drain currency. Weighted by COST, never raw tokens.
pub fn equiv_of(cc: f64, cr: f64) -> f64 {
    cc * 1.25 + cr * 0.1
}

/// TRDD-4FMHW124: a sub-range with hook events but ZERO bodies — a measured capture outage,
/// distinct from ordinary idle time.
#[derive(Clone, Debug)]
pub struct CaptureGap {
    pub from_iso: String,
    pub until_iso: String,
    pub hours: f64,
    pub hook_events_during: usize,
}

/// Bodies going quiet for ≥30 min while hook events keep arriving means the corpus has a hole,
/// not idle time. 30 min floor: shorter body-less stretches are ordinary between-turns quiet, and
/// a threshold low enough to catch them would page on every lunch break. Port of
/// `src/burnInvestigator.ts` `CAPTURE_GAP_MIN_MS`.
const CAPTURE_GAP_MIN_MS: f64 = 30.0 * 60_000.0;

/// Port of `src/burnInvestigator.ts` `findCaptureGaps`. Window edges count as boundaries — a body
/// gap that runs to the leading/trailing edge of the investigated window must still be reported.
fn find_capture_gaps(body_mtimes: &[f64], since_ms: f64, until_ms: f64, hook_dir: &Path) -> Vec<CaptureGap> {
    let mut ts: Vec<f64> = body_mtimes.to_vec();
    ts.sort_by(|a, b| a.total_cmp(b));
    let mut bounds: Vec<f64> = Vec::with_capacity(ts.len() + 2);
    bounds.push(since_ms);
    bounds.extend(ts);
    bounds.push(until_ms);
    let mut out = Vec::new();
    for i in 1..bounds.len() {
        let from = bounds[i - 1];
        let to = bounds[i];
        if to - from < CAPTURE_GAP_MIN_MS {
            continue;
        }
        // Shrink the probe by a minute each side so the activity that PRODUCED the boundary
        // bodies does not itself count as activity inside the hole.
        let ev = read_hook_events(
            hook_dir,
            &HookEventFilter {
                since_ms: Some((from + 60_000.0) as i64),
                until_ms: Some((to - 60_000.0) as i64),
                limit: Some(100),
                ..Default::default()
            },
        );
        if ev.is_empty() {
            continue; // no independent activity signal — idle time, not an outage
        }
        out.push(CaptureGap {
            from_iso: iso_from_ms(from),
            until_iso: iso_from_ms(to),
            hours: (to - from) / 3_600_000.0,
            hook_events_during: ev.len(),
        });
    }
    out
}

#[derive(Clone, Debug)]
pub struct RespRec {
    pub ts: f64,
    pub model: String,
    pub cc: f64,
    pub cr: f64,
    pub out: f64,
    pub inp: f64,
}

#[derive(Clone, Debug)]
pub struct ReqRec {
    pub ts: f64,
    pub size: f64,
    pub model: String,
    /// '' when the Environment block is absent (subagent-shaped).
    pub workspace: String,
    /// First-message identity — same value ⇒ same inherited transcript.
    pub fingerprint: String,
    pub image_bytes: f64,
    /// `metadata.user_id`'s session_id, when found — the FORK_STORM vs FAT_SESSION_REWRITES
    /// discriminator (TRDD-YBJGIYI1): ≥2 distinct ids sharing one fingerprint means the fingerprint
    /// was inherited by real siblings; exactly 1 means one session paid the write repeatedly.
    pub session_id: Option<String>,
}

/// What `resolveBodiesReadScope` returns in the TS. Resolved by the caller and passed in.
#[derive(Clone, Debug, Default)]
pub struct BodiesScope {
    pub dirs: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct InvestigateOptions {
    pub scope: BodiesScope,
    pub hook_events_dir: PathBuf,
    /// `os.homedir()` — only ever used by shortWs to abbreviate a path for display.
    pub home: String,
    pub window_hours: Option<f64>,
    pub until_ms: Option<f64>,
    pub max_files: Option<f64>,
    /// The Parquet api_call store (QSFYIHUO step 3). `None` == the pre-step-3 body-only behavior —
    /// the parity anchor burnscan_parity pins. When set, responses and request facts are read
    /// store-FIRST (SQL over api_calls), with the body walk only as per-row fallback for rows the
    /// store lacks or whose `raw_facts_v` is NULL (pre-step-3 rows, the A1 fallback key).
    pub store_dir: Option<PathBuf>,
}

/// The scan half's whole product: the measured records slice 2's detectors consume, plus the
/// partial report (`window`/`coverage`/`totals`/`attribution`) they will extend.
pub struct ScanOutcome {
    pub resps: Vec<RespRec>,
    pub reqs: Vec<ReqRec>,
    pub total_equiv: f64,
    pub cc: f64,
    pub cr: f64,
    pub est_cost_usd: f64,
    /// StopFailure hook-event timestamps in the window — the rate-limit-stall correlation.
    pub stop_failures: Vec<f64>,
    /// Set when the scan could NOT see the corpus. Totals must not be read as facts.
    pub blind: Option<&'static str>,
    /// The verdict when the scan is blind, or when responses are absent — both are decided
    /// entirely by the scan, so they belong to this slice; the detector verdicts do not.
    pub verdict_override: Option<String>,
    /// `{window, coverage, totals, attribution}` — slice 2 inserts `findings` + `verdict`.
    pub partial: Value,
}

// ── corpus scan ───────────────────────────────────────────────────────────────

struct FileRec {
    p: PathBuf,
    mtime: f64,
    size: f64,
}

/// listWindow — several dirs, ONE corpus: the live spool and the legacy dir can BOTH hold bodies
/// for the same window (a drain in progress), so the window is their union, not whichever we
/// looked at first. Over cap, keep the LARGEST files (they carry the burn) and report the drop.
fn list_window(dirs: &[String], suffix: &str, since_ms: f64, until_ms: f64, cap: usize) -> (Vec<FileRec>, usize) {
    let mut files: Vec<FileRec> = Vec::new();
    let mut present = 0usize;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(suffix) {
                continue;
            }
            let p = Path::new(dir).join(&name);
            let Ok(st) = std::fs::metadata(&p) else { continue };
            let mtime = st
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_millis() as f64);
            if mtime < since_ms || mtime > until_ms {
                continue;
            }
            present += 1;
            files.push(FileRec { p, mtime, size: st.len() as f64 });
        }
    }
    // read_dir order is filesystem-defined (JS readdirSync is too), so the size sort is what makes
    // the kept set deterministic. Ties keep discovery order on both sides — both sorts are stable.
    files.sort_by(|a, b| b.size.total_cmp(&a.size));
    files.truncate(cap);
    (files, present)
}

/// scanResponses — the billed usage, straight from Anthropic's own numbers. A file that is not a
/// usage-bearing response is skipped (and still counted in coverage), exactly as the TS `catch` does.
fn scan_responses(files: &[FileRec]) -> Vec<RespRec> {
    let mut out: Vec<RespRec> = Vec::new();
    for f in files {
        let Ok(raw) = std::fs::read_to_string(&f.p) else { continue };
        let Ok(d) = serde_json::from_str::<Value>(&raw) else { continue };
        let body_src = d.get("body").unwrap_or(&d);
        // `body` may itself be a JSON string (the TS re-parses it); a failed re-parse skips the file.
        let owned;
        let body = if let Some(s) = body_src.as_str() {
            match serde_json::from_str::<Value>(s) {
                Ok(v) => {
                    owned = v;
                    &owned
                }
                Err(_) => continue,
            }
        } else {
            body_src
        };
        let u = body.get("usage");
        // `u.x || 0` — a missing, null, zero, or non-numeric field all fall through to 0.
        let n = |k: &str| u.and_then(|u| u.get(k)).and_then(Value::as_f64).filter(|v| *v != 0.0).unwrap_or(0.0);
        out.push(RespRec {
            ts: f.mtime,
            // String(body.model ?? '?') — an absent OR null model is '?'.
            model: match body.get("model") {
                None | Some(Value::Null) => "?".to_owned(),
                Some(v) => crate::summarize::helpers::js_string(v),
            },
            cc: n("cache_creation_input_tokens"),
            cr: n("cache_read_input_tokens"),
            out: n("output_tokens"),
            inp: n("input_tokens"),
        });
    }
    out.sort_by(|a, b| a.ts.total_cmp(&b.ts));
    out
}

// QSFYIHUO step 3 (A2 hoist): ws_re/model_re/looks_like_workspace moved to agentlens_store::raw_facts.
use agentlens_store::raw_facts::{looks_like_workspace, model_re, ws_re};
use agentlens_store::duckdb::Connection;

// QSFYIHUO step 3 (A2 hoist): sum_image_bytes/djb2/to_base36/utf16_len moved to agentlens_store::raw_facts.
use agentlens_store::raw_facts::{djb2, sum_image_bytes};

/// The store-seam wrapper (QSFYIHUO step 3): the raw-text-only facts, extracted with
/// scan_request's own bounds (A3a) so a store row is bit-identical to what the body path computes.
/// The version stamps `raw_facts_v` (A1) — the sole fallback key at the read site.
pub fn extract_raw_facts(raw: &str, max_scan_bytes: usize) -> (i32, agentlens_store::raw_facts::RawFacts) {
    (agentlens_store::raw_facts::RAW_FACTS_VERSION, agentlens_store::raw_facts::extract_raw_facts(raw, max_scan_bytes))
}

/// scanRequest — bounded per-request read: head chunk for model + fingerprint, then a chunked
/// forward search for the Environment block. It sits AFTER the messages in fat transcripts, which
/// is the exact reason the incident's first shallow scan misattributed everything.
fn scan_request(f: &FileRec, max_scan_bytes: usize) -> Option<ReqRec> {
    let mut fd = std::fs::File::open(&f.p).ok()?;
    const CHUNK: usize = 512 * 1024;
    let mut buf = vec![0u8; CHUNK.min(max_scan_bytes)];
    let mut offset = 0usize;
    let mut model = "?".to_owned();
    let mut workspace = String::new();
    let mut fingerprint = String::new();
    let mut image_bytes = 0f64;
    let mut session_id: Option<String> = None;
    let mut carry = String::new();
    let size = f.size as usize;
    while offset < size && offset < max_scan_bytes {
        if fd.seek(SeekFrom::Start(offset as u64)).is_err() {
            break;
        }
        let n = match fd.read(&mut buf) {
            Ok(n) => n,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        // A split multi-byte char becomes U+FFFD here, exactly as Buffer.toString('utf-8') does.
        let text = format!("{carry}{}", String::from_utf8_lossy(&buf[..n]));
        if model == "?" {
            if let Some(m) = model_re().captures(&text) {
                model = m[1].to_owned();
            }
        }
        if fingerprint.is_empty() {
            // Identity of the FIRST message: same inherited transcript ⇒ same fingerprint. Both
            // the index and the 2600-wide slice are UTF-16, so the byte offset is converted.
            if let Some(bp) = text.find("\"messages\"") {
                let i = utf16_len(&text[..bp]);
                if utf16_len(&text) - i > 2600 {
                    fingerprint = djb2(js_slice(&text[bp..], 2600));
                }
            }
        }
        if workspace.is_empty() {
            for m in ws_re().captures_iter(&text) {
                let cand = m[1].trim();
                if looks_like_workspace(cand) {
                    workspace = cand.to_owned();
                    break;
                }
            }
        }
        // `metadata.user_id`'s session_id — same extractor `bodies_activity` uses on the same
        // OTEL body shape. Captured once, like fingerprint/workspace above; needed downstream to
        // tell a real fork storm (>=2 distinct sessions sharing a fingerprint) from one session
        // rewriting its own prefix repeatedly (TRDD-YBJGIYI1).
        if session_id.is_none() {
            session_id = find_session_id(&text);
        }
        image_bytes += sum_image_bytes(&text);
        if !workspace.is_empty()
            && !fingerprint.is_empty()
            && model != "?"
            && offset > 2 * CHUNK
            && image_bytes == 0.0
        {
            break;
        }
        carry = js_slice_from(&text, utf16_len(&text).saturating_sub(256)).to_owned();
        offset += n;
    }
    Some(ReqRec { ts: f.mtime, size: f.size, model, workspace, fingerprint, image_bytes, session_id })
}

// ── assembly ──────────────────────────────────────────────────────────────────

/// `ws.replace(os.homedir(), '~')` — JS String.replace with a STRING pattern replaces only the
/// FIRST occurrence, so `replacen(.., 1)` is the port; `str::replace` would replace them all.
fn short_ws(ws: &str, home: &str) -> String {
    ws.replacen(home, "~", 1)
}

/// fmtK — shared with slice 2's verdict composition.
pub fn fmt_k(n: f64) -> String {
    if n >= 1_000_000.0 {
        format!("{}M", crate::summarize::helpers::js_to_fixed_str(n / 1e6, 1))
    } else {
        format!("{}k", crate::summarize::helpers::js_math_round(n / 1000.0))
    }
}

/// What `load_store_window` returns. `no_facts` = (stem, ts_ms) of request rows with a NULL
/// `raw_facts_v`: not served from the store, but their ts_ms is a proof of capture.
#[derive(Default)]
struct StoreWindow {
    resps: Vec<RespRec>,
    reqs: Vec<ReqRec>,
    stems: std::collections::HashSet<String>,
    no_facts: Vec<(String, f64)>,
}

/// scan_window's store half (QSFYIHUO step 3): responses and request facts from ONE windowed SQL
/// SELECT each over the api_call parts — the connection discipline of step-1's load_store_facts
/// (cache_event_log.rs): in-memory connection, 256 MiB, threads per `crate::cores::duckdb_threads()` (TRDD-YH822LDI), `ts_ms >= since AND ts_ms <= until`.
/// Returns None when the store has no parts or the query fails (A3d: fail-open — the caller then
/// walks the bodies, the pre-step-3 behavior). Rows come back ORDERED BY ts_ms (A3c) because the
/// attribution table and fingerprint-family tallies are insertion-ordered.
fn load_store_window(store_dir: &Path, since_ms: f64, until_ms: f64) -> Option<StoreWindow> {
    let parts = agentlens_store::parquet_scan(store_dir, agentlens_store::API_CALLS_DIR)?;
    let con = Connection::open_in_memory().ok()?;
    if con.execute_batch(&format!("SET memory_limit='256MiB'; SET threads={};", crate::cores::duckdb_threads())).is_err() {
        return None;
    }
    let window = format!("ts_ms >= {} AND ts_ms <= {}", since_ms as i64, until_ms as i64);

    // Responses: RespRec maps 1:1 onto response columns — a pure SQL swap, same skip-zero
    // semantics as scan_responses (`u.x || 0` then a 0 is kept — RespRec keeps the value and
    // detectors see identical numbers).
    let resp_sql = format!(
        "SELECT ts_ms, COALESCE(model, '?'), COALESCE(cache_creation_tokens, 0), \
         COALESCE(cache_read_tokens, 0), COALESCE(output_tokens, 0), COALESCE(input_tokens, 0) \
         FROM {parts} WHERE kind = 'response' AND {window} ORDER BY ts_ms"
    );
    let mut resps: Vec<RespRec> = Vec::new();
    {
        let Ok(mut stmt) = con.prepare(&resp_sql) else { return None };
        let Ok(mut rows) = stmt.query([]) else { return None };
        loop {
            // A row-iteration error must fail the WHOLE load open (None): `while let Ok(Some(..))`
            // would treat it as end-of-data and serve a silently truncated window as complete.
            let row = match rows.next() {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(_) => return None,
            };
            let (ts, model, cc, cr, out, inp): (f64, String, f64, f64, f64, f64) = (
                row.get(0).ok()?, row.get(1).ok()?, row.get(2).ok()?, row.get(3).ok()?, row.get(4).ok()?, row.get(5).ok()?,
            );
            resps.push(RespRec { ts, model, cc, cr, out, inp });
        }
    }

    // Requests: the five first-class facts + version. raw_facts_v IS the fallback key (A1):
    // NULL (pre-step-3 rows) means the trio is NOT trusted — the row is not served from the store
    // and the body walk re-scans its file (its stem is not in the returned stem set), so a
    // NULL-version row never double-serves. Its stem and ts_ms are still returned in `no_facts`:
    // a body WAS captured for it (not a capture gap), and with the body gone it is a request the
    // scan cannot attribute, which the coverage must say. A non-NULL version trusts the trio as
    // extracted, including legitimately-empty values.
    let req_sql = format!(
        "SELECT ts_ms, COALESCE(model, '?'), COALESCE(raw_bytes, 0), workspace, fp_2600, \
         COALESCE(image_bytes, 0), session_id, raw_facts_v, stem \
         FROM {parts} WHERE kind = 'request' AND {window} ORDER BY ts_ms"
    );
    let mut reqs: Vec<ReqRec> = Vec::new();
    let mut no_facts: Vec<(String, f64)> = Vec::new();
    let mut stems: std::collections::HashSet<String> = std::collections::HashSet::new();
    {
        let Ok(mut stmt) = con.prepare(&req_sql) else { return None };
        let Ok(mut rows) = stmt.query([]) else { return None };
        loop {
            // See the response loop: an iteration error fails the whole load open.
            let row = match rows.next() {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(_) => return None,
            };
            let ts: f64 = row.get(0).ok()?;
            let model: String = row.get(1).ok()?;
            let size: f64 = row.get::<_, i64>(2).ok()? as f64;
            let workspace: Option<String> = row.get(3).ok()?;
            let fp_2600: Option<String> = row.get(4).ok()?;
            let image_bytes: f64 = row.get::<_, i64>(5).ok()? as f64;
            let session_id: Option<String> = row.get(6).ok()?;
            let rfv: Option<i32> = row.get(7).ok()?;
            let stem: String = row.get(8).ok()?;
            let (workspace, fp_2600, image_bytes) = match rfv {
                Some(_) => (workspace.unwrap_or_default(), fp_2600.unwrap_or_default(), image_bytes),
                None => {
                    no_facts.push((stem, ts)); // untrusted trio — the body walk re-scans this file
                    continue;
                }
            };
            stems.insert(stem);
            reqs.push(ReqRec { ts, size, model, workspace, fingerprint: fp_2600, image_bytes, session_id });
        }
    }
    // Response stems join the set so the caller can skip body files the store already served.
    {
        let stem_sql = format!("SELECT stem FROM {parts} WHERE kind = 'response' AND {window}");
        let Ok(mut stmt) = con.prepare(&stem_sql) else { return None };
        let Ok(mut rows) = stmt.query([]) else { return None };
        loop {
            // See the response loop: an iteration error fails the whole load open.
            let row = match rows.next() {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(_) => return None,
            };
            // A bad VALUE (NULL / non-string stem) skips just that row, as before step 3; only an iteration
            // Err fails the load, because it means the window may be truncated, not merely one row odd.
            if let Ok(stem) = row.get::<_, String>(0) {
                stems.insert(stem);
            }
        }
    }
    Some(StoreWindow { resps, reqs, stems, no_facts })
}

/// The scan half of investigateBurn: everything decided by the corpus alone.
pub fn scan_window(opts: &InvestigateOptions, now_ms: f64) -> ScanOutcome {
    // `clamp`, not `.max().min()`: it PROPAGATES NaN the way Math.min(48, Math.max(0.25, NaN))
    // does, whereas f64::max swallows NaN and would silently return the floor instead.
    let hours = opts.window_hours.unwrap_or(5.0).clamp(0.25, 48.0);
    let until_ms = opts.until_ms.unwrap_or(now_ms);
    let since_ms = until_ms - hours * 3_600_000.0;
    let cap = opts.max_files.unwrap_or(8000.0).clamp(100.0, 20_000.0) as usize;

    let (req_files, req_present) = list_window(&opts.scope.dirs, ".request.json", since_ms, until_ms, cap);
    let (resp_files, resp_present) = list_window(&opts.scope.dirs, ".response.json", since_ms, until_ms, cap);

    // ── Store-first pass (QSFYIHUO step 3) ──────────────────────────────────────
    // With store_dir set, responses and request facts come from the api_call rows FIRST; the body
    // walk runs only per-row: a body file the store has no row for. Dedup is by stem — the store
    // row is the same capture with proven bytes, so store wins. A store-query FAILURE degrades
    // the whole scan to the body walk (A3d fail-open — the fallback IS the documented path). The
    // SQL returns the FULL window, no file cap (A3c) — coverage must state that explicitly.
    // No backfill: a pre-step-3 (NULL raw_facts_v) row whose body has been settled away is unservable.
    let stem_of_file = |f: &FileRec| -> String {
        f.p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            .trim_end_matches(".request.json").trim_end_matches(".response.json").to_owned()
    };
    let store_load = opts.store_dir.as_ref().and_then(|sd| load_store_window(sd, since_ms, until_ms));
    let store_ok = store_load.is_some();
    let StoreWindow { resps: store_resps, reqs: store_reqs, stems: store_stems, no_facts: store_no_facts } = store_load.unwrap_or_default();
    let store_resp_count = store_resps.len();
    let store_req_count = store_reqs.len();
    // Every store row proves a body was captured at its ts_ms, spooled or not — NULL-version request
    // rows included. Gap detection must see them, or a drained spool reads as a window-wide hole.
    let store_ts: Vec<f64> = store_resps
        .iter()
        .map(|r| r.ts)
        .chain(store_reqs.iter().map(|r| r.ts))
        .chain(store_no_facts.iter().map(|(_, t)| *t))
        .collect();
    // NULL-version rows WITH a spool file are re-scanned by the body walk and must not be counted;
    // only the file-less ones are unservable (no trusted trio, body gone).
    let req_file_stems: std::collections::HashSet<String> = req_files.iter().map(&stem_of_file).collect();
    let store_without_facts = store_no_facts.iter().filter(|(s, _)| !req_file_stems.contains(s)).count();

    let resps = if store_ok {
        let mut out = store_resps;
        for f in &resp_files {
            if !store_stems.contains(&stem_of_file(f)) {
                out.extend(scan_responses(std::slice::from_ref(f)));
            }
        }
        out.sort_by(|a, b| a.ts.total_cmp(&b.ts));
        out
    } else {
        scan_responses(&resp_files)
    };

    let reqs: Vec<ReqRec> = if store_ok {
        let mut out = store_reqs;
        for f in &req_files {
            if !store_stems.contains(&stem_of_file(f)) {
                if let Some(r) = scan_request(f, 6 * 1024 * 1024) {
                    out.push(r);
                }
            }
        }
        out.sort_by(|a, b| a.ts.total_cmp(&b.ts));
        out
    } else {
        let mut out: Vec<ReqRec> = req_files.iter().filter_map(|f| scan_request(f, 6 * 1024 * 1024)).collect();
        out.sort_by(|a, b| a.ts.total_cmp(&b.ts));
        out
    };

    // Totals — exact billed usage from the responses.
    let (mut cc, mut cr, mut out_t) = (0f64, 0f64, 0f64);
    // byHour is read back in sorted-key order; byModel must keep INSERTION order, because the
    // total cost is a float sum over it and addition order is not associative.
    // v[4] is the running USD cost, priced PER-RESPONSE at that response's own timestamp (never
    // recomputed from the aggregated cc/cr/out afterward) — a window can straddle a
    // `scheduledChange` boundary, and aggregating first would price the whole bucket at one rate.
    let mut by_hour: BTreeMap<String, (f64, f64, f64)> = BTreeMap::new();
    let mut by_model: Vec<(String, [f64; 5])> = Vec::new();
    for r in &resps {
        cc += r.cc;
        cr += r.cr;
        out_t += r.out;
        let h = js_slice(&iso_from_ms(r.ts), 13).to_owned();
        let hb = by_hour.entry(h).or_insert((0.0, 0.0, 0.0));
        hb.0 += 1.0;
        hb.1 += r.cc;
        hb.2 += r.cr;
        let at_iso = iso_from_ms(r.ts);
        let usd = calc_token_cost_usd(0.0, r.cr, r.cc, r.out, &r.model, 0.0, Some(&at_iso), now_ms);
        match by_model.iter_mut().find(|(m, _)| *m == r.model) {
            Some((_, v)) => {
                v[0] += 1.0;
                v[1] += r.cc;
                v[2] += r.cr;
                v[3] += r.out;
                v[4] += usd;
            }
            None => by_model.push((r.model.clone(), [1.0, r.cc, r.cr, r.out, usd])),
        }
    }
    let total_equiv = equiv_of(cc, cr);
    let est_cost_usd = by_model.iter().fold(0.0, |a, (_, v)| a + v[4]);

    // Hook-event correlation (optional store — absent when --install-hooks was never run).
    let stop_failures: Vec<f64> = read_hook_events(
        &opts.hook_events_dir,
        &HookEventFilter {
            ev: Some("StopFailure"),
            since_ms: Some(since_ms as i64),
            until_ms: Some(until_ms as i64),
            limit: Some(100),
            ..Default::default()
        },
    )
    .iter()
    .filter_map(|e| e.get("ts").and_then(Value::as_f64))
    .collect();

    // Attribution table (workspace × model), interactive vs subagent-shaped. Insertion-ordered.
    let mut attr: Vec<(String, String, String, [f64; 4])> = Vec::new();
    for r in &reqs {
        let kind = if r.workspace.is_empty() { "subagent" } else { "interactive" };
        let ws = if r.workspace.is_empty() { "(subagent/no-env-block)" } else { &r.workspace };
        match attr.iter_mut().find(|(w, m, k, _)| w == ws && *m == r.model && k == kind) {
            Some((_, _, _, a)) => {
                a[0] += 1.0;
                a[1] += r.size;
                a[2] = a[2].min(r.ts);
                a[3] = a[3].max(r.ts);
            }
            None => attr.push((ws.to_owned(), r.model.clone(), kind.to_owned(), [1.0, r.size, r.ts, r.ts])),
        }
    }

    // ── Blind-spot classification ───────────────────────────────────────────────
    // Zero scanned files has TWO very different meanings, and conflating them is what let this tool
    // answer "nothing burned here" during a measured 2.3M tok/min burn. An empty corpus means the
    // investigator CANNOT SEE, not that nothing happened. QSFYIHUO step 3: a drained spool with a
    // live store is NOT blind — store rows in the window count as seen.
    let store_row_count = store_resp_count + store_req_count;
    let store_saw_rows = store_ok && store_row_count > 0;
    let nothing_scanned = req_files.is_empty() && resp_files.is_empty() && !store_saw_rows;
    let blind: Option<&'static str> = if !nothing_scanned {
        None
    } else if opts.scope.dirs.is_empty() {
        Some("no-bodies-dir")
    } else {
        Some("dirs-empty-in-window")
    };

    let where_s = if opts.scope.dirs.is_empty() {
        "(none exist)".to_owned()
    } else {
        opts.scope.dirs.iter().map(|d| short_ws(d, &opts.home)).collect::<Vec<_>>().join(", ")
    };
    let absent = if opts.scope.missing.is_empty() {
        String::new()
    } else {
        format!(" Missing: {}.", opts.scope.missing.iter().map(|d| short_ws(d, &opts.home)).collect::<Vec<_>>().join(", "))
    };
    let blind_verdict = match blind {
        Some("no-bodies-dir") => format!(
            "BLIND — no raw-body directory exists, so this window was never observed.{absent} \
This is NOT evidence that nothing burned: run `agentlenspro setup` (it wires raw-body capture), \
and meanwhile use `agentlenspro --risk` / `get_burn_status`, which \
read the live feed and never go blind."
        ),
        _ => format!(
            "BLIND — scanned {where_s} and found 0 request/response bodies in the window.{absent} \
Either the window predates capture, the spool was drained/unmounted, or \
the bounds are wrong. This is NOT evidence that nothing burned — cross-check with \
`agentlenspro --risk` / `get_burn_status` (live feed, never blind)."
        ),
    };

    // Two verdict branches are decided by the scan alone; the rest need the detectors (slice 2).
    let verdict_override = if blind.is_some() {
        Some(blind_verdict)
    } else if resps.is_empty() {
        Some(format!(
            "Scanned {} request bodies in {where_s} but no RESPONSE bodies — usage \
cannot be measured for this window (responses carry the billed numbers). Traffic existed; \
the totals below are not a burn measurement.",
            req_files.len()
        ))
    } else {
        None
    };

    // TRDD-4FMHW124: gap detection needs EVERY mtime in the window, so it is skipped (silently
    // reporting none would be dishonest — the cap note already discloses truncation) when the file
    // cap truncated either list: a gap computed on the largest-N subset would hallucinate holes
    // exactly where the small files were dropped.
    let capped = req_files.len() < req_present || resp_files.len() < resp_present;
    let capture_gaps: Vec<CaptureGap> = if blind.is_some() || capped {
        Vec::new()
    } else {
        let mut mtimes: Vec<f64> = req_files.iter().chain(resp_files.iter()).map(|f| f.mtime).collect();
        mtimes.extend_from_slice(&store_ts); // F1: store rows are captured bodies too (empty when !store_ok)
        find_capture_gaps(&mtimes, since_ms, until_ms, &opts.hook_events_dir)
    };
    let worst_gap = capture_gaps.iter().max_by(|a, b| a.hours.total_cmp(&b.hours));
    let gap_note = match worst_gap {
        Some(g) => format!(
            " CAPTURE GAP: no bodies for {:.1}h ({} → {}) while {}{} hook event(s) arrived — the corpus has a hole there, not idle time; totals under-count that range{} (TRDD-4FMHW124).",
            g.hours,
            g.from_iso,
            g.until_iso,
            g.hook_events_during,
            if g.hook_events_during >= 100 { "+" } else { "" },
            if capture_gaps.len() > 1 { format!(" (+{} more gap(s) in coverage.captureGaps)", capture_gaps.len() - 1) } else { String::new() },
        ),
        None => String::new(),
    };

    let mut coverage = Map::new();
    // `num()`, never `json!(f64)`: serde_json Number equality does NOT bridge PosInt vs Float, so a
    // count emitted as 5.0 compares unequal to the oracle's 5 while every digit matches.
    // QSFYIHUO step 3: store-served rows count toward the scanned counts (they are seen), and the
    // note states the no-cap SQL explicitly (A3c) when the store served the window.
    // A body file the store ALSO served must count once, not twice: add only the body files whose
    // stem the store lacks (store_stems is empty and both store counts are 0 when !store_ok).
    let body_only_reqs = req_files.iter().filter(|f| !store_stems.contains(&stem_of_file(f))).count();
    let body_only_resps = resp_files.iter().filter(|f| !store_stems.contains(&stem_of_file(f))).count();
    coverage.insert("requestFilesScanned".into(), json!(body_only_reqs + store_req_count));
    coverage.insert("responseFilesScanned".into(), json!(body_only_resps + store_resp_count));
    coverage.insert("bytesOnDisk".into(), num(req_files.iter().map(|f| f.size).sum::<f64>()));
    // A blind scan is never "complete" — it saw nothing, which is the opposite of full coverage.
    // Emitted BEFORE the store/body split so the store path carries the key too.
    coverage.insert(
        "complete".into(),
        json!(blind.is_none() && req_files.len() == req_present && resp_files.len() == resp_present),
    );
    if store_ok {
        // F2: a request row with no facts and no body cannot be attributed or fork-storm-checked;
        // say so in the note and in a counter, instead of letting `complete` imply full attribution.
        // When the request listing was capped, `req_file_stems` lacks files that exist, so the count
        // is only an upper bound and the note must say so instead of asserting bodies are gone.
        let without_facts_note = if store_without_facts > 0 && req_files.len() < req_present {
            format!(" Up to {store_without_facts} request(s) are in the store without workspace/fingerprint facts; the file listing was capped, so some may still have a body on disk. Those without one are unattributed and under-counted in attribution and fork-storm detection.")
        } else if store_without_facts > 0 {
            format!(" {store_without_facts} request(s) are in the store without workspace/fingerprint facts and their bodies are gone, so attribution and fork-storm detection under-count them.")
        } else {
            String::new()
        };
        coverage.insert("storeRequestsWithoutFacts".into(), json!(store_without_facts));
        // Why: "the full window" contradicts the without-facts suffix, so claim it only when the count is 0.
        let store_lead = if store_without_facts > 0 {
            "store-first: the window was read from the api_call store (SQL, no file cap)"
        } else {
            "store-first: the full window came from the api_call store (SQL, no file cap)"
        };
        coverage.insert(
            "note".into(),
            json!(format!(
                "{store_lead} plus {} body file(s) the store lacks — scanned {where_s}{absent}.{gap_note}{without_facts_note}",
                body_only_reqs + body_only_resps
            )),
        );
    } else {
        coverage.insert(
            "note".into(),
            json!(format!(
                "{}{gap_note}",
                if let Some(b) = blind {
                    format!("BLIND ({b}): scanned {where_s} — 0 bodies in the window.{absent} Totals are not a measurement.")
                } else if req_files.len() == req_present {
                    format!("full coverage of the window (scanned {where_s})")
                } else {
                    format!(
                        "CAP HIT: scanned the {} largest of {req_present} request files (responses {}/{resp_present}) — totals reflect the scanned set only",
                        req_files.len(),
                        resp_files.len()
                    )
                }
            )),
        );
    }
    coverage.insert("dirsScanned".into(), json!(opts.scope.dirs));
    coverage.insert("dirsMissing".into(), json!(opts.scope.missing));
    if let Some(b) = blind {
        coverage.insert("blind".into(), json!(b));
    }
    if !capture_gaps.is_empty() {
        coverage.insert(
            "captureGaps".into(),
            json!(capture_gaps
                .iter()
                .map(|g| json!({
                    "fromIso": g.from_iso,
                    "untilIso": g.until_iso,
                    "hours": num(g.hours),
                    "hookEventsDuring": num(g.hook_events_during as f64),
                }))
                .collect::<Vec<_>>()),
        );
    }

    let mut by_model_rows: Vec<Value> = by_model
        .iter()
        .map(|(model, v)| {
            json!({
                "model": model, "calls": num(v[0]), "cacheCreation": num(v[1]), "cacheRead": num(v[2]),
                "outputTokens": num(v[3]),
                "equiv": num(js_math_round(equiv_of(v[1], v[2]))),
                // Sum of per-response costs already priced above — see the scan-loop comment.
                "estCostUsd": num(js_to_fixed_num(v[4], 2)),
            })
        })
        .collect();
    by_model_rows.sort_by(|a, b| b["equiv"].as_f64().unwrap().total_cmp(&a["equiv"].as_f64().unwrap()));

    let mut attribution: Vec<Value> = attr
        .iter()
        .map(|(ws, model, kind, a)| {
            json!({
                "workspace": short_ws(ws, &opts.home), "model": model, "kind": kind,
                "requests": num(a[0]), "bytesSent": num(a[1]),
                "firstIso": iso_from_ms(a[2]), "lastIso": iso_from_ms(a[3]),
            })
        })
        .collect();
    attribution.sort_by(|a, b| b["bytesSent"].as_f64().unwrap().total_cmp(&a["bytesSent"].as_f64().unwrap()));
    attribution.truncate(20);

    let partial = json!({
        "window": { "fromIso": iso_from_ms(since_ms), "untilIso": iso_from_ms(until_ms), "hours": num(hours) },
        "coverage": Value::Object(coverage),
        "totals": {
            "calls": resps.len(),
            "cacheCreationTokens": num(cc),
            "cacheReadTokens": num(cr),
            "outputTokens": num(out_t),
            "inputEquivTokens": num(js_math_round(total_equiv)),
            "estCostUsd": num(js_to_fixed_num(est_cost_usd, 2)),
            "byHour": by_hour.iter().map(|(hour, v)| json!({
                "hour": hour, "calls": num(v.0), "cacheCreation": num(v.1), "cacheRead": num(v.2),
                "equiv": num(js_math_round(equiv_of(v.1, v.2))),
            })).collect::<Vec<_>>(),
            "byModel": by_model_rows,
        },
        "attribution": attribution,
    });

    ScanOutcome { resps, reqs, total_equiv, cc, cr, est_cost_usd, stop_failures, blind, verdict_override, partial }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected values COMPUTED BY NODE, not reasoned about — djb2 mixes int32 shift with float
    /// addition and ToUint32, which is exactly where hand-reasoning goes wrong.
    #[test]
    fn djb2_matches_node_including_the_surrogate_pair_path() {
        assert_eq!(djb2(""), "45h", "(5381).toString(36)");
        assert_eq!(djb2("a"), "3t3a");
        assert_eq!(djb2("abc"), "3772q3");
        // '🚀' is ONE char but TWO charCodeAt values — a char-wise loop would hash the scalar
        // 0x1F680 instead of the surrogate pair and silently diverge from the oracle.
        assert_eq!(djb2("🚀"), "4lz1e");
        assert_eq!(djb2("\u{fffd}"), "57ky", "the U+FFFD a split chunk boundary produces");
    }

    #[test]
    fn looks_like_workspace_accepts_posix_and_windows_only() {
        assert!(looks_like_workspace("/Users/x/Code"));
        assert!(looks_like_workspace("C:\\Users\\x"));
        assert!(looks_like_workspace("d:/src"));
        // The trap this guard exists for: the regex's own source, quoted inside a transcript.
        assert!(!looks_like_workspace("([^"));
        assert!(!looks_like_workspace("relative/path"));
        assert!(!looks_like_workspace(""));
    }

    #[test]
    fn image_run_is_counted_only_at_or_above_the_20k_floor() {
        let short = format!(r#"{{"data":"{}"}}"#, "A".repeat(19_999));
        assert_eq!(sum_image_bytes(&short), 0.0);
        let long = format!(r#"{{"data": "{}"}}"#, "A".repeat(20_005));
        assert_eq!(sum_image_bytes(&long), 20_005.0);
        // Two blobs accumulate; the scan resumes at the end of a counted run.
        let two = format!(r#"{{"data":"{}","x":1,"data":"{}"}}"#, "A".repeat(20_000), "B".repeat(21_000));
        assert_eq!(sum_image_bytes(&two), 41_000.0);
    }

    #[test]
    fn short_ws_replaces_only_the_first_home_occurrence() {
        // JS String.replace with a string pattern is FIRST-ONLY; str::replace would collapse BOTH
        // occurrences to "~/x/~". The home string is the sanctioned placeholder shape on purpose —
        // check-no-identities is shape-based and rejects a concrete-looking home path even in a test.
        assert_eq!(short_ws("/Users/<name>/x/Users/<name>", "/Users/<name>"), "~/x/Users/<name>");
    }

    fn write_resp(dir: &Path, name: &str, ts_ms: f64, model: &str, cc: f64, cr: f64, out: f64) {
        let p = dir.join(name);
        std::fs::write(
            &p,
            format!(
                r#"{{"body":{{"model":"{model}","usage":{{"cache_creation_input_tokens":{cc},"cache_read_input_tokens":{cr},"output_tokens":{out},"input_tokens":5}}}}}}"#
            ),
        )
        .unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ts_ms as u64);
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// TRDD-MF4YQWWA: a response must be priced at the rate in force at ITS OWN timestamp, not at
    /// `now_ms` — the whole point of an oracle that stays reproducible across regeneration dates.
    ///
    /// This was a straddle over claude-sonnet-5's announced 2026-09-01 rate change, which is the
    /// strongest form of the proof. That change was withdrawn upstream (CC 2.1.243) and removed on
    /// 2026-09-04, and no entry in pricing.json carries a `scheduledChange` any more, so the
    /// straddle is unbuildable and this asserted $25 against a rate that no longer exists.
    ///
    /// Rebuilt on the LONG-CONTEXT STEP, which is arithmetic rather than an announcement and so
    /// cannot be retracted: claude-sonnet-4's >200K surcharge reprices the WHOLE request once its
    /// total input crosses the threshold, so two 150K cache-read responses priced individually
    /// ($0.30/MTok, each under) and the same 300K priced as one aggregate ($0.60/MTok, over) differ
    /// by exactly 2x. Do NOT weaken this back to two same-rate calls: rates are LINEAR below the
    /// step, so 2 * price(N) == price(2N) and such an assertion passes identically against an
    /// implementation that prices the aggregate once — it would pin nothing. Mirrors
    /// `src/test/burnInvestigator.test.ts`; keep the two in step.
    #[test]
    fn est_cost_usd_prices_each_response_at_its_own_timestamp() {
        let dir = std::env::temp_dir().join(format!("al-burnscan-scheduled-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Kept ≤48h apart (the window's own cap) so both calls land in one scan.
        let before = 1_788_213_600_000.0; // 2026-08-31T22:00:00Z
        let after = 1_788_228_000_000.0; // 2026-09-01T02:00:00Z
        // 150K cache-read each: under the 200K step. Aggregated they are 300K: over it.
        write_resp(&dir, "r0.response.json", before, "claude-sonnet-4", 0.0, 150_000.0, 0.0);
        write_resp(&dir, "r1.response.json", after, "claude-sonnet-4", 0.0, 150_000.0, 0.0);
        let opts = InvestigateOptions {
            store_dir: None,
            scope: BodiesScope { dirs: vec![dir.to_string_lossy().into_owned()], missing: vec![] },
            hook_events_dir: dir.join("hook-events"),
            home: dir.to_string_lossy().into_owned(),
            window_hours: Some(48.0),
            until_ms: Some(after + 60_000.0),
            max_files: None,
        };
        let outcome = scan_window(&opts, after + 60_000.0);
        std::fs::remove_dir_all(&dir).ok();
        let by_model = outcome.partial["totals"]["byModel"].as_array().unwrap();
        assert_eq!(by_model.len(), 1);
        // $0.09 = 2 × (150K × $0.30/MTok), each response under the step. Pricing the aggregate
        // instead gives $0.18 = 300K × $0.60/MTok — the surcharged rate applied once.
        let expected = 0.09;
        let as_aggregate = 0.18;
        let got = by_model[0]["estCostUsd"].as_f64().unwrap();
        assert!(
            (got - expected).abs() < 0.001,
            "expected ${expected} (each response under the step); ${as_aggregate} would mean the \
             window was priced as one aggregate, got ${got}"
        );
        let total = outcome.partial["totals"]["estCostUsd"].as_f64().unwrap();
        assert!((total - expected).abs() < 0.001, "window total must match the per-response sum, got ${total}");
    }
}
