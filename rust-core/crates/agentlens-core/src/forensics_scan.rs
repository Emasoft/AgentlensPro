//! forensicsIndex SLICE B2 — the bounded scan every FAL fact row is built from (TRDD-DMWOBWFH).
//!
//! Port of `src/forensicsIndex.ts` 263-461: `refFor`, `resolveTs`, `selectRecent`,
//! `indexRequestsByPreviousMessageId` and `scanApiCallEvents`.
//!
//! It reads the COMPLETE evidence base — the raw spool UNION the Parquet store — so a call the
//! ingest drain already flushed and deleted from the spool stays indexable; the older spool-only
//! scan lost it the moment the drain ran. Every response body carrying a `usage` block is an event
//! (NOT just `cache_creation > 0`), joined to its owning session/account/model/effort/frontmatter
//! through the `previous_message_id` chain.
//!
//! Kept in its own module rather than appended to `forensics_index.rs`: that file is SLICE A, whose
//! contents are pure per-body transforms, while everything here touches the filesystem and the
//! store. The split is the same one the slicing followed.

use std::path::{Path, PathBuf};

use agentlens_store::bodies_evidence::{list_body_evidence, load_body_texts, EvidenceFilter, EvidenceRow};
use indexmap::IndexMap;
use rusqlite::Connection;
use serde_json::{Map, Value};
use sha1::{Digest, Sha1};

use crate::cache_creation_forensics::{
    ScanCoverage, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REQUEST_INDEX_CAP, RESPONSE_SCAN_CAP,
};
use crate::context_composition_index::build_call_composition;
use crate::forensics_db::{
    billable_weight, load_spawn_map, open_forensics_db, read_index_state, resolve_spawn,
    write_index_state,
};
use crate::pricing::calc_token_cost_usd;
use crate::forensics_index::{
    classify_effort, compute_frontmatter_fp, derive_content_tags, extract_injections, InjectionRow,
};
use crate::raw_body_context::parse_user_id;
use crate::summarize::helpers::num;

const EVIDENCE_LOAD_CHUNK: usize = 32;

fn str_or_undef(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn num_or0(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|f| f.is_finite()).unwrap_or(0.0)
}

/// A row from the evidence union paired with its RESOLVED capture timestamp.
struct SelectedRow {
    row: EvidenceRow,
    ts: f64,
}

/// Store-only rows may no longer exist as a file (drained once the store proved it held the bytes),
/// so `src_name` is their only stable pointer. Spool rows still exist on disk, and the absolute path
/// is a real read handle.
fn ref_for(row: &EvidenceRow, spool: Option<&Path>) -> String {
    match spool {
        Some(dir) if row.location == "spool" => dir.join(&row.src_name).to_string_lossy().into_owned(),
        _ => row.src_name.clone(),
    }
}

/// `None` = the ts is UNKNOWABLE (a spool row drained between listing and stat, with no store row in
/// this snapshot), and such a row is DROPPED by `select_recent`.
///
/// The TS records that an earlier shape fell back to `Date.now()` here and thereby FABRICATED a
/// capture timestamp: a stale call drained mid-scan was stamped "now", sorted first in recency
/// selection, and turned up inside live burn windows with wrong culprit attribution. The drain put
/// its bytes in the store, so the next pass indexes it with its TRUE capture ts — skipping one pass
/// is honest, back-dating history to the scan time is not.
fn resolve_ts(row: &EvidenceRow, spool: Option<&Path>) -> Option<f64> {
    if let Some(ts) = row.ts_ms {
        return Some(ts);
    }
    let dir = spool?;
    let md = std::fs::metadata(dir.join(&row.src_name)).ok()?;
    let mtime = md.modified().ok()?;
    let dur = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_secs_f64() * 1000.0)
}

/// Recency-first, capped selection over the evidence union. `ts_from_ms` is already pushed down to
/// the store by `list_body_evidence`'s SQL WHERE, but a spool row's ts is unresolved at list time,
/// so the window is applied HERE, after resolving its file mtime.
///
/// The TS records that an earlier shape exempted spool rows from the window entirely, on the
/// assumption that the drain keeps the spool young — false whenever the server is stopped or a file
/// repeatedly fails verify, so a `windowHours=5` scan indexed days-old calls while its coverage note
/// claimed otherwise. `matched` counts in-window rows PRE-cap, which is what makes `complete`
/// meaningful.
fn select_recent(
    rows: Vec<EvidenceRow>,
    spool: Option<&Path>,
    ts_from_ms: Option<f64>,
    cap: usize,
) -> (Vec<SelectedRow>, usize) {
    let mut with_ts: Vec<SelectedRow> = Vec::new();
    for row in rows {
        let Some(ts) = resolve_ts(&row, spool) else { continue };
        if let Some(from) = ts_from_ms {
            if ts < from {
                continue;
            }
        }
        with_ts.push(SelectedRow { row, ts });
    }
    // STABLE, matching JS's sort: equal timestamps must keep their listed order, or two calls
    // captured in the same millisecond could swap across runs and move the cap boundary.
    with_ts.sort_by(|a, b| b.ts.partial_cmp(&a.ts).unwrap_or(std::cmp::Ordering::Equal));
    let matched = with_ts.len();
    with_ts.truncate(cap);
    (with_ts, matched)
}

struct RequestLink {
    session_id: Option<String>,
    account_uuid: Option<String>,
    model: Option<String>,
    path: String,
    effort: &'static str,
    frontmatter_fp: Option<String>,
    injections: Vec<InjectionRow>,
    content_tags: Vec<Value>,
}

fn index_requests_by_previous_message_id(
    store_dir: &Path,
    spool: Option<&Path>,
    selected: &[SelectedRow],
    derive_tags: bool,
    now_ms: f64,
) -> IndexMap<String, RequestLink> {
    let mut index: IndexMap<String, RequestLink> = IndexMap::new();
    for window in selected.chunks(EVIDENCE_LOAD_CHUNK) {
        // The size bound is applied BEFORE loading, preserving readJsonBounded's semantics: a row
        // over the cap is skipped, never read — so an oversized body is never even fetched from the
        // store.
        let mut chunk: Vec<EvidenceRow> = window
            .iter()
            .filter(|c| c.row.raw_bytes <= MAX_REQUEST_BYTES as f64)
            .map(|c| c.row.clone())
            .collect();
        if chunk.is_empty() {
            continue;
        }
        let Ok(texts) = load_body_texts(store_dir, spool, &mut chunk, EVIDENCE_LOAD_CHUNK) else {
            continue;
        };
        for c in window.iter().filter(|c| c.row.raw_bytes <= MAX_REQUEST_BYTES as f64) {
            let Some(raw) = texts.get(&c.row.src_name) else { continue };
            let Ok(q) = serde_json::from_str::<Value>(raw) else { continue };
            let Some(pmid) = str_or_undef(q.pointer("/diagnostics/previous_message_id")) else {
                continue;
            };
            let uid = parse_user_id(q.pointer("/metadata/user_id").unwrap_or(&Value::Null));
            let body_ref = ref_for(&c.row, spool);
            // Tags are derived HERE, inside the chunk, so `raw` never outlives its load window. The
            // model hint is the request's own model and the ts is the request row's capture ts — the
            // joined response's values differ at most cosmetically, and neither is load-bearing for
            // tag shape.
            let content_tags: Vec<Value> = if derive_tags {
                build_call_composition(
                    &body_ref,
                    0.0,
                    c.ts,
                    None,
                    None,
                    q.get("model").and_then(Value::as_str),
                    Some(raw),
                    now_ms,
                )
                .map(|comp| derive_content_tags(&comp))
                .unwrap_or_default()
            } else {
                Vec::new()
            };
            index.insert(
                pmid,
                RequestLink {
                    session_id: uid.session_id,
                    account_uuid: uid.account_uuid,
                    model: str_or_undef(q.get("model")),
                    path: body_ref,
                    effort: classify_effort(q.pointer("/thinking/budget_tokens").and_then(Value::as_f64)),
                    frontmatter_fp: compute_frontmatter_fp(&q),
                    injections: extract_injections(&q),
                    content_tags,
                },
            );
        }
    }
    index
}

/// One scanned API call. Field order below is the TS push order, and `to_value` preserves it —
/// the parity oracle compares key ORDER as well as content.
pub struct ApiCallEvent {
    pub call_id: String,
    pub response_ref: String,
    pub request_ref: Option<String>,
    pub request_content_tags: Option<Vec<Value>>,
    pub ts: f64,
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub model: Option<String>,
    pub effort: String,
    pub frontmatter_fp: Option<String>,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_creation_tokens: f64,
    pub tier_5m_tokens: f64,
    pub tier_1h_tokens: f64,
    pub injections: Vec<InjectionRow>,
    pub attributed: bool,
}

impl ApiCallEvent {
    /// An absent optional is OMITTED, never emitted as null: `JSON.stringify` drops an `undefined`
    /// property, so a port that wrote null would differ from the oracle on every unattributed call.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("callId".into(), Value::String(self.call_id.clone()));
        m.insert("responseRef".into(), Value::String(self.response_ref.clone()));
        if let Some(v) = &self.request_ref {
            m.insert("requestRef".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.request_content_tags {
            m.insert("requestContentTags".into(), Value::Array(v.clone()));
        }
        m.insert("ts".into(), num(self.ts));
        if let Some(v) = &self.session_id {
            m.insert("sessionId".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.account_uuid {
            m.insert("accountUuid".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.model {
            m.insert("model".into(), Value::String(v.clone()));
        }
        m.insert("effort".into(), Value::String(self.effort.clone()));
        if let Some(v) = &self.frontmatter_fp {
            m.insert("frontmatterFp".into(), Value::String(v.clone()));
        }
        m.insert("inputTokens".into(), num(self.input_tokens));
        m.insert("outputTokens".into(), num(self.output_tokens));
        m.insert("cacheReadTokens".into(), num(self.cache_read_tokens));
        m.insert("cacheCreationTokens".into(), num(self.cache_creation_tokens));
        m.insert("tier5mTokens".into(), num(self.tier_5m_tokens));
        m.insert("tier1hTokens".into(), num(self.tier_1h_tokens));
        m.insert(
            "injections".into(),
            Value::Array(self.injections.iter().map(InjectionRow::to_value).collect()),
        );
        m.insert("attributed".into(), Value::Bool(self.attributed));
        Value::Object(m)
    }
}

// ── SLICE B4: the indexer (TS 553-701) ──────────────────────────────────────────

const AC_INSERT_SQL: &str = "INSERT OR REPLACE INTO api_calls (
  call_id, response_ref, request_ref, ts,
  session_id, account_uuid, model, effort,
  spawn_kind, subagent_type, spawn_model_override, spawn_isolation, is_sidechain, parent_session, spawn_resolution,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens,
  break_cause, culprit_fingerprint, gap_minutes, frontmatter_fp, cost_usd, billable_weight, indexed_at
) VALUES (
  ?1, ?2, ?3, ?4,
  ?5, ?6, ?7, ?8,
  ?9, ?10, ?11, ?12, ?13, ?14, ?15,
  ?16, ?17, ?18, ?19, ?20, ?21,
  ?22, ?23, ?24, ?25, ?26, ?27, ?28
)";

pub struct IndexApiCallsResult {
    pub inserted: usize,
    pub coverage: ScanCoverage,
    pub high_water_ms: f64,
}

/// Index the bounded slice of API-call facts into forensics.db. Idempotent: keyed on call_id via
/// INSERT OR REPLACE, so re-running is safe and a previously-unresolved spawn is re-resolved once
/// the sessions table catches up.
///
/// `break_cause` / `culprit_fingerprint` / `gap_minutes` stay NULL until the optional
/// cacheBreakTimeline dependency lands — the TS says the same, and writing a placeholder would make
/// an absent analysis look like a computed one.
pub fn index_api_calls(
    conn: &mut Connection,
    opts: &ScanApiCallOptions,
    main_db_path: &Path,
    with_injections: bool,
    now_ms: f64,
) -> Result<IndexApiCallsResult, rusqlite::Error> {
    let (events, coverage) = scan_api_call_events(opts, now_ms);
    let spawn_map = load_spawn_map(main_db_path);
    let mut high_water = 0.0_f64;
    let mut inserted = 0usize;

    // One transaction for the whole batch: a partially-indexed DB whose index_state claims a
    // completed run is worse than no run, because the freshness gate would then skip the repair.
    let tx = conn.transaction()?;
    for ev in &events {
        let spawn = resolve_spawn(ev.session_id.as_deref(), &spawn_map);
        let model = ev.model.as_deref();
        let cost_usd = match model {
            // The TS calls the 5-ARG calcTokenCostUsd, whose trailing 1h argument defaults to 0.
            Some(m) => calc_token_cost_usd(
                ev.input_tokens,
                ev.cache_read_tokens,
                ev.cache_creation_tokens,
                ev.output_tokens,
                m,
                0.0,
                None,
                now_ms,
            ),
            None => 0.0,
        };
        // A response can carry a FLAT cache_creation total with no tier sub-object, leaving both
        // tiers 0. Attribute that flat total to the 5-minute tier for the WEIGHT only, so the
        // priciest bucket is counted instead of dropped — otherwise billable_weight disagrees with
        // cost_usd (which already uses the flat total) and every "worst config" ranking undercounts
        // cache-write-heavy configs. The STORED tier_5m_tokens column below is left as-is: only the
        // weight computation sees the synthesized value.
        let weight_tier_5m = if ev.tier_5m_tokens == 0.0 && ev.tier_1h_tokens == 0.0 && ev.cache_creation_tokens > 0.0 {
            ev.cache_creation_tokens
        } else {
            ev.tier_5m_tokens
        };
        let weight = billable_weight(
            weight_tier_5m,
            ev.tier_1h_tokens,
            ev.cache_read_tokens,
            ev.output_tokens,
            ev.input_tokens,
            model,
            now_ms,
        );
        tx.execute(
            AC_INSERT_SQL,
            rusqlite::params![
                ev.call_id,
                ev.response_ref,
                ev.request_ref,
                ev.ts,
                ev.session_id,
                ev.account_uuid,
                model,
                ev.effort,
                spawn.spawn_kind,
                spawn.subagent_type,
                spawn.spawn_model_override,
                spawn.spawn_isolation,
                spawn.is_sidechain,
                spawn.parent_session,
                spawn.spawn_resolution,
                ev.input_tokens,
                ev.output_tokens,
                ev.cache_read_tokens,
                ev.cache_creation_tokens,
                ev.tier_5m_tokens,
                ev.tier_1h_tokens,
                Option::<String>::None, // break_cause
                Option::<String>::None, // culprit_fingerprint
                Option::<f64>::None,    // gap_minutes
                ev.frontmatter_fp,
                cost_usd,
                weight,
                now_ms,
            ],
        )?;
        // Manual cascade. Under rusqlite `PRAGMA foreign_keys = ON` genuinely fires ON DELETE
        // CASCADE, but the parent is REPLACED rather than deleted here, so the children of the old
        // row would survive on their own: clearing them first is what makes a re-index leave no
        // stale content/injection rows.
        if with_injections {
            tx.execute("DELETE FROM call_injections WHERE call_id = ?1", [&ev.call_id])?;
            for r in &ev.injections {
                tx.execute(
                    "INSERT OR REPLACE INTO call_injections (call_id, kind, name, tokens) VALUES (?1, ?2, ?3, ?4)",
                    // A literal 0: the TS InjectionRow.tokens is invariantly 0 (a per-injection
                    // split cannot be attributed out of one shared system block, and a fabricated
                    // one would rank on itself), and the Rust struct omits the field entirely.
                    rusqlite::params![ev.call_id, r.kind, r.name, 0],
                )?;
            }
        }
        if opts.with_content {
            tx.execute("DELETE FROM call_content WHERE call_id = ?1", [&ev.call_id])?;
            for t in ev.request_content_tags.as_deref().unwrap_or(&[]) {
                tx.execute(
                    "INSERT OR REPLACE INTO call_content (call_id, tag, tokens, count) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        ev.call_id,
                        t.get("tag").and_then(Value::as_str).unwrap_or(""),
                        num_or0(t.get("tokens")),
                        num_or0(t.get("count")),
                    ],
                )?;
            }
        }
        inserted += 1;
        if ev.ts > high_water {
            high_water = ev.ts;
        }
    }
    tx.commit()?;

    // The high-water mark advances MONOTONICALLY toward the present: a prior deeper run is never
    // rolled back by a later shallower one.
    let prev_hw = read_index_state(conn, "high_water_mtime_ms")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    let new_hw = prev_hw.max(high_water);
    write_index_state(conn, "high_water_mtime_ms", &js_num(new_hw))?;
    write_index_state(conn, "last_run_ms", &js_num(now_ms))?;
    write_index_state(conn, "responses_indexed", &coverage.response_files_scanned.to_string())?;
    write_index_state(conn, "responses_total", &coverage.response_files_total.to_string())?;
    write_index_state(conn, "coverage_note", &coverage.note)?;

    Ok(IndexApiCallsResult { inserted, coverage, high_water_ms: new_hw })
}

/// `String(n)` for a value the TS holds as a JS number — an integral f64 must render as "17", never
/// "17.0", or the stored index_state string differs from the TS's and a later parse round-trips to a
/// different literal.
fn js_num(v: f64) -> String {
    crate::summarize::helpers::js_string(&num(v))
}

/// Re-index only when the fact DB is missing or its last run is older than `max_age_ms` (default 5
/// minutes in the TS). This is what the MCP tools call before answering: the first query pays the
/// index cost and later queries inside the freshness window reuse the cached facts.
pub fn ensure_fresh_index(
    db_path: &Path,
    opts: &ScanApiCallOptions,
    main_db_path: &Path,
    with_injections: bool,
    max_age_ms: f64,
    force: bool,
    now_ms: f64,
) -> Result<Option<IndexApiCallsResult>, rusqlite::Error> {
    if !force && db_path.exists() {
        let probe = open_forensics_db(db_path, now_ms)?;
        let last = read_index_state(&probe, "last_run_ms")
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        drop(probe);
        // `last > 0` matters: a DB that exists but has never completed a run must NOT be treated as
        // fresh, or a failed first index would be cached as success for the whole window.
        if last > 0.0 && now_ms - last < max_age_ms {
            return Ok(None);
        }
    }
    let mut conn = open_forensics_db(db_path, now_ms)?;
    index_api_calls(&mut conn, opts, main_db_path, with_injections, now_ms).map(Some)
}

pub struct ScanApiCallOptions {
    pub bodies_dir: PathBuf,
    pub store_dir: PathBuf,
    pub window_hours: Option<f64>,
    pub scan_cap: usize,
    /// Derive call_content tags during the join pass — the only moment the request text is in
    /// memory. Default on in the TS; the caller passes it explicitly here.
    pub with_content: bool,
}

impl ScanApiCallOptions {
    pub fn new(bodies_dir: PathBuf, store_dir: PathBuf) -> Self {
        Self { bodies_dir, store_dir, window_hours: None, scan_cap: RESPONSE_SCAN_CAP, with_content: true }
    }
}

pub fn scan_api_call_events(opts: &ScanApiCallOptions, now_ms: f64) -> (Vec<ApiCallEvent>, ScanCoverage) {
    let bodies_dir = opts.bodies_dir.as_path();
    let spool: Option<&Path> = if bodies_dir.exists() { Some(bodies_dir) } else { None };
    // The spool alone no longer decides whether evidence exists — drained history lives in the
    // Parquet store, so a missing spool with a populated store is a NORMAL state, not "no data".
    let store_exists = opts.store_dir.join("bodies").exists();
    if spool.is_none() && !store_exists {
        return (
            Vec::new(),
            ScanCoverage {
                bodies_dir: bodies_dir.to_string_lossy().into_owned(),
                dir_exists: false,
                response_files_total: 0,
                response_files_scanned: 0,
                request_files_total: 0,
                request_files_indexed: 0,
                scan_cap: opts.scan_cap,
                window_hours: opts.window_hours,
                complete: true,
                note: format!(
                    "No raw-body evidence: neither {} nor the Parquet store at {} exists — set OTEL_LOG_RAW_API_BODIES to capture bodies.",
                    bodies_dir.display(),
                    opts.store_dir.display()
                ),
            },
        );
    }

    // `windowHours !== undefined && windowHours > 0` — a 0 or negative window means NO window, not
    // an empty one.
    let ts_from_ms = opts
        .window_hours
        .filter(|h| *h > 0.0)
        .map(|h| now_ms - h * 3_600_000.0);

    let filt = |kind: &str| EvidenceFilter {
        kind: Some(kind.to_owned()),
        ts_from_ms,
        ..Default::default()
    };
    let resp_all = list_body_evidence(&opts.store_dir, spool, &filt("response")).unwrap_or_default();
    let req_all = list_body_evidence(&opts.store_dir, spool, &filt("request")).unwrap_or_default();
    let resp_total = resp_all.len();
    let req_total = req_all.len();

    let (resp_selected, response_matched) = select_recent(resp_all, spool, ts_from_ms, opts.scan_cap);
    let (req_selected, _) = select_recent(req_all, spool, ts_from_ms, REQUEST_INDEX_CAP);

    let prev_index = index_requests_by_previous_message_id(
        &opts.store_dir,
        spool,
        &req_selected,
        opts.with_content,
        now_ms,
    );

    let mut events: Vec<ApiCallEvent> = Vec::new();
    for window in resp_selected.chunks(EVIDENCE_LOAD_CHUNK) {
        let mut chunk: Vec<EvidenceRow> = window
            .iter()
            .filter(|c| c.row.raw_bytes <= MAX_RESPONSE_BYTES as f64)
            .map(|c| c.row.clone())
            .collect();
        if chunk.is_empty() {
            continue;
        }
        let Ok(texts) = load_body_texts(&opts.store_dir, spool, &mut chunk, EVIDENCE_LOAD_CHUNK) else {
            continue;
        };
        for c in window.iter().filter(|c| c.row.raw_bytes <= MAX_RESPONSE_BYTES as f64) {
            let Some(raw) = texts.get(&c.row.src_name) else { continue };
            let Ok(body) = serde_json::from_str::<Value>(raw) else { continue };
            let Some(usage) = body.get("usage").filter(|u| !u.is_null()) else { continue };
            let response_id = str_or_undef(body.get("id"));
            let link = response_id.as_ref().and_then(|id| prev_index.get(id));
            let model = link
                .and_then(|l| l.model.clone())
                .or_else(|| str_or_undef(body.get("model")))
                .or_else(|| str_or_undef(body.pointer("/message/model")));
            let tier = usage.get("cache_creation");
            let body_ref = ref_for(&c.row, spool);
            // call_id is the response id (msg_…) when present, else a stable sha1 of the row's
            // SRC_NAME — never of `ref`, which is LOCATION-DEPENDENT (an absolute spool path before
            // the drain, a bare src_name after). The TS records that hashing `ref` gave one physical
            // call two different primary keys across a drain, so INSERT OR REPLACE kept both rows
            // and every aggregate double-counted its tokens and dollars. src_name survives the
            // spool→store move unchanged.
            let call_id = response_id.clone().unwrap_or_else(|| {
                let mut h = Sha1::new();
                h.update(c.row.src_name.as_bytes());
                format!("sha1:{:x}", h.finalize())
            });
            events.push(ApiCallEvent {
                call_id,
                response_ref: body_ref,
                request_ref: link.map(|l| l.path.clone()),
                request_content_tags: link.map(|l| l.content_tags.clone()),
                ts: c.ts,
                session_id: link.and_then(|l| l.session_id.clone()),
                account_uuid: link.and_then(|l| l.account_uuid.clone()),
                model,
                effort: link.map_or("none", |l| l.effort).to_owned(),
                frontmatter_fp: link.and_then(|l| l.frontmatter_fp.clone()),
                input_tokens: num_or0(usage.get("input_tokens")),
                output_tokens: num_or0(usage.get("output_tokens")),
                cache_read_tokens: num_or0(usage.get("cache_read_input_tokens")),
                cache_creation_tokens: num_or0(usage.get("cache_creation_input_tokens")),
                tier_5m_tokens: num_or0(tier.and_then(|t| t.get("ephemeral_5m_input_tokens"))),
                tier_1h_tokens: num_or0(tier.and_then(|t| t.get("ephemeral_1h_input_tokens"))),
                injections: link.map(|l| l.injections.clone()).unwrap_or_default(),
                attributed: link.is_some(),
            });
        }
    }

    let scanned = resp_selected.len();
    let complete = scanned == response_matched;
    let from_store = resp_selected.iter().filter(|c| c.row.location == "store").count();
    let note = if complete {
        // `opts.windowHours ? ...` is a TRUTHY test in the TS, so a window of 0 prints no suffix.
        let window_txt = match opts.window_hours {
            Some(h) if h != 0.0 => format!(
                " in the last {}h",
                crate::summarize::helpers::js_string(&num(h))
            ),
            _ => String::new(),
        };
        format!(
            "Scanned all {response_matched} response body(ies){window_txt} — {from_store} from the Parquet store, {} from the raw spool (drained history stays in evidence).",
            scanned - from_store
        )
    } else {
        format!(
            "SAMPLE: {scanned} most-recent of {response_matched} matching response body(ies) (cap {}; {from_store} store / {} spool). Not full history.",
            opts.scan_cap,
            scanned - from_store
        )
    };

    (
        events,
        ScanCoverage {
            bodies_dir: bodies_dir.to_string_lossy().into_owned(),
            dir_exists: spool.is_some(),
            response_files_total: resp_total,
            response_files_scanned: scanned,
            request_files_total: req_total,
            request_files_indexed: req_selected.len(),
            scan_cap: opts.scan_cap,
            window_hours: opts.window_hours,
            complete,
            note,
        },
    )
}
