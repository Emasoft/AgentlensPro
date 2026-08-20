// Regenerates cachebreak-expected.json from the COMPILED src/shared/cacheBreak.ts — the parity
// oracle for the cache-break classifier (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cachebreak-expected.mjs
//
// What this pins (each case exists because getting it wrong is silent):
//  - diffTurnSources emits cur-order entries FIRST, then prev-dropped ones, and flags exactly ONE
//    isFirstDivergence even when a kind::label repeats inside a single turn.
//  - The two branches are ASYMMETRIC: the cur branch writes `prevTokens: p?.tokens ?? 0` (nullish,
//    so absent → 0) while the removed branch writes `prevTokens: s.tokens` RAW and `curTokens: 0`.
//    An `excerpt` that is undefined DROPS its key entirely — `?? null` would keep it as null.
//  - Classification ORDER. Model switch beats fast mode beats reload beats block-diff beats idle
//    beats unattributable. Reload is deliberately checked BEFORE the single-first-divergence pick,
//    or a ≥2-catalog churn collapses to whichever catalog sorted first and is never named.
//  - The reload guard requires the catalog kind to have EXISTED in prev, so turn-2 cold-start churn
//    (a kind appearing for the FIRST time) is warmup, not a reload.
//  - MODEL_SWITCHED is TRUTHY-guarded on both sides: an EMPTY model string is "unknown", not a
//    switch. A port using `is_some()` would fire on it.
//  - The step-5 no-break object carries `idleGapMs` when known; the turn-1 literal has NO such key
//    at all. Two different shapes for two different "no break"s.
//  - UNATTRIBUTABLE needs wasted > 0 AND wasted > cacheRead — a modest write with no divergence is
//    ordinary suffix writing and must stay SILENT.
//  - priceWaste credits back the model's REAL cache-read rate; with no rates at all the cost stays
//    0 while wastedTokens is still populated.
//  - Offender ranking sorts by cost then tokens under a STABLE sort, so full ties keep insertion
//    order — and a break with no source label is grouped under a synthetic `(CAUSE)` label.
//  - buildCacheBreakReport returns null (not an empty report) for no composition and for <2 turns,
//    skips `background` entries and entries with no turn, takes the model from the FIRST llm entry
//    of the turn, and the timestamp from the first parseable one.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname

const {
  diffTurnSources, analyzeCacheBreaks, buildCacheBreakReport, CAUSE_LABEL,
} = require('../../../../../out/test/shared/cacheBreak.js')

// `buildCacheBreakReport` → `lookupRates(model)` reads the wall clock for scheduled rate changes,
// so BOTH the Date constructor and Date.now must be frozen (`new Date()` reads the clock directly).
const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const src = (kind, label, tokens, extra = {}) => ({ label, kind, tokens, bytes: tokens * 4, count: 1, ...extra })

// ── diffTurnSources cases ─────────────────────────────────────────────────────
const DIFFS = {
  // added + resized + unchanged + removed in one shot; the first divergence is the RESIZED block
  // because it comes first in cur order — not the added one further along.
  mixed: {
    prev: [src('file', 'CLAUDE.md', 5000, { excerpt: 'old md' }), src('hook', 'janitor', 100), src('skill', 'gone', 42, { excerpt: 'bye' })],
    cur: [src('file', 'CLAUDE.md', 9000, { excerpt: 'new md' }), src('hook', 'janitor', 100), src('mcp', 'brand-new', 7)],
  },
  // Nothing changed in cur, but prev has a dropped block → the divergence comes from the prev pass.
  onlyDropped: {
    prev: [src('file', 'a', 1), src('file', 'b', 2)],
    cur: [src('file', 'a', 1)],
  },
  // A duplicate kind::label inside ONE turn must not double-flag: only the first entry is marked.
  duplicateKey: {
    prev: [src('file', 'dup', 10)],
    cur: [src('file', 'dup', 99), src('file', 'dup', 99)],
  },
  identical: {
    prev: [src('file', 'a', 1), src('hook', 'h', 2)],
    cur: [src('file', 'a', 1), src('hook', 'h', 2)],
  },
  // Empty prev: every cur block is `added` and the first one is the divergence.
  coldStart: { prev: [], cur: [src('toolCatalog', 'tools', 800), src('agentCatalog', 'agents', 600)] },
}

// ── analyzeCacheBreaks cases ──────────────────────────────────────────────────
const t = (turn, o) => ({
  turn,
  sources: o.sources ?? [],
  cacheReadTokens: o.read ?? 0,
  cacheCreateTokens: o.create ?? 0,
  inputTokens: o.input ?? 0,
  ...(o.model !== undefined ? { model: o.model } : {}),
  ...(o.fast !== undefined ? { hasFastMode: o.fast } : {}),
  ...(o.ts !== undefined ? { timestampMs: o.ts } : {}),
})

const CATALOGS = [src('toolCatalog', 'tools', 800), src('agentCatalog', 'agents', 600), src('skill', 'skills', 400), src('mcp', 'servers', 200)]
const bump = (list, by) => list.map(s => ({ ...s, tokens: s.tokens + by }))

const RATES = { writeRateUsdPerMTok: 6.25, inputRateUsdPerMTok: 5, cacheReadRateUsdPerMTok: 0.5 }

const CASES = {
  // Turn 1 never breaks (no idleGapMs key at all); turn 2 switches model, which dominates the block
  // diff that is ALSO present.
  modelSwitch: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('file', 'a', 10)], read: 0, create: 5000, model: 'claude-opus-5' }),
      t(2, { sources: [src('file', 'a', 99)], read: 100, create: 5000, model: 'claude-sonnet-5' }),
    ],
  },
  // An EMPTY model string is falsy on both guards, so this is NOT a switch — it falls through to
  // the block diff. `is_some()` in a port would wrongly report MODEL_SWITCHED here.
  emptyModelIsNotASwitch: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('file', 'a', 10)], model: '' }),
      t(2, { sources: [src('file', 'a', 99)], read: 10, create: 200, model: 'claude-opus-5' }),
    ],
  },
  fastMode: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('file', 'a', 10)], fast: false }),
      t(2, { sources: [src('file', 'a', 10)], read: 10, create: 900, fast: true }),
      // Fast mode STAYS on → no longer a break; the identical sources leave nothing to blame and
      // the write is modest, so this turn is silent.
      t(3, { sources: [src('file', 'a', 10)], read: 900, create: 10, fast: true }),
    ],
  },
  // 4 catalogs churn → 'high'. All four existed in prev, so the reload guard passes.
  reloadHigh: {
    opts: RATES,
    turns: [t(1, { sources: CATALOGS }), t(2, { sources: bump(CATALOGS, 1), read: 100, create: 40000 })],
  },
  // Exactly 2 churn → 'medium', and the label lists them SORTED, not in diff order.
  reloadMedium: {
    opts: RATES,
    turns: [
      t(1, { sources: CATALOGS }),
      t(2, { sources: [CATALOGS[0], CATALOGS[1], { ...CATALOGS[2], tokens: 401 }, { ...CATALOGS[3], tokens: 201 }], read: 100, create: 9000 }),
    ],
  },
  // Two catalog kinds appear for the FIRST time (absent from prev) → warmup, NOT a reload. Without
  // the prev-must-exist guard this would be mislabeled PLUGINS_RELOADED.
  firstTimeCatalogsAreWarmup: {
    opts: RATES,
    turns: [t(1, { sources: [src('file', 'a', 10)] }), t(2, { sources: [src('file', 'a', 10), CATALOGS[0], CATALOGS[1]], read: 10, create: 1400 })],
  },
  // causeForKind: a catalog kind alone → TOOLS_CHANGED; 'mcp' → MCP_SERVER_TOGGLE; anything else →
  // INJECTED_BLOCK_CHANGED. All three are confidence 'low' / attribution 'block-diff-only'.
  kindMapping: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('toolCatalog', 'tools', 800), src('mcp', 'srv', 100), src('hook', 'h', 50)] }),
      t(2, { sources: [src('toolCatalog', 'tools', 801), src('mcp', 'srv', 100), src('hook', 'h', 50)], read: 10, create: 900 }),
      t(3, { sources: [src('toolCatalog', 'tools', 801), src('mcp', 'srv', 101), src('hook', 'h', 50)], read: 10, create: 900 }),
      t(4, { sources: [src('toolCatalog', 'tools', 801), src('mcp', 'srv', 101), src('hook', 'h', 51)], read: 10, create: 900 }),
    ],
  },
  // No diff + a gap past the TTL + a real write → IDLE_TTL_EXPIRY, carrying the gap.
  idleExpiry: {
    opts: { ...RATES, idleTtlMs: 60_000 },
    turns: [
      t(1, { sources: [src('file', 'a', 10)], ts: 1_000_000 }),
      t(2, { sources: [src('file', 'a', 10)], read: 5, create: 3000, ts: 1_000_000 + 120_000 }),
    ],
  },
  // The same gap with NO write is not an expiry — and the modest-write case below it stays silent.
  idleGapWithoutWriteIsSilent: {
    opts: { ...RATES, idleTtlMs: 60_000 },
    turns: [
      t(1, { sources: [src('file', 'a', 10)], ts: 1_000_000 }),
      t(2, { sources: [src('file', 'a', 10)], read: 5000, create: 0, ts: 1_000_000 + 120_000 }),
    ],
  },
  // wasted > cacheRead with nothing to blame → UNATTRIBUTABLE. The third turn writes MORE in
  // absolute terms but less than it read, so it stays silent — the discriminator is the RATIO.
  unattributable: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('file', 'a', 10)] }),
      t(2, { sources: [src('file', 'a', 10)], read: 100, create: 5000 }),
      t(3, { sources: [src('file', 'a', 10)], read: 900_000, create: 9000 }),
    ],
  },
  // No rates at all: wastedTokens is populated, wastedCostUsd stays 0.
  noRates: {
    opts: {},
    turns: [t(1, { sources: [src('file', 'a', 10)] }), t(2, { sources: [src('file', 'a', 99)], read: 10, create: 4000 })],
  },
  // Only the write + input rates: the cache-read credit falls back to 0.1 × input.
  defaultCacheReadRate: {
    opts: { writeRateUsdPerMTok: 6.25, inputRateUsdPerMTok: 5 },
    turns: [t(1, { sources: [src('file', 'a', 10)] }), t(2, { sources: [src('file', 'a', 99)], read: 10, create: 4000 })],
  },
  // A negative spread (write cheaper than the credited read) clamps to 0, never a negative cost.
  clampedNegativeSpread: {
    opts: { writeRateUsdPerMTok: 1, inputRateUsdPerMTok: 100 },
    turns: [t(1, { sources: [src('file', 'a', 10)] }), t(2, { sources: [src('file', 'a', 99)], read: 10, create: 4000 })],
  },
  // Offender grouping + ranking: 'heavy' accumulates over two turns and outranks 'light'; the
  // MODEL_SWITCHED break has no source label so it is grouped under the synthetic '(CAUSE)' label
  // with kind '-'; two full ties keep INSERTION order under the stable sort.
  offenders: {
    opts: RATES,
    turns: [
      t(1, { sources: [src('file', 'heavy', 1), src('file', 'light', 1), src('file', 'tieA', 1), src('file', 'tieB', 1)], model: 'claude-opus-5' }),
      t(2, { sources: [src('file', 'heavy', 2), src('file', 'light', 1), src('file', 'tieA', 1), src('file', 'tieB', 1)], read: 10, create: 8000, model: 'claude-opus-5' }),
      t(3, { sources: [src('file', 'heavy', 3), src('file', 'light', 1), src('file', 'tieA', 1), src('file', 'tieB', 1)], read: 10, create: 8000, model: 'claude-opus-5' }),
      t(4, { sources: [src('file', 'heavy', 3), src('file', 'light', 2), src('file', 'tieA', 1), src('file', 'tieB', 1)], read: 10, create: 100, model: 'claude-opus-5' }),
      t(5, { sources: [src('file', 'heavy', 3), src('file', 'light', 2), src('file', 'tieA', 2), src('file', 'tieB', 1)], read: 10, create: 500, model: 'claude-opus-5' }),
      t(6, { sources: [src('file', 'heavy', 3), src('file', 'light', 2), src('file', 'tieA', 2), src('file', 'tieB', 2)], read: 10, create: 500, model: 'claude-opus-5' }),
      t(7, { sources: [src('file', 'heavy', 3), src('file', 'light', 2), src('file', 'tieA', 2), src('file', 'tieB', 2)], read: 10, create: 7000, model: 'claude-sonnet-5' }),
    ],
  },
  // A single turn: no transition to classify, and cacheHitRate still reports off its buckets.
  singleTurn: { opts: RATES, turns: [t(1, { sources: [src('file', 'a', 10)], read: 900, create: 100 })] },
  // No turns at all: denom 0 → cacheHitRate 0, not NaN.
  empty: { opts: RATES, turns: [] },
}

// ── buildCacheBreakReport cases ───────────────────────────────────────────────
const tl = (turn, o) => ({
  type: o.type ?? 'llm', turn,
  cacheReadTokens: o.read ?? 0, cacheCreateTokens: o.create ?? 0, inputTokens: o.input ?? 0,
  ...(o.model !== undefined ? { model: o.model } : {}),
  ...(o.ts !== undefined ? { timestamp: o.ts } : {}),
})

const COMPOSITION = {
  sessionId: 's1', estimated: true, truncated: false,
  turns: [
    { turn: 1, sources: [src('file', 'CLAUDE.md', 5000)] },
    { turn: 2, sources: [src('file', 'CLAUDE.md', 9000)] },
    { turn: 3, sources: [src('file', 'CLAUDE.md', 9000)] },
  ],
}
const TIMELINE = [
  tl(1, { type: 'llm', read: 0, create: 5000, model: 'claude-opus-5', ts: '2026-08-01T11:00:00.000Z' }),
  // A `background` entry must be skipped entirely — its tokens belong to no turn.
  { type: 'background', turn: 1, cacheReadTokens: 999_999, cacheCreateTokens: 999_999 },
  // No `turn` at all → skipped.
  { type: 'llm', cacheReadTokens: 888_888, model: 'claude-haiku-4-5' },
  // A non-llm entry contributes tokens but must NOT supply the turn's model.
  tl(2, { type: 'tool', read: 100, create: 50, model: 'not-a-model' }),
  tl(2, { type: 'llm', read: 4000, create: 9000, model: 'claude-opus-5', ts: '2026-08-01T11:01:00.000Z' }),
  // The SECOND llm entry of a turn must not overwrite the model or the timestamp already taken.
  tl(2, { type: 'llm', read: 10, create: 10, model: 'claude-sonnet-5', ts: '2026-08-01T11:02:00.000Z' }),
  tl(3, { type: 'llm', read: 20_000, create: 100, model: 'claude-opus-5', ts: '2026-08-01T11:30:00.000Z' }),
]

const BUILDS = {
  full: { timeline: TIMELINE, composition: COMPOSITION, model: 'claude-opus-5' },
  // No composition → null, NOT an empty report (the caller must distinguish "cannot compute").
  noComposition: { timeline: TIMELINE, composition: null, model: 'claude-opus-5' },
  // A single turn cannot be diffed → null.
  oneTurn: { timeline: [TIMELINE[0]], composition: COMPOSITION, model: 'claude-opus-5' },
  // Turns exist but the composition has no sources for them → every turn diffs against [].
  compositionWithoutTheseTurns: {
    timeline: TIMELINE, composition: { sessionId: 's1', estimated: true, truncated: false, turns: [] }, model: 'claude-opus-5',
  },
  // An unknown model → lookupRates returns null → no rates → costs stay 0.
  unpricedModel: { timeline: TIMELINE, composition: COMPOSITION, model: 'totally-made-up-model' },
}

writeFileSync(dir + 'cachebreak-expected.json', JSON.stringify({
  nowMs: NOW,
  causeLabel: CAUSE_LABEL,
  diffs: Object.fromEntries(Object.entries(DIFFS).map(([k, v]) => [k, { ...v, out: diffTurnSources(v.prev, v.cur) }])),
  analyze: Object.fromEntries(Object.entries(CASES).map(([k, v]) => [k, { ...v, out: analyzeCacheBreaks(k, v.turns, v.opts) }])),
  build: Object.fromEntries(Object.entries(BUILDS).map(([k, v]) => [k, { ...v, out: buildCacheBreakReport('s1', v.timeline, v.composition, v.model) }])),
}, null, 2) + '\n')
console.log('wrote cachebreak-expected.json')
