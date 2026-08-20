//! MCP tool handlers (TRDD-DMWOBWFH P4x.2) — the pure SHAPERS that turn an already-ported engine's
//! output into a tool payload.
//!
//! The TS keeps these deliberately separate from the engines (`handleGetX(engineResult, args)`), and
//! that split is preserved here: the engine does the I/O, the shaper is pure and testable, and the
//! route owns the async + the lock. Wire objects mirror the TS literals key-for-key in insertion
//! order; an `undefined` field is OMITTED, never null.

use serde_json::{Map, Value};

use crate::summarize::helpers::{fmt_js_num, js_slice, js_to_fixed_num, num, truthy};

/// JS `String.prototype.length` — UTF-16 code units, never bytes and never chars.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

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

/// `sessionCost` — the four token buckets are DISJOINT, so each bills at its own rate and nothing is
/// subtracted anywhere. `inputTokens` is RAW uncached input on every card; the read-time
/// "inputTokens < cache means it includes cache" heuristic that used to live here was structurally
/// unsound (a raw-convention card whose input happened to exceed its cache total was misclassified
/// and silently under-counted) and was retired when the convention moved to the ingestion sites.
fn session_cost(s: &Value, now_ms: f64) -> f64 {
    crate::pricing::calc_token_cost_usd(
        f(s, "inputTokens"),
        f(s, "cacheReadTokens"),
        f(s, "cacheCreateTokens"),
        f(s, "outputTokens"),
        s.get("model").and_then(Value::as_str).unwrap_or(""),
        0.0,
        None,
        now_ms,
    )
}

/// A session counts toward cache-health SLIs only when it actually EXERCISED the cache. Junk rows
/// (synthetic empties, zero-token cards) all carry `cacheHitRate: 0`, so averaging them in drags the
/// SLI toward 0 with no billing behind it — the average would describe the junk, not the cache.
fn is_cache_measured(s: &Value) -> bool {
    let traffic = f(s, "inputTokens") + f(s, "outputTokens") + f(s, "cacheReadTokens") + f(s, "cacheCreateTokens");
    f(s, "totalLlmCalls") > 0.0 && traffic > 0.0
}

const ACTIVE_WINDOW_MS: f64 = 5.0 * 60_000.0;

/// `Array.prototype.slice(0, n)` — a NEGATIVE `n` counts back from the end and drops the last |n|
/// elements. `take()` would silently return everything instead. Reachable here: the limit is
/// `Math.min(args.limit ?? 10, 50)`, which passes a caller's negative through unclamped.
fn js_head(v: &[Value], n: i64) -> Vec<Value> {
    let end = if n < 0 { (v.len() as i64 + n).max(0) } else { n.min(v.len() as i64) } as usize;
    v[..end].to_vec()
}

/// `get_recent_sessions` — "recent" means recently ACTIVE, not recently STARTED.
///
/// The caller's list is start-date ordered, which buries a long-running session still emitting spans
/// NOW beneath fresh idle ones — live-confirmed as 4 actively-emitting sessions missing from the
/// default top-10. So the rank is recomputed here on start + duration, and the caller's order is
/// never trusted. This is the one place it matters.
pub fn get_recent_sessions(sessions: &[Value], agent: Option<&str>, workspace: Option<&str>, limit: Option<f64>, now_ms: f64) -> Value {
    let filtered: Vec<&Value> = sessions
        .iter()
        .filter(|s| agent.is_none_or(|a| s.get("source").and_then(Value::as_str) == Some(a)))
        .filter(|s| {
            workspace.is_none_or(|w| {
                s.get("sessionId").and_then(Value::as_str).unwrap_or("").contains(w)
                    || s.get("userRequest").and_then(Value::as_str).unwrap_or("").contains(w)
            })
        })
        .collect();
    let last_active = |s: &Value| -> f64 {
        // `Date.parse(...) || 0` — an UNPARSEABLE date is 0, not NaN, so such a card sorts last
        // instead of poisoning the comparator.
        let started = s.get("startTime").and_then(Value::as_str).and_then(crate::summarize::helpers::parse_iso_ms).unwrap_or(0.0);
        started + f(s, "durationMs")
    };
    let limit = limit.unwrap_or(10.0).min(50.0) as i64;
    let mut ranked: Vec<&Value> = filtered.clone();
    // Stable, like Array.prototype.sort — equal-activity cards keep the caller's relative order.
    ranked.sort_by(|a, b| last_active(b).partial_cmp(&last_active(a)).unwrap_or(std::cmp::Ordering::Equal));
    let ranked: Vec<Value> = ranked.into_iter().cloned().collect();
    let rows: Vec<Value> = js_head(&ranked, limit)
        .iter()
        .map(|s| {
            let la = last_active(s);
            let start = s.get("startTime").and_then(Value::as_str).unwrap_or("");
            let mut m = Map::new();
            m.insert("sessionId".into(), s.get("sessionId").cloned().unwrap_or(Value::Null));
            m.insert("date".into(), Value::String(js_slice(start, 16).replacen('T', " ", 1)));
            m.insert(
                "lastActive".into(),
                Value::String(js_slice(&crate::summarize::helpers::iso_from_ms(la), 16).replacen('T', " ", 1)),
            );
            // Rides only on LIVE sessions — absent means idle, never a `false`. A false would read
            // as a measurement ("we checked, it is not active") on cards where nothing was checked.
            if now_ms - la < ACTIVE_WINDOW_MS {
                m.insert("active".into(), Value::Bool(true));
            }
            for k in ["title", "entrypoint"] {
                if let Some(v) = s.get(k).filter(|v| truthy(v)) {
                    m.insert(k.into(), v.clone());
                }
            }
            m.insert("agent".into(), s.get("source").cloned().unwrap_or(Value::Null));
            m.insert("model".into(), s.get("model").cloned().unwrap_or(Value::Null));
            let prompt = s.get("userRequest").and_then(Value::as_str).filter(|p| !p.is_empty());
            m.insert(
                "prompt".into(),
                match prompt {
                    Some(p) => Value::String(format!("{}{}", js_slice(p, 120), if utf16_len(p) > 120 { "…" } else { "" })),
                    None => Value::Null,
                },
            );
            m.insert("turns".into(), s.get("totalLlmCalls").cloned().unwrap_or(Value::Null));
            m.insert("cost_usd".into(), num(js_to_fixed_num(session_cost(s, now_ms), 4)));
            m.insert("durationMin".into(), num(js_to_fixed_num(f(s, "durationMs") / 60_000.0, 1)));
            m.insert("errors".into(), s.get("errors").cloned().unwrap_or(Value::Null));
            // P7 provenance: which feed backs this row's numbers. `null` = a pre-P7 card, which is
            // "unknown" — never a backfilled guess.
            m.insert("tokensSource".into(), s.get("tokensSource").cloned().unwrap_or(Value::Null));
            if let Some(v) = s.get("coverageNote").filter(|v| truthy(v)) {
                m.insert("coverageNote".into(), v.clone());
            }
            m.insert("topTools".into(), Value::Array(top_counts(s.get("toolCounts"), 4, |t, n| format!("{t}×{}", fmt_js_num(n)))));
            m.insert(
                "loopSignals".into(),
                Value::Array(
                    s.get("loopSignals")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().map(|l| l.get("type").cloned().unwrap_or(Value::Null)).collect())
                        .unwrap_or_default(),
                ),
            );
            m.insert(
                "filesChanged".into(),
                Value::Array(s.get("filesChanged").and_then(Value::as_array).map(|a| a.iter().take(5).cloned().collect()).unwrap_or_default()),
            );
            Value::Object(m)
        })
        .collect();
    Value::Array(rows)
}

/// The top-N entries of a `{key: count}` object, highest first, rendered by `render`.
/// IndexMap semantics: JS builds these with `Object.entries` (insertion order) and a STABLE sort, so
/// equal counts keep their original order on both engines.
fn top_counts(counts: Option<&Value>, n: usize, render: impl Fn(&str, f64) -> String) -> Vec<Value> {
    let Some(o) = counts.and_then(Value::as_object) else { return Vec::new() };
    let mut entries: Vec<(&String, f64)> = o.iter().map(|(k, v)| (k, v.as_f64().unwrap_or(0.0))).collect();
    entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    entries.iter().take(n).map(|(k, v)| Value::String(render(k, *v))).collect()
}

/// A `{key: count}` frequency table, insertion-ordered so a stable sort ties the same way JS does.
fn freq_entries(map: &indexmap::IndexMap<String, f64>) -> Vec<(String, f64)> {
    let mut v: Vec<(String, f64)> = map.iter().map(|(k, n)| (k.clone(), *n)).collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    v
}

/// `get_workspace_patterns` — hot files, top tools, loop signals and per-agent averages.
///
/// NOTE: the TS accepts a `workspace` arg and NEVER USES IT (only `days` filters). Mirrored rather
/// than "fixed": the frozen schema advertises the parameter, so honouring it here would make the
/// Rust core answer a narrower question than the TS for the same call — a silent behaviour fork,
/// which is worse than a parameter that visibly does nothing.
///
/// The cache-hit SLI averages ONLY cache-measured sessions, and the exclusion is LABELLED in the
/// payload rather than silent: junk rows all read 0% and would drag the average toward 0 with no
/// billing behind it, so a reader must be able to see how many sessions actually back the number.
pub fn get_workspace_patterns(sessions: &[Value], days: Option<f64>, now_ms: f64) -> Value {
    let filtered: Vec<&Value> = match days.filter(|d| *d != 0.0) {
        Some(d) => {
            let cutoff = now_ms - d * 86_400_000.0;
            sessions
                .iter()
                .filter(|s| {
                    // `Date.parse(x) >= cutoff` — an UNPARSEABLE date is NaN and NaN >= x is FALSE,
                    // so such a card is excluded. `unwrap_or(0.0)` would let it through when the
                    // cutoff is negative; the explicit `is_none_or(false)` keeps the JS semantics.
                    s.get("startTime")
                        .and_then(Value::as_str)
                        .and_then(crate::summarize::helpers::parse_iso_ms)
                        .is_some_and(|t| t >= cutoff)
                })
                .collect()
        }
        None => sessions.iter().collect(),
    };
    if filtered.is_empty() {
        let mut m = Map::new();
        m.insert("message".into(), "No sessions found matching the filters.".into());
        return Value::Object(m);
    }
    let n = filtered.len() as f64;

    let mut file_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let mut tool_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let mut signal_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let mut agent_map: indexmap::IndexMap<String, (f64, f64, f64)> = indexmap::IndexMap::new();
    let (mut total_cost, mut total_turns, mut error_sessions) = (0.0, 0.0, 0.0);
    let (mut total_cache, mut cache_measured) = (0.0, 0.0);
    for s in &filtered {
        for key in ["filesRead", "filesChanged"] {
            for file in s.get(key).and_then(Value::as_array).unwrap_or(&Vec::new()) {
                if let Some(f) = file.as_str() {
                    *file_freq.entry(f.to_owned()).or_insert(0.0) += 1.0;
                }
            }
        }
        if let Some(o) = s.get("toolCounts").and_then(Value::as_object) {
            for (t, c) in o {
                *tool_freq.entry(t.clone()).or_insert(0.0) += c.as_f64().unwrap_or(0.0);
            }
        }
        for sig in s.get("loopSignals").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            if let Some(t) = sig.get("type").and_then(Value::as_str) {
                *signal_freq.entry(t.to_owned()).or_insert(0.0) += 1.0;
            }
        }
        let cost = session_cost(s, now_ms);
        total_cost += cost;
        total_turns += f(s, "totalLlmCalls");
        if f(s, "errors") > 0.0 {
            error_sessions += 1.0;
        }
        if is_cache_measured(s) {
            cache_measured += 1.0;
            total_cache += f(s, "cacheHitRate");
        }
        let key = format!(
            "{}/{}",
            crate::summarize::helpers::js_string(s.get("source").unwrap_or(&Value::Null)),
            crate::summarize::helpers::js_string(s.get("model").unwrap_or(&Value::Null))
        );
        let e = agent_map.entry(key).or_insert((0.0, 0.0, 0.0));
        e.0 += 1.0;
        e.1 += cost;
        e.2 += f(s, "totalLlmCalls");
    }

    let hot_files: Vec<Value> = freq_entries(&file_freq)
        .iter()
        .take(15)
        .map(|(file, count)| {
            let mut m = Map::new();
            m.insert("file".into(), Value::String(file.clone()));
            m.insert("sessions".into(), num(*count));
            m.insert("pct".into(), num(crate::summarize::helpers::js_math_round(count / n * 100.0)));
            Value::Object(m)
        })
        .collect();
    let top_tools: Vec<Value> = freq_entries(&tool_freq)
        .iter()
        .take(8)
        .map(|(tool, total)| {
            let mut m = Map::new();
            m.insert("tool".into(), Value::String(tool.clone()));
            m.insert("total".into(), num(*total));
            Value::Object(m)
        })
        .collect();
    // No slice on this one — every distinct loop signal is reported.
    let loop_signals: Vec<Value> = freq_entries(&signal_freq)
        .iter()
        .map(|(t, count)| {
            let mut m = Map::new();
            m.insert("type".into(), Value::String(t.clone()));
            m.insert("count".into(), num(*count));
            Value::Object(m)
        })
        .collect();
    let mut agents: Vec<(&String, &(f64, f64, f64))> = agent_map.iter().collect();
    agents.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap_or(std::cmp::Ordering::Equal));
    let agent_breakdown: Vec<Value> = agents
        .iter()
        .take(6)
        .map(|(key, v)| {
            let mut m = Map::new();
            m.insert("agentModel".into(), Value::String((*key).clone()));
            m.insert("sessions".into(), num(v.0));
            m.insert("avgCost".into(), num(js_to_fixed_num(v.1 / v.0, 4)));
            m.insert("avgTurns".into(), num(js_to_fixed_num(v.2 / v.0, 1)));
            Value::Object(m)
        })
        .collect();

    let mut m = Map::new();
    m.insert("sessionCount".into(), num(n));
    m.insert("avgCostUsd".into(), num(js_to_fixed_num(total_cost / n, 4)));
    m.insert("avgTurns".into(), num(js_to_fixed_num(total_turns / n, 1)));
    // A STRING with a '%' — `+x.toFixed(0) + '%'` in the TS, so the number is rounded first and
    // then concatenated. 'n/a' when nothing backs it, never a 0% that reads as a measurement.
    m.insert(
        "avgCacheHitRate".into(),
        Value::String(if cache_measured > 0.0 {
            format!("{}%", fmt_js_num(js_to_fixed_num(total_cache / cache_measured * 100.0, 0)))
        } else {
            "n/a".to_owned()
        }),
    );
    m.insert("cacheMeasuredSessions".into(), num(cache_measured));
    m.insert("cacheExcludedJunkSessions".into(), num(n - cache_measured));
    m.insert("errorRate".into(), Value::String(format!("{}%", fmt_js_num(crate::summarize::helpers::js_math_round(error_sessions / n * 100.0)))));
    m.insert("hotFiles".into(), Value::Array(hot_files));
    m.insert("topTools".into(), Value::Array(top_tools));
    m.insert("loopSignals".into(), Value::Array(loop_signals));
    m.insert("agentBreakdown".into(), Value::Array(agent_breakdown));
    Value::Object(m)
}

/// `find_relevant_context` — "have we done something like this before?"
///
/// The task is reduced to words LONGER than 3 characters, after everything outside
/// `[a-z0-9\s/_.]` is blanked. The length floor is what stops "the", "for" and "and" from matching
/// every session ever recorded; the surviving punctuation (`/`, `_`, `.`) is what keeps a path or a
/// filename as ONE word instead of shattering it.
pub fn find_relevant_context(sessions: &[Value], task: &str, now_ms: f64) -> Value {
    let cleaned: String = task
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c.is_whitespace() || c == '/' || c == '_' || c == '.' { c } else { ' ' })
        .collect();
    // A Set: DEDUPED, and insertion-ordered so the overlap count is deterministic.
    let mut task_words: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for w in cleaned.split_whitespace() {
        if utf16_len(w) > 3 {
            task_words.insert(w.to_owned());
        }
    }
    if task_words.is_empty() {
        let mut m = Map::new();
        m.insert("message".into(), "Task description too short to match against history.".into());
        return Value::Object(m);
    }
    let mut scored: Vec<(&Value, usize)> = sessions
        .iter()
        .map(|s| {
            let req = s.get("userRequest").and_then(Value::as_str).unwrap_or("").to_lowercase();
            (s, task_words.iter().filter(|w| req.contains(w.as_str())).count())
        })
        .filter(|(_, score)| *score > 0)
        .collect();
    // Descending, and STABLE — equal-overlap sessions keep the caller's order, as JS's sort does.
    scored.sort_by_key(|(_, score)| std::cmp::Reverse(*score));
    let similar: Vec<&Value> = scored.iter().take(15).map(|(s, _)| *s).collect();
    if similar.is_empty() {
        let mut m = Map::new();
        m.insert("message".into(), "No past sessions closely match this task description. No history to draw from yet.".into());
        return Value::Object(m);
    }
    let n = similar.len() as f64;

    let mut file_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let mut sig_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let (mut costs, mut turns): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    for s in &similar {
        for key in ["filesRead", "filesChanged"] {
            for file in s.get(key).and_then(Value::as_array).unwrap_or(&Vec::new()) {
                if let Some(f) = file.as_str() {
                    *file_freq.entry(f.to_owned()).or_insert(0.0) += 1.0;
                }
            }
        }
        for sig in s.get("loopSignals").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            if let Some(t) = sig.get("type").and_then(Value::as_str) {
                *sig_freq.entry(t.to_owned()).or_insert(0.0) += 1.0;
            }
        }
        costs.push(session_cost(s, now_ms));
        turns.push(f(s, "totalLlmCalls"));
    }
    let relevant_files: Vec<Value> = freq_entries(&file_freq)
        .iter()
        .take(12)
        .map(|(file, count)| {
            let mut m = Map::new();
            m.insert("file".into(), Value::String(file.clone()));
            m.insert("appearsIn".into(), num(*count));
            m.insert("pct".into(), num(crate::summarize::helpers::js_math_round(count / n * 100.0)));
            Value::Object(m)
        })
        .collect();
    let known_traps: Vec<Value> = freq_entries(&sig_freq)
        .iter()
        .take(4)
        .map(|(t, count)| Value::String(format!("{t} ({}/{} similar sessions)", fmt_js_num(*count), fmt_js_num(n))))
        .collect();

    let mut est = Map::new();
    est.insert("min".into(), num(js_to_fixed_num(costs.iter().cloned().fold(f64::INFINITY, f64::min), 3)));
    est.insert("avg".into(), num(js_to_fixed_num(costs.iter().sum::<f64>() / n, 3)));
    est.insert("max".into(), num(js_to_fixed_num(costs.iter().cloned().fold(f64::NEG_INFINITY, f64::max), 3)));
    let mut m = Map::new();
    m.insert("matchedSessions".into(), num(n));
    m.insert("estimatedCostUsd".into(), Value::Object(est));
    m.insert("estimatedTurns".into(), num(js_to_fixed_num(turns.iter().sum::<f64>() / n, 1)));
    m.insert("relevantFiles".into(), Value::Array(relevant_files.clone()));
    // Explicit NULL, not an omitted key and not an empty array: "we looked and found no recurring
    // traps" is a real answer, and an empty array reads the same as a field that was never filled.
    m.insert("knownTraps".into(), if known_traps.is_empty() { Value::Null } else { Value::Array(known_traps) });
    m.insert(
        "tip".into(),
        if relevant_files.is_empty() {
            Value::Null
        } else {
            Value::String(format!(
                "Consider mentioning these files upfront: {}",
                relevant_files.iter().take(3).filter_map(|f| f.get("file").and_then(Value::as_str)).collect::<Vec<_>>().join(", ")
            ))
        },
    );
    Value::Object(m)
}

/// `get_efficiency_report` — the cost trend, the agent ranking, and the cache-health SLI.
///
/// The trend splits the window in HALF and compares averages, with a ±15% dead band so ordinary
/// variance does not read as a movement. `avgFirst == 0` is 'no data' rather than an infinite
/// increase — with no first half to compare against, any ratio would be meaningless.
///
/// Junk rows are excluded-but-COUNTED from the cache SLI: they all read 0%, so they would both
/// dilute the average AND monopolise `worstSessions` with rows that never billed anything.
pub fn get_efficiency_report(sessions: &[Value], days: Option<f64>, now_ms: f64) -> Value {
    let cutoff_days = days.unwrap_or(30.0);
    let cutoff = now_ms - cutoff_days * 86_400_000.0;
    let started = |s: &Value| s.get("startTime").and_then(Value::as_str).and_then(crate::summarize::helpers::parse_iso_ms);
    let recent: Vec<&Value> = sessions.iter().filter(|s| started(s).is_some_and(|t| t >= cutoff)).collect();
    if recent.is_empty() {
        let mut m = Map::new();
        m.insert("message".into(), Value::String(format!("No sessions in the last {} days.", fmt_js_num(cutoff_days))));
        return Value::Object(m);
    }
    let n = recent.len() as f64;
    let mid = now_ms - (cutoff_days / 2.0) * 86_400_000.0;
    let half_avg = |before: bool| -> f64 {
        let h: Vec<&&Value> = recent.iter().filter(|s| started(s).is_some_and(|t| if before { t < mid } else { t >= mid })).collect();
        if h.is_empty() { 0.0 } else { h.iter().map(|s| session_cost(s, now_ms)).sum::<f64>() / h.len() as f64 }
    };
    let (avg_first, avg_second) = (half_avg(true), half_avg(false));
    let trend = if avg_first == 0.0 {
        "no data"
    } else if avg_second > avg_first * 1.15 {
        "increasing ↑"
    } else if avg_second < avg_first * 0.85 {
        "decreasing ↓"
    } else {
        "stable →"
    };

    let mut sig_freq: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    let mut agent_map: indexmap::IndexMap<String, (f64, f64, f64, f64)> = indexmap::IndexMap::new();
    let (mut total_cost, mut total_turns, mut error_sessions) = (0.0, 0.0, 0.0);
    let mut measured: Vec<&&Value> = Vec::new();
    for s in &recent {
        for sig in s.get("loopSignals").and_then(Value::as_array).unwrap_or(&Vec::new()) {
            if let Some(t) = sig.get("type").and_then(Value::as_str) {
                *sig_freq.entry(t.to_owned()).or_insert(0.0) += 1.0;
            }
        }
        let cost = session_cost(s, now_ms);
        total_cost += cost;
        total_turns += f(s, "totalLlmCalls");
        if f(s, "errors") > 0.0 {
            error_sessions += 1.0;
        }
        if is_cache_measured(s) {
            measured.push(s);
        }
        // `${source}/${model || 'unknown'}` — FALSY-or, so an EMPTY model becomes 'unknown' here.
        // NOTE get_workspace_patterns does NOT do this; its key is a bare `${model}`. Two tools,
        // two spellings of the same key — mirrored rather than unified, because unifying them would
        // change one tool's output.
        let model = s.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("unknown");
        let key = format!("{}/{model}", crate::summarize::helpers::js_string(s.get("source").unwrap_or(&Value::Null)));
        let e = agent_map.entry(key).or_insert((0.0, 0.0, 0.0, 0.0));
        e.0 += 1.0;
        e.1 += cost;
        e.2 += f(s, "totalLlmCalls");
        e.3 += f(s, "errors");
    }
    let top_signals: Vec<Value> = freq_entries(&sig_freq)
        .iter()
        .map(|(t, count)| {
            let mut m = Map::new();
            m.insert("type".into(), Value::String(t.clone()));
            m.insert("count".into(), num(*count));
            m.insert("rate".into(), Value::String(format!("{}%", fmt_js_num(crate::summarize::helpers::js_math_round(count / n * 100.0)))));
            Value::Object(m)
        })
        .collect();
    // `n >= 2` — a single session is an anecdote, not a ranking. Sorted ASCENDING: cheapest first,
    // because the question is "what should I use", not "what cost the most".
    let mut ranked: Vec<Value> = agent_map
        .iter()
        .filter(|(_, v)| v.0 >= 2.0)
        .map(|(key, v)| {
            let mut m = Map::new();
            m.insert("agentModel".into(), Value::String(key.clone()));
            m.insert("sessions".into(), num(v.0));
            m.insert("avgCostUsd".into(), num(js_to_fixed_num(v.1 / v.0, 4)));
            m.insert("avgTurns".into(), num(js_to_fixed_num(v.2 / v.0, 1)));
            m.insert("errorRate".into(), Value::String(format!("{}%", fmt_js_num(crate::summarize::helpers::js_math_round(v.3 / v.0 * 100.0)))));
            Value::Object(m)
        })
        .collect();
    ranked.sort_by(|a, b| f(a, "avgCostUsd").partial_cmp(&f(b, "avgCostUsd")).unwrap_or(std::cmp::Ordering::Equal));

    let mn = measured.len() as f64;
    let avg_hit = if measured.is_empty() { 0.0 } else { measured.iter().map(|s| f(s, "cacheHitRate")).sum::<f64>() / mn };
    let below70 = measured.iter().filter(|s| f(s, "cacheHitRate") < 0.7).count();
    let mut worst: Vec<&&&Value> = measured.iter().collect();
    worst.sort_by(|a, b| f(a, "cacheHitRate").partial_cmp(&f(b, "cacheHitRate")).unwrap_or(std::cmp::Ordering::Equal));
    let worst_cache: Vec<Value> = worst
        .iter()
        .take(5)
        .map(|s| {
            let mut m = Map::new();
            m.insert("sessionId".into(), s.get("sessionId").cloned().unwrap_or(Value::Null));
            m.insert("model".into(), s.get("model").cloned().unwrap_or(Value::Null));
            m.insert("cacheHitRatePct".into(), num(crate::summarize::helpers::js_math_round(f(s, "cacheHitRate") * 100.0)));
            m.insert("cacheCreateTokens".into(), s.get("cacheCreateTokens").cloned().unwrap_or(Value::Null));
            Value::Object(m)
        })
        .collect();

    let mut health = Map::new();
    // NULL when nothing was measured — never a 0 that reads as "the cache is completely cold".
    health.insert(
        "avgCacheHitRatePct".into(),
        if measured.is_empty() { Value::Null } else { num(crate::summarize::helpers::js_math_round(avg_hit * 100.0)) },
    );
    health.insert("measuredSessions".into(), num(mn));
    health.insert("excludedJunkSessions".into(), num(n - mn));
    health.insert("sessionsBelow70pct".into(), num(below70 as f64));
    health.insert("worstSessions".into(), Value::Array(worst_cache));

    let mut m = Map::new();
    m.insert("period".into(), Value::String(format!("last {} days", fmt_js_num(cutoff_days))));
    m.insert("sessionCount".into(), num(n));
    m.insert("costTrend".into(), trend.into());
    m.insert("avgCostUsd".into(), num(js_to_fixed_num(total_cost / n, 4)));
    m.insert("avgTurns".into(), num(js_to_fixed_num(total_turns / n, 1)));
    m.insert("errorRate".into(), Value::String(format!("{}%", fmt_js_num(crate::summarize::helpers::js_math_round(error_sessions / n * 100.0)))));
    m.insert("cacheHealth".into(), Value::Object(health));
    m.insert("topLoopSignals".into(), Value::Array(top_signals));
    m.insert("agentRanking".into(), Value::Array(ranked));
    Value::Object(m)
}

/// `get_instruction_suggestions` — project-scoped, so a missing workspace is an ERROR rather than a
/// machine-wide answer: instructions that fit one project are usually wrong for another.
///
/// THREE DIFFERENT TOP-LEVEL SHAPES, and that is deliberate: `{error}` when the caller gave no
/// workspace, `{message, suggestions: []}` when there is history but not enough of it, and a BARE
/// ARRAY on success. The middle one is the one worth keeping — "not enough history yet" is a
/// different fact from "nothing to suggest", and an empty array alone cannot say which.
///
/// The re-projection is not cosmetic: the advisor's suggestion objects carry more fields than the
/// tool's contract, so passing them through would ship whatever the advisor happens to add next.
pub fn get_instruction_suggestions(sessions: &[Value], workspace: Option<&str>, existing: &str) -> Value {
    let Some(ws) = workspace.map(str::trim).filter(|w| !w.is_empty()) else {
        let mut m = Map::new();
        m.insert("error".into(), "workspace is required — instruction suggestions are project-scoped.".into());
        return Value::Object(m);
    };
    let filtered: Vec<Value> = sessions
        .iter()
        .filter(|s| {
            let w = s.get("workspace").and_then(Value::as_str);
            w.unwrap_or("") == ws || w.is_some_and(|w| w.starts_with(ws))
        })
        .cloned()
        .collect();
    if filtered.len() < 5 {
        let mut m = Map::new();
        m.insert(
            "message".into(),
            Value::String(format!("Not enough history for workspace \"{ws}\" ({} sessions, need 5).", filtered.len())),
        );
        m.insert("suggestions".into(), Value::Array(Vec::new()));
        return Value::Object(m);
    }
    let mut out: Vec<Value> = crate::instruction_advisor::generate_suggestions(&filtered, existing)
        .iter()
        .map(|s| project(s, &["id", "category", "title", "evidence", "suggestedText", "targetAgents", "priority"], &[]))
        .collect();

    // A data-driven cache suggestion when the workspace's prompt cache is under-used: a low hit
    // rate means the prefix is re-billed as cache_creation at FULL write rate every turn, and the
    // fix is instruction-level (no mid-session tool/model churn, no volatile per-turn injections).
    //
    // Same junk-row exclusion as the efficiency SLI, and it needs >= 5 MEASURED sessions — so a
    // handful of real sessions among a pile of synthetic empties can neither trigger it nor
    // suppress it. `avgHit` defaults to 1 with nothing measured, which is the quiet direction.
    let measured: Vec<&Value> = filtered.iter().filter(|s| is_cache_measured(s)).collect();
    let avg_hit = if measured.is_empty() { 1.0 } else { measured.iter().map(|s| f(s, "cacheHitRate")).sum::<f64>() / measured.len() as f64 };
    if measured.len() >= 5 && avg_hit < 0.8 {
        let mut m = Map::new();
        m.insert("id".into(), "cache-efficiency".into());
        m.insert("category".into(), "behavior".into());
        m.insert("title".into(), "Improve prompt-cache hit rate".into());
        m.insert("evidence".into(), Value::String(format!(
            "Average cache-hit rate across {} cache-measured sessions is {}% (target ≥ 80%). A low hit rate re-bills the prompt prefix as cache_creation at full write rate.",
            measured.len(),
            fmt_js_num(crate::summarize::helpers::js_math_round(avg_hit * 100.0))
        )));
        m.insert("suggestedText".into(), "Avoid mid-session tool-set changes, model switches, and volatile per-turn injections (they break the prefix cache). Run get_cache_break_report for the specific offending blocks and remediations.".into());
        m.insert("targetAgents".into(), Value::Array(Vec::new()));
        m.insert("priority".into(), "medium".into());
        out.push(Value::Object(m));
    }
    Value::Array(out)
}

/// computeTurnGrowth — per-turn token aggregation off the timeline, `background` entries skipped
/// (they carry another agent's tokens and would inflate the parent's turns).
fn compute_turn_growth(timeline: &[Value]) -> Vec<Value> {
    let mut by_turn: indexmap::IndexMap<i64, (f64, f64, f64, f64)> = indexmap::IndexMap::new();
    for e in timeline {
        let Some(turn) = e.get("turn").and_then(Value::as_f64) else { continue };
        if e.get("type").and_then(Value::as_str) == Some("background") {
            continue;
        }
        let a = by_turn.entry(turn as i64).or_insert((0.0, 0.0, 0.0, 0.0));
        a.0 += f(e, "inputTokens");
        a.1 += f(e, "cacheReadTokens");
        a.2 += f(e, "cacheCreateTokens");
        a.3 += f(e, "outputTokens");
    }
    let mut entries: Vec<(i64, (f64, f64, f64, f64))> = by_turn.into_iter().collect();
    entries.sort_by_key(|(turn, _)| *turn);
    entries
        .iter()
        .map(|(turn, (input, read, create, output))| {
            let denom = read + create;
            let mut m = Map::new();
            m.insert("turn".into(), num(*turn as f64));
            m.insert("promptTokens".into(), num(input + read + create));
            m.insert("cacheReadTokens".into(), num(*read));
            m.insert("cacheCreateTokens".into(), num(*create));
            m.insert("newInputTokens".into(), num(*input));
            m.insert("outputTokens".into(), num(*output));
            // 0 when nothing was cached that turn — this one IS a 0, not a null: the turn genuinely
            // measured no cache traffic, which is a fact, unlike the SLI averages elsewhere.
            m.insert("hitRatePct".into(), num(if denom > 0.0 { crate::summarize::helpers::js_math_round(read / denom * 100.0) } else { 0.0 }));
            Value::Object(m)
        })
        .collect()
}

/// aggregateComposition — one injected source summed across the turns it appears in: the
/// "turns × per-turn weight" inflation view, heaviest first.
fn aggregate_composition(composition: &Value) -> Vec<Value> {
    let empty: Vec<Value> = Vec::new();
    let mut by_key: indexmap::IndexMap<String, (String, String, f64, f64, f64)> = indexmap::IndexMap::new();
    for t in composition.get("turns").and_then(Value::as_array).unwrap_or(&empty) {
        for s in t.get("sources").and_then(Value::as_array).unwrap_or(&empty) {
            let label = s.get("label").and_then(Value::as_str).unwrap_or("").to_owned();
            let kind = s.get("kind").and_then(Value::as_str).unwrap_or("").to_owned();
            let tokens = f(s, "tokens");
            // `${kind}::${label}` — BOTH halves, because the same label legitimately appears under
            // two kinds (a file read as content and referenced in a tool result).
            let e = by_key.entry(format!("{kind}::{label}")).or_insert((label, kind, 0.0, 0.0, 0.0));
            e.2 += tokens;
            e.3 += 1.0;
            e.4 = e.4.max(tokens);
        }
    }
    let mut rows: Vec<(String, String, f64, f64, f64)> = by_key.into_values().collect();
    rows.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    rows.iter()
        .map(|(label, kind, cumulative, turns, peak)| {
            let mut m = Map::new();
            m.insert("label".into(), Value::String(label.clone()));
            m.insert("kind".into(), Value::String(kind.clone()));
            m.insert("cumulativeTokens".into(), num(*cumulative));
            m.insert("turnsPresent".into(), num(*turns));
            m.insert("peakTokens".into(), num(*peak));
            Value::Object(m)
        })
        .collect()
}

/// subAgentChildren — direct children rolled up for the tree view. fork = cache-warm.
fn sub_agent_children(sessions: &[Value], parent_id: &str, now_ms: f64) -> Vec<Value> {
    sessions
        .iter()
        .filter(|s| s.get("parentSessionId").and_then(Value::as_str) == Some(parent_id))
        .map(|c| {
            let spawn_kind = c.get("spawnKind").and_then(Value::as_str);
            let mut m = Map::new();
            m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
            m.insert("spawnedByTurn".into(), c.get("spawnedByTurn").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
            m.insert("spawnKind".into(), Value::String(spawn_kind.unwrap_or("fresh").to_owned()));
            m.insert("warm".into(), Value::Bool(spawn_kind == Some("fork")));
            // `spawnModelOverride || model` — FALSY-or, so an empty override falls through.
            let model = c
                .get("spawnModelOverride")
                .and_then(Value::as_str)
                .filter(|m| !m.is_empty())
                .map_or_else(|| c.get("model").cloned().unwrap_or(Value::Null), |m| Value::String(m.to_owned()));
            m.insert("model".into(), model);
            m.insert("modelOverride".into(), c.get("spawnModelOverride").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
            m.insert("isolation".into(), c.get("spawnIsolation").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
            m.insert("totalTokens".into(), num(f(c, "inputTokens") + f(c, "outputTokens")));
            m.insert("cost_usd".into(), num(js_to_fixed_num(session_cost(c, now_ms), 4)));
            // Async launches never report tokens into the parent transcript — without this flag the
            // zero totalTokens/cost above would read as "measured free" instead of "unknown".
            // `undefined` when sync, so the key is OMITTED.
            if truthy(c.get("spawnAsync").unwrap_or(&Value::Null)) {
                m.insert("asyncTokensUnknown".into(), Value::Bool(true));
            }
            Value::Object(m)
        })
        .collect()
}

/// summarizeGeneratedFiles — count + top-5 by size. NULL when the session produced none.
/// Dedupes across the session-level group + per-tool-call leaves, FIRST occurrence wins.
fn summarize_generated_files(card: &Value, timeline: &[Value]) -> Value {
    let empty: Vec<Value> = Vec::new();
    let mut by_path: indexmap::IndexMap<String, Value> = indexmap::IndexMap::new();
    let mut add = |gf: &Value| {
        if let Some(p) = gf.get("path").and_then(Value::as_str) {
            by_path.entry(p.to_owned()).or_insert_with(|| gf.clone());
        }
    };
    for gf in card.get("generatedFiles").and_then(Value::as_array).unwrap_or(&empty) {
        add(gf);
    }
    for e in timeline {
        for gf in e.get("generatedFiles").and_then(Value::as_array).unwrap_or(&empty) {
            add(gf);
        }
    }
    if by_path.is_empty() {
        return Value::Null;
    }
    let mut all: Vec<Value> = by_path.into_values().collect();
    all.sort_by(|a, b| f(b, "sizeBytes").partial_cmp(&f(a, "sizeBytes")).unwrap_or(std::cmp::Ordering::Equal));
    let mut m = Map::new();
    m.insert("count".into(), num(all.len() as f64));
    m.insert(
        "top".into(),
        Value::Array(all.iter().take(5).map(|gf| project(gf, &["path", "sizeBytes", "tokenEstimate"], &[])).collect()),
    );
    Value::Object(m)
}

/// `get_session_detail` — ONE session's full drill: identity, cost, cache accounting, per-turn
/// growth, composition rollup, sub-agent children, generated files, and the timeline head.
///
/// Every array is CAPPED (60 growth rows, 12 composition rows, 80 timeline rows) because this
/// payload rides in the caller's transcript; the caps predate leanResponse and stay because they
/// are part of the frozen shape, not because the lean layer would not catch them.
pub fn get_session_detail(sessions: &[Value], timeline: &[Value], composition: Option<&Value>, session_id: &str, now_ms: f64) -> Value {
    let Some(card) = sessions.iter().find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id)) else {
        let mut m = Map::new();
        m.insert("error".into(), Value::String(format!("Session {session_id} not found.")));
        return Value::Object(m);
    };
    let growth = compute_turn_growth(timeline);
    let children = sub_agent_children(sessions, session_id, now_ms);
    let start = card.get("startTime").and_then(Value::as_str).unwrap_or("");
    let mut m = Map::new();
    m.insert("sessionId".into(), card.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("date".into(), Value::String(js_slice(start, 19).replacen('T', " ", 1)));
    m.insert("agent".into(), card.get("source").cloned().unwrap_or(Value::Null));
    m.insert("model".into(), card.get("model").cloned().unwrap_or(Value::Null));
    // `userRequest || null` — FALSY, so '' becomes null (unlike get_recent_sessions' nullish read).
    m.insert("prompt".into(), card.get("userRequest").filter(|v| truthy(v)).cloned().unwrap_or(Value::Null));
    m.insert("cost_usd".into(), num(js_to_fixed_num(session_cost(card, now_ms), 4)));
    m.insert("turns".into(), card.get("totalLlmCalls").cloned().unwrap_or(Value::Null));
    m.insert("errors".into(), card.get("errors").cloned().unwrap_or(Value::Null));
    m.insert("outcome".into(), card.get("outcome").cloned().unwrap_or(Value::Null));
    m.insert("cacheReadTokens".into(), card.get("cacheReadTokens").cloned().unwrap_or(Value::Null));
    m.insert("cacheCreateTokens".into(), card.get("cacheCreateTokens").cloned().unwrap_or(Value::Null));
    m.insert("cacheHitRatePct".into(), num(crate::summarize::helpers::js_math_round(f(card, "cacheHitRate") * 100.0)));
    m.insert("peakContextPerTurn".into(), card.get("peakContextPerTurn").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    // Per-turn cache-READ vs cache-CREATED split — a RE-PROJECTION with the tool's own key names
    // (`prompt`, `cacheRead`, `cacheCreated`), not the growth rows verbatim.
    m.insert(
        "perTurnCacheSplit".into(),
        Value::Array(
            growth
                .iter()
                .take(60)
                .map(|g| {
                    let mut o = Map::new();
                    o.insert("turn".into(), g.get("turn").cloned().unwrap_or(Value::Null));
                    o.insert("prompt".into(), g.get("promptTokens").cloned().unwrap_or(Value::Null));
                    o.insert("cacheRead".into(), g.get("cacheReadTokens").cloned().unwrap_or(Value::Null));
                    o.insert("cacheCreated".into(), g.get("cacheCreateTokens").cloned().unwrap_or(Value::Null));
                    o.insert("newInput".into(), g.get("newInputTokens").cloned().unwrap_or(Value::Null));
                    o.insert("hitPct".into(), g.get("hitRatePct").cloned().unwrap_or(Value::Null));
                    Value::Object(o)
                })
                .collect(),
        ),
    );
    // NULL when no local composition — a pure-OTEL session genuinely has none to aggregate, and an
    // empty array would read as "we looked and it was empty".
    m.insert(
        "compositionSummary".into(),
        match composition.filter(|c| !c.is_null()) {
            Some(c) => Value::Array(
                aggregate_composition(c)
                    .iter()
                    .take(12)
                    .map(|a| project(a, &["label", "kind", "cumulativeTokens", "turnsPresent"], &[]))
                    .collect(),
            ),
            None => Value::Null,
        },
    );
    // NULL when none, same reasoning.
    m.insert("subAgents".into(), if children.is_empty() { Value::Null } else { Value::Array(children) });
    m.insert("loopSignals".into(), card.get("loopSignals").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Array(Vec::new())));
    m.insert("filesRead".into(), card.get("filesRead").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Array(Vec::new())));
    m.insert("filesChanged".into(), card.get("filesChanged").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Array(Vec::new())));
    m.insert("toolCounts".into(), card.get("toolCounts").cloned().unwrap_or(Value::Null));
    m.insert("generatedFiles".into(), summarize_generated_files(card, timeline));
    m.insert(
        "timeline".into(),
        Value::Array(
            timeline
                .iter()
                .take(80)
                .map(|e| {
                    let mut o = Map::new();
                    o.insert("type".into(), e.get("type").cloned().unwrap_or(Value::Null));
                    o.insert("label".into(), e.get("label").cloned().unwrap_or(Value::Null));
                    // `ms: e.durationMs` — an ABSENT durationMs is undefined, so the KEY drops
                    // from JSON; only a PRESENT one (null included) survives.
                    copy_opt(&mut o, e, "durationMs");
                    if let Some(v) = o.shift_remove("durationMs") {
                        o.insert("ms".into(), v);
                    }
                    // `isError || false` — falsy, so an absent/null flag serialises as false.
                    o.insert("error".into(), Value::Bool(truthy(e.get("isError").unwrap_or(&Value::Null))));
                    Value::Object(o)
                })
                .collect(),
        ),
    );
    Value::Object(m)
}

/// One rollup bucket. `unpriced_sessions` counts cards whose model has no pricing entry — they are
/// EXCLUDED from costUsd, never a silent $0 that reads as "measured free".
#[derive(Clone, Default)]
struct RollupBuckets {
    sessions: f64,
    turns: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,
    cost_usd: f64,
    unpriced_sessions: f64,
}

impl RollupBuckets {
    fn add(&mut self, s: &Value, now_ms: f64) {
        self.sessions += 1.0;
        self.turns += f(s, "turns");
        self.input += f(s, "inputTokens");
        self.output += f(s, "outputTokens");
        self.cache_read += f(s, "cacheReadTokens");
        self.cache_creation += f(s, "cacheCreateTokens");
        if truthy(s.get("unpriced").unwrap_or(&Value::Null)) {
            self.unpriced_sessions += 1.0;
        } else {
            self.cost_usd += session_cost(s, now_ms);
        }
    }
    fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_creation
    }
    /// The bucket fields in the TS spread order (`{...zero()}`).
    fn write(&self, m: &mut Map<String, Value>) {
        m.insert("sessions".into(), num(self.sessions));
        m.insert("turns".into(), num(self.turns));
        m.insert("input".into(), num(self.input));
        m.insert("output".into(), num(self.output));
        m.insert("cacheRead".into(), num(self.cache_read));
        m.insert("cacheCreation".into(), num(self.cache_creation));
        m.insert("costUsd".into(), num(self.cost_usd));
        m.insert("unpricedSessions".into(), num(self.unpriced_sessions));
    }
}

const LIVE_WINDOW_MS: f64 = 3.0 * 60_000.0;

/// `get_cost_rollup` — "what did project X / my subagents cost in interval Y, at what rate".
///
/// The HONESTY RULE this tool is built around: cards are SESSION-granular, so a session counts when
/// it OVERLAPS the window and its token totals are WHOLE-SESSION — stated in coverage.note, never
/// silently time-sliced (there is no per-turn slicing here, and pretending otherwise would
/// attribute tokens to hours they were not spent in).
pub fn get_cost_rollup(sessions: &[Value], args: &Value, now_ms: f64) -> Value {
    let s_arg = |k: &str| args.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let parse_iso = crate::summarize::helpers::parse_iso_ms;
    let until = match s_arg("untilIso") {
        Some(v) => parse_iso(v).unwrap_or(f64::NAN),
        None => now_ms,
    };
    let hours = args.get("windowHours").and_then(Value::as_f64).unwrap_or(24.0).clamp(0.05, 24.0 * 45.0);
    let since = match s_arg("sinceIso") {
        Some(v) => parse_iso(v).unwrap_or(f64::NAN),
        None => until - hours * 3_600_000.0,
    };
    let err = |text: &str| {
        let mut m = Map::new();
        m.insert("error".into(), text.into());
        Value::Object(m)
    };
    if !until.is_finite() || !since.is_finite() {
        return err("sinceIso/untilIso must be valid ISO datetimes");
    }
    if since >= until {
        return err("the window is empty (since >= until)");
    }
    let window_h = (until - since) / 3_600_000.0;
    let group_by = args.get("groupBy").and_then(Value::as_str).unwrap_or("project");

    // Cards without a parseable startTime cannot be window-filtered — EXCLUDED and COUNTED, never
    // silently mixed in or silently dropped.
    let mut undated = 0.0;
    let started = |s: &Value| s.get("startTime").and_then(Value::as_str).and_then(parse_iso);
    let mut pool: Vec<&Value> = sessions
        .iter()
        .filter(|s| match started(s) {
            None => {
                undated += 1.0;
                false
            }
            Some(start) => {
                let end = start + f(s, "durationMs").max(0.0);
                start <= until && end >= since
            }
        })
        .collect();
    let has_parent = |s: &Value| s.get("parentSessionId").and_then(Value::as_str).is_some_and(|p| !p.is_empty());
    if truthy(args.get("subagentsOnly").unwrap_or(&Value::Null)) {
        pool.retain(|s| has_parent(s));
    }
    if let Some(p) = s_arg("parentSessionId") {
        pool.retain(|s| s.get("parentSessionId").and_then(Value::as_str) == Some(p));
    }
    if truthy(args.get("liveOnly").unwrap_or(&Value::Null)) {
        pool.retain(|s| now_ms - (started(s).unwrap_or(0.0) + f(s, "durationMs").max(0.0)) <= LIVE_WINDOW_MS);
    }
    // groupBy:subagent IS the "rank my subagents" view — spawned sessions implicitly.
    if group_by == "subagent" {
        pool.retain(|s| has_parent(s));
    }

    let key_of = |s: &Value| -> String {
        match group_by {
            "all" => "all".to_owned(),
            // `s.workspace || '(unknown workspace)'` — FALSY, an empty workspace falls through.
            "project" => s.get("workspace").and_then(Value::as_str).filter(|w| !w.is_empty()).unwrap_or("(unknown workspace)").to_owned(),
            "model" => s.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("(unknown model)").to_owned(),
            _ => s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned(),
        }
    };

    let mut totals = RollupBuckets::default();
    // The group map carries (buckets, per-session labels): labels are set on the FIRST card of the
    // group only, exactly as the TS `if (!g)` branch does.
    type RollupGroup = (RollupBuckets, Option<Map<String, Value>>);
    let mut groups: indexmap::IndexMap<String, RollupGroup> = indexmap::IndexMap::new();
    for s in &pool {
        totals.add(s, now_ms);
        let key = key_of(s);
        let entry = groups.entry(key).or_insert_with(|| {
            let labels = if group_by == "session" || group_by == "subagent" {
                let mut l = Map::new();
                // Two assignment shapes in the TS literal, and they serialise differently:
                // `g.workspace = s.workspace` keeps undefined UNDEFINED (the key DROPS), while
                // `g.parentSessionId = s.parentSessionId ?? null` coalesces to an explicit null
                // (the key SURVIVES). The oracle caught nulls where keys should have dropped.
                copy_opt(&mut l, s, "workspace");
                copy_opt(&mut l, s, "model");
                l.insert("parentSessionId".into(), s.get("parentSessionId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
                l.insert("spawnKind".into(), s.get("spawnKind").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
                l.insert("subagentType".into(), s.get("spawnSubagentType").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
                copy_opt(&mut l, s, "startTime");
                if let Some(v) = l.shift_remove("startTime") {
                    l.insert("startedAtIso".into(), v);
                }
                l.insert("tokensSource".into(), s.get("tokensSource").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
                if let Some(n) = s.get("coverageNote").filter(|v| truthy(v)) {
                    l.insert("coverageNote".into(), n.clone());
                }
                Some(l)
            } else {
                None
            };
            (RollupBuckets::default(), labels)
        });
        entry.0.add(s, now_ms);
    }

    let sort_by = args.get("sortBy").and_then(Value::as_str).unwrap_or("cost");
    let metric = |b: &RollupBuckets| -> f64 {
        match sort_by {
            "input" => b.input,
            "output" => b.output,
            "cacheRead" => b.cache_read,
            "cacheCreation" => b.cache_creation,
            "total" => b.total(),
            _ => b.cost_usd,
        }
    };
    let top_n = args.get("topN").and_then(Value::as_f64).unwrap_or(20.0).clamp(1.0, 100.0) as usize;
    let mut ranked: Vec<(&String, &RollupGroup)> = groups.iter().collect();
    ranked.sort_by(|a, b| metric(&b.1 .0).partial_cmp(&metric(&a.1 .0)).unwrap_or(std::cmp::Ordering::Equal));

    // FLAT rate scalars, not a nested object: the lean shaper prunes nested objects from rows, and
    // the hourly rate is a headline number that must survive the default (shaped) view.
    let rate = |m: &mut Map<String, Value>, b: &RollupBuckets| {
        m.insert("tokensPerHour".into(), num(crate::summarize::helpers::js_math_round(b.total() / window_h)));
        m.insert("costUsdPerHour".into(), num(js_to_fixed_num(b.cost_usd / window_h, 4)));
    };

    let mut out = Map::new();
    let mut window = Map::new();
    window.insert("sinceIso".into(), Value::String(crate::summarize::helpers::iso_from_ms(since)));
    window.insert("untilIso".into(), Value::String(crate::summarize::helpers::iso_from_ms(until)));
    window.insert("hours".into(), num(js_to_fixed_num(window_h, 2)));
    out.insert("window".into(), Value::Object(window));
    out.insert("groupBy".into(), Value::String(group_by.to_owned()));
    let mut filters = Map::new();
    filters.insert("subagentsOnly".into(), Value::Bool(truthy(args.get("subagentsOnly").unwrap_or(&Value::Null))));
    filters.insert("parentSessionId".into(), s_arg("parentSessionId").map_or(Value::Null, |p| Value::String(p.to_owned())));
    filters.insert("liveOnly".into(), Value::Bool(truthy(args.get("liveOnly").unwrap_or(&Value::Null))));
    filters.insert("sortBy".into(), Value::String(sort_by.to_owned()));
    out.insert("filters".into(), Value::Object(filters));
    let mut t = Map::new();
    totals.write(&mut t);
    t.insert("totalTokens".into(), num(totals.total()));
    rate(&mut t, &totals);
    out.insert("totals".into(), Value::Object(t));
    let rows: Vec<Value> = ranked
        .iter()
        .take(top_n)
        .map(|(key, (b, labels))| {
            // `{...g, totalTokens, ...rateFields, costShare}` — key first, buckets, THEN the
            // session labels (they were assigned after zero() in the literal), then the appends.
            let mut m = Map::new();
            m.insert("key".into(), Value::String((*key).clone()));
            b.write(&mut m);
            if let Some(l) = labels {
                for (k, v) in l {
                    m.insert(k.clone(), v.clone());
                }
            }
            m.insert("totalTokens".into(), num(b.total()));
            rate(&mut m, b);
            m.insert(
                "costShare".into(),
                if totals.cost_usd > 0.0 { num(js_to_fixed_num(b.cost_usd / totals.cost_usd, 3)) } else { Value::Null },
            );
            Value::Object(m)
        })
        .collect();
    out.insert("groups".into(), Value::Array(rows));
    let mut cov = Map::new();
    cov.insert("sessionsInWindow".into(), num(pool.len() as f64));
    cov.insert("undatedSessions".into(), num(undated));
    cov.insert("groupsTotal".into(), num(groups.len() as f64));
    cov.insert("groupsReturned".into(), num(groups.len().min(top_n) as f64));
    cov.insert("note".into(), "sessions count when they OVERLAP the window; token totals are whole-session (cards are session-granular). unpricedSessions are excluded from costUsd, never silent $0. tokensPerHour/costUsdPerHour divide by the window length.".into());
    out.insert("coverage".into(), Value::Object(cov));
    Value::Object(out)
}

/// The JS percentile pick: `sorted[min(len-1, floor(p/100 * len))]`. Not an interpolation — a
/// MEMBER of the sample, so the reported p50 is a cost a real session actually incurred.
fn pct_of(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// `predict_session_cost` — "what will a session like THIS cost?", answered as a DISTRIBUTION
/// (p25/p50/p75) over real matched precedents, never a point guess.
///
/// Zero-precedent honesty: no match returns `{matched: 0, note}` and NO numbers — a prediction
/// with no precedent behind it would be a guess wearing percentile clothes. And zero-traffic cards
/// are excluded up front, because they would drag every percentile toward 0.
pub fn predict_session_cost(sessions: &[Value], args: &Value, now_ms: f64) -> Value {
    let err = |text: &str| {
        let mut m = Map::new();
        m.insert("error".into(), text.into());
        Value::Object(m)
    };
    let task = args.get("task").and_then(Value::as_str).unwrap_or("");
    if task.trim().chars().count() < 3 {
        return err("task (a description of the planned work) is required");
    }
    // `[...new Set(...)]` — split on runs of non-[a-z0-9], length > 3, DEDUPED, insertion order.
    let lowered = task.to_lowercase();
    let mut keywords: indexmap::IndexSet<String> = indexmap::IndexSet::new();
    for w in lowered.split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit()) {
        if utf16_len(w) > 3 {
            keywords.insert(w.to_owned());
        }
    }
    if keywords.is_empty() {
        return err("task yielded no matchable keywords — describe the work in a sentence");
    }
    let subagent_type = args.get("subagentType").and_then(Value::as_str).filter(|t| !t.is_empty());
    let file_bytes = args.get("fileBytes").and_then(Value::as_f64).filter(|b| *b != 0.0);

    let read_bytes_of = |s: &Value| -> Option<f64> {
        let ops = s.get("fileOps").and_then(Value::as_array).filter(|a| !a.is_empty())?;
        let n: f64 = ops.iter().map(|o| f(o, "readBytes")).sum();
        (n > 0.0).then_some(n)
    };

    let mut scored: Vec<(&Value, f64, Option<f64>)> = sessions
        .iter()
        .filter(|s| is_cache_measured(s))
        .filter_map(|s| {
            let text = s.get("userRequest").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let hits = keywords.iter().filter(|k| text.contains(k.as_str())).count() as f64;
            let mut score = hits / keywords.len() as f64;
            if subagent_type.is_some() && s.get("spawnSubagentType").and_then(Value::as_str) == subagent_type {
                score += 0.5;
            }
            // Soft comparability band: when BOTH sides know the input size, a session outside a
            // 10x band is a poor precedent for cost extrapolation — down-weighted, not excluded.
            let rb = read_bytes_of(s);
            if let (Some(fb), Some(r)) = (file_bytes, rb) {
                if r > fb * 10.0 || r < fb / 10.0 {
                    score *= 0.3;
                }
            }
            (score > 0.0).then_some((s, score, rb))
        })
        .collect();
    // Stable descending, as Array.prototype.sort — equal scores keep card order.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let top_k = args.get("topK").and_then(Value::as_f64).unwrap_or(12.0).clamp(3.0, 50.0) as usize;
    let picked: Vec<&(&Value, f64, Option<f64>)> = scored.iter().take(top_k).collect();
    if picked.is_empty() {
        let mut m = Map::new();
        m.insert("matched".into(), num(0.0));
        m.insert(
            "note".into(),
            Value::String(format!(
                "no past session matched the task keywords{} — no precedent, no prediction. Broaden the task description or drop the type filter.",
                subagent_type.map_or(String::new(), |t| format!(" (subagentType {t})"))
            )),
        );
        return Value::Object(m);
    }

    let dist = |get: &dyn Fn(&Value) -> f64| -> Value {
        let mut v: Vec<f64> = picked.iter().map(|(s, _, _)| get(s)).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut m = Map::new();
        m.insert("p25".into(), num(pct_of(&v, 25.0)));
        m.insert("p50".into(), num(pct_of(&v, 50.0)));
        m.insert("p75".into(), num(pct_of(&v, 75.0)));
        Value::Object(m)
    };
    let cost_fn = |s: &Value| js_to_fixed_num(session_cost(s, now_ms), 4);
    let cost = dist(&cost_fn);

    let mut m = Map::new();
    m.insert("matched".into(), num(picked.len() as f64));
    m.insert("keywords".into(), Value::Array(keywords.iter().map(|k| Value::String(k.clone())).collect()));
    // FLAT headline estimates — the lean shaper prunes deep nesting from the default view, and
    // "what will it cost" must survive it (p50 central, p75 budget-safe).
    m.insert("estCostUsdP50".into(), cost.get("p50").cloned().unwrap_or(Value::Null));
    m.insert("estCostUsdP75".into(), cost.get("p75").cloned().unwrap_or(Value::Null));
    m.insert("estTurnsP50".into(), dist(&|s| f(s, "turns")).get("p50").cloned().unwrap_or(Value::Null));
    let mut pred = Map::new();
    pred.insert("input".into(), dist(&|s| f(s, "inputTokens")));
    pred.insert("output".into(), dist(&|s| f(s, "outputTokens")));
    pred.insert("cacheRead".into(), dist(&|s| f(s, "cacheReadTokens")));
    pred.insert("cacheCreation".into(), dist(&|s| f(s, "cacheCreateTokens")));
    pred.insert("costUsd".into(), cost);
    pred.insert("turns".into(), dist(&|s| f(s, "turns")));
    m.insert("prediction".into(), Value::Object(pred));
    m.insert(
        "precedents".into(),
        Value::Array(
            picked
                .iter()
                .take(8)
                .map(|(s, score, rb)| {
                    let mut p = Map::new();
                    p.insert("sessionId".into(), s.get("sessionId").cloned().unwrap_or(Value::Null));
                    // `workspace: x.s.workspace` — undefined DROPS the key (the rollup lesson).
                    copy_opt(&mut p, s, "workspace");
                    copy_opt(&mut p, s, "model");
                    p.insert("subagentType".into(), s.get("spawnSubagentType").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
                    p.insert("similarity".into(), num(js_to_fixed_num(*score, 2)));
                    p.insert("costUsd".into(), num(cost_fn(s)));
                    p.insert("turns".into(), s.get("turns").cloned().unwrap_or(Value::Null));
                    p.insert("readBytes".into(), rb.map_or(Value::Null, num));
                    p.insert("request".into(), Value::String(js_slice(s.get("userRequest").and_then(Value::as_str).unwrap_or(""), 100).to_owned()));
                    Value::Object(p)
                })
                .collect(),
        ),
    );
    m.insert("note".into(), "a DISTRIBUTION over real matched precedents (keyword + type + size-band similarity), not a point guess. p50 is the central estimate; p75 the budget-safe one. Model changes shift costs — check the precedents' models against the model you will run.".into());
    Value::Object(m)
}

/// `get_context_growth` (mcpServer.ts handleGetContextGrowth) — per-turn prompt growth for ONE
/// session, plus the overall cache hit rate.
///
/// An EMPTY growth list returns a MESSAGE, not an empty report: a session with no turn indices (an
/// OTEL session, or an empty timeline) is undiagnosable rather than measured-at-zero, and a report of
/// zeros would read as the latter.
pub fn get_context_growth(card: &Value, timeline: &[Value]) -> Value {
    let growth = compute_turn_growth(timeline);
    if growth.is_empty() {
        let mut m = Map::new();
        m.insert("sessionId".into(), card.get("sessionId").cloned().unwrap_or(Value::Null));
        m.insert(
            "message".into(),
            "No per-turn token data (OTEL session without turn indices, or empty timeline).".into(),
        );
        return Value::Object(m);
    }
    let peak = growth.iter().map(|g| f(g, "promptTokens")).fold(0.0, f64::max);
    let total_create: f64 = growth.iter().map(|g| f(g, "cacheCreateTokens")).sum();
    let total_read: f64 = growth.iter().map(|g| f(g, "cacheReadTokens")).sum();
    let denom = total_read + total_create;
    let mut m = Map::new();
    m.insert("sessionId".into(), card.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("model".into(), card.get("model").cloned().unwrap_or(Value::Null));
    m.insert("turns".into(), num(growth.len() as f64));
    m.insert("peakPromptTokens".into(), num(peak));
    // `s.peakContextPerTurn ?? null` — NULLISH, so a persisted 0 survives as 0 rather than becoming
    // null: "measured no growth" and "never persisted" are different facts.
    m.insert("persistedPeakContextPerTurn".into(), card.get("peakContextPerTurn").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    m.insert(
        "overallCacheHitRatePct".into(),
        num(if denom > 0.0 { crate::summarize::helpers::js_math_round(total_read / denom * 100.0) } else { 0.0 }),
    );
    m.insert("totalCacheCreatedTokens".into(), num(total_create));
    // `.slice(0, 300)` — a positive cap, so this is a plain take (unlike the negative-limit slice
    // trap elsewhere in this file).
    m.insert("perTurn".into(), Value::Array(growth.into_iter().take(300).collect()));
    Value::Object(m)
}

/// `get_subagent_tree` (mcpServer.ts handleGetSubagentTree) — one session's fan-out, rolled up, with
/// the spawn-cost advisor's antipattern detections.
///
/// The tree is always rooted at the PARENT: asking about a child answers about its whole family, so a
/// fan-out's cost is never reported as just one sibling's. A parent id that is not itself in the card
/// set falls back to the queried session (`?? s`) rather than erroring — a missing parent card is a
/// coverage gap, not a bad request.
pub fn get_subagent_tree(sessions: &[Value], session_id: &str, now_ms: f64) -> Value {
    let Some(card) = sessions.iter().find(|x| x.get("sessionId").and_then(Value::as_str) == Some(session_id)) else {
        let mut m = Map::new();
        m.insert("error".into(), Value::String(format!("Session {session_id} not found.")));
        return Value::Object(m);
    };
    let parent_id = card.get("parentSessionId").and_then(Value::as_str).filter(|p| !p.is_empty());
    let root = match parent_id {
        Some(p) => sessions.iter().find(|x| x.get("sessionId").and_then(Value::as_str) == Some(p)).unwrap_or(card),
        None => card,
    };
    let root_id = root.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let children = sub_agent_children(sessions, root_id, now_ms);
    let rolled_up_tokens = f(root, "inputTokens") + f(root, "outputTokens") + children.iter().map(|c| f(c, "totalTokens")).sum::<f64>();
    let rolled_up_cost =
        js_to_fixed_num(session_cost(root, now_ms) + children.iter().map(|c| f(c, "cost_usd")).sum::<f64>(), 4);

    // TRDD-62E8UU41: the rollup + detections run over the FULL child CARDS, not the reduced `children`
    // shape above — that shape lacks the cache buckets every detector reads, so passing it would make
    // every child look cache-free and silently disable the advisor. `session_cost` is the same
    // normalizing pricer used for rolledUpCost, so the two figures stay consistent.
    let child_cards: Vec<Value> = sessions
        .iter()
        .filter(|c| {
            c.get("parentSessionId").and_then(Value::as_str) == Some(root_id)
                && c.get("sessionId").and_then(Value::as_str) != Some(root_id)
        })
        .cloned()
        .collect();
    let cost_of = |c: &Value| session_cost(c, now_ms);
    let spawn_rollup = crate::spawn_rollup::build_spawn_rollup(
        &child_cards,
        root.get("model").and_then(Value::as_str).unwrap_or(""),
        &cost_of,
    );

    let mut r = Map::new();
    r.insert("sessionId".into(), root.get("sessionId").cloned().unwrap_or(Value::Null));
    r.insert("model".into(), root.get("model").cloned().unwrap_or(Value::Null));
    r.insert("ownTokens".into(), num(f(root, "inputTokens") + f(root, "outputTokens")));
    r.insert("ownCost_usd".into(), num(js_to_fixed_num(session_cost(root, now_ms), 4)));

    let mut m = Map::new();
    m.insert("root".into(), Value::Object(r));
    m.insert("childCount".into(), num(children.len() as f64));
    let empty = children.is_empty();
    m.insert("children".into(), Value::Array(children));
    m.insert("rolledUpTokens".into(), num(rolled_up_tokens));
    m.insert("rolledUpCost_usd".into(), num(rolled_up_cost));
    m.insert("spawnRollup".into(), spawn_rollup);
    // `note: cond ? '…' : undefined` — the key is DECLARED in the literal but DROPS when undefined,
    // so a session WITH children carries no note at all.
    if empty {
        m.insert("note".into(), "No sub-agent children recorded for this session.".into());
    }
    Value::Object(m)
}

/// mcpServer.ts HOG_SCAN_CAP — how many log-backed sessions one hog scan will open.
pub const HOG_SCAN_CAP: usize = 25;

/// `buildScanCoverage` — the honest-sampling contract (spec 4). It states EXPLICITLY what was
/// scanned versus skipped, so a bounded total is never mistaken for full history. The note is three
/// different sentences on purpose: "nothing to scan", "complete", and "SAMPLE" are three different
/// facts, and collapsing them lets an empty result read as a clean bill of health.
pub fn build_scan_coverage(considered: f64, with_log: f64, scanned: f64, scan_cap: f64) -> Value {
    let skipped = with_log - scanned;
    let complete = skipped == 0.0;
    let note = if complete {
        if with_log == 0.0 {
            format!("No log-backed sessions to scan ({} considered, none with a local transcript on disk).", fmt_js_num(considered))
        } else {
            format!(
                "Complete coverage: all {} log-backed sessions (of {} considered) were scanned.",
                fmt_js_num(with_log),
                fmt_js_num(considered)
            )
        }
    } else {
        format!(
            "SAMPLE, not full coverage: {} most-recent log-backed sessions scanned (cap {}); {} of {} log-backed sessions were NOT scanned. Totals reflect the scanned sample only.",
            fmt_js_num(scanned),
            fmt_js_num(scan_cap),
            fmt_js_num(skipped),
            fmt_js_num(with_log)
        )
    };
    let mut m = Map::new();
    m.insert("sessionsConsidered".into(), num(considered));
    m.insert("sessionsWithLog".into(), num(with_log));
    m.insert("sessionsScanned".into(), num(scanned));
    m.insert("sessionsSkipped".into(), num(skipped));
    m.insert("scanCap".into(), num(scan_cap));
    m.insert("complete".into(), Value::Bool(complete));
    m.insert("note".into(), Value::String(note));
    Value::Object(m)
}

/// `fileBackedPool` — the scoped sessions that actually have a transcript ON DISK, capped.
/// `considered` counts the scope match and `withLog` the file-backed subset, so the two numbers
/// together say whether a small pool means "narrow scope" or "most sessions have no local log".
///
/// THE SCOPE PREDICATE IS NOT UNIFORM ACROSS CALLERS, so it is a PARAMETER rather than a constant.
/// `find_context_hogs` matches a workspace PREFIX **or** a sessionId SUBSTRING (so a bare id
/// fragment works as a scope) with a cap of 25; `get_context_inflation_report` and
/// `get_cache_break_report` match the workspace prefix ONLY, with a cap of 20. Hardcoding the first
/// caller's rule silently over-matches for the others — a session would be scanned because its id
/// happened to contain the workspace string.
/// `fileBackedPool` with the TS's own `scopeMatch` predicate. The scope-string callers go through
/// `file_backed_pool`; `get_cache_risk_costs` needs a predicate that is not a workspace prefix at
/// all (it filters on "a command was typed in this session"), so the general form is the one that
/// actually matches the TS signature and the string form delegates to it.
fn file_backed_pool_with<'a>(
    sessions: &'a [Value],
    file_ids: &std::collections::HashSet<String>,
    scope_match: Option<&dyn Fn(&Value) -> bool>,
    limit: usize,
) -> (Vec<&'a Value>, f64, f64) {
    let scoped: Vec<&Value> = match scope_match {
        Some(f) => sessions.iter().filter(|s| f(s)).collect(),
        None => sessions.iter().collect(),
    };
    let backed: Vec<&Value> =
        scoped.iter().copied().filter(|s| file_ids.contains(s.get("sessionId").and_then(Value::as_str).unwrap_or(""))).collect();
    let (considered, with_log) = (scoped.len() as f64, backed.len() as f64);
    (backed.into_iter().take(limit).collect(), considered, with_log)
}

fn file_backed_pool<'a>(
    sessions: &'a [Value],
    file_ids: &std::collections::HashSet<String>,
    scope: Option<&str>,
    limit: usize,
    match_session_id: bool,
) -> (Vec<&'a Value>, f64, f64) {
    match scope {
        Some(sc) => {
            let f = |s: &Value| {
                s.get("workspace").and_then(Value::as_str).unwrap_or("").starts_with(sc)
                    || (match_session_id && s.get("sessionId").and_then(Value::as_str).unwrap_or("").contains(sc))
            };
            file_backed_pool_with(sessions, file_ids, Some(&f), limit)
        }
        None => file_backed_pool_with(sessions, file_ids, None, limit),
    }
}

/// `find_context_hogs` (mcpServer.ts handleFindContextHogs) — which injected sources cost the most
/// across a project's sessions, summed over the turns they persist in.
///
/// `get_composition` is a CLOSURE because the TS accessor is async and per-session: the whole call
/// is disk-bound and belongs on a blocking thread. A session whose composition cannot be
/// reconstructed is NOT counted as scanned — that is what keeps `coverage` honest rather than
/// letting an unreadable transcript inflate the sample.
pub fn find_context_hogs(
    sessions: &[Value],
    file_ids: &std::collections::HashSet<String>,
    args: &Value,
    get_composition: &dyn Fn(&str) -> Option<Value>,
) -> Value {
    // `args.scope?.trim()` is guarded TWICE, with DIFFERENT operators, and the two disagree on the
    // whitespace case: the pool filter is `scope ? … : null` (TRUTHY — "" is no scope at all) while
    // the echo is `scope ?? 'all'` (NULLISH — "" survives as ""). So an all-whitespace scope filters
    // nothing yet reports itself as `""`, not as `"all"`. Collapsing them to one `Option` (either
    // way) is wrong; keep present-ness for the echo and emptiness for the filter.
    let trimmed = args.get("scope").and_then(Value::as_str).map(str::trim);
    let scope = trimmed.filter(|s| !s.is_empty());
    // `Math.min(topN ?? 15, 50)` — NULLISH default, and only an UPPER clamp: a 0 or negative topN
    // stays as given and returns nothing, which is what the TS does.
    let top_n = args.get("topN").and_then(Value::as_f64).unwrap_or(15.0).min(50.0);
    let (pool, considered, with_log) = file_backed_pool(sessions, file_ids, scope, HOG_SCAN_CAP, true);

    let mut by_key: indexmap::IndexMap<String, (String, String, f64, f64, f64)> = indexmap::IndexMap::new();
    let mut scanned = 0.0;
    for s in &pool {
        let Some(c) = get_composition(s.get("sessionId").and_then(Value::as_str).unwrap_or("")) else { continue };
        scanned += 1.0;
        for a in aggregate_composition(&c) {
            let (label, kind) = (
                a.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                a.get("kind").and_then(Value::as_str).unwrap_or("").to_owned(),
            );
            let e = by_key.entry(format!("{kind}::{label}")).or_insert((label, kind, 0.0, 0.0, 0.0));
            e.2 += f(&a, "cumulativeTokens");
            e.3 += 1.0;
            e.4 += f(&a, "turnsPresent");
        }
    }
    let distinct = by_key.len() as f64;
    let mut hogs: Vec<(String, String, f64, f64, f64)> = by_key.into_values().collect();
    // Stable, so equal-cost sources keep first-seen order rather than reshuffling between runs.
    hogs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let kept: Vec<Value> = hogs
        .into_iter()
        .take(top_n.max(0.0) as usize)
        .map(|(label, kind, cumulative, sess, occ)| {
            let mut m = Map::new();
            m.insert("label".into(), Value::String(label));
            m.insert("kind".into(), Value::String(kind));
            m.insert("cumulativeTokens".into(), num(cumulative));
            m.insert("sessions".into(), num(sess));
            m.insert("occurrences".into(), num(occ));
            Value::Object(m)
        })
        .collect();

    let mut m = Map::new();
    m.insert("scope".into(), Value::String(trimmed.unwrap_or("all").to_owned()));
    // Legacy flat counters kept for existing consumers; `coverage` is the honest-sampling contract.
    m.insert("sessionsConsidered".into(), num(considered));
    m.insert("sessionsWithLog".into(), num(with_log));
    m.insert("sessionsScanned".into(), num(scanned));
    m.insert("coverage".into(), build_scan_coverage(considered, with_log, scanned, HOG_SCAN_CAP as f64));
    // Top-N truncation is labeled too: how many distinct sources existed vs how many are returned.
    m.insert("distinctSources".into(), num(distinct));
    m.insert("returnedHogs".into(), num(kept.len() as f64));
    m.insert("hogsTruncated".into(), Value::Bool(distinct > top_n));
    m.insert("hogs".into(), Value::Array(kept));
    Value::Object(m)
}

/// `get_account_state_at` (mcpServer.ts handleGetAccountStateAt) — which account/plan/TTL regime was
/// in force at a given moment.
///
/// A timeline that does not reach back far enough returns `state: null` WITH a note, never an error:
/// the record starts when the server first observed a state, so "before our history" is a coverage
/// gap and must not read as "no account was active".
pub fn get_account_state_at(args: &Value, path: &std::path::Path) -> Value {
    // `typeof args.ts === 'number' ? args.ts : (args.iso ? Date.parse(args.iso) : NaN)` — `ts` wins,
    // and only a TRUTHY `iso` is parsed (an empty string yields NaN either way).
    let t = match args.get("ts").and_then(Value::as_f64) {
        Some(n) => Some(n),
        None => args.get("iso").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(crate::summarize::helpers::parse_iso_ms),
    }
    .filter(|n| n.is_finite());
    let Some(t) = t else {
        let mut m = Map::new();
        m.insert("error".into(), "Provide `ts` (ms epoch) or `iso` (ISO-8601) — could not resolve a timestamp.".into());
        return Value::Object(m);
    };
    let mut m = Map::new();
    m.insert("at".into(), Value::String(crate::summarize::helpers::iso_from_ms(t)));
    match crate::account_state_timeline::resolve_state_at(t, path) {
        Some(state) => {
            m.insert("state".into(), state);
        }
        None => {
            m.insert("state".into(), Value::Null);
            m.insert("note".into(), "No account-state record precedes this timestamp — the timeline may not extend that far back (it starts when the server first observed a state), or no state has been recorded yet.".into());
        }
    }
    Value::Object(m)
}

/// `agent-<id>` → `<id>`. The two forms are the SAME agent, and the report accepts either.
fn strip_agent_prefix(session_id: &str) -> &str {
    session_id.strip_prefix("agent-").unwrap_or(session_id)
}

/// Compact candidate line for the ambiguity error — enough to pick one (the full sessionId is the
/// unambiguous re-query key), never the whole card.
fn agent_candidate_summary(s: &Value) -> Value {
    let mut m = Map::new();
    m.insert("sessionId".into(), s.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("parentSessionId".into(), s.get("parentSessionId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    // `spawnModelOverride || model` — FALSY-or, so an empty override falls through.
    m.insert(
        "model".into(),
        s.get("spawnModelOverride")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map_or_else(|| s.get("model").cloned().unwrap_or(Value::Null), |v| Value::String(v.to_owned())),
    );
    m.insert("spawnKind".into(), s.get("spawnKind").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    m.insert("totalTokens".into(), num(f(s, "inputTokens") + f(s, "outputTokens")));
    Value::Object(m)
}

/// `contextTokens` — the INPUT-SIDE volume: uncached input + cache read + cache creation. Output is
/// excluded because this is what the model READ, not what it produced.
fn context_tokens_of(b: &Value) -> f64 {
    f(b, "inputTokens") + f(b, "cacheReadTokens") + f(b, "cacheCreateTokens")
}

/// The CC-footer ↓ reconciliation numbers (TRDD-9YT1UR2F addendum, empirically decoded by
/// regressing a live fork's transcript against two footer readings).
///
/// `cumulativeInputSideTokens` is CC's per-agent ↓: input+cacheRead+cacheCreation across ALL turns
/// INCLUDING the launch turn — a fork's turn 1 is the inherited-prefix cache read, ~99.5% of the
/// figure. `lastTurnContextRead` is the context-SIZE proxy, derived most→least authoritative and
/// NEVER guessed: (1) the statusline overlay, CC's own exact numbers; (2) the last usage-carrying
/// timeline entry; (3) a single-turn card's cumulative figure (one turn ⇒ cumulative == last turn);
/// (4) null — a multi-turn card with no per-turn data cannot honestly answer, and a fabricated
/// number here would silently become someone's context-pressure verdict.
fn cc_display_equivalent(c: &Value, timeline: &[Value]) -> Value {
    let cumulative = context_tokens_of(c);
    let last_turn: Option<f64> = match c.get("statusline").filter(|v| !v.is_null()) {
        Some(sl) => sl.get("lastTotalInputTokens").and_then(Value::as_f64),
        None => {
            let found = timeline.iter().rev().map(context_tokens_of).find(|t| *t > 0.0);
            match found {
                Some(t) => Some(t),
                None if f(c, "totalLlmCalls") <= 1.0 && cumulative > 0.0 => Some(cumulative),
                None => None,
            }
        }
    };
    let mut m = Map::new();
    m.insert("cumulativeInputSideTokens".into(), num(cumulative));
    m.insert("lastTurnContextRead".into(), last_turn.map_or(Value::Null, num));
    m.insert("note".into(), "CC's footer ↓ ≈ cumulativeInputSideTokens (cumulative input+cacheRead+cacheCreation across ALL turns, launch turn included; output excluded or below CC's 0.1k rounding). It is volume moved, not billing — use cost_usd for spend.".into());
    Value::Object(m)
}

/// The `{error: "…"}` payload shape, for routes that build their own early returns. Same literal
/// as the in-module `err`, exported so an arm cannot accidentally invent a second error shape.
pub fn error_payload(msg: &str) -> Value {
    err(msg.to_owned())
}

fn err(msg: String) -> Value {
    let mut m = Map::new();
    m.insert("error".into(), Value::String(msg));
    Value::Object(m)
}

fn err_with_candidates(msg: String, matches: &[&Value]) -> Value {
    let mut m = Map::new();
    m.insert("error".into(), Value::String(msg));
    m.insert("candidates".into(), Value::Array(matches.iter().map(|s| agent_candidate_summary(s)).collect()));
    Value::Object(m)
}

/// `get_agent_tokens` (mcpServer.ts handleGetAgentTokens) — the exact per-agent buckets, resolved
/// from a bare agent id, its `agent-<id>` transcript form, or a full sessionId.
///
/// THE MATCH ORDER IS THE WHOLE CORRECTNESS ARGUMENT. Resolution starts from the NORMALIZED
/// equivalence class (bare id ↔ `agent-<id>`, case-insensitive) and exact sessionId equality is
/// only a TIE-BREAK — never blanket precedence. A spawn PLACEHOLDER's sessionId IS the bare agent
/// id by construction, so on an un-merged placeholder+transcript pair a bare-id query would
/// "exactly" match the ZERO-BUCKET placeholder and serve it over the real totals: a guess dressed
/// as precision. The tie-break is trusted only when the query carries the distinguishing
/// `agent-<id>` form, which names exactly one card of the pair.
pub fn get_agent_tokens(sessions: &[Value], timeline_of: &dyn Fn(&Value) -> Vec<Value>, args: &Value, now_ms: f64) -> Value {
    // `(args.agentId ?? '').trim()` then a TRUTHY test — whitespace is no id.
    let q = args.get("agentId").and_then(Value::as_str).unwrap_or("").trim();
    if q.is_empty() {
        return err("agentId is required — a bare agent id, its agent-<id> transcript form, or a full sessionId.".into());
    }
    let q_lower = q.to_lowercase();
    let q_bare = strip_agent_prefix(&q_lower).to_owned();

    let mut matches: Vec<&Value> =
        sessions.iter().filter(|s| strip_agent_prefix(&s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_lowercase()) == q_bare).collect();

    let parent_arg = args.get("parentSessionId").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty());
    if let Some(p) = parent_arg {
        if !matches.is_empty() {
            let p = p.to_lowercase();
            let scoped: Vec<&Value> =
                matches.iter().copied().filter(|s| s.get("parentSessionId").and_then(Value::as_str).unwrap_or("").to_lowercase() == p).collect();
            if scoped.is_empty() {
                // The id EXISTS but not under that parent — say so and show where it DOES live,
                // instead of a bare not-found that sends the caller hunting a typo in the agent id.
                return err_with_candidates(
                    format!("Agent \"{q}\" matched {} card(s), but none under parent {}.", matches.len(), parent_arg.unwrap()),
                    &matches,
                );
            }
            matches = scoped;
        }
    }

    if matches.is_empty() {
        return err(format!(
            "Agent \"{q}\" not found. Accepted forms: bare agent id, agent-<id>, or a full sessionId (case-insensitive). Use get_subagent_tree on the spawning session to list its children."
        ));
    }
    if matches.len() > 1 {
        let exact: Vec<&Value> =
            matches.iter().copied().filter(|s| s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_lowercase() == q_lower).collect();
        if exact.len() == 1 && q_lower != q_bare {
            matches = exact;
        } else {
            // NEVER guess between conflicting cards: list the candidates and let the caller pin one.
            return err_with_candidates(
                format!(
                    "Agent id \"{q}\" is ambiguous — {} cards match. Pass parentSessionId to scope the lookup, or the full sessionId of one candidate (the agent-<id> transcript form).",
                    matches.len()
                ),
                &matches,
            );
        }
    }

    let c = matches[0];
    // Same conventions as get_subagent_tree children — the cross-tool consistency contract. A card
    // with NO parent (a full-sessionId query for a top-level session) carries no spawn taxonomy:
    // null, NOT 'fresh', because it was never spawned at all.
    let spawn_kind = match c.get("spawnKind").and_then(Value::as_str).filter(|k| !k.is_empty()) {
        Some(k) => Value::String(k.to_owned()),
        None if c.get("parentSessionId").and_then(Value::as_str).is_some_and(|p| !p.is_empty()) => Value::String("fresh".into()),
        None => Value::Null,
    };
    let start_ms = c.get("startTime").and_then(Value::as_str).and_then(crate::summarize::helpers::parse_iso_ms);
    let timeline = timeline_of(c);

    let mut m = Map::new();
    m.insert("agentId".into(), Value::String(strip_agent_prefix(c.get("sessionId").and_then(Value::as_str).unwrap_or("")).to_owned()));
    m.insert("sessionId".into(), c.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("parentSessionId".into(), c.get("parentSessionId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    m.insert("spawnedByTurn".into(), c.get("spawnedByTurn").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    // `spawnKind` BEFORE `warm` — the TS literal's order, and key order is a wire contract.
    let warm = spawn_kind == Value::String("fork".into());
    m.insert("spawnKind".into(), spawn_kind);
    m.insert("warm".into(), Value::Bool(warm));
    m.insert(
        "model".into(),
        c.get("spawnModelOverride")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map_or_else(|| c.get("model").cloned().unwrap_or(Value::Null), |v| Value::String(v.to_owned())),
    );
    m.insert("modelOverride".into(), c.get("spawnModelOverride").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    m.insert("isolation".into(), c.get("spawnIsolation").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    m.insert("subagentType".into(), c.get("spawnSubagentType").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    // `c.startTime || null` — FALSY-or, so an empty string becomes null rather than shipping "".
    m.insert(
        "startedAt".into(),
        c.get("startTime").and_then(Value::as_str).filter(|s| !s.is_empty()).map_or(Value::Null, |s| Value::String(s.to_owned())),
    );
    // Derived from the card's OWN span (start + duration) — null when the card has no parseable
    // start (an async placeholder before its transcript exists), never a fabricated now().
    m.insert(
        "lastSeenAt".into(),
        start_ms.map_or(Value::Null, |s| Value::String(crate::summarize::helpers::iso_from_ms(s + f(c, "durationMs")))),
    );
    // `> 0 ? : null` — a zero-call card reports null, not 0: "no turns recorded" is not "0 turns".
    m.insert("turns".into(), if f(c, "totalLlmCalls") > 0.0 { num(f(c, "totalLlmCalls")) } else { Value::Null });
    m.insert("inputTokens".into(), num(f(c, "inputTokens")));
    m.insert("outputTokens".into(), num(f(c, "outputTokens")));
    m.insert("cacheReadTokens".into(), num(f(c, "cacheReadTokens")));
    m.insert("cacheCreateTokens".into(), num(f(c, "cacheCreateTokens")));
    m.insert("totalTokens".into(), num(f(c, "inputTokens") + f(c, "outputTokens")));
    m.insert("cost_usd".into(), num(js_to_fixed_num(session_cost(c, now_ms), 4)));
    // Async launches never report tokens into the parent transcript — without this flag the zero
    // buckets above read as "measured free" instead of "unknown" (same flag as the tree).
    if truthy(c.get("spawnAsync").unwrap_or(&Value::Null)) {
        m.insert("asyncTokensUnknown".into(), Value::Bool(true));
    }
    m.insert("ccDisplayEquivalent".into(), cc_display_equivalent(c, &timeline));
    // P7 provenance — which feed backs this card's token figures; null = a pre-P7 card ("unknown"),
    // never a backfilled guess. coverageNote rides only when a decision set it.
    m.insert("tokensSource".into(), c.get("tokensSource").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
    if truthy(c.get("coverageNote").unwrap_or(&Value::Null)) {
        m.insert("coverageNote".into(), c.get("coverageNote").cloned().unwrap_or(Value::Null));
    }
    Value::Object(m)
}

/// mcpServer.ts CAUSE_SCAN_CAP — how many recently-ACTIVE Claude Code sessions one leaderboard scan
/// will reparse.
pub const CAUSE_SCAN_CAP: usize = 50;

/// Session usage ground truth for the by-cause reconciliation: uncached input + cacheRead +
/// cacheCreate + output. `inputTokens` is RAW on every card (the 2026-07-10 normalization), so the
/// total is a plain sum of the four DISJOINT buckets — no subtraction, no double count.
fn normalized_session_total_tokens(s: &Value) -> f64 {
    f(s, "inputTokens") + f(s, "cacheReadTokens") + f(s, "cacheCreateTokens") + f(s, "outputTokens")
}

/// `get_cost_by_cause` (mcpServer.ts handleGetCostByCause) — "which skill/plugin/subagent costs me
/// the most?", for ONE session or as a cross-session leaderboard.
///
/// THE WINDOW AND THE RANKING ARE BY LAST ACTIVITY, NOT startTime, and that is not a preference.
/// On a busy fleet the newest-STARTED cards are ephemeral subagents and heartbeats carrying no
/// attribution, while the heavy long-lived sessions (started days ago, still burning NOW) never make
/// a startTime-ranked pool at all — measured 2026-07-16: 13,241 CC cards, the active flagship
/// session ranked #446 by startTime, and the machine-wide leaderboard read 0 attributed calls while
/// that same session's own drill showed 1,155. startTime also silently DROPS an old-started-but-
/// active session from the WINDOW itself, so the bug is invisible in the coverage counters.
pub fn get_cost_by_cause(
    sessions: &[Value],
    timeline_of: &dyn Fn(&Value) -> Vec<Value>,
    args: &Value,
    now_ms: f64,
    time_budget_ms: f64,
) -> Value {
    if let Some(id) = args.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let Some(card) = sessions.iter().find(|x| x.get("sessionId").and_then(Value::as_str) == Some(id)) else {
            return err(format!("Session {id} not found."));
        };
        return crate::tokens_by_cause::build_tokens_by_cause(
            &timeline_of(card),
            Some(id),
            None,
            Some(normalized_session_total_tokens(card)),
        );
    }

    // `Math.min(Math.max(days ?? 7, 1), 90)` — clamped at BOTH ends, unlike find_context_hogs' topN.
    let days = args.get("days").and_then(Value::as_f64).unwrap_or(7.0).clamp(1.0, 90.0);
    let cutoff = now_ms - days * 24.0 * 60.0 * 60.0 * 1000.0;
    let in_window: Vec<&Value> = sessions.iter().filter(|s| crate::burn::monitor::last_activity_ms(s) >= cutoff).collect();
    // Only claude_code sessions can carry api_request events (the rich events are CC-specific), so
    // other agents are EXCLUDED from the scan but still counted in `considered` — otherwise the
    // coverage numbers would quietly redefine "all sessions" as "the ones we can read".
    let mut candidates: Vec<&Value> = in_window.iter().copied().filter(|s| s.get("source").and_then(Value::as_str) == Some("claude_code")).collect();
    candidates.sort_by(|a, b| {
        crate::burn::monitor::last_activity_ms(b).partial_cmp(&crate::burn::monitor::last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let scan_pool: Vec<&Value> = candidates.iter().copied().take(CAUSE_SCAN_CAP).collect();

    // scanWithBudget: a stripped card's timeline is reparsed from its WHOLE transcript, so the scan
    // is deadline-checked per session. The deadline is read from the real clock exactly as the TS
    // does (`Date.now() > deadline`) — hardcoding stoppedEarly:false would be cheaper but would
    // silently delete one of the three coverage-note branches, so the shaper takes a real budget.
    // A budget of 0 or less means "no budget" (the TS callers always pass a positive one).
    let deadline = (time_budget_ms > 0.0).then(|| crate::now_ms() as f64 + time_budget_ms);
    let (mut merged, mut scanned): (Vec<Value>, Vec<&Value>) = (Vec::new(), Vec::new());
    let mut stopped_early = false;
    for s in &scan_pool {
        if deadline.is_some_and(|d| crate::now_ms() as f64 > d) {
            stopped_early = true;
            break;
        }
        merged.extend(timeline_of(s));
        scanned.push(s);
    }
    // Window ground truth = Σ normalized per-session totals over the SCANNED pool ONLY, so the
    // reconciliation remainder compares like with like (scanned traffic vs scanned api_requests).
    let scan_pool = scanned;
    let window_total: f64 = scan_pool.iter().map(|s| normalized_session_total_tokens(s)).sum();
    let report = crate::tokens_by_cause::build_tokens_by_cause(&merged, None, Some(scan_pool.len() as f64), Some(window_total));

    let skipped = candidates.len() - scan_pool.len();
    // THREE branches, three different facts: complete, stopped-by-BUDGET (retry widens it, because
    // reparsed timelines are cached on their cards), and capped-by-POOL-SIZE (retrying changes
    // nothing). Collapsing the middle one would tell a user to accept a sample they could fix.
    let note = if skipped == 0 {
        format!(
            "Complete coverage: all {} Claude Code sessions in the last {}d were scanned ({} total sessions considered).",
            candidates.len(),
            fmt_js_num(days),
            in_window.len()
        )
    } else if stopped_early {
        format!(
            "SAMPLE, not full coverage: the {}s scan time budget stopped the scan after {} of {} Claude Code sessions (transcript reparses are expensive right after a server restart). Totals reflect the scanned sample only — retry for wider coverage as reparsed timelines are cached on their cards.",
            fmt_js_num(time_budget_ms / 1000.0),
            scan_pool.len(),
            candidates.len()
        )
    } else {
        format!(
            "SAMPLE, not full coverage: the {} most-recently-ACTIVE Claude Code sessions scanned (cap {CAUSE_SCAN_CAP}); {skipped} of {} active in the {}d window were NOT scanned. Totals reflect the scanned sample only.",
            scan_pool.len(),
            candidates.len(),
            fmt_js_num(days)
        )
    };
    let mut cov = Map::new();
    cov.insert("sessionsConsidered".into(), num(in_window.len() as f64));
    cov.insert("claudeCodeSessions".into(), num(candidates.len() as f64));
    cov.insert("sessionsScanned".into(), num(scan_pool.len() as f64));
    cov.insert("sessionsSkipped".into(), num(skipped as f64));
    cov.insert("scanCap".into(), num(CAUSE_SCAN_CAP as f64));
    cov.insert("stoppedEarly".into(), Value::Bool(stopped_early));
    cov.insert("complete".into(), Value::Bool(skipped == 0));
    cov.insert("note".into(), Value::String(note));

    // `{...report, days, coverage}` — the spread first, so `days` and `coverage` append at the END.
    let mut m = report.as_object().cloned().unwrap_or_default();
    m.insert("days".into(), num(days));
    m.insert("coverage".into(), Value::Object(cov));
    Value::Object(m)
}

/// mcpServer.ts INFLATION_SCAN_CAP — the workspace-scope pool for the inflation report. NOT
/// HOG_SCAN_CAP: this scan also streams each pooled transcript's composition, so it is capped lower.
pub const INFLATION_SCAN_CAP: usize = 20;

/// `get_context_inflation_report` (mcpServer.ts handleGetContextInflationReport) — which injected
/// sources inflate the context, and (single-session only) the itemized resident-cost reconciliation.
///
/// `get_history` is separate from `get_composition` because the itemization needs the FULL
/// transcript history, not the composition summary — and it is single-session ONLY by design: the
/// workspace path already streams every pooled transcript once for the composition, so a second
/// full-history pass per pooled session would double the scan cost of one call for an aggregate the
/// per-session drill answers better.
pub fn get_context_inflation_report(
    sessions: &[Value],
    file_ids: &std::collections::HashSet<String>,
    args: &Value,
    get_composition: &dyn Fn(&str) -> Option<Value>,
    get_history: &dyn Fn(&str) -> Option<Value>,
) -> Value {
    // key → (label, kind, cumulative, turnsPresent, peakTokens, sessions)
    let mut agg: indexmap::IndexMap<String, (String, String, f64, f64, f64, f64)> = indexmap::IndexMap::new();
    let mut fold = |c: &Value| {
        for a in aggregate_composition(c) {
            let (label, kind) = (
                a.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                a.get("kind").and_then(Value::as_str).unwrap_or("").to_owned(),
            );
            let e = agg.entry(format!("{kind}::{label}")).or_insert((label, kind, 0.0, 0.0, 0.0, 0.0));
            e.2 += f(&a, "cumulativeTokens");
            e.3 += f(&a, "turnsPresent");
            e.4 = e.4.max(f(&a, "peakTokens"));
            e.5 += 1.0;
        }
    };

    // `considered`/`withLog` DEFAULT TO 1, not 0 — a single-session drill reports 1/1 rather than
    // claiming it considered nothing.
    let (mut scanned, mut considered, mut with_log) = (0.0, 1.0, 1.0);
    let session_id = args.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(sid) = session_id {
        let Some(c) = get_composition(sid) else {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(sid.to_owned()));
            m.insert("message".into(), "No local composition available for this session.".into());
            return Value::Object(m);
        };
        fold(&c);
        scanned = 1.0;
    } else {
        let scope = args.get("workspace").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        // Workspace PREFIX only (no sessionId substring) and cap 20 — see file_backed_pool's note.
        let (pool, cons, wl) = file_backed_pool(sessions, file_ids, scope, INFLATION_SCAN_CAP, false);
        considered = cons;
        with_log = wl;
        for s in &pool {
            if let Some(c) = get_composition(s.get("sessionId").and_then(Value::as_str).unwrap_or("")) {
                fold(&c);
                scanned += 1.0;
            }
        }
    }

    let mut ranked: Vec<(String, String, f64, f64, f64, f64)> = agg.into_values().collect();
    // Stable, so equal-cost sources keep first-seen order.
    ranked.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    // Runaway = re-injected across MANY turns AND heavy PER TURN. Both halves are required: a huge
    // one-off paste is not a structural sink, and a tiny per-turn injection is not worth moving.
    // This is the fixable one — if it lives in the cached prefix it forces repeated cache-creation.
    let runaway: Vec<&(String, String, f64, f64, f64, f64)> = ranked.iter().filter(|a| a.3 >= 5.0 && a.4 >= 1000.0).collect();

    let mut m = Map::new();
    // `args.sessionId ? \`session ${id}\` : (args.workspace ?? 'all')` — the workspace echo is
    // NULLISH and uses the RAW, UNTRIMMED arg, while the pool guard above uses the TRIMMED value
    // under a truthy test. So `workspace: "   "` filters NOTHING and echoes "   " — not "all", and
    // not "" either (that is find_context_hogs' shape). Three sites, three answers for one input.
    m.insert(
        "scope".into(),
        Value::String(match session_id {
            Some(sid) => format!("session {sid}"),
            None => args.get("workspace").and_then(Value::as_str).unwrap_or("all").to_owned(),
        }),
    );
    m.insert("sessionsConsidered".into(), num(considered));
    m.insert("sessionsWithLog".into(), num(with_log));
    m.insert("sessionsScanned".into(), num(scanned));
    m.insert(
        "topContributors".into(),
        Value::Array(
            ranked
                .iter()
                .take(15)
                .map(|(label, kind, cum, turns, peak, sess)| {
                    let mut r = Map::new();
                    r.insert("label".into(), Value::String(label.clone()));
                    r.insert("kind".into(), Value::String(kind.clone()));
                    r.insert("cumulativeTokens".into(), num(*cum));
                    r.insert("turnsPresent".into(), num(*turns));
                    r.insert("peakTokens".into(), num(*peak));
                    r.insert("sessions".into(), num(*sess));
                    Value::Object(r)
                })
                .collect(),
        ),
    );
    m.insert(
        "runawaySources".into(),
        Value::Array(
            runaway
                .iter()
                .take(10)
                .map(|(label, kind, cum, turns, peak, _)| {
                    let mut r = Map::new();
                    r.insert("label".into(), Value::String(label.clone()));
                    r.insert("kind".into(), Value::String(kind.clone()));
                    r.insert("turnsPresent".into(), num(*turns));
                    r.insert("peakTokens".into(), num(*peak));
                    r.insert("cumulativeTokens".into(), num(*cum));
                    r.insert("hint".into(), "Re-injected across many turns — if it sits in the cached prefix it forces repeated cache-creation; move it into the message suffix after the last breakpoint.".into());
                    Value::Object(r)
                })
                .collect(),
        ),
    );

    // TRDD-W0RRL2FZ: the resident-cost itemization, SESSION-SCOPED ONLY (null on workspace scope,
    // where it is deliberately not computed).
    let resident_cost = match session_id {
        None => Value::Null,
        Some(sid) => {
            // `.catch(() => null)` — a failed history read only omits the itemization.
            let history = get_history(sid);
            let steps = history.as_ref().and_then(|h| h.get("steps")).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
            match history {
                Some(h) if steps > 0 => {
                    let rc = crate::resident_cost::build_resident_cost_report(&h);
                    let total = f(&rc, "totalContextTokens");
                    let mut r = Map::new();
                    r.insert("estimated".into(), rc.get("estimated").cloned().unwrap_or(Value::Bool(true)));
                    r.insert("truncated".into(), rc.get("truncated").cloned().unwrap_or(Value::Bool(false)));
                    r.insert("stepCount".into(), rc.get("stepCount").cloned().unwrap_or(Value::Null));
                    r.insert("stepsWithUsage".into(), rc.get("stepsWithUsage").cloned().unwrap_or(Value::Null));
                    r.insert("compactionTurns".into(), rc.get("compactionTurns").cloned().unwrap_or(Value::Null));
                    r.insert("totalContextTokens".into(), rc.get("totalContextTokens").cloned().unwrap_or(Value::Null));
                    r.insert("itemizedResidentTokens".into(), rc.get("itemizedResidentTokens").cloned().unwrap_or(Value::Null));
                    r.insert("unattributedTokens".into(), rc.get("unattributedTokens").cloned().unwrap_or(Value::Null));
                    // NULL when there is no ground truth to divide by — a 0% would read as "nothing
                    // was itemized" rather than "the denominator is unknown".
                    r.insert(
                        "itemizedPct".into(),
                        if total > 0.0 { num(js_to_fixed_num(f(&rc, "itemizedResidentTokens") / total * 100.0, 1)) } else { Value::Null },
                    );
                    r.insert("note".into(), rc.get("note").cloned().unwrap_or(Value::Null));
                    r.insert(
                        "topBlocks".into(),
                        Value::Array(
                            rc.get("blocks")
                                .and_then(Value::as_array)
                                .map(Vec::as_slice)
                                .unwrap_or(&[])
                                .iter()
                                .take(10)
                                .map(|b| {
                                    // `{...b, drill}` — the spread first, so `drill` appends LAST.
                                    let mut o = b.as_object().cloned().unwrap_or_default();
                                    let mut d = Map::new();
                                    d.insert("tool".into(), "get_context_history".into());
                                    d.insert("sessionId".into(), Value::String(sid.to_owned()));
                                    d.insert("turn".into(), b.get("firstSeenTurn").cloned().unwrap_or(Value::Null));
                                    d.insert("blockId".into(), b.get("id").cloned().unwrap_or(Value::Null));
                                    o.insert("drill".into(), Value::Object(d));
                                    Value::Object(o)
                                })
                                .collect(),
                        ),
                    );
                    Value::Object(r)
                }
                // HONEST ABSENCE: an OTEL-only session (or a missing accessor) cannot be itemized.
                // Say so, rather than returning a silent null field that reads as "nothing resident".
                _ => {
                    let mut r = Map::new();
                    r.insert("message".into(), "No local transcript to itemize (history accessor unavailable, or OTEL-only session with no .jsonl on disk).".into());
                    Value::Object(r)
                }
            }
        }
    };
    m.insert("residentCost".into(), resident_cost);
    Value::Object(m)
}

/// `{...o, wastedCostUsd: +o.wastedCostUsd.toFixed(4)}` — a spread whose OVERWRITE of an existing
/// key keeps that key's ORIGINAL position, so the offender stays `label, kind, cause, occurrences,
/// wastedTokens, wastedCostUsd`. Re-inserting at the end would reorder the wire object; IndexMap's
/// `insert` on a present key preserves position for the same reason JS does.
fn offender_rounded(o: &Value) -> Value {
    let mut m = o.as_object().cloned().unwrap_or_default();
    let usd = o.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0);
    m.insert("wastedCostUsd".into(), num(js_to_fixed_num(usd, 4)));
    Value::Object(m)
}

/// `get_cache_break_report` (mcpServer.ts handleGetCacheBreakReport) — per-session break verdicts,
/// or a cross-session offender leaderboard. The engine is `crate::cache_break`.
///
/// `get_composition` is a CLOSURE (the TS accessor is async and per-session) and `report_for` runs
/// one transcript reparse per pooled session, so the caller must run this on a blocking thread with
/// the state lock released — the P4s rule.
///
/// `scan_deadline_ms` is the absolute wall-clock deadline, already resolved by the caller, so this
/// function stays pure: `scanWithBudget` checks its deadline BETWEEN items, never during one.
/// The TS `CompositionAccessor | null` — per-session, fallible, and NULLABLE, which is a distinct
/// state from "the accessor exists but this session has no transcript".
pub type CompositionAccessor<'a> = Option<&'a dyn Fn(&str) -> Option<Value>>;

/// `get_composition` is an `Option` rather than a separate `has_accessor` flag so the TS's
/// `if (!getComposition)` guard has exactly one representation — a bool beside the closure would
/// let the two disagree, and it pushed the signature past clippy's argument limit for nothing.
pub fn get_cache_break_report(
    sessions: &[Value],
    file_ids: &std::collections::HashSet<String>,
    args: &Value,
    get_composition: CompositionAccessor<'_>,
    timeline_of: &dyn Fn(&Value) -> Vec<Value>,
    now_ms: f64,
    time_budget_ms: f64,
) -> Value {
    let Some(get_composition) = get_composition else {
        return err("Composition accessor unavailable — cache-break analysis needs local Claude logs.".to_owned());
    };
    let model_of = |s: &Value| s.get("model").and_then(Value::as_str).unwrap_or_default().to_owned();
    let report_for = |s: &Value| -> Option<Value> {
        let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        crate::cache_break::build_cache_break_report(sid, &timeline_of(s), get_composition(sid).as_ref(), &model_of(s), now_ms)
    };

    if let Some(sid) = args.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let Some(s) = sessions.iter().find(|x| x.get("sessionId").and_then(Value::as_str) == Some(sid)) else {
            return err(format!("Session {sid} not found."));
        };
        let Some(report) = report_for(s) else {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(sid.to_owned()));
            m.insert(
                "message".into(),
                Value::String("Not enough data to diff (no local composition, or a single-turn session).".into()),
            );
            return Value::Object(m);
        };
        let empty: Vec<Value> = Vec::new();
        let broken: Vec<&Value> =
            report.get("turns").and_then(Value::as_array).unwrap_or(&empty).iter().filter(|t| truthy(&t["broke"])).collect();
        let mut m = Map::new();
        m.insert("sessionId".into(), report["sessionId"].clone());
        m.insert("model".into(), Value::String(model_of(s)));
        m.insert(
            "cacheHitRatePct".into(),
            num(crate::summarize::helpers::js_math_round(report.get("cacheHitRate").and_then(Value::as_f64).unwrap_or(0.0) * 100.0)),
        );
        m.insert("totalWastedTokens".into(), report["totalWastedTokens"].clone());
        m.insert(
            "totalWastedCostUsd".into(),
            num(js_to_fixed_num(report.get("totalWastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0), 4)),
        );
        m.insert("breakCount".into(), num(broken.len() as f64));
        let breaks: Vec<Value> = broken
            .iter()
            .take(40)
            .map(|t| {
                let mut b = Map::new();
                b.insert("turn".into(), t["turn"].clone());
                b.insert("cause".into(), t["cause"].clone());
                // `?? null` KEEPS the key as null — unlike the engine's own `breakSourceLabel`,
                // which is DROPPED when absent. Same datum, two different wire contracts.
                b.insert("block".into(), t.get("breakSourceLabel").cloned().unwrap_or(Value::Null));
                b.insert("wastedTokens".into(), t["wastedTokens"].clone());
                b.insert("wastedCostUsd".into(), num(js_to_fixed_num(t.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0), 4)));
                copy_opt(&mut b, t, "remediation");
                Value::Object(b)
            })
            .collect();
        m.insert("breaks".into(), Value::Array(breaks));
        let offenders = report.get("offenders").and_then(Value::as_array).unwrap_or(&empty);
        m.insert("topOffenders".into(), Value::Array(offenders.iter().take(10).map(offender_rounded).collect()));
        return Value::Object(m);
    }

    // TRIMMED under a truthy guard for the filter, and the ECHO is `scope ?? 'all'` on that same
    // TRIMMED value — so a whitespace workspace filters nothing and echoes `""`, not `"all"`. This
    // is the find_context_hogs variant; get_context_inflation_report echoes the RAW arg instead.
    // Three call sites, three answers for one input — assert each, never generalize.
    // ABSENT and PRESENT-BUT-BLANK are DIFFERENT: `args.workspace?.trim()` is `undefined` only when
    // the arg is missing (or null), so `?? 'all'` reads "all" there while a whitespace arg keeps its
    // trimmed `""`. Collapsing both to `""` up front loses that distinction and echoes `""` for an
    // absent arg — which is what this first failed on.
    let scope: Option<&str> = args.get("workspace").and_then(Value::as_str).map(str::trim);
    // Prefix ONLY and capped at 20 — NOT find_context_hogs' sessionId-substring rule at 25.
    let (pool, considered, with_log) = file_backed_pool(sessions, file_ids, scope.filter(|s| !s.is_empty()), 20, false);

    // Unconditional deadline, exactly as `scanWithBudget` computes it — a `> 0` guard would turn a
    // non-positive budget into "no budget" instead of "already elapsed".
    let deadline = crate::now_ms() as f64 + time_budget_ms;
    let mut merged: indexmap::IndexMap<String, (Value, Value, String, f64, f64, f64)> = indexmap::IndexMap::new();
    let mut analyzed = 0.0_f64;
    let mut scanned = 0usize;
    let mut stopped_early = false;
    let empty: Vec<Value> = Vec::new();
    for s in &pool {
        if crate::now_ms() as f64 > deadline {
            stopped_early = true;
            break;
        }
        let report = report_for(s);
        scanned += 1;
        let Some(report) = report else { continue };
        analyzed += 1.0;
        for o in report.get("offenders").and_then(Value::as_array).unwrap_or(&empty) {
            let cause = o.get("cause").and_then(Value::as_str).unwrap_or_default().to_owned();
            let kind = o.get("kind").cloned().unwrap_or(Value::Null);
            let label = o.get("label").cloned().unwrap_or(Value::Null);
            let key = format!("{}::{}::{}", cause, crate::summarize::helpers::js_string(&kind), crate::summarize::helpers::js_string(&label));
            let e = merged.entry(key).or_insert((label, kind, cause, 0.0, 0.0, 0.0));
            e.3 += o.get("occurrences").and_then(Value::as_f64).unwrap_or(0.0);
            e.4 += o.get("wastedTokens").and_then(Value::as_f64).unwrap_or(0.0);
            e.5 += o.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0);
        }
    }
    let mut ranked: Vec<(Value, Value, String, f64, f64, f64)> = merged.into_values().collect();
    ranked.sort_by(|a, b| {
        let d = b.5 - a.5;
        if d != 0.0 && !d.is_nan() {
            return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
        }
        (b.4 - a.4).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut m = Map::new();
    m.insert("scope".into(), Value::String(scope.unwrap_or("all").to_owned()));
    m.insert("sessionsConsidered".into(), num(considered));
    m.insert("sessionsWithLog".into(), num(with_log));
    m.insert("sessionsAnalyzed".into(), num(analyzed));
    if stopped_early {
        m.insert("scanStoppedEarly".into(), Value::Bool(true));
        m.insert(
            "scanNote".into(),
            Value::String(format!(
                "SAMPLE: the {}s scan budget stopped after {} of {} pooled sessions — retry to widen (reparsed timelines are cached).",
                fmt_js_num(time_budget_ms / 1000.0),
                scanned,
                pool.len()
            )),
        );
    }
    m.insert(
        "topOffenders".into(),
        Value::Array(
            ranked
                .iter()
                .take(15)
                .map(|(label, kind, cause, occ, tok, usd)| {
                    let mut o = Map::new();
                    o.insert("label".into(), label.clone());
                    o.insert("kind".into(), kind.clone());
                    o.insert("cause".into(), Value::String(cause.clone()));
                    o.insert("occurrences".into(), num(*occ));
                    o.insert("wastedTokens".into(), num(*tok));
                    o.insert("wastedCostUsd".into(), num(js_to_fixed_num(*usd, 4)));
                    Value::Object(o)
                })
                .collect(),
        ),
    );
    Value::Object(m)
}

/// Everything `get_cache_risk_costs` needs from its caller. A struct rather than six more
/// parameters: the signature would otherwise be 8 wide, and these six travel together — they are
/// the "where do I read from, and what clock/budget am I on" context, not per-call options.
pub struct CacheRiskCtx<'a> {
    pub file_ids: &'a std::collections::HashSet<String>,
    /// Transcript roots — `claudeProjectsDirs()` in the TS, injectable so the oracle can point at
    /// fixtures instead of the real `~/.claude`.
    pub dirs: &'a [std::path::PathBuf],
    pub get_composition: CompositionAccessor<'a>,
    pub timeline_of: &'a dyn Fn(&Value) -> Vec<Value>,
    pub now_ms: f64,
    pub time_budget_ms: f64,
}

/// `get_cache_risk_costs` / `reload-cost` (mcpServer.ts handleGetCacheRiskCosts, TRDD-EYA3X5MQ) —
/// "what did each cache-breaking command cost me?". EXACT, not inferred: Claude Code persists every
/// built-in slash command it runs as a transcript entry, so /reload-plugins, /reload-skills, a
/// mutating /plugin, /login|/logout, /mcp and /model are read straight off disk with their real
/// wall-clock. The COST comes from the same composition path `get_cache_break_report` uses, joined
/// on `CacheBreakTurn.tsMs`: a command at time T is billed on the FIRST turn at or after T, because
/// the local command makes no API call of its own and its changed prefix rides the NEXT request.
///
/// The join is also what settles the ambiguous commands. Bare /plugin, /mcp and /model open a
/// picker the user may simply close — so an invocation is only charged when the turn that followed
/// it actually broke. No break after it ⇒ cost 0, STATED as such, never quietly dropped.
///
/// The old co-churn heuristic survives ONLY as a labeled residue: reload-shaped turns that no
/// command explains. It over-counted badly (102 vs 69 actual) so it must never be summed into the
/// exact rows — but discarding it would hide real breaks in sessions whose transcript was rotated.
pub fn get_cache_risk_costs(sessions: &[Value], args: &Value, ctx: &CacheRiskCtx<'_>) -> Value {
    let Some(get_composition) = ctx.get_composition else {
        return err("Composition accessor unavailable — reload-cost needs local Claude logs.".to_owned());
    };
    let n = |k: &str| args.get(k).and_then(Value::as_f64);
    let cap = n("topN").unwrap_or(25.0).clamp(1.0, 200.0) as usize;
    // ABSENT vs PRESENT-BUT-BLANK again: `?.trim()` is undefined only when the arg is missing.
    let scope: Option<&str> = args.get("workspace").and_then(Value::as_str).map(str::trim);
    // TRUTHY on `args.window`, so `window: 0` means NO time filter — while `windowHours` below is
    // `args.window ?? null`, which reports the 0. The two guards disagree on purpose and a port
    // that unifies them either loses the echo or silently applies a zero-hour window.
    let since_ms = n("window").filter(|w| *w != 0.0).map(|w| ctx.now_ms - w * 3_600_000.0);
    let min_tokens = n("minTokens").unwrap_or(0.0).max(0.0);

    let kinds: Option<Vec<String>> = args
        .get("kinds")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect());

    // 1. The exact causes, off disk. Machine-wide and retroactive — no hook, no restart, no capture.
    let commands = crate::cache_risk_commands::scan_cache_risk_commands(ctx.dirs, since_ms, kinds.as_deref(), None);
    // TWO SOURCES, because a typed command is not the only way a prefix breaks. An effort change
    // needs no command at all, and MEASURED corpus-wide all 12 real effort transitions occurred in
    // sessions containing ZERO /effort commands — reading only commands scored 0 of 12 on a cause
    // that genuinely invalidates the prefix.
    let want_effort = kinds.as_ref().is_none_or(|k| k.iter().any(|x| x == "EFFORT_CHANGED"));
    let effort_events: Vec<Value> = if want_effort {
        crate::effort_transitions::scan_effort_transitions(ctx.dirs, since_ms, None, false)
            .iter()
            .map(crate::effort_transitions::effort_transition_as_risk_command)
            .collect()
    } else {
        Vec::new()
    };

    let mut by_session: indexmap::IndexMap<String, Vec<Value>> = indexmap::IndexMap::new();
    for c in commands.iter().chain(effort_events.iter()) {
        // TRUTHY: an empty session string is no session at all.
        let Some(sid) = c.get("session").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        by_session.entry(sid.to_owned()).or_default().push(c.clone());
    }

    // 2. Price them. Analysing a session is the expensive half, so spend the bounded pool ONLY on
    //    sessions a command was actually typed in — otherwise the budget goes to sessions that can
    //    contribute nothing to this report.
    let pred = |s: &Value| {
        let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if !by_session.contains_key(sid) {
            return false;
        }
        if let Some(sc) = scope.filter(|x| !x.is_empty()) {
            if !s.get("workspace").and_then(Value::as_str).unwrap_or("").starts_with(sc) {
                return false;
            }
        }
        if let Some(since) = since_ms {
            // `Date.parse(...) < sinceMs` is FALSE for NaN, so an unparseable startTime KEEPS the
            // session rather than dropping it — the JS comparison, not a `.unwrap_or(0.0)` that
            // would drop every card with a bad timestamp.
            let started = crate::summarize::helpers::parse_iso_ms(s.get("startTime").and_then(Value::as_str).unwrap_or(""));
            if started.is_some_and(|t| t < since) {
                return false;
            }
        }
        true
    };
    let (pool, considered, with_log) = file_backed_pool_with(sessions, ctx.file_ids, Some(&pred), 40);

    let deadline = crate::now_ms() as f64 + ctx.time_budget_ms;
    let empty: Vec<Value> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut residue: Vec<Value> = Vec::new();
    let (mut total_cc, mut total_cost, mut analyzed, mut priced) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
    let mut scanned = 0usize;
    let mut stopped_early = false;

    for card in &pool {
        if crate::now_ms() as f64 > deadline {
            stopped_early = true;
            break;
        }
        let sid = card.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let card_model = card.get("model").and_then(Value::as_str).map(str::to_owned);
        let report = crate::cache_break::build_cache_break_report(
            sid,
            &(ctx.timeline_of)(card),
            get_composition(sid).as_ref(),
            card_model.as_deref().unwrap_or(""),
            ctx.now_ms,
        );
        scanned += 1;
        let Some(report) = report else { continue };
        analyzed += 1.0;
        let report_sid = report.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();

        let mut cmds: Vec<Value> = by_session.get(&report_sid).cloned().unwrap_or_default();
        cmds.sort_by(|a, b| {
            let (x, y) = (a.get("ts").and_then(Value::as_f64).unwrap_or(0.0), b.get("ts").and_then(Value::as_f64).unwrap_or(0.0));
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut timed: Vec<&Value> =
            report.get("turns").and_then(Value::as_array).unwrap_or(&empty).iter().filter(|t| t.get("tsMs").is_some()).collect();
        timed.sort_by(|a, b| {
            let (x, y) = (a.get("tsMs").and_then(Value::as_f64).unwrap_or(0.0), b.get("tsMs").and_then(Value::as_f64).unwrap_or(0.0));
            x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
        });

        let mut explained: std::collections::HashSet<u64> = std::collections::HashSet::new();
        // A turn's cache_creation is ONE cost. Several commands can land before the same next turn
        // (two /login 18s apart, a /reload-plugins immediately followed by /reload-skills) — they
        // broke the prefix once, TOGETHER, so only the EARLIEST is charged and the rest are listed
        // at 0 with the reason. Charging each the full turn is exactly the double-count that made
        // the old heuristic untrustworthy; `cmds` is sorted ascending so "earliest" is first seen.
        let mut charged: std::collections::HashSet<u64> = std::collections::HashSet::new();
        for c in &cmds {
            let c_ts = c.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
            let billed = timed.iter().copied().find(|t| t.get("tsMs").and_then(Value::as_f64).unwrap_or(0.0) >= c_ts);
            let billed_turn = billed.and_then(|t| t.get("turn").and_then(Value::as_f64)).map(f64::to_bits);
            let already_charged = billed_turn.is_some_and(|t| charged.contains(&t));
            let wasted = billed.and_then(|t| t.get("wastedTokens").and_then(Value::as_f64)).unwrap_or(0.0);
            let broke = billed.is_some_and(|t| t.get("broke") == Some(&Value::Bool(true))) && wasted > 0.0 && !already_charged;
            if let Some(t) = billed_turn {
                explained.insert(t);
            }
            // The minTokens gate applies ONLY to a break: a non-breaking invocation is still LISTED
            // (at 0) so "this changed nothing" stays visible instead of looking like no data.
            if broke && wasted < min_tokens {
                continue;
            }
            let cc = if broke { wasted } else { 0.0 };
            let usd = if broke { billed.and_then(|t| t.get("wastedCostUsd").and_then(Value::as_f64)).unwrap_or(0.0) } else { 0.0 };
            if broke {
                if let Some(t) = billed_turn {
                    charged.insert(t);
                }
            }
            total_cc += cc;
            total_cost += usd;
            if cc > 0.0 {
                priced += 1.0;
            }
            let mut row = Map::new();
            row.insert("when".into(), Value::String(crate::summarize::helpers::iso_from_ms(c_ts)));
            row.insert(
                "sessionId".into(),
                Value::String(c.get("session").and_then(Value::as_str).unwrap_or(&report_sid).to_owned()),
            );
            copy_opt(&mut row, c, "command");
            copy_opt(&mut row, c, "kind");
            copy_opt(&mut row, c, "mutation");
            row.insert("turn".into(), billed.and_then(|t| t.get("turn").cloned()).unwrap_or(Value::Null));
            row.insert("cacheCreateTokens".into(), num(cc));
            row.insert("wastedCostUsd".into(), num(js_to_fixed_num(usd, 4)));
            // `model: r.card.model` — an undefined property is OMITTED by JSON.stringify, so an
            // unknown model drops the key without moving `evidence`.
            if let Some(m) = &card_model {
                row.insert("model".into(), Value::String(m.clone()));
            }
            row.insert("evidence".into(), Value::String("exact".into()));
            if let Some(a) = c.get("args").filter(|v| truthy(v)) {
                row.insert("args".into(), a.clone());
            }
            let turn_label = billed.and_then(|t| t.get("turn").and_then(Value::as_f64)).map(fmt_js_num).unwrap_or_default();
            if billed.is_none() {
                row.insert("note".into(), Value::String("no turn recorded at or after this command — cost unattributable".into()));
            } else if already_charged {
                row.insert(
                    "note".into(),
                    Value::String(format!(
                        "turn {turn_label} was already charged to an earlier command — they broke the prefix once, together"
                    )),
                );
            } else if !broke {
                row.insert(
                    "note".into(),
                    Value::String("the next turn did not break — this invocation changed nothing (menu opened and closed)".into()),
                );
            }
            rows.push(Value::Object(row));
        }
        // Reload-shaped turns nothing explains. Reported separately, NEVER summed with the exact
        // rows — the heuristic over-counts, but dropping it would hide real breaks in sessions
        // whose transcript has been rotated away.
        for t in report.get("turns").and_then(Value::as_array).unwrap_or(&empty) {
            let wasted = t.get("wastedTokens").and_then(Value::as_f64).unwrap_or(0.0);
            let turn_bits = t.get("turn").and_then(Value::as_f64).map(f64::to_bits);
            if t.get("cause").and_then(Value::as_str) != Some("PLUGINS_RELOADED")
                || wasted <= 0.0
                || turn_bits.is_some_and(|b| explained.contains(&b))
            {
                continue;
            }
            let mut r = Map::new();
            r.insert("sessionId".into(), Value::String(report_sid.clone()));
            r.insert("turn".into(), t.get("turn").cloned().unwrap_or(Value::Null));
            r.insert("catalogs".into(), t.get("breakSourceLabel").cloned().unwrap_or(Value::Null));
            r.insert("cacheCreateTokens".into(), num(wasted));
            r.insert("wastedCostUsd".into(), num(js_to_fixed_num(t.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0), 4)));
            r.insert("evidence".into(), Value::String("inference".into()));
            residue.push(Value::Object(r));
        }
    }

    // Newest-first by the ISO string. A STABLE sort, so same-timestamp rows keep discovery order.
    rows.sort_by(|a, b| b["when"].as_str().unwrap_or("").cmp(a["when"].as_str().unwrap_or("")));
    let shown: Vec<Value> = rows.iter().take(cap).cloned().collect();

    // `costUsd` is re-rounded to 4dp on EVERY accumulation, not once at the end — so the total is
    // the sum of rounded partials, not the rounded sum. Rounding only at the end drifts.
    let mut by_kind: indexmap::IndexMap<String, (f64, f64, f64)> = indexmap::IndexMap::new();
    for r in &rows {
        let k = r.get("kind").and_then(Value::as_str).unwrap_or("").to_owned();
        let e = by_kind.entry(k).or_insert((0.0, 0.0, 0.0));
        e.0 += 1.0;
        e.1 += r.get("cacheCreateTokens").and_then(Value::as_f64).unwrap_or(0.0);
        e.2 = js_to_fixed_num(e.2 + r.get("wastedCostUsd").and_then(Value::as_f64).unwrap_or(0.0), 4);
    }

    let mut m = Map::new();
    // NULLISH on the RAW arg — so `window: 0` echoes 0 here while filtering nothing above.
    m.insert("windowHours".into(), n("window").map(num).unwrap_or(Value::Null));
    m.insert("scope".into(), Value::String(scope.unwrap_or("all").to_owned()));
    m.insert("commandsFoundInTranscripts".into(), num(commands.len() as f64));
    m.insert("sessionsWithCommands".into(), num(by_session.len() as f64));
    m.insert("sessionsConsidered".into(), num(considered));
    m.insert("sessionsWithLog".into(), num(with_log));
    m.insert("sessionsAnalyzed".into(), num(analyzed));
    m.insert("eventsPriced".into(), num(priced));
    m.insert("eventsListed".into(), num(rows.len() as f64));
    m.insert("totalCacheCreateTokens".into(), num(total_cc));
    m.insert("totalCostUsd".into(), num(js_to_fixed_num(total_cost, 4)));
    let mut bk = Map::new();
    for (k, (events, cc, usd)) in &by_kind {
        let mut e = Map::new();
        e.insert("events".into(), num(*events));
        e.insert("cacheCreateTokens".into(), num(*cc));
        e.insert("costUsd".into(), num(*usd));
        bk.insert(k.clone(), Value::Object(e));
    }
    m.insert("byKind".into(), Value::Object(bk));
    if stopped_early {
        m.insert("scanStoppedEarly".into(), Value::Bool(true));
        m.insert(
            "scanNote".into(),
            Value::String(format!(
                "SAMPLE: the {}s scan budget stopped after {} of {} pooled sessions — retry to widen (reparsed timelines are cached).",
                fmt_js_num(ctx.time_budget_ms / 1000.0),
                scanned,
                pool.len()
            )),
        );
    }
    m.insert("events".into(), Value::Array(shown.clone()));
    if rows.len() > cap {
        m.insert(
            "eventsNote".into(),
            Value::String(format!("Showing the most recent {} of {} (raise topN, max 200).", shown.len(), rows.len())),
        );
    }
    if !residue.is_empty() {
        m.insert("unexplainedReloadTurns".into(), Value::Array(residue.iter().take(cap).cloned().collect()));
        m.insert(
            "unexplainedNote".into(),
            Value::String(format!(
                "{} reload-shaped turn(s) had no matching command in the transcript (co-churn INFERENCE — historically over-counts; listed separately and NOT included in the totals above).",
                residue.len()
            )),
        );
    }
    // NOTE the first branch counts SLASH COMMANDS ONLY: a window whose only cause was an effort
    // transition reports 0 found and says so, even though `events` is non-empty. That is the TS's
    // wording and the number it counts — not a bug to smooth over here.
    if commands.is_empty() {
        m.insert("note".into(), Value::String("No cache-risk commands found in the transcripts for this window/scope.".into()));
    } else if rows.is_empty() {
        m.insert(
            "note".into(),
            Value::String(format!(
                "Found {} command(s) in the transcripts, but none of their sessions is in the analysable pool (needs local Claude logs + composition). Widen the window or drop the workspace filter.",
                commands.len()
            )),
        );
    }
    Value::Object(m)
}

// ── check_cache_expiry (TRDD-OCNHOHE9 / mcpServer.ts handleCheckCacheExpiry) ──────────────────
// Is a session past its prompt-cache TTL? Finds each target's last LLM-request time, classifies
// its per-session TTL regime (crate::burn::cache_ttl), and reports fresh/expired/unknown.

/// `formatIdle` (src/cacheExpiry.ts) — "45s" · "1m 30s" · "1h 2m". Hours drop the seconds;
/// negative durations clamp to 0s.
pub fn format_idle(ms: f64) -> String {
    let total_sec = (ms.max(0.0) / 1000.0).floor();
    let h = (total_sec / 3600.0).floor();
    let m = ((total_sec % 3600.0) / 60.0).floor();
    let s = total_sec % 60.0;
    if h > 0.0 {
        format!("{}h {}m", h as i64, m as i64)
    } else if m > 0.0 {
        format!("{}m {}s", m as i64, s as i64)
    } else {
        format!("{}s", s as i64)
    }
}

/// `assessCacheExpiry` (src/cacheExpiry.ts) — pure idle-vs-TTL verdict. Key order matches the TS
/// object literal EXACTLY: both branches build `{verdict, idleMs, idleHuman, marginMs, reason,
/// ...base}` where `base = {ttlMs, ttlMin, ttlSource, ttlBasis, usedThresholdOverride}` — the
/// spread appends `base`'s fields at the END, not at their declared interface position.
pub fn assess_cache_expiry(
    last_request_at_ms: Option<f64>,
    now_ms: f64,
    kind: Option<crate::burn::cache_ttl::SessionTtlKind>,
    ctx: Option<&crate::burn::cache_ttl::TtlContext>,
    threshold_ms: Option<f64>,
) -> Value {
    let regime = crate::burn::cache_ttl::classify_ttl_regime(kind, ctx);
    // A positive explicit threshold overrides the regime TTL AND its provenance — the user's
    // cutoff decided the number, so ttlSource becomes 'config' regardless of what the regime said.
    let override_ = threshold_ms.is_some_and(|t| t > 0.0);
    let ttl_ms = if override_ { threshold_ms.unwrap() } else { regime.ttl_ms };
    let ttl_min = crate::summarize::helpers::js_math_round(ttl_ms / 60_000.0);
    let ttl_source: &str = if override_ { "config" } else { regime.ttl_source };
    let ttl_basis = if override_ {
        format!(
            "explicit --threshold-minutes={} override (regime would use {}m)",
            fmt_js_num(ttl_min),
            fmt_js_num(regime.ttl_assumed_min)
        )
    } else {
        regime.ttl_basis.clone()
    };

    let mut m = Map::new();
    let Some(last_ms) = last_request_at_ms else {
        m.insert("verdict".into(), "unknown".into());
        m.insert("idleMs".into(), Value::Null);
        m.insert("idleHuman".into(), Value::Null);
        m.insert("marginMs".into(), Value::Null);
        m.insert(
            "reason".into(),
            "no LLM request recorded for this session — cannot measure idle time or cache freshness".into(),
        );
        m.insert("ttlMs".into(), num(ttl_ms));
        m.insert("ttlMin".into(), num(ttl_min));
        m.insert("ttlSource".into(), ttl_source.into());
        m.insert("ttlBasis".into(), ttl_basis.into());
        m.insert("usedThresholdOverride".into(), Value::Bool(override_));
        return Value::Object(m);
    };

    // Every cache HIT resets the inactivity timer, so idle is measured from the LAST request. A
    // future timestamp (clock skew across machines) clamps to 0 rather than a negative idle.
    let idle_ms = (now_ms - last_ms).max(0.0);
    let expired = idle_ms > ttl_ms;
    m.insert("verdict".into(), (if expired { "expired" } else { "fresh" }).into());
    m.insert("idleMs".into(), num(idle_ms));
    m.insert("idleHuman".into(), format_idle(idle_ms).into());
    m.insert("marginMs".into(), num(ttl_ms - idle_ms));
    m.insert(
        "reason".into(),
        if expired {
            format!(
                "idle {} exceeds the {}-min TTL — the cached prefix has likely been evicted; the next request pays a full cache-creation write (~1.25× the prefix)",
                format_idle(idle_ms),
                fmt_js_num(ttl_min)
            )
        } else {
            format!(
                "idle {} is within the {}-min TTL — the cached prefix is likely still warm",
                format_idle(idle_ms),
                fmt_js_num(ttl_min)
            )
        }
        .into(),
    );
    m.insert("ttlMs".into(), num(ttl_ms));
    m.insert("ttlMin".into(), num(ttl_min));
    m.insert("ttlSource".into(), ttl_source.into());
    m.insert("ttlBasis".into(), ttl_basis.into());
    m.insert("usedThresholdOverride".into(), Value::Bool(override_));
    Value::Object(m)
}

/// `lastLlmRequestMs` (src/mcpServer.ts) — the freshest billed call. `api_request` entries are
/// the ground-truth LLM calls; `llm` spans are a fallback for OTEL-only cards that predate log
/// correlation. NaN timestamps are skipped, not zeroed.
fn last_llm_request_ms(timeline: &[Value]) -> Option<f64> {
    let mut best: Option<f64> = None;
    for e in timeline {
        let ty = e.get("type").and_then(Value::as_str);
        if ty != Some("api_request") && ty != Some("llm") {
            continue;
        }
        let Some(ms) = crate::summarize::helpers::parse_iso_ms(e.get("timestamp").and_then(Value::as_str).unwrap_or("")) else {
            continue;
        };
        if best.is_none_or(|b| ms > b) {
            best = Some(ms);
        }
    }
    best
}

/// `assessOneSession` (src/mcpServer.ts) — the TTL verdict for ONE card, projected into a
/// `CacheExpiryRow`. Key order: `{...verdict, sessionId, workspace, kind, lastRequestAt}` — the
/// verdict's own fields first (spread), then the four session-identifying fields appended.
///
/// `precomputed_last_ms`: `Some` = the caller already resolved the last-request time (a bounded
/// tail read) and it must NOT be recomputed via a full-transcript reparse; `None` = fall back to
/// `last_llm_request_ms` over `timeline_of(card)`.
fn assess_one_session(
    card: &Value,
    timeline_of: &dyn Fn(&Value) -> Vec<Value>,
    ttl_ctx: Option<&crate::burn::cache_ttl::TtlContext>,
    now_ms: f64,
    threshold_ms: Option<f64>,
    precomputed_last_ms: Option<f64>,
) -> Value {
    let last_ms = precomputed_last_ms.or_else(|| last_llm_request_ms(&timeline_of(card)));
    let kind = crate::burn::cache_ttl::session_ttl_kind_of(card);
    let verdict = assess_cache_expiry(last_ms, now_ms, Some(kind), ttl_ctx, threshold_ms);
    let mut m = verdict.as_object().cloned().unwrap_or_default();
    m.insert("sessionId".into(), card.get("sessionId").cloned().unwrap_or(Value::Null));
    m.insert("workspace".into(), card.get("workspace").cloned().unwrap_or(Value::Null));
    m.insert("kind".into(), kind.as_str().into());
    m.insert(
        "lastRequestAt".into(),
        match last_ms {
            Some(ms) => Value::String(crate::summarize::helpers::iso_from_ms(ms)),
            None => Value::Null,
        },
    );
    Value::Object(m)
}

/// `EXPIRY_NEWEST_PROBE` (src/mcpServer.ts) — how many newest-by-activity candidates the DEFAULT
/// path reparses to find the caller's active conversation.
pub const EXPIRY_NEWEST_PROBE: usize = 12;

/// `workspaceUnder` (src/mcpServer.ts) — is this card's workspace AT or UNDER `root`?
/// Path-boundary aware on purpose: a bare `starts_with` would make `/x/y` match the sibling
/// `/x/y-old`.
fn workspace_under(workspace: Option<&str>, root: &str) -> bool {
    let Some(w) = workspace.filter(|w| !w.is_empty()) else { return false };
    let w = w.trim_end_matches('/');
    let r = root.trim_end_matches('/');
    w == r || w.starts_with(&format!("{r}/"))
}

/// `handleCheckCacheExpiry` (src/mcpServer.ts, exported for unit tests — X2E6OSWK) — is a
/// session past its prompt-cache TTL?
///
/// `timeline_of` mirrors `asTimeline(getTimeline, id, card)`: the closure is the getTimeline
/// accessor with the inline-timeline fallback already folded in by the caller.
/// `now_ms` is injected (the TS reads `Date.now()` internally) so the assessment is pure and
/// testable — the caller passes the real wall clock in production.
/// `get_last_request_ms` mirrors the optional tail resolver: `Some(f)` = a bounded 256KB tail
/// read; `None` = the TS's no-resolver path (full reparse per probed candidate, preserved
/// unchanged for parity with tests/older embedders).
#[allow(clippy::type_complexity)] // mirrors timeline_of's closure-injection shape, just optional
pub fn check_cache_expiry(
    sessions: &[Value],
    timeline_of: &dyn Fn(&Value) -> Vec<Value>,
    ttl_ctx: Option<&crate::burn::cache_ttl::TtlContext>,
    args: &Value,
    now_ms: f64,
    time_budget_ms: f64,
    get_last_request_ms: Option<&dyn Fn(&str) -> Option<f64>>,
) -> Value {
    let threshold_minutes = args.get("thresholdMinutes").and_then(Value::as_f64);
    let threshold_ms = threshold_minutes.filter(|t| *t > 0.0).map(|t| t * 60_000.0);

    if let Some(sid) = args.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let targets: Vec<&Value> = sessions.iter().filter(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid)).collect();
        let rows: Vec<Value> =
            targets.iter().map(|c| assess_one_session(c, timeline_of, ttl_ctx, now_ms, threshold_ms, None)).collect();
        let mut m = Map::new();
        m.insert("sessions".into(), Value::Array(rows));
        return Value::Object(m);
    }

    // PROJECT SCOPE (a correctness fix, not a convenience): the default pick must be the newest
    // session WITHIN the caller's project, never machine-wide. An explicit empty string is the
    // documented opt-out (`project: ""` = machine-wide).
    let project_root = args.get("project").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(|s| s.trim_end_matches('/').to_owned());
    let in_scope: Vec<&Value> = match &project_root {
        Some(root) => sessions
            .iter()
            .filter(|s| {
                let ws = s.get("projectPath").and_then(Value::as_str).or_else(|| s.get("workspace").and_then(Value::as_str));
                workspace_under(ws, root)
            })
            .collect(),
        None => sessions.iter().collect(),
    };
    let mut scope = Map::new();
    scope.insert("project".into(), project_root.clone().map(Value::String).unwrap_or(Value::Null));
    scope.insert("sessionsInScope".into(), num(in_scope.len() as f64));
    let scope = Value::Object(scope);
    let sessions: Vec<&Value> = in_scope;

    if truthy(args.get("all").unwrap_or(&Value::Null)) {
        // Whole-corpus assessment, newest-activity first so the budget spends itself on the
        // sessions a caller actually cares about.
        let mut pool: Vec<&Value> = sessions.clone();
        pool.sort_by(|a, b| crate::burn::monitor::last_activity_ms(b).partial_cmp(&crate::burn::monitor::last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
        // UNCONDITIONAL, exactly as `scanWithBudget` computes it: `Date.now() + timeBudgetMs`. A
        // `> 0` guard here would INVERT the meaning of a zero/negative budget — the TS treats that
        // as an already-elapsed deadline (stop immediately, `stoppedEarly: true`), while an
        // Option-gated deadline reads it as "no budget" and scans the whole corpus.
        let deadline = crate::now_ms() as f64 + time_budget_ms;
        let mut results: Vec<Value> = Vec::new();
        let mut scanned: Vec<&Value> = Vec::new();
        let mut stopped_early = false;
        for c in &pool {
            if crate::now_ms() as f64 > deadline {
                stopped_early = true;
                break;
            }
            results.push(assess_one_session(c, timeline_of, ttl_ctx, now_ms, threshold_ms, None));
            scanned.push(c);
        }
        let mut cov = Map::new();
        cov.insert("sessionsConsidered".into(), num(pool.len() as f64));
        cov.insert("sessionsScanned".into(), num(scanned.len() as f64));
        cov.insert("stoppedEarly".into(), Value::Bool(stopped_early));
        cov.insert(
            "note".into(),
            if stopped_early {
                format!(
                    "SAMPLE, not full coverage: the {}s scan budget stopped after {} of {} sessions (newest-activity first; reparsed timelines are cached on their cards, so a retry widens coverage).",
                    fmt_js_num(time_budget_ms / 1000.0),
                    scanned.len(),
                    pool.len()
                )
            } else {
                format!("Complete coverage: all {} sessions assessed.", pool.len())
            }
            .into(),
        );
        let mut m = Map::new();
        m.insert("sessions".into(), Value::Array(results));
        m.insert("scope".into(), scope);
        m.insert("coverage".into(), Value::Object(cov));
        return Value::Object(m);
    }

    // Default: the caller's active conversation — the newest MAIN session by its last LLM
    // request. Fall back to any kind if there are no main cards. BOUNDED: rank by card-metadata
    // lastActivityMs (cheap), reparse ONLY the top EXPIRY_NEWEST_PROBE candidates for the precise
    // last-request time.
    let mains: Vec<&Value> = sessions.iter().copied().filter(|s| crate::burn::cache_ttl::session_ttl_kind_of(s) == crate::burn::cache_ttl::SessionTtlKind::Main).collect();
    let mut pool: Vec<&Value> = if !mains.is_empty() { mains } else { sessions.clone() };
    pool.sort_by(|a, b| crate::burn::monitor::last_activity_ms(b).partial_cmp(&crate::burn::monitor::last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
    pool.truncate(EXPIRY_NEWEST_PROBE);

    // Unconditional — see the `all` branch above for why a `> 0` guard inverts a zero/negative
    // budget instead of honouring it.
    let deadline = crate::now_ms() as f64 + time_budget_ms;
    // Each probed candidate: (card, tailMs, ms) — ms is what ranks the pool; tailMs (if a tail
    // resolver answered) is reused by the eventual winner so it does not trigger a second reparse.
    let mut probed: Vec<(&Value, Option<f64>, f64)> = Vec::new();
    let mut probe_stopped_early = false;
    for s in &pool {
        if crate::now_ms() as f64 > deadline {
            probe_stopped_early = true;
            break;
        }
        let (tail_ms, ms) = match get_last_request_ms {
            Some(resolver) => {
                let tail_ms = resolver(s.get("sessionId").and_then(Value::as_str).unwrap_or(""));
                (tail_ms, tail_ms.unwrap_or_else(|| crate::burn::monitor::last_activity_ms(s)))
            }
            None => {
                let ms = last_llm_request_ms(&timeline_of(s))
                    .unwrap_or_else(|| crate::summarize::helpers::parse_iso_ms(s.get("startTime").and_then(Value::as_str).unwrap_or("")).unwrap_or(f64::NAN));
                (None, ms)
            }
        };
        probed.push((s, tail_ms, ms));
    }

    let mut newest: Option<&Value> = None;
    let mut newest_ms = -1.0_f64;
    let mut newest_tail_ms: Option<f64> = None;
    for (s, tail_ms, ms) in &probed {
        if !ms.is_nan() && *ms > newest_ms {
            newest_ms = *ms;
            newest = Some(s);
            newest_tail_ms = *tail_ms;
        }
    }

    let rows: Vec<Value> = match newest {
        Some(c) => vec![assess_one_session(c, timeline_of, ttl_ctx, now_ms, threshold_ms, newest_tail_ms)],
        None => Vec::new(),
    };
    let mut m = Map::new();
    m.insert("sessions".into(), Value::Array(rows));
    m.insert("scope".into(), scope);
    // Honest pick: a budget-stopped probe chose from a subset — say so instead of presenting the
    // pick as the corpus-wide newest.
    if probe_stopped_early {
        m.insert(
            "note".into(),
            "Newest-session probe stopped early on the scan time budget — the pick is from the probed subset only.".into(),
        );
    }
    Value::Object(m)
}
