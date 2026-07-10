// Fallback counters (P6) — "silence is never invisible".
//
// The ingest paths are deliberately fail-open: a corrupt JSONL line, an unparseable sidecar, an
// unreadable transcript each get swallowed so one bad byte can never take the collector down.
// That stance is correct — but it made every degradation INVISIBLE: the rich-event drop lived
// undetected for weeks, and a corrupt offsets sidecar silently costs a full cold rescan on every
// boot. This registry gives each silent catch-fallback a NAME and a count, surfaced by
// /api/server-stats under `degradations`, so an operator can see "what quietly went wrong and
// how often" without any behavior change at the swallow sites (count, don't throw — the fallback
// still happens exactly as before).
//
// Names are static string literals at the call sites (grep `countFallback(` for the inventory),
// so the map is bounded by construction — no cap/fold machinery needed.
//
// Runtime-neutral (no Node/DOM imports). The esbuild bundles are per-process, so each runtime
// (standalone server, CLI) counts its own process's fallbacks — which is exactly the scope
// /api/server-stats reports everything else in ("since boot").

const counters = new Map<string, number>()

/** Record one occurrence of the named silent fallback. Call it INSIDE the catch/skip branch,
 *  right where the failure is swallowed — never on the happy path. */
export function countFallback(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

/** Snapshot of every counter that fired since boot, name-sorted for stable output. A name that
 *  never fired is absent (honest absence — no zero-noise for paths that never degraded). */
export function fallbackTotals(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

/** Test hook: clear all counters so suites can assert exact deltas in isolation. */
export function resetFallbackCounters(): void {
  counters.clear()
}
