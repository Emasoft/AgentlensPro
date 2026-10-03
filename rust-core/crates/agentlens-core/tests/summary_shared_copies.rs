//! TRDD-9VX3WTGU — the engine counts every pass that had to DEEP-COPY the previous summary because
//! a reader still held its Arc (`Arc::try_unwrap` failed). Its own test binary on purpose: the
//! counter is process-wide, so a parallel test holding readers would corrupt a delta here.

use agentlens_core::{summary_engine, CoreState};
use serde_json::json;

fn card(id: &str, start: &str) -> serde_json::Value {
    json!({ "sessionId": id, "source": "claude_code", "dataSource": "log", "startTime": start, "durationMs": 1.0,
            "inputTokens": 1, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreateTokens": 0, "timeline": [] })
}

fn rebuild(st: &mut CoreState) -> std::sync::Arc<serde_json::Value> {
    let mut inputs = st.summary_snapshot();
    let build = CoreState::summary_from(&mut inputs, 0.0);
    st.store_summary(inputs.version, build)
}

#[test]
fn a_reader_holding_the_previous_summary_is_counted_and_an_unheld_one_is_not() {
    let dir = std::env::temp_dir().join(format!("al-shared-copies-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = CoreState::open(&dir);
    st.put_log_session(card("a", "2026-08-01T10:00:00.000Z"));
    let first = rebuild(&mut st); // full pass: nothing to take back
    drop(first);

    // Nobody holds the previous output: the sessions array is MOVED, no copy.
    let base = summary_engine::shared_copies();
    st.put_log_session(card("b", "2026-08-02T10:00:00.000Z"));
    let second = rebuild(&mut st);
    assert_eq!(summary_engine::shared_copies(), base, "an unheld previous summary is moved, not copied");

    // A reader holds it across the next pass: one forced copy (the summary Arc; the stripped twin is
    // held only by the cache, so it still moves).
    let reader = second.clone();
    drop(second);
    st.put_log_session(card("c", "2026-08-03T10:00:00.000Z"));
    rebuild(&mut st);
    assert_eq!(summary_engine::shared_copies(), base + 1, "a held previous summary costs exactly one counted copy");
    assert_eq!(reader["sessions"].as_array().unwrap().len(), 2, "the reader still sees its own consistent view");
}
