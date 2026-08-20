// Regenerates inflation-expected.json from the COMPILED src/mcpServer.ts — the parity oracle for
// get_context_inflation_report (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-inflation-expected.mjs
//
// HOME/CLAUDE_CONFIG_DIR points at the EXISTING fixtures/claude-home so `listSessionFileIds`
// resolves against committed transcripts. Nothing is ADDED under claude-home/ — a new .jsonl there
// changes that set and breaks ctxcomposition_parity.
//
// What this pins:
//  - THE THIRD DOUBLE-GUARD VARIANT. `scope` is echoed as `args.workspace ?? 'all'` using the RAW,
//    UNTRIMMED arg, while the pool guard uses the TRIMMED value under a truthy test. So
//    `workspace: "   "` filters NOTHING and echoes "   " — not "all", and not "" (which is what
//    find_context_hogs does with the same input). Three call sites, three answers, one input.
//  - The pool matches a workspace PREFIX ONLY — no sessionId substring, unlike find_context_hogs —
//    and caps at 20, not 25. A shared hardcoded predicate silently over-matches here.
//  - `considered`/`withLog` DEFAULT TO 1 (not 0) on the single-session path.
//  - `runawaySources` needs BOTH halves: turnsPresent >= 5 AND peakTokens >= 1000. A huge one-off
//    paste is not a structural sink; a tiny per-turn injection is not worth moving. The fixture has
//    a decoy for each half.
//  - peakTokens folds with MAX across sessions while cumulative/turnsPresent SUM — mixing those up
//    turns a per-turn peak into a total.
//  - residentCost is SESSION-SCOPED ONLY: null on workspace scope, an explicit {message} for a
//    session with no history, and the full itemization otherwise. A silent null would read as
//    "nothing resident" rather than "not computed".
//  - `itemizedPct` is NULL when totalContextTokens is 0 — a 0% would claim nothing was itemized.
//  - Each topBlock is `{...b, drill}`, so `drill` appends LAST.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
process.env.CLAUDE_CONFIG_DIR = dir + 'claude-home'

const { handleGetContextInflationReport: handle } = require('../../../../../out/test/mcpServer.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const card = (id, ws) => ({
  sessionId: id, workspace: ws, model: 'claude-opus-5',
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1,
})
const SESSIONS = [
  card('comp-many', '/w/alpha'),
  card('comp-own', '/w/alpha'),
  card('comp-parent', '/w/beta'),
  card('no-log-here', '/w/alpha'),
]

const turn = (i, sources) => ({ turn: i, sources })
// CLAUDE.md: 6 turns × 5,000 → runaway (both halves). ponytail: 6 turns × 200 → fails the SIZE half.
// paste: 1 turn × 90,000 → fails the TURNS half. Both decoys must stay OUT of runawaySources.
const COMPOSITIONS = {
  'comp-many': { turns: [
    turn(1, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
    turn(2, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
    turn(3, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
    turn(4, [{ kind: 'file', label: 'CLAUDE.md', tokens: 9_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
    turn(5, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
    turn(6, [{ kind: 'userMsg', label: 'paste', tokens: 90_000 }, { kind: 'skill', label: 'ponytail', tokens: 200 }]),
  ] },
  'comp-own': { turns: [
    turn(1, [{ kind: 'file', label: 'CLAUDE.md', tokens: 4_000 }]),
    turn(2, [{ kind: 'tool', label: 'Bash', tokens: 300 }]),
  ] },
  'comp-parent': null,
}
const getComposition = async (id) => COMPOSITIONS[id] ?? null

const step = (t, o) => ({ turn: t, blocks: o.blocks ?? [], usage: o.usage })
const HISTORIES = {
  'comp-many': {
    sessionId: 'comp-many', truncated: false,
    steps: [
      // The usage shape is `{input, cacheRead, cacheCreate}` — NOT the `*Tokens` names used on
      // session cards. `input` already EXCLUDES the cache buckets here, so the per-turn context is
      // the sum of all three. Getting these names wrong makes the TS sum `undefined` into NaN
      // (serialized as null) while a `?? 0` port reads 0 — the divergence that caught this fixture.
      step(1, { blocks: [{ id: 'b1', kind: 'claudemd', label: 'CLAUDE.md', tokens: 5_000 }], usage: { input: 10, cacheRead: 6_000, cacheCreate: 0 } }),
      step(2, { blocks: [{ id: 'b1', kind: 'claudemd', label: 'CLAUDE.md', tokens: 5_000 }, { id: 'b2', kind: 'bashOutput', label: 'ps snapshot', tokens: 900 }], usage: { input: 5, cacheRead: 12_000, cacheCreate: 0 } }),
    ],
  },
  // A session whose history exists but has ZERO steps — the explicit {message} branch.
  'comp-own': { sessionId: 'comp-own', truncated: false, steps: [] },
}
const getHistory = async (id) => HISTORIES[id] ?? null

const run = (args) => handle(SESSIONS, getComposition, getHistory, args)

writeFileSync(dir + 'inflation-expected.json', JSON.stringify({
  sessions: SESSIONS,
  compositions: COMPOSITIONS,
  histories: HISTORIES,
  all: await run({}),
  scoped: await run({ workspace: '/w/alpha' }),
  // The third double-guard variant: filters nothing, echoes the RAW untrimmed value.
  blankScope: await run({ workspace: '   ' }),
  // A workspace that matches nothing, so the pool is empty but considered/withLog are honest.
  noMatch: await run({ workspace: '/w/nowhere' }),
  // Single session: considered/withLog default to 1, and residentCost is itemized.
  oneSession: await run({ sessionId: 'comp-many' }),
  // History exists but has no steps ⇒ the explicit {message}, not a silent null.
  oneNoSteps: await run({ sessionId: 'comp-own' }),
  // No composition at all ⇒ the early {sessionId, message} return.
  oneNoComposition: await run({ sessionId: 'comp-parent' }),
}, null, 2) + '\n')
console.log('wrote inflation-expected.json')
