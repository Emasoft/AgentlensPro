// Regenerates forensicsdb-expected.json from the COMPILED src/forensicsDb.ts — the parity oracle
// for SLICE B1's two pure helpers (TRDD-DMWOBWFH): billableWeight and tierClassify. The DB handle,
// the schema and the custom-fn registration are exercised by native Rust tests instead: they have no
// TS oracle worth building, because the TS side is sql.js (in-memory, WAL inert) and the Rust side
// is real SQLite — the very difference SLICE B1 exists to handle correctly.
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsdb-expected.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { billableWeight, tierClassify } =
  await import(path.join(HERE, '../../../../../out/test/forensicsDb.js'))

// NaN / ±Infinity do not survive JSON (JSON.stringify writes them as null, which is also how a
// legitimate null encodes). Tag them as strings and let the Rust side map them back, so an input the
// fixture claims is NaN cannot silently arrive as null.
const enc = (v) => {
  if (v === undefined) return 'undefined'
  if (v === null) return null
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return 'Infinity'
  if (v === -Infinity) return '-Infinity'
  return v
}

// ── billableWeight ────────────────────────────────────────────────────────────────
//
// MODEL CHOICE IS LOAD-BEARING, TWICE OVER.
//
// 1. `claude-sonnet-5` is EXCLUDED. It is the only model in the table carrying a `scheduledChange`
//    (introductory pricing ends 2026-08-31), and billableWeight calls `lookupRates(model)` with NO
//    `atIso`, so that model's rates resolve against `Date.now()`. A fixture built on it would encode
//    today's rates and start failing on 2026-09-01 for a reason that has nothing to do with the
//    port. Every model used here is time-independent, so this oracle does not rot.
//
// 2. `gpt-4o` is INCLUDED specifically because its cacheRead rate (1.25) is NOT one tenth of its
//    input rate (2.5 → 0.25). billableWeight deliberately weights cache reads at a flat 0.1x of the
//    INPUT rate rather than reading `cacheReadPerMTok`, and on every Claude model those two happen
//    to be equal — so a port that used the table's cacheRead column would agree everywhere and only
//    diverge here, by 5x. Without this row that bug ships green.
const M = 1_000_000
const bwCases = [
  // Each bucket alone, one MTok, so a swapped or dropped multiplier moves exactly one row.
  { case: 'input only',        cc5m: 0, cc1h: 0, cread: 0, out: 0, input: M, model: 'claude-opus-5' },
  { case: 'cc5m only (1.25x)', cc5m: M, cc1h: 0, cread: 0, out: 0, input: 0, model: 'claude-opus-5' },
  { case: 'cc1h only (2x)',    cc5m: 0, cc1h: M, cread: 0, out: 0, input: 0, model: 'claude-opus-5' },
  { case: 'cread only (0.1x)', cc5m: 0, cc1h: 0, cread: M, out: 0, input: 0, model: 'claude-opus-5' },
  { case: 'output only',       cc5m: 0, cc1h: 0, cread: 0, out: M, input: 0, model: 'claude-opus-5' },
  { case: 'all buckets mixed', cc5m: 1000, cc1h: 2000, cread: 30000, out: 400, input: 5000, model: 'claude-opus-5' },
  // The 0.1x-vs-table falsification (see note 2 above).
  { case: 'gpt-4o cread only — 0.1x input, NOT the cacheRead column', cc5m: 0, cc1h: 0, cread: M, out: 0, input: 0, model: 'gpt-4o' },
  { case: 'codex-mini cread only — same trap, 2.5x apart', cc5m: 0, cc1h: 0, cread: M, out: 0, input: 0, model: 'codex-mini-latest' },
  // A second Claude model proves the rate is looked up per-model, not hardcoded to opus.
  { case: 'mythos-5 mixed', cc5m: 1000, cc1h: 1000, cread: 1000, out: 1000, input: 1000, model: 'claude-mythos-5' },
  // Fail-soft: an unknown / absent model is 0, never a throw and never a guessed rate.
  { case: 'unknown model', cc5m: M, cc1h: M, cread: M, out: M, input: M, model: 'no-such-model-xyz' },
  { case: 'null model',    cc5m: M, cc1h: M, cread: M, out: M, input: M, model: null },
  { case: 'empty model',   cc5m: M, cc1h: M, cread: M, out: M, input: M, model: '' },
  // num(): a non-finite bucket contributes 0 rather than poisoning the whole sum with NaN.
  { case: 'NaN bucket',      cc5m: NaN, cc1h: 0, cread: 0, out: 0, input: M, model: 'claude-opus-5' },
  { case: 'Infinity bucket', cc5m: Infinity, cc1h: 0, cread: 0, out: 0, input: M, model: 'claude-opus-5' },
  { case: 'every bucket NaN', cc5m: NaN, cc1h: NaN, cread: NaN, out: NaN, input: NaN, model: 'claude-opus-5' },
  // Negatives are finite, so num() passes them through — a port that clamped at 0 would disagree.
  { case: 'negative input passes through', cc5m: 0, cc1h: 0, cread: 0, out: 0, input: -M, model: 'claude-opus-5' },
]
const billableWeightCases = bwCases.map((c) => ({
  case: c.case,
  cc5m: enc(c.cc5m), cc1h: enc(c.cc1h), cread: enc(c.cread), out: enc(c.out), input: enc(c.input),
  model: c.model,
  value: billableWeight(c.cc5m, c.cc1h, c.cread, c.out, c.input, c.model),
}))

// ── tierClassify ──────────────────────────────────────────────────────────────────
// Every boundary pinned ON and either side. The comparisons are `< 4.5`, `<= 6`, `<= 65`, so 4.5 is
// TTL_5m (NOT break), 6 is TTL_5m, and 65 is MID — the three places a `<`/`<=` slip hides.
const tcInputs = [
  null, undefined, NaN, Infinity, -Infinity,
  -1e9, -0.0001, 0, 4.4999, 4.5, 4.5001, 5, 5.9999, 6, 6.0001,
  64.9999, 65, 65.0001, 1e9,
]
const tierClassifyCases = tcInputs.map((v) => ({ input: enc(v), out: tierClassify(v) }))

const out = { billableWeight: billableWeightCases, tierClassify: tierClassifyCases }
fs.writeFileSync(path.join(HERE, 'forensicsdb-expected.json'), `${JSON.stringify(out, null, 2)}\n`)
console.log(`wrote forensicsdb-expected.json — ${billableWeightCases.length} billableWeight, ${tierClassifyCases.length} tierClassify`)
