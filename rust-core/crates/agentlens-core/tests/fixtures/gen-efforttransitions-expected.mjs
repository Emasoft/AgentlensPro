// Regenerates efforttransitions-expected.json from the COMPILED src/effortTransitions.ts — the
// parity oracle for the effort-transition detector (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-efforttransitions-expected.mjs
//
// MTIME ORACLE. `scanEffortTransitions` skips a file whose mtime predates `sinceMs`, and git does
// NOT preserve mtimes — a fresh clone would stamp every fixture with checkout time and the skip
// would never fire (or would fire on everything). So this generator STAMPS a fixed table with
// utimesSync and PUBLISHES it in the expected JSON; the Rust test re-stamps from that same table
// rather than hardcoding a second copy that can drift out of step with this one.
//
// What this pins:
//  - THE ABSENT-VALUE RULE. Only an EXPLICIT non-empty string `effort` is an observation. A record
//    predating CC 2.1.212 carries none, so absent→present is the FIELD APPEARING, not a change —
//    counting it would manufacture one false invalidation per session at the upgrade boundary.
//  - The first observation in a partition establishes the BASELINE and emits nothing.
//  - PARTITIONING by (session, sidechain). A subagent runs at its own effort and its records
//    interleave into the parent's transcript, so differencing across the boundary invents two
//    transitions per subagent that never happened. `isSidechain === true` is STRICT.
//  - TIME order, not FILE order. sess-resume.jsonl holds a record timestamped BETWEEN two records
//    of sess-main.jsonl, so file-order differencing yields the same COUNT with different from/to
//    values — a bug a length assertion cannot see.
//  - `model` is appended AFTER the object literal, so it lands LAST — and is DROPPED entirely when
//    the record carries none (or a non-string one).
//  - The two post-filters (sidechain, sinceMs) run AFTER the differencing, never before: dropping
//    records first would difference across the hole and report a transition between two turns that
//    were never adjacent.
//  - The `"effort"` substring gate skips a whole file before parsing any line of it.
import { createRequire } from 'module'
import { writeFileSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const root = dir + 'effort-home/projects'
const slug = root + '/proj-a/'

const {
  effortObservation, effortTransitionsOf, effortTransitionAsRiskCommand, scanEffortTransitions,
} = require('../../../../../out/test/effortTransitions.js')

// The mtime table. sess-old is stamped a month back so the mtime skip has something to skip.
const MTIMES = {
  'sess-main.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'sess-resume.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'sess-edge.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'sess-noeffort.jsonl': Date.parse('2026-08-01T11:00:00.000Z'),
  'sess-old.jsonl': Date.parse('2026-07-01T00:00:00.000Z'),
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(slug + name, ms / 1000, ms / 1000)

// ── effortObservation: one case per rejection reason ──────────────────────────
const OBS_CASES = {
  ok: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: 'xhigh', message: { model: 'claude-opus-5' } },
  okNoModel: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: 'xhigh' },
  okEmptyModel: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: 'xhigh', message: { model: '' } },
  notAssistant: { type: 'user', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: 'xhigh' },
  effortAbsent: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z' },
  effortEmpty: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: '' },
  effortNotString: { type: 'assistant', sessionId: 's', timestamp: '2026-08-01T10:00:00.000Z', effort: 3 },
  tsAbsent: { type: 'assistant', sessionId: 's', effort: 'xhigh' },
  tsNotString: { type: 'assistant', sessionId: 's', timestamp: 1754042400000, effort: 'xhigh' },
  tsUnparseable: { type: 'assistant', sessionId: 's', timestamp: 'not-a-date', effort: 'xhigh' },
}

// ── effortTransitionsOf: driven directly, so the pure half is pinned without the file walk ────
const rec = (o) => ({ entry: o, obs: effortObservation(o) })
const a = (session, min, effort, extra = {}) => rec({
  type: 'assistant', sessionId: session, timestamp: `2026-08-01T10:${String(min).padStart(2, '0')}:00.000Z`, effort, ...extra,
})
const PURE_CASES = {
  // A baseline plus two real changes; the first record emits nothing.
  simple: [a('s1', 0, 'xhigh'), a('s1', 1, 'xhigh'), a('s1', 2, 'low'), a('s1', 3, 'xhigh')],
  // Sidechain records are a SEPARATE partition — differencing across the boundary would invent
  // main→side and side→main transitions that never happened.
  sidechainPartitioned: [
    a('s1', 0, 'xhigh'), a('s1', 1, 'medium', { isSidechain: true }), a('s1', 2, 'high', { isSidechain: true }), a('s1', 3, 'xhigh'),
  ],
  // `isSidechain` must be STRICTLY true: a truthy non-boolean stays in the MAIN partition.
  sidechainTruthyIsNotTrue: [a('s1', 0, 'xhigh'), a('s1', 1, 'low', { isSidechain: 1 })],
  // A record with no sessionId is dropped before partitioning.
  noSession: [rec({ type: 'assistant', timestamp: '2026-08-01T10:00:00.000Z', effort: 'xhigh' }), a('s1', 1, 'low')],
  // Out-of-order input: the bucket sorts by TIME, so the emitted from/to pair differs from what
  // file-order differencing would produce — same count, different content.
  outOfOrder: [a('s1', 5, 'low'), a('s1', 0, 'xhigh'), a('s1', 3, 'medium')],
  // Two sessions interleaved: each partitions independently.
  twoSessions: [a('s1', 0, 'xhigh'), a('s2', 1, 'low'), a('s1', 2, 'low'), a('s2', 3, 'high')],
  empty: [],
}

const SINCE_MTIME_SKIP = Date.parse('2026-07-15T00:00:00.000Z')
const SINCE_POST_FILTER = Date.parse('2026-08-01T10:06:00.000Z')

const scan = (o) => scanEffortTransitions({ dirs: [root], ...o })

writeFileSync(dir + 'efforttransitions-expected.json', JSON.stringify({
  mtimes: MTIMES,
  sinceMtimeSkip: SINCE_MTIME_SKIP,
  sincePostFilter: SINCE_POST_FILTER,
  observations: Object.fromEntries(Object.entries(OBS_CASES).map(([k, v]) => [k, { entry: v, out: effortObservation(v) ?? null }])),
  pure: Object.fromEntries(Object.entries(PURE_CASES).map(([k, v]) => [k, {
    records: v.map(r => r.entry), out: effortTransitionsOf(v),
  }])),
  // The risk-command projection, including the model→args append and its absence.
  asRiskCommand: effortTransitionAsRiskCommand({ ts: 1, session: 's1', from: 'xhigh', to: 'low', sidechain: false, model: 'claude-opus-5' }),
  asRiskCommandNoModel: effortTransitionAsRiskCommand({ ts: 1, session: 's1', from: 'xhigh', to: 'low', sidechain: false }),
  // ── the file walk ──────────────────────────────────────────────────────────
  scanAll: scan({}),
  scanWithSidechain: scan({ includeSidechain: true }),
  // sess-old's mtime predates this, so the whole file is skipped before any parse.
  scanSinceMtimeSkip: scan({ sinceMs: SINCE_MTIME_SKIP }),
  // Every file passes the mtime gate, so this exercises the POST-differencing ts filter.
  scanSincePostFilter: scan({ sinceMs: SINCE_POST_FILTER }),
  scanLimited: scan({ limit: 2 }),
  scanSidechainAndLimit: scan({ includeSidechain: true, limit: 3 }),
}, null, 2) + '\n')
console.log('wrote efforttransitions-expected.json')
