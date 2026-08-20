// Regenerates skillattr-expected.json from the COMPILED src/skillAttribution.ts — the parity
// oracle for get_skill_attribution (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-skillattr-expected.mjs
//
// Both engines read the SAME committed fixture transcripts under ./skillattr-home/, passed as an
// explicit `dirs` root so neither engine ever touches the real ~/.claude.
//
// What the fixture is built to discriminate:
//  - THE DEDUPE. msg_aaaa1111 is ONE message written as THREE JSONL rows, each repeating the FULL
//    usage. Per-row summing triples it; per-message-id counts it once and reports 2 skipped rows.
//  - The ts filter runs BEFORE the dedupe: in the windowed case all three of those rows are cut by
//    timestamp, so duplicateRowsSkipped drops to 0 rather than staying 2.
//  - An attributed message with NO usage block (msg_aaaa4444) still counts as attributed, just not
//    priced — the two counters must diverge.
//  - `usage: 5` (msg_cccc4444) is TRUTHY but not an object: the TS prices it (at $0), so an
//    `is_object()` port would move it into unpriced and disagree.
//  - An EMPTY attributionSkill (msg_cccc2222) is falsy: no "" rollup is minted, but the row's
//    PLUGIN still counts.
//  - A row with no `message` at all (other:delta) is attributed, unpriced, and un-deduped.
//  - An unparseable timestamp (msg_cccc3333) is kept when unwindowed and dropped when windowed,
//    and never contributes a firstTs/lastTs.
//  - models are ranked most-used-first (alpha: opus x3, sonnet x1).
//  - A cost TIE (other:gamma and other:delta, both $0) resolves by insertion order — both live in
//    ONE file so the tie-break is deterministic regardless of readdir order.
//  - Non-assistant rows, rows without the marker, and a TORN JSON line are all skipped.
//
// NOT pinned here, deliberately: the whole-file `includes('attributionSkill')` pre-filter is a pure
// optimization — a file it skips has no attributed rows to begin with, so no fixture can make its
// absence observable. And the mtime file-skip is unpinnable from a committed fixture because git
// does not preserve mtimes; the Rust side asserts it as a property test instead.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { buildAttributionReport } = require('../../../../../out/test/skillAttribution.js')
const dir = new URL('.', import.meta.url).pathname

// Pinned clock. calcTokenCostUsd resolves an announced rate change against "now" when the call
// carries no timestamp, so an unpinned Date.now would make this oracle expire on a rate-change
// date. `new Date()` reads the system clock directly and would slip past a Date.now stub, so the
// whole constructor is replaced.
const NOW = Date.parse('2026-08-01T13:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const dirs = [dir + 'skillattr-home']

// The tool layer: `{...rep, windowHours}` — `windowHours` already exists in the report, so it keeps
// its ORIGINAL position and only its value changes. And the two guards differ: sinceMs is derived
// under a TRUTHY test while windowHours is assigned under a NULLISH one, so `window: 0` means "no
// window at all" AND `windowHours: 0` — not null.
const tool = (window, topN) => ({
  ...buildAttributionReport({ dirs, sinceMs: window ? NOW - window * 3_600_000 : undefined, topN }),
  windowHours: window ?? null,
})

writeFileSync(dir + 'skillattr-expected.json', JSON.stringify({
  nowMs: NOW,
  report: buildAttributionReport({ dirs }),
  windowed: buildAttributionReport({ dirs, sinceMs: Date.parse('2026-08-01T10:07:00.000Z') }),
  // Math.max(1, topN) with no upper clamp: 0 and a negative both floor to 1.
  capped1: buildAttributionReport({ dirs, topN: 1 }),
  capped0: buildAttributionReport({ dirs, topN: 0 }),
  cappedNeg: buildAttributionReport({ dirs, topN: -5 }),
  // A root that does not exist is skipped, not fatal — a machine with no transcripts is a real
  // answer, and erroring there would read as "the probe failed".
  missingRoot: buildAttributionReport({ dirs: [dir + 'skillattr-home-does-not-exist'] }),
  toolFull: tool(undefined, undefined),
  toolWindow1h: tool(1, undefined),
  toolZeroWindow: tool(0, undefined),
  toolTop1: tool(undefined, 1),
}, null, 2) + '\n')
console.log('wrote skillattr-expected.json')
