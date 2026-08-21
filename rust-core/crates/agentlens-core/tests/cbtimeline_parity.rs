//! Cross-engine parity for the cacheBreakTimeline SLICE 1 primitives (TRDD-DMWOBWFH P4x.2i).
//! Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cbtimeline-expected.mjs
//!
//! Pure functions only — no I/O, no clock, so the fixture IS the input and there is no mtime
//! oracle to stamp. What each section is for is documented in the generator, next to the data.

use agentlens_core::cache_break_timeline::{
    classify_content_kind, extract_turn_prefix, min_cacheable_tokens_for, segment_injected, TimelineCause,
};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cbtimeline-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see: two objects with the same fields in a
/// different order compare equal field by field and serialize differently.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().cloned().unwrap_or_default();
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

/// The remediation text ships to the user verbatim, and the table's KEY ORDER is the declaration
/// order of the TS literal — `TimelineCause::ALL` is what has to reproduce it, so comparing the
/// whole table at once checks both the 34 strings and their order in one assertion.
#[test]
fn remediation_table_matches_the_ts_literal() {
    let o = oracle();
    same(&TimelineCause::remediation_table(), &o["remediation"], "remediation");
}

#[test]
fn expected_causes_match() {
    let o = oracle();
    let got: Vec<Value> = TimelineCause::EXPECTED.iter().map(|c| Value::String(c.id().to_owned())).collect();
    same(&Value::Array(got), &o["expectedCauses"], "expectedCauses");
    // The array and the predicate are two encodings of one fact; a cause in one and not the other
    // would make the ranking disagree with itself.
    for c in TimelineCause::ALL {
        assert_eq!(c.is_expected(), TimelineCause::EXPECTED.contains(&c), "is_expected({})", c.id());
    }
}

/// `undefined` is a VERDICT, not a default: the minimum is per model over an 8x spread, so a
/// borrowed threshold makes BELOW_MIN_CACHEABLE fire on models whose real minimum is far away.
#[test]
fn min_cacheable_matches_per_model() {
    let o = oracle();
    for (model, exp) in o["minCacheable"].as_object().unwrap() {
        let got = min_cacheable_tokens_for(model).map_or(Value::Null, Value::from);
        assert_eq!(&got, exp, "minCacheableTokensFor({model})");
    }
}

#[test]
fn content_kind_matches_every_branch() {
    let o = oracle();
    // Re-derive the inputs from the generator's own case table rather than duplicating the texts:
    // the oracle stores only the RESULTS, so the texts live in one place. They are re-listed here
    // because a Rust test cannot import a .mjs — kept byte-identical, and a drift shows up as a
    // failing case name rather than a silent skip.
    for (name, exp) in o["contentKind"].as_object().unwrap() {
        let text = kind_case_text(name);
        let got = classify_content_kind(text).id();
        assert_eq!(got, exp.as_str().unwrap(), "classifyContentKind({name})");
    }
}

#[test]
fn segments_match() {
    let o = oracle();
    for (name, exp) in o["segments"].as_object().unwrap() {
        let (text, label) = seg_case(name);
        let got: Vec<Value> = segment_injected(text, label)
            .iter()
            .map(|s| serde_json::json!({ "kind": s.kind.id(), "label": s.label, "text": s.text }))
            .collect();
        same(&Value::Array(got), exp, &format!("segmentInjected({name})"));
    }
}

/// The bodies are read straight out of the oracle file's own `bodies` section, so the Rust side
/// cannot drift from what the TS was actually given.
#[test]
fn turn_prefixes_match() {
    let o = oracle();
    let bodies = o["bodies"].as_object().expect("the oracle carries its own inputs");
    for (name, exp) in o["prefixes"].as_object().unwrap() {
        // A body that is absent and a body that is `null` both read as Value::Null, and the second
        // is a real case (`null_body`) — so the KEY has to exist, or a typo in the generator would
        // look like a passing null case.
        let body = bodies.get(name).unwrap_or_else(|| panic!("no input body for prefix case {name}"));
        // `Some(Value::Null)` is deliberate: the TS is CALLED with null and rejects it itself.
        let got = extract_turn_prefix(Some(body)).map_or(Value::Null, |p| p.to_value());
        same(&got, exp, &format!("extractTurnPrefix({name})"));
    }
}

// ── the classifier / segmenter inputs, mirrored from the generator ───────────────
fn kind_case_text(name: &str) -> &'static str {
    match name {
        "agentmeta_billing" => "x-anthropic-billing-header: cc_version=2.1.230",
        "agentmeta_beats_system" => "<system-reminder>\ncc_entrypoint=cli\n</system-reminder>",
        "postcompact_continued" => "This session is being continued from a previous conversation.",
        "postcompact_analysis" => "Analysis:\nthe user asked for X\nSummary:\nported the thing",
        "postcompact_beats_claudemd" => "compacted the previous conversation\nContents of /w/p/CLAUDE.md (project instructions):",
        "claudemd_contents" => "Contents of /w/p/CLAUDE.md (project instructions, checked into the codebase):\n# CLAUDE.md\nbe good",
        "claudemd_heading" => "# CLAUDE.md\nproject notes",
        "rule_contents" => "Contents of /Users/x/.claude/rules/commit-discipline.md (private global instructions):",
        "memory_beats_hook" => "Contents of /Users/x/.claude/projects/p/memory/MEMORY.md — see [janitor-memory] recall",
        "memory_autoheader" => "auto-memory, persists across conversations",
        "execresult_stdout" => "<local-command-stdout>ok</local-command-stdout>",
        "execresult_fnresults" => "<function_results>42</function_results>",
        "skillcatalog" => "The following skills are available for use with the Skill tool:\n- distill",
        "agentcatalog" => "Available agent types for the Agent tool:\n- Explore",
        "hook_pss" => "<pss-skills>rust, typescript</pss-skills>",
        "hook_janitor_memory" => "[janitor-memory] Memory corpus: 17 local notes",
        "hook_userpromptsubmit" => "UserPromptSubmit hook additional context: budget ok",
        "hook_pretooluse" => "PreToolUse:Bash hook additional context: token spike 453,881 tokens",
        "hook_posttooluse" => "PostToolUse:Edit hook additional context: formatted",
        "hook_tasklist" => "task tools haven't been used recently",
        "hook_reminder_wrapped" => "<system-reminder>the janitor heartbeat fired</system-reminder>",
        "date_today" => "Today's date is 2026-08-21",
        "date_currentdate" => "# currentDate\n2026-08-21",
        "system_plain" => "<system-reminder>this context may or may not be relevant</system-reminder>",
        "usertext" => "port the classifier to rust please",
        "empty" => "",
        other => panic!("unknown contentKind case {other} — add it here when the generator gains one"),
    }
}

fn seg_case(name: &str) -> (&'static str, &'static str) {
    match name {
        "none_hook" => ("<pss-skills>rust</pss-skills>", "system[0]"),
        "none_janitor" => ("[janitor-heartbeat] fired at 05:00", "system[0]"),
        "none_usertext" => ("just some prose", "msg[3] user"),
        "none_system_sig" => ("<system-reminder>AI Maestro inbox: 2 unread messages</system-reminder>", "system[1]"),
        "lead_and_two" => (
            concat!(
                "cc_version=2.1.230\nToday's date is 2026-08-21\n",
                "Contents of /w/p/CLAUDE.md (project instructions):\nbe good\n",
                "Contents of /Users/x/.claude/rules/never_use_sed.md (private):\nno sed"
            ),
            "system[3]",
        ),
        "mark_at_zero" => ("Contents of /w/p/CLAUDE.md (project):\nbody", "system[0]"),
        "label_paren" => ("Contents of /w/p/notes.md   (a comment)\nbody", "system[0]"),
        "memory_segment" => (
            "preamble\nContents of /Users/x/.claude/projects/p/memory/MEMORY.md (auto-memory):\n- a note",
            "msg[0] user",
        ),
        "no_extension" => ("Contents of some directory\nand more text", "system[0]"),
        other => panic!("unknown segment case {other} — add it here when the generator gains one"),
    }
}
