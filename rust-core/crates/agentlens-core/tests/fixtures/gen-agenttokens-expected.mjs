// Regenerates agenttokens-expected.json from the COMPILED src/mcpServer.ts — the parity oracle for
// get_agent_tokens (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-agenttokens-expected.mjs
//
// THE MATCH ORDER IS THE WHOLE CORRECTNESS ARGUMENT, and the fixture is built to break a naive one:
//  - A spawn PLACEHOLDER's sessionId IS the bare agent id BY CONSTRUCTION, so an un-merged
//    placeholder + `agent-<id>` transcript pair both live in the equivalence class. A port that
//    lets exact sessionId equality take BLANKET precedence answers a bare-id query with the
//    ZERO-BUCKET placeholder and serves it over the real totals — a guess dressed as precision.
//    Here `dup-1` is that pair: the placeholder carries zeros, `agent-dup-1` carries the real ones.
//  - Exact equality IS trusted as a TIE-BREAK, but only when the query carries the distinguishing
//    `agent-<id>` form (`qLower !== qBare`) — which names exactly one card of the pair.
//  - Otherwise ambiguity is REPORTED with candidates, never resolved by guessing.
//  - parentSessionId scopes the lookup; an id that exists but not under that parent gets an error
//    that SHOWS where it does live, not a bare not-found that sends the caller hunting a typo.
//  - A card with NO parent (a full-sessionId query for a top-level session) has spawnKind null, NOT
//    'fresh' — it was never spawned at all.
//  - `lastSeenAt` derives from the card's OWN span (start + duration); an unparseable start yields
//    null, never a fabricated now().
//  - `turns` is null (not 0) when totalLlmCalls is 0 — "no turns recorded" is not "0 turns".
//  - ccDisplayEquivalent derives lastTurnContextRead most→least authoritative: statusline overlay,
//    then the last usage-carrying timeline entry, then a single-turn card's cumulative figure, then
//    NULL. A multi-turn card with no per-turn data cannot honestly answer.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { handleGetAgentTokens } = require('../../../../../out/test/mcpServer.js')
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
  totalLlmCalls: o.calls ?? 1,
  startTime: o.start ?? '2026-08-01T10:00:00.000Z',
  durationMs: o.dur ?? 60_000,
  lastActivity: NOW,
  ...o.extra,
})

const SESSIONS = [
  // A top-level session: no parent, so spawnKind is NULL, not 'fresh'.
  card({ id: 'root-1', in: 5_000, out: 2_000, read: 400_000, create: 20_000, calls: 40 }),
  // A plain fork child.
  card({ id: 'agent-fork-1', in: 100, out: 50, read: 180_000, create: 2_000, calls: 6,
         extra: { parentSessionId: 'root-1', spawnKind: 'fork', spawnedByTurn: 12, spawnSubagentType: 'fork', tokensSource: 'transcript' } }),
  // THE TRAP: an un-merged placeholder + transcript pair for the SAME agent id.
  // The placeholder's sessionId IS the bare id and carries ZERO buckets.
  card({ id: 'dup-1', in: 0, out: 0, read: 0, create: 0, calls: 0, start: '',
         extra: { parentSessionId: 'root-1', spawnAsync: true, spawnedByTurn: 20 } }),
  card({ id: 'agent-dup-1', in: 900, out: 400, read: 250_000, create: 90_000, calls: 9,
         extra: { parentSessionId: 'root-1', spawnKind: 'fresh', spawnedByTurn: 20, coverageNote: 'partial transcript' } }),
  // Same bare id under a DIFFERENT parent — makes parentSessionId scoping meaningful.
  card({ id: 'agent-multi', in: 10, out: 5, calls: 2, extra: { parentSessionId: 'root-1', spawnKind: 'fresh' } }),
  card({ id: 'multi', in: 20, out: 7, calls: 3, extra: { parentSessionId: 'other-root', spawnKind: 'worktree', spawnIsolation: 'worktree', spawnModelOverride: 'claude-sonnet-5' } }),
  // A statusline-bearing card: the MOST authoritative lastTurnContextRead source.
  card({ id: 'agent-sl-1', in: 1, out: 1, read: 5, calls: 3,
         extra: { parentSessionId: 'root-1', spawnKind: 'fork', statusline: { lastTotalInputTokens: 123_456 } } }),
  // A multi-turn card with NO timeline and no statusline — lastTurnContextRead must be NULL.
  card({ id: 'agent-blind', in: 7, out: 3, read: 11, calls: 5, extra: { parentSessionId: 'root-1', spawnKind: 'fresh' } }),
]

const TIMELINES = {
  'agent-fork-1': [
    { turn: 1, inputTokens: 2, cacheReadTokens: 180_000, cacheCreateTokens: 0, outputTokens: 10 },
    // A zero-usage trailing entry must be SKIPPED, not taken as the last read.
    { turn: 2, inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 0 },
  ],
}
const getTimeline = (id) => TIMELINES[id] ?? []

const run = (args) => handleGetAgentTokens(SESSIONS, getTimeline, args)

writeFileSync(dir + 'agenttokens-expected.json', JSON.stringify({
  nowMs: NOW,
  sessions: SESSIONS,
  timelines: TIMELINES,
  fork: run({ agentId: 'fork-1' }),
  forkPrefixed: run({ agentId: 'agent-fork-1' }),
  forkUpper: run({ agentId: 'FORK-1' }),
  root: run({ agentId: 'root-1' }),
  // The bare-id query on the placeholder pair is AMBIGUOUS — it must NOT silently serve the
  // zero-bucket placeholder.
  dupBare: run({ agentId: 'dup-1' }),
  // The agent-<id> form is the distinguishing one, so the tie-break resolves it to the real card.
  dupPrefixed: run({ agentId: 'agent-dup-1' }),
  multiScoped: run({ agentId: 'multi', parentSessionId: 'other-root' }),
  multiWrongParent: run({ agentId: 'fork-1', parentSessionId: 'nobody' }),
  statusline: run({ agentId: 'sl-1' }),
  blind: run({ agentId: 'blind' }),
  missing: run({ agentId: 'nope' }),
  blank: run({ agentId: '   ' }),
  noArg: run({}),
}, null, 2) + '\n')
console.log('wrote agenttokens-expected.json')
