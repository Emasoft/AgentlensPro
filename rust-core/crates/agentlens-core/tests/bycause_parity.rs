//! Cross-engine parity for `get_cost_by_cause` and the shared tokensByCause engine
//! (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-bycause-expected.mjs

use agentlens_core::mcp_tools::get_cost_by_cause;
use agentlens_core::tokens_by_cause::{build_tokens_by_cause, CAUSE_DIMENSIONS};
use serde_json::{json, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bycause-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn arr(o: &Value, k: &str) -> Vec<Value> {
    o[k].as_array().cloned().unwrap_or_default()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (under `preserve_order` a `Value::Object` is
/// an IndexMap whose `PartialEq` ignores order). Asserted explicitly, recursing through the nested
/// dimensions/rows so every row's field order is covered too.
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
                    if e.is_object() {
                        same(g, e, &format!("{label}.{k}[{i}]"));
                    } else {
                        assert_eq!(g, e, "{label}.{k}[{i}]");
                    }
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

fn tool(o: &Value, args: Value) -> Value {
    let sessions = arr(o, "sessions");
    let timeline_of = |c: &Value| -> Vec<Value> { c.get("timeline").and_then(Value::as_array).cloned().unwrap_or_default() };
    // A generous budget: the fixture pool is tiny, so the deadline must never fire and
    // `stoppedEarly` must stay false — otherwise the coverage note would be nondeterministic.
    get_cost_by_cause(&sessions, &timeline_of, &args, o["nowMs"].as_f64().unwrap(), 60_000.0)
}

#[test]
fn build_tokens_by_cause_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let tl = arr(&o, "timeline");
    same(&build_tokens_by_cause(&tl, Some("stale-start"), None, Some(851_171.0)), &o["engineFull"], "engineFull");
    same(&build_tokens_by_cause(&tl, Some("stale-start"), None, Some(1_000.0)), &o["engineNegative"], "engineNegative");
    same(&build_tokens_by_cause(&tl, None, None, None), &o["engineNoTotal"], "engineNoTotal");
    same(&build_tokens_by_cause(&[], None, Some(0.0), Some(0.0)), &o["engineEmpty"], "engineEmpty");
    same(&build_tokens_by_cause(&tl, None, None, Some(851_176.0)), &o["engineExact"], "engineExact");
    assert_eq!(CAUSE_DIMENSIONS.to_vec(), o["dimensions"].as_array().unwrap().iter().map(|d| d.as_str().unwrap()).collect::<Vec<_>>());
}

/// The unattributed bucket is PINNED LAST regardless of size — and in this fixture it is the
/// BIGGEST row in every dimension. A port that merely sorts by totalTokens puts it FIRST and buries
/// every named cause below it, which inverts the whole point of the table.
#[test]
fn the_unattributed_bucket_is_pinned_last_even_when_largest() {
    let o = oracle();
    for dim in build_tokens_by_cause(&arr(&o, "timeline"), None, None, None)["dimensions"].as_array().unwrap() {
        let rows = dim["rows"].as_array().unwrap();
        let last = rows.last().unwrap();
        assert_eq!(last["unattributed"], true, "{}: last row must be the bucket", dim["dimension"]);
        let biggest = rows.iter().map(|r| r["totalTokens"].as_f64().unwrap()).fold(0.0, f64::max);
        assert_eq!(last["totalTokens"].as_f64().unwrap(), biggest, "{}: and here it IS the biggest", dim["dimension"]);
        // Every NAMED row precedes it, in descending totalTokens.
        let named: Vec<f64> = rows[..rows.len() - 1].iter().map(|r| r["totalTokens"].as_f64().unwrap()).collect();
        assert!(named.windows(2).all(|w| w[0] >= w[1]), "{}: named rows rank heaviest-first: {named:?}", dim["dimension"]);
    }
}

/// The bucket's LABEL differs by dimension, and the distinction is a factual one: for querySource an
/// unattributed call is genuinely UNKNOWN, while for every other dimension absence MEANS "not caused
/// by any <dim>" (a call with no skill active). One shared label would assert ignorance where the
/// data is definite.
#[test]
fn the_unattributed_label_distinguishes_unknown_from_not_applicable() {
    let o = oracle();
    let dims = build_tokens_by_cause(&arr(&o, "timeline"), None, None, None);
    let label = |d: &str| -> String {
        dims["dimensions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["dimension"] == d)
            .unwrap()["rows"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(label("querySource"), "(unattributed)");
    assert_eq!(label("skill"), "(no skill)");
    assert_eq!(label("mcpServer"), "(no MCP server)");
    assert_eq!(label("mcpTool"), "(no MCP tool)");
}

/// `mcpTool` keys as `server/tool`, so two same-named tools on DIFFERENT servers never merge into
/// one row — merging them would attribute one server's spend to another. A tool whose server is
/// unknown keys as `?/tool` rather than being dropped: it is still a real, chargeable cause.
#[test]
fn mcp_tools_are_keyed_by_server_and_an_unknown_server_is_not_dropped() {
    let o = oracle();
    let dims = build_tokens_by_cause(&arr(&o, "timeline"), None, None, None);
    let rows = dims["dimensions"].as_array().unwrap().iter().find(|d| d["dimension"] == "mcpTool").unwrap()["rows"].clone();
    let names: Vec<&str> = rows.as_array().unwrap().iter().map(|r| r["key"].as_str().unwrap()).collect();
    assert!(names.contains(&"srv-a/search") && names.contains(&"srv-b/search"), "must NOT merge: {names:?}");
    assert!(names.contains(&"?/orphan"), "an unknown server keys as '?', it is not dropped: {names:?}");
}

/// A call with no finite `cost_usd` makes every row it touches a FLOOR — `costKnown:false` — rather
/// than silently understating a figure the reader would take as complete. The report level says the
/// same thing twice over: `costComplete:false` and `costCalls` < `apiRequestCalls`.
#[test]
fn a_costless_call_flags_the_row_as_a_floor_rather_than_understating_it() {
    let o = oracle();
    let got = build_tokens_by_cause(&arr(&o, "timeline"), None, None, None);
    let rec = &got["reconciliation"];
    assert_eq!(rec["costComplete"], false, "{rec}");
    assert_eq!((rec["costCalls"].as_f64(), rec["apiRequestCalls"].as_f64()), (Some(7.0), Some(8.0)), "{rec}");
    // The 'compact' row is the one that call lands in — its cost is a floor.
    let qs = got["dimensions"].as_array().unwrap().iter().find(|d| d["dimension"] == "querySource").unwrap();
    let compact = qs["rows"].as_array().unwrap().iter().find(|r| r["key"] == "compact").unwrap();
    assert_eq!(compact["costKnown"], false, "{compact}");
    // A row untouched by it stays complete.
    let main = qs["rows"].as_array().unwrap().iter().find(|r| r["key"] == "repl_main_thread").unwrap();
    assert_eq!(main["costKnown"], true, "{main}");
}

/// The remainder is SIGNED and never clamped. A NEGATIVE remainder — api_request events exceeding
/// the session usage totals — is a real ingestion-drift signal, and clamping it to 0 would present
/// drift as a clean reconciliation. A NULL total yields a NULL remainder, never 0: "cannot compute"
/// and "reconciles perfectly" are opposite claims.
#[test]
fn the_remainder_is_signed_nullable_and_never_clamped() {
    let o = oracle();
    let tl = arr(&o, "timeline");
    let rem = |total: Option<f64>| build_tokens_by_cause(&tl, None, None, total)["reconciliation"]["unattributedTotalTokens"].clone();
    assert_eq!(rem(Some(1_000.0)), -850176.0, "negative survives");
    assert_eq!(rem(None), Value::Null, "no ground truth ⇒ null, NOT 0");
    assert_eq!(rem(Some(851_176.0)), 0.0, "and an exact match IS 0");
    let neg = build_tokens_by_cause(&tl, None, None, Some(1_000.0));
    // The note carries the grouped number, so the locale formatting is part of the contract.
    assert!(neg["reconciliation"]["note"].as_str().unwrap().contains("-850,176 tokens"), "{}", neg["reconciliation"]["note"]);
    let exact = build_tokens_by_cause(&tl, None, None, Some(851_176.0));
    assert!(exact["reconciliation"]["note"].as_str().unwrap().starts_with("The api_request events fully reconcile"));
}

/// `sessionId` and `sessionsScanned` are DECLARED in the literal but an undefined option DROPS the
/// key — and the two callers are mutually exclusive (one session vs a scanned window), so each
/// report carries exactly one of them. Emitting both as null would make a single-session drill look
/// like a zero-session window scan.
#[test]
fn session_id_and_sessions_scanned_drop_when_absent() {
    let o = oracle();
    let one = build_tokens_by_cause(&arr(&o, "timeline"), Some("stale-start"), None, None);
    assert!(one.get("sessionId").is_some() && one.get("sessionsScanned").is_none(), "{:?}", keys(&one));
    let win = build_tokens_by_cause(&arr(&o, "timeline"), None, Some(2.0), None);
    assert!(win.get("sessionId").is_none() && win.get("sessionsScanned").is_some(), "{:?}", keys(&win));
    let neither = build_tokens_by_cause(&arr(&o, "timeline"), None, None, None);
    assert_eq!(keys(&neither)[0], "apiRequestCalls", "both drop: {:?}", keys(&neither));
}

#[test]
fn get_cost_by_cause_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, args) in [
        ("toolOne", json!({"sessionId": "stale-start"})),
        ("toolMissing", json!({"sessionId": "nope"})),
        ("toolWindow", json!({})),
        ("toolWindow90", json!({"days": 90})),
        ("toolDays0", json!({"days": 0})),
        ("toolDays999", json!({"days": 999})),
    ] {
        same(&tool(&o, args), &o[case], case);
    }
}

/// THE WINDOW IS BY LAST ACTIVITY, NOT startTime. `stale-start` began 30 days ago — well outside a
/// 7-day startTime window — but was active a minute ago, and it carries ALL the attribution in this
/// fixture. A startTime window silently DROPS it, and the leaderboard then reads zero attributed
/// calls while the session's own drill shows them all (measured on the real fleet: 13,241 cards, the
/// active flagship ranked #446 by startTime).
#[test]
fn the_window_is_by_last_activity_not_start_time() {
    let o = oracle();
    let win = tool(&o, json!({}));
    assert_eq!(win["apiRequestCalls"], 8, "the old-STARTED but active session must be in the window: {win}");
    assert_eq!(win["coverage"]["sessionsScanned"], 2, "{}", win["coverage"]);
    // Non-claude_code sessions are EXCLUDED from the scan but still COUNTED as considered — the
    // coverage numbers must not quietly redefine "all sessions" as "the ones we can read".
    assert_eq!(win["coverage"]["sessionsConsidered"], 3, "{}", win["coverage"]);
    assert_eq!(win["coverage"]["claudeCodeSessions"], 2, "{}", win["coverage"]);
}

/// `Math.min(Math.max(days ?? 7, 1), 90)` clamps at BOTH ends — unlike find_context_hogs' `topN`,
/// which clamps only upward and lets 0 return nothing. The conventions are not uniform across this
/// codebase, so each is asserted rather than assumed.
#[test]
fn days_clamps_at_both_ends() {
    let o = oracle();
    assert_eq!(tool(&o, json!({"days": 0}))["days"], 1, "floors to 1, it does not disable the window");
    assert_eq!(tool(&o, json!({"days": 999}))["days"], 90);
    assert_eq!(tool(&o, json!({}))["days"], 7, "and the default is 7");
}

/// `{...report, days, coverage}` — the spread comes FIRST, so `days` and `coverage` append at the
/// END of the object rather than at any declared position.
#[test]
fn days_and_coverage_append_after_the_spread() {
    let o = oracle();
    let win = tool(&o, json!({}));
    let k = keys(&win);
    assert_eq!(k[k.len() - 2..], ["days", "coverage"], "{k:?}");
}
