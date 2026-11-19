//! TRDD-9VX3WTGU Phase C part 2 — the incremental (patch-in-place) summary rebuild.
//!
//! Every test compares the engine's output, byte for byte, with an INDEPENDENT full rebuild: the
//! cards are read back out of the DuckDB table and run through the public merge / link / sort
//! steps, exactly as the pre-engine `summary_over` did. The engine's own per-card logic (dirty
//! tracking, per-pair linking, ordered patch) is therefore what is under test, not a restatement.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use agentlens_core::{feed_merge, ingest_post, now_ms, summary_card_cutoff_ms, ui::strip_session_detail, CoreState, SummaryWindow};
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
    reference_at(st, None)
}

/// TRDD-ER88PXNB: the full rebuild over the cards the summary card window keeps (`cutoff` None = every card).
fn reference_at(st: &CoreState, cutoff: Option<f64>) -> (Value, Value) {
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
    let log: Vec<Value> = st.cards.cards().into_iter().filter(|c| cutoff.is_none_or(|t| agentlens_core::log_reader::last_active_ms(c) >= t)).collect();
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
}

/// The real flow: snapshot (takes the caches' previous outputs), build, store.
fn rebuild(st: &mut CoreState) -> Out {
    let mut inputs = st.summary_snapshot();
    let build = CoreState::summary_from(&mut inputs, 0.0);
    let attribution = serde_json::to_value(&build.attribution).unwrap();
    let summary = st.store_summary(inputs.version, build);
    Out { summary, attribution }
}

fn assert_equals_full(st: &mut CoreState, step: &str) -> Out {
    let (want_s, want_a) = reference(st);
    let got = rebuild(st);
    assert_eq!(serde_json::to_string(&*got.summary).unwrap(), serde_json::to_string(&want_s).unwrap(), "summary bytes after {step}");
    assert_eq!(serde_json::to_string(&got.attribution).unwrap(), serde_json::to_string(&want_a).unwrap(), "attribution bytes after {step}");
    assert_eq!(serde_json::to_string(&agentlens_core::ui::StrippedView(&want_s)).unwrap(), strip_session_detail(&want_s).to_string(), "StrippedView bytes after {step}");
    got
}

/// TRDD-ER88PXNB: the real flow at a given clock, recording the window the way ui::rebuild_once does.
fn rebuild_at(st: &mut CoreState, now: f64) -> Out {
    let mut inputs = st.summary_snapshot_at(now);
    let build = CoreState::summary_from(&mut inputs, now);
    let attribution = serde_json::to_value(&build.attribution).unwrap();
    let summary = st.store_summary(inputs.version, build);
    st.store_summary_window(inputs.version, inputs.window.take());
    Out { summary, attribution }
}

fn assert_window_equals_full(st: &mut CoreState, now: f64, step: &str) -> Out {
    let cutoff = summary_card_cutoff_ms(now, st.summary_card_days);
    let (want_s, want_a) = reference_at(st, cutoff);
    let got = rebuild_at(st, now);
    assert_eq!(serde_json::to_string(&*got.summary).unwrap(), serde_json::to_string(&want_s).unwrap(), "summary bytes after {step}");
    assert_eq!(serde_json::to_string(&got.attribution).unwrap(), serde_json::to_string(&want_a).unwrap(), "attribution bytes after {step}");
    got
}

const DAY: f64 = 86_400_000.0;

fn ms(iso: &str) -> f64 {
    agentlens_core::summarize::helpers::parse_iso_ms(iso).unwrap()
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
/// attribution map, while a reader sometimes holds the previous Arc (the forced-copy path).
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
            // Mutations the ops below do not reach, applied BEFORE the step own op so the two compose:
            // an account learned or CHANGED mid-run (the OTEL side joins it); a feed-preference flip on an
            // existing id (claude_code logs win their OTEL twin, every other source loses to it); and a
            // cold-boot restore (engine and both caches gone, cards re-inserted in REVERSE so slots reshuffle).
            let extra = r.next() % 100;
            if extra < 12 {
                let uuid = *r.pick(&["acct-1", "acct-2", "acct-3"]);
                st.accounts.record(r.pick(&IDS), uuid);
            } else if extra < 22 {
                let id = *r.pick(&IDS);
                if let Some(mut c) = st.cards.cards().into_iter().find(|c| c["sessionId"] == id) {
                    c["source"] = json!(if c["source"] == "codex" { "claude_code" } else { "codex" });
                    st.put_log_session(c);
                }
            } else if extra < 28 {
                incremental += st.summary_engine.incremental_passes.load(Ordering::Relaxed);
                st.summary_engine = Arc::new(agentlens_core::summary_engine::SummaryEngine::default());
                st.summary_cache.clear();
                let all = st.cards.cards();
                st.cards.clear();
                for c in all.into_iter().rev() {
                    st.put_log_session(c);
                }
            }
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


/// An EMPTY prune (nothing aged out, nothing narrowed) must not bump `data_version` or force a full
/// rebuild: the 5 s flush tick calls it forever, and a forced full pass there is the churn the
/// engine exists to remove. No wall-clock input reaches the summary (`summarize_spans` and the merge
/// take no `now`), so nothing but a real eviction can make the summary stale.
#[test]
fn an_empty_prune_forces_no_rebuild_and_the_next_pass_is_incremental() {
    let mut st = CoreState::open(&tmp("empty-prune"));
    st.put_log_session(card("a", "claude_code", "2026-08-01T10:00:00.000Z", None, 1, 1));
    ingest_post(&mut st, "/v1/traces", otel_trace("o", 1).as_bytes());
    assert_equals_full(&mut st, "seed");
    let version = st.data_version;
    st.prune_window(now_ms());
    assert_eq!(st.data_version, version, "a prune that evicted nothing must not bump the data version");
    assert!(!st.summary_engine.force_full.load(Ordering::Relaxed), "a prune that evicted nothing must not force a full rebuild");
    let (full, incr) = (st.summary_engine.full_passes.load(Ordering::Relaxed), st.summary_engine.incremental_passes.load(Ordering::Relaxed));
    assert_equals_full(&mut st, "after an empty prune");
    assert_eq!(st.summary_engine.full_passes.load(Ordering::Relaxed), full, "no full pass after an empty prune");
    assert_eq!(st.summary_engine.incremental_passes.load(Ordering::Relaxed), incr + 1, "the pass was incremental");
}

/// A build the cache REFUSES (a newer summary landed first) is dropped whole. The engine already
/// advanced its own state for it, so the next pass must NOT patch from that state: the previous
/// output in the cache is not the one the engine published, which the pointer check turns into a
/// full rebuild. That is why a dropped build needs no re-marking of the ids it drained.
#[test]
fn a_dropped_build_makes_the_next_pass_a_full_rebuild_that_still_matches() {
    let mut st = CoreState::open(&tmp("dropped"));
    st.put_log_session(card("a", "claude_code", "2026-08-01T10:00:00.000Z", None, 1, 1));
    assert_equals_full(&mut st, "seed");
    st.put_log_session(card("b", "claude_code", "2026-08-02T10:00:00.000Z", None, 2, 1));
    let mut inputs = st.summary_snapshot(); // takes the cache's previous output
    let slow = CoreState::summary_from(&mut inputs, 0.0); // the engine's state now includes "b"
    // A newer summary lands first (an inline build at a later data version, as `hook_events` does).
    st.data_version += 1;
    let newer = st.build_session_summary(0.0);
    let newer_version = st.summary_cache.version();
    let served = st.store_summary(inputs.version, slow);
    assert!(Arc::ptr_eq(&served, &newer), "the late, older build is refused and the newer summary is served");
    assert_eq!(st.summary_cache.version(), newer_version, "the cache never moves backwards");
    st.put_log_session(card("c", "claude_code", "2026-08-03T10:00:00.000Z", None, 3, 1));
    let full_before = st.summary_engine.full_passes.load(Ordering::Relaxed);
    let got = assert_equals_full(&mut st, "pass after a dropped build");
    assert_eq!(got.summary["sessions"].as_array().unwrap().len(), 3);
    assert!(st.summary_engine.full_passes.load(Ordering::Relaxed) > full_before, "an unrecognised previous output forces a full rebuild");
}


/// The exact interleaving the empty-slot rule exists for: a slow OLD build (A) is still running while
/// a newer pass (X) lands and a third (B) snapshots, which EMPTIES the slot again. A's late store
/// hits an empty slot that remembers a newer version and must be refused, not moved backwards.
#[test]
fn a_late_old_build_cannot_land_in_the_slot_a_newer_pass_emptied() {
    let mut st = CoreState::open(&tmp("late-old"));
    st.put_log_session(card("a", "claude_code", "2026-08-01T10:00:00.000Z", None, 1, 1));
    assert_equals_full(&mut st, "seed");
    st.put_log_session(card("b", "claude_code", "2026-08-02T10:00:00.000Z", None, 2, 1));
    let mut a = st.summary_snapshot();
    let build_a = CoreState::summary_from(&mut a, 0.0); // slow pass A, version of "b"
    st.put_log_session(card("c", "claude_code", "2026-08-03T10:00:00.000Z", None, 3, 1));
    assert_equals_full(&mut st, "newer pass X lands"); // cache holds X's version
    st.put_log_session(card("d", "claude_code", "2026-08-04T10:00:00.000Z", None, 4, 1));
    let mut b = st.summary_snapshot(); // pass B takes X's output: the slot is empty again
    assert!(st.summary_cache.is_empty());
    let x_version = st.summary_cache.version();
    assert!(a.version < x_version);
    st.store_summary(a.version, build_a);
    assert!(st.summary_cache.is_empty(), "the late old build did not land in the emptied slot");
    assert_eq!(st.summary_cache.version(), x_version, "the cache did not move backwards");
    let build_b = CoreState::summary_from(&mut b, 0.0);
    let got = st.store_summary(b.version, build_b);
    assert_eq!(got["sessions"].as_array().unwrap().len(), 4);
    assert_equals_full(&mut st, "after pass B");
}

/// The race the version guard exists for: concurrent snapshot -> build -> store loops (no rebuild
/// gate here, which is the worst case) against a writer. A late OLD build landing in the slot a
/// newer pass emptied (`take_arc`) used to be accepted and moved the cache backwards; the next pass
/// then patched from stale inputs. The cache version must never decrease, and once the dust settles
/// one more rebuild must equal the independent full rebuild.
#[test]
fn concurrent_rebuilds_never_move_the_cache_backwards_and_the_end_state_is_exact() {
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::Mutex;
    let state = Arc::new(Mutex::new(CoreState::open(&tmp("race"))));
    for i in 0..4 {
        state.lock().unwrap().put_log_session(card(&format!("s{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i + 1), None, 1, 1));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let regressions = Arc::new(AtomicU64::new(0));
    let workers: Vec<_> = (0..3)
        .map(|_| {
            let (state, stop, regressions) = (state.clone(), stop.clone(), regressions.clone());
            std::thread::spawn(move || {
                let mut last = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    let mut inputs = state.lock().unwrap().summary_snapshot();
                    let build = CoreState::summary_from(&mut inputs, 0.0);
                    let mut st = state.lock().unwrap();
                    st.store_summary(inputs.version, build);
                    let v = st.summary_cache.version();
                    if v < last {
                        regressions.fetch_add(1, Ordering::Relaxed);
                    }
                    last = v;
                }
            })
        })
        .collect();
    for i in 0..400 {
        state.lock().unwrap().put_log_session(card(&format!("s{}", i % 7), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i % 9 + 1), None, i % 5, 1));
        std::thread::yield_now();
    }
    stop.store(true, Ordering::Relaxed);
    for w in workers {
        w.join().unwrap();
    }
    assert_eq!(regressions.load(Ordering::Relaxed), 0, "the summary cache moved backwards");
    assert_equals_full(&mut state.lock().unwrap(), "after the race");
}


/// Seed an engine with a patchable previous output (two incremental-capable passes), then return
/// the full-pass count so a test can assert the NEXT pass fell back to a full rebuild.
fn seeded(name: &str) -> CoreState {
    let mut st = CoreState::open(&tmp(name));
    for i in 0..4 {
        st.put_log_session(card(&format!("e{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i + 1), None, 1, 1));
    }
    assert_equals_full(&mut st, "seed");
    st.put_log_session(card("e9", "claude_code", "2026-08-09T10:00:00.000Z", None, 1, 1));
    let before = st.summary_engine.incremental_passes.load(Ordering::Relaxed);
    assert_equals_full(&mut st, "incremental seed pass");
    assert!(st.summary_engine.incremental_passes.load(Ordering::Relaxed) > before, "the seed really patches in place");
    st
}

/// TRDD-091Z1FU0: with the stripped twin gone, the summary pointer alone proves "previous output is
/// ours". Clearing ONLY the summary cache (the pressure ladder's stage 2) must therefore force a full pass.
#[test]
fn clearing_only_the_summary_cache_forces_a_full_pass_that_matches() {
    let mut st = seeded("only-summary-cleared");
    st.summary_cache.clear();
    st.put_log_session(card("e10", "claude_code", "2026-08-10T10:00:00.000Z", None, 1, 1));
    let full_before = st.summary_engine.full_passes.load(Ordering::Relaxed);
    assert_equals_full(&mut st, "summary cache cleared");
    assert!(st.summary_engine.full_passes.load(Ordering::Relaxed) > full_before, "no previous output -> full rebuild");
}

#[test]
fn force_full_forces_a_full_pass_that_matches() {
    let mut st = seeded("force-full");
    st.summary_engine.force_full.store(true, Ordering::Relaxed);
    st.put_log_session(card("e10", "claude_code", "2026-08-10T10:00:00.000Z", None, 1, 1));
    let full_before = st.summary_engine.full_passes.load(Ordering::Relaxed);
    assert_equals_full(&mut st, "force_full");
    assert!(st.summary_engine.full_passes.load(Ordering::Relaxed) > full_before, "force_full -> full rebuild");
}

#[test]
fn a_card_epoch_clear_forces_a_full_pass_that_matches() {
    let mut st = seeded("epoch-clear");
    st.cards.clear();
    st.put_log_session(card("fresh", "claude_code", "2026-09-01T10:00:00.000Z", None, 1, 1));
    st.put_log_session(card("e0", "claude_code", "2026-08-01T10:00:00.000Z", None, 2, 1));
    let full_before = st.summary_engine.full_passes.load(Ordering::Relaxed);
    assert_equals_full(&mut st, "card epoch cleared");
    assert!(st.summary_engine.full_passes.load(Ordering::Relaxed) > full_before, "a new card epoch -> full rebuild");
}

/// The review's top risk: a foreign value in `summary_cache` at the engine's own version, with the
/// right number of sessions. Only the pointer-equality check rejects it; if the engine patched it,
/// the tampered (untouched, hence retained) session would survive into the output.
#[test]
fn a_foreign_value_in_the_summary_cache_is_rejected_and_rebuilt_in_full() {
    let mut st = seeded("foreign");
    let (version, ours) = st.summary_cache.take_arc().expect("the engine's output is cached");
    let mut foreign = (*ours).clone();
    foreign["sessions"][0]["inputTokens"] = json!(987_654_321u64);
    drop(ours);
    st.summary_cache.store_arc_if_newer(version, Arc::new(foreign));
    st.put_log_session(card("e10", "claude_code", "2026-08-10T10:00:00.000Z", None, 1, 1));
    let full_before = st.summary_engine.full_passes.load(Ordering::Relaxed);
    let got = assert_equals_full(&mut st, "foreign summary cache value");
    assert!(st.summary_engine.full_passes.load(Ordering::Relaxed) > full_before, "an unrecognised previous output -> full rebuild");
    assert!(!serde_json::to_string(&*got.summary).unwrap().contains("987654321"), "the foreign value never reached the output");
}

// TRDD-ER88PXNB T1: only cards active since the UTC-midnight cutoff enter the summary; 0 turns the window off.
#[test]
fn the_card_window_keeps_only_cards_active_since_the_utc_midnight_cutoff() {
    let mut st = CoreState::open(&tmp("window-basic"));
    st.summary_card_days = 14.0;
    let now = ms("2026-08-20T12:00:00.000Z");
    st.put_log_session(card("w-recent", "claude_code", "2026-08-19T10:00:00.000Z", None, 1, 1));
    st.put_log_session(card("w-edge", "claude_code", "2026-08-06T00:00:00.000Z", None, 1, 0));
    st.put_log_session(card("w-old", "claude_code", "2026-08-01T10:00:00.000Z", None, 1, 0));
    let got = assert_window_equals_full(&mut st, now, "window on");
    let ids: Vec<&str> = got.summary["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["w-recent", "w-edge"], "the old card is outside, the card at the cutoff is inside");
    assert_eq!(
        st.summary_window,
        Some(SummaryWindow { card_days: 14.0, cutoff_ms: ms("2026-08-06T00:00:00.000Z"), cards_included: 2, cards_resident: 3 })
    );
    // Window off, with a new card so the data version moves and the new summary is stored.
    st.summary_card_days = 0.0;
    st.put_log_session(card("w-new", "claude_code", "2026-08-20T09:00:00.000Z", None, 1, 1));
    let all = assert_window_equals_full(&mut st, now, "window off");
    assert_eq!(all.summary["sessions"].as_array().unwrap().len(), 4);
    assert_eq!(st.summary_window, None);
}

// TRDD-ER88PXNB T2: the cutoff moves only at a UTC midnight; 0, NaN give no window; a fraction rounds up to a whole day.
#[test]
fn the_card_window_cutoff_moves_only_at_a_utc_midnight() {
    let a = summary_card_cutoff_ms(ms("2026-08-20T23:59:00.000Z"), 14.0).unwrap();
    let b = summary_card_cutoff_ms(ms("2026-08-21T00:01:00.000Z"), 14.0).unwrap();
    assert_eq!(a, ms("2026-08-06T00:00:00.000Z"));
    assert_eq!(b - a, DAY);
    let noon = ms("2026-08-20T12:00:00.000Z");
    assert_eq!(summary_card_cutoff_ms(noon, 0.0), None);
    assert_eq!(summary_card_cutoff_ms(noon, f64::NAN), None);
    assert_eq!(summary_card_cutoff_ms(noon, 0.5), summary_card_cutoff_ms(noon, 1.0));
}

// TRDD-ER88PXNB T3: a card ages out while another arrives (same list length, every slot shifted); with an OTEL twin
// on the new card, a stale slot map would keep the twin beside its log card.
#[test]
fn a_card_aging_out_while_another_arrives_still_matches_a_full_rebuild() {
    let mut st = CoreState::open(&tmp("window-age-out"));
    st.summary_card_days = 14.0;
    st.put_log_session(card("x", "claude_code", "2026-08-06T00:00:30.000Z", None, 1, 0));
    st.put_log_session(card("y", "claude_code", "2026-08-10T10:00:00.000Z", None, 1, 1));
    st.put_log_session(card("z", "claude_code", "2026-08-12T10:00:00.000Z", None, 1, 1));
    assert_window_equals_full(&mut st, ms("2026-08-20T12:00:00.000Z"), "x, y, z inside");
    st.put_log_session(card("w", "claude_code", "2026-08-21T11:00:00.000Z", None, 1, 2));
    ingest_post(&mut st, "/v1/traces", otel_trace("w", 1).as_bytes());
    let got = assert_window_equals_full(&mut st, ms("2026-08-21T12:00:00.000Z"), "x aged out, w arrived");
    let n = got.summary["sessions"].as_array().unwrap().iter().filter(|s| s["sessionId"] == "w").count();
    assert_eq!(n, 1, "the log card w displaces its OTEL twin");
}

// TRDD-ER88PXNB T4: a resumed old session re-enters mid-list (with an OTEL twin) and still matches; a new session that
// appends keeps the old cards an id prefix, so that pass stays incremental.
#[test]
fn a_card_re_entering_the_window_mid_list_matches_and_appending_stays_incremental() {
    let mut st = CoreState::open(&tmp("window-re-enter"));
    st.summary_card_days = 14.0;
    let now = ms("2026-08-20T12:00:00.000Z");
    st.put_log_session(card("p", "claude_code", "2026-08-19T08:00:00.000Z", None, 1, 1));
    st.put_log_session(card("q", "claude_code", "2026-08-01T08:00:00.000Z", None, 1, 0));
    st.put_log_session(card("r", "claude_code", "2026-08-18T08:00:00.000Z", None, 1, 1));
    assert_window_equals_full(&mut st, now, "p, r inside, q outside");
    st.put_log_session(card("q", "claude_code", "2026-08-20T09:00:00.000Z", None, 1, 2));
    ingest_post(&mut st, "/v1/traces", otel_trace("q", 2).as_bytes());
    assert_window_equals_full(&mut st, now, "q re-entered mid-list");
    let (full, incr) = (st.summary_engine.full_passes.load(Ordering::Relaxed), st.summary_engine.incremental_passes.load(Ordering::Relaxed));
    st.put_log_session(card("s", "claude_code", "2026-08-20T10:00:00.000Z", None, 1, 1));
    assert_window_equals_full(&mut st, now, "s appended");
    assert_eq!(st.summary_engine.full_passes.load(Ordering::Relaxed), full, "appending forces no full pass");
    assert_eq!(st.summary_engine.incremental_passes.load(Ordering::Relaxed), incr + 1, "the append pass was incremental");
}
