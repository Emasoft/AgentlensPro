//! TRDD-735Q3JF4 item 2: the burn path builds its summary over a card SUBSET
//! (`CoreState::burn_subset_summary`). These tests pin that the subset gives the same burn status as
//! the whole-corpus `summary_over`, and that asking for burn status never starts the full-summary path.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::ui::{burn_status_now, burn_summary_now, summary_now};
use crate::{burn_status_for, BurnInputs, CoreState, LockTimed};

const OTEL_TWIN: &str = "22222222-otel-twin-cold";
/// A fixed clock for every test here: the fixture timestamps are built from it, so no run depends on the wall clock.
const NOW: f64 = 1_790_000_000_000.0;

fn iso(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let rem = (ms - secs as f64 * 1000.0) as u32;
    chrono_free_iso(secs, rem)
}

/// Epoch seconds to `YYYY-MM-DDTHH:MM:SS.mmmZ` without a date crate (civil-from-days).
fn chrono_free_iso(secs: i64, ms: u32) -> String {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z", tod / 3600, tod % 3600 / 60, tod % 60)
}

fn entries(now: f64, n: usize, base_cost: f64) -> Value {
    Value::Array(
        (0..n)
            .map(|i| {
                json!({
                    "type": "api_request",
                    "timestamp": iso(now - 60_000.0 * (i as f64 + 1.0)),
                    "inputTokens": 100 + i, "outputTokens": 50, "cacheReadTokens": 4000, "cacheCreateTokens": 300,
                    "costUsd": base_cost + i as f64 * 0.01, "model": "claude-opus-5",
                })
            })
            .collect(),
    )
}

#[allow(clippy::too_many_arguments)]
fn card(id: &str, account: &str, parent: Option<&str>, workspace: &str, tl: Value, traffic: u64, now: f64, age_min: f64) -> Value {
    let mut c = json!({
        "sessionId": id, "source": "claude_code", "dataSource": "log", "accountId": account,
        "workspace": workspace, "model": "claude-opus-5",
        "startTime": iso(now - age_min * 60_000.0), "durationMs": 1000.0,
        "inputTokens": traffic, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreateTokens": 0,
        "timeline": tl,
    });
    if let Some(p) = parent {
        c["parentSessionId"] = json!(p);
    }
    c
}

fn otel_post(session: &str, now: f64) -> String {
    let nanos = format!("{}", (now as i64 - 120_000) * 1_000_000);
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": "00000000000000000000000000000abc", "spanId": "0000000000000abc",
        "startTimeUnixNano": nanos,
        "attributes": [
            { "key": "session.id", "value": { "stringValue": session } },
            { "key": "input_tokens", "value": { "intValue": "9000" } },
            { "key": "cost_usd", "value": { "doubleValue": 7.5 } }
        ]
    }] }] }] })
    .to_string()
}

/// The fixture: one state holding every case the subset rule exists for. `now` is fixed by the
/// caller so both computations read the same clock; nothing in the burn output is otherwise nondeterministic.
fn fixture(dir: &std::path::Path, now: f64) -> Arc<Mutex<CoreState>> {
    let state = Arc::new(Mutex::new(CoreState::open(dir)));
    {
        let mut st = state.lock_timed();
        // OTEL window session whose LOG twin is cold: the log card displaces it in the full merge.
        crate::ingest_post(&mut st, "/v1/traces", otel_post(OTEL_TWIN, now).as_bytes());
        // (a) hot cards, two accounts.
        st.put_log_session(card("11111111-hot-a", "acct-a", None, "/ws/a", entries(now, 3, 0.10), 5000, now, 30.0));
        st.put_log_session(card("77777777-hot-b", "acct-b", None, "/ws/b", entries(now, 2, 0.20), 5000, now, 20.0));
        // (b) the demoted twin: sessionId matches the OTEL session, timeline stripped.
        let mut cold = card(OTEL_TWIN, "acct-b", None, "/ws/b", json!([]), 5000, now, 40.0);
        cold["timelineTruncatedCount"] = json!(4);
        st.put_log_session(cold);
        // (c1) a FORK placeholder, hot, whose transcript twin is cold: the full merge keeps the cold
        // transcript and drops the hot placeholder, so its events vanish.
        let mut fork = card("33333333-ph-hot", "acct-a", Some("11111111-hot-a"), "/ws/a", entries(now, 2, 0.30), 0, now, 25.0);
        fork["spawnKind"] = json!("fork");
        st.put_log_session(fork);
        st.put_log_session(card("agent-33333333-ph-hot", "acct-a", Some("11111111-hot-a"), "/ws/a", json!([]), 8000, now, 25.0));
        // (c2) the other direction: a COLD placeholder whose HOT transcript has no workspace, so the
        // merged card takes the placeholder's workspace (`t.x || p.x`) and the events carry it.
        st.put_log_session(card("44444444-ph-cold", "acct-b", Some("77777777-hot-b"), "/ws/placeholder", json!([]), 0, now, 15.0));
        st.put_log_session(card("agent-44444444-ph-cold", "acct-b", Some("77777777-hot-b"), "", entries(now, 2, 0.40), 8000, now, 15.0));
        // A hot subagent card (parent set, no transcript twin).
        st.put_log_session(card("66666666-sub", "acct-a", Some("11111111-hot-a"), "/ws/a", entries(now, 1, 0.05), 100, now, 10.0));
        // Unrelated cold cards: they must not matter.
        for i in 0..20 {
            st.put_log_session(card(&format!("cold-{i:02}"), "acct-a", None, "/ws/cold", json!([]), 100, now, 600.0 + i as f64));
        }
    }
    state
}

fn full_status(state: &Arc<Mutex<CoreState>>, now: f64) -> Value {
    let BurnInputs { spans, cards, accounts } = state.lock_timed().burn_snapshot();
    let full = CoreState::summary_over(&spans, &cards, &accounts, now).0;
    let (ttl, config) = {
        let mut st = state.lock_timed();
        (st.burn.ttl_context(now), st.burn.config.clone())
    };
    burn_status_for(&full, &config, &ttl, now)
}

fn subset_status(state: &Arc<Mutex<CoreState>>, now: f64) -> Value {
    let summary = burn_summary_now(state);
    let (ttl, config) = {
        let mut st = state.lock_timed();
        (st.burn.ttl_context(now), st.burn.config.clone())
    };
    burn_status_for(&summary, &config, &ttl, now)
}

struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(tag: &str) -> (std::path::PathBuf, Cleanup) {
    let dir = std::env::temp_dir().join(format!("al-burnsubset-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    (dir.clone(), Cleanup(dir))
}

/// END-TO-END PARITY: the whole burn status (every field, `now` fixed) from the subset path equals the
/// one from `summary_over` over the whole corpus. The fixture covers hot cards on two accounts, a cold
/// log card that displaces an OTEL twin, a hot fork placeholder over a cold transcript, a cold placeholder
/// under a hot transcript, a subagent card and unrelated cold cards.
///
/// `costIsIntervalTotal` is NOT in the fixture: it exists only on statusline events, and
/// `burn_status_for` is always called with an empty statusline list, so no timeline can produce it.
///
/// MUTATION CHECKS (each makes this fail): drop part (b), the `window_twin` test, from
/// `burn_subset_summary`; drop part (c), the `while let Some(i) = work.pop()` closure.
#[test]
fn the_burn_subset_gives_the_same_burn_status_as_the_full_summary() {
    let (dir, _cleanup) = temp("parity");
    let now = NOW;
    let state = fixture(&dir, now);
    let full = full_status(&state, now);
    let subset = subset_status(&state, now);
    // Non-vacuity: the fixture's events reached the status, and the subset really is a subset.
    assert!(full["activeSessions"].as_f64().unwrap_or(0.0) >= 4.0, "fixture produced no burn: {full}");
    assert!(full["accountWindows"].as_array().is_some_and(|a| a.len() >= 2), "two accounts expected: {full}");
    {
        let BurnInputs { spans, cards, accounts } = state.lock_timed().burn_snapshot();
        // Non-vacuity of case (b): the OTEL twin really is a session of the window (not pruned or rejected by the clock).
        let window = crate::summarize::summarizer::summarize_spans(&spans, &|sid| accounts.get(sid).cloned());
        let in_window = window["sessions"].as_array().is_some_and(|a| a.iter().any(|c| c["sessionId"].as_str() == Some(OTEL_TWIN)));
        assert!(in_window, "OTEL_TWIN must be a session of the window, else case (b) is vacuous");
        let full_sessions = CoreState::summary_over(&spans, &cards, &accounts, now).0["sessions"].as_array().unwrap().len();
        let subset_sessions = burn_summary_now(&state)["sessions"].as_array().unwrap().len();
        assert!(subset_sessions < full_sessions, "the subset must drop the unrelated cold cards ({subset_sessions} vs {full_sessions})");
    }
    assert_eq!(subset, full);
}

/// ENGINE PARITY: `summary_over` is the reference, but production serves `summary_now` (the incremental
/// engine). The burn status from its summary must equal the subset path's too. Run on a SEPARATE state built
/// from the same fixture, because `summary_now` sets `summary_asked`, which the unasked test pins false.
#[test]
fn the_burn_subset_gives_the_same_burn_status_as_the_production_engine() {
    let (dir_a, _ca) = temp("engine-a");
    let (dir_b, _cb) = temp("engine-b");
    let now = NOW;
    let subset = subset_status(&fixture(&dir_a, now), now);
    let state = fixture(&dir_b, now);
    let (_, summary) = summary_now(&state, now);
    let (ttl, config) = {
        let mut st = state.lock_timed();
        (st.burn.ttl_context(now), st.burn.config.clone())
    };
    let engine = burn_status_for(&summary, &config, &ttl, now);
    assert!(engine["activeSessions"].as_f64().unwrap_or(0.0) >= 4.0, "fixture produced no burn: {engine}");
    assert_eq!(subset, engine);
}

/// The memo: with no data change two calls return the SAME `Arc`; a write moves `data_version` and yields a new one.
#[test]
fn the_burn_summary_is_memoized_per_data_version() {
    let (dir, _cleanup) = temp("memo");
    let now = NOW;
    let state = fixture(&dir, now);
    let a = burn_summary_now(&state);
    let b = burn_summary_now(&state);
    assert!(Arc::ptr_eq(&a, &b), "no data change: the memoized summary must be returned");
    state.lock_timed().put_log_session(card("99999999-new", "acct-a", None, "/ws/a", entries(now, 1, 0.5), 100, now, 5.0));
    let c = burn_summary_now(&state);
    assert!(!Arc::ptr_eq(&a, &c), "a data change must produce a new summary");
}

/// Asking for burn status must not start the whole-summary path: no `summary_asked`, no cached summary.
/// (`run_burn_tick` is an endless async loop; its body is scanned for the call as well.)
#[test]
fn burn_status_never_asks_for_the_full_summary() {
    let (dir, _cleanup) = temp("unasked");
    let now = NOW;
    let state = fixture(&dir, now);
    let _ = burn_status_now(&state, now);
    {
        let mut st = state.lock_timed();
        let version = st.data_version;
        assert!(!st.summary_asked, "burn_status_now must not release the rebuild loop");
        assert!(st.summary_cache.current(version).is_none(), "burn_status_now must not build the full summary");
    }
    let src = include_str!("ui.rs");
    let start = src.find("pub async fn run_burn_tick").expect("run_burn_tick");
    let body = &src[start..];
    let end = body.find("\n}\n").expect("end of run_burn_tick");
    let needle = format!("{}(", "summary_now");
    // A bare call, not a longer name that ends in it (`burn_summary_now(` is the replacement).
    let bare_call = |l: &str| l.match_indices(needle.as_str()).any(|(i, _)| !l[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_'));
    let hits: Vec<&str> = body[..end].lines().filter(|l| !l.trim_start().starts_with("//") && bare_call(l)).collect();
    assert!(hits.is_empty(), "run_burn_tick must not call summary_now: {hits:?}");
}

/// TRDD-H3D5ZBO1: the bodies scan must never come back under the first (lock A) hold of the burn
/// tick. That hold once ran `bodies.poll` for 534-588 s on the first pass after boot.
#[test]
fn the_burn_tick_runs_no_bodies_poll_or_scan_under_lock_a() {
    let src = include_str!("ui.rs");
    let start = src.find("pub async fn run_burn_tick").expect("run_burn_tick");
    let body = &src[start..];
    let lock_a = body.find("lock_timed()").expect("lock A");
    let end = lock_a + body[lock_a..].find("\n        };\n").expect("end of lock A");
    let hits: Vec<&str> = body[lock_a..end].lines().filter(|l| !l.trim_start().starts_with("//") && (l.contains(".poll(") || l.contains(".scan"))).collect();
    assert!(hits.is_empty(), "lock A of run_burn_tick must not poll or scan the bodies folder: {hits:?}");
}