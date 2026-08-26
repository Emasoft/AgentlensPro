// Regenerates pricing-expected.json from the COMPILED TS pricing module (the parity oracle):
// calcTokenCostUsd over every model in the table × a bucket matrix, plus the id-normalization /
// prefix / scheduled-change / unknown-model edges. Run from the repo root AFTER
// `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-pricing-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { calcTokenCostUsd, RATES } = require('../../../../../out/test/shared/pricing.js')
const dir = new URL('.', import.meta.url).pathname

// Pinned "now" for the scheduled-change default branch (no atIso ⇒ Date.now()).
const FIXED_NOW = Date.parse('2026-08-19T12:00:00Z')
Date.now = () => FIXED_NOW

const BUCKETS = [
  { i: 0, r: 0, w: 0, o: 0, w1h: 0 },
  { i: 1000, r: 0, w: 0, o: 100, w1h: 0 },
  { i: 1234, r: 50000, w: 3000, o: 456, w1h: 0 },
  { i: 1234, r: 50000, w: 3000, o: 456, w1h: 1000 },    // 1h split
  { i: 1234, r: 50000, w: 3000, o: 456, w1h: 99999 },   // clamp: w1h > w
  { i: 1234, r: 50000, w: 3000, o: 456, w1h: -5 },      // clamp: negative
  { i: 250000, r: 300000, w: 210000, o: 201000, w1h: 205000 }, // far above every threshold — whole-request step
  { i: 150000, r: 150000, w: 0, o: 5000, w1h: 0 },     // >200K COMBINED, each bucket under — step vs marginal diverge
  { i: 250000, r: 0, w: 0, o: 10000, w1h: 0 },         // between 200K and gpt-5.x's 272K threshold
]
const cases = []
for (const model of Object.keys(RATES)) {
  for (const b of BUCKETS) {
    cases.push({ model, ...b, at: null })
  }
}
// Edges: date suffixes, prefix aliases (LONGER than a key), unknown, empty, scheduled change
// before/after/unparseable atIso.
const EDGES = [
  'Claude-Opus-5-2026-05-01', 'claude-opus-5-20260501', 'claude-sonnet-5-something-longer',
  'gpt-5', 'gemini-3', 'totally-unknown-model', '', 'GPT-4.1', 'gpt-5.1-codex-mini-2025-11-13',
]
for (const model of EDGES) cases.push({ model, i: 1000, r: 2000, w: 500, o: 300, w1h: 100, at: null })
for (const at of ['2026-08-31T23:59:59Z', '2026-09-01T00:00:00Z', '2027-01-01T00:00:00Z', 'not-a-date']) {
  cases.push({ model: 'claude-sonnet-5', i: 1000, r: 2000, w: 500, o: 300, w1h: 100, at })
}
const expected = cases.map(c => ({ ...c, cost: calcTokenCostUsd(c.i, c.r, c.w, c.o, c.model, c.w1h, c.at ?? undefined) }))
writeFileSync(dir + 'pricing-expected.json', JSON.stringify({ fixedNowMs: FIXED_NOW, cases: expected }, null, 1) + '\n')
console.log('wrote', expected.length, 'pricing cases')
