// Regenerates sessionreports-expected.json from the COMPILED src/mcpServer.ts — the parity oracle
// for get_recent_sessions and get_workspace_patterns (TRDD-DMWOBWFH P4x.2c).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-sessionreports-expected.mjs
//
// TIME IS PINNED: both shapers read Date.now() (the `active` flag, the `days` cutoff), so a floating
// clock would make the oracle drift the moment it was regenerated on a different day.
//
// Discriminators the cases exist to pin:
//  - "recent" means recently ACTIVE, not recently STARTED. The `stale-start-live-now` card starts
//    oldest and is still emitting; it must rank FIRST. Live-confirmed as 4 actively-emitting
//    sessions missing from the default top-10 before this rank existed.
//  - `active` rides ONLY on live sessions — absent means idle, never `false`. A false would read as
//    a measurement on cards where nothing was measured.
//  - `limit` is `Math.min(x ?? 10, 50)` with NO low clamp, so a negative limit hits
//    Array.slice(0, -n), which drops the LAST n rows rather than returning none.
//  - the cache SLI averages ONLY cache-measured sessions and LABELS the exclusion; a junk row reads
//    0% and would drag the average toward 0 with no billing behind it.
//  - `avgCacheHitRate` and `errorRate` are STRINGS with a '%'; 'n/a' when nothing backs the first.
//  - `workspace` is accepted by get_workspace_patterns and NEVER USED — only `days` filters.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { handleGetRecentSessions, handleGetWorkspacePatterns, handleFindRelevantContext, handleGetEfficiencyReport } = require('../../../../../out/test/mcpServer.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = 1_760_000_000_000
const iso = (ms) => new Date(ms).toISOString()
const card = (o) => ({
  sessionId: o.sessionId, source: o.source ?? 'claude_code', model: o.model ?? 'claude-opus-5',
  startTime: o.startTime, durationMs: o.durationMs ?? 0,
  inputTokens: o.inputTokens ?? 0, outputTokens: o.outputTokens ?? 0,
  cacheReadTokens: o.cacheReadTokens ?? 0, cacheCreateTokens: o.cacheCreateTokens ?? 0,
  cacheHitRate: o.cacheHitRate ?? 0, totalLlmCalls: o.totalLlmCalls ?? 0, errors: o.errors ?? 0,
  userRequest: o.userRequest, workspace: o.workspace, toolCounts: o.toolCounts,
  loopSignals: o.loopSignals, filesRead: o.filesRead, filesChanged: o.filesChanged,
  tokensSource: o.tokensSource, coverageNote: o.coverageNote, title: o.title, entrypoint: o.entrypoint,
  outcome: o.outcome ?? 'ok', durationMin: undefined,
})

const sessions = [
  // Starts OLDEST but is still running — must rank FIRST on last-activity.
  card({ sessionId: 'stale-start-live-now', startTime: iso(NOW - 7_200_000), durationMs: 7_190_000,
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500_000, cacheCreateTokens: 60_000,
    cacheHitRate: 0.91, totalLlmCalls: 40, errors: 0,
    userRequest: 'refactor the loader so the deterministic tests stop flaking in src/logReader.ts ' + 'x'.repeat(200),
    toolCounts: { Bash: 30, Read: 20, Edit: 9, Grep: 4, Glob: 1 }, filesRead: ['a.ts', 'b.ts'],
    filesChanged: ['a.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts'], tokensSource: 'log',
    loopSignals: [{ type: 'repeated_tool' }, { type: 'no_progress' }], title: 'Long run', entrypoint: 'cli' }),
  // Started recently, already idle.
  card({ sessionId: 'fresh-but-idle', startTime: iso(NOW - 1_800_000), durationMs: 60_000,
    inputTokens: 500, outputTokens: 100, cacheReadTokens: 20_000, cacheCreateTokens: 5_000,
    cacheHitRate: 0.62, totalLlmCalls: 6, errors: 2, userRequest: 'parsing bug in src/logReader.ts loader',
    toolCounts: { Read: 5, Bash: 2 }, filesRead: ['a.ts'], filesChanged: ['h.ts'],
    tokensSource: 'otel', coverageNote: 'partial capture' }),
  // A JUNK row: zero calls, zero traffic. Excluded from the cache SLI, counted everywhere else.
  card({ sessionId: 'junk-zero', startTime: iso(NOW - 600_000), durationMs: 0, model: '', source: 'codex' }),
  // Old enough to fall outside a 1-day window.
  card({ sessionId: 'old-week', startTime: iso(NOW - 8 * 86_400_000), durationMs: 120_000,
    inputTokens: 300, outputTokens: 50, cacheReadTokens: 9_000, cacheHitRate: 0.4,
    totalLlmCalls: 3, model: 'claude-sonnet-5', source: 'copilot', toolCounts: { Read: 3 },
    filesRead: ['a.ts'], loopSignals: [{ type: 'repeated_tool' }] }),
  // Unparseable start date: `Date.parse() || 0` sorts it last and the days cutoff EXCLUDES it.
  card({ sessionId: 'bad-date', startTime: 'not-a-date', durationMs: 0, totalLlmCalls: 1, inputTokens: 10 }),
  // 20 days old: inside the default 30-day window but BEFORE its midpoint, so the efficiency
  // report's first half is non-empty and the trend is a real comparison rather than 'no data'.
  // A second session on the same agent/model pair is also what lifts it past the `n >= 2` bar that
  // keeps a single anecdote out of the ranking.
  card({ sessionId: 'first-half-20d', startTime: iso(NOW - 20 * 86_400_000), durationMs: 300_000,
    inputTokens: 2000, outputTokens: 400, cacheReadTokens: 100_000, cacheCreateTokens: 200_000,
    cacheHitRate: 0.33, totalLlmCalls: 12, errors: 1,
    userRequest: 'earlier attempt at the loader refactor with deterministic tests',
    toolCounts: { Bash: 10, Read: 4 }, filesRead: ['a.ts'], filesChanged: ['a.ts', 'b.ts'],
    loopSignals: [{ type: 'repeated_tool' }] }),
]

const recentCases = [
  { name: 'defaults', args: {} },
  { name: 'limit-2', args: { limit: 2 } },
  { name: 'limit-over-cap', args: { limit: 999 } },
  { name: 'limit-negative-drops-the-tail', args: { limit: -1 } },
  { name: 'limit-zero', args: { limit: 0 } },
  { name: 'agent-filter', args: { agent: 'copilot' } },
  { name: 'workspace-substring-on-id-or-prompt', args: { workspace: 'idle' } },
  { name: 'workspace-matches-nothing', args: { workspace: 'zzz' } },
]
// find_relevant_context: words of 3 chars or FEWER never match (they would hit every session), and
// `/`, `_`, `.` survive the blanking so a path stays ONE word instead of shattering into three.
const relevantCases = [
  { name: 'matches-by-word-overlap', args: { task: 'refactor the loader deterministic tests' } },
  { name: 'path-stays-one-word', args: { task: 'fix src/logReader.ts parsing' } },
  { name: 'short-words-only-is-refused', args: { task: 'do it now' } },
  { name: 'punctuation-is-blanked', args: { task: 'refactor!!! the... loader???' } },
  { name: 'no-match-is-an-honest-message', args: { task: 'quantum entanglement harmonics' } },
  { name: 'empty-task', args: { task: '' } },
]
// get_efficiency_report: the trend has a ±15% dead band, and `avgFirst === 0` is 'no data' rather
// than an infinite increase — with no first half there is no ratio to report.
const efficiencyCases = [
  { name: 'default-30-days', args: {} },
  { name: 'days-1', args: { days: 1 } },
  { name: 'days-90', args: { days: 90 } },
  { name: 'days-0-is-not-nullish-so-it-filters', args: { days: 0 } },
  { name: 'window-with-nothing-in-it', args: { days: 0.0001 } },
]
const patternCases = [
  { name: 'all', args: {} },
  { name: 'days-1', args: { days: 1 } },
  { name: 'days-30', args: { days: 30 } },
  { name: 'days-0-is-falsy-so-unfiltered', args: { days: 0 } },
  { name: 'workspace-arg-is-ignored', args: { workspace: '/nope' } },
  { name: 'days-filters-everything-out', args: { days: 0.0001 } },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
// Date.now() is read inside both shapers, so it is stubbed for the duration of the generation.
const realNow = Date.now
Date.now = () => NOW
try {
  writeFileSync(join(dir, 'sessionreports-expected.json'), JSON.stringify({
    nowMs: NOW,
    sessions: J(sessions),
    recentCases: J(recentCases),
    recentResults: recentCases.map(c => J(handleGetRecentSessions(sessions, c.args))),
    patternCases: J(patternCases),
    patternResults: patternCases.map(c => J(handleGetWorkspacePatterns(sessions, c.args))),
    relevantCases: J(relevantCases),
    relevantResults: relevantCases.map(c => J(handleFindRelevantContext(sessions, c.args))),
    efficiencyCases: J(efficiencyCases),
    efficiencyResults: efficiencyCases.map(c => J(handleGetEfficiencyReport(sessions, c.args))),
  }, null, 1) + '\n')
} finally {
  Date.now = realNow
}
console.log(`sessionreports-expected.json: ${recentCases.length} recent + ${patternCases.length} pattern cases`)
