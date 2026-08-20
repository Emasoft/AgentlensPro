//! Cross-engine parity for `get_runtime_inventory` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-runtimeinv-expected.mjs
//!
//! Both engines run over a FIXTURE ps snapshot with subprocesses disabled, so no test reads a live
//! process table or spawns lsof — and the fixture contains shapes a real machine rarely produces
//! (a ppid cycle, an orphan whose parent is absent, a nested claude).

use agentlens_core::runtime_inventory::{build_claude_instances, build_runtime_inventory, is_claude_root, parse_ps_snapshot};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtimeinv-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// ps pads its columns with RUNS of spaces and commands contain spaces of their own, so the row
/// parse has to be the regex the TS uses. A `splitn` on single whitespace characters yields empty
/// fields and drops every real row — which is exactly what the first version of this port did.
#[test]
fn parse_ps_snapshot_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let rows = parse_ps_snapshot(o["psText"].as_str().unwrap());
    let exp = o["rows"].as_array().unwrap();
    assert_eq!(rows.len(), exp.len(), "row count — a padded-column parse failure shows up HERE first");
    for (i, (got, e)) in rows.iter().zip(exp).enumerate() {
        assert_eq!(got.pid, e["pid"].as_i64().unwrap(), "row {i} pid");
        assert_eq!(got.ppid, e["ppid"].as_i64().unwrap(), "row {i} ppid");
        assert_eq!(got.rss_kb, e["rssKb"].as_f64().unwrap(), "row {i} rssKb");
        assert_eq!(got.etime, e["etime"].as_str().unwrap(), "row {i} etime");
        assert_eq!(got.command, e["command"].as_str().unwrap(), "row {i} command — kept VERBATIM, spaces included");
    }
}

/// argv0 BASENAME matching, not a command-line search. Every process launched by Claude Code has
/// `~/.claude/...` somewhere in its ARGS, so a whole-line match would call each of them an instance
/// and multiply the machine's apparent footprint.
#[test]
fn is_claude_root_matches_the_basename_only() {
    let o = oracle();
    for (case, exp) in o["rootCases"].as_array().unwrap().iter().zip(o["rootResults"].as_array().unwrap()) {
        let c = case.as_str().unwrap();
        assert_eq!(Value::Bool(is_claude_root(c)), *exp, "isClaudeRoot({c:?})");
    }
}

#[test]
fn build_claude_instances_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let got = build_claude_instances(&parse_ps_snapshot(o["psText"].as_str().unwrap()));
    let exp = o["instances"].as_array().unwrap();
    assert_eq!(got.len(), exp.len(), "instance count");
    for (i, (g, e)) in got.iter().zip(exp).enumerate() {
        assert_eq!(keys(g), keys(e), "instance {i}: key set/ORDER differs");
        assert_eq!(g, e, "instance {i}");
    }
}

/// A NESTED claude (a subagent CLI) folds into its parent instance rather than being counted as a
/// second one — otherwise one machine's footprint is reported twice and the ranking is meaningless.
/// The fixture's instance 100 owns a nested claude at pid 103 plus that claude's own child.
#[test]
fn a_nested_claude_folds_into_its_parent_instance() {
    let o = oracle();
    let got = build_claude_instances(&parse_ps_snapshot(o["psText"].as_str().unwrap()));
    let pids: Vec<i64> = got.iter().map(|i| i["pid"].as_i64().unwrap()).collect();
    assert_eq!(pids, vec![100, 200], "the nested claude (103) is NOT its own instance: {pids:?}");
    let parent = &got[0];
    assert_eq!(parent["processCount"], 5, "and its whole subtree counts toward the parent: {parent}");
    assert!(
        parent["topProcesses"].as_array().unwrap().iter().any(|p| p["pid"] == 103),
        "the nested claude appears as a PROCESS of its parent: {parent}"
    );
}

/// A ppid CYCLE in a torn snapshot must terminate. The fixture has 500↔501 pointing at each other;
/// without the hop cap and the BFS seen-set this hangs the server rather than returning a report.
#[test]
fn a_ppid_cycle_terminates() {
    let o = oracle();
    // If this test ever hangs rather than fails, the guard is gone — that is the failure mode.
    let got = build_claude_instances(&parse_ps_snapshot(o["psText"].as_str().unwrap()));
    assert_eq!(got.len(), 2, "the cycle is not a claude tree and must not become one: {got:?}");
}

#[test]
fn build_runtime_inventory_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let got = build_runtime_inventory(Some(o["psText"].as_str().unwrap()), true, now);
    assert_eq!(keys(&got), keys(&o["report"]), "key set/ORDER differs");
    for (k, ev) in o["report"].as_object().unwrap() {
        assert_eq!(&got[k], ev, "report.{k}");
    }
    // An EMPTY snapshot is a valid report with zero instances — not an error. A machine with no
    // Claude running is a real answer, and erroring there would read as "the probe failed".
    let empty = build_runtime_inventory(Some(""), true, now);
    assert_eq!(keys(&empty), keys(&o["emptyReport"]), "empty: key set/ORDER differs");
    for (k, ev) in o["emptyReport"].as_object().unwrap() {
        assert_eq!(&empty[k], ev, "emptyReport.{k}");
    }
    assert!(empty.get("error").is_none(), "{empty}");
}
