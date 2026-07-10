import * as assert from 'assert'
import {
  buildSpawnRollup, detectSpawnAntipatterns,
  COLD_CACHE_CREATE_MIN, FLEET_COLD_MIN_CHILDREN,
} from '../shared/spawnRollup'
import { handleGetSubagentTree } from '../mcpServer'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// TRDD-62E8UU41 — spawn-cost rollup + cache-friendly-spawn advisor (FLEET-COLD / WORKTREE-SCATTER /
// MODEL-MIX). Children are LOG-derived sub-agent cards: inputTokens INCLUDES cache (uncached + read +
// create), matching _buildSubAgentCards, so the fixtures below preserve that invariant.

const PARENT_MODEL = 'claude-opus-4-8'

// A sub-agent CHILD card. `uncached` is the raw new input; inputTokens is stored incl-cache.
function child(id: string, o: {
  uncached?: number; output?: number; cacheRead: number; cacheCreate: number
  spawnKind?: SessionSummaryCard['spawnKind']; model?: string
  spawnModelOverride?: string; spawnIsolation?: string; parent?: string
}): SessionSummaryCard {
  const uncached = o.uncached ?? 5_000
  const output = o.output ?? 20_000
  return {
    sessionId: id, traceId: 'trace-' + id, source: 'claude_code', dataSource: 'log',
    initiator: 'agent', parentSessionId: o.parent ?? 'parent', spawnedByTurn: 1,
    spawnKind: o.spawnKind, spawnModelOverride: o.spawnModelOverride, spawnIsolation: o.spawnIsolation,
    workspace: '/ws', userRequest: 'sub', model: o.model ?? PARENT_MODEL, turns: 1,
    inputTokens: uncached + o.cacheRead + o.cacheCreate, outputTokens: output,
    cacheReadTokens: o.cacheRead, cacheCreateTokens: o.cacheCreate,
    cacheHitRate: 0, durationMs: 1000, startTime: new Date().toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 1, totalLlmCalls: 1, errors: 0,
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
  }
}

// A cold child: wrote a big prefix, read almost none of it (the fleet-of-cold-forks signature).
function coldChild(id: string, extra: Partial<Parameters<typeof child>[1]> = {}): SessionSummaryCard {
  return child(id, { cacheRead: 40_000, cacheCreate: 3_000_000, spawnKind: 'fresh', ...extra })
}

// A warm fork child: reads the parent cache (cache_read dominates), tiny cache_create.
function forkChild(id: string): SessionSummaryCard {
  return child(id, { cacheRead: 3_000_000, cacheCreate: 8_000, spawnKind: 'fork' })
}

// Deterministic cost: $1 per 1M cache-create — makes waste assertions exact without a rate table.
const costPerMcacheCreate = (c: SessionSummaryCard) => c.cacheCreateTokens / 1_000_000
const opts = { parentModel: PARENT_MODEL, costOf: costPerMcacheCreate }

suite('buildSpawnRollup — aggregation + spawn-kind mix (TRDD-62E8UU41)', () => {
  test('sums tokens and cost across every child', () => {
    const kids = [coldChild('a'), coldChild('b'), forkChild('c')]
    const r = buildSpawnRollup(kids, opts)
    assert.strictEqual(r.childCount, 3)
    assert.strictEqual(r.totalCacheCreateTokens, 3_000_000 + 3_000_000 + 8_000)
    assert.strictEqual(r.totalCacheReadTokens, 40_000 + 40_000 + 3_000_000)
    assert.strictEqual(r.totalOutputTokens, 60_000)
    // cost = Σ cacheCreate/1M = 3 + 3 + 0.008 = 6.008
    assert.strictEqual(r.totalCostUsd, 6.008)
  })

  test('counts each spawn kind and flags model overrides', () => {
    const kids = [
      coldChild('a', { spawnKind: 'fresh' }),
      forkChild('b'),
      child('c', { cacheRead: 1000, cacheCreate: 1000, spawnKind: 'worktree' }),
      child('d', { cacheRead: 1000, cacheCreate: 1000, spawnKind: 'fleet', spawnModelOverride: 'claude-haiku-4' }),
    ]
    const r = buildSpawnRollup(kids, opts)
    assert.strictEqual(r.kindMix.fresh, 1)
    assert.strictEqual(r.kindMix.fork, 1)
    assert.strictEqual(r.kindMix.worktree, 1)
    assert.strictEqual(r.kindMix.fleet, 1)
    assert.strictEqual(r.kindMix.modelOverride, 1)
    assert.strictEqual(r.kindMix.unknown, 0)
  })

  test('FAIL-FAST: an absent/unrecognized spawnKind is counted unknown, never assumed fresh', () => {
    const kids = [child('a', { cacheRead: 1, cacheCreate: 1 })] // spawnKind undefined
    const r = buildSpawnRollup(kids, opts)
    assert.strictEqual(r.kindMix.unknown, 1)
    assert.strictEqual(r.kindMix.fresh, 0)
  })
})

suite('FLEET-COLD detector (TRDD-62E8UU41)', () => {
  test('fires when ≥3 cold children re-bill the prefix; waste = Σ their cache-create', () => {
    const kids = [coldChild('a'), coldChild('b'), coldChild('c')]
    const dets = detectSpawnAntipatterns(kids, opts)
    const fleet = dets.find(d => d.code === 'FLEET-COLD')
    assert.ok(fleet, 'FLEET-COLD should fire')
    assert.strictEqual(fleet!.severity, 'HIGH')
    assert.strictEqual(fleet!.childCount, 3)
    assert.strictEqual(fleet!.wastedTokens, 9_000_000)
    assert.strictEqual(fleet!.wastedCostUsd, 9)
    assert.ok(/fork/i.test(fleet!.remediation), 'remediation should suggest forks')
  })

  test('does NOT fire below the min-children threshold', () => {
    const kids = Array.from({ length: FLEET_COLD_MIN_CHILDREN - 1 }, (_, i) => coldChild('c' + i))
    assert.strictEqual(detectSpawnAntipatterns(kids, opts).some(d => d.code === 'FLEET-COLD'), false)
  })

  test('warm fork children (cache-read dominated) do NOT count as cold', () => {
    const kids = [forkChild('a'), forkChild('b'), forkChild('c'), forkChild('d')]
    assert.strictEqual(detectSpawnAntipatterns(kids, opts).some(d => d.code === 'FLEET-COLD'), false)
  })

  test('a child that read back >20% of what it wrote is not cold (near-zero-read guard)', () => {
    // cache_create just over the floor, cache_read = 30% of it → reused a warm cache, not a cold re-bill.
    const warmish = (id: string) => child(id, { cacheRead: 45_000, cacheCreate: 150_000, spawnKind: 'fresh' })
    const kids = [warmish('a'), warmish('b'), warmish('c')]
    assert.strictEqual(detectSpawnAntipatterns(kids, opts).some(d => d.code === 'FLEET-COLD'), false)
  })
})

suite('WORKTREE-SCATTER detector (TRDD-62E8UU41)', () => {
  test('fires with ≥2 worktree-isolated cache-heavy children', () => {
    const kids = [
      child('a', { cacheRead: 10_000, cacheCreate: COLD_CACHE_CREATE_MIN, spawnKind: 'worktree' }),
      child('b', { cacheRead: 10_000, cacheCreate: 500_000, spawnIsolation: 'worktree' }),
    ]
    const wt = detectSpawnAntipatterns(kids, opts).find(d => d.code === 'WORKTREE-SCATTER')
    assert.ok(wt)
    assert.strictEqual(wt!.childCount, 2)
    assert.strictEqual(wt!.wastedTokens, COLD_CACHE_CREATE_MIN + 500_000)
  })

  test('a single worktree child is not a scatter', () => {
    const kids = [child('a', { cacheRead: 10_000, cacheCreate: 500_000, spawnKind: 'worktree' })]
    assert.strictEqual(detectSpawnAntipatterns(kids, opts).some(d => d.code === 'WORKTREE-SCATTER'), false)
  })
})

suite('MODEL-MIX detector (TRDD-62E8UU41)', () => {
  test('fires with ≥2 big-prefix children on a different model than the parent', () => {
    const kids = [
      child('a', { cacheRead: 10_000, cacheCreate: 400_000, model: 'claude-haiku-4', spawnKind: 'fresh' }),
      child('b', { cacheRead: 10_000, cacheCreate: 400_000, spawnModelOverride: 'claude-haiku-4', spawnKind: 'fresh' }),
    ]
    const mm = detectSpawnAntipatterns(kids, opts).find(d => d.code === 'MODEL-MIX')
    assert.ok(mm)
    assert.strictEqual(mm!.childCount, 2)
    assert.ok(mm!.message.includes(PARENT_MODEL))
  })

  test('children on the parent model do NOT trigger MODEL-MIX', () => {
    const kids = [coldChild('a'), coldChild('b')] // same model as parent
    assert.strictEqual(detectSpawnAntipatterns(kids, opts).some(d => d.code === 'MODEL-MIX'), false)
  })
})

suite('handleGetSubagentTree — rollup + detections in the MCP output (TRDD-62E8UU41)', () => {
  function parentCard(): SessionSummaryCard {
    return {
      sessionId: 'parent', traceId: 'trace-parent', source: 'claude_code', dataSource: 'log',
      workspace: '/ws', userRequest: 'orchestrate', model: PARENT_MODEL, turns: 3,
      inputTokens: 500_000, outputTokens: 30_000, cacheReadTokens: 400_000, cacheCreateTokens: 20_000,
      cacheHitRate: 0.9, durationMs: 5000, startTime: new Date().toISOString(),
      filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
      toolCounts: {}, totalToolCalls: 5, totalLlmCalls: 3, errors: 0,
      outcome: 'tool_calls', timeline: [], backgroundSpans: [], loopSignals: [],
    }
  }

  test('the founding fleet-of-cold-forks shape surfaces FLEET-COLD with order-of-magnitude waste', () => {
    const sessions = [parentCard(), coldChild('k1'), coldChild('k2'), coldChild('k3')]
    const out = handleGetSubagentTree(sessions, { sessionId: 'parent' }) as Record<string, unknown>
    const rollup = out.spawnRollup as { childCount: number; detections: Array<{ code: string; wastedTokens: number; wastedCostUsd: number }> }
    assert.strictEqual(rollup.childCount, 3)
    const fleet = rollup.detections.find(d => d.code === 'FLEET-COLD')
    assert.ok(fleet, 'FLEET-COLD detection present in the MCP output')
    assert.strictEqual(fleet!.wastedTokens, 9_000_000)
    // Priced with the real rate table (sessionCost) — cost is unknown to the test but must be > 0.
    assert.ok(fleet!.wastedCostUsd > 0, 'wasted cost priced from the child cards')
  })

  test('resolving from a CHILD id finds the root and returns the same rollup', () => {
    const sessions = [parentCard(), coldChild('k1'), coldChild('k2'), coldChild('k3')]
    const out = handleGetSubagentTree(sessions, { sessionId: 'k2' }) as Record<string, unknown>
    const rollup = out.spawnRollup as { childCount: number }
    assert.strictEqual(rollup.childCount, 3)
  })

  test('a childless session yields an empty rollup with no detections', () => {
    const out = handleGetSubagentTree([parentCard()], { sessionId: 'parent' }) as Record<string, unknown>
    const rollup = out.spawnRollup as { childCount: number; detections: unknown[] }
    assert.strictEqual(rollup.childCount, 0)
    assert.strictEqual(rollup.detections.length, 0)
  })
})
