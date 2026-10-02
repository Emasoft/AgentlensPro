//! TRDD-9VX3WTGU Phase C part 2 — the incremental (patch-in-place) summary rebuild.
//!
//! Every test compares the engine's output, byte for byte, with an INDEPENDENT full rebuild: the
//! cards are read back out of the DuckDB table and run through the public merge / link / sort
//! steps, exactly as the pre-engine `summary_over` did. The engine's own per-card logic (dirty
//! tracking, per-pair linking, ordered patch) is therefore what is under test, not a restatement.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use agentlens_core::{feed_merge, ingest_post, now_ms, ui::strip_session_detail, CoreState};
use indexmap::IndexMap;
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-engine-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn otel_trace(session: &str, n: u64) -> String {
    let trace: String = session.bytes().map(|b| format!("{b:02x}")).collect::<String>() + &format!("{n:032x}");
    let trace = trace.chars().rev().take(32).collect::<String>();
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": trace, "spanId": format!("{n:016x}"),
        "startTimeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
        "attributes": [
            { "key": "session.id", "value": { "stringValue": session } },
            { "key": "input_tokens", "value": { "intValue": "100" } }
        ]
    }] }] }] })
    .to_string()
}

fn card(id: &str, source: &str, start: &str, parent: Option<&str>, tokens: u64, timeline: usize) -> Value {
    let mut c = json!({
        "sessionId": id, "source": source, "dataSource": "log", "startTime": start, "durationMs": 1000.0,
        "inputTokens": tokens, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreateTokens": 0,
        "timeline": (0..timeline).map(|i| json!({ "type": "api_request", "spanId": format!("{id}-{i}"), "timestamp": format!("2026-08-01T10:00:0{i}.000Z") })).collect::<Vec<_>>(),
    });
    if let Some(p) = parent {
        c["parentSessionId"] = json!(p);
    }
    c
}

/// The full rebuild, independent of the engine.
fn reference(st: &CoreState) -> (Value, Value) {
    let accounts = st.accounts.snapshot();
    let mut summary = agentlens_core::summarize::summarizer::summarize_spans(&st.window.spans, &|sid| accounts.get(sid).cloned());
    let mut attribution = IndexMap::<String, Vec<Value>>::new();
    for s in summary["sessions"].as_array().unwrap() {
        if s["source"] != "claude_code" {
            continue;
        }
        let e: Vec<Value> = s["timeline"].as_array().unwrap().iter().filter(|e| e["type"] == "api_request").cloned().collect();
        if !e.is_empty() {
            attribution.insert(s["sessionId"].as_str().unwrap().to_owned(), e);
        }
    }
    let log = st.cards.cards();
    if !log.is_empty() {
        let otel = summary["sessions"].as_array().cloned().unwrap_or_default();
        let mut merged = feed_merge::link_subagent_transcripts(feed_merge::merge_otel_and_log_sessions(otel, log));
        merged.sort_by(|a, b| {
            let k = |c: &Value| {
                let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
                if st.is_empty() { -62_167_219_200_000.0 } else { agentlens_core::summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
            };
            k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
        });
        summary["sessions"] = Value::Array(merged);
    }
    (summary, serde_json::to_value(attribution).unwrap())
}

struct Out {
    summary: Arc<Value>,
    attribution: Value,
    stripped: Option<Arc<Value>>,
}

/// The real flow: snapshot (takes the caches' previous outputs), build, store.
fn rebuild(st: &mut CoreState) -> Out {
    let mut inputs = st.summary_snapshot();
    let build = CoreState::summary_from(&mut inputs, 0.0);
    let attribution = serde_json::to_value(&build.attribution).unwrap();
    let stripped = build.stripped.clone();
    let summary = st.store_summary(inputs.version, build);
    Out { summary, attribution, stripped }
}

fn assert_equals_full(st: &mut CoreState, step: &str) -> Out {
    let (want_s, want_a) = reference(st);
    let got = rebuild(st);
    assert_eq!(serde_json::to_string(&*got.summary).unwrap(), serde_json::to_string(&want_s).unwrap(), "summary bytes after {step}");
    assert_eq!(serde_json::to_string(&got.attribution).unwrap(), serde_json::to_string(&want_a).unwrap(), "attribution bytes after {step}");
    if let Some(s) = &got.stripped {
        assert_eq!(serde_json::to_string(&**s).unwrap(), serde_json::to_string(&strip_session_detail(&want_s)).unwrap(), "stripped bytes after {step}");
    }
    got
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() as usize) % xs.len()]
    }
}

const IDS: [&str; 10] = ["a", "b", "c", "d", "e", "X", "agent-X", "Y", "agent-Y", "z"];
const STARTS: [&str; 6] = [
    "2026-08-01T10:00:00.000Z",
    "2026-08-01T10:00:00.000Z", // a tie group
    "2026-08-01T11:00:00.000Z",
    "2026-08-02T09:30:00.000Z",
    "2026-07-30T00:00:00.000Z",
    "", // no startTime at all
];

fn random_card(r: &mut Lcg) -> Value {
    let id = *r.pick(&IDS);
    let source = if r.next().is_multiple_of(4) { "codex" } else { "claude_code" };
    let parent = match id {
        "X" | "Y" => Some("P"),
        "agent-X" | "agent-Y" => *r.pick(&[None, Some("P"), Some("Q")]),
        _ => None,
    };
    card(id, source, r.pick(&STARTS), parent, r.next() % 3 * 10, (r.next() % 4) as usize)
}

/// THE property: random interleavings of log puts, OTEL ingest, demotion, card clear, window prune
/// and span clear — each followed by a rebuild — equal a full rebuild byte for byte, including the
/// stripped twin and the attribution map, while a reader sometimes holds the previous Arc (the
/// forced-copy path).
#[test]
fn random_interleavings_equal_a_full_rebuild_at_every_step() {
    let mut incremental = 0;
    for seed in 1..=6u64 {
        let mut st = CoreState::open(&tmp(&format!("prop{seed}")));
        let mut r = Lcg(seed * 7919);
        let mut readers: Vec<Arc<Value>> = Vec::new();
        let mut span_n = 0u64;
        for step in 0..60 {
            let op = r.next() % 100;
            let what = match op {
                0..=39 => {
                    st.put_log_session(random_card(&mut r));
                    "put"
                }
                40..=64 => {
                    span_n += 1;
                    ingest_post(&mut st, "/v1/traces", otel_trace(r.pick(&IDS), span_n).as_bytes());
                    "otel"
                }
                65..=74 => {
                    st.demote_cold_timelines(1 + (r.next() % 4) as usize);
                    "demote"
                }
                75..=78 => {
                    st.cards.clear();
                    "clear cards"
                }
                79..=82 => {
                    st.prune_window(now_ms() + 25 * 3_600_000);
                    "prune"
                }
                83..=85 => {
                    st.clear_spans();
                    "clear spans"
                }
                _ => "noop rebuild",
            };
            let got = assert_equals_full(&mut st, &format!("seed {seed} step {step}: {what}"));
            if r.next().is_multiple_of(5) {
                readers.push(got.summary); // a reader keeps the previous Arc across the next patch
            }
            // A second rebuild with nothing changed must be a no-op on the bytes.
            if step % 9 == 0 {
                assert_equals_full(&mut st, &format!("seed {seed} step {step}: idempotent"));
            }
        }
        incremental += st.summary_engine.incremental_passes.load(Ordering::Relaxed);
    }
    assert!(incremental > 50, "the patch path really ran ({incremental} incremental passes)");
}

/// OTEL-side invalidation: an UNTOUCHED log card's merged output changes when its OTEL twin
/// arrives (stamp flips), and flips back when the window evicts the twin.
#[test]
fn an_untouched_log_card_follows_its_otel_twin_arriving_and_leaving() {
    let mut st = CoreState::open(&tmp("otel-twin"));
    st.put_log_session(card("L", "claude_code", "2026-08-01T10:00:00.000Z", None, 5, 2));
    st.put_log_session(card("other", "claude_code", "2026-08-01T09:00:00.000Z", None, 5, 0));
    let before = assert_equals_full(&mut st, "log only");
    let tokens_source = |o: &Out, id: &str| -> Value {
        o.summary["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == id).unwrap()["tokensSource"].clone()
    };
    assert_eq!(tokens_source(&before, "L"), "log");

    ingest_post(&mut st, "/v1/traces", otel_trace("L", 1).as_bytes());
    let with_twin = assert_equals_full(&mut st, "otel twin arrived");
    assert_eq!(tokens_source(&with_twin, "L"), "log", "log still wins, now stamped as displacing a twin");
    assert!(with_twin.summary["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == "L").unwrap()["coverageNote"].is_string());
    assert!(with_twin.attribution["L"].as_array().is_some_and(|e| !e.is_empty()), "the displaced twin's entries were captured");

    st.prune_window(now_ms() + 25 * 3_600_000);
    let gone = assert_equals_full(&mut st, "otel twin evicted");
    assert!(gone.summary["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == "L").unwrap().get("coverageNote").is_none());

    // A codex log card with a Claude OTEL twin of the same id: OTEL wins, so the log card is DROPPED.
    st.put_log_session(card("cx", "codex", "2026-08-01T08:00:00.000Z", None, 1, 0));
    ingest_post(&mut st, "/v1/traces", otel_trace("cx", 2).as_bytes());
    let dropped = assert_equals_full(&mut st, "otel wins for a non-claude log card");
    let n = dropped.summary["sessions"].as_array().unwrap().iter().filter(|s| s["sessionId"] == "cx").count();
    assert_eq!(n, 1, "exactly one card for the colliding id");
}

#[test]
fn subagent_links_patch_correctly_when_either_side_changes() {
    let mut st = CoreState::open(&tmp("links"));
    st.put_log_session(card("X", "claude_code", "2026-08-01T10:00:00.000Z", Some("P"), 5, 0));
    assert_equals_full(&mut st, "placeholder alone");
    st.put_log_session(card("agent-X", "claude_code", "2026-08-01T10:05:00.000Z", Some("P"), 7, 2));
    let linked = assert_equals_full(&mut st, "transcript arrives -> link");
    let ids: Vec<&str> = linked.summary["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert!(ids.contains(&"agent-X") && !ids.contains(&"X"), "{ids:?}");
    // The placeholder changes while the transcript is untouched: the winner must pick it up.
    let mut p = card("X", "claude_code", "2026-08-01T10:00:00.000Z", Some("P"), 5, 0);
    p["spawnKind"] = json!("async");
    p["userRequest"] = json!("do the thing");
    st.put_log_session(p);
    let relinked = assert_equals_full(&mut st, "placeholder edited");
    let w = relinked.summary["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == "agent-X").unwrap().clone();
    assert_eq!(w["spawnKind"], "async");
    // The transcript's parent stops matching: the link dissolves and the placeholder reappears.
    st.put_log_session(card("agent-X", "claude_code", "2026-08-01T10:05:00.000Z", Some("Q"), 7, 2));
    let split = assert_equals_full(&mut st, "parent mismatch -> unlinked");
    let ids: Vec<&str> = split.summary["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert!(ids.contains(&"agent-X") && ids.contains(&"X"), "{ids:?}");
}

#[test]
fn clear_and_demotion_invalidate_the_patch_state() {
    let mut st = CoreState::open(&tmp("clear-demote"));
    for i in 0..8 {
        st.put_log_session(card(&format!("c{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i + 1), None, 1, 3));
    }
    assert_equals_full(&mut st, "seed");
    let before = st.summary_engine.incremental_passes.load(Ordering::Relaxed);
    st.demote_cold_timelines(2);
    let demoted = assert_equals_full(&mut st, "demote");
    assert!(st.summary_engine.incremental_passes.load(Ordering::Relaxed) > before, "demotion patches, it does not rebuild");
    let cold = demoted.summary["sessions"].as_array().unwrap().iter().filter(|s| s["timeline"].as_array().is_some_and(|t| t.is_empty())).count();
    assert_eq!(cold, 6, "six cards lost their timelines in the merged summary");
    st.cards.clear();
    let cleared = assert_equals_full(&mut st, "clear");
    assert!(cleared.summary["sessions"].as_array().unwrap().is_empty());
    st.put_log_session(card("fresh", "claude_code", "2026-09-01T10:00:00.000Z", None, 1, 1));
    let again = assert_equals_full(&mut st, "refill after clear");
    assert_eq!(again.summary["sessions"].as_array().unwrap().len(), 1, "a card never refills after clear_all is the regression this pins");
}

#[test]
fn an_unparseable_start_time_falls_back_to_the_legacy_sort_and_still_matches() {
    let mut st = CoreState::open(&tmp("nan"));
    st.put_log_session(card("a", "claude_code", "2026-08-01T10:00:00.000Z", None, 1, 0));
    st.put_log_session(card("b", "claude_code", "not a date", None, 1, 0));
    st.put_log_session(card("c", "claude_code", "2026-08-03T10:00:00.000Z", None, 1, 0));
    assert_equals_full(&mut st, "nan seed");
    st.put_log_session(card("d", "claude_code", "2026-08-02T10:00:00.000Z", None, 1, 0));
    assert_equals_full(&mut st, "nan then insert");
}

#[test]
fn a_reader_holding_the_previous_summary_gets_a_consistent_old_view_and_the_patch_still_matches() {
    let mut st = CoreState::open(&tmp("held"));
    for i in 0..5 {
        st.put_log_session(card(&format!("h{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i + 1), None, 1, 1));
    }
    let first = assert_equals_full(&mut st, "first");
    let held = first.summary.clone(); // the reader
    let held_bytes = serde_json::to_string(&*held).unwrap();
    st.put_log_session(card("h2", "claude_code", "2026-08-09T10:00:00.000Z", None, 99, 1));
    assert_equals_full(&mut st, "after change with a reader holding the old Arc");
    assert_eq!(serde_json::to_string(&*held).unwrap(), held_bytes, "the reader's Arc was never mutated");
}
