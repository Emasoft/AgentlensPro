//! Port of src/shared/tokensByCause.ts (TRDD-UBEP5XY7, ported under TRDD-DMWOBWFH P4x.2d) — the
//! tokens-by-CAUSE attribution rollup.
//!
//! Pure aggregation over the `claude_code.api_request` timeline entries the rich-event ingestion
//! produces: each carries the per-call usage buckets, the EXACT `cost_usd`, and WHO caused the call
//! (querySource / agent / skill / plugin / mcp server+tool). Figures are exact ground truth, never
//! estimates — and it works on OTEL-only sessions with no local transcript.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::summarize::helpers::{js_to_fixed_num, num};

/// The drill order the TRDD names: who issued → which sub-agent → which skill → which plugin →
/// which MCP server → which MCP tool. The MCP tool and the webview iterate this same canonical order.
pub const CAUSE_DIMENSIONS: [&str; 6] = ["querySource", "agent", "skill", "plugin", "mcpServer", "mcpTool"];

fn dimension_label(dim: &str) -> &'static str {
    match dim {
        "querySource" => "query source",
        "agent" => "agent",
        "skill" => "skill",
        "plugin" => "plugin",
        "mcpServer" => "MCP server",
        _ => "MCP tool",
    }
}

fn s<'a>(e: &'a Value, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The cause value one api_request carries for a dimension; `""` = no value (→ the explicit
/// unattributed bucket). `mcpTool` keys as `server/tool` so two same-named tools on DIFFERENT
/// servers never merge into one row — and the server half falls back to `?` rather than dropping the
/// tool, because a tool whose server is unknown is still a real, chargeable cause.
fn cause_key(e: &Value, dim: &str) -> String {
    match dim {
        "querySource" => s(e, "querySource").to_owned(),
        "agent" => s(e, "agentName").to_owned(),
        "skill" => s(e, "skillName").to_owned(),
        "plugin" => s(e, "pluginName").to_owned(),
        "mcpServer" => s(e, "mcpServerName").to_owned(),
        // `e.mcpToolName ? … : ''` — TRUTHY, so an empty tool name is no key at all.
        _ => {
            let tool = s(e, "mcpToolName");
            if tool.is_empty() {
                String::new()
            } else {
                let server = e.get("mcpServerName").and_then(Value::as_str).unwrap_or("?");
                format!("{server}/{tool}")
            }
        }
    }
}

/// The label of the pinned bucket that absorbs calls with NO value for a dimension. FAIL-FAST
/// honesty: those tokens are counted and LABELED, never silently dropped and never guessed into a
/// named cause. For querySource an unattributed call is genuinely unknown; for every other dimension
/// absence MEANS "not caused by any <dim>" (a call with no skill active), so the label says so.
fn unattributed_label(dim: &str) -> String {
    if dim == "querySource" {
        "(unattributed)".to_owned()
    } else {
        format!("(no {})", dimension_label(dim))
    }
}

#[derive(Default, Clone)]
struct Row {
    calls: f64,
    input: f64,
    output: f64,
    read: f64,
    create: f64,
    cost: f64,
    cost_known: bool,
}

fn f(e: &Value, k: &str) -> f64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn fold(row: &mut Row, e: &Value) {
    row.calls += 1.0;
    row.input += f(e, "inputTokens");
    row.output += f(e, "outputTokens");
    row.read += f(e, "cacheReadTokens");
    row.create += f(e, "cacheCreateTokens");
    // A call with no cost_usd (rare — an api_request event that lost the attribute) makes the row's
    // cost a FLOOR, flagged via costKnown:false rather than silently understating a figure the
    // reader would take as complete.
    match e.get("costUsd").and_then(Value::as_f64).filter(|c| c.is_finite()) {
        Some(c) => row.cost += c,
        None => row.cost_known = false,
    }
}

fn row_value(dim: &str, key: &str, unattributed: bool, r: &Row) -> Value {
    let mut m = Map::new();
    m.insert("dimension".into(), Value::String(dim.to_owned()));
    m.insert("key".into(), Value::String(key.to_owned()));
    m.insert("unattributed".into(), Value::Bool(unattributed));
    m.insert("calls".into(), num(r.calls));
    m.insert("inputTokens".into(), num(r.input));
    m.insert("outputTokens".into(), num(r.output));
    m.insert("cacheReadTokens".into(), num(r.read));
    m.insert("cacheCreateTokens".into(), num(r.create));
    m.insert("totalTokens".into(), num(r.input + r.output + r.read + r.create));
    // Rounded ONCE, after aggregation — summing many 4-decimal per-call costs accumulates float
    // noise, and this report is read as exact ground truth.
    m.insert("costUsd".into(), num(js_to_fixed_num(r.cost, 4)));
    m.insert("costKnown".into(), Value::Bool(r.cost_known));
    Value::Object(m)
}

/// Rollup of ONE dimension. Named rows rank heaviest-first by totalTokens; the unattributed bucket
/// (when non-empty) is PINNED LAST regardless of size, so a reader always sees the named causes
/// first but can never miss the unattributed remainder.
fn rollup_dimension(api_requests: &[&Value], dim: &str) -> Value {
    let mut by_key: IndexMap<String, Row> = IndexMap::new();
    let mut unattributed: Option<Row> = None;
    for e in api_requests {
        let key = cause_key(e, dim);
        if key.is_empty() {
            fold(unattributed.get_or_insert(Row { cost_known: true, ..Row::default() }), e);
        } else {
            fold(by_key.entry(key).or_insert(Row { cost_known: true, ..Row::default() }), e);
        }
    }
    let mut named: Vec<(String, Row)> = by_key.into_iter().collect();
    // Stable, so equal-total causes keep first-seen order rather than reshuffling between runs.
    let total = |r: &Row| r.input + r.output + r.read + r.create;
    named.sort_by(|a, b| total(&b.1).partial_cmp(&total(&a.1)).unwrap_or(std::cmp::Ordering::Equal));
    let attributed_calls: f64 = named.iter().map(|(_, r)| r.calls).sum();
    let mut rows: Vec<Value> = named.iter().map(|(k, r)| row_value(dim, k, false, r)).collect();
    if let Some(u) = &unattributed {
        rows.push(row_value(dim, &unattributed_label(dim), true, u));
    }
    let mut m = Map::new();
    m.insert("dimension".into(), Value::String(dim.to_owned()));
    m.insert("rows".into(), Value::Array(rows));
    m.insert("attributedCalls".into(), num(attributed_calls));
    m.insert("unattributedCalls".into(), num(unattributed.map_or(0.0, |u| u.calls)));
    Value::Object(m)
}

/// `Number.prototype.toLocaleString()` in en-US: integer grouping by thousands with commas. Only
/// integers reach it here (a token remainder), so no fractional handling is needed.
fn locale_num(n: f64) -> String {
    let neg = n < 0.0;
    let digits = format!("{}", n.abs().trunc() as i64);
    let grouped: String = digits
        .as_bytes()
        .rchunks(3)
        .rev()
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(",");
    if neg {
        format!("-{grouped}")
    } else {
        grouped
    }
}

/// Group the api_request calls per cause dimension and sum buckets + cost.
///
/// `session_total_tokens` is the usage-bucket ground truth for reconciliation. `None` means the
/// caller has no reliable total (a multi-session window mixing token conventions) — the remainder is
/// then reported as NULL, not 0: "we cannot compute it" and "it reconciles perfectly" are opposite
/// claims, and conflating them manufactures a clean bill of health.
pub fn build_tokens_by_cause(
    timeline: &[Value],
    session_id: Option<&str>,
    sessions_scanned: Option<f64>,
    session_total_tokens: Option<f64>,
) -> Value {
    let api_requests: Vec<&Value> = timeline.iter().filter(|e| s(e, "type") == "api_request").collect();
    let dimensions: Vec<Value> = CAUSE_DIMENSIONS.iter().map(|d| rollup_dimension(&api_requests, d)).collect();

    let (mut in_tok, mut out_tok, mut read_tok, mut create_tok, mut cost, mut cost_calls) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for e in &api_requests {
        in_tok += f(e, "inputTokens");
        out_tok += f(e, "outputTokens");
        read_tok += f(e, "cacheReadTokens");
        create_tok += f(e, "cacheCreateTokens");
        if let Some(c) = e.get("costUsd").and_then(Value::as_f64).filter(|c| c.is_finite()) {
            cost += c;
            cost_calls += 1.0;
        }
    }
    let attributed_total = in_tok + out_tok + read_tok + create_tok;
    // SIGNED and never clamped: a negative remainder means the api_request events EXCEED the session
    // usage totals, which is a real ingestion-drift signal. Clamping it to 0 would hide that.
    let remainder = session_total_tokens.map(|t| t - attributed_total);

    let note = match remainder {
        None => "No usage-bucket ground truth supplied for this scope, so the unattributed remainder cannot be computed (reported null, never fabricated).".to_owned(),
        Some(0.0) => "The api_request events fully reconcile with the usage-bucket totals.".to_owned(),
        Some(r) => format!(
            "Signed remainder: {} tokens of the usage-bucket total were NOT covered by any api_request event (calls recorded before rich OTEL logging, or span/log ingestion drift). Negative = api_request events exceed the session usage totals.",
            locale_num(r)
        ),
    };

    let mut rec = Map::new();
    rec.insert("apiRequestCalls".into(), num(api_requests.len() as f64));
    rec.insert("attributedInputTokens".into(), num(in_tok));
    rec.insert("attributedOutputTokens".into(), num(out_tok));
    rec.insert("attributedCacheReadTokens".into(), num(read_tok));
    rec.insert("attributedCacheCreateTokens".into(), num(create_tok));
    rec.insert("attributedTotalTokens".into(), num(attributed_total));
    rec.insert("attributedCostUsd".into(), num(js_to_fixed_num(cost, 4)));
    rec.insert("costComplete".into(), Value::Bool(cost_calls == api_requests.len() as f64));
    rec.insert("costCalls".into(), num(cost_calls));
    rec.insert("sessionTotalTokens".into(), session_total_tokens.map_or(Value::Null, num));
    rec.insert("unattributedTotalTokens".into(), remainder.map_or(Value::Null, num));
    rec.insert("note".into(), Value::String(note));

    let mut m = Map::new();
    // `sessionId: opts.sessionId` / `sessionsScanned: opts.sessionsScanned` — DECLARED in the
    // literal, but an undefined option DROPS the key. The two callers are mutually exclusive (one
    // session vs a scanned window), so each report carries exactly one of them.
    if let Some(id) = session_id {
        m.insert("sessionId".into(), Value::String(id.to_owned()));
    }
    if let Some(n) = sessions_scanned {
        m.insert("sessionsScanned".into(), num(n));
    }
    m.insert("apiRequestCalls".into(), num(api_requests.len() as f64));
    m.insert("hasAttribution".into(), Value::Bool(!api_requests.is_empty()));
    m.insert("dimensions".into(), Value::Array(dimensions));
    m.insert("reconciliation".into(), Value::Object(rec));
    m.insert("estimated".into(), Value::Bool(false));
    m.insert("note".into(), if api_requests.is_empty() {
        "No claude_code.api_request events in this scope — per-cause attribution needs the rich OTEL log events (CLAUDE_CODE_ENABLE_TELEMETRY=1 with logs exported), or this is not a Claude Code session.".into()
    } else {
        "Grouped from the per-call api_request ground truth (exact usage buckets + cost_usd per call). Calls carrying no value for a dimension are in that dimension's pinned unattributed bucket — counted, never dropped.".into()
    });
    Value::Object(m)
}
