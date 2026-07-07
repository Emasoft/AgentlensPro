import * as assert from 'assert'
import {
  isCacheMeasured, buildScanCoverage,
  handleGetWorkspacePatterns, handleGetEfficiencyReport, handleFindContextHogs,
  HOG_SCAN_CAP,
} from '../mcpServer'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

// TRDD-ZK37VG4X specs 3+4 — SLI junk-row exclusion + bounded-scan sampling honesty.

function makeCard(id: string, overrides: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'log', workspace: '/ws',
    userRequest: 'test', model: 'claude-opus-4-8', turns: 1,
    inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 80_000, cacheCreateTokens: 5_000,
    cacheHitRate: 0.9, durationMs: 1000, startTime: new Date(Date.now() - 86_400_000).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 2, totalLlmCalls: 3, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
    ...overrides,
  }
}

// A junk row: no LLM calls, no tokens — the synthetic empties that all read 0% cache hit.
function junkCard(id: string): SessionSummaryCard {
  return makeCard(id, {
    model: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, totalLlmCalls: 0, totalToolCalls: 0, turns: 0,
  })
}

suite('isCacheMeasured — junk-row classifier (TRDD-ZK37VG4X spec 3)', () => {
  test('a session with LLM calls and token traffic is measured', () => {
    assert.strictEqual(isCacheMeasured(makeCard('a')), true)
  })

  test('a zero-token zero-LLM-call synthetic empty is NOT measured', () => {
    assert.strictEqual(isCacheMeasured(junkCard('b')), false)
  })

  test('token traffic without any LLM call is NOT measured (no prompt cache was exercised)', () => {
    assert.strictEqual(isCacheMeasured(makeCard('c', { totalLlmCalls: 0 })), false)
  })

  test('an LLM call recorded with zero tokens is NOT measured', () => {
    assert.strictEqual(isCacheMeasured(makeCard('d', {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    })), false)
  })
})

suite('cache-hit SLI excludes junk rows (TRDD-ZK37VG4X spec 3)', () => {
  const real1 = makeCard('r1', { cacheHitRate: 0.9 })
  const real2 = makeCard('r2', { cacheHitRate: 0.7 })
  const junk = [junkCard('j1'), junkCard('j2'), junkCard('j3')]

  test('get_workspace_patterns averages only measured sessions and labels the exclusion', () => {
    const out = handleGetWorkspacePatterns([real1, real2, ...junk], {}) as Record<string, unknown>
    // Diluted (pre-fix) value would be (0.9+0.7)/5 = 32%; measured-only is (0.9+0.7)/2 = 80%.
    assert.strictEqual(out.avgCacheHitRate, '80%')
    assert.strictEqual(out.cacheMeasuredSessions, 2)
    assert.strictEqual(out.cacheExcludedJunkSessions, 3)
  })

  test('get_workspace_patterns reports n/a when no session is cache-measured', () => {
    const out = handleGetWorkspacePatterns(junk, {}) as Record<string, unknown>
    assert.strictEqual(out.avgCacheHitRate, 'n/a')
    assert.strictEqual(out.cacheMeasuredSessions, 0)
  })

  test('get_efficiency_report cacheHealth averages only measured sessions and counts the excluded', () => {
    const out = handleGetEfficiencyReport([real1, real2, ...junk], {}) as {
      cacheHealth: { avgCacheHitRatePct: number | null; measuredSessions: number; excludedJunkSessions: number; worstSessions: { sessionId: string }[] }
    }
    assert.strictEqual(out.cacheHealth.avgCacheHitRatePct, 80)
    assert.strictEqual(out.cacheHealth.measuredSessions, 2)
    assert.strictEqual(out.cacheHealth.excludedJunkSessions, 3)
  })

  test('get_efficiency_report worstSessions is not monopolized by 0%-junk rows', () => {
    const out = handleGetEfficiencyReport([real1, real2, ...junk], {}) as {
      cacheHealth: { worstSessions: { sessionId: string }[] }
    }
    const ids = out.cacheHealth.worstSessions.map(w => w.sessionId)
    assert.ok(ids.every(id => id === 'r1' || id === 'r2'), `junk leaked into worstSessions: ${ids}`)
  })

  test('get_efficiency_report reports null SLI when nothing is measured (never a fake 0%)', () => {
    const out = handleGetEfficiencyReport(junk, {}) as {
      cacheHealth: { avgCacheHitRatePct: number | null; measuredSessions: number }
    }
    assert.strictEqual(out.cacheHealth.avgCacheHitRatePct, null)
    assert.strictEqual(out.cacheHealth.measuredSessions, 0)
  })
})

suite('buildScanCoverage — bounded scans state their sample (TRDD-ZK37VG4X spec 4)', () => {
  test('full coverage is marked complete and says so', () => {
    const c = buildScanCoverage(8, 5, 5, 25)
    assert.strictEqual(c.complete, true)
    assert.strictEqual(c.sessionsSkipped, 0)
    assert.ok(c.note.includes('Complete coverage'))
  })

  test('a capped scan is marked incomplete with an explicit skipped count and SAMPLE warning', () => {
    const c = buildScanCoverage(100, 60, 25, 25)
    assert.strictEqual(c.complete, false)
    assert.strictEqual(c.sessionsSkipped, 35)
    assert.strictEqual(c.scanCap, 25)
    assert.ok(c.note.includes('SAMPLE, not full coverage'))
    assert.ok(c.note.includes('35'))
  })

  test('zero log-backed sessions is complete-but-empty with a diagnosable note', () => {
    const c = buildScanCoverage(3, 0, 0, 25)
    assert.strictEqual(c.complete, true)
    assert.ok(c.note.includes('No log-backed sessions'))
  })
})

suite('find_context_hogs — sampling honesty in the response (TRDD-ZK37VG4X spec 4)', () => {
  test('response carries a coverage block with the scan cap and consistent counters', async () => {
    // Fake session ids are not on disk, so the file-backed pool is empty — the tool must still
    // report exactly what happened (3 considered, 0 with log, 0 scanned) instead of implying a scan.
    const sessions = [makeCard('h1'), makeCard('h2'), makeCard('h3')]
    const out = await handleFindContextHogs(sessions, async () => null, {}) as {
      coverage: { sessionsConsidered: number; sessionsWithLog: number; sessionsScanned: number; scanCap: number; complete: boolean; note: string }
      distinctSources: number; returnedHogs: number; hogsTruncated: boolean
    }
    assert.strictEqual(out.coverage.sessionsConsidered, 3)
    assert.strictEqual(out.coverage.sessionsWithLog, 0)
    assert.strictEqual(out.coverage.sessionsScanned, 0)
    assert.strictEqual(out.coverage.scanCap, HOG_SCAN_CAP)
    assert.strictEqual(typeof out.coverage.note, 'string')
    assert.strictEqual(out.hogsTruncated, false)
    assert.strictEqual(out.returnedHogs, 0)
  })

  test('missing composition accessor still fails loud with an error, not an empty leaderboard', async () => {
    const out = await handleFindContextHogs([makeCard('h4')], null, {}) as { error?: string }
    assert.ok(out.error, 'expected an explicit error')
  })
})
