// Runtime-neutral time-window predicate (no Node imports, no DOM APIs) so BOTH the webview
// (media/src/state.ts → rangedSessions and every surface derived from it) and the host can share
// ONE definition of "is this session in the selected time window". Pure and trivially unit-testable.
// (TRDD-06Q5AXYN D1)
//
// A session's active interval is [startMs, startMs + durationMs]. It falls IN a [since, until]
// window when that interval OVERLAPS the window — so a long-running / resumed session that STARTED
// before the window but is still active inside it is correctly included. A start-time-only test
// wrongly excluded such sessions, which is why a 15m filter still hid active-but-old work.

export function sessionInWindow(
  card: { startTime?: string; durationMs?: number },
  since: number,
  until: number,
): boolean {
  if (!card.startTime) return false
  const startMs = Date.parse(card.startTime)
  if (Number.isNaN(startMs)) return false
  const endMs = startMs + (typeof card.durationMs === 'number' && card.durationMs > 0 ? card.durationMs : 0)
  // interval-overlap: [startMs, endMs] ∩ [since, until] ≠ ∅
  return startMs <= until && endMs >= since
}
