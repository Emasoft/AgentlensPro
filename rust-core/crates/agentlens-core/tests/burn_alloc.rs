//! TRDD-9VX3WTGU — the burn tick's per-pass allocations are no longer proportional to the
//! consumption-event corpus.
//!
//! The defect: `compute_burn_series` deep-cloned EVERY consumption event once per session
//! (`Vec<Value>` built from `evs.iter().map(|e| (*e).clone())`), `compute_account_window_budgets`
//! deep-cloned every event again per account, and `compute_session_status` deep-cloned the
//! session's events. The helpers now take `&[&Value]`, so a pass borrows instead of copying.
//!
//! The proof is an ALLOCATION COUNT, not a timing assertion: with N sessions the old code
//! allocated ~N*N event copies inside `compute_burn_series` alone; the new code allocates a
//! pointer vector per group (O(N) pointers, no payload copies), so the bytes allocated by one
//! `compute_burn_status` call must stay a small FRACTION of the corpus' own serialized size —
//! and must NOT grow with the number of sessions the way a per-session deep copy would.
//!
//! The counting allocator is thread-local, so DuckDB's worker threads and the harness do not
//! pollute the number (same approach as tests/summary_alloc.rs).

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use agentlens_core::burn::monitor::{compute_burn_status, gather_consumption_events, load_burn_config};
use serde_json::{json, Value};

thread_local! {
    static BYTES: Cell<u64> = const { Cell::new(0) };
    static COUNTING: Cell<bool> = const { Cell::new(false) };
}

struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if COUNTING.try_with(|c| c.get()).unwrap_or(false) {
            let _ = BYTES.try_with(|b| b.set(b.get() + l.size() as u64));
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if COUNTING.try_with(|c| c.get()).unwrap_or(false) && new > l.size() {
            let _ = BYTES.try_with(|b| b.set(b.get() + (new - l.size()) as u64));
        }
        unsafe { System.realloc(p, l, new) }
    }
}
#[global_allocator]
static A: Counting = Counting;

fn measured<R>(f: impl FnOnce() -> R) -> (R, u64) {
    BYTES.with(|b| b.set(0));
    COUNTING.with(|c| c.set(true));
    let r = f();
    COUNTING.with(|c| c.set(false));
    (r, BYTES.with(|b| b.get()))
}

/// One session card with `calls` api_request timeline entries, each with a real cost.
fn card(i: usize, calls: usize) -> Value {
    let timeline: Vec<Value> = (0..calls)
        .map(|t| {
            json!({
                "type": "api_request",
                "timestamp": format!("2026-10-20T10:{:02}:{:02}.000Z", t / 60 % 60, t % 60),
                "model": "claude-opus-5",
                "inputTokens": 1000 + t as i64,
                "outputTokens": 500,
                "cacheReadTokens": 2000,
                "cacheCreateTokens": 300,
                "costUsd": 0.0123,
            })
        })
        .collect();
    json!({
        "sessionId": format!("sess-{i:05}"),
        "source": "claude_code",
        "dataSource": "log",
        "startTime": "2026-10-20T10:00:00.000Z",
        "durationMs": 60000.0,
        "model": "claude-opus-5",
        "workspace": "/some/workspace",
        "userRequest": "x".repeat(80),
        "inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 0, "cacheCreateTokens": 0,
        "turns": calls, "totalLlmCalls": calls,
        "accountId": "acct-a",
        "timeline": timeline,
    })
}

fn corpus(sessions: usize, calls: usize) -> (Vec<Value>, Vec<Value>) {
    let cards: Vec<Value> = (0..sessions).map(|i| card(i, calls)).collect();
    let now = 1_792_490_460_000.0;
    let events = gather_consumption_events(&cards, &[], now);
    (cards, events)
}

#[test]
fn the_burn_status_pass_does_not_copy_the_consumption_event_corpus() {
    let now = 1_792_490_460_000.0;
    let config = load_burn_config(&std::collections::HashMap::new(), std::path::Path::new("/nonexistent-home"));

    // 40 sessions × 20 calls = 800 consumption events, one per session+call.
    let (cards, events) = corpus(40, 20);
    assert_eq!(events.len(), 800, "the corpus must be the full event stream");

    // The yardstick is the OLD algorithm's own allocation, measured in the same run: the
    // pre-fix `compute_burn_series` deep-copied EVERY event once per session
    // (`evs.iter().map(|e| (*e).clone())`), so a 40-session corpus cost 40 whole-corpus copies
    // inside one pass. Reproducing that exact shape here makes the comparison real rather than
    // a hand-waved constant.
    let (_, old_style_bytes) = measured(|| {
        let mut copies: Vec<Vec<Value>> = Vec::new();
        for _ in 0..cards.len() {
            let owned: Vec<Value> = events.to_vec();
            copies.push(owned);
        }
        copies
    });
    let corpus_bytes = serde_json::to_string(&events).unwrap().len() as u64;

    let (status, bytes) = measured(|| compute_burn_status(&events, &cards, &config, now, None));
    // The status itself is a real result — the pass must still produce the whole shape.
    assert!(status["global"]["fiveMin"]["tokensPerMin"].as_f64().unwrap_or(0.0) > 0.0);
    assert_eq!(status["activeSessions"].as_f64().unwrap(), 40.0);
    assert!(status["alerts"].is_array());

    eprintln!("BURN-ALLOC corpus_events=800 corpus_bytes={corpus_bytes} B | old_style_copies={old_style_bytes} B | one_burn_status_pass={bytes} B");
    // The new pass must be an order of magnitude below the old per-session copy.
    assert!(
        bytes * 10 < old_style_bytes,
        "one burn-status pass must not copy the event corpus per session: {bytes} B allocated vs the old per-session copy at {old_style_bytes} B (corpus {corpus_bytes} B)"
    );
}

#[test]
fn the_burn_status_pass_does_not_grow_with_the_number_of_sessions() {
    // The regression's signature: a per-session deep copy makes the allocation grow with the
    // session COUNT (each session copies the WHOLE event stream). Borrowing makes it flat.
    let now = 1_792_490_460_000.0;
    let config = load_burn_config(&std::collections::HashMap::new(), std::path::Path::new("/nonexistent-home"));

    let (cards_small, events_small) = corpus(10, 20);
    let (_, small) = measured(|| compute_burn_status(&events_small, &cards_small, &config, now, None));

    let (cards_big, events_big) = corpus(80, 20);
    let (_, big) = measured(|| compute_burn_status(&events_big, &cards_big, &config, now, None));

    eprintln!("BURN-ALLOC-GROWTH 10_sessions={small} B | 80_sessions={big} B");
    // 8× the sessions ⇒ ~8× the events. A per-session copy would scale with sessions² (64×);
    // borrowing scales with events (8×). Allow a generous 4× slack over the linear 8×.
    assert!(
        big < small * 8 * 4,
        "the burn-status pass must scale with the EVENT COUNT, not the session count: 10 sessions {small} B vs 80 sessions {big} B"
    );
}
