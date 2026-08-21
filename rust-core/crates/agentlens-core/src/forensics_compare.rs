//! `compare_configs` — the TS `src/forensicsCompare.ts` engine (TRDD-FB5RG4P1 design §4, ported
//! under TRDD-DMWOBWFH).
//!
//! Groups every API-call fact by a config dimension and ranks the groups worst→best on a chosen
//! metric, with per-group min/max/avg/median/p95/count/sum ALWAYS returned + a share of the total
//! and a billable-weighted USD number. median/p95 are computed HERE rather than in SQL (§4.3), the
//! same choice the TS made for a different reason: sql.js had no PERCENTILE, and doing it in the
//! host keeps one definition of the quantile instead of one per engine.
//!
//! The unresolved-spawn mass is NEVER hidden: it surfaces as its own group and in the coverage
//! block (the same honesty contract as the unattributed bucket in cacheCreationForensics).

use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::forensics_db::open_readonly_snapshot;
use crate::summarize::helpers::{js_math_round, js_to_fixed_str, num};

/// Group dimension → the JOIN + key expression. `COALESCE` surfaces the null buckets under an
/// explicit label rather than dropping them.
struct GroupJoin {
    join: &'static str,
    key_expr: &'static str,
    kind_param: Option<&'static str>,
}

fn group_join(dim: &str) -> Option<GroupJoin> {
    let inj = "JOIN call_injections ci ON ci.call_id = a.call_id";
    match dim {
        "skill" => Some(GroupJoin { join: inj, key_expr: "ci.name", kind_param: Some("skill") }),
        "mcp" => Some(GroupJoin { join: inj, key_expr: "ci.name", kind_param: Some("mcp") }),
        "rule" => Some(GroupJoin { join: inj, key_expr: "ci.name", kind_param: Some("rule") }),
        "content_tag" => Some(GroupJoin {
            join: "JOIN call_content cc ON cc.call_id = a.call_id",
            key_expr: "cc.tag",
            kind_param: None,
        }),
        _ => None,
    }
}

fn group_col(dim: &str) -> Option<&'static str> {
    Some(match dim {
        "spawn_kind" => "COALESCE(a.spawn_kind, 'unresolved')",
        "model" => "COALESCE(a.model, '(unknown)')",
        "effort" => "COALESCE(a.effort, 'none')",
        "isolation" => "COALESCE(a.spawn_isolation, 'none')",
        "subagent_type" => "COALESCE(a.subagent_type, '(unknown)')",
        "frontmatter" => "COALESCE(a.frontmatter_fp, '(none)')",
        "break_cause" => "COALESCE(a.break_cause, '(none)')",
        "account" => "COALESCE(a.account_uuid, '(unattributed)')",
        "session" => "COALESCE(a.session_id, '(unattributed)')",
        _ => return None,
    })
}

/// `METRIC_EXPR` is a TOTAL record in the TS (`Record<MetricKey, string>`), so an unknown key there
/// yields `undefined` and produces the SQL `SELECT ... AS k, undefined AS v` — a hard parse error.
/// Here an unknown metric is `None`, which the caller turns into the same "no rows" shape the
/// TS reaches by throwing. Callers pass a schema-constrained enum, so neither path is reachable
/// from the MCP surface.
fn metric_expr(metric: &str) -> Option<&'static str> {
    Some(match metric {
        "cache_creation" => "a.cache_creation_tokens",
        "cache_read" => "a.cache_read_tokens",
        "output_tokens" => "a.output_tokens",
        "input_tokens" => "a.input_tokens",
        "total" => "(a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_creation_tokens)",
        "billable_weighted" => "a.billable_weight",
        // Avoidable breaks only — degrades to 0 when break_cause is unpopulated (no
        // cacheBreakTimeline), which is an honest zero rather than a missing column.
        "breaks" => "CASE WHEN a.break_cause IS NOT NULL AND a.break_cause NOT IN ('COLD_START','TTL_EXPIRY') THEN 1 ELSE 0 END",
        _ => return None,
    })
}

/// JS `Number(v)` — the coercion, WITHOUT the `|| 0` that `as_num` adds. Kept separate because the
/// `window` filter needs the raw result: `NaN > 0` is false (no cutoff), whereas a `|| 0` would
/// have already turned it into 0 and reached the same place for the wrong reason.
///
/// KNOWN, DELIBERATE GAP: `Number([5])` is 5 in JS (an array stringifies before coercing). Arrays
/// and objects are NaN here. Reproducing single-element-array-to-number would be porting a JS
/// absurdity into a filter field that is documented as a scalar.
fn to_number(v: &Value) -> f64 {
    match v {
        // serde_json cannot hold NaN/±Infinity in a Number, so this is always finite.
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_of(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

/// `num(v)` — `typeof v === 'number' && isFinite(v) ? v : Number(v) || 0`. A TEXT column is
/// therefore PARSED here (unlike the custom SQL fns in forensics_db, which deliberately do not),
/// and `|| 0` collapses ONLY the falsy results: NaN and 0. It does NOT swallow ±Infinity, which is
/// why this is not simply "non-finite → 0" — an early draft of this port had that and would have
/// silently zeroed a value the TS keeps.
///
/// KNOWN, UNREACHABLE GAP: a genuine IEEE infinity stored in a SQL REAL column survives the TS
/// aggregation as Infinity but arrives here as 0, because the row reader goes through
/// `serde_json`, which cannot represent it and yields Null. Every token/weight column the indexer
/// writes is finite, so no real row takes that path; closing it would mean not using Value as the
/// row representation, which is a bigger change than the gap is worth.
fn as_num(v: &Value) -> f64 {
    let n = to_number(v);
    if n.is_nan() {
        0.0
    } else {
        n
    }
}

/// Bind one filter value the way sql.js does, so a wrong-typed filter NARROWS exactly as the TS
/// narrows instead of being dropped. Measured against sql.js directly: a number binds as INTEGER
/// (or REAL when not int-exact), a bool as 1/0, a string as TEXT, and a plain object THROWS.
///
/// The port of that throw is a bound NULL: `col = NULL` is never true, so the row set is the same
/// EMPTY one the TS's failed call produces, without plumbing an error path through every caller for
/// input that can only be a client bug. An array binds as a BLOB in sql.js, which likewise never
/// equals a TEXT column — same outcome, same NULL here.
/// ponytail: bound NULL for array/object; give it a real error path if a caller ever needs to tell
/// "you sent the wrong type" apart from "nothing matched".
fn js_bind_value(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as S;
    match v {
        Value::String(s) => S::Text(s.clone()),
        Value::Bool(b) => S::Integer(i64::from(*b)),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            // sql.js: `num === (num | 0) ? bind_int : bind_double`.
            if f.fract() == 0.0 && f.is_finite() && f.abs() <= f64::from(i32::MAX) {
                S::Integer(f as i64)
            } else {
                S::Real(f)
            }
        }
        _ => S::Null,
    }
}

/// The TS quantile: an index of `ceil(q·n) − 1`, clamped — a nearest-rank definition, NOT an
/// interpolating one. Reproduced literally; switching to a "better" quantile would change every
/// median the tool has ever reported.
fn quantile(sorted_asc: &[f64], q: f64) -> f64 {
    if sorted_asc.is_empty() {
        return 0.0;
    }
    if sorted_asc.len() == 1 {
        return sorted_asc[0];
    }
    let n = sorted_asc.len();
    let idx = (q * n as f64).ceil() - 1.0;
    let idx = idx.max(0.0).min((n - 1) as f64) as usize;
    sorted_asc[idx]
}

#[derive(Default)]
struct Agg {
    min: f64,
    max: f64,
    avg: f64,
    median: f64,
    p95: f64,
    sum: f64,
}

fn aggregate(values: &[f64]) -> Agg {
    let n = values.len();
    if n == 0 {
        return Agg::default();
    }
    let mut sorted = values.to_vec();
    // JS's default numeric comparator; no NaN can reach here (`as_num` maps it to 0).
    sorted.sort_by(|x, y| x.partial_cmp(y).expect("as_num rules out NaN"));
    let sum: f64 = sorted.iter().sum();
    Agg {
        min: sorted[0],
        max: sorted[n - 1],
        avg: sum / n as f64,
        median: quantile(&sorted, 0.5),
        p95: quantile(&sorted, 0.95),
        sum,
    }
}

// ── filters ─────────────────────────────────────────────────────────────────────

/// One WHERE fragment set plus its bound params. Every value is BOUND, never concatenated.
struct Filter {
    where_: Vec<String>,
    params: Vec<(String, Value)>,
}

/// The TS `eq()` gate: `val !== undefined && val !== null && val !== ''`. NOTHING about the TYPE —
/// a number, a bool, even an object passes it and gets bound. Requiring `Value::String` here (an
/// earlier draft did) silently DROPPED the filter for any other type, which WIDENS the result set;
/// the TS narrows it to nothing instead. Widening is the dangerous direction: it answers a
/// different, broader question under the label the caller asked for.
fn val_of<'a>(f: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    f.and_then(|v| v.get(k))
        .filter(|v| !v.is_null() && v.as_str() != Some(""))
}

/// EVERY element, whatever its type — the TS `vals.map(...)` builds one placeholder per element
/// regardless. Filtering non-strings out would emit a DIFFERENT number of `IN (...)` placeholders
/// than the TS and therefore a different filter.
fn vals_of(f: Option<&Value>, k: &str) -> Vec<Value> {
    f.and_then(|v| v.get(k))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn build_filter(f: Option<&Value>, now_ms: f64) -> Filter {
    let mut out = Filter { where_: Vec::new(), params: Vec::new() };
    let Some(fv) = f else { return out };

    // `f.window && f.window > 0`, and `to_number(v) > 0` is EXACTLY equivalent: every falsy JS
    // value coerces to 0, -0 or NaN, none of which is > 0 — so the truthiness half is subsumed.
    // The coercion is the point: the TS accepts a STRING "24" here (`"24" > 0` is true, and the
    // arithmetic coerces too), so requiring a JSON number would drop a cutoff the TS applies.
    if let Some(w) = fv.get("window").map(to_number).filter(|w| *w > 0.0) {
        out.where_.push("a.ts >= :__win".to_owned());
        out.params.push((":__win".to_owned(), num(now_ms - w * 3_600_000.0)));
    }
    let mut eq = |col: &str, key: &str, val: Option<&Value>| {
        if let Some(v) = val {
            out.where_.push(format!("{col} = {key}"));
            out.params.push((key.to_owned(), v.clone()));
        }
    };
    eq("a.model", ":f_model", val_of(f, "model"));
    eq("a.spawn_kind", ":f_sk", val_of(f, "spawnKind"));
    eq("a.subagent_type", ":f_sat", val_of(f, "subagentType"));
    eq("a.effort", ":f_eff", val_of(f, "effort"));
    eq("a.spawn_isolation", ":f_iso", val_of(f, "isolation"));
    eq("a.account_uuid", ":f_acc", val_of(f, "accountUuid"));
    eq("a.session_id", ":f_sess", val_of(f, "sessionId"));
    eq("a.break_cause", ":f_bc", val_of(f, "breakCause"));
    eq("a.spawn_resolution", ":f_res", val_of(f, "spawnResolution"));

    for (key, col, field) in [
        (":f_mcc", "a.cache_creation_tokens", "minCacheCreate"),
        (":f_mot", "a.output_tokens", "minOutputTokens"),
    ] {
        if let Some(n) = fv.get(field).and_then(Value::as_f64) {
            out.where_.push(format!("{col} >= {key}"));
            out.params.push((key.to_owned(), num(n)));
        }
    }
    add_exists(&mut out, Some("skill"), &vals_of(f, "hasSkill"), "call_injections", "name", Some("kind"));
    add_exists(&mut out, Some("mcp"), &vals_of(f, "hasMcp"), "call_injections", "name", Some("kind"));
    add_exists(&mut out, Some("rule"), &vals_of(f, "hasRule"), "call_injections", "name", Some("kind"));
    add_exists(&mut out, None, &vals_of(f, "hasContentTag"), "call_content", "tag", None);
    out
}

fn add_exists(
    out: &mut Filter,
    kind: Option<&str>,
    vals: &[Value],
    table: &str,
    col: &str,
    kind_col: Option<&str>,
) {
    if vals.is_empty() {
        return;
    }
    let tag = kind.unwrap_or("tag");
    let placeholders: Vec<String> = vals
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let k = format!(":he_{table}_{tag}_{i}");
            out.params.push((k.clone(), v.clone()));
            k
        })
        .collect();
    let kind_clause = match (kind, kind_col) {
        (Some(k), Some(kc)) => {
            let key = format!(":hk_{table}_{k}");
            out.params.push((key.clone(), Value::String(k.to_owned())));
            format!("x.{kc} = {key} AND ")
        }
        _ => String::new(),
    };
    out.where_.push(format!(
        "EXISTS (SELECT 1 FROM {table} x WHERE x.call_id = a.call_id AND {kind_clause}x.{col} IN ({}))",
        placeholders.join(", ")
    ));
}

// ── query ───────────────────────────────────────────────────────────────────────

fn query_rows(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[(String, Value)],
) -> Result<Vec<Map<String, Value>>, rusqlite::Error> {
    let mut stmt = conn.prepare(sql)?;
    for (name, v) in params {
        if let Some(idx) = stmt.parameter_index(name)? {
            stmt.raw_bind_parameter(idx, js_bind_value(v))?;
        }
    }
    let cols: Vec<String> = stmt.column_names().iter().map(|s| (*s).to_owned()).collect();
    let mut out = Vec::new();
    let mut cursor = stmt.raw_query();
    while let Some(r) = cursor.next()? {
        let mut m = Map::new();
        for (i, c) in cols.iter().enumerate() {
            let v = match r.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(v) => Value::from(v),
                rusqlite::types::ValueRef::Real(v) => num(v),
                rusqlite::types::ValueRef::Text(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            m.insert(c.clone(), v);
        }
        out.push(m);
    }
    Ok(out)
}

// ── verdicts + coverage ─────────────────────────────────────────────────────────

struct Group {
    key: String,
    calls: usize,
    agg: Agg,
    share_pct: f64,
    billable_weighted_usd: f64,
}

impl Group {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), Value::String(self.key.clone()));
        m.insert("calls".into(), Value::from(self.calls));
        m.insert("min".into(), num(self.agg.min));
        m.insert("max".into(), num(self.agg.max));
        m.insert("avg".into(), num(self.agg.avg));
        m.insert("median".into(), num(self.agg.median));
        m.insert("p95".into(), num(self.agg.p95));
        m.insert("sum".into(), num(self.agg.sum));
        m.insert("sharePct".into(), num(self.share_pct));
        m.insert("billableWeightedUsd".into(), num(self.billable_weighted_usd));
        Value::Object(m)
    }
}

/// The 7 sort aggregates. A name outside this set is rejected up front (see `build_compare_configs`)
/// rather than reaching `sort_key`, so its `_` arm is unreachable rather than a silent default.
const AGGS: [&str; 7] = ["sum", "avg", "median", "min", "max", "p95", "count"];

fn sort_key(g: &Group, agg: &str) -> f64 {
    match agg {
        "sum" => g.agg.sum,
        "median" => g.agg.median,
        "min" => g.agg.min,
        "max" => g.agg.max,
        "p95" => g.agg.p95,
        "count" => g.calls as f64,
        _ => g.agg.avg,
    }
}

/// The spawn_kind narrative. Only spawn_kind gets one: the phrases assert cache mechanics that are
/// specific to how a subagent was launched, and attaching them to any other dimension would be
/// asserting a cause the grouping cannot support.
fn build_verdicts(group_by: &str, metric: &str, groups: &[Group]) -> Vec<Value> {
    if group_by != "spawn_kind" {
        return Vec::new();
    }
    let by = |k: &str| groups.iter().find(|g| g.key == k);
    let m = metric.replace('_', " ");
    let mut out: Vec<Value> = Vec::new();
    let mut cmp = |a: &str, b: &str, phrase: &dyn Fn(f64, &Group, &Group) -> String| {
        if let (Some(ga), Some(gb)) = (by(a), by(b)) {
            if gb.agg.avg > 0.0 {
                out.push(Value::String(phrase(ga.agg.avg / gb.agg.avg, ga, gb)));
            }
        }
    };
    cmp("worktree", "fork", &|r, ga, gb| {
        format!(
            "worktree averages {}× the {m}/call of fork ({} vs {}) — worktree spawns are cache-cold and isolated.",
            js_to_fixed_str(r, 1),
            js_math_round(ga.agg.avg),
            js_math_round(gb.agg.avg)
        )
    });
    cmp("fork", "fresh", &|r, ga, gb| {
        format!(
            "fork averages {}% {} {m} than fresh ({} vs {}) — forks read the parent cache.",
            js_math_round((1.0 - r).abs() * 100.0),
            if r < 1.0 { "less" } else { "more" },
            js_math_round(ga.agg.avg),
            js_math_round(gb.agg.avg)
        )
    });
    cmp("fresh", "root", &|r, ga, gb| {
        format!(
            "fresh subagents average {}× the {m}/call of root sessions ({} vs {}).",
            js_to_fixed_str(r, 1),
            js_math_round(ga.agg.avg),
            js_math_round(gb.agg.avg)
        )
    });
    out
}

fn read_coverage(conn: &rusqlite::Connection, groups: &[Group]) -> Value {
    let mut kv: IndexMap<String, String> = IndexMap::new();
    if let Ok(rows) = query_rows(conn, "SELECT k, v FROM index_state", &[]) {
        for r in rows {
            // `String(r.k)` / `String(r.v)` — the TS stringifies whatever the column held.
            let k = r.get("k").map(js_str).unwrap_or_default();
            let v = r.get("v").map(js_str).unwrap_or_default();
            kv.insert(k, v);
        }
    }
    // `Number(kv.get(..) ?? '0')` — a non-numeric stored value becomes NaN, which JSON.stringify
    // writes as `null`. `num` reaches the same place: Number::from_f64(NaN) is None → Value::Null.
    let n = |k: &str| num(kv.get(k).map_or(0.0, |s| js_number_of(s)));
    let unresolved = groups.iter().find(|g| g.key == "unresolved");
    let mut m = Map::new();
    m.insert("responsesIndexed".into(), n("responses_indexed"));
    m.insert("responsesTotal".into(), n("responses_total"));
    m.insert("lastRunMs".into(), n("last_run_ms"));
    m.insert(
        "note".into(),
        Value::String(
            kv.get("coverage_note").cloned().unwrap_or_else(|| "No index_state — run the indexer.".to_owned()),
        ),
    );
    m.insert("unresolvedCalls".into(), Value::from(unresolved.map_or(0, |g| g.calls)));
    Value::Object(m)
}

/// `String(v)` for a SQL value read back into JS.
fn js_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        other => crate::summarize::helpers::js_string(other),
    }
}

/// `Number(s)` — the whole-string numeric coercion, NaN when it does not parse.
fn js_number_of(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

// ── entry point ─────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct CompareConfigsOptions<'a> {
    pub group_by: Option<&'a str>,
    pub metric: Option<&'a str>,
    pub agg: Option<&'a str>,
    pub filter: Option<&'a Value>,
    pub rank_order: Option<&'a str>,
    pub top_n: Option<f64>,
}

/// Build the compare_configs report. Reads a read-only handle on forensics.db — the indexer
/// (`ensure_fresh_index`) must have run first (the MCP handler does that). Returns
/// `dbAvailable:false` with an explanatory coverage note when the fact DB is absent.
pub fn build_compare_configs(db_path: &Path, opts: &CompareConfigsOptions<'_>, now_ms: f64) -> Value {
    let group_by = opts.group_by.unwrap_or("spawn_kind");
    let metric = opts.metric.unwrap_or("cache_creation");
    let agg = opts.agg.unwrap_or("avg");
    let rank_order = opts.rank_order.unwrap_or("worst-first");
    let top_n = opts.top_n.unwrap_or(20.0).clamp(1.0, 100.0);

    // DELIBERATE DIVERGENCE, and the only one in this file that changes an OUTPUT.
    //
    // The MCP schema types groupBy/metric/agg as bare `string` with no enum and the TS handler
    // casts without validating, so a typo reaches the engine from any client. The TS then does
    // something different and silently wrong for each: an unknown `metric` interpolates the token
    // `undefined` into the SQL and THROWS; an unknown `agg` makes `pickSort` return `undefined`,
    // every comparison NaN, and the ranking arbitrary; an unknown `groupBy` quietly groups by
    // spawn_kind instead. Two of those three answer a different question under the label the caller
    // asked for, which is the failure mode this project treats as worse than an error.
    //
    // Reproducing them faithfully would mean shipping a tool that lies about a typo. It is named
    // here instead. `groupBy` is included even though the TS's fallback is at least deterministic:
    // being told "sesion is not a dimension" beats silently receiving spawn_kind rows.
    let bad = if metric_expr(metric).is_none() {
        Some(format!("unknown metric \"{metric}\" — expected one of cache_creation, cache_read, output_tokens, input_tokens, breaks, total, billable_weighted"))
    } else if !AGGS.contains(&agg) {
        Some(format!("unknown agg \"{agg}\" — expected one of {}", AGGS.join(", ")))
    } else if group_join(group_by).is_none() && group_col(group_by).is_none() {
        Some(format!("unknown groupBy \"{group_by}\" — expected one of spawn_kind, model, effort, isolation, subagent_type, frontmatter, skill, mcp, rule, content_tag, break_cause, account, session"))
    } else {
        None
    };
    if let Some(msg) = bad {
        return serde_json::json!({ "error": msg });
    }

    let head = |m: &mut Map<String, Value>| {
        m.insert("groupBy".into(), Value::from(group_by));
        m.insert("metric".into(), Value::from(metric));
        m.insert("agg".into(), Value::from(agg));
        m.insert("rankOrder".into(), Value::from(rank_order));
    };
    let baseline = |calls: usize, a: &Agg| {
        let mut b = Map::new();
        b.insert("calls".into(), Value::from(calls));
        b.insert("sum".into(), num(a.sum));
        b.insert("avg".into(), num(a.avg));
        b.insert("median".into(), num(a.median));
        b.insert("p95".into(), num(a.p95));
        Value::Object(b)
    };

    let Some(conn) = open_readonly_snapshot(db_path, now_ms) else {
        let mut m = Map::new();
        head(&mut m);
        m.insert("baseline".into(), baseline(0, &Agg::default()));
        m.insert("groups".into(), Value::Array(Vec::new()));
        m.insert("verdict".into(), Value::Array(Vec::new()));
        m.insert(
            "coverage".into(),
            serde_json::json!({ "note": "forensics.db unavailable (no OTEL bodies indexed yet, or sql.js unavailable in this runtime)." }),
        );
        m.insert("dbAvailable".into(), Value::Bool(false));
        return Value::Object(m);
    };

    let join_spec = group_join(group_by);
    let key_expr = join_spec
        .as_ref()
        .map_or_else(|| group_col(group_by).unwrap_or("COALESCE(a.spawn_kind, 'unresolved')"), |j| j.key_expr);
    let mut filter = build_filter(opts.filter, now_ms);
    if let Some(kind) = join_spec.as_ref().and_then(|j| j.kind_param) {
        filter.where_.push("ci.kind = :__gk".to_owned());
        filter.params.push((":__gk".to_owned(), Value::String(kind.to_owned())));
    }
    let where_sql = if filter.where_.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", filter.where_.join(" AND "))
    };
    // Infallible: the guard above already rejected every metric this can fail on.
    let m = metric_expr(metric).expect("metric validated above");
    let sql = format!(
        "SELECT {key_expr} AS k, {m} AS v, a.billable_weight AS bw\n                 FROM api_calls a {} {where_sql}",
        join_spec.as_ref().map_or("", |j| j.join)
    );
    let rows = query_rows(&conn, &sql, &filter.params).unwrap_or_default();

    // Aggregate per group (+ the overall baseline). IndexMap because a JS Map iterates in
    // INSERTION order and the sort below is stable — first-seen order is the tiebreak.
    let mut per_group: IndexMap<String, (Vec<f64>, f64)> = IndexMap::new();
    let mut all_vals: Vec<f64> = Vec::new();
    for r in &rows {
        let k = r.get("k").map(js_str).unwrap_or_default();
        let v = r.get("v").map_or(0.0, as_num);
        let e = per_group.entry(k).or_insert_with(|| (Vec::new(), 0.0));
        e.0.push(v);
        e.1 += r.get("bw").map_or(0.0, as_num);
        all_vals.push(v);
    }
    let baseline_agg = aggregate(&all_vals);
    let baseline_sum = baseline_agg.sum;

    let mut groups: Vec<Group> = per_group
        .into_iter()
        .map(|(key, (vals, bw))| {
            let a = aggregate(&vals);
            Group {
                key,
                calls: vals.len(),
                share_pct: if baseline_sum > 0.0 { (a.sum / baseline_sum) * 100.0 } else { 0.0 },
                agg: a,
                billable_weighted_usd: bw,
            }
        })
        .collect();
    // `Array.prototype.sort` is stable per spec, and so is `sort_by` — equal keys keep first-seen
    // order on both sides, which is the only reason two engines agree on a tie at all.
    groups.sort_by(|x, y| {
        let (a, b) = if rank_order == "best-first" {
            (sort_key(x, agg), sort_key(y, agg))
        } else {
            (sort_key(y, agg), sort_key(x, agg))
        };
        a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
    });
    // Verdicts and coverage are computed on the FULL ranking, before topN truncates it — a verdict
    // about fork vs fresh must not vanish because one of them fell off the end of the list.
    let verdict = build_verdicts(group_by, metric, &groups);
    let coverage = read_coverage(&conn, &groups);
    groups.truncate(top_n as usize);

    let mut m = Map::new();
    head(&mut m);
    m.insert("baseline".into(), baseline(all_vals.len(), &baseline_agg));
    m.insert("groups".into(), Value::Array(groups.iter().map(Group::to_value).collect()));
    m.insert("verdict".into(), Value::Array(verdict));
    m.insert("coverage".into(), coverage);
    m.insert("dbAvailable".into(), Value::Bool(true));
    Value::Object(m)
}
