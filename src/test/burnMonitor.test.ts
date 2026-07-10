import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  loadBurnConfig, gatherConsumptionEvents, rateWindow, computeBurnSeries,
  computeWindowBudget, evaluateBurnAlerts, computeBurnStatus, computeSessionStatus,
  resolveSession, DEFAULT_THRESHOLDS,
  type ConsumptionEvent, type StatuslineBillingEvent, type BurnConfig,
} from '../burnMonitor'
import type { SessionSummaryCard, TimelineEntry } from '../shared/summarizerTypes'

// ── fixtures ─────────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000  // fixed epoch ms so window math is deterministic

function apiEvent(offsetMs: number, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: 'api_request', spanId: 's' + offsetMs, label: 'api_request',
    durationMs: 100, isError: false,
    timestamp: new Date(NOW - offsetMs).toISOString(),
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0,
    costUsd: 0.01, querySource: 'repl_main_thread',
    ...over,
  }
}

function card(over: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1', traceId: 't1', source: 'claude_code', dataSource: 'otel',
    workspace: '/ws/proj', userRequest: 'do a thing', model: 'claude-sonnet-4-5',
    turns: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: new Date(NOW - 1000).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'text_response',
    timeline: [], backgroundSpans: [], loopSignals: [],
    ...over,
  }
}

function ev(over: Partial<ConsumptionEvent> = {}): ConsumptionEvent {
  return { ts: NOW, sessionId: 'sess-1', workspace: '/ws/proj', costUsd: 0.01, tokens: 1000, source: 'api_request', ...over }
}

function baseConfig(over: Partial<BurnConfig> = {}): BurnConfig {
  return { window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null, capacitySource: 'none', notify: false, thresholds: { ...DEFAULT_THRESHOLDS }, ...over }
}

suite('burnMonitor — rolling window math', () => {
  test('rateWindow sums only events inside the window and normalizes to per-minute', () => {
    const events: ConsumptionEvent[] = [
      ev({ ts: NOW - 10_000, tokens: 100, costUsd: 0.1 }),  // in 1-min + 5-min
      ev({ ts: NOW - 90_000, tokens: 200, costUsd: 0.2 }),  // only in 5-min
      ev({ ts: NOW - 400_000, tokens: 999, costUsd: 9 }),   // outside both
    ]
    const oneMin = rateWindow(events, NOW, 60_000)
    assert.strictEqual(oneMin.tokens, 100)
    assert.strictEqual(oneMin.tokensPerMin, 100)          // 1-min window rate == its sum
    const fiveMin = rateWindow(events, NOW, 300_000)
    assert.strictEqual(fiveMin.tokens, 300)
    assert.strictEqual(fiveMin.tokensPerMin, 60)          // 300 tokens / 5 min
    assert.ok(Math.abs(fiveMin.costPerMin - 0.06) < 1e-9)
  })

  test('computeBurnSeries groups per session, hottest first, with dominant cause', () => {
    const events: ConsumptionEvent[] = [
      ev({ sessionId: 'A', ts: NOW - 5_000, tokens: 5000, attribution: 'agent:worker' }),
      ev({ sessionId: 'A', ts: NOW - 6_000, tokens: 1000, attribution: 'main' }),
      ev({ sessionId: 'B', ts: NOW - 5_000, tokens: 500, attribution: 'skill:foo' }),
    ]
    const series = computeBurnSeries(events, NOW)
    assert.strictEqual(series.sessions.length, 2)
    assert.strictEqual(series.sessions[0].sessionId, 'A')        // hotter
    assert.strictEqual(series.sessions[0].dominantCause, 'agent:worker') // 5000 > 1000
    assert.strictEqual(series.global.oneMin.tokens, 6500)
  })

  test('sessions active only outside the 5-min window are excluded', () => {
    const events: ConsumptionEvent[] = [ev({ sessionId: 'stale', ts: NOW - 400_000, tokens: 9999 })]
    assert.strictEqual(computeBurnSeries(events, NOW).sessions.length, 0)
  })
})

suite('burnMonitor — window budget accounting', () => {
  const events: ConsumptionEvent[] = [
    ev({ ts: NOW - 60_000, tokens: 100_000, costUsd: 1 }),        // in 5h + 7d
    ev({ ts: NOW - 3 * 3600_000, tokens: 200_000, costUsd: 2 }),  // in 5h + 7d
    ev({ ts: NOW - 6 * 3600_000, tokens: 300_000, costUsd: 3 }),  // in 7d only (past 5h)
  ]

  test('consumption sums are windowed; pct/projection null when capacity unset', () => {
    const b = computeWindowBudget(events, baseConfig(), 1000, NOW)
    assert.strictEqual(b.fiveHour.consumedTokens, 300_000)
    assert.strictEqual(b.sevenDay.consumedTokens, 600_000)
    assert.strictEqual(b.fiveHour.pctConsumed, null)
    assert.strictEqual(b.fiveHour.minutesToExhaustion, null)
    assert.strictEqual(b.capacityConfigured, false)
    assert.ok(b.note && b.note.includes('capacity'))
  })

  test('pct + time-to-exhaustion computed when capacity is set', () => {
    const cfg = baseConfig({ window5hTokens: 1_000_000, capacitySource: 'env' })
    const b = computeWindowBudget(events, cfg, 10_000, NOW)   // 10k tok/min projection
    assert.strictEqual(b.fiveHour.pctConsumed, 30)            // 300k / 1M
    // remaining 700k / 10k per min == 70 min
    assert.strictEqual(b.fiveHour.minutesToExhaustion, 70)
    assert.strictEqual(b.capacityConfigured, true)
  })

  test('over-capacity reports 0 minutes to exhaustion', () => {
    const cfg = baseConfig({ window5hTokens: 100_000, capacitySource: 'env' })
    const b = computeWindowBudget(events, cfg, 10_000, NOW)   // consumed 300k > cap 100k
    assert.strictEqual(b.fiveHour.minutesToExhaustion, 0)
  })
})

suite('burnMonitor — alert threshold triggering', () => {
  test('tokens_per_min alert fires and names the hottest session + cause', () => {
    const events: ConsumptionEvent[] = [ev({ sessionId: 'hot', ts: NOW - 1000, tokens: 5_000_000, attribution: 'agent:fleet' })]
    const cfg = baseConfig({ thresholds: { ...DEFAULT_THRESHOLDS, tokensPerMin: 1_000_000 } })
    const series = computeBurnSeries(events, NOW)
    const budget = computeWindowBudget(events, cfg, series.global.fiveMin.tokensPerMin, NOW)
    const alerts = evaluateBurnAlerts(series, budget, cfg, [card({ sessionId: 'hot' })], events, NOW)
    const a = alerts.find(x => x.rule === 'tokens_per_min')
    assert.ok(a, 'tokens_per_min alert present')
    assert.strictEqual(a!.sessionId, 'hot')
    assert.strictEqual(a!.cause, 'agent:fleet')
    assert.ok(a!.detail.includes('agent:fleet'))
  })

  test('window pct alert fires only when capacity known and threshold crossed', () => {
    const events: ConsumptionEvent[] = [ev({ ts: NOW - 1000, tokens: 900_000 })]
    const cfg = baseConfig({ window5hTokens: 1_000_000, capacitySource: 'env', thresholds: { ...DEFAULT_THRESHOLDS, windowPct: 80 } })
    const series = computeBurnSeries(events, NOW)
    const budget = computeWindowBudget(events, cfg, series.global.fiveMin.tokensPerMin, NOW)
    const alerts = evaluateBurnAlerts(series, budget, cfg, [card()], events, NOW)
    assert.ok(alerts.some(a => a.rule === 'window_5h_pct'), '90% > 80% must alert')

    // No capacity → no window alert even at huge consumption.
    const cfg2 = baseConfig({ thresholds: { ...DEFAULT_THRESHOLDS, windowPct: 80 } })
    const budget2 = computeWindowBudget(events, cfg2, series.global.fiveMin.tokensPerMin, NOW)
    const alerts2 = evaluateBurnAlerts(series, budget2, cfg2, [card()], events, NOW)
    assert.ok(!alerts2.some(a => a.rule.startsWith('window_')), 'no capacity → no window alert')
  })

  test('cache_create_spike alert fires on a single big cache-creation call', () => {
    const events: ConsumptionEvent[] = [ev({ sessionId: 'spike', ts: NOW - 1000, tokens: 300_000, cacheCreateTokens: 300_000, attribution: 'compaction' })]
    const cfg = baseConfig({ thresholds: { ...DEFAULT_THRESHOLDS, cacheCreateSingleCall: 200_000, tokensPerMin: 1e12 } })
    const series = computeBurnSeries(events, NOW)
    const budget = computeWindowBudget(events, cfg, 0, NOW)
    const alerts = evaluateBurnAlerts(series, budget, cfg, [card({ sessionId: 'spike' })], events, NOW)
    const a = alerts.find(x => x.rule === 'cache_create_spike')
    assert.ok(a, 'cache_create_spike present')
    assert.strictEqual(a!.sessionId, 'spike')
    assert.strictEqual(a!.cause, 'compaction')
  })

  test('nothing fires when rates are under threshold', () => {
    const events: ConsumptionEvent[] = [ev({ ts: NOW - 1000, tokens: 1000, costUsd: 0.001 })]
    const cfg = baseConfig()
    const series = computeBurnSeries(events, NOW)
    const budget = computeWindowBudget(events, cfg, 0, NOW)
    assert.strictEqual(evaluateBurnAlerts(series, budget, cfg, [card()], events, NOW).length, 0)
  })
})

suite('burnMonitor — event gathering + dedup', () => {
  test('a session with api_request events ignores its statusline deltas (no double count)', () => {
    const sessions = [card({ sessionId: 'A', timeline: [apiEvent(1000, { costUsd: 0.5, inputTokens: 1000 })] })]
    const sl: StatuslineBillingEvent[] = [
      { ts: NOW / 1000 - 1, sessionId: 'A', deltaCostUsd: 0.5, deltaTokens: 1200 },  // dropped (A has api_request)
      { ts: NOW / 1000 - 1, sessionId: 'B', deltaCostUsd: 0.3, deltaTokens: 800 },   // kept (no api_request)
    ]
    const events = gatherConsumptionEvents(sessions, sl, NOW)
    assert.strictEqual(events.filter(e => e.sessionId === 'A').length, 1)
    assert.strictEqual(events.filter(e => e.sessionId === 'A')[0].source, 'api_request')
    const b = events.find(e => e.sessionId === 'B')
    assert.ok(b && b.source === 'statusline')
    assert.strictEqual(b!.tokens, 800)
    assert.ok(b!.ts > 1e12, 'statusline seconds normalized to ms')
  })
})

suite('burnMonitor — session resolution + status', () => {
  const live = card({ sessionId: 'live', workspace: '/ws/proj', timeline: [apiEvent(30_000)], startTime: new Date(NOW - 30_000).toISOString() })
  const stale = card({ sessionId: 'old', workspace: '/ws/proj', startTime: new Date(NOW - 3 * 3600_000).toISOString(), timeline: [apiEvent(3 * 3600_000)] })

  test('resolveSession prefers the newest live session under the workspace prefix', () => {
    const r = resolveSession([stale, live], { workspace: '/ws/proj' }, NOW)
    assert.strictEqual(r.card!.sessionId, 'live')
    assert.strictEqual(r.matchedBy, 'workspace-recent')
    assert.strictEqual(r.live, true)
  })

  test('resolveSession falls back to newest-overall-under-prefix labeled live:false', () => {
    const r = resolveSession([stale], { workspace: '/ws/proj' }, NOW)
    assert.strictEqual(r.card!.sessionId, 'old')
    assert.strictEqual(r.matchedBy, 'workspace-latest')
    assert.strictEqual(r.live, false)
  })

  test('computeSessionStatus returns the full field set incl. comparison to prior sessions', () => {
    const prev = card({ sessionId: 'prev', workspace: '/ws/proj', totalLlmCalls: 10, cacheHitRate: 0.9,
      inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 4000,
      startTime: new Date(NOW - 5 * 3600_000).toISOString(), timeline: [apiEvent(5 * 3600_000)] })
    const cur = card({ sessionId: 'cur', workspace: '/ws/proj', totalLlmCalls: 4, cacheHitRate: 0.5,
      inputTokens: 8000, outputTokens: 2000, cacheReadTokens: 3000,
      peakContextPerTurn: 120_000,
      timeline: [apiEvent(20_000, { costUsd: 0.42 })], startTime: new Date(NOW - 20_000).toISOString() })
    const events = gatherConsumptionEvents([prev, cur], [], NOW)
    const st = computeSessionStatus([prev, cur], events, baseConfig(), { workspace: '/ws/proj' }, NOW)
    assert.ok('resolved' in st, 'resolved status returned')
    if (!('resolved' in st)) return
    assert.strictEqual(st.resolved.sessionId, 'cur')
    assert.strictEqual(st.context.peakTokens, 120_000)
    assert.strictEqual(st.cacheHitRatePct, 50)
    assert.strictEqual(st.lastCallCostUsd, 0.42)
    assert.ok(st.comparison, 'comparison present')
    assert.strictEqual(st.comparison!.previousSessions, 1)
    assert.strictEqual(st.comparison!.avgTurns, 10)
    // avg-5-values present
    assert.ok(st.avgPerCall.total > 0)
    // drill pointers reference the follow-up tools
    assert.ok(st.drill.context_history.includes('get_context_history'))
  })

  test('computeSessionStatus returns a message when nothing matches', () => {
    const st = computeSessionStatus([], [], baseConfig(), { workspace: '/nope' }, NOW)
    assert.ok('message' in st)
  })
})

suite('burnMonitor — computeBurnStatus + config', () => {
  test('computeBurnStatus assembles rate + budget + alerts', () => {
    const events: ConsumptionEvent[] = [ev({ ts: NOW - 1000, tokens: 3_000_000, attribution: 'agent:x' })]
    const cfg = baseConfig({ thresholds: { ...DEFAULT_THRESHOLDS, tokensPerMin: 1_000_000 } })
    const status = computeBurnStatus(events, [card()], cfg, NOW)
    assert.ok(status.global.oneMin.tokensPerMin >= 3_000_000)
    assert.ok(status.alerts.some(a => a.rule === 'tokens_per_min'))
    assert.strictEqual(status.activeSessions, 1)
  })

  test('loadBurnConfig reads env capacity + thresholds; capacity null by default', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burncfg-'))
    try {
      const def = loadBurnConfig({}, home)
      assert.strictEqual(def.window5hTokens, null)
      assert.strictEqual(def.capacitySource, 'none')
      assert.strictEqual(def.thresholds.tokensPerMin, DEFAULT_THRESHOLDS.tokensPerMin)

      const withEnv = loadBurnConfig(
        { AGENTLENS_WINDOW_5H_TOKENS: '2000000', AGENTLENS_BURN_TOKENS_PER_MIN: '500000', AGENTLENS_NOTIFY: '1' },
        home,
      )
      assert.strictEqual(withEnv.window5hTokens, 2_000_000)
      assert.strictEqual(withEnv.capacitySource, 'env')
      assert.strictEqual(withEnv.thresholds.tokensPerMin, 500_000)
      assert.strictEqual(withEnv.notify, true)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('loadBurnConfig reads ~/.agentlens/burn-config.json when no env override', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burncfg-'))
    try {
      fs.mkdirSync(path.join(home, '.agentlens'))
      fs.writeFileSync(path.join(home, '.agentlens', 'burn-config.json'),
        JSON.stringify({ window7dTokens: 5_000_000, thresholds: { costPerHour: 12 } }))
      const cfg = loadBurnConfig({}, home)
      assert.strictEqual(cfg.window7dTokens, 5_000_000)
      assert.strictEqual(cfg.capacitySource, 'config')
      assert.strictEqual(cfg.thresholds.costPerHour, 12)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
