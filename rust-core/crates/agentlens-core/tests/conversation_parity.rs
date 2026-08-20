//! Cross-engine parity for conversation.ts (TRDD-DMWOBWFH P4w.2c, freeze row 34).
//!
//! After any TS change:
//!   pnpm run compile-tests \
//!     && node rust-core/crates/agentlens-core/tests/fixtures/gen-conversation-expected.mjs \
//!     && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxcomposition-expected.mjs

use agentlens_core::conversation::{build_conversation, build_conversation_from_file};
use agentlens_logscan::discovery::Env;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/conversation-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn projects_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home/projects/proj-a")
}

fn fixture_env() -> Env {
    let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home");
    let mut env = Env::from_process();
    env.vars.clear();
    env.vars.insert("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().into_owned());
    env
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

fn cmp(got: &Value, exp: &Value, ctx: &str) {
    if exp.is_null() {
        assert!(got.is_null(), "{ctx}: TS null, Rust {got}");
        return;
    }
    assert!(!got.is_null(), "{ctx}: TS returned a value, Rust returned null");
    if exp.is_object() {
        assert_eq!(keys(got), keys(exp), "{ctx}: key set/ORDER differs (an `undefined` field must be OMITTED, never null)");
        for (k, ev) in exp.as_object().unwrap() {
            cmp(&got[k], ev, &format!("{ctx}.{k}"));
        }
        return;
    }
    if let (Some(ga), Some(ea)) = (got.as_array(), exp.as_array()) {
        assert_eq!(ga.len(), ea.len(), "{ctx}: array length differs\n  got: {got}\n  exp: {exp}");
        for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
            cmp(g, e, &format!("{ctx}[{i}]"));
        }
        return;
    }
    assert_eq!(got, exp, "{ctx}");
}

#[test]
fn build_conversation_from_file_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let env = fixture_env();
    for (case, exp) in o["fileCases"].as_array().unwrap().iter().zip(o["fromFile"].as_array().unwrap()) {
        let name = case.as_str().unwrap();
        let path = projects_dir().join(name);
        let got = build_conversation_from_file(&env, path.to_str().unwrap(), "conv-main").unwrap_or(Value::Null);
        cmp(&got, exp, &format!("buildConversationFromFile({name})"));
    }
}

#[test]
fn build_conversation_resolution_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let env = fixture_env();
    for (case, exp) in o["resolveCases"].as_array().unwrap().iter().zip(o["resolved"].as_array().unwrap()) {
        let id = case["sessionId"].as_str().unwrap();
        let got = build_conversation(&env, id, case.get("parent").and_then(Value::as_str)).unwrap_or(Value::Null);
        cmp(&got, exp, &format!("buildConversation({id})"));
    }
}

/// Usage is credited ONCE per message.id. Every streaming chunk repeats the SAME numbers, so
/// crediting per chunk silently multiplies the whole session's reported cost — the single most
/// consequential way this parser can be wrong, since these totals feed cost attribution.
#[test]
fn usage_is_credited_once_per_message_id() {
    let env = fixture_env();
    let c = build_conversation(&env, "conv-main", None).unwrap();
    let u = &c["totals"]["usage"];
    // m1 contributes 30 and the second <synthetic> row 5 — the m1 STREAMING CHUNK repeats 30 and
    // must contribute nothing.
    assert_eq!(u["input"], 35, "a repeated streaming chunk must not re-credit usage: {u}");
    assert_eq!(u["cacheRead"], 900, "{u}");
    // The ephemeral TTL-tier split is the reason this parser exists at all (5m vs 1h write rates).
    assert_eq!(u["tier5m"], 10, "{u}");
    assert_eq!(u["tier1h"], 30, "{u}");
}

/// The NARRATIVE ordering is the product: a tool_result pairs back to the ISSUING assistant turn,
/// not to the user record it physically arrived in, and an ORPHAN result stays visible rather than
/// being dropped. A record of PURE tool_results must not fabricate an empty user turn.
#[test]
fn tool_results_pair_back_to_the_issuing_turn_and_orphans_stay_visible() {
    let env = fixture_env();
    let c = build_conversation(&env, "conv-main", None).unwrap();
    let turns = c["turns"].as_array().unwrap();

    let assistant = turns.iter().find(|t| t["role"] == "assistant").unwrap();
    let kinds: Vec<&str> = assistant["blocks"].as_array().unwrap().iter().map(|b| b["kind"].as_str().unwrap()).collect();
    // Attachments flush in AHEAD of the turn's own content — that is their transcript position.
    assert_eq!(kinds.first(), Some(&"attachment"), "queued attachments lead the turn: {kinds:?}");
    assert_eq!(
        kinds.iter().filter(|k| **k == "toolResult").count(),
        3,
        "both paired results AND the later pure-tool-result record land on the ISSUING turn: {kinds:?}"
    );

    // The orphan opened exactly one user turn carrying only it.
    let orphan_turns: Vec<&Value> = turns
        .iter()
        .filter(|t| {
            t["role"] == "user"
                && t["blocks"].as_array().unwrap().iter().all(|b| b["kind"] == "toolResult")
        })
        .collect();
    assert_eq!(orphan_turns.len(), 1, "exactly one user turn holds the orphan result");
    assert!(
        orphan_turns[0]["blocks"][0].get("toolName").is_none(),
        "an orphan has no issuing tool to name: {}",
        orphan_turns[0]
    );

    // Nothing is silently dropped: every unrecognised record is counted.
    let other = &c["otherRecords"];
    assert_eq!(other["mode"], 1, "{other}");
    assert_eq!(other["(untyped)"], 1, "an untyped record still gets counted: {other}");
    assert_eq!(other["attachment"], 1, "a 0-byte attachment is counted, not rendered: {other}");
}

/// `tokens` is TRUTHY-gated in the TS literal, so text that tokenizes to 0 (a short run of spaces)
/// stores its text and OMITS the key entirely. Emitting `tokens: 0` instead would be a wire change
/// on a frozen surface.
#[test]
fn a_zero_token_block_omits_the_tokens_key_but_keeps_its_text() {
    let env = fixture_env();
    let c = build_conversation(&env, "conv-main", None).unwrap();
    let zero = c["turns"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|t| t["blocks"].as_array().unwrap())
        .find(|b| b["kind"] == "assistantText" && b.get("tokens").is_none())
        .expect("the fixture carries a zero-token text block");
    assert!(zero["text"].is_string(), "the text is still stored: {zero}");
}
