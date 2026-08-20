// Regenerates lean-expected.json from the COMPILED src/leanResponse.ts — the parity oracle for the
// MCP token-economy choke point (TRDD-DMWOBWFH P4x.2c).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-lean-expected.mjs
//
// leanify is PURE, so it is driven directly. The cases are chosen to hit each shaping rule AND each
// ceiling-degradation stage, because the stages are what a "simplification" would collapse:
//
//  - DROP_KEYS is a DENY-list: `breakdown` goes, `remediation` STAYS. Four tool descriptions
//    advertise remediation as part of the answer, and an allow-list once deleted it silently.
//  - nested objects are KEPT. Flattening them deleted 87% of get_window_budget's leaves and the
//    authoritative usageWindows.fiveHourPct from get_account_status.
//  - the three shapeGeneric passes ARE the key order: scalars, arrays, objects, coverage,
//    _truncated — not the input's order.
//  - the ceiling emits ONE note, rewritten in place. Against a tiny ceiling the per-iteration
//    version came out 203 tokens for a 60-token budget, of which 7 notes WERE the payload.
//  - a {format,text} payload is the tool's own rendering and is only CAPPED, never re-shaped.
//  - `… (+N chars)` and the elision markers are measured in UTF-16 units, so a payload full of
//    astral characters must not drift the ceiling.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { leanify } = require('../../../../../out/test/leanResponse.js')
const dir = new URL('.', import.meta.url).pathname

const bigArray = (n, w = 1) => Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, tokens: i * 1000, note: 'x'.repeat(w) }))
const deep = (levels) => levels === 0 ? { leaf: 1 } : { down: deep(levels - 1), scalar: levels }

const cases = [
  { name: 'null-passes-through', result: null },
  { name: 'string-passes-through', result: 'just a string' },
  { name: 'number-passes-through', result: 42 },
  { name: 'scalars-arrays-objects-in-that-key-order', result: {
    // Deliberately interleaved in the INPUT so a shaper that preserved input order fails.
    arr: bigArray(3), verdict: 'the answer', obj: { a: 1, b: { c: 2 } }, count: 7, flag: true, other: [1, 2, 3],
  } },
  { name: 'drop-keys-removes-breakdown-but-keeps-remediation', result: {
    total: 5,
    window: { consumedTokens: 100, breakdown: { input: 1, output: 2 }, pctConsumed: 0.5 },
    remediation: ['stop the fan-out', 'compact the parent'],
    culpritId: 'abc-123', culpritSummary: 'the fan-out',
  } },
  { name: 'nested-objects-are-kept-to-depth-3', result: { budget: deep(2) } },
  { name: 'depth-guard-elides-at-4', result: { a: deep(6) } },
  { name: 'array-head-of-5-discloses-the-cut', result: { rows: bigArray(12) } },
  { name: 'nested-array-head-of-3-discloses-the-cut', result: { holder: { inner: bigArray(9) } } },
  { name: 'coverage-collapses-to-one-line', result: { verdict: 'ok', coverage: { note: 'scanned 12 of 40 sessions', complete: false, scanned: 12, total: 40 } } },
  { name: 'coverage-complete-true', result: { verdict: 'ok', coverage: { complete: true, scanned: 40, total: 40 } } },
  { name: 'coverage-unrecognised-is-dropped', result: { verdict: 'ok', coverage: { scanned: 12 } } },
  { name: 'nulls-are-dropped-from-rows', result: { rows: [{ a: 1, b: null, c: 'keep' }] } },
  { name: 'long-string-clips-with-a-disclosure', result: { verdict: 'v'.repeat(900), note: 'n'.repeat(900) } },
  { name: 'astral-chars-are-counted-in-utf16-units', result: { note: '🙂'.repeat(300) } },
  { name: 'top-level-array-becomes-rows', result: bigArray(9) },
  { name: 'top-level-array-under-limit', result: bigArray(2) },
  { name: 'pre-rendered-text-is-only-capped', result: { format: 'table', text: 't'.repeat(200) } },
  { name: 'pre-rendered-text-over-budget', result: { format: 'table', text: 't'.repeat(50_000) }, opts: { maxTokens: 100 } },
  { name: 'verbosity-full-is-untouched', result: { rows: bigArray(30), coverage: { note: 'n' } }, opts: { verbosity: 'full' } },
  // ── the ceiling's four stages, each forced ────────────────────────────────────────────────────
  { name: 'ceiling-shrinks-arrays', result: { rows: bigArray(5, 400) }, opts: { maxTokens: 200 } },
  { name: 'ceiling-prunes-nesting', result: { a: deep(3), b: deep(3), c: deep(3) }, opts: { maxTokens: 40 } },
  { name: 'ceiling-narrows-width', result: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, `v${i}`.repeat(20)])), opts: { maxTokens: 60 } },
  { name: 'ceiling-clips-strings-last', result: { one: 'z'.repeat(5_000) }, opts: { maxTokens: 30 } },
  { name: 'ceiling-emits-exactly-one-note', result: { rows: bigArray(20, 300), deepObj: deep(4), wide: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`w${i}`, i])) }, opts: { maxTokens: 60 } },
  { name: 'ceiling-preserves-an-earlier-phase-note', result: { rows: bigArray(20, 200), coverage: { note: 'partial scan' } }, opts: { maxTokens: 80 } },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'lean-expected.json'), JSON.stringify({
  cases: J(cases),
  results: cases.map(c => J(leanify(c.result, c.opts ?? {}))),
}, null, 1) + '\n')
console.log(`lean-expected.json: ${cases.length} case(s)`)
