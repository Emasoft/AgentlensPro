// Regenerates update-payload-expected.json from the COMPILED TS updatePayload module (the parity
// oracle) over the summarize fixture, with the clock PINNED. Run from the repo root AFTER
// `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-update-payload-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { summarizeSpans } = require('../../../../../out/test/spanSummarizer.js')
const { computeSidebarPayload, computeSidebarData, computeAnalyticsData } = require('../../../../../out/test/updatePayload.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'summarize-spans.json', 'utf8'))
// One span carries a receivedAt 5 s before "now" → isActive true; latest session has durationMs
// > 10 s so burnRate computes; the empty case pins the no-session literals (avg = 1, null).
const NOW = 1755600305000
spans[spans.length - 1].receivedAt = NOW - 5000
const summary = summarizeSpans(spans)
// Hand-crafted summary: a priced (claude-opus-5) newest session with durationMs > 10 s so
// burnRate + costUsd + the >1 turnInputTokens path are pinned, plus an unparseable-startTime
// card and a second day for the analytics bucketing/sort.
const crafted = { sessions: [
  { sessionId: 'a', source: 'claude_code', model: 'claude-opus-5', userRequest: 'prompt A', totalLlmCalls: 3, totalToolCalls: 2,
    errors: 1, cacheHitRate: 0.5, durationMs: 65000, startTime: '2025-08-20T10:00:00.000Z',
    inputTokens: 1200, outputTokens: 800, cacheReadTokens: 30000, cacheCreateTokens: 4000, filesChanged: ['/a.ts', '/b.ts'],
    timeline: [
      { type: 'llm', inputTokens: 100, cacheReadTokens: 1000, cacheCreateTokens: 0 },
      { type: 'tool', inputTokens: 999 },
      { type: 'llm', inputTokens: 0, cacheReadTokens: 0 },
      { type: 'llm', inputTokens: 50, cacheCreateTokens: 25 },
    ] },
  { sessionId: 'b', source: 'codex', model: 'gpt-5.2', userRequest: '', totalLlmCalls: 1, totalToolCalls: 0,
    errors: 0, cacheHitRate: 0.25, durationMs: 1000, startTime: '2025-08-18T09:00:00.000Z',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0, filesChanged: ['/b.ts'], timeline: [] },
  { sessionId: 'c', source: 'copilot', model: '', userRequest: 'x', totalLlmCalls: 0, totalToolCalls: 0,
    errors: 0, cacheHitRate: 0, durationMs: 0, startTime: '', inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreateTokens: 0, filesChanged: [], timeline: [] },
] }
const craftedSpans = [{ receivedAt: NOW - 1000 }, { receivedAt: 5 }, {}]
const expected = {
  nowMs: NOW,
  spans,
  crafted: {
    summary: crafted,
    spans: craftedSpans,
    sidebarPayload: computeSidebarPayload(crafted, craftedSpans, NOW),
    sidebarData: computeSidebarData(crafted, craftedSpans),
    analyticsData: computeAnalyticsData(crafted.sessions),
  },
  full: {
    sidebarPayload: computeSidebarPayload(summary, spans, NOW),
    sidebarData: computeSidebarData(summary, spans),
    analyticsData: computeAnalyticsData(summary.sessions),
  },
  empty: {
    sidebarPayload: computeSidebarPayload({ sessions: [] }, [], NOW),
    sidebarData: computeSidebarData({ sessions: [] }, []),
    analyticsData: computeAnalyticsData([]),
  },
}
writeFileSync(dir + 'update-payload-expected.json', JSON.stringify(expected, null, 1) + '\n')
console.log('wrote update-payload expectations over', summary.sessions.length, 'sessions')
