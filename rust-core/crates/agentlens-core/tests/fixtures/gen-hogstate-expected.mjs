// Regenerates hogstate-expected.json from the COMPILED TS — the parity oracle for
// find_context_hogs, get_account_state_at, and the shared buildScanCoverage / resolveStateAt
// engines (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-hogstate-expected.mjs
//
// HOME/CLAUDE_CONFIG_DIR is pointed at the EXISTING fixtures/claude-home so `listSessionFileIds`
// resolves against committed transcripts instead of the developer's real ~/.claude. Nothing is
// added under claude-home/ — a new .jsonl there changes that set and breaks ctxcomposition_parity.
//
// What this pins:
//  - fileBackedPool separates "in scope" from "has a transcript ON DISK". A card with no local log
//    is counted in `sessionsConsidered` but never scanned, and the two numbers together are what
//    say whether a small pool means a narrow scope or a machine with no logs.
//  - A scope matches a workspace PREFIX **or** a sessionId SUBSTRING, so a bare id fragment works.
//  - An all-whitespace scope is NO scope (trim-then-truthy), not a scope that matches nothing.
//  - `Math.min(topN ?? 15, 50)` is an UPPER clamp only — a 0 returns nothing rather than flooring
//    to 1, and `hogsTruncated` is what tells the reader the list was cut.
//  - A session whose composition cannot be reconstructed is SKIPPED and is NOT counted as scanned;
//    buildScanCoverage then reports a SAMPLE rather than claiming complete coverage.
//  - buildScanCoverage emits three DIFFERENT notes — nothing-to-scan, complete, and SAMPLE. They are
//    three different facts, and collapsing them lets an empty result read as a clean bill of health.
//  - resolveStateAt returns the newest record at or BEFORE the query; a query before the timeline
//    starts is `state: null` WITH a note (a coverage gap), never an error and never "no account".
//  - The timeline reader drops a torn line and a record with a non-numeric `ts` individually — one
//    bad record must not discard the history around it.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const home = dir + 'claude-home'
process.env.CLAUDE_CONFIG_DIR = home
process.env.AGENTLENS_ACCOUNT_STATE_LOG = dir + 'acct-state.ndjson'

const { handleFindContextHogs, handleGetAccountStateAt, buildScanCoverage, HOG_SCAN_CAP } = require('../../../../../out/test/mcpServer.js')
const { readTimeline, resolveStateAt } = require('../../../../../out/test/accountStateTimeline.js')

const card = (id, ws) => ({
  sessionId: id, workspace: ws, model: 'claude-opus-5',
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 1,
})

// Three cards backed by real fixture transcripts, plus one that is in scope but has NO local log —
// the gap between sessionsConsidered and sessionsWithLog.
const SESSIONS = [
  card('comp-many', '/w/alpha'),
  card('comp-own', '/w/alpha'),
  card('comp-parent', '/w/beta'),
  card('no-log-here', '/w/alpha'),
]

// A deterministic stand-in for the real composition accessor. `comp-parent` returns null, so it is
// pooled and opened but NOT counted as scanned — which is exactly what turns coverage into a SAMPLE.
// A composition is turns × sources; aggregateComposition sums each source ACROSS the turns it
// persists in, which is the whole "turns × per-turn weight" inflation view. CLAUDE.md appears in
// both sessions AND in several turns of each, so `sessions` and `occurrences` must diverge — a port
// that conflated them would look right on a single-turn fixture.
const turn = (i, sources) => ({ turn: i, sources })
const COMPOSITIONS = {
  'comp-many': { turns: [
    turn(1, [{ kind: 'skill', label: 'ponytail', tokens: 1_000 }, { kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }]),
    turn(2, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }]),
    turn(3, [{ kind: 'skill', label: 'ponytail', tokens: 1_200 }, { kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }]),
  ] },
  'comp-own': { turns: [
    turn(1, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }, { kind: 'tool', label: 'Bash', tokens: 300 }]),
    turn(2, [{ kind: 'file', label: 'CLAUDE.md', tokens: 5_000 }]),
  ] },
  'comp-parent': null,
}
const getComposition = async (id) => COMPOSITIONS[id] ?? null

const hogs = async (args) => handleFindContextHogs(SESSIONS, getComposition, args)

const ISO = {
  before: '2026-07-31T20:33:20.000Z',   // predates the whole timeline
  first: '2026-07-31T23:20:00.000Z',    // exactly the first record's ts — `<=`, so it RESOLVES
  mid: '2026-08-01T00:43:20.000Z',      // between records 2 and 3
  last: '2026-08-01T02:20:00.000Z',
}

writeFileSync(dir + 'hogstate-expected.json', JSON.stringify({
  sessions: SESSIONS,
  compositions: COMPOSITIONS,
  hogScanCap: HOG_SCAN_CAP,
  isoCases: ISO,
  timeline: readTimeline(),
  hogsAll: await hogs({}),
  hogsScoped: await hogs({ scope: '/w/alpha' }),
  // A sessionId SUBSTRING is a valid scope too.
  hogsById: await hogs({ scope: 'comp-own' }),
  // Trim-then-truthy: whitespace is NO scope, so this must equal hogsAll.
  hogsBlankScope: await hogs({ scope: '   ' }),
  hogsTop1: await hogs({ topN: 1 }),
  // Upper clamp only — 0 returns nothing rather than flooring to 1.
  hogsTop0: await hogs({ topN: 0 }),
  hogsTop999: await hogs({ topN: 999 }),
  // A scope nothing matches: zero considered, zero with log, and the nothing-to-scan note.
  hogsNoMatch: await hogs({ scope: '/w/nowhere' }),
  coverageComplete: buildScanCoverage(3, 3, 3, 25),
  coverageEmpty: buildScanCoverage(4, 0, 0, 25),
  coverageSample: buildScanCoverage(40, 30, 25, 25),
  stateBefore: handleGetAccountStateAt({ iso: ISO.before }),
  stateFirst: handleGetAccountStateAt({ iso: ISO.first }),
  stateMid: handleGetAccountStateAt({ iso: ISO.mid }),
  stateLast: handleGetAccountStateAt({ iso: ISO.last }),
  // `ts` wins over `iso` when both are given.
  stateByTs: handleGetAccountStateAt({ ts: 1785547200000, iso: ISO.before }),
  stateBadArgs: handleGetAccountStateAt({}),
  stateBadIso: handleGetAccountStateAt({ iso: 'not-a-date' }),
  resolveMid: resolveStateAt(Date.parse(ISO.mid)),
  resolveBefore: resolveStateAt(Date.parse(ISO.before)),
}, null, 2) + '\n')
console.log('wrote hogstate-expected.json')
