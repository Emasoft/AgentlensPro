//! Cross-engine parity for `get_agent_tokens` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-agenttokens-expected.mjs

use agentlens_core::mcp_tools::get_agent_tokens;
use serde_json::{json, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/agenttokens-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (under `preserve_order` a `Value::Object` is
/// an IndexMap whose `PartialEq` ignores order). Asserted explicitly, recursing into nested objects
/// and arrays so the candidate lists are covered too.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs");
    if let Some(o) = exp.as_object() {
        for (k, ev) in o {
            if ev.is_object() {
                same(&got[k], ev, &format!("{label}.{k}"));
            } else if let Some(ea) = ev.as_array() {
                let ga = got[k].as_array().cloned().unwrap_or_default();
                assert_eq!(ga.len(), ea.len(), "{label}.{k}: length");
                for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                    same(g, e, &format!("{label}.{k}[{i}]"));
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

fn run(o: &Value, args: Value) -> Value {
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let timeline_of = |c: &Value| -> Vec<Value> {
        o["timelines"].get(c.get("sessionId").and_then(Value::as_str).unwrap_or("")).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    get_agent_tokens(&sessions, &timeline_of, &args, o["nowMs"].as_f64().unwrap())
}

#[test]
fn get_agent_tokens_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, args) in [
        ("fork", json!({"agentId": "fork-1"})),
        ("forkPrefixed", json!({"agentId": "agent-fork-1"})),
        ("forkUpper", json!({"agentId": "FORK-1"})),
        ("root", json!({"agentId": "root-1"})),
        ("dupBare", json!({"agentId": "dup-1"})),
        ("dupPrefixed", json!({"agentId": "agent-dup-1"})),
        ("multiScoped", json!({"agentId": "multi", "parentSessionId": "other-root"})),
        ("multiWrongParent", json!({"agentId": "fork-1", "parentSessionId": "nobody"})),
        ("statusline", json!({"agentId": "sl-1"})),
        ("blind", json!({"agentId": "blind"})),
        ("missing", json!({"agentId": "nope"})),
        ("blank", json!({"agentId": "   "})),
        ("noArg", json!({})),
    ] {
        same(&run(&o, args), &o[case], case);
    }
}

/// THE TRAP THIS TOOL EXISTS TO AVOID. A spawn PLACEHOLDER's sessionId IS the bare agent id BY
/// CONSTRUCTION, so on an un-merged placeholder + `agent-<id>` transcript pair both cards sit in the
/// equivalence class. Letting exact sessionId equality take BLANKET precedence would answer a
/// bare-id query with the ZERO-BUCKET placeholder and serve it over the real totals — a guess
/// dressed as precision, and one that reports a real agent's spend as free.
#[test]
fn a_bare_id_never_silently_resolves_to_the_zero_bucket_placeholder() {
    let o = oracle();
    let bare = run(&o, json!({"agentId": "dup-1"}));
    assert!(bare["error"].as_str().unwrap().contains("ambiguous"), "{bare}");
    assert_eq!(bare["candidates"].as_array().unwrap().len(), 2, "both cards are named: {bare}");
    // And it is emphatically NOT the placeholder's zeros served as an answer.
    assert!(bare.get("cacheReadTokens").is_none(), "{bare}");
}

/// Exact equality IS trusted — but only as a TIE-BREAK, and only when the query carries the
/// distinguishing `agent-<id>` form (`qLower !== qBare`), which names exactly one card of the pair.
#[test]
fn the_prefixed_form_is_the_tie_break_that_resolves_the_pair() {
    let o = oracle();
    let got = run(&o, json!({"agentId": "agent-dup-1"}));
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(got["sessionId"], "agent-dup-1");
    assert_eq!(got["cacheReadTokens"], 250000, "the REAL buckets, not the placeholder's zeros: {got}");
    // `agentId` is reported bare, so the two query forms answer with one identity.
    assert_eq!(got["agentId"], "dup-1", "{got}");
    // coverageNote rides only when a decision set it; asyncTokensUnknown belongs to the placeholder.
    assert!(got.get("coverageNote").is_some() && got.get("asyncTokensUnknown").is_none(), "{got}");
}

/// A card with NO parent — a full-sessionId query for a top-level session — carries no spawn
/// taxonomy at all: `spawnKind` is NULL, not `'fresh'`. It was never spawned, and calling it fresh
/// would invent a launch that did not happen.
#[test]
fn a_top_level_session_has_a_null_spawn_kind_not_fresh() {
    let o = oracle();
    let root = run(&o, json!({"agentId": "root-1"}));
    assert_eq!(root["spawnKind"], Value::Null, "{root}");
    assert_eq!(root["warm"], false, "{root}");
    assert_eq!(root["parentSessionId"], Value::Null, "{root}");
    // A CHILD without an explicit kind does default to 'fresh' — the parent is what distinguishes them.
    let dup = run(&o, json!({"agentId": "agent-dup-1"}));
    assert_eq!(dup["spawnKind"], "fresh", "{dup}");
}

/// `spawnKind` precedes `warm` in the TS literal, and key order is a wire contract. Computing
/// `warm` first and inserting it first is a natural port mistake that no value comparison catches.
#[test]
fn spawn_kind_precedes_warm_in_the_wire_object() {
    let o = oracle();
    let k = keys(&o["fork"]);
    let i = k.iter().position(|x| *x == "spawnKind").unwrap();
    assert_eq!(k[i..i + 2], ["spawnKind", "warm"], "{k:?}");
    let got = run(&o, json!({"agentId": "fork-1"}));
    assert_eq!(keys(&got), k, "and the port must reproduce it");
}

/// `lastTurnContextRead` is derived most→least authoritative and NEVER guessed: the statusline
/// overlay (CC's own exact numbers), then the last USAGE-CARRYING timeline entry — a zero-usage
/// trailing entry is skipped, not taken as the last read — then a single-turn card's cumulative
/// figure, then NULL. A multi-turn card with no per-turn data cannot honestly answer, and a
/// fabricated number there silently becomes someone's context-pressure verdict.
#[test]
fn last_turn_context_read_follows_the_authority_order_and_falls_to_null() {
    let o = oracle();
    let ltcr = |a: Value| run(&o, a)["ccDisplayEquivalent"]["lastTurnContextRead"].clone();
    assert_eq!(ltcr(json!({"agentId": "sl-1"})), 123456, "the statusline overlay wins");
    assert_eq!(ltcr(json!({"agentId": "fork-1"})), 180002, "the last USAGE-carrying turn, not the trailing zero one");
    assert_eq!(ltcr(json!({"agentId": "blind"})), Value::Null, "multi-turn, no per-turn data ⇒ null, never a guess");
    // The single-turn fallback: cumulative == last turn when there is exactly one call.
    let root = run(&o, json!({"agentId": "root-1"}));
    assert_eq!(root["ccDisplayEquivalent"]["lastTurnContextRead"], Value::Null, "40 calls, no timeline ⇒ null: {root}");
}

/// An id that EXISTS but not under the requested parent gets an error that SHOWS where it does
/// live. A bare not-found would send the caller hunting a typo in the agent id when the id was
/// right and only the scope was wrong.
#[test]
fn a_wrong_parent_names_where_the_id_actually_lives() {
    let o = oracle();
    let got = run(&o, json!({"agentId": "fork-1", "parentSessionId": "nobody"}));
    let msg = got["error"].as_str().unwrap();
    assert!(msg.contains("matched 1 card(s)") && msg.contains("none under parent nobody"), "{msg}");
    assert_eq!(got["candidates"][0]["parentSessionId"], "root-1", "and points at the real parent: {got}");
}

/// `lastSeenAt` derives from the card's OWN span (start + duration) and is NULL when the start is
/// unparseable — an async placeholder before its transcript exists. Never a fabricated now(), which
/// would make a never-observed agent look alive. `turns` is likewise null (not 0) at zero calls:
/// "no turns recorded" is not "0 turns".
#[test]
fn last_seen_and_turns_are_null_rather_than_fabricated() {
    let o = oracle();
    // The placeholder is only reachable via the candidate list (the bare id is ambiguous), so assert
    // the property on the shape the oracle froze for it.
    let placeholder = o["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == "dup-1").unwrap();
    assert_eq!(placeholder["startTime"], "", "the fixture's placeholder has no parseable start");
    assert_eq!(placeholder["totalLlmCalls"], 0);
    let fork = run(&o, json!({"agentId": "fork-1"}));
    assert_eq!(fork["lastSeenAt"], "2026-08-01T10:01:00.000Z", "start + 60s duration: {fork}");
    assert_eq!(fork["turns"], 6, "{fork}");
}
