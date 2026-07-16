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
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCostRollup, handleGetAgentTokens, handleGetContextGrowth,
  handleGetAccountStatus, handleGetWindowBudget,
} from '../mcpServer'
import { computeBurnStatus, DEFAULT_THRESHOLDS, type ConsumptionEvent, type BurnConfig } from '../burnMonitor'
import { buildConversationFromFile } from '../conversation'
import type { SessionSummaryCard, TimelineEntry } from '../shared/summarizerTypes'
import type { AccountInfo } from '../accountInfo'
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
})
