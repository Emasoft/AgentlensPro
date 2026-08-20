//! Port of src/cacheEventLog.ts — `get_cache_event_log`: the per-call CACHE LEDGER for ONE project
//! (TRDD-DMWOBWFH P4x.2d).
//!
//! PROJECT SCOPING IS A HARD BOUNDARY, NOT A FILTER. This machine runs many concurrent sessions
//! across many projects and their calls interleave in ONE shared bodies directory. Rows are emitted
//! only for sessions this project owns, resolved through the authoritative on-disk fact
//! `~/.claude/projects/<project-slug>/<sessionId>.jsonl`. A call that cannot be PROVEN to belong
//! here is COUNTED in `excluded` and never printed — showing another project's traffic would be a
//! privacy break, not a cosmetic bug, so the default is exclusion and the exclusions are disclosed.
//!
//! SOURCE = the raw OTEL bodies / span store, NEVER the session transcript: a compaction's own
//! summarization request is a real API call the `.jsonl` does not record, so read from there a
//! compaction looks free.
//!
//! ONE TS dependency is deliberately NOT ported, and it changes no answer: `otelCallIndex`'s
//! per-day SIDECAR CACHE. That layer exists to avoid re-walking the whole span store in
//! single-core TS — and the TS itself bypasses it entirely ("no sidecars") the moment the Rust
//! engine is opted in, answering the window with one multi-core scan. Here that scan IS the
//! engine (`agentlens_spanstore::scan_call_events`), so porting the cache would add a second,
//! staler copy of a result the direct scan already produces in about a second.

use std::path::{Path, PathBuf};

use chrono::TimeZone;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::cache_creation_forensics::{
    read_json_bounded, scan_cache_creation_events, CacheCreationEvent, ScanOptions, MAX_RESPONSE_BYTES,
};
use crate::pricing::{calc_token_cost_usd, lookup_rates};
use crate::summarize::helpers::{iso_from_ms, js_math_round, js_to_fixed_num, js_to_fixed_str, num, to_locale_en};

pub const WRITE_SCALE_EMOJI: &str = "🔥";

/// Cache-write size → a 1..5 marker. The steps are ~3-4x apart, so the marker tracks ORDERS OF
/// MAGNITUDE rather than linear size: a 400k full-prefix rewrite must not look like a 12k suffix
/// write, and on a linear scale it would.
pub const WRITE_SCALE_THRESHOLDS: [f64; 5] = [1.0, 10_000.0, 50_000.0, 150_000.0, 400_000.0];

pub fn write_scale_of(cache_write_tokens: f64) -> usize {
    WRITE_SCALE_THRESHOLDS.iter().filter(|t| cache_write_tokens >= **t).count()
}

const DEFAULT_CONTEXT_EVENTS: f64 = 3.0;
const MAX_CONTEXT_EVENTS: f64 = 25.0;
const DEFAULT_RECENT_LIMIT: f64 = 12.0;
const MAX_RECENT_LIMIT: f64 = 200.0;

/// How the ledger renders wall-clock time. The TS reads the MACHINE's zone
/// (`toLocaleTimeString` + `Intl.DateTimeFormat().resolvedOptions().timeZone`); the engine takes it
/// as a PARAMETER instead, because a parity fixture generated in one zone and asserted in another
/// is not a fixture — it is a different expected file on every machine.
#[derive(Clone, Debug)]
pub enum DisplayZone {
    /// The machine's own zone, resolved PER TIMESTAMP so a window spanning a DST change renders
    /// each side correctly — what the server uses.
    System { name: String },
    /// A pinned constant offset — what the parity oracle uses.
    Fixed { name: String, offset_secs: i32 },
}

impl DisplayZone {
    pub fn system() -> Self {
        Self::System { name: iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_owned()) }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::System { name } | Self::Fixed { name, .. } => name,
        }
    }

    /// `toLocaleTimeString('en-GB', { hour12: false })` — zero-padded 24-hour HH:MM:SS.
    fn local_time(&self, ts_ms: f64) -> String {
        let ms = ts_ms as i64;
        match self {
            Self::System { .. } => {
                chrono::Local.timestamp_millis_opt(ms).single().map(|t| t.format("%H:%M:%S").to_string())
            }
            Self::Fixed { offset_secs, .. } => chrono::FixedOffset::east_opt(*offset_secs)
                .and_then(|o| o.timestamp_millis_opt(ms).single())
                .map(|t| t.format("%H:%M:%S").to_string()),
        }
        // An unrepresentable instant is the JS `new Date(NaN)` case, which cannot arise from a
        // file mtime or an OTEL ts — an empty cell is the honest rendering if it ever does.
        .unwrap_or_default()
    }
}

/// One API call, normalized from EITHER source. The OTEL path is preferred: it carries `session.id`
/// directly (so a session's newest call and a compaction's own summarization call are attributable,
/// which the body path's previous_message_id chain cannot do) and Claude Code's own tier-aware
/// `cost_usd`. The body path fills in what OTEL does not carry — the 5m/1h write split and the
/// cache-miss reason — and serves as the whole source when no span store is readable.
#[derive(Clone, Debug, Default)]
struct NormalizedCall {
    ts: f64,
    session_id: Option<String>,
    model: Option<String>,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
    cache_create_1h: f64,
    /// Non-null ONLY when the harness reported it.
    cost_usd: Option<f64>,
    query_source: Option<String>,
    cache_miss_reason: Option<String>,
    cache_missed_tokens: Option<f64>,
    from_body: bool,
}

#[derive(Clone, Debug, Default)]
pub struct CacheEventLogOptions {
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub mode: Option<String>,
    pub context_events: Option<f64>,
    pub limit: Option<f64>,
    pub window_hours: Option<f64>,
    pub scan_cap: Option<usize>,
}

/// Everything the TS reads from ambient process state — passed in, so the engine has no hidden
/// inputs and a test does not have to mutate the process to pin them.
pub struct LedgerEnv<'a> {
    pub bodies_dir: &'a Path,
    pub spans_dir: &'a Path,
    /// `claudeProjectsDirs()` — the roots whose directory NAMES are the ownership fact.
    pub projects_dirs: &'a [PathBuf],
    /// `process.env.CLAUDE_PROJECT_DIR?.trim()`.
    pub project_env_dir: Option<&'a str>,
    /// `process.cwd()`.
    pub cwd: &'a str,
    pub zone: &'a DisplayZone,
    pub now_ms: f64,
}

/// sessionId → project slug, from directory NAMES only (readdir, no file is opened). This is the
/// authoritative ownership fact: Claude Code writes a session's transcript into exactly one
/// project directory.
///
/// Sorted, unlike `readdirSync`: Node's order is filesystem-dependent, and `Map.set` overwrites, so
/// the TS's winner for a sessionId present under two slugs is whatever the filesystem happened to
/// list last. A sorted walk is the only reproducible version of that tie.
pub fn build_session_project_index(projects_dirs: &[PathBuf]) -> IndexMap<String, String> {
    let mut index: IndexMap<String, String> = IndexMap::new();
    for root in projects_dirs {
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        let mut slugs: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        slugs.sort();
        for slug in slugs {
            let Ok(files) = std::fs::read_dir(root.join(&slug)) else { continue };
            let mut names: Vec<String> = files.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            for file in names {
                if let Some(stem) = file.strip_suffix(".jsonl") {
                    index.insert(stem.to_owned(), slug.clone());
                }
            }
        }
    }
    index
}

/// Normalize a raw-body scan event — the fallback source, and the enrichment that adds the 5m/1h
/// write split and the cache-miss reason to an OTEL-sourced call.
fn from_body(e: &CacheCreationEvent) -> NormalizedCall {
    NormalizedCall {
        ts: e.ts,
        session_id: e.session_id.clone(),
        model: e.model.clone(),
        input: e.input_tokens,
        output: e.output_tokens,
        cache_read: e.cache_read_tokens,
        cache_create: e.cache_create_tokens,
        cache_create_1h: e.cache_creation_1h_tokens,
        // The body carries usage, never a cost — we price it ourselves.
        cost_usd: None,
        from_body: true,
        ..NormalizedCall::default()
    }
}

/// Read the two things OTEL does not carry from a call's raw body, when it is still on the spool:
/// the cache-write TTL split (OTEL reports one undifferentiated `cache_creation_tokens`) and the
/// API's own `cache_miss_reason`. Keyed by `request_id`, which IS the body filename stem.
fn enrich_from_body(bodies_dir: &Path, request_id: Option<&str>, call: &mut NormalizedCall) {
    // `if (!requestId) return {}` is TRUTHY — an empty id enriches nothing.
    let Some(request_id) = request_id.filter(|s| !s.is_empty()) else { return };
    let Some(body) = read_json_bounded(&bodies_dir.join(format!("{request_id}.response.json")), MAX_RESPONSE_BYTES)
    else {
        return;
    };
    // `typeof h1 === 'number'` — a numeric STRING does not count.
    if let Some(h1) = body.pointer("/usage/cache_creation/ephemeral_1h_input_tokens").and_then(Value::as_f64) {
        call.cache_create_1h = h1;
    }
    let Some(reason) = body.pointer("/diagnostics/cache_miss_reason").filter(|v| crate::summarize::helpers::truthy(v))
    else {
        return;
    };
    if let Some(t) = reason.get("type").and_then(Value::as_str) {
        call.cache_miss_reason = Some(t.to_owned());
        // NESTED under the type check, exactly as the TS is: a missed-token count with no reason
        // beside it would be a number nothing explains.
        if let Some(n) = reason.get("cache_missed_input_tokens").and_then(Value::as_f64) {
            call.cache_missed_tokens = Some(n);
        }
    }
}

struct Row {
    value: Value,
    input: f64,
    cache_write: f64,
    cache_read: f64,
    output: f64,
    weighted: Option<f64>,
    cost_usd: Option<f64>,
}

fn row_of(call: &NormalizedCall, role: &str, zone: &DisplayZone, now_ms: f64) -> Row {
    let rates = call.model.as_deref().filter(|m| !m.is_empty()).and_then(|m| lookup_rates(m, None, now_ms));
    // Prefer the harness's own figure: Claude Code prices the cache-write TTL tiers separately (a
    // 1-hour write bills at 2x base input, a 5-minute write at 1.25x), so recomputing locally can
    // only MATCH it — and silently under-reports whenever the tier is unknown. Recompute ONLY when
    // the harness reported nothing, and then feed the 1h portion through so the tier is honored.
    let cost_usd = match call.cost_usd {
        Some(c) => Some(c),
        None => call.model.as_deref().filter(|m| !m.is_empty()).map(|m| {
            calc_token_cost_usd(call.input, call.cache_read, call.cache_create, call.output, m, call.cache_create_1h, None, now_ms)
        }),
    };
    let cost_source = if call.cost_usd.is_some() {
        "harness"
    } else if cost_usd.is_some() {
        "computed"
    } else {
        "unpriced"
    };
    let ttl: Option<&str> = if call.cache_create <= 0.0 {
        None
    } else if call.cache_create_1h > 0.0 {
        Some("1-hour")
    } else if call.from_body {
        // OTEL reports one undifferentiated write, so an OTEL row with no 1h portion is UNKNOWN,
        // not 5-minute. Only the body path can assert the 5-minute tier.
        Some("5-minute")
    } else {
        None
    };
    // Divide the real dollar cost by the model's own base input rate. Doing it this way (rather
    // than hardcoding 0.1x/1.25x/5x) keeps the weighting correct for any model whose multipliers
    // differ from the Claude family — the ratios are READ from the rate table, never assumed.
    let weighted = match (cost_usd, &rates) {
        (Some(c), Some(r)) if r.input_per_mtok > 0.0 => Some(js_math_round(c / (r.input_per_mtok / 1_000_000.0))),
        _ => None,
    };
    let scale = write_scale_of(call.cache_create);
    let cost_rounded = cost_usd.map(|c| js_to_fixed_num(c, 4));

    let opt_str = |v: &Option<String>| v.clone().map_or(Value::Null, Value::String);
    let opt_num = |v: Option<f64>| v.map_or(Value::Null, num);
    let mut m = Map::new();
    m.insert("role".into(), Value::String(role.to_owned()));
    m.insert("localTime".into(), Value::String(zone.local_time(call.ts)));
    m.insert("iso".into(), Value::String(iso_from_ms(call.ts)));
    // `?? ''` — a call with no session renders an EMPTY id, not null. (It cannot reach a row: an
    // unattributable call is excluded upstream. The literal is mirrored anyway.)
    m.insert("sessionId".into(), Value::String(call.session_id.clone().unwrap_or_default()));
    m.insert("model".into(), opt_str(&call.model));
    m.insert("inputTokens".into(), num(call.input));
    m.insert("cacheWriteTokens".into(), num(call.cache_create));
    m.insert("cacheReadTokens".into(), num(call.cache_read));
    m.insert("outputTokens".into(), num(call.output));
    m.insert("cacheWriteTtl".into(), ttl.map_or(Value::Null, |t| Value::String(t.to_owned())));
    m.insert("querySource".into(), opt_str(&call.query_source));
    m.insert("cacheMissReason".into(), opt_str(&call.cache_miss_reason));
    m.insert("cacheMissedTokens".into(), opt_num(call.cache_missed_tokens));
    m.insert("costSource".into(), Value::String(cost_source.to_owned()));
    m.insert("weightedInputEquivalentTokens".into(), opt_num(weighted));
    m.insert("costUsd".into(), opt_num(cost_rounded));
    m.insert("writeScale".into(), num(scale as f64));
    m.insert("writeMarker".into(), Value::String(WRITE_SCALE_EMOJI.repeat(scale)));

    Row {
        value: Value::Object(m),
        input: call.input,
        cache_write: call.cache_create,
        cache_read: call.cache_read,
        output: call.output,
        weighted,
        cost_usd: cost_rounded,
    }
}

const LEGEND: [&str; 5] = [
    "Cache write marker: 🔥 1+ tokens · 🔥🔥 10,000+ · 🔥🔥🔥 50,000+ · 🔥🔥🔥🔥 150,000+ · 🔥🔥🔥🔥🔥 400,000+ (order-of-magnitude steps).",
    "Weighted input-equivalents = the call's dollar cost expressed in plain-input tokens. The rate-limit windows are metered by COST, so raw token counts are not comparable across buckets.",
    "Cache write TTL: 1-hour = a main-conversation turn on a subscription; 5-minute = a subagent, or a usage-credits session. A 5-minute write with zero cache read is a fresh subagent paying for a cold copy of its parent's context.",
    "Never sourced from the session transcript: a compaction's own summarization call is a real API call that the .jsonl does not record, so read from there a compaction looks free.",
    "Cost source: `harness` rows carry Claude Code's own cost_usd, which prices the cache-write TTL tiers separately (1-hour writes bill at 2x base input, 5-minute at 1.25x). `computed` rows were priced locally from the rate table.",
];

const OTEL_EXCLUDED_NOTE: &str = "Source is the OTEL span store, whose api_request events carry session.id directly, so attribution is exact and even a compaction's own summarization call (query_source `compact`) is attributed — an unattributable count here means an event with no session.id.";
const BODY_EXCLUDED_NOTE: &str = "Source is the raw-body scan (no OTEL span store readable): a call is attributed through the FOLLOWING request's previous_message_id, so a session's most recent call — and a compaction's own summarization call, which the next request does not chain to — cannot be attributed.";

/// The per-call cache ledger for ONE project.
///
/// mode 'peak'   — the costliest single call in the window (ties broken toward the MOST RECENT),
///                 with the `contextEvents` calls before and after it.
/// mode 'recent' — the last `limit` calls regardless of cost.
///
/// Both modes rank and total by cost-weighted input-equivalents, never by raw token count.
pub fn build_cache_event_log(opts: &CacheEventLogOptions, env: &LedgerEnv) -> Value {
    let mode = if opts.mode.as_deref() == Some("recent") { "recent" } else { "peak" };
    let context_events = opts.context_events.unwrap_or(DEFAULT_CONTEXT_EVENTS).clamp(0.0, MAX_CONTEXT_EVENTS);
    let limit = opts.limit.unwrap_or(DEFAULT_RECENT_LIMIT).clamp(1.0, MAX_RECENT_LIMIT);

    // `opts.project?.trim()` then `explicit || envDir || cwd` — JS TRUTHINESS, so a whitespace-only
    // project argument falls through to the env var rather than resolving to "".
    let explicit = opts.project.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let env_dir = env.project_env_dir.map(str::trim).filter(|s| !s.is_empty());
    let resolved_from = if explicit.is_some() {
        "argument"
    } else if env_dir.is_some() {
        "CLAUDE_PROJECT_DIR"
    } else {
        "working directory"
    };
    // Resolved against directories that ACTUALLY EXIST, not derived and hoped for: `owned_by` below
    // comes from real directory names, so a path long enough for Claude Code to truncate-and-hash
    // its slug would never equal a naive derivation — and EVERY call would be excluded as another
    // project's.
    let projects = crate::burn::causing_tool_call::resolve_project_slugs(
        explicit.or(env_dir).unwrap_or(env.cwd),
        env.projects_dirs,
    );
    let project = projects.first().cloned().unwrap_or_default();

    // include_zero_cache_create: a ledger that hides warm turns cannot show that the call before a
    // cold write was warm — which is the whole comparison separating a TTL expiry from a break.
    let scan_opts = ScanOptions {
        window_hours: opts.window_hours,
        scan_cap: opts.scan_cap,
        include_zero_cache_create: true,
    };
    let (body_events, coverage) = scan_cache_creation_events(env.bodies_dir, &scan_opts, env.now_ms);

    // OTEL FIRST. Its api_request events carry session.id directly, so attribution is exact — no
    // previous_message_id chain, which means a session's newest call and a compaction's own
    // summarization call (query_source `compact`) finally appear instead of falling into the
    // unattributable bucket. Each is then enriched from its raw body via `request_id`.
    let since = opts.window_hours.map_or(0.0, |w| env.now_ms - w * 3_600_000.0);
    let otel = agentlens_spanstore::scan_call_events(env.spans_dir, since as i64, env.now_ms as i64)
        .map(|r| r.events)
        .unwrap_or_default();
    let using_otel = !otel.is_empty();
    let calls: Vec<NormalizedCall> = if using_otel {
        otel.iter()
            .map(|e| {
                let mut c = NormalizedCall {
                    ts: e.ts as f64,
                    // The spanstore's session id is a plain String; an EMPTY one is the TS's
                    // `undefined` — both fail the truthy ownership lookup below.
                    session_id: (!e.session_id.is_empty()).then(|| e.session_id.clone()),
                    model: e.model.clone(),
                    input: e.input_tokens as f64,
                    output: e.output_tokens as f64,
                    cache_read: e.cache_read_tokens as f64,
                    cache_create: e.cache_create_tokens as f64,
                    cache_create_1h: 0.0,
                    cost_usd: e.cost_usd,
                    query_source: e.query_source.clone(),
                    from_body: false,
                    ..NormalizedCall::default()
                };
                enrich_from_body(env.bodies_dir, e.request_id.as_deref(), &mut c);
                c
            })
            .collect()
    } else {
        body_events.iter().map(from_body).collect()
    };

    let owner = build_session_project_index(env.projects_dirs);
    let want_session = opts.session_id.as_deref().filter(|s| !s.is_empty());
    let mut mine: Vec<NormalizedCall> = Vec::new();
    let (mut other_project, mut unattributable) = (0.0, 0.0);
    for c in calls {
        let owned_by = c.session_id.as_deref().and_then(|s| owner.get(s));
        let Some(owned_by) = owned_by else {
            unattributable += 1.0;
            continue;
        };
        if !projects.iter().any(|p| p == owned_by) || want_session.is_some_and(|s| c.session_id.as_deref() != Some(s)) {
            other_project += 1.0;
            continue;
        }
        mine.push(c);
    }
    mine.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));

    let mut rows: Vec<Row> = Vec::new();
    if !mine.is_empty() && mode == "peak" {
        // COST, not cache-write size: the costliest call is sometimes an OUTPUT spike (billed ~5x),
        // and a ledger that only ever points at the biggest write would never show it. Ties go to
        // the MOST RECENT (`>=`), so "the peak" means the one the user just watched happen.
        let cost_of = |e: &NormalizedCall| -> f64 {
            match e.cost_usd {
                Some(c) => c,
                None => e.model.as_deref().filter(|m| !m.is_empty()).map_or(0.0, |m| {
                    calc_token_cost_usd(e.input, e.cache_read, e.cache_create, e.output, m, e.cache_create_1h, None, env.now_ms)
                }),
            }
        };
        let mut peak = 0usize;
        for i in 1..mine.len() {
            if cost_of(&mine[i]) >= cost_of(&mine[peak]) {
                peak = i;
            }
        }
        let ctx = context_events as usize;
        let from = peak.saturating_sub(ctx);
        let to = (peak + ctx).min(mine.len() - 1);
        for (i, call) in mine.iter().enumerate().take(to + 1).skip(from) {
            let role = if i == peak {
                "peak"
            } else if i < peak {
                "before"
            } else {
                "after"
            };
            rows.push(row_of(call, role, env.zone, env.now_ms));
        }
    } else {
        let start = mine.len().saturating_sub(limit as usize);
        for call in &mine[start..] {
            rows.push(row_of(call, "recent", env.zone, env.now_ms));
        }
    }

    let mut totals = Map::new();
    let sum = |f: &dyn Fn(&Row) -> f64| -> f64 { rows.iter().map(f).sum() };
    totals.insert("events".into(), num(rows.len() as f64));
    totals.insert("inputTokens".into(), num(sum(&|r| r.input)));
    totals.insert("cacheWriteTokens".into(), num(sum(&|r| r.cache_write)));
    totals.insert("cacheReadTokens".into(), num(sum(&|r| r.cache_read)));
    totals.insert("outputTokens".into(), num(sum(&|r| r.output)));
    totals.insert("weightedInputEquivalentTokens".into(), num(sum(&|r| r.weighted.unwrap_or(0.0))));
    totals.insert("costUsd".into(), num(js_to_fixed_num(sum(&|r| r.cost_usd.unwrap_or(0.0)), 4)));

    let mut excluded = Map::new();
    excluded.insert("calls".into(), num(other_project + unattributable));
    excluded.insert("otherProject".into(), num(other_project));
    excluded.insert("unattributable".into(), num(unattributable));
    excluded.insert(
        "note".into(),
        Value::String(format!(
            "{} call(s) excluded as belonging to another project (the scoping boundary working as intended) and {} as unattributable to any session. {} They are never guessed into a project by timing.",
            crate::summarize::helpers::fmt_js_num(other_project),
            crate::summarize::helpers::fmt_js_num(unattributable),
            if using_otel { OTEL_EXCLUDED_NOTE } else { BODY_EXCLUDED_NOTE },
        )),
    );

    let mut out = Map::new();
    out.insert("project".into(), Value::String(project));
    out.insert("projectResolvedFrom".into(), Value::String(resolved_from.to_owned()));
    out.insert("mode".into(), Value::String(mode.to_owned()));
    if let Some(w) = opts.window_hours {
        out.insert("windowHours".into(), num(w));
    }
    out.insert("timezone".into(), Value::String(env.zone.name().to_owned()));
    out.insert("rows".into(), Value::Array(rows.iter().map(|r| r.value.clone()).collect()));
    out.insert("totals".into(), Value::Object(totals));
    out.insert("excluded".into(), Value::Object(excluded));
    out.insert("source".into(), Value::String(if using_otel { "otel".into() } else { "raw-bodies".to_string() }));
    out.insert("legend".into(), Value::Array(LEGEND.iter().map(|s| Value::String((*s).to_owned())).collect()));
    out.insert("coverage".into(), coverage.to_value());
    Value::Object(out)
}

// ── rendering ───────────────────────────────────────────────────────────────

/// Terminal display WIDTH, not code-point count. An emoji is ONE code point but occupies TWO
/// columns, so sizing the marker column by length leaves every row after a wide marker visibly out
/// of line — which in a table of numbers reads as a data error, not a font quirk.
fn display_width(value: &str) -> usize {
    value.chars().map(|c| if c as u32 > 0xFFFF { 2 } else { 1 }).sum()
}

fn pad(value: &str, width: usize, right: bool) -> String {
    let fill = " ".repeat(width.saturating_sub(display_width(value)));
    if right {
        format!("{fill}{value}")
    } else {
        format!("{value}{fill}")
    }
}

const HEADER: [&str; 12] = [
    "", "Time", "Query source", "Input tokens", "Cache write", "", "Cache read", "Output tokens",
    "Cache write TTL", "Cache miss reason", "Weighted", "Cost USD",
];

/// Render the ledger. 'json' returns the object; 'table'/'markdown' return
/// `{ format, text, coverage }` so the MCP result stays JSON-serializable.
pub fn format_cache_event_log(log: &Value, format: &str) -> Value {
    if format == "json" {
        return log.clone();
    }
    let empty: Vec<Value> = Vec::new();
    let rows = log.get("rows").and_then(Value::as_array).unwrap_or(&empty);
    let f = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    // `?? '—'` is NULLISH on a JSON null; `r.cacheMissedTokens ? …` inside the reason cell is
    // TRUTHY, so a missed-token count of exactly 0 renders no parenthetical.
    let dash = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("—").to_owned();

    let body: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            let reason = match r.get("cacheMissReason").and_then(Value::as_str) {
                Some(reason) => {
                    let n = f(r, "cacheMissedTokens");
                    if n != 0.0 {
                        format!("{reason} ({})", to_locale_en(n))
                    } else {
                        reason.to_owned()
                    }
                }
                None => "—".to_owned(),
            };
            vec![
                if s(r, "role") == "peak" { "▶".to_owned() } else { " ".to_owned() },
                s(r, "localTime"),
                dash(r, "querySource"),
                to_locale_en(f(r, "inputTokens")),
                to_locale_en(f(r, "cacheWriteTokens")),
                s(r, "writeMarker"),
                to_locale_en(f(r, "cacheReadTokens")),
                to_locale_en(f(r, "outputTokens")),
                dash(r, "cacheWriteTtl"),
                reason,
                r.get("weightedInputEquivalentTokens")
                    .and_then(Value::as_f64)
                    .map_or("—".to_owned(), to_locale_en),
                r.get("costUsd")
                    .and_then(Value::as_f64)
                    .map_or("unpriced".to_owned(), |c| format!("${}", js_to_fixed_str(c, 4))),
            ]
        })
        .collect();

    let t = |k: &str| log.pointer(&format!("/totals/{k}")).and_then(Value::as_f64).unwrap_or(0.0);
    let total_row: Vec<String> = vec![
        String::new(),
        "TOTAL".to_owned(),
        String::new(),
        to_locale_en(t("inputTokens")),
        to_locale_en(t("cacheWriteTokens")),
        String::new(),
        to_locale_en(t("cacheReadTokens")),
        to_locale_en(t("outputTokens")),
        String::new(),
        String::new(),
        to_locale_en(t("weightedInputEquivalentTokens")),
        format!("${}", js_to_fixed_str(t("costUsd"), 4)),
    ];

    let mode = log.get("mode").and_then(Value::as_str).unwrap_or("");
    let title = if mode == "peak" {
        format!(
            "Cache event ledger — costliest call in window, with {} calls",
            if (rows.len() as f64 - 1.0) / 2.0 >= 1.0 { "surrounding" } else { "no surrounding" }
        )
    } else {
        format!("Cache event ledger — {} most recent call(s)", rows.len())
    };
    let cost_note = if rows.iter().any(|r| r.get("costSource").and_then(Value::as_str) == Some("harness")) {
        "cost reported by Claude Code (tier-aware)"
    } else {
        "cost computed locally"
    };
    let scope = format!(
        "project {} (from {}) · source {} · {cost_note} · times local ({})",
        log.get("project").and_then(Value::as_str).unwrap_or(""),
        log.get("projectResolvedFrom").and_then(Value::as_str).unwrap_or(""),
        log.get("source").and_then(Value::as_str).unwrap_or(""),
        log.get("timezone").and_then(Value::as_str).unwrap_or(""),
    );

    let mut lines: Vec<String> = Vec::new();
    if format == "markdown" {
        lines.push(format!("# {title}"));
        lines.push(String::new());
        lines.push(scope);
        lines.push(String::new());
        lines.push(format!("| {} |", HEADER.join(" | ")));
        lines.push(format!("|{}|", HEADER.iter().map(|_| "---").collect::<Vec<_>>().join("|")));
        for row in &body {
            lines.push(format!("| {} |", row.join(" | ")));
        }
        lines.push(format!("| {} |", total_row.join(" | ")));
    } else {
        let header: Vec<String> = HEADER.iter().map(|h| (*h).to_owned()).collect();
        let mut table: Vec<&Vec<String>> = vec![&header];
        table.extend(body.iter());
        table.push(&total_row);
        // Width by the widest CELL, not by the header — emoji and grouped digits both break naive
        // sizing.
        let widths: Vec<usize> = (0..HEADER.len())
            .map(|c| table.iter().map(|r| display_width(r.get(c).map(String::as_str).unwrap_or(""))).max().unwrap_or(0))
            .collect();
        // Columns 0 and 1 are LEFT-aligned (`right = c > 1`); everything numeric is right-aligned.
        let render = |r: &Vec<String>| {
            r.iter().enumerate().map(|(c, cell)| pad(cell, widths[c], c > 1)).collect::<Vec<_>>().join("  ")
        };
        lines.push(title);
        lines.push(scope);
        lines.push(String::new());
        lines.push(render(&header));
        for row in &body {
            lines.push(render(row));
        }
        lines.push(render(&total_row));
    }

    lines.push(String::new());
    for l in log.get("legend").and_then(Value::as_array).unwrap_or(&empty) {
        lines.push(format!("· {}", l.as_str().unwrap_or("")));
    }
    if log.pointer("/excluded/calls").and_then(Value::as_f64).unwrap_or(0.0) > 0.0 {
        lines.push(String::new());
        lines.push(format!("· {}", log.pointer("/excluded/note").and_then(Value::as_str).unwrap_or("")));
    }

    let mut m = Map::new();
    m.insert("format".into(), Value::String(format.to_owned()));
    m.insert("text".into(), Value::String(lines.join("\n")));
    m.insert("coverage".into(), log.get("coverage").cloned().unwrap_or(Value::Null));
    Value::Object(m)
}
