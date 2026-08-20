//! Cross-engine parity for `get_heartbeat_cost` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-hbcost-expected.mjs
//!
//! MTIME ORACLE: the window filter, the fire ordering, the span and the duration are all functions
//! of the fixture's mtime table, which git does not preserve — the generator stamps it and
//! publishes it; this test re-stamps from it.
//!
//! Absolute paths are REDACTED to `<BODIES>` / `<MISSING>` on both sides before comparing.

use std::path::PathBuf;

use agentlens_core::heartbeat_cost::{build_heartbeat_cost, HeartbeatCostOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn bodies() -> PathBuf {
    fixtures().join("hbcost-bodies")
}
fn missing_dir() -> PathBuf {
    fixtures().join("no-such-hbcost-dir")
}

fn oracle() -> Value {
    let o: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("hbcost-expected.json")).unwrap()).unwrap();
    let dir = bodies();
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    o
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). Four fields here are explicit `null` on the empty
/// report — a port that dropped them instead would compare equal field by field.
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

fn strip(v: &Value) -> Value {
    let s = v
        .to_string()
        .replace(&bodies().to_string_lossy().into_owned(), "<BODIES>")
        .replace(&missing_dir().to_string_lossy().into_owned(), "<MISSING>");
    serde_json::from_str(&s).unwrap()
}

fn report(o: &Value, opts: &HeartbeatCostOptions) -> Value {
    strip(&build_heartbeat_cost(&bodies(), opts, o["nowMs"].as_f64().unwrap()))
}

fn opts() -> HeartbeatCostOptions {
    HeartbeatCostOptions::default()
}

#[test]
fn heartbeat_cost_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let sess_a = o["sessions"]["a"].as_str().unwrap().to_owned();
    same(&report(&o, &opts()), &o["reportDefault"], "reportDefault");
    same(
        &report(&o, &HeartbeatCostOptions { session_id: Some(sess_a.clone()), ..Default::default() }),
        &o["reportBySession"],
        "reportBySession",
    );
    // A short unique PREFIX resolves the same session — `startsWith`, not equality.
    same(
        &report(&o, &HeartbeatCostOptions { session_id: Some("aaaaaaaa".to_owned()), ..Default::default() }),
        &o["reportByPrefix"],
        "reportByPrefix",
    );
    same(
        &report(&o, &HeartbeatCostOptions { fire: Some("current".to_owned()), ..Default::default() }),
        &o["reportCurrent"],
        "reportCurrent",
    );
    same(
        &report(
            &o,
            &HeartbeatCostOptions { fire: Some("current".to_owned()), session_id: Some(sess_a), ..Default::default() },
        ),
        &o["reportCurrentBySession"],
        "reportCurrentBySession",
    );
    // A 0.5h window sees only ONE fire, so 'last-complete' falls back to the newest.
    same(
        &report(&o, &HeartbeatCostOptions { window_hours: Some(0.5), ..Default::default() }),
        &o["reportNarrowWindow"],
        "reportNarrowWindow",
    );
}

#[test]
fn the_fire_start_traps_are_all_exercised() {
    let o = oracle();
    let d = report(&o, &opts());
    assert_eq!(d["fireDetected"], true);
    // TRAP 1 — `raw.includes(marker)` is wrong: f1r2's transcript HISTORY carries the marker while
    // its current turn is a tool_result, and f1r3's carries it under an ASSISTANT last message.
    // Either one read as a fire start would split fire 1 in two, so apiCalls settles it: the fire
    // is FOUR consecutive calls, not one.
    assert_eq!(d["apiCalls"].as_f64().unwrap(), 4.0);
    // TRAP 2 — the last message is not the user's: f1r1 ends with a UserPromptSubmit hook message
    // and f2r1 with a <system-reminder>. If either stopped the walk, that fire would not be found
    // at all, and with only one fire left the default would report the newest instead.
    assert_eq!(d["fireStartedAt"], o["reportDefault"]["fireStartedAt"]);
    assert!(d["inFlight"].is_null(), "the last COMPLETE fire has no unsettled tail");
    // Agent/Task spawns come from the LAST message only — f1r1 carries an Agent tool_use in an
    // earlier message that must not be counted, f1r2 carries Agent + Task in its last.
    assert_eq!(d["agentSpawns"].as_f64().unwrap(), 2.0);
    // A sub-agent stream carries the parent session id but a different tool count — which is the
    // only thing that separates it in the payload.
    let surface = d["callsByToolSurface"].as_array().unwrap();
    assert_eq!(surface.len(), 2);
    assert!(surface[0]["calls"].as_f64().unwrap() >= surface[1]["calls"].as_f64().unwrap(), "not sorted by calls desc");
}

#[test]
fn another_sessions_call_is_counted_in_the_span_but_disclosed_separately() {
    let o = oracle();
    let d = report(&o, &opts());
    let filtered = report(
        &o,
        &HeartbeatCostOptions { session_id: Some(o["sessions"]["a"].as_str().unwrap().to_owned()), ..Default::default() },
    );
    // `candidates` is only session-filtered when asked, so unfiltered the other session's call
    // falls inside the fire's index range and IS one of its apiCalls. The two runs therefore
    // differ by exactly that one call — this is the TS behaviour, not a rounding artifact.
    assert_eq!(d["apiCalls"].as_f64().unwrap() - filtered["apiCalls"].as_f64().unwrap(), 1.0);
    // …and it is disclosed under `concurrent` in BOTH runs: those calls competed for the same
    // rate-limit window whether or not they were billed to the fire.
    assert_eq!(d["concurrent"]["calls"].as_f64().unwrap(), 1.0);
    assert_eq!(d["concurrent"]["sessions"].as_f64().unwrap(), 1.0);
    assert_eq!(filtered["concurrent"]["calls"].as_f64().unwrap(), 1.0);
    // A response body with NO model adopts the REQUEST's, so the model appears in byModel rather
    // than collapsing into an unpriced empty-string bucket.
    let models: Vec<&str> = d["byModel"].as_array().unwrap().iter().map(|m| m["model"].as_str().unwrap()).collect();
    assert!(models.contains(&"claude-sonnet-5"), "the model-less response did not adopt the request's: {models:?}");
    assert!(!models.iter().any(|m| m.is_empty()), "an empty model bucket means the adoption did not happen");
    // …and it is absent once that call is filtered out, which is what proves it came from THAT call.
    let fm: Vec<&str> = filtered["byModel"].as_array().unwrap().iter().map(|m| m["model"].as_str().unwrap()).collect();
    assert!(!fm.contains(&"claude-sonnet-5"), "{fm:?}");
}

#[test]
fn an_unsettled_tail_is_excluded_and_disclosed_never_counted_as_zero() {
    let o = oracle();
    let current = report(&o, &HeartbeatCostOptions { fire: Some("current".to_owned()), ..Default::default() });
    same(&current, &o["reportCurrent"], "reportCurrent");
    // The newest fire's final call has no successor, so its usage is not on disk yet.
    assert_eq!(current["inFlight"]["calls"].as_f64().unwrap(), 1.0);
    assert!(current["inFlight"]["note"].as_str().unwrap().contains("previous_message_id"));
    // It is EXCLUDED, not zero-filled: two calls, one settled, and the verdict says so.
    assert_eq!(current["apiCalls"].as_f64().unwrap(), 2.0);
    assert_eq!(current["byModel"].as_array().unwrap().iter().map(|m| m["calls"].as_f64().unwrap()).sum::<f64>(), 1.0);
    assert!(current["verdict"].as_str().unwrap().contains("not yet settled — EXCLUDED"));
    assert!(current["verdict"].as_str().unwrap().starts_with("Current heartbeat (in flight)"));
    // The default fire's verdict uses the other label and carries no warning.
    let d = report(&o, &opts());
    assert!(d["verdict"].as_str().unwrap().starts_with("The last heartbeat"));
    assert!(!d["verdict"].as_str().unwrap().contains("EXCLUDED"));
}

#[test]
fn the_empty_reports_keep_their_scan_note() {
    let o = oracle();
    let unknown = report(&o, &HeartbeatCostOptions { marker: Some("[no-such-marker]".to_owned()), ..Default::default() });
    same(&unknown, &o["reportUnknownMarker"], "reportUnknownMarker");
    assert_eq!(unknown["fireDetected"], false);
    // The dir WAS scanned, and the note says so — which is what stops the caller reading "no fire"
    // as "no capture" and going to fix the wrong thing.
    assert!(unknown["coverage"]["note"].as_str().unwrap().starts_with("Scanned "));
    // …but `filesScanned` is 0 ANYWAY, because emptyReport hardcodes it and only threads the NOTE
    // through. So the two fields of the same coverage object disagree: the note says 11, the count
    // says 0. That is the TS behaviour, it is pinned here deliberately, and it must NOT be
    // "corrected" in the port — a reader who fixes it silently diverges the two engines on the
    // one field a caller uses to decide whether the answer is trustworthy.
    assert_eq!(unknown["coverage"]["filesScanned"].as_f64().unwrap(), 0.0);
    assert!(unknown["coverage"]["note"].as_str().unwrap().contains("Scanned 11 body file(s)"));
    assert!(unknown["verdict"].as_str().unwrap().contains("[no-such-marker]"));

    let missing =
        strip(&build_heartbeat_cost(&missing_dir(), &HeartbeatCostOptions::default(), o["nowMs"].as_f64().unwrap()));
    same(&missing, &o["reportMissingDir"], "reportMissingDir");
    assert_eq!(missing["coverage"]["filesScanned"].as_f64().unwrap(), 0.0);
    assert!(missing["coverage"]["note"].as_str().unwrap().contains("OTEL_LOG_RAW_API_BODIES"));
}
