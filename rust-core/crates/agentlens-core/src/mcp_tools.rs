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
fn file_backed_pool<'a>(
    sessions: &'a [Value],
    file_ids: &std::collections::HashSet<String>,
    scope: Option<&str>,
    limit: usize,
) -> (Vec<&'a Value>, f64, f64) {
    let scoped: Vec<&Value> = match scope {
        // `(s.workspace ?? '').startsWith(scope) || s.sessionId.includes(scope)` — a scope matches
        // either a workspace PREFIX or a session-id SUBSTRING, so a bare id fragment works as a scope.
        Some(sc) => sessions
            .iter()
            .filter(|s| {
                s.get("workspace").and_then(Value::as_str).unwrap_or("").starts_with(sc)
                    || s.get("sessionId").and_then(Value::as_str).unwrap_or("").contains(sc)
            })
            .collect(),
        None => sessions.iter().collect(),
    };
    let backed: Vec<&Value> =
        scoped.iter().copied().filter(|s| file_ids.contains(s.get("sessionId").and_then(Value::as_str).unwrap_or(""))).collect();
    let (considered, with_log) = (scoped.len() as f64, backed.len() as f64);
    (backed.into_iter().take(limit).collect(), considered, with_log)
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
    let (pool, considered, with_log) = file_backed_pool(sessions, file_ids, scope, HOG_SCAN_CAP);

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
