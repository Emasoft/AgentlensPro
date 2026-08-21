// Regenerates seismicrender-expected.json from the COMPILED src/burnSeismic.ts — the parity oracle
// for `renderBurnSeismic` (TRDD-DMWOBWFH P4x.2q, slice A of 3).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicrender-expected.mjs
//
// The results are hand-authored rather than produced by a real analysis, and that is the point: the
// renderer's hard cases are the ABSENT ones — a null local baseline, an unmeasurable background, no
// mainshock, no culprits, no spawns — and a real run gives whichever of those the day happened to
// produce. Every field the report reads is set explicitly, so a field the port forgets prints
// `undefined` here and diverges loudly instead of matching an accidental empty.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { renderBurnSeismic } = await import(path.join(HERE, '../../../../../out/test/burnSeismic.js'))

const base = (over = {}) => ({
  windowSinceIso: '2026-08-21 02:00:00',
  bucketMinutes: 5,
  filesAnalysed: 42,
  totalUsd: 123.456,
  totalWriteUsd: 80.5,
  totalReadUsd: 30.25,
  totalOutputUsd: 12.706,
  totalTurns: 1234,
  bucketCount: 240,
  baseline: { median: 0.125, mad: 0.0625 },
  poissonLambda: 5.142857,
  intensityBaseline: { median: -1.5, mad: 0.75 },
  rateLaw: 'negative-binomial',
  dispersionIndex: 3.14159,
  fdrAlpha: 0.05,
  fdrMethod: 'bh',
  fdrThreshold: 0.000123456,
  fdrSignificantCount: 7,
  calibration: { alpha: 0.05, observedBackgroundShare: 0.0612, pi0: 0.83, nullAttributableShare: 0.41, upperUniformity: 1.06 },
  localBaseline: { reference: 30, guard: 3, trim: 0.2, fallbackShare: 0.125 },
  pvalueEngine: 'internal',
  dominantModeOverall: 'CACHE_THRASH',
  verdict: 'one workspace drove 68% of the excess',
  changePoints: ['2026-08-21 03:05:00', '2026-08-21 04:10:00'],
  peltChangepoints: ['2026-08-21 03:00:00'],
  events: [],
  sessions: [],
  spawnsInMainshock: [],
  buckets: [],
  ...over,
})

const event = (over = {}) => ({
  fromIso: '2026-08-21 03:00:00',
  toIso: '2026-08-21 03:25:00',
  durMin: 25,
  costUsd: 41.5,
  excessUsd: 33.25,
  writeUsd: 30,
  readUsd: 8,
  outputUsd: 3.5,
  turns: 96,
  peakUsd: 12.75,
  peakIso: '2026-08-21 03:10:00',
  peakModZ: 8.42,
  peakStaLta: 6.1,
  minP: 0.0000012345,
  minPRate: 0.00004,
  minPIntensity: 0.002,
  magnitude: 4.25,
  dominantMode: 'CACHE_THRASH',
  cause: 'FAT_TURN_THRASH',
  culprits: [],
  ...over,
})

// A 300-unit boundary made of ASCII plus ONE astral emoji, which is TWO UTF-16 units: a port that
// counted Unicode SCALARS instead would cut in a different place and report a different overflow.
// The emoji ENDS exactly at unit 300 on purpose — one unit earlier and the cut would split the
// surrogate pair, and JS would emit a LONE SURROGATE that Rust cannot represent in a `str` at all
// (it is not valid UTF-8). That divergence is real but unreachable from a transcript, so the
// fixture pins the case that matters instead of a shape neither engine should ever produce.
const LONG = 'x'.repeat(298) + '🔥' + 'y'.repeat(10)
const LONG_ASCII = 'a'.repeat(512)

const cases = {
  reason_no_files: base({ reason: 'no-files' }),
  reason_duckdb: base({ reason: 'duckdb-unavailable', mainshock: event() }),
  // No mainshock: the report stops after the header, and everything below it must be suppressed
  // rather than printed empty.
  no_mainshock: base(),
  // Both nullable halves of the calibration line absent, and the GLOBAL background branch.
  nulls_everywhere: base({
    localBaseline: null,
    calibration: { alpha: 0.05, observedBackgroundShare: null, pi0: null, nullAttributableShare: null, upperUniformity: null },
    verdict: '',
    rateLaw: 'poisson',
    pvalueEngine: 'stochastic',
    fdrMethod: 'by',
    peltChangepoints: [],
    changePoints: [],
  }),
  // A measured background whose π̂₀ half is still absent — the two nulls are independent, and a port
  // that gated both on one condition prints the wrong half here.
  background_without_pi0: base({
    calibration: { alpha: 0.05, observedBackgroundShare: 0.5, pi0: null, nullAttributableShare: null, upperUniformity: null },
  }),
  // A zero total: every percentage divides by it, and the guard must yield 0% rather than NaN%.
  zero_total: base({
    totalUsd: 0, totalWriteUsd: 0, totalReadUsd: 0, totalOutputUsd: 0,
    mainshock: event({ costUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, culprits: [{ session: 'aaaaaaaabbbb', project: 'p', eventUsd: 0, excessUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, turns: 0, tags: [], models: [] }] }),
    events: [event({ costUsd: 0 })],
    sessions: [{ session: 'aaaaaaaabbbb', project: 'p', costUsd: 0, writeUsd: 0, readUsd: 0, outputUsd: 0, turns: 0, maxPrefixTokens: 0, eventExcessUsd: 0 }],
  }),
  // A NON-NEGATIVE exponent. Every p-value in the other cases is below 1, so they only ever produce
  // `e-N` — and `toExponential` writes a SIGN on the positive side too (`1.00e+0`, not `1.00e0`),
  // which is a branch nothing else here reaches. Both values are reachable: an FDR threshold of 1
  // means everything was significant, and a p-value underflowing to 0 prints `0.0e+0`.
  exponent_zero_and_positive: base({
    fdrThreshold: 1,
    mainshock: event({ minP: 0, minPRate: 0, minPIntensity: 12345 }),
    events: [event({ minP: 0 }), event({ minP: 1 })],
  }),
  full: base({
    events: [event(), event({ fromIso: '2026-08-21 04:00:00', durMin: 5, costUsd: 2.5, excessUsd: 1.25, magnitude: 1.05, minP: 0.049, cause: 'FANOUT_RATE' })],
    mainshock: event({
      culprits: [
        { session: 'aaaaaaaa-1111-2222-3333-444444444444', project: '/w/one', eventUsd: 30, excessUsd: 24, writeUsd: 25, readUsd: 4, outputUsd: 1, turns: 64, tags: ['COLD_REWRITE', 'MODEL_SWITCH'], models: ['claude-opus-5'] },
        { session: 'bbbbbbbb-1111-2222-3333-444444444444', project: '/w/two', eventUsd: 11.5, excessUsd: 9.25, writeUsd: 5, readUsd: 4, outputUsd: 2.5, turns: 32, tags: [], models: [] },
      ],
    }),
    sessions: [
      { session: 'aaaaaaaa-1111-2222-3333-444444444444', project: '/w/one', costUsd: 60.5, writeUsd: 40, readUsd: 15.5, outputUsd: 5, turns: 400, maxPrefixTokens: 512_000, eventExcessUsd: 24 },
      { session: 'bbbbbbbb-1111-2222-3333-444444444444', project: '/w/two', costUsd: 22, writeUsd: 10, readUsd: 9, outputUsd: 3, turns: 150, maxPrefixTokens: 96_000, eventExcessUsd: 9.25 },
    ],
    spawnsInMainshock: [
      { n: 1, iso: '2026-08-21 03:02:00', sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', tool: 'Agent', subagentType: 'general-purpose', model: 'claude-opus-5', input: 'short input' },
      // No subagentType and no model: `.filter(Boolean)` drops both clauses entirely rather than
      // printing `subagent_type=undefined`.
      { n: 2, iso: '2026-08-21 03:03:00', sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', tool: 'Task', subagentType: null, model: '', input: LONG },
      { n: 3, iso: '2026-08-21 03:04:00', sessionId: 'cccccccc-1111-2222-3333-444444444444', tool: 'Agent', subagentType: 'spark', model: null, input: LONG_ASCII },
    ],
  }),
}

const out = { cases, rendered: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, renderBurnSeismic(v)])) }
fs.writeFileSync(path.join(HERE, 'seismicrender-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote seismicrender-expected.json')
for (const [k, v] of Object.entries(out.rendered)) {
  console.log(` ${k}: ${v.split('\n').length} lines, ${v.length} chars`)
}
