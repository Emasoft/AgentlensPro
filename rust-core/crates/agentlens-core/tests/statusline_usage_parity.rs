//! statusline_usage parity tests (TRDD-DMWOBWFH) — port of src/statuslineUsage.ts's
//! StatuslineUsageReader. Pure in-memory logic (no file I/O), so none of these tests touch the
//! filesystem — nothing to scope to a PID/tag temp dir.

use agentlens_core::statusline_usage::StatuslineUsageReader;
use serde_json::{json, Map, Value};

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        other => panic!("expected object, got {other:?}"),
    }
}

fn payload(session_id: &str, input: f64, output: f64, cache_create: f64, cache_read: f64, cost: f64) -> Map<String, Value> {
    obj(json!({
        "session_id": session_id,
        "model": { "display_name": "aaaaaaaa" },
        "workspace": { "project_dir": "/fake/aaaaaaaa" },
        "context_window": {
            "current_usage": {
                "input_tokens": input,
                "output_tokens": output,
                "cache_creation_input_tokens": cache_create,
                "cache_read_input_tokens": cache_read,
            },
            "total_input_tokens": input + cache_create + cache_read,
            "total_output_tokens": output,
            "context_window_size": 200000,
            "used_percentage": 12.5,
        },
        "cost": { "total_cost_usd": cost },
    }))
}

// ---------------------------------------------------------------------------------------------
// 1. Empty store
// ---------------------------------------------------------------------------------------------

#[test]
fn empty_store_reports_nothing() {
    let mut r = StatuslineUsageReader::new();
    assert!(r.get("aaaaaaaa").is_none());
    assert!(r.get_latest_rate_limits().is_none());
    assert!(r.get_rate_limits_for_sessions(["aaaaaaaa"]).is_none());
    assert!(r.get_billing_events(1_000_000.0).is_empty());
}

// ---------------------------------------------------------------------------------------------
// 2. Single sample
// ---------------------------------------------------------------------------------------------

#[test]
fn single_sample_populates_the_aggregate() {
    let mut r = StatuslineUsageReader::new();
    let p = payload("aaaaaaaa", 100.0, 50.0, 10.0, 20.0, 0.42);
    r.ingest_sample(&p, 10_000_000.0);

    let a = r.get("aaaaaaaa").expect("session should be aggregated");
    assert_eq!(a.session_id, "aaaaaaaa");
    assert_eq!(a.project_dir, "/fake/aaaaaaaa");
    assert_eq!(a.model, "aaaaaaaa");
    assert_eq!(a.last_input_tokens, 100.0);
    assert_eq!(a.last_output_tokens, 50.0);
    assert_eq!(a.last_cache_create_tokens, 10.0);
    assert_eq!(a.last_cache_read_tokens, 20.0);
    assert_eq!(a.last_total_input_tokens, 130.0); // input + cache_create + cache_read
    assert_eq!(a.context_window_size, 200_000.0);
    assert_eq!(a.used_percentage, 12.5);
    assert_eq!(a.total_cost_usd, 0.42);
    assert_eq!(a.peak_context_tokens, 130.0);
    assert_eq!(a.samples, 1.0);
    assert_eq!(a.last_ts, 10_000.0); // ts_ms / 1000, floored

    // First sample of a session bills nothing — the cumulative-cost baseline, not a real delta.
    let events = r.get_billing_events(10_000_000.0 + 1.0);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].delta_cost_usd, 0.0);
    assert_eq!(events[0].delta_tokens, 180.0); // 100+50+10+20
    assert_eq!(events[0].interval_ms, None);
}

// ---------------------------------------------------------------------------------------------
// 3. Multi-sample aggregation
// ---------------------------------------------------------------------------------------------

#[test]
fn multi_sample_aggregation_latest_wins_peak_and_billing_deltas() {
    let mut r = StatuslineUsageReader::new();

    // Turn 1 (baseline — bills nothing).
    r.ingest_sample(&payload("aaaaaaaa", 100.0, 50.0, 10.0, 20.0, 0.10), 1_000_000.0);
    // A re-render of the SAME turn (identical input/cache buckets, output grew) — must UPDATE the
    // open event in place, not append a second one, and must not double-count cost.
    r.ingest_sample(&payload("aaaaaaaa", 100.0, 80.0, 10.0, 20.0, 0.10), 1_003_000.0);
    // Turn 2 — a genuinely new turn (input side changed) with real cost growth.
    r.ingest_sample(&payload("aaaaaaaa", 150.0, 30.0, 15.0, 25.0, 0.55), 1_010_000.0);

    let a = r.get("aaaaaaaa").unwrap();
    // Latest-wins snapshot reflects turn 2, not turn 1.
    assert_eq!(a.last_input_tokens, 150.0);
    assert_eq!(a.last_output_tokens, 30.0);
    assert_eq!(a.total_cost_usd, 0.55);
    // Peak context is the MAX across all turns, not the latest.
    let turn1_total: f64 = 100.0 + 10.0 + 20.0; // 130
    let turn2_total: f64 = 150.0 + 15.0 + 25.0; // 190
    assert_eq!(a.peak_context_tokens, turn1_total.max(turn2_total));
    // 3 ingested samples, but the re-render collapsed into turn 1 — 3 aggregate samples counted,
    // 2 distinct billing events.
    assert_eq!(a.samples, 3.0);

    let events = r.get_billing_events(2_000_000.0);
    assert_eq!(events.len(), 2, "re-render of turn 1 must not append a 3rd billing event");
    assert_eq!(events[0].delta_cost_usd, 0.0, "turn 1 is the session's baseline — bills nothing");
    assert_eq!(events[0].delta_output, Some(80.0), "the re-render's later output must win");
    // NOT the literal 0.45. IEEE754 makes 0.55-0.10 = 0.45000000000000007, and node agrees
    // (`0.55-0.10 === 0.45` is FALSE) — so the literal would assert the port is WRONG in exactly
    // the way it is right. Writing the subtraction keeps this bit-exact with the TS, which is the
    // property this suite exists to pin; rounding it to 0.45 here would quietly license a port
    // that computes the delta some other way.
    assert_eq!(events[1].delta_cost_usd, 0.55 - 0.10, "turn 2 bills the real cost growth 0.55-0.10");
    assert!(events[1].interval_ms.is_some());
}

// ---------------------------------------------------------------------------------------------
// 4. Refusal path — malformed input must never fabricate an aggregate
// ---------------------------------------------------------------------------------------------

#[test]
fn malformed_payloads_are_refused_not_guessed() {
    let mut r = StatuslineUsageReader::new();

    // Missing session_id entirely.
    r.ingest_sample(&obj(json!({ "cost": { "total_cost_usd": 5.0 } })), 1.0);
    // Empty-string session_id.
    r.ingest_sample(&obj(json!({ "session_id": "" })), 1.0);
    // session_id present but wrong type.
    r.ingest_sample(&obj(json!({ "session_id": 12345 })), 1.0);

    assert!(r.get("").is_none());
    assert!(r.get_billing_events(1_000_000.0).is_empty());

    // A malformed NUMERIC field (Infinity-shaped via a huge string that overflows to inf, or a
    // non-numeric string) must collapse to 0 — never crash, never smuggle NaN/Infinity through.
    let mut bad = obj(json!({
        "session_id": "bbbb2222",
        "context_window": {
            "current_usage": { "input_tokens": "not-a-number" },
            "context_window_size": "also-not-a-number",
        },
    }));
    // Also inject a genuinely unresolvable value shape (an object) for a numeric field — must
    // still refuse to fabricate a plausible number.
    bad.get_mut("context_window").unwrap().as_object_mut().unwrap()
        .insert("used_percentage".into(), json!({"nested": true}));
    r.ingest_sample(&bad, 2.0);

    let a = r.get("bbbb2222").expect("a bad numeric field must not drop the whole sample");
    assert_eq!(a.last_input_tokens, 0.0, "unparseable string must collapse to 0, not NaN");
    assert_eq!(a.context_window_size, 0.0);
    assert_eq!(a.used_percentage, 0.0, "an object value must never be coerced into a fabricated number");
}

// ---------------------------------------------------------------------------------------------
// overlay() — writes onto a session-card JSON map
// ---------------------------------------------------------------------------------------------

#[test]
fn overlay_writes_statusline_and_raises_peak_context_per_turn() {
    let mut r = StatuslineUsageReader::new();
    r.ingest_sample(&payload("aaaaaaaa", 100.0, 50.0, 10.0, 20.0, 0.10), 1.0);

    let mut card = obj(json!({ "sessionId": "aaaaaaaa", "peakContextPerTurn": 50 }));
    r.overlay(&mut card);

    assert!(card.get("statusline").is_some());
    // existing 50 < the observed 130 → raised.
    assert_eq!(card.get("peakContextPerTurn").unwrap().as_f64().unwrap(), 130.0);

    // A card whose peak already exceeds the observed value must NOT be lowered.
    let mut card2 = obj(json!({ "sessionId": "aaaaaaaa", "peakContextPerTurn": 9999 }));
    r.overlay(&mut card2);
    assert_eq!(card2.get("peakContextPerTurn").unwrap().as_f64().unwrap(), 9999.0);

    // Unknown session → no-op, card left untouched.
    let mut card3 = obj(json!({ "sessionId": "zzzzzzzz" }));
    r.overlay(&mut card3);
    assert!(card3.get("statusline").is_none());
}

// ---------------------------------------------------------------------------------------------
// Rate-limits snapshot — TRDD-VY1IUVUM Part-5
// ---------------------------------------------------------------------------------------------

#[test]
fn rate_limits_absent_window_stays_none_never_zero() {
    let mut r = StatuslineUsageReader::new();
    let mut p = payload("aaaaaaaa", 10.0, 5.0, 1.0, 2.0, 0.01);
    p.insert("rate_limits".into(), json!({ "five_hour": { "used_percentage": 42.0 } }));
    r.ingest_sample(&p, 1_000_000.0);

    let snap = r.get_latest_rate_limits().expect("a rate_limits block was ingested");
    assert_eq!(snap.five_hour_utilization, Some(42.0));
    assert_eq!(snap.seven_day_utilization, None, "an absent window must stay None, never 0");

    let per_session = r.get_rate_limits_for_sessions(["aaaaaaaa"]).unwrap();
    assert_eq!(per_session.five_hour_utilization, Some(42.0));
    assert!(r.get_rate_limits_for_sessions(["zzzzzzzz"]).is_none());
}
