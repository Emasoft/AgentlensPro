//! Port of src/cacheCreationForensics.ts — SCAN HALF (TRDD-DMWOBWFH P4x.2d).
//!
//! The shared bounded scan every cache-creation-forensic tool builds on: every response body with a
//! non-zero `cache_creation_input_tokens`, joined to its owning session via the
//! `previous_message_id` chain. It never reads more than `scan_cap` response files plus
//! `REQUEST_INDEX_CAP` request files — a directory with 15k+ bodies is NEVER loaded whole.
//!
//! Ported in two slices; this is the first. The report builders (`buildCacheCreationReport`,
//! `buildExpensiveWritesTrace`, `buildCacheBreakGapReport`) consume `scan_cache_creation_events`
//! and land next.
//!
//! TWO TS dependencies are deliberately NOT ported, and neither changes an answer:
//!  - `defaultBodiesDir()` (which is what pulls in `captureConfig.resolveBodiesReadScope` and
//!    `dataDir()`): the bodies dir is a REQUIRED parameter here. The Rust route already resolves it
//!    the same way via `burn::guard::default_bodies_dir(&data_dir)`, so re-deriving it inside the
//!    engine would give two resolvers that can disagree.
//!  - `makeRssSampler`: an in-scan RSS trail written to server.log every 100 files. Pure
//!    diagnostics — it touches nothing in the returned events or coverage.

use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::raw_body_context::parse_user_id;
use crate::summarize::helpers::num;

// Bounded scan caps — same convention as HOG_SCAN_CAP / CAUSE_SCAN_CAP, sized for the (much larger)
// raw-body-file universe rather than the session universe. Only metadata (name + mtime) is read for
// files beyond these caps; JSON content is parsed for the capped slice only.
pub const RESPONSE_SCAN_CAP: usize = 4000;
pub const REQUEST_INDEX_CAP: usize = 4000;
pub const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
/// Matches rawBodyContext's own MAX_RAW_BODY_BYTES guard — request bodies carry embedded images and
/// can be tens of MB; this bounds worst-case per-file memory, not the number of files touched.
pub const MAX_REQUEST_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
    pub mtime_ms: f64,
}

/// List a directory's entries matching a suffix, paired with mtime — WITHOUT reading file content.
/// The cheap first pass every bounded scan starts from (readdir + stat are metadata-only syscalls).
///
/// Sorted, unlike `readdirSync`: Node's order is filesystem-dependent, so the TS's own order is not
/// reproducible across machines. It is observable only in the same-mtime tie order of
/// `bounded_recent`, and a sorted walk is the only stable version of that.
pub fn list_by_suffix(dir: &Path, suffix: &str) -> Vec<DirEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut out = Vec::new();
    for n in names {
        if !n.ends_with(suffix) {
            continue;
        }
        let p = dir.join(&n);
        // A file that vanished between readdir and stat is SKIPPED, not fatal — the reclaim pass
        // runs concurrently with every scan.
        let Ok(st) = std::fs::metadata(&p) else { continue };
        if !st.is_file() {
            continue;
        }
        let mtime_ms = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        out.push(DirEntry { name: n, path: p, mtime_ms });
    }
    out
}

/// Bounded, recency-first slice: newest mtime first, optionally windowed, capped at `cap`.
/// `matched` is the count BEFORE the cap (how many fell in the window) so callers can report an
/// honest sample-vs-total coverage rather than presenting a capped slice as the whole history.
///
/// `now_ms` is threaded in because the TS reads `Date.now()` here — pinning it is what makes the
/// window reproducible.
pub fn bounded_recent(entries: &[DirEntry], window_hours: Option<f64>, cap: usize, now_ms: f64) -> (Vec<DirEntry>, usize) {
    // `windowHours !== undefined && > 0` — a zero or negative window is NO window, not an empty one.
    let matched: Vec<&DirEntry> = match window_hours.filter(|w| *w > 0.0) {
        Some(w) => {
            let cutoff = now_ms - w * 3_600_000.0;
            entries.iter().filter(|e| e.mtime_ms >= cutoff).collect()
        }
        None => entries.iter().collect(),
    };
    let count = matched.len();
    let mut sorted: Vec<DirEntry> = matched.into_iter().cloned().collect();
    // STABLE descending — ties keep the (sorted) directory order.
    sorted.sort_by(|a, b| (b.mtime_ms - a.mtime_ms).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(cap);
    (sorted, count)
}

/// Read + parse a JSON file, refusing anything over `max_bytes`. Every failure — missing, not a
/// file, oversized, unreadable, unparseable — is the SAME `None`, because to a bounded scan they
/// are the same outcome: this file contributes nothing and the scan continues.
pub fn read_json_bounded(path: &Path, max_bytes: u64) -> Option<Value> {
    let st = std::fs::metadata(path).ok()?;
    if !st.is_file() || st.len() > max_bytes {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn num_or0(v: Option<&Value>) -> f64 {
    // `typeof v === 'number' && isFinite(v)` — a numeric STRING is not a number here.
    v.and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0)
}

fn str_or_undef(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

#[derive(Clone, Debug, Default)]
struct RequestLink {
    session_id: Option<String>,
    account_uuid: Option<String>,
    model: Option<String>,
    path: PathBuf,
}

/// Index request bodies by the RESPONSE id they reference (`diagnostics.previous_message_id`) — the
/// join key that attributes a response's cache_creation to a session/account.
///
/// `Map.set` overwrites, so when two requests name the same previous_message_id the LAST one in
/// slice order wins. The slice is newest-first, so that is the OLDEST of the colliding pair.
fn index_requests_by_previous_message_id(entries: &[DirEntry]) -> IndexMap<String, RequestLink> {
    let mut index: IndexMap<String, RequestLink> = IndexMap::new();
    for e in entries {
        let Some(q) = read_json_bounded(&e.path, MAX_REQUEST_BYTES) else { continue };
        let Some(pmid) = str_or_undef(q.get("diagnostics").and_then(|d| d.get("previous_message_id"))) else { continue };
        let uid = parse_user_id(q.get("metadata").and_then(|m| m.get("user_id")).unwrap_or(&Value::Null));
        index.insert(
            pmid,
            RequestLink {
                session_id: uid.session_id,
                account_uuid: uid.account_uuid,
                model: str_or_undef(q.get("model")),
                path: e.path.clone(),
            },
        );
    }
    index
}

#[derive(Clone, Debug, Default)]
pub struct ScanOptions {
    pub window_hours: Option<f64>,
    pub scan_cap: Option<usize>,
    /// Keep calls with ZERO cache_creation (pure warm cache-read turns). Off by default because
    /// every forensic tool here ranks WRITES. The per-call event LOG needs them: a ledger that
    /// hides the cheap warm turns cannot show that the turn before a cold write was warm, which is
    /// exactly the comparison that tells a TTL expiry apart from a prefix break.
    pub include_zero_cache_create: bool,
}

/// One scanned call. Kept as a struct (not a bare `Value`) because the report builders in the next
/// slice read these fields dozens of times; `to_value` is the wire projection.
#[derive(Clone, Debug)]
pub struct CacheCreationEvent {
    pub cache_create_tokens: f64,
    pub cache_read_tokens: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    /// Cost of JUST the cache_creation write.
    pub cost_usd: f64,
    /// TRDD-CCFORNSC — the write splits into TWO TTL tiers (Anthropic's `usage.cache_creation`
    /// sub-object). A write in the 1h tier was never going to expire on a 5-min clock, so this
    /// split is what tells TTL-expiry apart from a genuine cache BREAK. Always present (0 when the
    /// response carries no split).
    pub cache_creation_5m_tokens: f64,
    pub cache_creation_1h_tokens: f64,
    pub model: Option<String>,
    pub response_id: Option<String>,
    /// Response file mtime (epoch ms) — the proxy for call time.
    pub ts: f64,
    pub response_ref: String,
    pub request_ref: Option<String>,
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub attributed: bool,
}

impl CacheCreationEvent {
    /// The object literal's key order, with every `undefined` field DROPPED — `model`,
    /// `responseId`, `requestRef`, `sessionId` and `accountUuid` are all optional, and a `?? null`
    /// port would add five keys the TS never emits.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("cacheCreateTokens".into(), num(self.cache_create_tokens));
        m.insert("cacheReadTokens".into(), num(self.cache_read_tokens));
        m.insert("inputTokens".into(), num(self.input_tokens));
        m.insert("outputTokens".into(), num(self.output_tokens));
        m.insert("costUsd".into(), num(self.cost_usd));
        m.insert("cacheCreation5mTokens".into(), num(self.cache_creation_5m_tokens));
        m.insert("cacheCreation1hTokens".into(), num(self.cache_creation_1h_tokens));
        if let Some(x) = &self.model {
            m.insert("model".into(), Value::String(x.clone()));
        }
        if let Some(x) = &self.response_id {
            m.insert("responseId".into(), Value::String(x.clone()));
        }
        m.insert("ts".into(), num(self.ts));
        m.insert("responseRef".into(), Value::String(self.response_ref.clone()));
        if let Some(x) = &self.request_ref {
            m.insert("requestRef".into(), Value::String(x.clone()));
        }
        if let Some(x) = &self.session_id {
            m.insert("sessionId".into(), Value::String(x.clone()));
        }
        if let Some(x) = &self.account_uuid {
            m.insert("accountUuid".into(), Value::String(x.clone()));
        }
        m.insert("attributed".into(), Value::Bool(self.attributed));
        Value::Object(m)
    }
}

#[derive(Clone, Debug)]
pub struct ScanCoverage {
    pub bodies_dir: String,
    pub dir_exists: bool,
    pub response_files_total: usize,
    pub response_files_scanned: usize,
    pub request_files_total: usize,
    pub request_files_indexed: usize,
    pub scan_cap: usize,
    pub window_hours: Option<f64>,
    pub complete: bool,
    pub note: String,
}

impl ScanCoverage {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("bodiesDir".into(), Value::String(self.bodies_dir.clone()));
        m.insert("dirExists".into(), Value::Bool(self.dir_exists));
        m.insert("responseFilesTotal".into(), num(self.response_files_total as f64));
        m.insert("responseFilesScanned".into(), num(self.response_files_scanned as f64));
        m.insert("requestFilesTotal".into(), num(self.request_files_total as f64));
        m.insert("requestFilesIndexed".into(), num(self.request_files_indexed as f64));
        m.insert("scanCap".into(), num(self.scan_cap as f64));
        // `windowHours: opts.windowHours` — an ABSENT window drops the key entirely.
        if let Some(w) = self.window_hours {
            m.insert("windowHours".into(), num(w));
        }
        m.insert("complete".into(), Value::Bool(self.complete));
        m.insert("note".into(), Value::String(self.note.clone()));
        Value::Object(m)
    }
}

/// The shared bounded scan. `bodies_dir` is required — see the module header for why the engine
/// does not resolve it itself.
pub fn scan_cache_creation_events(bodies_dir: &Path, opts: &ScanOptions, now_ms: f64) -> (Vec<CacheCreationEvent>, ScanCoverage) {
    let dir_str = bodies_dir.to_string_lossy().into_owned();
    let scan_cap = opts.scan_cap.unwrap_or(RESPONSE_SCAN_CAP);
    if !bodies_dir.exists() {
        return (
            Vec::new(),
            ScanCoverage {
                bodies_dir: dir_str.clone(),
                dir_exists: false,
                response_files_total: 0,
                response_files_scanned: 0,
                request_files_total: 0,
                request_files_indexed: 0,
                scan_cap,
                window_hours: opts.window_hours,
                // `complete: true` on a MISSING dir is deliberate: there was nothing to sample, so
                // the scan is not a partial view of anything. Reporting it as incomplete would send
                // the caller retrying for coverage that cannot exist.
                complete: true,
                note: format!("No OTEL raw-body directory at {dir_str} — set OTEL_LOG_RAW_API_BODIES to capture bodies."),
            },
        );
    }

    let all_responses = list_by_suffix(bodies_dir, ".response.json");
    let all_requests = list_by_suffix(bodies_dir, ".request.json");
    let (response_slice, response_matched) = bounded_recent(&all_responses, opts.window_hours, scan_cap, now_ms);
    // Requests are indexed over the SAME window and a matching cap — the request that attributes a
    // response arrives moments later (the next turn), so windowing both sides together keeps the
    // join intact without ever indexing the whole directory. NOTE the request cap is the CONSTANT
    // REQUEST_INDEX_CAP, not `scan_cap`: a caller lowering the response cap does not shrink the
    // index the join depends on.
    let (request_slice, _) = bounded_recent(&all_requests, opts.window_hours, REQUEST_INDEX_CAP, now_ms);
    let prev_index = index_requests_by_previous_message_id(&request_slice);

    let mut events: Vec<CacheCreationEvent> = Vec::new();
    for r in &response_slice {
        let Some(body) = read_json_bounded(&r.path, MAX_RESPONSE_BYTES) else { continue };
        // `!body.usage` is TRUTHY — a response with no usage object contributes nothing.
        let Some(usage) = body.get("usage").filter(|u| crate::summarize::helpers::truthy(u)) else { continue };
        let cc = num_or0(usage.get("cache_creation_input_tokens"));
        if cc <= 0.0 && !opts.include_zero_cache_create {
            continue;
        }
        let response_id = str_or_undef(body.get("id"));
        let link = response_id.as_deref().and_then(|id| prev_index.get(id));
        // The REQUEST's model wins over the response's — the request is what was actually billed,
        // and a response can carry a resolved alias the pricing table does not know.
        let model = link
            .and_then(|l| l.model.clone())
            .or_else(|| str_or_undef(body.get("model")))
            .or_else(|| str_or_undef(body.get("message").and_then(|m| m.get("model"))));
        let tier = usage.get("cache_creation");
        events.push(CacheCreationEvent {
            cache_create_tokens: cc,
            cache_read_tokens: num_or0(usage.get("cache_read_input_tokens")),
            input_tokens: num_or0(usage.get("input_tokens")),
            output_tokens: num_or0(usage.get("output_tokens")),
            // An UNKNOWN model costs 0, not a guessed rate — `unpriced` is the honest answer.
            // `atIso` is OMITTED by the TS call, so the rate is today's — which means the
            // scheduled-rate-change branch reads the wall clock. `now_ms` is threaded through for
            // exactly that, and pinning it is what makes the oracle reproducible.
            cost_usd: model.as_deref().map_or(0.0, |m| calc_token_cost_usd(0.0, 0.0, cc, 0.0, m, 0.0, None, now_ms)),
            cache_creation_5m_tokens: num_or0(tier.and_then(|t| t.get("ephemeral_5m_input_tokens"))),
            cache_creation_1h_tokens: num_or0(tier.and_then(|t| t.get("ephemeral_1h_input_tokens"))),
            model,
            response_id,
            ts: r.mtime_ms,
            response_ref: r.path.to_string_lossy().into_owned(),
            request_ref: link.map(|l| l.path.to_string_lossy().into_owned()),
            session_id: link.and_then(|l| l.session_id.clone()),
            account_uuid: link.and_then(|l| l.account_uuid.clone()),
            attributed: link.is_some(),
        });
    }

    let complete = response_slice.len() == response_matched;
    // `${opts.windowHours ? ` in the last …` : ''}` is TRUTHY, so a ZERO window renders no text —
    // matching `bounded_recent`, which also treats 0 as "no window". The `windowHours` field in
    // coverage still reports the raw 0, because that is what the caller asked for.
    let window_txt = opts.window_hours.filter(|w| *w != 0.0).map_or(String::new(), |w| {
        format!(" in the last {}h", crate::summarize::helpers::fmt_js_num(w))
    });
    let note = if complete {
        format!(
            "Scanned all {response_matched} response body file(s){window_txt} ({} total on disk).",
            all_responses.len()
        )
    } else {
        format!(
            "SAMPLE: {} most-recent of {response_matched} matching response body file(s) scanned (cap {scan_cap}; {} total on disk). Not full history.",
            response_slice.len(),
            all_responses.len()
        )
    };
    (
        events,
        ScanCoverage {
            bodies_dir: dir_str,
            dir_exists: true,
            response_files_total: all_responses.len(),
            response_files_scanned: response_slice.len(),
            request_files_total: all_requests.len(),
            request_files_indexed: request_slice.len(),
            scan_cap,
            window_hours: opts.window_hours,
            complete,
            note,
        },
    )
}
