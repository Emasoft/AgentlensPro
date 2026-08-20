// Regenerates spawntree-expected.json from the COMPILED TS — the parity oracle for
// get_context_growth, get_subagent_tree and the shared spawnRollup engine (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-spawntree-expected.mjs
//
// The cards are synthetic and drive both engines directly — no disk, no server.
//
// What the fixture is built to discriminate:
//  - buildSpawnRollup counts an ABSENT or UNRECOGNIZED spawnKind as `unknown`, never `fresh`. A
//    mislabeled cold fork has to show up as unknown or the mix stops being evidence.
//  - FLEET-COLD is derived from the RECORDED BUCKETS, not from spawnKind: c3 is LABELLED `fork` yet
//    wrote 300k and read ~nothing, so it counts as cold. A spawnKind-based detector misses exactly
//    the case that matters (a fork that did not actually inherit the cache).
//  - The near-zero-read ratio is what separates cold from warm: c5 wrote 200k and READ 180k (a real
//    fork), so it must NOT be cold — otherwise every large child trips the detector.
//  - MODEL-MIX reads `spawnModelOverride || model` (falsy-or), and is DISABLED entirely when the
//    parent model is unknown — comparing against '' would flag every child.
//  - `asyncUnreportedChildren` is OMITTED when zero. Async children report zero buckets by data
//    ABSENCE, so a 0 there would read identically to "checked, none found".
//  - Σ cost is rounded ONCE over the set, not per child — per-child rounding compounds across a
//    large fan-out, which is the case this report exists for.
//  - get_subagent_tree always roots at the PARENT: querying a CHILD answers about the whole family.
//  - `note` is present ONLY when there are no children (`cond ? … : undefined` drops the key).
//  - handleGetContextGrowth returns a MESSAGE, not a zeroed report, when there is no turn data —
//    undiagnosable and measured-at-zero are different facts.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { handleGetSubagentTree, handleGetContextGrowth } = require('../../../../../out/test/mcpServer.js')
const { buildSpawnRollup, detectSpawnAntipatterns } = require('../../../../../out/test/shared/spawnRollup.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const card = (o) => ({
  sessionId: o.id, model: o.model ?? 'claude-opus-5', workspace: '/w/alpha',
  inputTokens: o.in ?? 0, outputTokens: o.out ?? 0,
  cacheReadTokens: o.read ?? 0, cacheCreateTokens: o.create ?? 0,
  turns: o.turns ?? 1, startTime: NOW - 3_600_000, lastActivity: NOW,
  ...o.extra,
})

// One parent and six children. c1/c2/c3 are cold (c3 is LABELLED fork but behaves cold);
// c4 is a worktree; c5 is a genuine warm fork; c6 is async on another model.
const SESSIONS = [
  card({ id: 'parent-1', in: 5_000, out: 2_000, read: 400_000, create: 20_000, turns: 40 }),
  card({ id: 'c1', in: 100, out: 50, read: 0, create: 300_000, extra: { parentSessionId: 'parent-1', spawnKind: 'fresh', spawnedByTurn: 12 } }),
  card({ id: 'c2', in: 100, out: 50, read: 1_000, create: 250_000, extra: { parentSessionId: 'parent-1', spawnKind: 'worktree', spawnIsolation: 'worktree', spawnedByTurn: 12 } }),
  card({ id: 'c3', in: 100, out: 50, read: 5_000, create: 300_000, extra: { parentSessionId: 'parent-1', spawnKind: 'fork', spawnedByTurn: 12 } }),
  card({ id: 'c4', in: 100, out: 50, read: 0, create: 180_000, extra: { parentSessionId: 'parent-1', spawnKind: 'worktree', spawnIsolation: 'worktree', spawnedByTurn: 13 } }),
  card({ id: 'c5', in: 100, out: 50, read: 180_000, create: 200_000, extra: { parentSessionId: 'parent-1', spawnKind: 'fork', spawnedByTurn: 14 } }),
  card({ id: 'c6', model: 'claude-sonnet-5', in: 0, out: 0, read: 0, create: 0, extra: { parentSessionId: 'parent-1', spawnAsync: true, spawnedByTurn: 15 } }),
  // A lone session with no family at all — the `note` branch.
  card({ id: 'solo-1', in: 10, out: 5, turns: 2 }),
]

// Two children on a DIFFERENT model with large prefixes — the MODEL-MIX shape, kept in its own set
// so it does not perturb the main rollup.
const MIXED = [
  card({ id: 'm1', model: 'claude-sonnet-5', create: 200_000, extra: { spawnKind: 'fresh' } }),
  card({ id: 'm2', create: 150_000, extra: { spawnKind: 'fresh', spawnModelOverride: 'claude-haiku-4-5' } }),
  // An EMPTY override must fall through to `model` (falsy-or), so this one matches the parent and
  // is NOT mixed — an `?? ` port would read '' as the model and flag it.
  card({ id: 'm3', create: 150_000, extra: { spawnKind: 'fresh', spawnModelOverride: '' } }),
]

// The MCP's normalizing pricer is not exported; the oracle injects a simple deterministic one and
// the Rust test injects the same, so the comparison is of the ROLLUP, not of two pricers.
const costOf = (c) => (c.inputTokens + c.outputTokens) / 1_000_000 * 5
  + c.cacheReadTokens / 1_000_000 * 0.5 + c.cacheCreateTokens / 1_000_000 * 6.25

const children = SESSIONS.filter(c => c.parentSessionId === 'parent-1')

const TIMELINE = [
  { turn: 1, inputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 50_000, outputTokens: 200 },
  { turn: 1, inputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 100 },
  { turn: 2, inputTokens: 20, cacheReadTokens: 50_000, cacheCreateTokens: 2_000, outputTokens: 300 },
  // A `background` entry is EXCLUDED from turn growth — it is not part of the conversation prefix.
  { turn: 2, type: 'background', inputTokens: 999_999, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0 },
  // No turn index → skipped entirely.
  { inputTokens: 777, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0 },
  { turn: 3, inputTokens: 10, cacheReadTokens: 120_000, cacheCreateTokens: 0, outputTokens: 50 },
]

writeFileSync(dir + 'spawntree-expected.json', JSON.stringify({
  nowMs: NOW,
  sessions: SESSIONS,
  mixed: MIXED,
  timeline: TIMELINE,
  rollup: buildSpawnRollup(children, { parentModel: 'claude-opus-5', costOf }),
  // No children at all: every total is 0, the mix is all zeros, detections empty — and
  // asyncUnreportedChildren is ABSENT.
  rollupEmpty: buildSpawnRollup([], { parentModel: 'claude-opus-5', costOf }),
  detectionsMixed: detectSpawnAntipatterns(MIXED, { parentModel: 'claude-opus-5', costOf }),
  // An UNKNOWN parent model disables MODEL-MIX entirely rather than flagging everything.
  detectionsNoParentModel: detectSpawnAntipatterns(MIXED, { parentModel: '', costOf }),
  tree: handleGetSubagentTree(SESSIONS, { sessionId: 'parent-1' }),
  // Querying a CHILD roots at the parent and returns the same family.
  treeFromChild: handleGetSubagentTree(SESSIONS, { sessionId: 'c1' }),
  treeSolo: handleGetSubagentTree(SESSIONS, { sessionId: 'solo-1' }),
  treeMissing: handleGetSubagentTree(SESSIONS, { sessionId: 'nope' }),
  growth: handleGetContextGrowth(SESSIONS[0], TIMELINE),
  growthEmpty: handleGetContextGrowth(SESSIONS[0], []),
}, null, 2) + '\n')
console.log('wrote spawntree-expected.json')
