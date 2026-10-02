//! TRDD-9VX3WTGU Phase C part 2 — allocated bytes per rebuild, measured with a counting allocator.
//!
//! N cards, ONE changed between two rebuilds. The first rebuild is the full build (every card
//! materialized); the second is the steady-state pass the 25 ms loop runs under ingest. Bytes are
//! counted for the measuring thread only (a thread-local counter), so DuckDB's own worker threads
//! and the test harness do not pollute the number.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use agentlens_core::CoreState;
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

fn card(i: usize, version: u32) -> Value {
    let timeline: Vec<Value> = (0..if i.is_multiple_of(2) { 20 } else { 0 })
        .map(|t| json!({ "type": "api_request", "spanId": format!("s{i}-{t}"), "timestamp": format!("2026-08-01T10:00:{t:02}.000Z"),
                         "model": "claude-opus-5", "inputTokens": 100, "outputTokens": 50, "note": "x".repeat(40) }))
        .collect();
    json!({
        "sessionId": format!("sess-{i:06}"), "source": "claude_code", "dataSource": "log",
        "startTime": format!("2026-08-{:02}T10:{:02}:00.000Z", 1 + (i / 60) % 28, i % 60), "durationMs": 1000.0 + version as f64,
        "model": "claude-opus-5", "workspace": "/some/workspace/path", "userRequest": "x".repeat(120),
        "inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 0, "cacheCreateTokens": 0,
        "turns": 3, "totalLlmCalls": 3, "timeline": timeline,
    })
}

#[test]
fn a_steady_state_rebuild_allocates_a_small_fraction_of_a_full_build() {
    const N: usize = 4_000;
    let dir = std::env::temp_dir().join(format!("al-alloc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = CoreState::open(&dir);
    for i in 0..N {
        st.put_log_session(card(i, 0));
    }
    let rebuild = |st: &mut CoreState| {
        let mut inputs = st.summary_snapshot();
        let build = CoreState::summary_from(&mut inputs, 0.0);
        st.store_summary(inputs.version, build);
    };
    let ((), full) = measured(|| rebuild(&mut st));
    // One card changes (an ingest tick), then the steady-state pass.
    st.put_log_session(card(7, 1));
    let ((), one_changed) = measured(|| rebuild(&mut st));
    st.put_log_session(card(N + 1, 0)); // and a brand-new card
    let ((), one_new) = measured(|| rebuild(&mut st));
    eprintln!("ALLOC cards={N} full_build={full} B | 1_changed={one_changed} B | 1_new={one_new} B");
    assert!(one_changed * 8 < full, "a 1-card change must allocate far less than a full build: {one_changed} vs {full}");
    assert!(one_new * 8 < full, "{one_new} vs {full}");
}
