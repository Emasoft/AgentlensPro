//! TRDD-YU8QPU89: the memory-pressure guard the port dropped.
//!
//! Measured motivation: an isolated alcore flooded ~9 min ingested ~6M spans, hit 10.25 GB RSS and
//! stopped answering /api/server-stats. A `/usr/bin/sample` showed the wedge inside the summary
//! rebuild over the window (IndexMap::get_index_of / clone / parse_iso_ms), ZERO writer or fsync
//! frames — so bounding the window is the fix, and nothing else bounded it.

use agentlens_core::span_window::{SpanWindow, SUMMARY_WINDOW_FLOOR_MS};

const DAY: i64 = 24 * 3_600_000;

#[test]
fn halves_over_budget_and_never_below_the_floor() {
    let mut w = SpanWindow::new(DAY);
    assert!(w.apply_memory_pressure(9_000, 4_000), "over budget must narrow");
    assert_eq!(w.effective_ms, DAY / 2);

    // Keep the pressure on: it must converge to the floor and then STOP reporting changes, or the
    // caller logs a "cut" every 5s forever on a machine that is simply over budget.
    for _ in 0..64 {
        w.apply_memory_pressure(9_000, 4_000);
    }
    assert_eq!(w.effective_ms, SUMMARY_WINDOW_FLOOR_MS);
    assert!(!w.apply_memory_pressure(9_000, 4_000), "at the floor there is nothing left to cut");
}

#[test]
fn recovers_toward_configured_and_stops_there() {
    let mut w = SpanWindow::new(DAY);
    w.apply_memory_pressure(9_000, 4_000);
    let narrowed = w.effective_ms;

    assert!(w.apply_memory_pressure(1_000, 4_000), "under budget must widen");
    assert!(w.effective_ms > narrowed);

    for _ in 0..64 {
        w.apply_memory_pressure(1_000, 4_000);
    }
    assert_eq!(w.effective_ms, DAY, "must return to the configured window, never exceed it");
    assert!(!w.apply_memory_pressure(1_000, 4_000), "already restored — no further change");
}

/// A zero budget disables the guard rather than cutting to the floor: a misconfigured 0 must not
/// silently reduce every user's window to 5 minutes.
#[test]
fn zero_budget_is_disabled_not_maximum_pressure() {
    let mut w = SpanWindow::new(DAY);
    assert!(!w.apply_memory_pressure(u64::MAX, 0));
    assert_eq!(w.effective_ms, DAY);
}
