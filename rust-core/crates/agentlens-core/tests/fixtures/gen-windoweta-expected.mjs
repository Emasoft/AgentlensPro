// Regenerates windoweta-expected.json from the COMPILED src/windowEta.ts — the parity oracle for
// get_window_eta (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-windoweta-expected.mjs
//
// It reuses the account-burners fixture timeline + event pool, because the two tools SHARE their
// attribution rule and capacity resolver by design — a separate fixture here would let them drift
// apart in exactly the place the TS comment says they must not.
//
// What this pins:
//  - THE ROLLING-WINDOW PLATEAU, which is the whole reason this tool is not `remaining ÷ rate`. A
//    rolling window sheds consumption older than its length, so at a steady rate r it plateaus at
//    r × windowLength. If that plateau is below the cap the window can NEVER exhaust — a naive
//    projection would print a confident finite countdown for a window that will never fill.
//  - The five etaReasons are DISTINCT outcomes, not shades of "unknown": no-capacity / over-limit /
//    idle / plateau / projected each get their own human string.
//  - `humanEta` and `exhaustionEtaIso` read the UNROUNDED etaMinutes while the reported
//    `etaMinutes` field is `+x.toFixed(1)` — so the ISO can disagree with etaMinutes × 60s by a few
//    seconds. Rounding first would silently "fix" a discrepancy the TS actually emits.
//  - `Math.round(m % 60)` in humanEta is half-toward-+∞, not Rust's half-away-from-zero.
//  - `capacity.costUsd?.toFixed(0)` renders "undefined" when absent — the template literal's real
//    output, not "0" and not "".
//  - bindingWindow: an ALREADY-OVER window wins outright over a smaller positive ETA, because
//    "you are past the limit" is not a countdown.
import { createRequire } from 'module'
import { writeFileSync, readFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname

const { buildWindowEtaReport, humanEta } = require('../../../../../out/test/windowEta.js')

// Reuse the burners fixture wholesale — same timeline, same events, same accounts.
const BURNERS = JSON.parse(readFileSync(dir + 'acctburners-expected.json', 'utf8'))
const NOW = BURNERS.nowMs
const EVENTS = BURNERS.events
const SEGMENTS = BURNERS.readSegments
const TARGET = BURNERS.targets.current

const CAP = (h5c, d7c) => ({
  'aaaaaaaa-1111-1111-1111-111111111111': {
    window5hTokens: 5_000_000, window7dTokens: 40_000_000,
    window5hCostUsd: h5c, window7dCostUsd: d7c, observedAt: '2026-07-30T00:00:00.000Z',
  },
})

const run = (o) => buildWindowEtaReport({
  events: EVENTS, target: TARGET, allSegments: SEGMENTS, nowMs: NOW,
  rateWindowMs: o.rateWindowMs ?? 30 * 60_000, observed: o.observed,
})

writeFileSync(dir + 'windoweta-expected.json', JSON.stringify({
  nowMs: NOW,
  // humanEta in isolation, one case per reason plus the h/m formatting boundaries.
  humanEta: [
    [null, 'no-capacity'], [null, 'idle'], [null, 'plateau'], [0, 'over-limit'],
    [0, 'projected'], [0.4, 'projected'], [30, 'projected'], [59.5, 'projected'],
    [60, 'projected'], [90, 'projected'], [1439.6, 'projected'], [null, 'projected'],
  ].map(([m, r]) => [m, r, humanEta(m, r)]),

  // No calibration at all ⇒ every section is 'no-capacity' and the verdict says why.
  noCapacity: run({ observed: {} }),
  // A generous cap the current rate can never reach ⇒ PLATEAU on both windows.
  plateau: run({ observed: CAP(500, 5000) }),
  // A cap the 5h rate WILL reach ⇒ a projected ETA, and the 5h binds.
  projected: run({ observed: CAP(4, 5000) }),
  // Already consumed past the 5h cap ⇒ over-limit wins the binding pick outright.
  overLimit: run({ observed: CAP(1, 5000) }),
  // A rate window with no events in it ⇒ rate 0 ⇒ 'idle' even though capacity is known.
  idle: run({ observed: CAP(500, 5000), rateWindowMs: 60_000 }),
  // A cap of exactly 0 is NOT null: `cap > 0` fails so fillPct is null and renders "undefined",
  // while `remaining <= 0` makes it over-limit. The two guards read the same number differently.
  zeroCap: run({ observed: CAP(0, 5000) }),
  // Both windows projected: the SMALLER positive ETA binds.
  bothProjected: run({ observed: CAP(4, 5) }),
}, null, 2) + '\n')
console.log('wrote windoweta-expected.json')
