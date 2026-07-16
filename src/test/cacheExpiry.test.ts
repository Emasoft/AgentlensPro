import * as assert from 'assert'
import { TTL_5M_MS, TTL_1H_MS, type TtlContext } from '../shared/cacheTtl'
import { assessCacheExpiry, formatIdle } from '../cacheExpiry'
import { handleCheckCacheExpiry, EXPIRY_NEWEST_PROBE } from '../mcpServer'
import type { SessionSummaryCard, TimelineEntry } from '../shared/summarizerTypes'

// ── Cache-expiry probe (TRDD-OCNHOHE9) ────────────────────────────────────────
// assessCacheExpiry composes the doc-verified TTL regime (cacheTtl.ts) with a
// session's last-LLM-request timestamp to answer "has the prompt cache expired?".
// It NEVER re-declares a TTL number — the regime supplies ttlMs — and it honours
// the same honesty contract: a missing last-request time yields 'unknown', not a guess.

const SUBSCRIPTION: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
const USAGE_CREDITS: TtlContext = { auth: 'usage-credits', force5m: false, enable1h: false }
const UNKNOWN_AUTH: TtlContext = { auth: 'unknown', force5m: false, enable1h: false }
const NOW = 1_800_000_000_000 // fixed clock so tests are deterministic

suite('formatIdle — compact human idle duration', () => {
  test('renders sub-minute idle as seconds', () => {
    assert.strictEqual(formatIdle(45_000), '45s')
  })
  test('renders minutes with trailing seconds', () => {
    assert.strictEqual(formatIdle(90_000), '1m 30s')
  })
  test('renders hours with trailing minutes (drops seconds)', () => {
    assert.strictEqual(formatIdle(62 * 60_000), '1h 2m')
  })
  test('clamps negative input to 0s (never renders a negative duration)', () => {
    assert.strictEqual(formatIdle(-5_000), '0s')
  })
})

suite('assessCacheExpiry — main conversation on a subscription (1h tier)', () => {
  test('reports fresh when idle is well within the 1h TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'fresh')
    assert.strictEqual(v.ttlMs, TTL_1H_MS)
    assert.strictEqual(v.ttlSource, 'doc-matrix')
    assert.ok(v.marginMs !== null && v.marginMs > 0)
  })
  test('reports expired once idle exceeds the 1h TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 90 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'expired')
    assert.ok(v.marginMs !== null && v.marginMs < 0)
    assert.match(v.reason, /evicted|cache-creation/)
  })
  test('treats exactly-at-TTL as still fresh (eviction is strictly after the TTL)', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - TTL_1H_MS, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'fresh')
    assert.strictEqual(v.marginMs, 0)
  })
})

suite('assessCacheExpiry — subagent is 5-min ALWAYS (auth-independent)', () => {
  test('expires a subagent after 6 minutes even on a subscription', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 6 * 60_000, nowMs: NOW, kind: 'subagent', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'expired')
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
    assert.strictEqual(v.ttlSource, 'doc-matrix')
  })
})

suite('assessCacheExpiry — subscription drawing usage credits drops to 5-min', () => {
  test('expires a usage-credits main session after 10 minutes', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 10 * 60_000, nowMs: NOW, kind: 'main', ctx: USAGE_CREDITS })
    assert.strictEqual(v.verdict, 'expired')
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
  })
})

suite('assessCacheExpiry — honesty contract', () => {
  test('surfaces the assumed 5-min floor when auth is unknown (never a silent guess)', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 3 * 60_000, nowMs: NOW, kind: 'main', ctx: UNKNOWN_AUTH })
    assert.strictEqual(v.ttlMs, TTL_5M_MS)
    assert.strictEqual(v.ttlSource, 'assumed')
    assert.strictEqual(v.verdict, 'fresh') // 3m < 5m assumed floor
  })
  test("returns 'unknown' with a reason when no LLM request was recorded", () => {
    const v = assessCacheExpiry({ lastRequestAtMs: null, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.verdict, 'unknown')
    assert.strictEqual(v.idleMs, null)
    assert.strictEqual(v.idleHuman, null)
    assert.strictEqual(v.marginMs, null)
    assert.match(v.reason, /no LLM request/i)
  })
  test('clamps a future last-request timestamp (clock skew) to 0 idle, reporting fresh', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW + 5_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION })
    assert.strictEqual(v.idleMs, 0)
    assert.strictEqual(v.verdict, 'fresh')
  })
})

suite('assessCacheExpiry — explicit --threshold-minutes override', () => {
  test('uses the override TTL, flags it, and labels the source config', () => {
    // 30m idle: fresh under the 1h regime, but EXPIRED under an explicit 15-min threshold.
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 15 * 60_000 })
    assert.strictEqual(v.usedThresholdOverride, true)
    assert.strictEqual(v.ttlMs, 15 * 60_000)
    assert.strictEqual(v.ttlSource, 'config')
    assert.strictEqual(v.verdict, 'expired')
  })
  test('ignores a non-positive override and falls back to the regime TTL', () => {
    const v = assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 0 })
    assert.strictEqual(v.usedThresholdOverride, false)
    assert.strictEqual(v.ttlMs, TTL_1H_MS)
  })
})

// ── MCP handler — bounded corpus scans (TRDD-X2E6OSWK) ────────────────────────
// The handler used to reparse EVERY main transcript synchronously (default path) and map the
// WHOLE corpus (--all) — the exact unbounded-synchronous shape that wedged the server on
// 2026-07-16. These tests pin the bounds: the default path probes only the newest-by-activity
// candidates, and --all yields per card under a time budget with honest coverage.

function expiryCard(id: string, startTime: string): SessionSummaryCard {
  return {
    sessionId: id, traceId: 't-' + id, source: 'claude_code', dataSource: 'log',
    workspace: '/ws', userRequest: 'req', model: 'claude-opus-4-8', turns: 1,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime,
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
    // timeline [] = a stripped/disk-restored card: activity ranking falls back to startTime and
    // asTimeline must go through getTimeline (the reparse) — the post-restart worst case.
    outcome: 'text_response', timeline: [], backgroundSpans: [], loopSignals: [],
  }
}

function apiRequestAt(iso: string): TimelineEntry {
  return { type: 'api_request', spanId: 'r', label: 'api', durationMs: 1, isError: false, timestamp: iso }
}

suite('handleCheckCacheExpiry — bounded scans (TRDD-X2E6OSWK)', () => {
  const CTX: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }

  test('default path reparses only the newest-activity probe, and precision-ranks within it', async () => {
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    // 30 stripped mains, activity rank = startTime rank (m0 newest). m2 carries the NEWEST actual
    // api_request, so precision ranking inside the probe must pick m2 over the rank-1 card.
    const cards = Array.from({ length: 30 }, (_, i) => expiryCard(`m${i}`, iso(i)))
    const probed = new Set<string>()
    const getTimeline = (id: string): unknown[] => {
      probed.add(id)
      return [apiRequestAt(id === 'm2' ? iso(0) : iso(Number(id.slice(1)) + 1))]
    }
    const r = await handleCheckCacheExpiry(cards, getTimeline, CTX, {})
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'm2')
    // Probe bound: only the top EXPIRY_NEWEST_PROBE by activity are ever reparsed (assessOneSession
    // re-reads the winner, which is already in the probed set).
    assert.ok(probed.size <= EXPIRY_NEWEST_PROBE, `probed ${probed.size} > cap ${EXPIRY_NEWEST_PROBE}`)
    assert.ok(!probed.has('m20'), 'a card outside the probe window must never be reparsed')
  })

  test('--all stops on the time budget with honest coverage, newest-activity first', async () => {
    const now = Date.now()
    const cards = Array.from({ length: 40 }, (_, i) =>
      expiryCard(`s${i}`, new Date(now - i * 60_000).toISOString()))
    // Each "reparse" burns ~8ms synchronously — the wedge ingredient the budget exists to bound.
    const getTimeline = (): unknown[] => {
      const until = Date.now() + 8
      while (Date.now() < until) { /* synchronous spin */ }
      return [apiRequestAt(new Date(now).toISOString())]
    }
    const r = await handleCheckCacheExpiry(cards, getTimeline, CTX, { all: true }, 1)
    assert.ok(r.coverage, '--all must return a coverage block')
    assert.strictEqual(r.coverage!.stoppedEarly, true)
    assert.strictEqual(r.coverage!.sessionsConsidered, 40)
    assert.ok(r.coverage!.sessionsScanned < 40, 'the budget must stop the scan before the corpus ends')
    assert.strictEqual(r.sessions.length, r.coverage!.sessionsScanned)
    assert.ok(/SAMPLE/.test(r.coverage!.note), 'a budget stop must be labeled a SAMPLE')
    // Newest-activity first: the scanned prefix is the newest cards, so the budget is spent on
    // the sessions a caller actually cares about.
    assert.strictEqual(r.sessions[0].sessionId, 's0')
  })

  test('--all reports complete coverage when the corpus fits the budget', async () => {
    const now = Date.now()
    const cards = [expiryCard('a', new Date(now).toISOString()), expiryCard('b', new Date(now - 60_000).toISOString())]
    const getTimeline = (): unknown[] => [apiRequestAt(new Date(now).toISOString())]
    const r = await handleCheckCacheExpiry(cards, getTimeline, CTX, { all: true })
    assert.strictEqual(r.sessions.length, 2)
    assert.strictEqual(r.coverage!.stoppedEarly, false)
    assert.ok(/Complete coverage/.test(r.coverage!.note))
  })
})
