// Regenerates feed-merge-expected.json from the COMPILED TS feedMergePolicy (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-feed-merge-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { mergeOtelAndLogSessions, linkSubagentTranscripts, graftOtelAttribution, stampIdentityMerge } =
  require('../../../../../out/test/feedMergePolicy.js')
const dir = new URL('.', import.meta.url).pathname

const card = (o) => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, timeline: [], ...o })
const otel = [
  card({ sessionId: 'claude-A', source: 'claude_code', dataSource: 'otel', inputTokens: 5 }),   // displaced by log
  card({ sessionId: 'codex-B', source: 'codex', dataSource: 'otel', inputTokens: 7 }),           // wins over log
  card({ sessionId: 'otel-only', source: 'copilot', dataSource: 'otel' }),
  card({ sessionId: 'claude-C', source: 'claude_code', dataSource: 'log', inputTokens: 1 }),      // a LOG card in the otel list (merge input shape)
]
const log = [
  card({ sessionId: 'claude-A', source: 'claude_code', dataSource: 'log', inputTokens: 900, coverageNote: 'stale-note' }),
  card({ sessionId: 'codex-B', source: 'codex', dataSource: 'log', inputTokens: 3 }),
  card({ sessionId: 'log-only', source: 'claude_code', dataSource: 'log', tokensSource: 'merged', coverageNote: 'old' }),
]
const merged = mergeOtelAndLogSessions(structuredClone(otel), structuredClone(log))
const mergedEmptyLog = mergeOtelAndLogSessions(structuredClone(otel), [])

const linkInput = [
  // placeholder + transcript with traffic → merged, spawnAsync lifts
  card({ sessionId: 'p1', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1', spawnAsync: true,
    spawnedByTurn: 3, spawnKind: 'async', spawnSubagentType: 'lean-worker', userRequest: 'from placeholder', model: 'claude-opus-5' }),
  card({ sessionId: 'agent-p1', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1', inputTokens: 100, outputTokens: 20,
    userRequest: '', model: '', workspace: '/w', mergedFrom: ['agent-p1', 'old'], spawnKind: 'transcript-says-sync', spawnIsolation: 'worktree' }),
  // placeholder + ZERO-traffic transcript, placeholder has no usage → merged, spawnAsync survives
  card({ sessionId: 'p2', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1', spawnAsync: true }),
  card({ sessionId: 'agent-p2', source: 'claude_code', dataSource: 'log' }),
  // placeholder WITH usage + zero-traffic transcript → left un-merged
  card({ sessionId: 'p3', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1', inputTokens: 50 }),
  card({ sessionId: 'agent-p3', source: 'claude_code', dataSource: 'log' }),
  // cross-parent mismatch → un-merged
  card({ sessionId: 'p4', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1' }),
  card({ sessionId: 'agent-p4', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-2', inputTokens: 9 }),
  // a second placeholder for an already-won transcript → ignored (first pair wins)
  card({ sessionId: 'p1', source: 'claude_code', dataSource: 'log', parentSessionId: 'parent-1', spawnKind: 'dup' }),
  // not a placeholder (no parent) / not log → untouched
  card({ sessionId: 'p5', source: 'claude_code', dataSource: 'log' }),
  card({ sessionId: 'p6', source: 'claude_code', dataSource: 'otel', parentSessionId: 'parent-1' }),
  card({ sessionId: 'agent-p6', source: 'claude_code', dataSource: 'log', inputTokens: 1 }),
]
const linked = linkSubagentTranscripts(structuredClone(linkInput))
const linkedNoop = linkSubagentTranscripts([card({ sessionId: 'x', source: 'codex', dataSource: 'otel' })])

const logTl = [
  { type: 'llm', spanId: 'l1', timestamp: '2025-08-19T10:00:01.000Z' },
  { type: 'api_request', spanId: 'r1', timestamp: '2025-08-19T10:00:02.000Z' },
  { type: 'tool', spanId: 't1' },
]
const otelTl = [
  { type: 'api_request', spanId: 'r1', timestamp: '2025-08-19T10:00:02.000Z' },  // dup → skipped
  { type: 'api_request', spanId: 'r2', timestamp: '2025-08-19T10:00:00.500Z' },  // sorts first
  { type: 'llm', spanId: 'l9', timestamp: '2025-08-19T09:00:00.000Z' },          // not api_request → ignored
]
const grafted = graftOtelAttribution(structuredClone(logTl), structuredClone(otelTl))
const graftedNone = graftOtelAttribution(structuredClone(logTl), [{ type: 'llm', spanId: 'z' }])
const graftedUndef = graftOtelAttribution(structuredClone(logTl), undefined)

const w1 = card({ sessionId: 'w', dataSource: 'otel', tokensSource: 'otel' })
stampIdentityMerge(w1, card({ sessionId: 'w', dataSource: 'log' }))
const w2 = card({ sessionId: 'w', dataSource: 'log', tokensSource: 'log', coverageNote: 'keep' })
stampIdentityMerge(w2, card({ sessionId: 'w', dataSource: 'log' }))

writeFileSync(dir + 'feed-merge-expected.json', JSON.stringify({
  otel, log, merged, mergedEmptyLog, linkInput, linked, linkedNoop, logTl, otelTl, grafted, graftedNone, graftedUndef,
  identityCross: w1, identitySame: w2,
}, null, 1) + '\n')
console.log('wrote feed-merge expectations:', merged.length, 'merged,', linked.length, 'linked')
