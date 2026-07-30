// CLI contract lock for the ai-maestro consumer (AgentlensPro issue #3, reciprocal of ai-maestro#70).
//
// ai-maestro ships AgentlensPro as an official dependency (their commit 5d889dc5, floor >=2.8.0) and
// named the tools its chat-history enrichment will consume. Their issue GUESSED several field names
// (cost, cache_read, billingMode, fiveHour/sevenDay) that do not exist — this suite pins the TRUE
// paths, verified against the live CLI on 2026-07-16, and the corrections are posted on issue #3.
// If a change makes this suite fail, restore the field or post a heads-up on AgentlensPro#3 BEFORE
// shipping, so the ai-maestro parsers move in lockstep. Sibling: cliContract.janitor.test.ts.
//
// Pinned contract (true paths):
//   get_agent_tokens     → inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
//                          totalTokens, cost_usd
//   get_cost_rollup      → groups[].{input,output,cacheRead,cacheCreation,costUsd} (+ totals)
//   get_context_growth   → perTurn[].{cacheReadTokens,cacheCreateTokens}, totalCacheCreatedTokens,
//                          overallCacheHitRatePct
//   get_account_status   → account, plan, mode, cacheTtl   (mode, NOT billingMode)
//   get_window_budget    → capacitySource, machineWide.capacitySource
//   get_conversation     → sessionId, turns[].{turn,role,blocks[].kind}
//
// Cache-health surface (the ai-maestro-tailored janitor's "prevent cache-miss/expiration"
// consumption — named on #3, 2026-07-16):
//   check_cache_expiry          → sessions[].{sessionId,kind,lastRequestAt,verdict,idleMs,ttlMs,
//                                 ttlMin,marginMs,reason}; --all adds coverage{sessionsConsidered,
//                                 sessionsScanned,stoppedEarly,note} (coverage is POST-2.8.0 additive)
//   get_cache_break_report      → per-session {cacheHitRatePct,totalWastedTokens,totalWastedCostUsd,
//                                 breakCount,breaks[].{turn,cause,wastedTokens},topOffenders[]};
//                                 cross-session {scope,sessionsConsidered,sessionsWithLog,
//                                 sessionsAnalyzed,topOffenders[]} (scanStoppedEarly/scanNote POST-2.8.0)
//   get_cache_break_gap_report  → tierSplit{totalCacheCreateTokens,ephemeral5m/1hTokens,
//                                 ephemeral5m/1hPct}, gapBuckets[] (the 6 fixed bucket keys ARE the
//                                 TTL-expiry-vs-genuine-break distinction), bigEventCount, coverage
//   get_cache_break_timeline    → minTokens,systematicThreshold,turnsInSession,turnsClassified,
//                                 totalCacheCreateTokens,events[].{turn,ts,cause,culprit,
//                                 cacheCreateTokens,gapMinutes,ttlTier},causeHistogram,
//                                 repeatOffenders,coverage
//
// Embed viewer-role assertion (AgentlensPro#4, TRDD-1ZH1D5EG — ai-maestro's proxy signs, we verify):
//   header `X-Agentlens-Viewer: <b64url(payload)>.<b64url(HMAC-SHA256(b64url(payload), key))>`,
//   payload {v:1,role:"maestro"|"user",iat,exp,nonce}, key = ~/.agentlens/embed-key (hex, 0600).
//   Decision table (§B5): absent→standalone(full), maestro→full, user→restricted(GET/HEAD/OPTIONS
//   only, minus GET /api/hook-config; settings chrome hidden), ANY failure→invalid(403 everything).
//   GET /api/embed-status → {mode:"standalone"|"embedded", role:"maestro"|"user"|null, keyLoaded}.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCostRollup, handleGetAgentTokens, handleGetContextGrowth,
  handleGetAccountStatus, handleGetWindowBudget,
  handleCheckCacheExpiry, handleGetCacheBreakReport,
} from '../mcpServer'
import { analyzeCacheBreaks, type CacheTurnInput } from '../shared/cacheBreak'
import { resolveViewerRole, signViewerAssertion, VIEWER_HEADER } from '../embedAuth'
import { buildCacheBreakGapReport, type GapBucketKey } from '../cacheCreationForensics'
import { buildCacheBreakTimeline, type CacheBreakEvent } from '../cacheBreakTimeline'
import type { ContextComposition } from '../shared/summarizerTypes'
import { computeBurnStatus, DEFAULT_THRESHOLDS, type ConsumptionEvent, type BurnConfig } from '../burnMonitor'
import { buildConversationFromFile } from '../conversation'
import type { SessionSummaryCard, TimelineEntry } from '../shared/summarizerTypes'
import { parseOauthAccount, parseSubscriptionType, type AccountInfo } from '../accountInfo'
import type { TtlContext } from '../shared/cacheTtl'

const NOW = 1_700_000_000_000
const BREAK = (p: string): string =>
  `CONTRACT BREAK: ${p} is consumed by ai-maestro (AgentlensPro#3) — post a heads-up there before renaming`

function card(over: Partial<SessionSummaryCard>): SessionSummaryCard {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    agent: 'claude-code', workspace: '/w/proj', userRequest: 'work', model: 'claude-sonnet-5',
    turns: 3, inputTokens: 1_000, outputTokens: 2_000, cacheReadTokens: 100_000, cacheCreateTokens: 10_000,
    cacheHitRate: 0.9, durationMs: 600_000, startTime: new Date(NOW - 3600e3).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], toolCounts: {}, totalToolCalls: 0,
    totalLlmCalls: 3, errors: 0, outcome: 'text_response', timeline: [], backgroundSpans: [],
    loopSignals: [], filesWritten: [],
    ...over,
  } as SessionSummaryCard
}

suite('CLI contract lock — ai-maestro consumed fields (AgentlensPro#3)', () => {
  test('get_agent_tokens serves the 4-bucket split + totalTokens + cost_usd (snake_case)', () => {
    const agent = card({ sessionId: 'agent-abc123def456', model: 'claude-sonnet-5' })
    const res = handleGetAgentTokens([agent], null, { agentId: 'abc123def456' }) as Record<string, unknown>
    for (const f of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'totalTokens'] as const) {
      assert.strictEqual(typeof res[f], 'number', BREAK(`get_agent_tokens.${f}`))
    }
    assert.strictEqual(typeof res.cost_usd, 'number', BREAK('get_agent_tokens.cost_usd (snake_case, not costUSD)'))
  })

  test('get_cost_rollup serves the 5-value breakdown per group AND on totals (camelCase, costUsd)', () => {
    const res = buildCostRollup([card({})], { windowHours: 24 }, NOW) as {
      groups: Array<Record<string, unknown>>; totals: Record<string, unknown>
    }
    assert.ok(res.groups.length > 0, 'fixture must produce a group')
    for (const f of ['input', 'output', 'cacheRead', 'cacheCreation', 'costUsd'] as const) {
      assert.strictEqual(typeof res.groups[0][f], 'number', BREAK(`get_cost_rollup.groups[].${f}`))
      assert.strictEqual(typeof res.totals[f], 'number', BREAK(`get_cost_rollup.totals.${f}`))
    }
  })

  test('get_context_growth serves the per-turn cache read-vs-created split', () => {
    const tl = (turn: number): TimelineEntry => ({
      type: 'llm', spanId: `l${turn}`, label: 'llm', durationMs: 5, isError: false,
      timestamp: new Date(NOW + turn).toISOString(), turn,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 5_000, cacheCreateTokens: 500,
    } as TimelineEntry)
    const res = handleGetContextGrowth(card({}), [tl(1), tl(2)]) as unknown as {
      perTurn: Array<Record<string, unknown>>; totalCacheCreatedTokens: number; overallCacheHitRatePct: number
    }
    assert.ok(Array.isArray(res.perTurn) && res.perTurn.length === 2, 'fixture must produce perTurn rows')
    assert.strictEqual(typeof res.perTurn[0].cacheReadTokens, 'number', BREAK('get_context_growth.perTurn[].cacheReadTokens'))
    assert.strictEqual(typeof res.perTurn[0].cacheCreateTokens, 'number', BREAK('get_context_growth.perTurn[].cacheCreateTokens'))
    assert.strictEqual(typeof res.totalCacheCreatedTokens, 'number', BREAK('get_context_growth.totalCacheCreatedTokens'))
    assert.strictEqual(typeof res.overallCacheHitRatePct, 'number', BREAK('get_context_growth.overallCacheHitRatePct'))
  })

  test('get_account_status serves account/plan/mode/cacheTtl (the mode field is named mode, NOT billingMode)', () => {
    const cfg: BurnConfig = {
      window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null,
      capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS },
    }
    const events: ConsumptionEvent[] = [{ ts: NOW - 1000, sessionId: 's1', accountUuid: 'acct-A', costUsd: 1, tokens: 100, source: 'statusline' }]
    const account: AccountInfo = {
      accountUuid: 'acct-A', email: 'dev@example.com', organizationName: 'Acme', organizationUuid: 'org-1',
      billingType: 'stripe_subscription', hasExtraUsageEnabled: true,
      organizationRateLimitTier: 't4', userRateLimitTier: 't2', displayName: 'Dev',
      planType: 'max', rateLimitTier: 'default_claude_max_20x', label: 'dev@example.com', source: 'claude.json',
    }
    const ttlCtx: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
    const burn = computeBurnStatus(events, [], cfg, NOW)
    const res = handleGetAccountStatus(account, burn, ttlCtx) as Record<string, unknown>
    assert.ok(res.account && typeof res.account === 'object', BREAK('get_account_status.account'))
    assert.strictEqual(typeof res.plan, 'string', BREAK('get_account_status.plan'))
    assert.strictEqual(typeof res.mode, 'string', BREAK('get_account_status.mode (ai-maestro guessed billingMode — mode is canonical)'))
    assert.ok(res.cacheTtl && typeof res.cacheTtl === 'object', BREAK('get_account_status.cacheTtl'))
  })

  test('get_window_budget serves capacitySource at top level and inside machineWide (no fiveHour/sevenDay keys exist)', () => {
    const cfg: BurnConfig = {
      window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null,
      capacitySource: 'none', observed: {}, notify: false, thresholds: { ...DEFAULT_THRESHOLDS },
    }
    const events: ConsumptionEvent[] = [{ ts: NOW - 1000, sessionId: 's1', accountUuid: 'acct-A', costUsd: 1, tokens: 100, source: 'statusline' }]
    const burn = computeBurnStatus(events, [], cfg, NOW)
    const res = handleGetWindowBudget(burn, null, {}) as { capacitySource: unknown; machineWide: { capacitySource: unknown } }
    assert.strictEqual(typeof res.capacitySource, 'string', BREAK('get_window_budget.capacitySource'))
    assert.ok(res.machineWide && typeof res.machineWide.capacitySource === 'string', BREAK('get_window_budget.machineWide.capacitySource'))
  })

  test('get_conversation serves sessionId + verbatim ordered turns[].{turn,role,blocks[].kind}', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-conv-contract-'))
    const sid = 'bbbbbbbb-1111-2222-3333-555555555555'
    const file = path.join(dir, `${sid}.jsonl`)
    try {
      fs.writeFileSync(file,
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-16T10:00:00.000Z', cwd: '/w', sessionId: sid, message: { content: 'hello' } }) + '\n' +
        JSON.stringify({
          type: 'assistant', uuid: 'a1', timestamp: '2026-07-16T10:00:01.000Z', cwd: '/w', sessionId: sid,
          message: {
            id: 'msg-1', model: 'claude-sonnet-5',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'text', text: 'hi' }],
          },
        }) + '\n')
      const conv = await buildConversationFromFile(file, sid)
      assert.ok(conv, 'fixture must parse')
      assert.strictEqual(conv.sessionId, sid, BREAK('get_conversation.sessionId'))
      assert.ok(Array.isArray(conv.turns) && conv.turns.length >= 2, BREAK('get_conversation.turns[]'))
      assert.strictEqual(typeof conv.turns[0].turn, 'number', BREAK('get_conversation.turns[].turn'))
      assert.ok(conv.turns[0].role === 'user' || conv.turns[0].role === 'assistant', BREAK('get_conversation.turns[].role'))
      assert.ok(Array.isArray(conv.turns[0].blocks) && typeof conv.turns[0].blocks[0].kind === 'string',
        BREAK('get_conversation.turns[].blocks[].kind'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // ── Cache-health surface (ai-maestro-tailored janitor: "prevent cache-miss/expiration") ──────

  test('check_cache_expiry serves per-row verdict/idleMs/ttl*/marginMs (TTL-remaining) + lastRequestAt', async () => {
    const s = card({ sessionId: 'expiry-target' })
    const tenMinAgoIso = new Date(Date.now() - 10 * 60_000).toISOString()
    const getTimeline = (): unknown[] => [{
      type: 'api_request', spanId: 'r', label: 'api', durationMs: 1, isError: false, timestamp: tenMinAgoIso,
    }]
    const ttlCtx: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
    const res = await handleCheckCacheExpiry([s], getTimeline, ttlCtx, { sessionId: 'expiry-target' })
    assert.strictEqual(res.sessions.length, 1, 'fixture must produce a row')
    const row = res.sessions[0] as unknown as Record<string, unknown>
    assert.strictEqual(row.sessionId, 'expiry-target', BREAK('check_cache_expiry.sessions[].sessionId'))
    assert.strictEqual(typeof row.kind, 'string', BREAK('check_cache_expiry.sessions[].kind'))
    assert.strictEqual(typeof row.lastRequestAt, 'string', BREAK('check_cache_expiry.sessions[].lastRequestAt'))
    assert.ok(row.verdict === 'fresh' || row.verdict === 'expired' || row.verdict === 'unknown',
      BREAK('check_cache_expiry.sessions[].verdict (fresh|expired|unknown)'))
    assert.strictEqual(typeof row.idleMs, 'number', BREAK('check_cache_expiry.sessions[].idleMs'))
    assert.strictEqual(typeof row.ttlMs, 'number', BREAK('check_cache_expiry.sessions[].ttlMs'))
    assert.strictEqual(typeof row.ttlMin, 'number', BREAK('check_cache_expiry.sessions[].ttlMin'))
    assert.strictEqual(typeof row.marginMs, 'number', BREAK('check_cache_expiry.sessions[].marginMs (TTL-remaining; negative = expired)'))
    assert.strictEqual(typeof row.reason, 'string', BREAK('check_cache_expiry.sessions[].reason'))
  })

  test('check_cache_expiry --all serves coverage{sessionsConsidered,sessionsScanned,stoppedEarly,note} (post-2.8.0 additive)', async () => {
    const ttlCtx: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
    const res = await handleCheckCacheExpiry([card({})], null, ttlCtx, { all: true })
    assert.ok(res.coverage, BREAK('check_cache_expiry(--all).coverage'))
    assert.strictEqual(typeof res.coverage!.sessionsConsidered, 'number', BREAK('check_cache_expiry.coverage.sessionsConsidered'))
    assert.strictEqual(typeof res.coverage!.sessionsScanned, 'number', BREAK('check_cache_expiry.coverage.sessionsScanned'))
    assert.strictEqual(typeof res.coverage!.stoppedEarly, 'boolean', BREAK('check_cache_expiry.coverage.stoppedEarly'))
    assert.strictEqual(typeof res.coverage!.note, 'string', BREAK('check_cache_expiry.coverage.note'))
  })

  test('get_cache_break_report per-session serves cacheHitRatePct/totalWasted*/breakCount/breaks[]/topOffenders[]', async () => {
    // Two turns; turn 2 switches model → a guaranteed MODEL_SWITCHED break with wasted tokens.
    const s = card({ sessionId: 'break-target', model: 'claude-sonnet-5' })
    const tl = (turn: number, model: string): TimelineEntry => ({
      type: 'llm', spanId: `l${turn}`, label: 'llm', durationMs: 5, isError: false,
      timestamp: new Date(NOW + turn * 60_000).toISOString(), turn, model,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: turn === 1 ? 0 : 1_000, cacheCreateTokens: 50_000,
    } as TimelineEntry)
    const getTimeline = (): unknown[] => [tl(1, 'claude-sonnet-5'), tl(2, 'claude-opus-4-8')]
    const getComposition = async (): Promise<ContextComposition> => ({
      sessionId: 'break-target', estimated: true, truncated: false,
      turns: [{ turn: 1, sources: [] }, { turn: 2, sources: [] }],
    })
    const res = await handleGetCacheBreakReport([s], getTimeline, getComposition, { sessionId: 'break-target' }) as Record<string, unknown>
    assert.strictEqual(res.sessionId, 'break-target', BREAK('get_cache_break_report.sessionId'))
    assert.strictEqual(typeof res.cacheHitRatePct, 'number', BREAK('get_cache_break_report.cacheHitRatePct'))
    assert.strictEqual(typeof res.totalWastedTokens, 'number', BREAK('get_cache_break_report.totalWastedTokens'))
    assert.strictEqual(typeof res.totalWastedCostUsd, 'number', BREAK('get_cache_break_report.totalWastedCostUsd'))
    assert.strictEqual(typeof res.breakCount, 'number', BREAK('get_cache_break_report.breakCount'))
    const breaks = res.breaks as Array<Record<string, unknown>>
    assert.ok(Array.isArray(breaks) && breaks.length > 0, 'fixture must produce a break')
    assert.strictEqual(typeof breaks[0].turn, 'number', BREAK('get_cache_break_report.breaks[].turn'))
    assert.strictEqual(typeof breaks[0].cause, 'string', BREAK('get_cache_break_report.breaks[].cause'))
    assert.strictEqual(typeof breaks[0].wastedTokens, 'number', BREAK('get_cache_break_report.breaks[].wastedTokens'))
    const off = res.topOffenders as Array<Record<string, unknown>>
    assert.ok(Array.isArray(off) && off.length > 0, BREAK('get_cache_break_report.topOffenders[]'))
    for (const f of ['label', 'kind', 'cause', 'occurrences', 'wastedTokens', 'wastedCostUsd'] as const) {
      assert.ok(f in off[0], BREAK(`get_cache_break_report.topOffenders[].${f}`))
    }
  })

  test('get_cache_break_report cross-session serves scope/sessionsConsidered/sessionsWithLog/sessionsAnalyzed/topOffenders', async () => {
    const getComposition = async (): Promise<ContextComposition | null> => null
    const res = await handleGetCacheBreakReport([card({})], null, getComposition, {}) as Record<string, unknown>
    assert.strictEqual(typeof res.scope, 'string', BREAK('get_cache_break_report.scope'))
    assert.strictEqual(typeof res.sessionsConsidered, 'number', BREAK('get_cache_break_report.sessionsConsidered'))
    assert.strictEqual(typeof res.sessionsWithLog, 'number', BREAK('get_cache_break_report.sessionsWithLog'))
    assert.strictEqual(typeof res.sessionsAnalyzed, 'number', BREAK('get_cache_break_report.sessionsAnalyzed'))
    assert.ok(Array.isArray(res.topOffenders), BREAK('get_cache_break_report.topOffenders'))
  })

  test('get_cache_break_report break engine serves the cause taxonomy the janitor keys on (analyzeCacheBreaks)', () => {
    const turns: CacheTurnInput[] = [
      { turn: 1, sources: [], inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
      { turn: 2, sources: [], inputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 100_000, hasFastMode: true },
    ]
    const r = analyzeCacheBreaks('s', turns, { writeRateUsdPerMTok: 10, inputRateUsdPerMTok: 2 })
    assert.strictEqual(typeof r.cacheHitRate, 'number', BREAK('cacheBreak engine.cacheHitRate'))
    assert.strictEqual(typeof r.totalWastedTokens, 'number', BREAK('cacheBreak engine.totalWastedTokens'))
    const broke = r.turns.find(t => t.broke)
    assert.ok(broke, 'fixture must break')
    assert.strictEqual(typeof broke!.cause, 'string', BREAK('cacheBreak engine turns[].cause'))
  })

  test('get_cache_break_gap_report serves tierSplit + the 6 fixed gap buckets (TTL-expiry vs genuine-break distinction)', async () => {
    const dir = path.join(os.tmpdir(), `al-gap-contract-${Date.now()}-missing`)
    const res = await buildCacheBreakGapReport({ bodiesDir: dir })
    assert.strictEqual(typeof res.minCacheCreate, 'number', BREAK('get_cache_break_gap_report.minCacheCreate'))
    assert.strictEqual(typeof res.bigEventCount, 'number', BREAK('get_cache_break_gap_report.bigEventCount'))
    const ts = res.tierSplit as unknown as Record<string, unknown>
    for (const f of ['totalCacheCreateTokens', 'ephemeral5mTokens', 'ephemeral1hTokens', 'ephemeral5mPct', 'ephemeral1hPct'] as const) {
      assert.strictEqual(typeof ts[f], 'number', BREAK(`get_cache_break_gap_report.tierSplit.${f}`))
    }
    const expectedBuckets: GapBucketKey[] = ['first-call(no prev)', '<4.5m', '4.5-6m(=5m TTL)', '6-15m', '15-65m', '>65m(1h TTL)']
    assert.deepStrictEqual(res.gapBuckets.map(b => b.bucket), expectedBuckets,
      BREAK('get_cache_break_gap_report.gapBuckets[].bucket — the 6 keys ARE the TTL-vs-break diagnostic'))
    assert.strictEqual(typeof res.gapBuckets[0].events, 'number', BREAK('get_cache_break_gap_report.gapBuckets[].events'))
    assert.strictEqual(typeof res.gapBuckets[0].cacheCreateTokens, 'number', BREAK('get_cache_break_gap_report.gapBuckets[].cacheCreateTokens'))
    assert.ok(Array.isArray(res.interpretation), BREAK('get_cache_break_gap_report.interpretation'))
    assert.ok(res.coverage && typeof res.coverage === 'object', BREAK('get_cache_break_gap_report.coverage'))
  })

  test('get_cache_break_timeline (format=json, the default) serves the report shape + coverage honesty block', async () => {
    const dir = path.join(os.tmpdir(), `al-tl-contract-${Date.now()}-missing`)
    const res = await buildCacheBreakTimeline({ bodiesDir: dir })
    assert.strictEqual(typeof res.minTokens, 'number', BREAK('get_cache_break_timeline.minTokens'))
    assert.strictEqual(typeof res.systematicThreshold, 'number', BREAK('get_cache_break_timeline.systematicThreshold'))
    assert.strictEqual(typeof res.turnsInSession, 'number', BREAK('get_cache_break_timeline.turnsInSession'))
    assert.strictEqual(typeof res.turnsClassified, 'number', BREAK('get_cache_break_timeline.turnsClassified'))
    assert.strictEqual(typeof res.totalCacheCreateTokens, 'number', BREAK('get_cache_break_timeline.totalCacheCreateTokens'))
    assert.ok(Array.isArray(res.events), BREAK('get_cache_break_timeline.events'))
    assert.ok(Array.isArray(res.causeHistogram), BREAK('get_cache_break_timeline.causeHistogram'))
    assert.ok(Array.isArray(res.repeatOffenders), BREAK('get_cache_break_timeline.repeatOffenders'))
    assert.strictEqual(typeof res.coverage.dirExists, 'boolean', BREAK('get_cache_break_timeline.coverage.dirExists'))
    assert.strictEqual(typeof res.coverage.complete, 'boolean', BREAK('get_cache_break_timeline.coverage.complete'))
    assert.strictEqual(typeof res.coverage.note, 'string', BREAK('get_cache_break_timeline.coverage.note'))
    // Per-event field names pinned at the TYPE level: renaming any of these fails compilation,
    // which fails the gate — the hermetic empty-dir run above cannot exercise a populated event.
    const ev: CacheBreakEvent = {
      turn: 2, ts: '2026-07-16T00:00:00.000Z', cause: 'TTL_EXPIRY', culpritLayer: 'timing',
      culpritId: 'ttl', culprit: 'idle gap', cacheCreateTokens: 1, cacheReadTokens: 0,
      inputTokens: 0, outputTokens: 0, costUsd: 0, gapMinutes: 6, ttlTier: '5m', remediation: 'heartbeat',
    }
    assert.strictEqual(ev.ttlTier, '5m', BREAK('get_cache_break_timeline.events[].ttlTier (5m|1h|none)'))
    assert.strictEqual(ev.cause, 'TTL_EXPIRY', BREAK('get_cache_break_timeline.events[].cause (incl. TTL_EXPIRY)'))
  })
})

// ── Embed viewer-role assertion (AgentlensPro#4, TRDD-1ZH1D5EG) ────────────────────────────────
// ai-maestro's proxy SIGNS these; we verify. The full behavioral matrix (incl. the #4 §B4
// cross-repo test vector) lives in embedAuth.test.ts — this suite pins only the pieces their
// implementation hardcodes, so a rename/reshape fails HERE with a message routing to the issue.
suite('CLI contract lock — embed viewer-role assertion (AgentlensPro#4)', () => {
  test('the wire header name is x-agentlens-viewer', () => {
    assert.strictEqual(VIEWER_HEADER, 'x-agentlens-viewer',
      BREAK('the X-Agentlens-Viewer header name (their proxy stamps it per request)'))
  })

  test('the §B5 decision table verdicts: absent→standalone, user→restricted, maestro→maestro, garbage→invalid', () => {
    const key = Buffer.from('a'.repeat(64), 'hex')
    const now = 1_800_000_000_000
    assert.strictEqual(resolveViewerRole(undefined, key, now), 'standalone',
      BREAK('no-header ⇒ standalone full access (solo users must lose nothing)'))
    assert.strictEqual(resolveViewerRole(signViewerAssertion('maestro', key, now, 60_000), key, now), 'maestro',
      BREAK('valid maestro assertion ⇒ full access'))
    assert.strictEqual(resolveViewerRole(signViewerAssertion('user', key, now, 60_000), key, now), 'restricted',
      BREAK('valid user assertion ⇒ restricted viewer'))
    assert.strictEqual(resolveViewerRole('garbage-header', key, now), 'invalid',
      BREAK('unverifiable assertion ⇒ invalid/403 — NEVER a downgrade to standalone'))
  })
})

// AgentlensPro#3 asked us to CONFIRM that the account-facing tools never emit OAuth token material.
// The confirmation was true when checked by hand (three live tools, zero credential-shaped hits) —
// but a confirmation nobody can re-run is exactly the silent drift that issue exists to prevent. The
// risk is not that today's code leaks; it is that a future "just pass the whole blob through"
// refactor of either parser widens it and no gate notices. These two functions ARE the choke-points:
// everything account-facing downstream is built from what they return.
suite('CLI contract lock — account tools never emit OAuth token material (AgentlensPro#3)', () => {
  const ACCESS = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const REFRESH = 'sk-ant-ort01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

  /** Every way a secret could ride out: the literal values, and the shapes a leak would take. */
  const assertNoSecret = (emitted: unknown, what: string): void => {
    const s = JSON.stringify(emitted ?? null)
    for (const secret of [ACCESS, REFRESH]) {
      assert.ok(!s.includes(secret), BREAK(`${what} emitted a literal OAuth token`))
    }
    for (const re of [/sk-ant-[A-Za-z0-9_-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}/, /"(access|refresh)_?[Tt]oken"/]) {
      assert.ok(!re.test(s), BREAK(`${what} emitted credential-shaped material matching ${re}`))
    }
  }

  test('parseOauthAccount lifts identity only — a ~/.claude.json carrying tokens leaks none of them', () => {
    // A realistic file: the identity fields the tools legitimately surface, sitting right beside
    // token material, exactly as they do on disk.
    const claudeJson = JSON.stringify({
      oauthAccount: {
        accountUuid: '80ddbe47-7ad4-4af7-a381-cf908e33c916',
        emailAddress: 'someone@example.com',
        organizationUuid: 'org-1234',
        organizationRateLimitTier: 'tier_4',
        userRateLimitTier: 'tier_3',
        displayName: 'Someone',
        accessToken: ACCESS,
        refreshToken: REFRESH,
      },
      accessToken: ACCESS,
      other: { nested: { refreshToken: REFRESH } },
    })
    const id = parseOauthAccount(claudeJson)
    assert.ok(id, 'the identity must still parse — this test must not pass by returning nothing')
    // The input key is `emailAddress`; the emitted field is `email` — assert the EMITTED name, so
    // this test also pins the rename the tools' consumers depend on.
    assert.strictEqual(id.email, 'someone@example.com', 'identity fields still surface')
    assert.strictEqual(id.organizationRateLimitTier, 'tier_4')
    assertNoSecret(id, 'parseOauthAccount')
  })

  test('parseSubscriptionType returns the plan string ONLY — the credential blob around it is dropped', () => {
    // This is the higher-risk parser: its input is the KEYCHAIN blob, which really does hold the
    // access and refresh tokens. It must return one non-secret string and nothing else.
    for (const blob of [
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', accessToken: ACCESS, refreshToken: REFRESH } }),
      JSON.stringify({ subscriptionType: 'pro', accessToken: ACCESS }), // older top-level shape
    ]) {
      const plan = parseSubscriptionType(blob)
      assert.ok(plan === 'max' || plan === 'pro', 'the plan must still be extracted')
      assert.strictEqual(typeof plan, 'string', BREAK('parseSubscriptionType must return a bare string, never the blob'))
      assertNoSecret(plan, 'parseSubscriptionType')
    }
  })

  test('a malformed or token-only blob yields null, never a passthrough of what it could not parse', () => {
    // The failure path is where a passthrough would hide: "I could not parse it, here it is back".
    for (const bad of ['not json', '', '{}', JSON.stringify({ accessToken: ACCESS })]) {
      assertNoSecret(parseSubscriptionType(bad), 'parseSubscriptionType(malformed)')
      assertNoSecret(parseOauthAccount(bad), 'parseOauthAccount(malformed)')
    }
    assert.strictEqual(parseSubscriptionType(JSON.stringify({ accessToken: ACCESS })), null,
      BREAK('a blob with no subscriptionType must yield null, not something derived from the token'))
  })
})
