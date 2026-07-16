import * as assert from 'assert'
import { buildTokensByCause, CAUSE_DIMENSIONS } from '../shared/tokensByCause'
import { handleGetCostByCause, CAUSE_SCAN_CAP } from '../mcpServer'
import type { SessionSummaryCard, TimelineEntry, TokensByCauseReport, CauseDimensionRollup } from '../shared/summarizerTypes'

// TRDD-UBEP5XY7 — tokens-by-CAUSE attribution rollup. Fixtures are api_request timeline entries as
// the R-I rich-event ingestion (7612ff5) produces them: per-call usage buckets + exact cost_usd +
// the cause fields (querySource / agent / skill / plugin / mcp server+tool).

function apiReq(o: {
  input?: number; output?: number; read?: number; create?: number; cost?: number
  querySource?: string; agent?: string; skill?: string; plugin?: string; mcpServer?: string; mcpTool?: string
}): TimelineEntry {
  return {
    type: 'api_request', spanId: 'sp-' + Math.random().toString(36).slice(2), label: 'api_request',
    inputTokens: o.input, outputTokens: o.output, cacheReadTokens: o.read, cacheCreateTokens: o.create,
    costUsd: o.cost, querySource: o.querySource, agentName: o.agent, skillName: o.skill,
    pluginName: o.plugin, mcpServerName: o.mcpServer, mcpToolName: o.mcpTool,
    durationMs: 100, isError: false, timestamp: new Date().toISOString(),
  }
}

function dimOf(r: TokensByCauseReport, d: string): CauseDimensionRollup {
  const dim = r.dimensions.find(x => x.dimension === d)
  assert.ok(dim, `dimension ${d} missing`)
  return dim!
}

suite('buildTokensByCause — per-dimension grouping (TRDD-UBEP5XY7)', () => {
  test('groups calls by agent and sums the 4 buckets + exact cost, ranked heaviest-first', () => {
    const tl = [
      apiReq({ input: 100, output: 50, read: 1000, create: 200, cost: 0.01, querySource: 'repl_main_thread', agent: 'small' }),
      apiReq({ input: 500, output: 100, read: 9000, create: 400, cost: 0.05, querySource: 'sub', agent: 'big' }),
      apiReq({ input: 500, output: 100, read: 9000, create: 400, cost: 0.05, querySource: 'sub', agent: 'big' }),
    ]
    const r = buildTokensByCause(tl, { sessionId: 's1' })
    const agents = dimOf(r, 'agent')
    assert.strictEqual(agents.rows.length, 2)
    assert.strictEqual(agents.rows[0].key, 'big')          // 20,000 tok — heaviest first
    assert.strictEqual(agents.rows[0].calls, 2)
    assert.strictEqual(agents.rows[0].inputTokens, 1000)
    assert.strictEqual(agents.rows[0].cacheReadTokens, 18000)
    assert.strictEqual(agents.rows[0].totalTokens, 1000 + 200 + 18000 + 800)
    assert.strictEqual(agents.rows[0].costUsd, 0.1)
    assert.strictEqual(agents.rows[0].costKnown, true)
    assert.strictEqual(agents.rows[1].key, 'small')
    assert.strictEqual(r.hasAttribution, true)
    assert.strictEqual(r.estimated, false)                 // ground truth, never an estimate
  })

  test('every cause dimension is present in canonical order', () => {
    const r = buildTokensByCause([apiReq({ input: 1, querySource: 'x' })])
    assert.deepStrictEqual(r.dimensions.map(d => d.dimension), CAUSE_DIMENSIONS)
  })

  test('mcpTool keys as server/tool so same-named tools on different servers never merge', () => {
    const tl = [
      apiReq({ input: 10, mcpServer: 'a', mcpTool: 'search' }),
      apiReq({ input: 20, mcpServer: 'b', mcpTool: 'search' }),
    ]
    const tools = dimOf(buildTokensByCause(tl), 'mcpTool')
    const named = tools.rows.filter(x => !x.unattributed)
    assert.deepStrictEqual(named.map(x => x.key).sort(), ['a/search', 'b/search'])
  })
})

suite('buildTokensByCause — unattributed bucket honesty (FAIL-FAST)', () => {
  test('calls with no value for a dimension land in an explicit pinned-last bucket, never dropped', () => {
    const tl = [
      apiReq({ input: 5, skill: 'commit' }),
      apiReq({ input: 1_000_000 }),   // huge but skill-less: must NOT vanish or outrank by pinning
    ]
    const skills = dimOf(buildTokensByCause(tl), 'skill')
    assert.strictEqual(skills.rows.length, 2)
    assert.strictEqual(skills.rows[0].key, 'commit')                 // named first
    const un = skills.rows[1]
    assert.strictEqual(un.unattributed, true)                        // pinned LAST despite being heavier
    assert.strictEqual(un.key, '(no skill)')
    assert.strictEqual(un.calls, 1)
    assert.strictEqual(un.inputTokens, 1_000_000)
    assert.strictEqual(skills.attributedCalls, 1)
    assert.strictEqual(skills.unattributedCalls, 1)
  })

  test('a call missing cost_usd flags the row cost as a floor (costKnown false), never silently understates', () => {
    const tl = [
      apiReq({ input: 10, cost: 0.02, agent: 'a' }),
      apiReq({ input: 10, agent: 'a' }),                             // no cost_usd
    ]
    const r = buildTokensByCause(tl)
    const row = dimOf(r, 'agent').rows[0]
    assert.strictEqual(row.costUsd, 0.02)
    assert.strictEqual(row.costKnown, false)
    assert.strictEqual(r.reconciliation.costComplete, false)
    assert.strictEqual(r.reconciliation.costCalls, 1)
  })
})

suite('buildTokensByCause — reconciliation vs session totals', () => {
  test('signed remainder = session total − attributed total; never clamped', () => {
    const tl = [apiReq({ input: 100, output: 50, read: 800, create: 50, cost: 0.01, querySource: 'q' })]
    const r = buildTokensByCause(tl, { sessionTotalTokens: 1500 })
    assert.strictEqual(r.reconciliation.attributedTotalTokens, 1000)
    assert.strictEqual(r.reconciliation.unattributedTotalTokens, 500)
    // Negative remainder (api_requests exceed the session buckets) stays signed:
    const r2 = buildTokensByCause(tl, { sessionTotalTokens: 900 })
    assert.strictEqual(r2.reconciliation.unattributedTotalTokens, -100)
  })

  test('remainder is null (not 0) when no ground-truth total is supplied — never fabricated', () => {
    const r = buildTokensByCause([apiReq({ input: 1, querySource: 'q' })])
    assert.strictEqual(r.reconciliation.sessionTotalTokens, null)
    assert.strictEqual(r.reconciliation.unattributedTotalTokens, null)
  })

  test('empty timeline → hasAttribution false with an explanatory note', () => {
    const r = buildTokensByCause([])
    assert.strictEqual(r.hasAttribution, false)
    assert.strictEqual(r.apiRequestCalls, 0)
    assert.ok(/api_request/.test(r.note))
  })

  test('non-api_request entries are ignored (llm/tool spans are counted by the spans, not here)', () => {
    const llm: TimelineEntry = { type: 'llm', spanId: 'x', label: 'llm', inputTokens: 999, durationMs: 1, isError: false, timestamp: '' }
    const r = buildTokensByCause([llm, apiReq({ input: 10, querySource: 'q' })])
    assert.strictEqual(r.apiRequestCalls, 1)
    assert.strictEqual(r.reconciliation.attributedInputTokens, 10)
  })
})

// ── MCP handler — get_cost_by_cause ───────────────────────────────────────────

function card(id: string, o: { start?: string; source?: SessionSummaryCard['source']; timeline?: TimelineEntry[]; input?: number; output?: number; read?: number; create?: number } = {}): SessionSummaryCard {
  return {
    sessionId: id, traceId: 't-' + id, source: o.source ?? 'claude_code', dataSource: 'otel',
    workspace: '/ws', userRequest: 'req', model: 'claude-opus-4-8', turns: 1,
    inputTokens: o.input ?? 0, outputTokens: o.output ?? 0,
    cacheReadTokens: o.read ?? 0, cacheCreateTokens: o.create ?? 0,
    cacheHitRate: 0, durationMs: 1000, startTime: o.start ?? new Date().toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: o.timeline ?? [], backgroundSpans: [], loopSignals: [],
  }
}

suite('handleGetCostByCause — MCP tool (TRDD-UBEP5XY7)', () => {
  test('session mode returns the rollup reconciled against the normalized session totals', async () => {
    const tl = [apiReq({ input: 100, output: 50, read: 800, create: 50, cost: 0.02, querySource: 'repl_main_thread' })]
    // inputTokens is RAW on every card (four disjoint buckets): total = 150+800+50+50 = 1050.
    const s = card('s1', { timeline: tl, input: 150, output: 50, read: 800, create: 50 })
    const r = await handleGetCostByCause([s], null, { sessionId: 's1' }) as TokensByCauseReport
    assert.strictEqual(r.sessionId, 's1')
    assert.strictEqual(r.reconciliation.sessionTotalTokens, 1050)
    assert.strictEqual(r.reconciliation.attributedTotalTokens, 1000)
    assert.strictEqual(r.reconciliation.unattributedTotalTokens, 50)
    assert.strictEqual(dimOf(r, 'querySource').rows[0].key, 'repl_main_thread')
  })

  test('unknown session returns an explicit error', async () => {
    const r = await handleGetCostByCause([], null, { sessionId: 'nope' }) as { error?: string }
    assert.ok(r.error && /not found/.test(r.error))
  })

  test('leaderboard mode aggregates across sessions with an honest coverage block', async () => {
    const now = Date.now()
    const recent = (h: number) => new Date(now - h * 3600_000).toISOString()
    const sessions = [
      card('a', { start: recent(1), timeline: [apiReq({ input: 10, cost: 0.01, skill: 'commit' })], input: 10 }),
      card('b', { start: recent(2), timeline: [apiReq({ input: 20, cost: 0.02, skill: 'commit' })], input: 20 }),
      // A codex session in the window: considered but NOT scanned (api_request is CC-specific).
      card('c', { start: recent(3), source: 'codex' }),
      // Outside the 7d window: not even considered.
      card('d', { start: new Date(now - 30 * 24 * 3600_000).toISOString() }),
    ]
    const r = await handleGetCostByCause(sessions, null, {}) as TokensByCauseReport & { days: number; coverage: { sessionsConsidered: number; claudeCodeSessions: number; sessionsScanned: number; complete: boolean; scanCap: number } }
    assert.strictEqual(r.days, 7)
    assert.strictEqual(r.coverage.sessionsConsidered, 3)
    assert.strictEqual(r.coverage.claudeCodeSessions, 2)
    assert.strictEqual(r.coverage.sessionsScanned, 2)
    assert.strictEqual(r.coverage.complete, true)
    assert.strictEqual(r.coverage.scanCap, CAUSE_SCAN_CAP)
    assert.strictEqual(r.sessionsScanned, 2)
    const skill = dimOf(r, 'skill').rows[0]
    assert.strictEqual(skill.key, 'commit')
    assert.strictEqual(skill.calls, 2)
    assert.strictEqual(skill.inputTokens, 30)
    assert.strictEqual(skill.costUsd, 0.03)
  })

  test('leaderboard caps the scan at the most-recent CC sessions and says so (coverage.complete false)', async () => {
    const now = Date.now()
    const sessions = Array.from({ length: CAUSE_SCAN_CAP + 5 }, (_, i) =>
      card('s' + i, { start: new Date(now - i * 60_000).toISOString(), timeline: [apiReq({ input: 1, querySource: 'q' })], input: 1 }))
    const r = await handleGetCostByCause(sessions, null, { days: 7 }) as { coverage: { sessionsScanned: number; sessionsSkipped: number; complete: boolean; note: string } }
    assert.strictEqual(r.coverage.sessionsScanned, CAUSE_SCAN_CAP)
    assert.strictEqual(r.coverage.sessionsSkipped, 5)
    assert.strictEqual(r.coverage.complete, false)
    assert.ok(/SAMPLE/.test(r.coverage.note))
  })

  // X2E6OSWK — the leaderboard scan must never be able to starve the event loop: each pool entry
  // can reparse a whole transcript synchronously (getTimeline), so the loop yields one macrotask
  // per session and a deadline stops it honestly.
  test('leaderboard yields the event loop between sessions (a queued macrotask runs mid-scan)', async () => {
    const now = Date.now()
    const sessions = Array.from({ length: 5 }, (_, i) =>
      card('y' + i, { start: new Date(now - i * 60_000).toISOString(), timeline: [], input: 1 }))
    let interleaved = false
    // getTimeline is invoked once per scanned session; a macrotask queued before the call must get
    // to run BEFORE the scan finishes — with the old unyielding flatMap it could not.
    const seen: string[] = []
    const getTimeline = (id: string): unknown[] => { seen.push(id); return [] }
    setImmediate(() => { if (seen.length < sessions.length) interleaved = true })
    await handleGetCostByCause(sessions, getTimeline, { days: 7 })
    assert.strictEqual(seen.length, 5, 'all sessions scanned')
    assert.ok(interleaved, 'a concurrently queued macrotask must run before the scan completes')
  })

  // X2E6OSWK follow-up: pool selection is by LAST ACTIVITY. A fleet spawning ephemeral subagents
  // every minute must not push the heavy, still-active long-lived sessions out of the scan pool
  // (measured: the flagship session ranked #446 by startTime → machine-wide attribution read 0).
  test('leaderboard ranks and windows by last ACTIVITY, not startTime — an old-started active session is scanned first', async () => {
    const now = Date.now()
    const activeOld = card('old-active', {
      start: new Date(now - 10 * 24 * 3600_000).toISOString(),   // started 10d ago — outside a startTime window
      timeline: [apiReq({ input: 40, cost: 0.04, skill: 'heavy' })], // active NOW (fixture timestamps are new Date())
      input: 40,
    })
    const freshIdle = Array.from({ length: CAUSE_SCAN_CAP }, (_, i) =>
      card('fresh' + i, { start: new Date(now - i * 1000).toISOString(), timeline: [], input: 1 }))
    const r = await handleGetCostByCause([...freshIdle, activeOld], null, { days: 7 }) as TokensByCauseReport & {
      coverage: { sessionsScanned: number }
    }
    // The old-started active session must be IN the window and IN the pool — its skill row proves it was scanned.
    assert.strictEqual(dimOf(r, 'skill').rows[0]?.key, 'heavy',
      'the active old-started session must be scanned (last-activity ranking), not dropped for its startTime')
  })

  test('leaderboard stops at the time budget with honest coverage (stoppedEarly, complete false)', async () => {
    const now = Date.now()
    const sessions = Array.from({ length: 10 }, (_, i) =>
      card('t' + i, { start: new Date(now - i * 60_000).toISOString(), timeline: [], input: 1 }))
    // Each fake reparse burns ~15ms synchronously; a 1ms budget must stop after the first session.
    const getTimeline = (): unknown[] => { const until = Date.now() + 15; while (Date.now() < until) { /* spin */ } return [] }
    const r = await handleGetCostByCause(sessions, getTimeline, { days: 7 }, 1) as {
      coverage: { sessionsScanned: number; sessionsSkipped: number; stoppedEarly: boolean; complete: boolean; note: string }
    }
    assert.ok(r.coverage.stoppedEarly, 'the deadline must trip')
    assert.ok(r.coverage.sessionsScanned < 10, 'not all sessions scanned')
    assert.strictEqual(r.coverage.complete, false)
    assert.strictEqual(r.coverage.sessionsScanned + r.coverage.sessionsSkipped, 10, 'skipped accounts for the budget stop')
    assert.ok(/time budget/.test(r.coverage.note), 'the note names the budget stop')
  })
})
