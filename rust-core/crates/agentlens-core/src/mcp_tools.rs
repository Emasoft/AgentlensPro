//! MCP tool handlers (TRDD-DMWOBWFH P4x.2) — the pure SHAPERS that turn an already-ported engine's
//! output into a tool payload.
//!
//! The TS keeps these deliberately separate from the engines (`handleGetX(engineResult, args)`), and
//! that split is preserved here: the engine does the I/O, the shaper is pure and testable, and the
//! route owns the async + the lock. Wire objects mirror the TS literals key-for-key in insertion
//! order; an `undefined` field is OMITTED, never null.

use serde_json::{Map, Value};

use crate::summarize::helpers::num;

/// `get_call_context` — the full literal context of ONE llm call.
///
/// The no-body path is an HONEST message, not an error and not a spinner: a call recorded before
/// raw-body logging was enabled genuinely has nothing to show, and TRDD-ICHAVFCS §6 records that
/// saying "check the previous turn" instead sent people hunting for data that was never captured.
pub fn get_call_context(ctx: Option<&Value>, session_id: &str, request_id: Option<&str>, span_id: Option<&str>) -> Value {
    let Some(ctx) = ctx.filter(|c| !c.is_null()) else {
        let mut m = Map::new();
        m.insert("sessionId".into(), Value::String(session_id.to_owned()));
        if let Some(r) = request_id {
            m.insert("requestId".into(), Value::String(r.to_owned()));
        }
        if let Some(s) = span_id {
            m.insert("spanId".into(), Value::String(s.to_owned()));
        }
        m.insert("message".into(), Value::String(
            "Raw API body not captured for this call (recorded before raw-body logging was enabled, or not a Claude Code session with OTEL_LOG_RAW_API_BODIES set).".into(),
        ));
        return Value::Object(m);
    };
    let empty: Vec<Value> = Vec::new();
    let blocks = ctx.get("blocks").and_then(Value::as_array).unwrap_or(&empty);
    let mut m = Map::new();
    m.insert("sessionId".into(), ctx.get("sessionId").cloned().unwrap_or(Value::Null));
    if let Some(r) = ctx.get("requestId") {
        m.insert("requestId".into(), r.clone());
    }
    if let Some(md) = ctx.get("model") {
        m.insert("model".into(), md.clone());
    }
    m.insert("truncated".into(), ctx.get("truncated").cloned().unwrap_or(Value::Bool(false)));
    m.insert("estimated".into(), Value::Bool(true));
    m.insert("blockCount".into(), num(blocks.len() as f64));
    m.insert(
        "totalTokens".into(),
        num(blocks.iter().map(|b| b.get("tokens").and_then(Value::as_f64).unwrap_or(0.0)).sum()),
    );
    // A re-projection, NOT the block verbatim: `tokenSource` is dropped and the key order is the
    // shaper's own. Passing the block through unchanged would ship a different wire shape.
    let projected: Vec<Value> = blocks
        .iter()
        .map(|b| {
            let mut o = Map::new();
            for k in ["id", "kind", "label", "tokens", "bytes", "role"] {
                o.insert(k.into(), b.get(k).cloned().unwrap_or(Value::Null));
            }
            if let Some(t) = b.get("toolName") {
                o.insert("toolName".into(), t.clone());
            }
            o.insert("text".into(), b.get("text").cloned().unwrap_or(Value::Null));
            Value::Object(o)
        })
        .collect();
    m.insert("blocks".into(), Value::Array(projected));
    Value::Object(m)
}

/// Every shaper's "no local log" message. Identical text in the TS for history and conversation.
const NO_LOG: &str = "No local Claude log to reconstruct (OTEL-only session, or its transcript is not on disk).";

fn msg(session_id: &str, text: &str) -> Value {
    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    m.insert("message".into(), Value::String(text.to_owned()));
    Value::Object(m)
}

/// Copy `key` from `src` into `dst` only when present — the TS literals name these fields
/// unconditionally, but an `undefined` value is dropped by JSON.stringify.
fn copy_opt(dst: &mut Map<String, Value>, src: &Value, key: &str) {
    if let Some(v) = src.get(key) {
        dst.insert(key.into(), v.clone());
    }
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn arr<'a>(v: &'a Value, k: &str, empty: &'a Vec<Value>) -> &'a Vec<Value> {
    v.get(k).and_then(Value::as_array).unwrap_or(empty)
}

/// Project a subset of a block's keys, in the ORDER the shaper names them (not the block's).
fn project(b: &Value, keys: &[&str], optional: &[&str]) -> Value {
    let mut o = Map::new();
    for k in keys {
        if optional.contains(k) {
            copy_opt(&mut o, b, k);
        } else {
            o.insert((*k).into(), b.get(*k).cloned().unwrap_or(Value::Null));
        }
    }
    Value::Object(o)
}

/// `get_context_composition` — per-turn source breakdown.
///
/// `turnCount` is the UNFILTERED total even when `turn` selects one: it answers "how many turns
/// does this session have", not "how many did you get back". Recomputing it after the filter would
/// silently report 1 for every drill.
pub fn get_context_composition(composition: Option<&Value>, session_id: &str, turn: Option<f64>) -> Value {
    let Some(c) = composition.filter(|c| !c.is_null()) else {
        return msg(session_id, "No local Claude log composition available for this session (OTEL-only or not a Claude session).");
    };
    let empty: Vec<Value> = Vec::new();
    let all = arr(c, "turns", &empty);
    let picked: Vec<&Value> = match turn {
        Some(t) => all.iter().filter(|x| f(x, "turn") == t).collect(),
        None => all.iter().collect(),
    };
    let mut m = Map::new();
    m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("estimated".into(), c.get("estimated").cloned().unwrap_or(Value::Null));
    m.insert("truncated".into(), c.get("truncated").cloned().unwrap_or(Value::Null));
    m.insert("turnCount".into(), num(all.len() as f64));
    let turns: Vec<Value> = picked
        .into_iter()
        .take(200)
        .map(|t| {
            let sources = arr(t, "sources", &empty);
            let mut o = Map::new();
            o.insert("turn".into(), t.get("turn").cloned().unwrap_or(Value::Null));
            o.insert("totalTokens".into(), num(sources.iter().map(|s| f(s, "tokens")).sum()));
            // Drops bytes / tokenSource / excerpt — a re-projection, not the source verbatim.
            o.insert(
                "sources".into(),
                Value::Array(sources.iter().map(|s| project(s, &["label", "kind", "tokens", "count"], &[])).collect()),
            );
            Value::Object(o)
        })
        .collect();
    m.insert("turns".into(), Value::Array(turns));
    Value::Object(m)
}

/// The per-step cost of a history step.
///
/// NOTE the TS subtracts cacheRead+cacheCreate from `input` with a max(0) floor before pricing.
/// Mirrored exactly rather than "corrected": whatever the upstream field means, changing the
/// arithmetic here would silently reprice every step in the tool's output.
///
/// **`model` here is the CARD's model ONLY — never the step's.** The TS `cost` closure captures
/// `card?.model`, while the emitted `model` FIELD is `step.model ?? card.model`. So a session whose
/// card carries no model reports each step's model but NO costUsd, even though a price could be
/// computed from the step's own model. Passing the merged model in prices steps the TS leaves
/// unpriced — caught by the oracle's `whole-no-card-model` case.
fn step_cost(usage: Option<&Value>, model: Option<&str>, now_ms: f64) -> Option<f64> {
    let (u, model) = (usage?, model.filter(|m| !m.is_empty())?);
    let (input, read, create, out) = (f(u, "input"), f(u, "cacheRead"), f(u, "cacheCreate"), f(u, "output"));
    let uncached = (input - read - create).max(0.0);
    Some(crate::summarize::helpers::js_to_fixed_num(
        crate::pricing::calc_token_cost_usd(uncached, read, create, out, model, 0.0, None, now_ms),
        4,
    ))
}

/// `get_context_history` — progressive drill: whole session → one step → one block.
pub fn get_context_history(
    history: Option<&Value>,
    card_model: Option<&str>,
    session_id: &str,
    turn: Option<f64>,
    block_id: Option<&str>,
    now_ms: f64,
) -> Value {
    let Some(h) = history.filter(|h| !h.is_null()) else { return msg(session_id, NO_LOG) };
    let empty: Vec<Value> = Vec::new();
    let steps = arr(h, "steps", &empty);
    if steps.is_empty() {
        if let Some(parent) = h.get("reconstructedFrom").and_then(Value::as_str) {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(session_id.to_owned()));
            m.insert("reconstructedFrom".into(), Value::String(parent.to_owned()));
            m.insert("message".into(), Value::String(format!(
                "This spawned session has no transcript of its own — its context lives in parent {parent}, whose log is not on disk to reconstruct."
            )));
            return Value::Object(m);
        }
    }
    let step_of = |t: f64| steps.iter().find(|s| f(s, "turn") == t);

    // Deepest drill: ONE block's full text, spread VERBATIM (keeps tokenSource — unlike the
    // step-level projection below, which drops it).
    if let (Some(t), Some(bid)) = (turn, block_id) {
        let block = step_of(t)
            .and_then(|s| arr(s, "blocks", &empty).iter().find(|b| b.get("id").and_then(Value::as_str) == Some(bid)));
        let mut m = Map::new();
        m.insert("sessionId".into(), Value::String(session_id.to_owned()));
        m.insert("turn".into(), num(t));
        match block {
            None => {
                m.insert("message".into(), Value::String(format!("No block {bid} at turn {}.", crate::summarize::helpers::fmt_js_num(t))));
            }
            Some(b) => {
                m.insert("block".into(), b.clone());
            }
        }
        return Value::Object(m);
    }

    // One step, WITH full block text.
    if let Some(t) = turn {
        let Some(s) = step_of(t) else {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(session_id.to_owned()));
            m.insert("turn".into(), num(t));
            m.insert("message".into(), Value::String(format!("No step at turn {}.", crate::summarize::helpers::fmt_js_num(t))));
            return Value::Object(m);
        };
        let model = s.get("model").and_then(Value::as_str).or(card_model);
        let mut m = Map::new();
        m.insert("sessionId".into(), Value::String(session_id.to_owned()));
        m.insert("turn".into(), s.get("turn").cloned().unwrap_or(Value::Null));
        copy_opt(&mut m, s, "timestamp");
        if let Some(md) = model {
            m.insert("model".into(), Value::String(md.to_owned()));
        }
        copy_opt(&mut m, s, "usage");
        if let Some(c) = step_cost(s.get("usage"), card_model, now_ms) {
            m.insert("costUsd".into(), num(c));
        }
        m.insert("diff".into(), s.get("diff").cloned().unwrap_or(Value::Null));
        m.insert(
            "blocks".into(),
            Value::Array(
                arr(s, "blocks", &empty)
                    .iter()
                    .map(|b| project(b, &["id", "kind", "label", "tokens", "bytes", "role", "toolName", "text"], &["toolName"]))
                    .collect(),
            ),
        );
        return Value::Object(m);
    }

    // Whole session: per-step SUMMARIES, no full text (drill with turn=N).
    let mut m = Map::new();
    m.insert("sessionId".into(), h.get("sessionId").cloned().unwrap_or(Value::Null));
    copy_opt(&mut m, h, "reconstructedFrom");
    m.insert("estimated".into(), h.get("estimated").cloned().unwrap_or(Value::Null));
    m.insert("truncated".into(), h.get("truncated").cloned().unwrap_or(Value::Null));
    m.insert("stepCount".into(), num(steps.len() as f64));
    let out: Vec<Value> = steps
        .iter()
        .take(500)
        .map(|s| {
            let blocks = arr(s, "blocks", &empty);
            let model = s.get("model").and_then(Value::as_str).or(card_model);
            let mut o = Map::new();
            o.insert("turn".into(), s.get("turn").cloned().unwrap_or(Value::Null));
            copy_opt(&mut o, s, "timestamp");
            if let Some(md) = model {
                o.insert("model".into(), Value::String(md.to_owned()));
            }
            copy_opt(&mut o, s, "usage");
            if let Some(c) = step_cost(s.get("usage"), card_model, now_ms) {
                o.insert("costUsd".into(), num(c));
            }
            o.insert("blockCount".into(), num(blocks.len() as f64));
            o.insert("totalTokens".into(), num(blocks.iter().map(|b| f(b, "tokens")).sum()));
            // The diff collapses to COUNTS here — the id lists live in the per-step drill.
            let d = s.get("diff").cloned().unwrap_or(Value::Null);
            let mut dm = Map::new();
            for (k, src) in [("added", "added"), ("changed", "changed"), ("removed", "removed")] {
                dm.insert(k.into(), num(arr(&d, src, &empty).len() as f64));
            }
            copy_opt(&mut dm, &d, "firstChangeBlockId");
            o.insert("diff".into(), Value::Object(dm));
            o.insert(
                "blocks".into(),
                Value::Array(blocks.iter().map(|b| project(b, &["id", "kind", "label", "tokens", "role"], &[])).collect()),
            );
            Value::Object(o)
        })
        .collect();
    m.insert("steps".into(), Value::Array(out));
    Value::Object(m)
}

const CONVERSATION_SUMMARY_TURN_CAP: usize = 500;
const CONVERSATION_RANGE_CAP: f64 = 20.0;

/// One turn, verbatim — every block with its full stored text.
fn verbatim_turn(t: &Value) -> Value {
    let empty: Vec<Value> = Vec::new();
    let mut o = Map::new();
    o.insert("turn".into(), t.get("turn").cloned().unwrap_or(Value::Null));
    o.insert("role".into(), t.get("role").cloned().unwrap_or(Value::Null));
    copy_opt(&mut o, t, "ts");
    copy_opt(&mut o, t, "model");
    copy_opt(&mut o, t, "sidechain");
    copy_opt(&mut o, t, "durationMs");
    copy_opt(&mut o, t, "usage");
    let blocks: Vec<Value> = arr(t, "blocks", &empty)
        .iter()
        .map(|b| {
            let mut m = Map::new();
            m.insert("kind".into(), b.get("kind").cloned().unwrap_or(Value::Null));
            copy_opt(&mut m, b, "toolName");
            copy_opt(&mut m, b, "toolUseId");
            copy_opt(&mut m, b, "tokens");
            copy_opt(&mut m, b, "meta");
            // `text ?? ''` — a block with no text (an image stub) still carries the key, empty.
            m.insert("text".into(), Value::String(b.get("text").and_then(Value::as_str).unwrap_or("").to_owned()));
            Value::Object(m)
        })
        .collect();
    o.insert("blocks".into(), Value::Array(blocks));
    Value::Object(o)
}

/// `get_conversation` — the narrative lens. Progressive drill-down IS the bounding strategy: the
/// no-arg shape carries per-turn SUMMARIES only, and full verbatim text comes back only for one
/// turn or a HARD-CAPPED range.
pub fn get_conversation(
    conv: Option<&Value>,
    session_id: &str,
    turn: Option<f64>,
    turn_from: Option<f64>,
    turn_to: Option<f64>,
) -> Value {
    let Some(c) = conv.filter(|c| !c.is_null()) else { return msg(session_id, NO_LOG) };
    let empty: Vec<Value> = Vec::new();
    let turns = arr(c, "turns", &empty);
    if turns.is_empty() {
        if let Some(parent) = c.get("reconstructedFrom").and_then(Value::as_str) {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(session_id.to_owned()));
            m.insert("reconstructedFrom".into(), Value::String(parent.to_owned()));
            m.insert("message".into(), Value::String(format!(
                "This spawned session has no transcript of its own — its conversation lives in parent {parent}, whose log is not on disk to reconstruct."
            )));
            return Value::Object(m);
        }
    }

    // One turn, verbatim.
    if let Some(t) = turn {
        let mut m = Map::new();
        match turns.iter().find(|x| f(x, "turn") == t) {
            None => {
                m.insert("sessionId".into(), Value::String(session_id.to_owned()));
                m.insert("turn".into(), num(t));
                m.insert("message".into(), Value::String(format!(
                    "No turn {} (session has {}).",
                    crate::summarize::helpers::fmt_js_num(t),
                    turns.len()
                )));
            }
            Some(found) => {
                m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
                if let Some(v) = verbatim_turn(found).as_object() {
                    for (k, val) in v {
                        m.insert(k.clone(), val.clone());
                    }
                }
            }
        }
        return Value::Object(m);
    }

    // Bounded verbatim range — `to` is clamped to from+CAP-1 even when turnTo asks for more, so a
    // caller cannot widen the window by asking.
    if turn_from.is_some() || turn_to.is_some() {
        let from = turn_from.unwrap_or(1.0).max(1.0);
        let ceiling = from + CONVERSATION_RANGE_CAP - 1.0;
        let to = turn_to.unwrap_or(ceiling).min(ceiling);
        let picked: Vec<Value> = turns
            .iter()
            .filter(|t| f(t, "turn") >= from && f(t, "turn") <= to)
            .map(verbatim_turn)
            .collect();
        let mut m = Map::new();
        m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
        m.insert("turnFrom".into(), num(from));
        m.insert("turnTo".into(), num(to));
        m.insert("rangeCap".into(), num(CONVERSATION_RANGE_CAP));
        m.insert("turns".into(), Value::Array(picked));
        return Value::Object(m);
    }

    // Whole session: header + per-turn summaries.
    let mut m = Map::new();
    m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
    for k in ["title", "agentName", "entrypoint", "cwd", "model"] {
        copy_opt(&mut m, c, k);
    }
    for k in ["totals", "compactions", "otherRecords", "truncated", "reconstructedFrom"] {
        copy_opt(&mut m, c, k);
    }
    m.insert("turnCount".into(), num(turns.len() as f64));
    let summaries: Vec<Value> = turns
        .iter()
        .take(CONVERSATION_SUMMARY_TURN_CAP)
        .map(|t| {
            let blocks = arr(t, "blocks", &empty);
            let first_text = blocks.iter().find(|b| {
                matches!(b.get("kind").and_then(Value::as_str), Some("userText" | "assistantText" | "systemNote"))
                    && b.get("text").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
            });
            let tools: Vec<Value> = blocks
                .iter()
                .filter(|b| b.get("kind").and_then(Value::as_str) == Some("toolUse"))
                .map(|b| Value::String(b.get("toolName").and_then(Value::as_str).unwrap_or("tool").to_owned()))
                .collect();
            let mut o = Map::new();
            o.insert("turn".into(), t.get("turn").cloned().unwrap_or(Value::Null));
            o.insert("role".into(), t.get("role").cloned().unwrap_or(Value::Null));
            copy_opt(&mut o, t, "ts");
            copy_opt(&mut o, t, "sidechain");
            copy_opt(&mut o, t, "durationMs");
            copy_opt(&mut o, t, "usage");
            o.insert("blockCount".into(), num(blocks.len() as f64));
            if !tools.is_empty() {
                o.insert("tools".into(), Value::Array(tools));
            }
            let preview = first_text.and_then(|b| b.get("text")).and_then(Value::as_str).unwrap_or("");
            o.insert("preview".into(), Value::String(crate::summarize::helpers::js_slice(preview, 100).to_owned()));
            Value::Object(o)
        })
        .collect();
    m.insert("turns".into(), Value::Array(summaries));
    Value::Object(m)
}

/// `get_window_budget` — the per-account budgets (LABELLED) plus the pooled machine-wide window.
///
/// `machineWide` is `burn.window`: every account's consumption pooled, which is what the pre-
/// per-account view showed. It is kept deliberately — the pooled number is the one that matches a
/// human's mental model of "the machine's window", and dropping it would make the tool answer a
/// different question than the one people ask it.
///
/// The `accountId` filter reuses the SAME labelling pass as the unfiltered form (labels first,
/// filter second). Filtering first and labelling the survivors would be equivalent today but
/// couples the label to the filter, and `account_label_for`'s null-bucket rule already depends on
/// seeing the window's own uuid rather than the caller's.
///
/// The empty-filter `message` is SPREAD LAST in the TS literal, so it appends — and it appears only
/// when an `accountId` was actually asked for. An unfiltered call that legitimately has no windows
/// gets `accounts: []` with NO message, because nothing was asked for and nothing is missing.
pub fn get_window_budget(burn: Option<&Value>, account: Option<&crate::burn::account_info::AccountInfo>, account_id: Option<&str>) -> Value {
    let Some(burn) = burn.filter(|b| !b.is_null()) else {
        let mut m = Map::new();
        m.insert("message".into(), Value::String(
            "Burn monitor unavailable in this runtime (no live session/statusline source wired).".into(),
        ));
        return Value::Object(m);
    };
    let labelled = crate::burn::runtime::label_burn_status_accounts(burn, account);
    let empty: Vec<Value> = Vec::new();
    let windows = labelled.get("accountWindows").and_then(Value::as_array).unwrap_or(&empty);
    let accounts: Vec<Value> = match account_id.filter(|a| !a.is_empty()) {
        Some(id) => windows.iter().filter(|w| w.get("accountUuid").and_then(Value::as_str) == Some(id)).cloned().collect(),
        None => windows.clone(),
    };
    let machine_wide = burn.get("window").cloned().unwrap_or(Value::Null);
    let cap_source = machine_wide.get("capacitySource").cloned().unwrap_or(Value::Null);
    let cap_observed = machine_wide.get("capacityObservedAt").cloned().unwrap_or(Value::Null);
    let mut m = Map::new();
    m.insert("accounts".into(), Value::Array(accounts.clone()));
    m.insert("machineWide".into(), machine_wide);
    m.insert("capacitySource".into(), cap_source);
    m.insert("capacityObservedAt".into(), cap_observed);
    if let Some(id) = account_id.filter(|a| !a.is_empty()) {
        if accounts.is_empty() {
            m.insert("message".into(), Value::String(format!("No consumption recorded for account {id} in the rolling windows.")));
        }
    }
    Value::Object(m)
}

/// `get_lifecycle_events` — the hook-event lifecycle slice, plus an HONEST account of whether the
/// store even exists.
///
/// `dirExists` and the `note` are the whole point of the shape. Without them an empty `events` list
/// is ambiguous: it reads identically whether nothing happened or the hooks were never installed,
/// and a caller can only conclude "quiet" from the first. The note therefore names the DIRECTORY
/// and the exact command that creates it, rather than saying "no events found".
///
/// The note is `undefined` on the happy path — so the key is OMITTED, never null and never an
/// empty string. The HTTP `/api/lifecycle-events` route carries no note at all: the dashboard has
/// its own empty state, an MCP caller has only this payload.
pub fn get_lifecycle_events(hook_events_dir: &str, dir_exists: bool, events: Vec<Value>) -> Value {
    let mut m = Map::new();
    m.insert("hookEventsDir".into(), Value::String(hook_events_dir.to_owned()));
    m.insert("dirExists".into(), Value::Bool(dir_exists));
    m.insert("count".into(), Value::from(events.len()));
    m.insert("events".into(), Value::Array(events));
    if !dir_exists {
        m.insert("note".into(), Value::String(format!(
            "No lifecycle hook-event store at {hook_events_dir} — run 'agentlenspro --install-hooks' then restart the session to capture /clear and other lifecycle events."
        )));
    }
    Value::Object(m)
}

/// THE token-economy choke point (mcpServer.ts, just after the dispatch switch): every tool result
/// is leanified before it leaves the server, with the caller's own `verbosity` / `maxTokens` args.
///
/// It lives here rather than in `mcp.rs` because it is POLICY, not protocol — `mcp.rs` stays a pure
/// JSON-RPC transport. And it is ONE function rather than a call per arm on purpose: the TS made the
/// same choice, and the reason is that a tool added later must not be able to opt out by forgetting.
pub fn tool_ok_lean(id: &Value, payload: &Value, args: &Value) -> Value {
    let full = args.get("verbosity").and_then(Value::as_str) == Some("full");
    let max_tokens = args.get("maxTokens").and_then(Value::as_f64);
    crate::mcp::tool_ok(id, &crate::lean_response::leanify(payload, full, max_tokens))
}

/// `windowFillPct` — COST first, raw tokens only as a fallback.
///
/// The plan's windows are metered by cost-equivalent, not token count (a cache read bills at 0.1×),
/// so with ~96% of volume being cache reads the raw-token percentage systematically OVERSTATES the
/// fill: a pooled 7d window read 171.51% by tokens while the cost figure for the same window read
/// 64.49%. And a capacity the consumption has already passed yields NULL, because the denominator is
/// then proven wrong and any percentage off it is noise wearing a number's clothes.
pub fn window_fill_pct(w: &Value) -> Value {
    if w.get("capacityExceeded") == Some(&Value::Bool(true)) {
        return Value::Null;
    }
    match w.get("pctConsumedCost") {
        Some(v) if !v.is_null() => v.clone(),
        _ => w.get("pctConsumed").cloned().unwrap_or(Value::Null),
    }
}

/// `get_account_status` — the current account (identity + plan), how much of ITS window is left, its
/// billing MODE, and the machine's cache-TTL regime. The OAuth token is never touched; only the plan
/// string.
///
/// `rate_limits` is Claude Code's OWN utilisation, which is authoritative when present and is
/// preferred over our calibrated figure. **It is None in this core: the statusline reader
/// (`StatuslineUsageAgg`) is NOT PORTED — the same gap `live_burn_status` already documents.** The
/// consequence is visible rather than silent: `windowSource` reports `calibrated` / `none` instead
/// of `cc-rate-limits`, so a reader can tell which number they are looking at.
///
/// `windowSource` distinguishes `calibrated-exceeded` from `calibrated` on purpose: a calibrated
/// capacity that consumption has already passed yields a null pct, and a bare `calibrated` + null is
/// indistinguishable from "we have no data" — a different, and much less urgent, situation.
pub fn get_account_status(
    account: Option<&crate::burn::account_info::AccountInfo>,
    burn: Option<&Value>,
    ttl_ctx: Option<&crate::burn::cache_ttl::TtlContext>,
    rate_limits: Option<&Value>,
) -> Value {
    // NB: the window match uses the RAW account, not the source-filtered one. Only the payload's
    // `account`/`plan` fields consult `source !== 'none'`; narrowing here too would silently stop
    // matching a window for an account whose identity file is missing but whose uuid is known.
    let uuid = account.and_then(|a| a.account_uuid.as_deref());
    let win = burn
        .and_then(|b| b.get("accountWindows"))
        .and_then(Value::as_array)
        .and_then(|ws| ws.iter().find(|w| w.get("accountUuid").and_then(Value::as_str) == uuid));

    let auth_regime = crate::account_state_timeline::resolve_auth_regime_label(account, ttl_ctx);
    // Always 'main' — get_account_status IS a main-conversation tool. A null ctx yields the honest
    // 'assumed' 5-minute floor rather than a confident guess.
    let ttl_regime = crate::burn::cache_ttl::classify_ttl_regime(Some(crate::burn::cache_ttl::SessionTtlKind::Main), ttl_ctx);

    let mut usage_windows = Map::new();
    let cc = rate_limits.filter(|r| {
        !r.get("fiveHourUtilization").unwrap_or(&Value::Null).is_null()
            || !r.get("sevenDayUtilization").unwrap_or(&Value::Null).is_null()
    });
    if let Some(r) = cc {
        usage_windows.insert("fiveHourPct".into(), r.get("fiveHourUtilization").cloned().unwrap_or(Value::Null));
        usage_windows.insert("sevenDayPct".into(), r.get("sevenDayUtilization").cloned().unwrap_or(Value::Null));
        usage_windows.insert("windowSource".into(), "cc-rate-limits".into());
    } else if let Some(b) = win.map(|w| &w["budget"]).filter(|b| b.get("capacityConfigured") == Some(&Value::Bool(true))) {
        let exceeded = |k: &str| b[k].get("capacityExceeded") == Some(&Value::Bool(true));
        usage_windows.insert("fiveHourPct".into(), window_fill_pct(&b["fiveHour"]));
        usage_windows.insert("sevenDayPct".into(), window_fill_pct(&b["sevenDay"]));
        usage_windows.insert(
            "windowSource".into(),
            if exceeded("fiveHour") || exceeded("sevenDay") { "calibrated-exceeded" } else { "calibrated" }.into(),
        );
    } else {
        usage_windows.insert("fiveHourPct".into(), Value::Null);
        usage_windows.insert("sevenDayPct".into(), Value::Null);
        usage_windows.insert("windowSource".into(), "none".into());
    }

    let resolved = account.filter(|a| a.source != "none");
    let plan = resolved.map_or_else(
        || "unknown".to_owned(),
        |a| crate::account_state_timeline::describe_plan(a.plan_type.as_deref(), a.rate_limit_tier.as_deref()),
    );
    let mode = crate::account_state_timeline::describe_account_mode(auth_regime.as_deref());
    let mut cache_ttl = Map::new();
    cache_ttl.insert("minutes".into(), num(ttl_regime.ttl_assumed_min));
    cache_ttl.insert("regime".into(), auth_regime.clone().unwrap_or_else(|| "unknown".to_owned()).into());
    cache_ttl.insert("ttlSource".into(), ttl_regime.ttl_source.into());
    cache_ttl.insert("basis".into(), ttl_regime.ttl_basis.clone().into());

    // The one-line human digest, so a reader gets the gist without parsing the object.
    // `email ?? label ?? '…'` is NULLISH, not falsy: an EMPTY label is kept, it does not fall
    // through to "account unresolved". Only an absent account does.
    let email_str = account
        .and_then(|a| a.email.clone().or_else(|| Some(a.label.clone())))
        .unwrap_or_else(|| "account unresolved".to_owned());
    let pct = |v: &Value| match v.as_f64() {
        Some(n) => format!("{}%", crate::summarize::helpers::js_math_round(n)),
        None => "n/a".to_owned(),
    };
    let summary = format!(
        "{email_str} · {plan} · {mode} · 5h {} / 7d {} ({}) · cache TTL {}min ({})",
        pct(&usage_windows["fiveHourPct"]),
        pct(&usage_windows["sevenDayPct"]),
        usage_windows["windowSource"].as_str().unwrap_or(""),
        crate::summarize::helpers::fmt_js_num(ttl_regime.ttl_assumed_min),
        ttl_regime.ttl_source,
    );

    let os = |v: &Option<String>| v.clone().map_or(Value::Null, Value::from);
    let account_obj = match resolved {
        Some(a) => {
            let mut m = Map::new();
            m.insert("accountId".into(), os(&a.account_uuid));
            m.insert("label".into(), a.label.clone().into());
            m.insert("email".into(), os(&a.email));
            m.insert("organizationName".into(), os(&a.organization_name));
            m.insert("planType".into(), os(&a.plan_type));
            m.insert("billingType".into(), os(&a.billing_type));
            m.insert("hasExtraUsageEnabled".into(), Value::Bool(a.has_extra_usage_enabled));
            m.insert("rateLimitTier".into(), os(&a.rate_limit_tier));
            Value::Object(m)
        }
        None => {
            let mut m = Map::new();
            m.insert("planType".into(), account.map_or(Value::Null, |a| os(&a.plan_type)));
            m.insert("note".into(), "No ~/.claude.json oauthAccount found — identity unresolved.".into());
            Value::Object(m)
        }
    };

    let window_obj = match win {
        Some(w) => {
            let b = &w["budget"];
            let g = |win_key: &str, k: &str| b[win_key].get(k).cloned().unwrap_or(Value::Null);
            let mut m = Map::new();
            m.insert("fiveHourPctConsumed".into(), g("fiveHour", "pctConsumed"));
            m.insert("fiveHourPctConsumedCost".into(), g("fiveHour", "pctConsumedCost"));
            m.insert("sevenDayPctConsumed".into(), g("sevenDay", "pctConsumed"));
            m.insert("sevenDayPctConsumedCost".into(), g("sevenDay", "pctConsumedCost"));
            m.insert("fiveHourMinutesToExhaustion".into(), g("fiveHour", "minutesToExhaustion"));
            m.insert("sevenDayMinutesToExhaustion".into(), g("sevenDay", "minutesToExhaustion"));
            m.insert("consumedTokens5h".into(), g("fiveHour", "consumedTokens"));
            m.insert("consumedCostUsd5h".into(), g("fiveHour", "consumedCostUsd"));
            m.insert("capacityConfigured".into(), b.get("capacityConfigured").cloned().unwrap_or(Value::Null));
            m.insert("capacitySource".into(), b.get("capacitySource").cloned().unwrap_or(Value::Null));
            m.insert("capacityObservedAt".into(), b.get("capacityObservedAt").cloned().unwrap_or(Value::Null));
            Value::Object(m)
        }
        None => Value::Null,
    };

    let mut m = Map::new();
    m.insert("summary".into(), summary.into());
    m.insert("plan".into(), plan.into());
    m.insert("mode".into(), mode.into());
    m.insert("cacheTtl".into(), Value::Object(cache_ttl));
    m.insert("usageWindows".into(), Value::Object(usage_windows));
    m.insert("account".into(), account_obj);
    m.insert("window".into(), window_obj);
    // Three DIFFERENT causes of a missing percentage, named apart: no account id at all, an account
    // with no consumption yet, and consumption with no capacity to measure it against. The fourth
    // case — everything is fine — is `undefined`, so the key is OMITTED.
    let note = if uuid.is_none() {
        Some("Current account id is unresolved, so no per-account window could be matched. Enable OTEL raw bodies / metrics so sessions attribute to an account.")
    } else if win.is_none() {
        Some("No consumption recorded yet for the current account in the rolling windows.")
    } else if win.unwrap()["budget"].get("capacityConfigured") == Some(&Value::Bool(true)) {
        None
    } else {
        Some("Window % is null until a capacity is configured (AGENTLENS_WINDOW_5H_TOKENS / _COST_USD or ~/.agentlens/burn-config.json) — or until AgentlensPro auto-calibrates one from the next rate-limit hit (P5).")
    };
    if let Some(n) = note {
        m.insert("note".into(), n.into());
    }
    Value::Object(m)
}
