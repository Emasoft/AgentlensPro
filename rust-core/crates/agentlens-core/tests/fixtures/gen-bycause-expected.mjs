// Regenerates bycause-expected.json from the COMPILED TS — the parity oracle for get_cost_by_cause
// and the shared tokensByCause engine (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-bycause-expected.mjs
//
// What the fixtures are built to discriminate:
//  - The unattributed bucket is PINNED LAST regardless of size, and it is the BIGGEST row here — so
//    a port that just sorts by totalTokens puts it first and the named causes vanish below it.
//  - Its LABEL differs by dimension: '(unattributed)' for querySource (genuinely unknown) versus
//    '(no skill)' etc. for the rest (absence MEANS not-caused-by-any-skill). One shared label would
//    assert ignorance where the data is actually definite.
//  - mcpTool keys as `server/tool`, so two same-named tools on DIFFERENT servers never merge; the
//    server half falls back to '?' rather than dropping a real chargeable cause.
//  - A call with no finite cost_usd sets costKnown:false on every row it touches — the row's cost is
//    a FLOOR, not a complete figure. `costComplete` and `costCalls` say so at the report level.
//  - The reconciliation remainder is SIGNED and never clamped: a NEGATIVE remainder (api_requests
//    exceeding the session totals) is a real ingestion-drift signal, and clamping hides it.
//  - A null sessionTotalTokens yields a NULL remainder, never 0 — "cannot compute" and "reconciles
//    perfectly" are opposite claims.
//  - `sessionId` / `sessionsScanned` are DECLARED in the literal but an undefined option DROPS the
//    key, and the two callers are mutually exclusive.
//  - The leaderboard windows and ranks by LAST ACTIVITY, not startTime: `stale-start` started long
//    ago but is active NOW and must be scanned, while `fresh-start` started recently and went quiet.
//  - Non-claude_code sessions are EXCLUDED from the scan but still counted in `considered`.
//  - `days` is clamped at BOTH ends (1..90) — unlike find_context_hogs' upper-only topN clamp.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { handleGetCostByCause } = require('../../../../../out/test/mcpServer.js')
const { buildTokensByCause, CAUSE_DIMENSIONS } = require('../../../../../out/test/shared/tokensByCause.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const req = (o) => ({
  type: 'api_request',
  timestamp: o.ts ?? '2026-08-01T11:00:00.000Z',
  inputTokens: o.in ?? 0, outputTokens: o.out ?? 0,
  cacheReadTokens: o.read ?? 0, cacheCreateTokens: o.create ?? 0,
  costUsd: o.cost,
  querySource: o.qs, agentName: o.agent, skillName: o.skill,
  pluginName: o.plugin, mcpServerName: o.server, mcpToolName: o.tool,
})

const TIMELINE = [
  // A non-api_request entry must be ignored entirely.
  { type: 'assistant', timestamp: '2026-08-01T11:00:00.000Z', inputTokens: 999_999, outputTokens: 999_999 },
  req({ qs: 'repl_main_thread', skill: 'ponytail', plugin: 'ponytail', in: 100, read: 50_000, create: 5_000, out: 200, cost: 0.1234 }),
  req({ qs: 'repl_main_thread', skill: 'ponytail', plugin: 'ponytail', in: 50, read: 40_000, out: 100, cost: 0.0500 }),
  req({ qs: 'agent', agent: 'explore', skill: 'tldr-code', plugin: 'tldr', in: 10, read: 8_000, out: 30, cost: 0.0100 }),
  // Two same-named tools on DIFFERENT servers — they must NOT merge.
  req({ qs: 'agent', server: 'srv-a', tool: 'search', in: 5, read: 1_000, out: 5, cost: 0.0020 }),
  req({ qs: 'agent', server: 'srv-b', tool: 'search', in: 5, read: 1_000, out: 5, cost: 0.0020 }),
  // A tool whose SERVER is unknown — keys as '?/orphan', still a chargeable cause.
  req({ qs: 'agent', tool: 'orphan', in: 3, read: 500, out: 3, cost: 0.0010 }),
  // NO querySource at all, and the BIGGEST call — so the pinned-last rule is unmissable.
  req({ in: 900, read: 700_000, create: 40_000, out: 1_200, cost: 4.5678 }),
  // A call with NO cost_usd — makes every row it touches a FLOOR (costKnown:false).
  req({ qs: 'compact', in: 20, read: 3_000, out: 40 }),
]

const card = (o) => ({
  sessionId: o.id, model: 'claude-opus-5', workspace: '/w/alpha', source: o.source ?? 'claude_code',
  inputTokens: o.in ?? 0, outputTokens: o.out ?? 0,
  cacheReadTokens: o.read ?? 0, cacheCreateTokens: o.create ?? 0,
  totalLlmCalls: 1, startTime: o.start, durationMs: 0,
  lastActivity: o.last, timeline: o.tl,
})

// last-activity vs start-time: `stale-start` started 30 days ago and is active NOW; `fresh-start`
// started an hour ago and went quiet 20 days ago (outside a 7d window).
const SESSIONS = [
  card({ id: 'stale-start', start: '2026-07-02T00:00:00.000Z', last: '2026-08-01T11:59:00.000Z', in: 1_088, read: 803_500, create: 45_000, out: 1_583, tl: TIMELINE }),
  card({ id: 'fresh-start', start: '2026-08-01T11:00:00.000Z', last: '2026-07-12T00:00:00.000Z', in: 10, read: 20, out: 5, tl: [] }),
  card({ id: 'not-cc', source: 'codex', start: '2026-08-01T11:30:00.000Z', last: '2026-08-01T11:55:00.000Z', in: 7, out: 2, tl: [] }),
]
const getTimeline = (id) => (SESSIONS.find(s => s.sessionId === id)?.timeline) ?? []

writeFileSync(dir + 'bycause-expected.json', JSON.stringify({
  nowMs: NOW,
  dimensions: CAUSE_DIMENSIONS,
  timeline: TIMELINE,
  sessions: SESSIONS,
  // The engine, driven directly — three option shapes.
  engineFull: buildTokensByCause(TIMELINE, { sessionId: 'stale-start', sessionTotalTokens: 851_171 }),
  // A NEGATIVE remainder: api_requests exceed the supplied total. Signed, never clamped.
  engineNegative: buildTokensByCause(TIMELINE, { sessionId: 'stale-start', sessionTotalTokens: 1_000 }),
  // No ground truth ⇒ remainder NULL, not 0. And no sessionId ⇒ the key DROPS.
  engineNoTotal: buildTokensByCause(TIMELINE, {}),
  engineEmpty: buildTokensByCause([], { sessionsScanned: 0, sessionTotalTokens: 0 }),
  // The remainder===0 branch — the total is the measured attributedTotalTokens, so this is the ONLY
  // case that says "fully reconcile". Guessing the number leaves that branch untested (the first
  // attempt was off by 1,005 and silently took the signed-remainder branch instead).
  engineExact: buildTokensByCause(TIMELINE, { sessionTotalTokens: 851_176 }),
  // The tool: one session, then the leaderboard.
  toolOne: await handleGetCostByCause(SESSIONS, getTimeline, { sessionId: 'stale-start' }),
  toolMissing: await handleGetCostByCause(SESSIONS, getTimeline, { sessionId: 'nope' }),
  toolWindow: await handleGetCostByCause(SESSIONS, getTimeline, {}),
  toolWindow90: await handleGetCostByCause(SESSIONS, getTimeline, { days: 90 }),
  // days clamps at BOTH ends.
  toolDays0: await handleGetCostByCause(SESSIONS, getTimeline, { days: 0 }),
  toolDays999: await handleGetCostByCause(SESSIONS, getTimeline, { days: 999 }),
}, null, 2) + '\n')
console.log('wrote bycause-expected.json')
