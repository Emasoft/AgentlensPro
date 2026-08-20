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

use crate::context_composition_index::build_call_composition;
use crate::pricing::calc_token_cost_usd;
use crate::raw_body_context::parse_user_id;
use crate::summarize::helpers::{
    fmt_js_num, iso_from_ms, js_slice, js_string, js_to_fixed_num, num, pad_end, pad_start, parse_iso_ms, to_locale_en,
};

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

// ── REPORT HALF ─────────────────────────────────────────────────────────────
// The three builders that consume the scan above, plus their formatters. Each returns the wire
// `Value` directly rather than a struct-with-`to_value`: the formatters read the report back field
// by field exactly as the TS does, so a second in-memory representation would only be a place for
// the two to disagree.

/// `Array.prototype.slice(0, n)`'s end index. A NEGATIVE `n` counts back from the END
/// (`max(len + n, 0)`) — it does NOT mean "empty". `topN` is clamped from above but never from
/// below in the TS, so a caller passing -1 asks for "all but the last" and gets it.
fn slice_end(len: usize, n: f64) -> usize {
    if n < 0.0 {
        (len as f64 + n).max(0.0) as usize
    } else {
        (n as usize).min(len)
    }
}

/// `hourBucket` — the 'time' groupBy dimension: the containing hour as "YYYY-MM-DDTHH:00".
fn hour_bucket(ts: f64) -> String {
    format!("{}:00", &iso_from_ms((ts / 3_600_000.0).floor() * 3_600_000.0)[..13])
}

fn group_key_of(e: &CacheCreationEvent, group_by: &str) -> String {
    match group_by {
        "account" => e.account_uuid.clone().unwrap_or_else(|| "(unattributed)".to_owned()),
        "model" => e.model.clone().unwrap_or_else(|| "(unknown model)".to_owned()),
        "time" => hour_bucket(e.ts),
        // `case 'session': default:` — an unrecognized dimension falls through to session rather
        // than erroring. The one dimension that MUST NOT arrive here is 'cause' (it needs the
        // prefix-diff classifier in cacheBreakTimeline); the caller rejects it, see the MCP arm.
        _ => e.session_id.clone().unwrap_or_else(|| "(unattributed)".to_owned()),
    }
}

/// The structural `TokenCounts` the TS exports so cacheBreakTimeline's cause report can rank its
/// own per-turn shape by the SAME bucket formulas without importing `CacheCreationEvent`.
#[derive(Clone, Copy, Debug, Default)]
pub struct TokenCounts<'a> {
    pub input_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub output_tokens: f64,
    pub model: Option<&'a str>,
}

impl CacheCreationEvent {
    pub fn token_counts(&self) -> TokenCounts<'_> {
        TokenCounts {
            input_tokens: self.input_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_create_tokens: self.cache_create_tokens,
            output_tokens: self.output_tokens,
            model: self.model.as_deref(),
        }
    }
}

pub fn token_counts_total(t: &TokenCounts) -> f64 {
    t.input_tokens + t.cache_read_tokens + t.cache_create_tokens + t.output_tokens
}

/// `now_ms` is threaded for the same reason as in the scan: the TS omits `atIso`, so the pricing
/// table's scheduled-rate-change branch resolves against the wall clock.
pub fn token_counts_full_cost(t: &TokenCounts, now_ms: f64) -> f64 {
    // `t.model ? … : 0` is TRUTHY — an EMPTY model string is unpriced, never looked up.
    match t.model.filter(|m| !m.is_empty()) {
        Some(m) => calc_token_cost_usd(
            t.input_tokens,
            t.cache_read_tokens,
            t.cache_create_tokens,
            t.output_tokens,
            m,
            0.0,
            None,
            now_ms,
        ),
        None => 0.0,
    }
}

pub fn bucket_value_of(t: &TokenCounts, bucket: &str, now_ms: f64) -> f64 {
    match bucket {
        "output" => t.output_tokens,
        "input" => t.input_tokens,
        "total" => token_counts_total(t),
        "billable_weighted" => token_counts_full_cost(t, now_ms),
        // `case 'cache_creation': default:` — an unrecognized bucket ranks by the WRITE, not by 0.
        _ => t.cache_create_tokens,
    }
}

#[derive(Clone, Debug, Default)]
struct GroupRow {
    key: String,
    cache_create: f64,
    cache_read: f64,
    input: f64,
    output: f64,
    total: f64,
    cost_usd: f64,
    events: f64,
    max_single_cc: f64,
    max_single_out: f64,
    bucket_value: f64,
}

impl GroupRow {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), Value::String(self.key.clone()));
        m.insert("cacheCreateTokens".into(), num(self.cache_create));
        m.insert("cacheReadTokens".into(), num(self.cache_read));
        m.insert("inputTokens".into(), num(self.input));
        m.insert("outputTokens".into(), num(self.output));
        m.insert("totalTokens".into(), num(self.total));
        m.insert("costUsd".into(), num(self.cost_usd));
        m.insert("events".into(), num(self.events));
        m.insert("maxSingleCacheCreateTokens".into(), num(self.max_single_cc));
        m.insert("maxSingleOutputTokens".into(), num(self.max_single_out));
        m.insert("bucketValue".into(), num(self.bucket_value));
        Value::Object(m)
    }
}

const UNATTRIBUTED_NOTE: &str = "Responses with no following request in the scanned window (last-turn / still-in-flight calls) — cannot be joined to a session.";
const OUTPUT_SPIKE_NOTE: &str = "The biggest single OUTPUT-token events (output is billed at ~5x the input rate — sometimes the real cost peak, not the cache write). Rank by bucket=output or bucket=billable_weighted to surface these in the groups.";

/// The COST-PEAK finder: ranks WHO/WHAT is burning the most of a chosen cost bucket, because the
/// peak is sometimes an OUTPUT-token spike (billed ~5x) rather than a cache write.
pub fn build_cache_creation_report(
    bodies_dir: &Path,
    opts: &ScanOptions,
    group_by: &str,
    bucket: &str,
    top_n: Option<f64>,
    now_ms: f64,
) -> Value {
    let top_n = top_n.unwrap_or(15.0).min(50.0);
    let (events, coverage) = scan_cache_creation_events(bodies_dir, opts, now_ms);

    let mut groups: IndexMap<String, GroupRow> = IndexMap::new();
    let (mut t_cc, mut t_cr, mut t_in, mut t_out, mut t_cost) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let (mut un_events, mut un_cc, mut un_cost) = (0.0, 0.0, 0.0);
    for e in &events {
        let tc = e.token_counts();
        let full_cost = token_counts_full_cost(&tc, now_ms);
        t_cc += e.cache_create_tokens;
        t_cr += e.cache_read_tokens;
        t_in += e.input_tokens;
        t_out += e.output_tokens;
        t_cost += full_cost;
        if !e.attributed {
            un_events += 1.0;
            un_cc += e.cache_create_tokens;
            un_cost += full_cost;
        }
        let key = group_key_of(e, group_by);
        let g = groups.entry(key.clone()).or_insert_with(|| GroupRow { key, ..GroupRow::default() });
        g.cache_create += e.cache_create_tokens;
        g.cache_read += e.cache_read_tokens;
        g.input += e.input_tokens;
        g.output += e.output_tokens;
        g.total += token_counts_total(&tc);
        g.cost_usd += full_cost;
        g.events += 1.0;
        g.max_single_cc = g.max_single_cc.max(e.cache_create_tokens);
        g.max_single_out = g.max_single_out.max(e.output_tokens);
        g.bucket_value += bucket_value_of(&tc, bucket, now_ms);
    }

    // `.map(toFixed(4))` runs BEFORE the sort, so the ranking compares the ROUNDED values: two
    // groups differing only past the 4th decimal are TIES, and a stable sort leaves them in
    // first-seen order. Rounding after the sort would order them by invisible digits.
    let mut ranked: Vec<GroupRow> = groups
        .into_values()
        .map(|mut g| {
            g.cost_usd = js_to_fixed_num(g.cost_usd, 4);
            g.bucket_value = js_to_fixed_num(g.bucket_value, 4);
            g
        })
        .collect();
    ranked.sort_by(|a, b| b.bucket_value.partial_cmp(&a.bucket_value).unwrap_or(std::cmp::Ordering::Equal));

    let mut spikes: Vec<&CacheCreationEvent> = events.iter().filter(|e| e.output_tokens > 0.0).collect();
    spikes.sort_by(|a, b| b.output_tokens.partial_cmp(&a.output_tokens).unwrap_or(std::cmp::Ordering::Equal));
    spikes.truncate(5);
    let spike_values: Vec<Value> = spikes
        .iter()
        .map(|e| {
            let mut m = Map::new();
            // The literal's key order, with every `undefined` field DROPPED.
            if let Some(x) = &e.session_id {
                m.insert("sessionId".into(), Value::String(x.clone()));
            }
            if let Some(x) = &e.account_uuid {
                m.insert("accountUuid".into(), Value::String(x.clone()));
            }
            if let Some(x) = &e.model {
                m.insert("model".into(), Value::String(x.clone()));
            }
            m.insert("outputTokens".into(), num(e.output_tokens));
            m.insert("cacheCreateTokens".into(), num(e.cache_create_tokens));
            m.insert("ts".into(), Value::String(iso_from_ms(e.ts)));
            Value::Object(m)
        })
        .collect();

    let mut out = Map::new();
    out.insert("bucket".into(), Value::String(bucket.to_owned()));
    out.insert("groupBy".into(), Value::String(group_by.to_owned()));
    if let Some(w) = opts.window_hours {
        out.insert("windowHours".into(), num(w));
    }
    out.insert("totalCacheCreateTokens".into(), num(t_cc));
    out.insert("totalCacheReadTokens".into(), num(t_cr));
    out.insert("totalInputTokens".into(), num(t_in));
    out.insert("totalOutputTokens".into(), num(t_out));
    out.insert("totalCostUsd".into(), num(js_to_fixed_num(t_cost, 4)));
    let mut un = Map::new();
    un.insert("events".into(), num(un_events));
    un.insert("cacheCreateTokens".into(), num(un_cc));
    un.insert("costUsd".into(), num(js_to_fixed_num(un_cost, 4)));
    un.insert("note".into(), Value::String(UNATTRIBUTED_NOTE.to_owned()));
    out.insert("unattributed".into(), Value::Object(un));
    let mut sp = Map::new();
    sp.insert("note".into(), Value::String(OUTPUT_SPIKE_NOTE.to_owned()));
    sp.insert("top".into(), Value::Array(spike_values));
    out.insert("outputSpikes".into(), Value::Object(sp));
    let end = slice_end(ranked.len(), top_n);
    out.insert("groups".into(), Value::Array(ranked[..end].iter().map(GroupRow::to_value).collect()));
    out.insert("coverage".into(), coverage.to_value());
    Value::Object(out)
}

/// Render a cost-peak report. `json` → the object itself; every other format → a compact string
/// wrapped as `{ format, text, coverage }`.
pub fn format_cost_peaks(report: &Value, format: &str) -> Value {
    if format == "json" {
        return report.clone();
    }
    let empty: Vec<Value> = Vec::new();
    let groups = report.get("groups").and_then(Value::as_array).unwrap_or(&empty);
    let spikes = report.pointer("/outputSpikes/top").and_then(Value::as_array).unwrap_or(&empty);
    let bucket = report.get("bucket").and_then(Value::as_str).unwrap_or("");
    let group_by = report.get("groupBy").and_then(Value::as_str).unwrap_or("");
    let hdr = format!("cost peaks by {bucket} — grouped by {group_by} (top {})", groups.len());
    let f = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let key_of = |g: &Value| g.get("key").and_then(Value::as_str).unwrap_or("").to_owned();
    // `?? '?'` / `?? '(unattr)'` are NULLISH on an ABSENT key — a spike whose model was dropped.
    let model_of = |s: &Value| s.get("model").and_then(Value::as_str).unwrap_or("?").to_owned();
    let sid_of = |s: &Value| js_slice(s.get("sessionId").and_then(Value::as_str).unwrap_or("(unattr)"), 12).to_owned();
    let ts_of = |s: &Value| s.get("ts").and_then(Value::as_str).unwrap_or("").to_owned();

    let mut lines: Vec<String> = Vec::new();
    if format == "markdown" {
        lines.push(format!("# {hdr}"));
        lines.push(String::new());
        lines.push(format!("| group | {bucket} | cache_create | output | cost | events |"));
        lines.push("|---|---|---|---|---|---|".to_owned());
        for g in groups {
            lines.push(format!(
                "| {} | {} | {} | {} | ${} | {} |",
                js_slice(&key_of(g), 20),
                to_locale_en(f(g, "bucketValue")),
                to_locale_en(f(g, "cacheCreateTokens")),
                to_locale_en(f(g, "outputTokens")),
                fmt_js_num(f(g, "costUsd")),
                fmt_js_num(f(g, "events")),
            ));
        }
        lines.push(String::new());
        lines.push("## Output spikes (billed ~5x)".to_owned());
        lines.push(String::new());
        for s in spikes {
            lines.push(format!(
                "- {} out tok `{}` {} {}",
                to_locale_en(f(s, "outputTokens")),
                ts_of(s),
                model_of(s),
                sid_of(s),
            ));
        }
    } else if format == "timeline" {
        lines.push(hdr);
        for s in spikes {
            lines.push(format!(
                "{}  🔊 output={}  cc={}  {}  {}",
                ts_of(s),
                to_locale_en(f(s, "outputTokens")),
                to_locale_en(f(s, "cacheCreateTokens")),
                model_of(s),
                sid_of(s),
            ));
        }
    } else {
        lines.push(hdr);
        lines.push(format!("  {} cache_create      output   cost     group", pad_end(bucket, 14)));
        for g in groups {
            lines.push(format!(
                "  {} {} {}  ${}  {}",
                pad_start(&to_locale_en(f(g, "bucketValue")), 14),
                pad_start(&fmt_js_num(f(g, "cacheCreateTokens")), 12),
                pad_start(&fmt_js_num(f(g, "outputTokens")), 11),
                pad_start(&fmt_js_num(f(g, "costUsd")), 7),
                js_slice(&key_of(g), 24),
            ));
        }
    }
    let mut m = Map::new();
    m.insert("format".into(), Value::String(format.to_owned()));
    m.insert("text".into(), Value::String(lines.join("\n")));
    m.insert("coverage".into(), report.get("coverage").cloned().unwrap_or(Value::Null));
    Value::Object(m)
}

// ── trace_expensive_writes ──────────────────────────────────────────────────

const MAX_CHAIN_DEPTH: f64 = 20.0;

fn tool_catalog_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\((\d+) tools\)").expect("static regex"))
}

/// Reduce a full `CallComposition` (which carries raw block text) to POINTER-ONLY summary numbers —
/// never forwards a block's text, bytes, or the request's base64 image data.
fn composition_summary_from(cc: &Value) -> Value {
    let empty: Vec<Value> = Vec::new();
    let blocks = cc.get("blocks").and_then(Value::as_array).unwrap_or(&empty);
    let catalog = blocks.iter().find(|b| b.get("kind").and_then(Value::as_str) == Some("toolCatalog"));
    // `RE.exec(label)` coerces a non-string label (`null` → "null"), which then simply fails to
    // match — the same 0 as an absent catalog block, not a crash.
    let count = catalog
        .map(|b| js_string(b.get("label").unwrap_or(&Value::Null)))
        .and_then(|label| tool_catalog_re().captures(&label).and_then(|c| c[1].parse::<f64>().ok()))
        .unwrap_or(0.0);
    let f = |k: &str| cc.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let mut m = Map::new();
    m.insert("imageTokens".into(), num(cc.pointer("/images/tokens").and_then(Value::as_f64).unwrap_or(0.0)));
    m.insert("imageCount".into(), num(cc.pointer("/images/count").and_then(Value::as_f64).unwrap_or(0.0)));
    m.insert("toolResultTokens".into(), num(f("toolResultTokens")));
    m.insert("textTokens".into(), num(f("textTokens")));
    m.insert("thinkingTokens".into(), num(f("thinkingTokens")));
    m.insert("systemTokens".into(), num(f("systemTokens")));
    m.insert("toolCatalogTokens".into(), num(f("toolCatalogTokens")));
    m.insert("toolCatalogCount".into(), num(count));
    Value::Object(m)
}

/// One bounded request scan grouping every request body by its session_id into ordered
/// (ts, bodyRef) turns — the index the backward context chain walks. Run only when chainDepth > 0.
///
/// NOTE the cap is `opts.scanCap ?? REQUEST_INDEX_CAP` here, unlike the main scan's join index
/// which always uses the constant. Lowering scanCap DOES shrink this one.
fn scan_session_request_turns(bodies_dir: &Path, opts: &ScanOptions, now_ms: f64) -> IndexMap<String, Vec<(f64, String)>> {
    let cap = opts.scan_cap.unwrap_or(REQUEST_INDEX_CAP);
    let (slice, _) = bounded_recent(&list_by_suffix(bodies_dir, ".request.json"), opts.window_hours, cap, now_ms);
    let mut by_session: IndexMap<String, Vec<(f64, String)>> = IndexMap::new();
    for e in &slice {
        let Some(q) = read_json_bounded(&e.path, MAX_REQUEST_BYTES) else { continue };
        let uid = parse_user_id(q.get("metadata").and_then(|m| m.get("user_id")).unwrap_or(&Value::Null));
        // `if (!sid) continue` is TRUTHY — an empty session id is no session.
        let Some(sid) = uid.session_id.filter(|s| !s.is_empty()) else { continue };
        by_session.entry(sid).or_default().push((e.mtime_ms, e.path.to_string_lossy().into_owned()));
    }
    for list in by_session.values_mut() {
        list.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    }
    by_session
}

/// Every filter `buildExpensiveWritesTrace` accepts. Kept as raw `Option`s because the `filters`
/// echo in the result reports what the CALLER passed (an empty string is echoed as `""`), while
/// the filtering itself applies JS truthiness — the two are not the same value.
#[derive(Clone, Debug, Default)]
pub struct TraceFilters {
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub model: Option<String>,
    pub min_cache_create: Option<f64>,
    pub min_output_tokens: Option<f64>,
    pub turn_from: Option<f64>,
    pub turn_to: Option<f64>,
    pub time_from_iso: Option<String>,
    pub time_to_iso: Option<String>,
    pub top_n: Option<f64>,
    pub chain_depth: Option<f64>,
}

/// For the biggest single cache_creation writes, summarizes the CONTENT that made each expensive
/// (image / tool_result / text / system shares + tool-catalog size) — pointer-only, never raw text
/// or base64 — and optionally attaches the backward CONTEXT CHAIN that ramped up to it.
pub fn build_expensive_writes_trace(bodies_dir: &Path, opts: &ScanOptions, f: &TraceFilters, now_ms: f64) -> Value {
    let min_cc = f.min_cache_create.unwrap_or(0.0).max(0.0);
    let min_out = f.min_output_tokens.unwrap_or(0.0).max(0.0);
    let top_n = f.top_n.unwrap_or(6.0).min(25.0);
    let chain_depth = f.chain_depth.unwrap_or(0.0).clamp(0.0, MAX_CHAIN_DEPTH);
    // `opts.timeFromIso ? Date.parse(…) : undefined` is TRUTHY, so "" means NO filter; an
    // UNPARSEABLE string yields NaN, and every NaN comparison is false — which excludes
    // everything. That is the TS behaviour and it must not be "helpfully" repaired to no-filter.
    let time_from = f.time_from_iso.as_deref().filter(|s| !s.is_empty()).map(|s| parse_iso_ms(s).unwrap_or(f64::NAN));
    let time_to = f.time_to_iso.as_deref().filter(|s| !s.is_empty()).map(|s| parse_iso_ms(s).unwrap_or(f64::NAN));
    let want_session = f.session_id.as_deref().filter(|s| !s.is_empty());
    let want_account = f.account_uuid.as_deref().filter(|s| !s.is_empty());
    let want_model = f.model.as_deref().filter(|s| !s.is_empty());

    let (events, coverage) = scan_cache_creation_events(bodies_dir, opts, now_ms);
    let filtered: Vec<&CacheCreationEvent> = events
        .iter()
        .filter(|e| {
            e.cache_create_tokens >= min_cc
                && e.output_tokens >= min_out
                && want_session.is_none_or(|s| e.session_id.as_deref() == Some(s))
                && want_account.is_none_or(|a| e.account_uuid.as_deref() == Some(a))
                && want_model.is_none_or(|m| e.model.as_deref().unwrap_or("").contains(m))
                && time_from.is_none_or(|t| e.ts >= t)
                && time_to.is_none_or(|t| e.ts <= t)
        })
        .collect();

    // Per-session chronological turn index (1-based, among that session's cache_creation events).
    // Assigned over the SIZE/IDENTITY-filtered set BEFORE the turn-range filter runs, so an event
    // the range excludes still consumed its sequence number — which is what makes `turnFrom` mean
    // the same thing across two calls with different ranges.
    let mut order: Vec<usize> = (0..filtered.len()).collect();
    order.sort_by(|&a, &b| filtered[a].ts.partial_cmp(&filtered[b].ts).unwrap_or(std::cmp::Ordering::Equal));
    let mut turn_of = vec![0.0f64; filtered.len()];
    let mut seq: IndexMap<String, f64> = IndexMap::new();
    for &i in &order {
        let sid = filtered[i].session_id.clone().unwrap_or_else(|| "(unattributed)".to_owned());
        let n = seq.get(&sid).copied().unwrap_or(0.0) + 1.0;
        seq.insert(sid, n);
        turn_of[i] = n;
    }
    let mut idx: Vec<usize> = (0..filtered.len()).collect();
    if let Some(from) = f.turn_from {
        idx.retain(|&i| turn_of[i] >= from);
    }
    if let Some(to) = f.turn_to {
        idx.retain(|&i| turn_of[i] <= to);
    }
    idx.sort_by(|&a, &b| {
        filtered[b].cache_create_tokens.partial_cmp(&filtered[a].cache_create_tokens).unwrap_or(std::cmp::Ordering::Equal)
    });
    let end = slice_end(idx.len(), top_n);
    idx.truncate(end);

    let session_turns = if chain_depth > 0.0 { Some(scan_session_request_turns(bodies_dir, opts, now_ms)) } else { None };
    // Keyed on bodyRef ALONE, exactly as the TS is: the same request reached first as an event's
    // own body (WITH exact usage) and later as a chain turn (without) reuses the first summary.
    // Keying on (bodyRef, exact) would silently re-parse and produce a differently-calibrated
    // number for the same file.
    let mut comp_cache: IndexMap<String, Option<Value>> = IndexMap::new();

    let mut out_events: Vec<Value> = Vec::new();
    for &i in &idx {
        let e = filtered[i];
        let composition = match e.request_ref.as_deref() {
            Some(body_ref) => {
                let mut exact = Map::new();
                exact.insert("inputTokens".into(), num(e.input_tokens));
                exact.insert("outputTokens".into(), num(e.output_tokens));
                exact.insert("cacheReadTokens".into(), num(e.cache_read_tokens));
                exact.insert("cacheCreateTokens".into(), num(e.cache_create_tokens));
                if let Some(rid) = &e.response_id {
                    exact.insert("responseId".into(), Value::String(rid.clone()));
                }
                summarize_body(&mut comp_cache, body_ref, e.ts, Some(&Value::Object(exact)), now_ms)
            }
            None => None,
        };

        let mut backward: Option<Vec<Value>> = None;
        if let (Some(turns), Some(sid)) = (session_turns.as_ref(), e.session_id.as_deref()) {
            let list = turns.get(sid).cloned().unwrap_or_default();
            let preceding: Vec<(f64, String)> = list.into_iter().filter(|t| t.0 <= e.ts).collect();
            let start = preceding.len().saturating_sub(chain_depth as usize);
            let mut chain = Vec::new();
            for (ts, body_ref) in &preceding[start..] {
                let mut m = Map::new();
                m.insert("ts".into(), Value::String(iso_from_ms(*ts)));
                m.insert("bodyRef".into(), Value::String(body_ref.clone()));
                m.insert(
                    "composition".into(),
                    summarize_body(&mut comp_cache, body_ref, *ts, None, now_ms).unwrap_or(Value::Null),
                );
                chain.push(Value::Object(m));
            }
            backward = Some(chain);
        }

        let mut m = Map::new();
        m.insert("turn".into(), num(turn_of[i]));
        m.insert("cacheCreateTokens".into(), num(e.cache_create_tokens));
        m.insert("outputTokens".into(), num(e.output_tokens));
        m.insert("costUsd".into(), num(js_to_fixed_num(e.cost_usd, 4)));
        m.insert("ts".into(), Value::String(iso_from_ms(e.ts)));
        if let Some(x) = &e.model {
            m.insert("model".into(), Value::String(x.clone()));
        }
        if let Some(x) = &e.session_id {
            m.insert("sessionId".into(), Value::String(x.clone()));
        }
        if let Some(x) = &e.account_uuid {
            m.insert("accountUuid".into(), Value::String(x.clone()));
        }
        m.insert("attributed".into(), Value::Bool(e.attributed));
        if let Some(x) = &e.request_ref {
            m.insert("requestRef".into(), Value::String(x.clone()));
        }
        m.insert("responseRef".into(), Value::String(e.response_ref.clone()));
        m.insert("composition".into(), composition.unwrap_or(Value::Null));
        if let Some(chain) = backward {
            m.insert("backwardChain".into(), Value::Array(chain));
        }
        out_events.push(Value::Object(m));
    }

    let mut filters = Map::new();
    if let Some(x) = &f.session_id {
        filters.insert("sessionId".into(), Value::String(x.clone()));
    }
    if let Some(x) = &f.account_uuid {
        filters.insert("accountUuid".into(), Value::String(x.clone()));
    }
    if let Some(x) = &f.model {
        filters.insert("model".into(), Value::String(x.clone()));
    }
    filters.insert("minCacheCreate".into(), num(min_cc));
    filters.insert("minOutputTokens".into(), num(min_out));
    if let Some(x) = f.turn_from {
        filters.insert("turnFrom".into(), num(x));
    }
    if let Some(x) = f.turn_to {
        filters.insert("turnTo".into(), num(x));
    }
    if let Some(x) = &f.time_from_iso {
        filters.insert("timeFromIso".into(), Value::String(x.clone()));
    }
    if let Some(x) = &f.time_to_iso {
        filters.insert("timeToIso".into(), Value::String(x.clone()));
    }
    filters.insert("topN".into(), num(top_n));
    filters.insert("chainDepth".into(), num(chain_depth));

    let mut out = Map::new();
    out.insert("minCacheCreate".into(), num(min_cc));
    if let Some(w) = opts.window_hours {
        out.insert("windowHours".into(), num(w));
    }
    out.insert("filters".into(), Value::Object(filters));
    out.insert("events".into(), Value::Array(out_events));
    out.insert("coverage".into(), coverage.to_value());
    Value::Object(out)
}

fn summarize_body(
    cache: &mut IndexMap<String, Option<Value>>,
    body_ref: &str,
    ts: f64,
    exact: Option<&Value>,
    now_ms: f64,
) -> Option<Value> {
    if let Some(hit) = cache.get(body_ref) {
        return hit.clone();
    }
    let summary = build_call_composition(body_ref, 1.0, ts, None, exact, None, None, now_ms).map(|cc| composition_summary_from(&cc));
    cache.insert(body_ref.to_owned(), summary.clone());
    summary
}

fn dominant_component(c: Option<&Value>) -> String {
    let Some(c) = c.filter(|v| !v.is_null()) else { return "(no body)".to_owned() };
    let g = |k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let mut parts: Vec<(&str, f64)> = vec![
        ("image", g("imageTokens")),
        ("tool_result", g("toolResultTokens")),
        ("text", g("textTokens")),
        ("thinking", g("thinkingTokens")),
        ("system", g("systemTokens")),
        ("toolCatalog", g("toolCatalogTokens")),
    ];
    // Stable sort — an all-equal composition names `image`, the first in declaration order.
    parts.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let (name, tokens) = parts[0];
    if tokens > 0.0 {
        format!("{name}~{}", to_locale_en(tokens))
    } else {
        "(mixed)".to_owned()
    }
}

/// Render an expensive-writes trace. `json` → the object itself; the others → a compact string
/// wrapped as `{ format, text, coverage }` so the MCP result stays JSON-serializable.
pub fn format_expensive_writes(trace: &Value, format: &str) -> Value {
    if format == "json" {
        return trace.clone();
    }
    let empty: Vec<Value> = Vec::new();
    let events = trace.get("events").and_then(Value::as_array).unwrap_or(&empty);
    // `trace.filters.sessionId ? …` is TRUTHY — an echoed "" adds no bracket.
    let scope = trace
        .pointer("/filters/sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map_or(String::new(), |s| format!(" [session {s}]"));
    let hdr = format!("expensive cache_creation writes — top {}{scope}", events.len());
    let f = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let model_of = |e: &Value| e.get("model").and_then(Value::as_str).unwrap_or("?").to_owned();
    let sid_of = |e: &Value| js_slice(e.get("sessionId").and_then(Value::as_str).unwrap_or("(unattr)"), 12).to_owned();
    let ts_of = |e: &Value| e.get("ts").and_then(Value::as_str).unwrap_or("").to_owned();
    let dom = |e: &Value| dominant_component(e.get("composition"));

    let mut lines: Vec<String> = Vec::new();
    if format == "markdown" {
        lines.push(format!("# {hdr}"));
        lines.push(String::new());
        lines.push("| # | tokens | out | cost | model | session | dominant |".to_owned());
        lines.push("|---|---|---|---|---|---|---|".to_owned());
        for (i, e) in events.iter().enumerate() {
            lines.push(format!(
                "| {} | {} | {} | ${} | {} | {} | {} |",
                i + 1,
                to_locale_en(f(e, "cacheCreateTokens")),
                to_locale_en(f(e, "outputTokens")),
                fmt_js_num(f(e, "costUsd")),
                model_of(e),
                sid_of(e),
                dom(e),
            ));
        }
        for e in events {
            let chain = e.get("backwardChain").and_then(Value::as_array).unwrap_or(&empty);
            // `!e.backwardChain?.length` — an absent OR empty chain gets no section.
            if chain.is_empty() {
                continue;
            }
            lines.push(String::new());
            lines.push(format!(
                "## Context ramp → write @ {} ({} tok)",
                ts_of(e),
                to_locale_en(f(e, "cacheCreateTokens"))
            ));
            for (i, t) in chain.iter().enumerate() {
                lines.push(format!(
                    "- t-{}: `{}` {}",
                    chain.len() - i,
                    t.get("ts").and_then(Value::as_str).unwrap_or(""),
                    dominant_component(t.get("composition")),
                ));
            }
        }
    } else if format == "timeline" {
        lines.push(hdr);
        let mut sorted: Vec<&Value> = events.iter().collect();
        // `a.ts.localeCompare(b.ts)` over ISO strings — byte order and locale order coincide.
        sorted.sort_by_key(|a| ts_of(a));
        for e in sorted {
            lines.push(format!(
                "{}  💥 {} tok  out={}  {}  {}  ← {}",
                ts_of(e),
                to_locale_en(f(e, "cacheCreateTokens")),
                to_locale_en(f(e, "outputTokens")),
                model_of(e),
                sid_of(e),
                dom(e),
            ));
        }
    } else {
        lines.push(hdr);
        lines.push("  #      tokens       out    cost   dominant            session".to_owned());
        for (i, e) in events.iter().enumerate() {
            lines.push(format!(
                "{}  {}  {}  ${}  {}  {}",
                pad_start(&(i + 1).to_string(), 3),
                pad_start(&fmt_js_num(f(e, "cacheCreateTokens")), 11),
                pad_start(&fmt_js_num(f(e, "outputTokens")), 8),
                pad_start(&fmt_js_num(f(e, "costUsd")), 6),
                pad_end(&dom(e), 18),
                sid_of(e),
            ));
        }
    }
    let mut m = Map::new();
    m.insert("format".into(), Value::String(format.to_owned()));
    m.insert("text".into(), Value::String(lines.join("\n")));
    m.insert("coverage".into(), trace.get("coverage").cloned().unwrap_or(Value::Null));
    Value::Object(m)
}

// ── get_cache_break_gap_report ──────────────────────────────────────────────

/// The reference script's threshold for a "big" (worth TTL/break-classifying) write.
pub const DEFAULT_BIG_CACHE_CREATE: f64 = 100_000.0;

const GAP_BUCKET_ORDER: [&str; 6] =
    ["first-call(no prev)", "<4.5m", "4.5-6m(=5m TTL)", "6-15m", "15-65m", ">65m(1h TTL)"];

const TIER_SPLIT_NOTE: &str = "If mostly the 1h tier, a <5-min heartbeat is IRRELEVANT to those writes — they were never going to expire on the 5-min clock.";
const GAP_INTERPRETATION: [&str; 3] = [
    "Mass in \"4.5-6m(=5m TTL)\" -> 5-min TTL expiry: a <5min heartbeat WOULD convert these writes to cache_read.",
    "Mass in \"first-call(no prev)\" / \">65m(1h TTL)\" / \"15-65m\" -> cold start/resume/1h-expiry: a 5-min heartbeat does NOT help.",
    "Mass in \"<4.5m\" -> a genuine CACHE BREAK (the prefix changed faster than any TTL could have expired it) — the fix is upstream (stop the prefix from changing), not a heartbeat.",
];

fn classify_gap_minutes(gap_minutes: f64) -> &'static str {
    if gap_minutes < 4.5 {
        "<4.5m"
    } else if gap_minutes < 6.0 {
        "4.5-6m(=5m TTL)"
    } else if gap_minutes < 15.0 {
        "6-15m"
    } else if gap_minutes < 65.0 {
        "15-65m"
    } else {
        ">65m(1h TTL)"
    }
}

/// Splits cache_creation into its 5-min / 1-hour TTL tiers, and buckets every BIG write by the time
/// gap since the previous call in its session — the "was this a TTL expiry or a cache break"
/// diagnostic.
pub fn build_cache_break_gap_report(bodies_dir: &Path, opts: &ScanOptions, min_cache_create: Option<f64>, now_ms: f64) -> Value {
    let min_cc = min_cache_create.unwrap_or(DEFAULT_BIG_CACHE_CREATE);
    let (events, coverage) = scan_cache_creation_events(bodies_dir, opts, now_ms);

    // The tier split is over EVERY scanned event, not just the big ones — it answers "how much of
    // ALL cache_creation is even TTL-bound", independent of the per-event break/TTL diagnostic.
    let (mut total_cc, mut t5, mut t1) = (0.0, 0.0, 0.0);
    for e in &events {
        total_cc += e.cache_create_tokens;
        t5 += e.cache_creation_5m_tokens;
        t1 += e.cache_creation_1h_tokens;
    }

    let mut by_session: IndexMap<String, Vec<&CacheCreationEvent>> = IndexMap::new();
    for e in &events {
        by_session
            .entry(e.session_id.clone().unwrap_or_else(|| "(unattributed)".to_owned()))
            .or_default()
            .push(e);
    }

    let mut buckets: IndexMap<&str, (f64, f64)> = GAP_BUCKET_ORDER.iter().map(|k| (*k, (0.0, 0.0))).collect();
    let mut big_event_count = 0.0;
    for list in by_session.values() {
        let mut sorted: Vec<&&CacheCreationEvent> = list.iter().collect();
        sorted.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));
        for (i, e) in sorted.iter().enumerate() {
            if e.cache_create_tokens < min_cc {
                continue;
            }
            big_event_count += 1.0;
            // `i === 0` is POSITIONAL within the session, not "the previous BIG event" — a big
            // write whose predecessor was too small to classify still measures its gap against it.
            let key = if i == 0 {
                GAP_BUCKET_ORDER[0]
            } else {
                classify_gap_minutes((e.ts - sorted[i - 1].ts) / 60_000.0)
            };
            let row = buckets.entry(key).or_insert((0.0, 0.0));
            row.0 += 1.0;
            row.1 += e.cache_create_tokens;
        }
    }

    let mut tier = Map::new();
    tier.insert("totalCacheCreateTokens".into(), num(total_cc));
    tier.insert("ephemeral5mTokens".into(), num(t5));
    tier.insert("ephemeral1hTokens".into(), num(t1));
    tier.insert("ephemeral5mPct".into(), num(if total_cc > 0.0 { js_to_fixed_num(100.0 * t5 / total_cc, 1) } else { 0.0 }));
    tier.insert("ephemeral1hPct".into(), num(if total_cc > 0.0 { js_to_fixed_num(100.0 * t1 / total_cc, 1) } else { 0.0 }));
    tier.insert("note".into(), Value::String(TIER_SPLIT_NOTE.to_owned()));

    let mut out = Map::new();
    out.insert("minCacheCreate".into(), num(min_cc));
    if let Some(w) = opts.window_hours {
        out.insert("windowHours".into(), num(w));
    }
    out.insert("tierSplit".into(), Value::Object(tier));
    out.insert("bigEventCount".into(), num(big_event_count));
    out.insert(
        "gapBuckets".into(),
        Value::Array(
            GAP_BUCKET_ORDER
                .iter()
                .map(|k| {
                    let (events, tokens) = buckets.get(k).copied().unwrap_or((0.0, 0.0));
                    let mut m = Map::new();
                    m.insert("bucket".into(), Value::String((*k).to_owned()));
                    m.insert("events".into(), num(events));
                    m.insert("cacheCreateTokens".into(), num(tokens));
                    Value::Object(m)
                })
                .collect(),
        ),
    );
    out.insert(
        "interpretation".into(),
        Value::Array(GAP_INTERPRETATION.iter().map(|s| Value::String((*s).to_owned())).collect()),
    );
    out.insert("coverage".into(), coverage.to_value());
    Value::Object(out)
}
