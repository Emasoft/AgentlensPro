// Regenerates riskcosts-expected.json from the COMPILED src/mcpServer.ts — the parity oracle for
// get_cache_risk_costs / `reload-cost` (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-riskcosts-expected.mjs
//
// CLAUDE_CONFIG_DIR points at riskcost-home so BOTH transcript scanners (scanCacheRiskCommands and
// scanEffortTransitions) and listSessionFileIds resolve against committed fixtures rather than the
// real ~/.claude. The four .jsonl basenames ARE the file-backed session ids.
//
// MTIME ORACLE: `scanCacheRiskCommands` skips a file whose mtime predates `sinceMs`, and git does
// not preserve mtimes — so the table below is stamped here and PUBLISHED in the expected JSON; the
// Rust test re-stamps from that same table rather than keeping a second copy that can drift.
//
// What this pins, case by case:
//  - ONE TURN IS ONE COST. /reload-plugins (10:01:00) and /reload-skills (10:01:10) both land
//    before turn 2, so they broke the prefix ONCE, TOGETHER: only the EARLIEST is charged and the
//    other is listed at 0 with the reason. Charging both is the double-count that made the old
//    co-churn heuristic untrustworthy.
//  - A NON-BREAKING INVOCATION IS STILL LISTED, at 0, with "menu opened and closed" — bare /model
//    at 10:03 is followed by a turn that did not break. Dropping it would make "I ran this and it
//    cost nothing" indistinguishable from "no data".
//  - A command with NO turn at or after it is `turn: null` + "cost unattributable" — /login at
//    10:20 is past the last recorded turn.
//  - RESIDUE: turn 4 is a PLUGINS_RELOADED break that no command explains, so it goes in
//    `unexplainedReloadTurns` — reported separately and NEVER summed into the totals.
//  - EFFORT TRANSITIONS ARE A SECOND SOURCE. The 10:29→10:30 effort change types no command, so
//    `commandsFoundInTranscripts` does NOT count it — yet it still produces a row. And `kinds`
//    gates it: a kinds list without EFFORT_CHANGED skips the effort scan entirely.
//  - `windowHours: args.window ?? null` is NULLISH on the RAW arg while `sinceMs` is TRUTHY, so
//    `window: 0` ECHOES 0 and filters NOTHING. Unifying the two guards breaks one or the other.
//  - `scope ?? 'all'` is the TRIMMED value, so a blank workspace echoes "" and filters nothing.
//  - `byKind[].costUsd` is re-rounded to 4dp on EVERY accumulation, not once at the end.
//  - `eventsNote` / `unexplainedReloadTurns` / `unexplainedNote` / `note` are DROPPED when
//    undefined — their presence is itself information.
import { createRequire } from 'module'
import { writeFileSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
process.env.CLAUDE_CONFIG_DIR = dir + 'riskcost-home'
const slug = dir + 'riskcost-home/projects/proj-a/'

const { handleGetCacheRiskCosts: handle } = require('../../../../../out/test/mcpServer.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

// risk-old is stamped a month back so the mtime skip has something to skip.
const MTIMES = {
  'risk-a.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'risk-b.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'risk-c.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'risk-noreport.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'risk-old.jsonl': Date.parse('2026-07-01T00:00:00.000Z'),
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(slug + name, ms / 1000, ms / 1000)

const card = (id, ws, model, start) => ({
  sessionId: id, workspace: ws, model, startTime: start,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1,
})
const SESSIONS = [
  card('risk-a', '/w/alpha', 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
  card('risk-b', '/w/beta', 'claude-sonnet-5', '2026-08-01T10:00:00.000Z'),
  // The ONLY route to the "menu opened and closed" note — see its timeline below.
  card('risk-c', '/w/alpha', 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
  card('risk-old', '/w/alpha', 'claude-opus-5', '2026-07-01T09:00:00.000Z'),
  // Pooled and scanned, but its composition is null ⇒ never ANALYZED. The gap between
  // sessionsWithLog and sessionsAnalyzed is the diagnosis, so it has to be reachable.
  card('risk-noreport', '/w/alpha', 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
  // No command was typed here, so the predicate excludes it from `considered` entirely.
  card('no-cmd', '/w/alpha', 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
]

const src = (kind, label, tokens) => ({ label, kind, tokens, bytes: tokens * 4, count: 1 })
const tl = (turn, read, create, model, iso) => ({
  type: 'llm', turn, cacheReadTokens: read, cacheCreateTokens: create, inputTokens: 5, model, timestamp: iso,
})

const CATALOGS = [src('toolCatalog', 'tools', 800), src('agentCatalog', 'agents', 600)]
const TIMELINES = {
  'risk-a': [
    tl(1, 0, 5000, 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
    // Charged to /reload-plugins; /reload-skills is the already-charged sibling.
    tl(2, 1000, 9000, 'claude-opus-5', '2026-08-01T10:02:00.000Z'),
    // Identical sources ⇒ no break. Note it is therefore INVISIBLE to the join (see below).
    tl(3, 20_000, 100, 'claude-opus-5', '2026-08-01T10:04:00.000Z'),
    // A 2-catalog churn no command explains ⇒ RESIDUE.
    tl(4, 2000, 40_000, 'claude-opus-5', '2026-08-01T10:06:00.000Z'),
  ],
  // THE JOIN ONLY SEES BREAKING TURNS. `timed` filters on `tsMs !== undefined`, and `tsMs` is
  // written ONLY by the break path — a non-breaking turn carries no timestamp at all, so a command
  // followed by a quiet turn is billed against the NEXT turn that actually broke. That makes the
  // "menu opened and closed" note reachable ONLY through a turn that broke while wasting ZERO
  // tokens: here turn 2 switches model (a break) with cacheCreateTokens 0.
  'risk-c': [
    tl(1, 0, 5000, 'claude-opus-5', '2026-08-01T10:00:00.000Z'),
    tl(2, 5000, 0, 'claude-sonnet-5', '2026-08-01T10:02:00.000Z'),
  ],
  'risk-b': [
    tl(1, 0, 4000, 'claude-sonnet-5', '2026-08-01T10:00:00.000Z'),
    tl(2, 500, 7000, 'claude-sonnet-5', '2026-08-01T10:05:00.000Z'),
  ],
  'risk-old': [
    tl(1, 0, 4000, 'claude-opus-5', '2026-07-01T08:00:00.000Z'),
    tl(2, 500, 7000, 'claude-opus-5', '2026-07-01T09:30:00.000Z'),
  ],
  'risk-noreport': [tl(1, 0, 4000, 'claude-opus-5', '2026-08-01T10:00:00.000Z')],
}
const getTimeline = (id) => TIMELINES[id] ?? []

const COMPOSITIONS = {
  'risk-a': {
    sessionId: 'risk-a', estimated: true, truncated: false,
    turns: [
      { turn: 1, sources: [src('file', 'CLAUDE.md', 5000), ...CATALOGS] },
      { turn: 2, sources: [src('file', 'CLAUDE.md', 9000), ...CATALOGS] },
      { turn: 3, sources: [src('file', 'CLAUDE.md', 9000), ...CATALOGS] },
      { turn: 4, sources: [src('file', 'CLAUDE.md', 9000), src('toolCatalog', 'tools', 801), src('agentCatalog', 'agents', 601)] },
    ],
  },
  'risk-b': {
    sessionId: 'risk-b', estimated: true, truncated: false,
    turns: [{ turn: 1, sources: [src('file', 'CLAUDE.md', 3000)] }, { turn: 2, sources: [src('file', 'CLAUDE.md', 7000)] }],
  },
  'risk-old': {
    sessionId: 'risk-old', estimated: true, truncated: false,
    turns: [{ turn: 1, sources: [src('file', 'CLAUDE.md', 3000)] }, { turn: 2, sources: [src('file', 'CLAUDE.md', 7000)] }],
  },
  // IDENTICAL sources on both turns, so the only thing that can break turn 2 is the model switch —
  // which is what makes it `broke: true` with `wastedTokens: 0`.
  'risk-c': {
    sessionId: 'risk-c', estimated: true, truncated: false,
    turns: [{ turn: 1, sources: [src('file', 'CLAUDE.md', 3000)] }, { turn: 2, sources: [src('file', 'CLAUDE.md', 3000)] }],
  },
  // Deliberately absent ⇒ buildCacheBreakReport returns null.
}
const getComposition = async (id) => COMPOSITIONS[id] ?? null

const run = (args, comp = getComposition) => handle(SESSIONS, getTimeline, comp, args)

writeFileSync(dir + 'riskcosts-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  sessions: SESSIONS,
  timelines: TIMELINES,
  compositions: COMPOSITIONS,
  noAccessor: await run({}, null),
  all: await run({}),
  scoped: await run({ workspace: '/w/alpha' }),
  // TRIMMED echo: filters nothing, reports "" — not "all".
  blankScope: await run({ workspace: '   ' }),
  // TRUTHY sinceMs vs NULLISH windowHours: 0 echoes 0 and filters nothing.
  windowZero: await run({ window: 0 }),
  // 2h back from the frozen NOW (10:00Z) skips risk-old by mtime AND by startTime.
  window2h: await run({ window: 2 }),
  // kinds WITHOUT EFFORT_CHANGED ⇒ the effort scan is skipped entirely.
  kindsNoEffort: await run({ kinds: ['PLUGINS_RELOADED', 'SKILLS_RELOADED'] }),
  kindsWithEffort: await run({ kinds: ['EFFORT_CHANGED'] }),
  // An empty kinds array is FALSY-LENGTH ⇒ treated as "no filter", not "match nothing".
  kindsEmpty: await run({ kinds: [] }),
  // topN clamps to [1, 200]; 1 forces the eventsNote.
  topOne: await run({ topN: 1 }),
  topZeroClampsToOne: await run({ topN: 0 }),
  topHugeClampsTo200: await run({ topN: 9999 }),
  // minTokens gates only the BREAKS — the 0-cost rows stay listed.
  minTokensHigh: await run({ minTokens: 100_000 }),
  // A workspace nothing matches: no pool at all, and the note says why.
  noMatch: await run({ workspace: '/w/nowhere' }),
}, null, 2) + '\n')
console.log('wrote riskcosts-expected.json')
