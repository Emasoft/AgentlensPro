// Regenerates cachebreakreport-expected.json from the COMPILED src/mcpServer.ts — the parity oracle
// for get_cache_break_report (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cachebreakreport-expected.mjs
//
// CLAUDE_CONFIG_DIR points at the EXISTING fixtures/claude-home so `listSessionFileIds` resolves
// against committed transcripts; the session ids below are exactly the six .jsonl files there, plus
// one deliberately NOT backed by a log. Nothing is added under claude-home/ — a new file there
// changes that set and breaks ctxcomposition_parity.
//
// What this pins:
//  - THE SECOND DOUBLE-GUARD VARIANT. `scope = args.workspace?.trim()` is used BOTH as the truthy
//    filter guard AND as the `scope ?? 'all'` echo, so `workspace: "   "` filters nothing and
//    echoes "" — not "all" (which is what an ABSENT arg gives) and not "   " (which is what
//    get_context_inflation_report gives for the same input, because it echoes the RAW arg).
//  - The pool is prefix-ONLY and capped at 20 — not find_context_hogs' sessionId-substring rule at
//    25. A shared hardcoded predicate over-matches: a session would enter the pool merely because
//    its id contains the workspace string.
//  - `considered` counts scope-matched cards, `withLog` only the file-backed subset, `analyzed`
//    only those that produced a report. A single-turn session is pooled and scanned but NOT
//    analyzed — the three numbers are what makes a 0 result diagnosable rather than mysterious.
//  - `block: t.breakSourceLabel ?? null` KEEPS the key as null, while the engine's own
//    `breakSourceLabel` is DROPPED when absent. Same datum, two different wire contracts.
//  - `topOffenders: {...o, wastedCostUsd: +…}` — the overwrite of an EXISTING key keeps that key's
//    original position, so the offender stays label/kind/cause/occurrences/wastedTokens/
//    wastedCostUsd. Re-inserting at the end would reorder the wire object.
//  - Every USD figure is `+x.toFixed(4)` — a NUMBER, not the string toFixed returns.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
process.env.CLAUDE_CONFIG_DIR = dir + 'claude-home'

const { handleGetCacheBreakReport: handle } = require('../../../../../out/test/mcpServer.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const card = (id, ws, model) => ({
  sessionId: id, workspace: ws, model,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1,
  startTime: '2026-08-01T10:00:00.000Z',
})
const SESSIONS = [
  card('comp-many', '/w/alpha', 'claude-opus-5'),
  card('comp-own', '/w/alpha', 'claude-opus-5'),
  card('conv-main', '/w/alpha', 'claude-opus-5'),
  card('comp-parent', '/w/beta', 'claude-sonnet-5'),
  // Not backed by a .jsonl in claude-home ⇒ counted in `considered`, excluded from `withLog`.
  card('no-log-here', '/w/alpha', 'claude-opus-5'),
]

const src = (kind, label, tokens) => ({ label, kind, tokens, bytes: tokens * 4, count: 1 })
const ts = (m) => `2026-08-01T11:${String(m).padStart(2, '0')}:00.000Z`
const tl = (turn, read, create, model, min) => ({
  type: 'llm', turn, cacheReadTokens: read, cacheCreateTokens: create, inputTokens: 5,
  model, timestamp: ts(min),
})

const TIMELINES = {
  // Turn 2 resizes CLAUDE.md (INJECTED_BLOCK_CHANGED), turn 3 churns two catalogs
  // (PLUGINS_RELOADED), turn 4 is clean.
  'comp-many': [tl(1, 0, 5000, 'claude-opus-5', 0), tl(2, 1000, 9000, 'claude-opus-5', 1), tl(3, 2000, 40_000, 'claude-opus-5', 2), tl(4, 50_000, 100, 'claude-opus-5', 3)],
  // A single turn ⇒ buildCacheBreakReport returns null: pooled and scanned, never analyzed.
  'comp-own': [tl(1, 0, 5000, 'claude-opus-5', 0)],
  // No composition at all ⇒ also null, by the other early return.
  'conv-main': [tl(1, 0, 5000, 'claude-opus-5', 0), tl(2, 100, 6000, 'claude-opus-5', 1)],
  // A different workspace AND a different model, so the leaderboard merges across models and the
  // per-model rates actually differ.
  'comp-parent': [tl(1, 0, 4000, 'claude-sonnet-5', 0), tl(2, 500, 7000, 'claude-sonnet-5', 1)],
}
const getTimeline = (id) => TIMELINES[id] ?? []

const CATALOGS = [src('toolCatalog', 'tools', 800), src('agentCatalog', 'agents', 600)]
const COMPOSITIONS = {
  'comp-many': {
    sessionId: 'comp-many', estimated: true, truncated: false,
    turns: [
      { turn: 1, sources: [src('file', 'CLAUDE.md', 5000), ...CATALOGS] },
      { turn: 2, sources: [src('file', 'CLAUDE.md', 9000), ...CATALOGS] },
      { turn: 3, sources: [src('file', 'CLAUDE.md', 9000), src('toolCatalog', 'tools', 801), src('agentCatalog', 'agents', 601)] },
      { turn: 4, sources: [src('file', 'CLAUDE.md', 9000), src('toolCatalog', 'tools', 801), src('agentCatalog', 'agents', 601)] },
    ],
  },
  'comp-own': { sessionId: 'comp-own', estimated: true, truncated: false, turns: [{ turn: 1, sources: [src('file', 'CLAUDE.md', 4000)] }] },
  // The SAME offending block label as comp-many, so the cross-session leaderboard has something to
  // merge rather than just concatenate.
  'comp-parent': {
    sessionId: 'comp-parent', estimated: true, truncated: false,
    turns: [{ turn: 1, sources: [src('file', 'CLAUDE.md', 3000)] }, { turn: 2, sources: [src('file', 'CLAUDE.md', 7000)] }],
  },
}
const getComposition = async (id) => COMPOSITIONS[id] ?? null

const run = (args, comp = getComposition) => handle(SESSIONS, getTimeline, comp, args)

writeFileSync(dir + 'cachebreakreport-expected.json', JSON.stringify({
  sessions: SESSIONS,
  timelines: TIMELINES,
  compositions: COMPOSITIONS,
  // No composition accessor at all ⇒ an ERROR, not an empty report.
  noAccessor: await run({}, null),
  bySession: await run({ sessionId: 'comp-many' }),
  bySessionMissing: await run({ sessionId: 'nope' }),
  // A pooled session whose composition is absent ⇒ the explicit {sessionId, message}.
  bySessionNoComposition: await run({ sessionId: 'conv-main' }),
  // A session with one turn ⇒ the same message (nothing to diff), by the other early return.
  bySessionSingleTurn: await run({ sessionId: 'comp-own' }),
  all: await run({}),
  scoped: await run({ workspace: '/w/alpha' }),
  // The second double-guard variant: filters nothing, echoes "" (not "all", not "   ").
  blankScope: await run({ workspace: '   ' }),
  noMatch: await run({ workspace: '/w/nowhere' }),
  // A workspace string that is a SESSION-ID fragment must match nothing here — prefix only.
  byIdFragment: await run({ workspace: 'comp-many' }),
}, null, 2) + '\n')
console.log('wrote cachebreakreport-expected.json')
