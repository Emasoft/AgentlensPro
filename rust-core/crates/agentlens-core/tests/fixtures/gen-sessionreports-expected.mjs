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
const { handleGetRecentSessions, handleGetWorkspacePatterns, handleFindRelevantContext, handleGetEfficiencyReport, handleGetInstructionSuggestions, handleGetSessionDetail, buildCostRollup, predictSessionCost } = require('../../../../../out/test/mcpServer.js')
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
// get_instruction_suggestions needs its OWN session set — a workspace with >= 5 sessions — and it
// must NOT perturb the tables above, so it is a separate array rather than extra cards in `sessions`.
// The workspace is a path that does not exist, so `readAllInstructionContent` returns '' on BOTH
// engines and the oracle tests the advisor + the shaper rather than this machine's files.
const INSTR_WS = '/ws/instructions-fixture-does-not-exist'
const instrSessions = Array.from({ length: 6 }, (_, i) => card({
  sessionId: `instr-${i}`, startTime: iso(NOW - (i + 1) * 3_600_000), durationMs: 120_000,
  workspace: INSTR_WS, model: 'claude-opus-5',
  inputTokens: 500, outputTokens: 100, cacheReadTokens: 10_000, cacheCreateTokens: 40_000,
  // Deliberately BELOW the 0.8 target on every card, so the appended cache-efficiency suggestion
  // fires — it is the one suggestion this shaper adds itself rather than getting from the advisor.
  cacheHitRate: 0.2, totalLlmCalls: 8, errors: i % 2, userRequest: `task number ${i} in the fixture workspace`,
  toolCounts: { Bash: 20, Read: 15 }, filesRead: ['x.ts'], filesChanged: ['x.ts'],
  loopSignals: i < 4 ? [{ type: 'repeated_tool' }] : undefined,
}))
const instrCases = [
  { name: 'no-workspace-is-an-error', sessions: instrSessions, args: {} },
  { name: 'blank-workspace-is-an-error', sessions: instrSessions, args: { workspace: '   ' } },
  { name: 'too-little-history', sessions: instrSessions.slice(0, 3), args: { workspace: INSTR_WS } },
  { name: 'enough-history', sessions: instrSessions, args: { workspace: INSTR_WS } },
  { name: 'prefix-match-on-workspace', sessions: instrSessions, args: { workspace: '/ws/instructions' } },
  { name: 'unknown-workspace', sessions: instrSessions, args: { workspace: '/ws/nope' } },
]

// get_session_detail: driven with an explicit timeline + a synthetic composition, exercising the
// per-turn aggregation (background entries skipped), the ${kind}::${label} composition key, the
// sub-agent rollup (fork = warm; async = tokens unknown), and the generatedFiles dedupe.
const DETAIL_PARENT = card({ sessionId: 'detail-parent', startTime: iso(NOW - 3_600_000), durationMs: 3_500_000,
  inputTokens: 800, outputTokens: 150, cacheReadTokens: 60_000, cacheCreateTokens: 9_000,
  cacheHitRate: 0.87, totalLlmCalls: 4, errors: 1, userRequest: 'detail fixture prompt',
  workspace: '/ws/detail', toolCounts: { Bash: 3 }, filesRead: ['a.ts'], filesChanged: ['b.ts'],
  loopSignals: [{ type: 'repeated_tool' }] })
DETAIL_PARENT.outcome = 'partial'
DETAIL_PARENT.peakContextPerTurn = 70_000
DETAIL_PARENT.generatedFiles = [{ path: '/out/report.md', sizeBytes: 900, tokenEstimate: 220 }]
const forkChild = card({ sessionId: 'detail-fork', startTime: iso(NOW - 1_800_000), durationMs: 60_000,
  inputTokens: 50, outputTokens: 10, totalLlmCalls: 2 })
forkChild.parentSessionId = 'detail-parent'; forkChild.spawnKind = 'fork'; forkChild.spawnedByTurn = 2
const asyncChild = card({ sessionId: 'detail-async', startTime: iso(NOW - 1_700_000), durationMs: 0,
  inputTokens: 0, outputTokens: 0, totalLlmCalls: 0 })
asyncChild.parentSessionId = 'detail-parent'; asyncChild.spawnKind = 'fresh'; asyncChild.spawnAsync = true
asyncChild.spawnModelOverride = 'claude-sonnet-5'; asyncChild.spawnIsolation = 'worktree'
const detailSessions = [DETAIL_PARENT, forkChild, asyncChild]
const detailTimeline = [
  { type: 'llm', label: 'turn one', durationMs: 900, turn: 1, inputTokens: 100, cacheReadTokens: 10_000, cacheCreateTokens: 4_000, outputTokens: 40 },
  { type: 'tool', label: 'Bash', durationMs: 120, turn: 1, isError: true,
    generatedFiles: [{ path: '/out/big.json', sizeBytes: 5_000, tokenEstimate: 1_200 }, { path: '/out/report.md', sizeBytes: 1, tokenEstimate: 1 }] },
  { type: 'background', label: 'child tokens must NOT count', turn: 1, inputTokens: 999_999 },
  { type: 'llm', label: 'turn two', durationMs: 700, turn: 2, inputTokens: 200, cacheReadTokens: 50_000, cacheCreateTokens: 5_000, outputTokens: 110 },
  { type: 'note', label: 'no turn — skipped by growth, kept by the timeline head' },
]
const detailComposition = { turns: [
  { turn: 1, sources: [
    { label: 'CLAUDE.md', kind: 'claude_md', tokens: 30_000 },
    { label: 'a.ts', kind: 'file', tokens: 4_000 },
    { label: 'a.ts', kind: 'tool_result', tokens: 500 },   // same label, DIFFERENT kind → own row
  ] },
  { turn: 2, sources: [
    { label: 'CLAUDE.md', kind: 'claude_md', tokens: 30_000 },
    { label: 'a.ts', kind: 'file', tokens: 4_100 },
  ] },
] }
const detailCases = [
  { name: 'full', sessions: detailSessions, timeline: detailTimeline, composition: detailComposition, args: { sessionId: 'detail-parent' } },
  { name: 'no-composition', sessions: detailSessions, timeline: detailTimeline, composition: null, args: { sessionId: 'detail-parent' } },
  { name: 'no-children', sessions: [DETAIL_PARENT], timeline: detailTimeline, composition: null, args: { sessionId: 'detail-parent' } },
  { name: 'unknown-session', sessions: detailSessions, timeline: [], composition: null, args: { sessionId: 'ghost' } },
  { name: 'empty-timeline', sessions: detailSessions, timeline: [], composition: null, args: { sessionId: 'detail-parent' } },
]

// get_cost_rollup: session-granular OVERLAP semantics, the undated exclusion, and the unpriced
// exclusion. Cards reuse the detail set plus purpose-built ones.
const unpricedCard = card({ sessionId: 'roll-unpriced', startTime: iso(NOW - 7_200_000), durationMs: 600_000,
  inputTokens: 1_000, outputTokens: 200, totalLlmCalls: 3, workspace: '/ws/roll', model: 'mystery-model-x' })
unpricedCard.unpriced = true
unpricedCard.turns = 3
const spanningCard = card({ sessionId: 'roll-spans-window-edge', startTime: iso(NOW - 30 * 3_600_000), durationMs: 8 * 3_600_000,
  inputTokens: 5_000, outputTokens: 800, cacheReadTokens: 90_000, totalLlmCalls: 20, workspace: '/ws/roll', model: 'claude-opus-5' })
spanningCard.turns = 20
const rollSessions = [...detailSessions, unpricedCard, spanningCard,
  card({ sessionId: 'roll-undated', startTime: 'garbage', inputTokens: 7 })]
for (const s of rollSessions) { if (s.turns === undefined) s.turns = s.totalLlmCalls }
const rollupCases = [
  { name: 'default-24h-by-project', args: {} },
  { name: 'by-model', args: { groupBy: 'model' } },
  { name: 'by-session-carries-labels', args: { groupBy: 'session' } },
  { name: 'by-subagent-implicitly-filters', args: { groupBy: 'subagent' } },
  { name: 'by-all', args: { groupBy: 'all' } },
  { name: 'window-48h-catches-the-spanning-card', args: { windowHours: 48 } },
  // The spanning card STARTED 30h ago but RAN until 22h ago, so a 24h window still counts it —
  // overlap, not start-time membership.
  { name: 'overlap-not-start-membership', args: { windowHours: 24 } },
  { name: 'explicit-iso-window', args: { sinceIso: iso(NOW - 4 * 3_600_000), untilIso: iso(NOW - 1_800_000) } },
  { name: 'empty-window-is-an-error', args: { sinceIso: iso(NOW), untilIso: iso(NOW - 3_600_000) } },
  { name: 'bad-iso-is-an-error', args: { sinceIso: 'not-a-date' } },
  { name: 'subagents-only', args: { subagentsOnly: true } },
  { name: 'parent-filter', args: { parentSessionId: 'detail-parent' } },
  { name: 'live-only', args: { liveOnly: true } },
  { name: 'sort-by-total-top-1', args: { sortBy: 'total', topN: 1 } },
]

// predict_session_cost: the distribution over precedents, the 10x size band, the +0.5 type bonus,
// and the zero-precedent honesty. Cards need fileOps for the band and turns for the dist.
const predictSessions = [
  card({ sessionId: 'pred-close-match', startTime: iso(NOW - 3_600_000), durationMs: 300_000,
    inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 80_000, cacheCreateTokens: 30_000,
    cacheHitRate: 0.7, totalLlmCalls: 15, userRequest: 'review the parser module for correctness bugs' }),
  card({ sessionId: 'pred-typed-match', startTime: iso(NOW - 7_200_000), durationMs: 600_000,
    inputTokens: 4_000, outputTokens: 900, cacheReadTokens: 200_000, cacheCreateTokens: 90_000,
    cacheHitRate: 0.6, totalLlmCalls: 30, userRequest: 'review the loader and report bugs' }),
  card({ sessionId: 'pred-outside-band', startTime: iso(NOW - 10_800_000), durationMs: 900_000,
    inputTokens: 9_000, outputTokens: 2_000, cacheReadTokens: 900_000, cacheCreateTokens: 200_000,
    cacheHitRate: 0.5, totalLlmCalls: 60, userRequest: 'review everything in the whole parser codebase' }),
  card({ sessionId: 'pred-junk', startTime: iso(NOW - 1_000_000), durationMs: 0 }),  // zero traffic — excluded
  card({ sessionId: 'pred-unrelated', startTime: iso(NOW - 2_000_000), durationMs: 100_000,
    inputTokens: 100, outputTokens: 10, cacheReadTokens: 1_000, cacheHitRate: 0.9, totalLlmCalls: 2,
    userRequest: 'write documentation for the deploy pipeline' }),
]
predictSessions[1].spawnSubagentType = 'code-reviewer'
predictSessions[0].fileOps = [{ readBytes: 40_000 }, { readBytes: 10_000 }]
predictSessions[2].fileOps = [{ readBytes: 9_000_000 }]   // 180x the asked size — outside the band
for (const s of predictSessions) { s.turns = s.totalLlmCalls }
const predictCases = [
  { name: 'keyword-match', args: { task: 'review the parser for bugs' } },
  { name: 'type-bonus-reranks', args: { task: 'review the parser for bugs', subagentType: 'code-reviewer' } },
  { name: 'size-band-downweights', args: { task: 'review the parser for bugs', fileBytes: 50_000 } },
  { name: 'no-task-is-an-error', args: { task: '' } },
  { name: 'short-task-is-an-error', args: { task: 'ab' } },
  { name: 'no-keywords-is-an-error', args: { task: 'a b c !!' } },
  { name: 'no-precedent-is-matched-0', args: { task: 'quantum harmonics entanglement' } },
  { name: 'no-precedent-names-the-type-filter', args: { task: 'quantum harmonics', subagentType: 'ghost-type' } },
  { name: 'topK-floors-at-3', args: { task: 'review the parser for bugs', topK: 1 } },
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
    instrCases: J(instrCases),
    instrResults: instrCases.map(c => J(handleGetInstructionSuggestions(c.sessions, c.args))),
    detailCases: J(detailCases),
    detailResults: detailCases.map(c => J(handleGetSessionDetail(c.sessions, () => c.timeline, c.composition, c.args))),
    rollupSessions: J(rollSessions),
    rollupCases: J(rollupCases),
    rollupResults: rollupCases.map(c => J(buildCostRollup(rollSessions, c.args, NOW))),
    predictSessions: J(predictSessions),
    predictCases: J(predictCases),
    predictResults: predictCases.map(c => J(predictSessionCost(predictSessions, c.args))),
  }, null, 1) + '\n')
} finally {
  Date.now = realNow
}
console.log(`sessionreports-expected.json: ${recentCases.length} recent + ${patternCases.length} pattern cases`)
