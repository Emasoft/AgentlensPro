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

use regex::Regex;
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
    pub capture_on: bool,
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

fn ws_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"Primary working directory: ([^\\\n"]+)"#).unwrap())
}

fn model_re() -> &'static Regex {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r#""model"\s*:\s*"([^"]+)""#).unwrap())
}

/// An Environment-block workspace is always absolute — posix `/…` or Windows `C:\…`.
pub fn looks_like_workspace(s: &str) -> bool {
    if s.starts_with('/') {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// `/"data"\s*:\s*"([A-Za-z0-9+/=]{20000,})/g` hand-rolled: the regex crate expands a `{20000,}`
/// repeat literally and blows its compiled-size limit, so the bounded run is counted directly.
/// Semantics preserved exactly — greedy run, and the scan resumes at the END of a counted match
/// (JS sets lastIndex there) but only one char past the anchor when the run is too short.
fn sum_image_bytes(text: &str) -> f64 {
    const NEEDLE: &str = "\"data\"";
    let b = text.as_bytes();
    let mut total = 0f64;
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(NEEDLE) {
        let start = from + rel;
        let mut i = start + NEEDLE.len();
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b':' {
            i += 1;
            while i < b.len() && (b[i] as char).is_whitespace() {
                i += 1;
            }
            if i < b.len() && b[i] == b'"' {
                i += 1;
                let run_start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'+' || b[i] == b'/' || b[i] == b'=') {
                    i += 1;
                }
                let run = i - run_start;
                if run >= 20_000 {
                    total += run as f64; // base64 is ASCII, so byte length IS the UTF-16 length
                    from = i;
                    continue;
                }
            }
        }
        from = start + 1;
    }
    total
}

/// djb2 over UTF-16 code units. `((h << 5) + h + c) >>> 0`: the shift is a signed int32 op that
/// may go negative, the additions are exact doubles, and `>>> 0` is ToUint32 — which is what the
/// `as u32` truncation reproduces. Iterating bytes or chars instead of code units diverges the
/// moment a transcript holds an emoji.
pub fn djb2(s: &str) -> String {
    let mut h: u32 = 5381;
    for c in s.encode_utf16() {
        let shifted = (h as i32).wrapping_shl(5) as i64;
        h = (shifted + h as i64 + c as i64) as u32;
    }
    to_base36(h)
}

fn to_base36(mut n: u32) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
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
    let resps = scan_responses(&resp_files);
    let mut reqs: Vec<ReqRec> = req_files.iter().filter_map(|f| scan_request(f, 6 * 1024 * 1024)).collect();
    reqs.sort_by(|a, b| a.ts.total_cmp(&b.ts));

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
    // investigator CANNOT SEE, not that nothing happened.
    let nothing_scanned = req_files.is_empty() && resp_files.is_empty();
    let blind: Option<&'static str> = if !nothing_scanned {
        None
    } else if opts.scope.dirs.is_empty() {
        Some("no-bodies-dir")
    } else if !opts.scope.capture_on {
        Some("capture-off")
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
This is NOT evidence that nothing burned: turn capture on with `agentlenspro config set \
captureRawBodies on`, and meanwhile use `agentlenspro --risk` / `get_burn_status`, which \
read the live feed and never go blind."
        ),
        Some("capture-off") => format!(
            "BLIND — raw-body capture is OFF and {where_s} holds nothing for this window, so there is \
nothing to investigate FROM. This is NOT evidence that nothing burned — cross-check with \
`agentlenspro --risk` / `get_burn_status` (live feed, never blind)."
        ),
        _ => format!(
            "BLIND — scanned {where_s} and found 0 request/response bodies in the window.{absent} \
Capture is on, so either the window predates capture, the spool was drained/unmounted, or \
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
        let mtimes: Vec<f64> = req_files.iter().chain(resp_files.iter()).map(|f| f.mtime).collect();
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
    coverage.insert("requestFilesScanned".into(), json!(req_files.len()));
    coverage.insert("responseFilesScanned".into(), json!(resp_files.len()));
    coverage.insert("bytesOnDisk".into(), num(req_files.iter().map(|f| f.size).sum::<f64>()));
    // A blind scan is never "complete" — it saw nothing, which is the opposite of full coverage.
    coverage.insert(
        "complete".into(),
        json!(blind.is_none() && req_files.len() == req_present && resp_files.len() == resp_present),
    );
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

    /// TRDD-MF4YQWWA: claude-sonnet-5's introductory rate ($2/$10 per MTok) reverts to its $3/$15
    /// sticker on 2026-09-01 (`scheduledChange` in pricing.json/pricing.ts). A response must be
    /// priced at the rate in force at ITS OWN timestamp, not at `now_ms` — the whole point of an
    /// oracle that stays reproducible across regeneration dates. Two responses in one scan,
    /// straddling the boundary, prove each is priced independently rather than the aggregated
    /// cc/cr/out being priced once.
    #[test]
    fn est_cost_usd_prices_each_response_at_its_own_timestamp() {
        let dir = std::env::temp_dir().join(format!("al-burnscan-scheduled-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // Kept ≤48h apart (the window's own cap) so both calls land in one scan.
        let before = 1_788_213_600_000.0; // 2026-08-31T22:00:00Z — introductory: $10/MTok output
        let after = 1_788_228_000_000.0; // 2026-09-01T02:00:00Z — sticker: $15/MTok output
        write_resp(&dir, "r0.response.json", before, "claude-sonnet-5", 0.0, 0.0, 1_000_000.0);
        write_resp(&dir, "r1.response.json", after, "claude-sonnet-5", 0.0, 0.0, 1_000_000.0);
        let opts = InvestigateOptions {
            scope: BodiesScope { dirs: vec![dir.to_string_lossy().into_owned()], missing: vec![], capture_on: true },
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
        // $10 (pre-change) + $15 (post-change) = $25 — NOT $15×2=$30 (today's rate for both) nor
        // $10×2=$20 (the pre-change rate for both).
        let expected = 25.0;
        let got = by_model[0]["estCostUsd"].as_f64().unwrap();
        assert!((got - expected).abs() < 0.01, "expected ~${expected}, got ${got}");
        let total = outcome.partial["totals"]["estCostUsd"].as_f64().unwrap();
        assert!((total - expected).abs() < 0.01, "window total must match the per-response sum, got ${total}");
    }
}
