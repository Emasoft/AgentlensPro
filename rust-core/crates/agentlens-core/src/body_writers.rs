//! Port of src/bodyWriters.ts (TRDD-1FEIW17E, ported under TRDD-DMWOBWFH P4x.2d) —
//! `get_body_writers`: identify and rank the sessions writing raw OTEL bodies.
//!
//! A Claude session keeps its launch-time `OTEL_LOG_RAW_API_BODIES` env until restarted, so a stale
//! session keeps writing ~0.7–1.9MB request bodies per LLM call. This answers WHICH sessions, at
//! what rate, and how much total — so the user restarts exactly the right terminals.
//!
//! Attribution unit = the REQUEST body: its tail carries `metadata.user_id` (escaped JSON with
//! session_id) reachable by the same bounded 6KB read `bodies_activity` already uses. Response
//! bodies carry NO session metadata and requests dominate bytes by ~an order of magnitude (each
//! re-serializes the whole conversation) — so responses are reported IN AGGREGATE, never guessed.
//!
//! NOT PORTED: `queryStoreWriterTotals`. The durable DuckDB store is not held by the Rust server,
//! so the route passes `store: None` and this takes the TS's OWN store-unavailable branch — totals
//! cover the live dir only, and the `note` says so in the payload. A visible degradation, not a
//! silent one; when the store lands here, `StoreWriterTotals` is the shape to fill in.

use std::collections::HashSet;
use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::{fmt_js_num, js_math_round, js_to_fixed_str, num};

const MB: f64 = 1e6;

#[derive(Clone, Debug)]
pub struct FileRef {
    pub name: String,
    pub bytes: f64,
}

#[derive(Clone, Debug)]
pub struct LiveSessionAgg {
    pub session_id: Option<String>,
    /// name+bytes kept per file so the merge can subtract already-ingested files EXACTLY.
    pub files: Vec<FileRef>,
    pub bytes: f64,
    pub recent_files: f64,
    pub recent_bytes: f64,
    pub first_ms: f64,
    pub last_ms: f64,
    /// Model of the most recent attributed request — what the session is running NOW.
    pub model: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ResponsesAgg {
    pub files: Vec<FileRef>,
    pub bytes: f64,
    pub recent_bytes: f64,
    pub last_ms: f64,
}

#[derive(Clone, Debug)]
pub struct LiveBodiesScan {
    pub available: bool,
    pub dir: String,
    pub scanned_files: f64,
    pub sessions: Vec<LiveSessionAgg>,
    pub responses: ResponsesAgg,
}

/// All-time per-session totals from the durable store (requests only — see the module header).
/// The QUERY is not ported; this is the shape the route will hand in once it is.
#[derive(Clone, Debug, Default)]
pub struct StoreWriterTotals {
    pub sessions: Vec<StoreSession>,
    pub response_files: f64,
    pub response_bytes: f64,
    /// src_names ingested recently — the exact overlap set with the live dir.
    pub recent_src_names: HashSet<String>,
}

#[derive(Clone, Debug)]
pub struct StoreSession {
    pub session_id: Option<String>,
    pub files: f64,
    pub bytes: f64,
    pub last_ms: f64,
    pub model: Option<String>,
}

/// One full pass over the live bodies dir. A one-shot diagnostic, not a hot-path poll: stat every
/// file, bounded-read every request.
///
/// The directory walk is SORTED, unlike the TS's raw `readdirSync`. Node's order is
/// filesystem-dependent and therefore not reproducible across machines, so there is no "correct"
/// order to match — it is observable only in the same-rate tie order of the final ranking, and a
/// sorted walk is the only version of that which is stable. The parity fixture is built without
/// rate ties so the two agree regardless.
pub fn scan_live_body_writers(dir: &Path, now_ms: f64, window_ms: f64) -> LiveBodiesScan {
    let dir_str = dir.to_string_lossy().into_owned();
    let Ok(entries) = std::fs::read_dir(dir) else {
        // Dir absent (fresh install / capture off) — report available:false, never throw.
        return LiveBodiesScan {
            available: false,
            dir: dir_str,
            scanned_files: 0.0,
            sessions: Vec::new(),
            responses: ResponsesAgg::default(),
        };
    };
    let mut names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();

    let mut by_session: IndexMap<Option<String>, LiveSessionAgg> = IndexMap::new();
    let mut responses = ResponsesAgg::default();
    let recent_floor = now_ms - window_ms;
    let mut scanned = 0.0_f64;
    let mut latest_model_t: IndexMap<Option<String>, f64> = IndexMap::new();

    for name in names {
        let is_req = name.ends_with(".request.json");
        let is_resp = name.ends_with(".response.json");
        if !is_req && !is_resp {
            continue;
        }
        let path = dir.join(&name);
        let Ok(meta) = std::fs::metadata(&path) else { continue }; // raced with the reclaim pass
        let size = meta.len() as f64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        scanned += 1.0;
        if is_resp {
            responses.files.push(FileRef { name, bytes: size });
            responses.bytes += size;
            if mtime >= recent_floor {
                responses.recent_bytes += size;
            }
            if mtime > responses.last_ms {
                responses.last_ms = mtime;
            }
            continue;
        }
        let (session_id, model, _prev) = crate::burn::bodies_activity::extract_request_attribution(&path, meta.len());
        let agg = by_session.entry(session_id.clone()).or_insert_with(|| LiveSessionAgg {
            session_id: session_id.clone(),
            files: Vec::new(),
            bytes: 0.0,
            recent_files: 0.0,
            recent_bytes: 0.0,
            first_ms: mtime,
            last_ms: 0.0,
            model: None,
        });
        agg.files.push(FileRef { name, bytes: size });
        agg.bytes += size;
        if mtime < agg.first_ms {
            agg.first_ms = mtime;
        }
        if mtime > agg.last_ms {
            agg.last_ms = mtime;
        }
        if mtime >= recent_floor {
            agg.recent_files += 1.0;
            agg.recent_bytes += size;
        }
        // `>=` not `>`: at equal mtimes the LAST file scanned wins, which is what makes the model
        // "what the session runs NOW" rather than whichever file the walk happened to reach first.
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            if mtime >= latest_model_t.get(&session_id).copied().unwrap_or(0.0) {
                agg.model = Some(m);
                latest_model_t.insert(session_id.clone(), mtime);
            }
        }
    }
    LiveBodiesScan {
        available: true,
        dir: dir_str,
        scanned_files: scanned,
        sessions: by_session.into_values().collect(),
        responses,
    }
}

fn fmt_bytes(n: f64) -> String {
    if n >= 1e9 {
        return format!("{}GB", js_to_fixed_str(n / 1e9, 2));
    }
    if n >= MB {
        return format!("{}MB", js_to_fixed_str(n / MB, 1));
    }
    format!("{}KB", js_to_fixed_str(n / 1e3, 0))
}

struct Row {
    session_id: Option<String>,
    workspace: Option<String>,
    source: Option<String>,
    model: Option<String>,
    active: bool,
    last_write_ms: Option<f64>,
    recent_files: f64,
    recent_bytes: f64,
    rate_mb_min: f64,
    live_files: f64,
    live_bytes: f64,
    store_files: f64,
    store_bytes: f64,
    total_bytes: f64,
}

fn row_value(r: &Row) -> Value {
    let opt = |x: &Option<String>| x.clone().map(Value::from).unwrap_or(Value::Null);
    let mut m = Map::new();
    m.insert("sessionId".into(), opt(&r.session_id));
    m.insert("workspace".into(), opt(&r.workspace));
    m.insert("source".into(), opt(&r.source));
    m.insert("model".into(), opt(&r.model));
    m.insert("active".into(), Value::Bool(r.active));
    m.insert("lastWriteMs".into(), r.last_write_ms.map(num).unwrap_or(Value::Null));
    m.insert("recentFiles".into(), num(r.recent_files));
    m.insert("recentBytes".into(), num(r.recent_bytes));
    m.insert("rateMBmin".into(), num(r.rate_mb_min));
    m.insert("liveFiles".into(), num(r.live_files));
    m.insert("liveBytes".into(), num(r.live_bytes));
    m.insert("storeFiles".into(), num(r.store_files));
    m.insert("storeBytes".into(), num(r.store_bytes));
    m.insert("totalBytes".into(), num(r.total_bytes));
    Value::Object(m)
}

pub struct BodyWritersOpts<'a> {
    pub live: &'a LiveBodiesScan,
    pub store: Option<&'a StoreWriterTotals>,
    pub cards: &'a [Value],
    pub now_ms: f64,
    pub window_ms: f64,
    pub active_ms: f64,
    pub limit: f64,
    /// `process.env.HOME ?? ''`, injected so the rendered table is reproducible.
    pub home: &'a str,
}

pub fn build_body_writers_report(o: &BodyWritersOpts<'_>) -> Value {
    let window_min = js_math_round(o.window_ms / 60_000.0);
    let active_min = js_math_round(o.active_ms / 60_000.0);
    let mut card_by: IndexMap<&str, &Value> = IndexMap::new();
    for c in o.cards {
        card_by.insert(c.get("sessionId").and_then(Value::as_str).unwrap_or(""), c);
    }
    let blank = |session_id: Option<String>| -> Row {
        // `sessionId ? cardBy.get(...)... : null` is TRUTHY, so the unattributed bucket (null id)
        // never inherits a card — and neither would an empty-string id.
        let card = session_id.as_deref().filter(|s| !s.is_empty()).and_then(|s| card_by.get(s).copied());
        Row {
            workspace: card.and_then(|c| c.get("workspace").and_then(Value::as_str)).map(str::to_owned),
            source: card.and_then(|c| c.get("source").and_then(Value::as_str)).map(str::to_owned),
            session_id,
            model: None,
            active: false,
            last_write_ms: None,
            recent_files: 0.0,
            recent_bytes: 0.0,
            rate_mb_min: 0.0,
            live_files: 0.0,
            live_bytes: 0.0,
            store_files: 0.0,
            store_bytes: 0.0,
            total_bytes: 0.0,
        }
    };

    let mut rows: IndexMap<Option<String>, Row> = IndexMap::new();
    for s in o.store.map(|s| s.sessions.as_slice()).unwrap_or(&[]) {
        let mut r = blank(s.session_id.clone());
        r.store_files = s.files;
        r.store_bytes = s.bytes;
        r.total_bytes = s.bytes;
        r.last_write_ms = Some(s.last_ms);
        r.model = s.model.clone();
        rows.insert(s.session_id.clone(), r);
    }
    for agg in &o.live.sessions {
        let r = rows.entry(agg.session_id.clone()).or_insert_with(|| blank(agg.session_id.clone()));
        r.live_files = agg.files.len() as f64;
        r.live_bytes = agg.bytes;
        r.recent_files = agg.recent_files;
        r.recent_bytes = agg.recent_bytes;
        r.rate_mb_min = agg.recent_bytes / MB / (o.window_ms / 60_000.0);
        r.active = agg.last_ms >= o.now_ms - o.active_ms;
        if r.last_write_ms.is_none_or(|l| agg.last_ms > l) {
            r.last_write_ms = Some(agg.last_ms);
        }
        // Live beats store: it is what the session runs NOW.
        if let Some(m) = agg.model.as_deref().filter(|m| !m.is_empty()) {
            r.model = Some(m.to_owned());
        }
        // EXACT union: only live files the store has NOT ingested add to the total. Without a store
        // (down/absent) the live bytes ARE the only known total — double-counting them against an
        // already-ingested history is the failure this subtraction exists to prevent.
        let not_ingested: f64 = match o.store {
            Some(st) => agg.files.iter().filter(|f| !st.recent_src_names.contains(&f.name)).map(|f| f.bytes).sum(),
            None => agg.files.iter().map(|f| f.bytes).sum(),
        };
        r.total_bytes += not_ingested;
    }

    let total_writers = rows.len();
    let mut ranked: Vec<Row> = rows.into_values().collect();
    ranked.sort_by(|a, b| {
        let d = b.rate_mb_min - a.rate_mb_min;
        if d != 0.0 && !d.is_nan() {
            return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        (b.total_bytes - a.total_bytes).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    ranked.truncate(o.limit.max(1.0) as usize);

    let resp_live_not_ingested: f64 = match o.store {
        Some(st) => o.live.responses.files.iter().filter(|f| !st.recent_src_names.contains(&f.name)).map(|f| f.bytes).sum(),
        None => o.live.responses.bytes,
    };
    let store_resp_files = o.store.map_or(0.0, |s| s.response_files);
    let store_resp_bytes = o.store.map_or(0.0, |s| s.response_bytes);
    let mut responses = Map::new();
    responses.insert("liveFiles".into(), num(o.live.responses.files.len() as f64));
    responses.insert("liveBytes".into(), num(o.live.responses.bytes));
    responses.insert("storeFiles".into(), num(store_resp_files));
    responses.insert("storeBytes".into(), num(store_resp_bytes));
    let responses_total = store_resp_bytes + resp_live_not_ingested;
    responses.insert("totalBytes".into(), num(responses_total));

    let note = format!(
        "{}Attribution unit = request bodies (responses carry no session metadata and are aggregated below). active = wrote a request within {}m — that session's process still captures raw bodies until restarted.",
        if o.store.is_some() {
            "totals = ingested store history + not-yet-ingested live files (exact union). "
        } else {
            "STORE UNAVAILABLE — totals cover only the live dir (≤72h retained). "
        },
        fmt_js_num(active_min)
    );

    let mut lines = vec![format!(
        "raw-body writers — rate over last {}m, ranked by rate then total ({} writer(s), showing {})",
        fmt_js_num(window_min),
        total_writers,
        ranked.len()
    )];
    for w in &ranked {
        let act = if w.active { "●ACTIVE" } else { "       " };
        let sid = w
            .session_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or("unattributed".to_owned(), |s| format!("{}…", s.chars().take(8).collect::<String>()));
        let ws = match w.workspace.as_deref() {
            None => "?".to_owned(),
            Some(x) if !o.home.is_empty() && x.starts_with(o.home) => format!("~{}", &x[o.home.len()..]),
            Some(x) => x.to_owned(),
        };
        // `w.lastWriteMs ?` is TRUTHY — a lastWriteMs of exactly 0 renders "never", not "…m ago".
        let last = match w.last_write_ms {
            Some(l) if l != 0.0 => format!("{}m ago", fmt_js_num(js_math_round((o.now_ms - l) / 60_000.0))),
            _ => "never".to_owned(),
        };
        lines.push(format!(
            "{} {}  {}MB/min  recent {}/{}  total {}/{}  last {}  {}  {}",
            act,
            sid,
            js_to_fixed_str(w.rate_mb_min, 2),
            fmt_bytes(w.recent_bytes),
            fmt_js_num(w.recent_files),
            fmt_bytes(w.total_bytes),
            fmt_js_num(w.store_files + w.live_files),
            last,
            w.model.as_deref().unwrap_or("?"),
            ws
        ));
    }
    lines.push(format!(
        "responses (unattributable by design): live {}/{}, total {}",
        fmt_bytes(o.live.responses.bytes),
        o.live.responses.files.len(),
        fmt_bytes(responses_total)
    ));
    lines.push(note.clone());

    let mut m = Map::new();
    m.insert("available".into(), Value::Bool(o.live.available || o.store.is_some()));
    m.insert("dir".into(), Value::String(o.live.dir.clone()));
    m.insert("scannedFiles".into(), num(o.live.scanned_files));
    m.insert("windowMin".into(), num(window_min));
    m.insert("activeMin".into(), num(active_min));
    m.insert("writers".into(), Value::Array(ranked.iter().map(row_value).collect()));
    m.insert("totalWriters".into(), num(total_writers as f64));
    m.insert("responses".into(), Value::Object(responses));
    m.insert("note".into(), Value::String(note));
    m.insert("text".into(), Value::String(lines.join("\n")));
    Value::Object(m)
}
