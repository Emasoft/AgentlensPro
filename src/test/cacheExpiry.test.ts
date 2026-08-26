import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { TTL_5M_MS, TTL_1H_MS, type TtlContext } from '../shared/cacheTtl'
import { assessCacheExpiry, formatIdle } from '../cacheExpiry'
import {
  handleCheckCacheExpiry, handleCheckCacheExpiryMemoized, _clearCacheExpiryAnswerCacheForTests,
  EXPIRY_NEWEST_PROBE, DRILL_SCAN_TIME_BUDGET_MS,
} from '../mcpServer'
import { readTranscriptContext } from '../agentGate'
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

function expiryCard(id: string, startTime: string, workspace = '/ws'): SessionSummaryCard {
  return {
    sessionId: id, traceId: 't-' + id, source: 'claude_code', dataSource: 'log',
    workspace, userRequest: 'req', model: 'claude-opus-4-8', turns: 1,
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

// PROJECT SCOPE. Measured defect (2026-08-04): the default "newest MAIN session" was picked
// machine-wide, so a probe run inside one repo answered about a session in an unrelated one, with
// nothing in the payload disclosing the swap — a confidently wrong answer to "has MY cache
// expired". The filter runs BEFORE the bounded probe so the budget is spent on sessions that can
// actually be the answer.
suite('handleCheckCacheExpiry — project scope (2026-08-04)', () => {
  const CTX: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
  const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString()
  // Every card reports the same recent request: these tests pin WHICH session is selected, and a
  // per-card timestamp would let the precision ranking, not the scope filter, decide the winner.
  //
  // CAPTURED ONCE — this must not be `iso(1)` inside the closure. `getTimeline` is called fresh per
  // session (mcpServer.ts:2013), and `scanWithBudget` yields to the macrotask queue between items
  // (`await setImmediate`, mcpServer.ts:3053). So a per-call `Date.now()` gives the LATER-processed
  // card a strictly newer millisecond, and the strict-greater tie-break `ms > newestMs`
  // (mcpServer.ts:2157) then crowns whichever card the scheduler happened to reach second. That is
  // precisely the per-card timestamp the comment above says must not exist — and it made this suite
  // fail 7 times in 20 isolated runs, more often the busier the machine. The product code is right;
  // reading the real clock across its yield is what was not. (The file's other suites already pin a
  // frozen `NOW`, line 16; these cards stay relative to the real clock because their expiry is
  // assessed against it, so freezing the VALUE once is the fix, not adopting the fixed epoch.)
  const activityAt = iso(1)
  const tl = (): unknown[] => [apiRequestAt(activityAt)]

  test('the default pick is the newest main OF THE NAMED PROJECT, not the busiest one on the machine', async () => {
    // The foreign session is strictly newer — under the old rule it won every time.
    const cards = [
      expiryCard('foreign', iso(1), '/other/repo'),
      expiryCard('mine', iso(30), '/my/repo'),
    ]
    const r = await handleCheckCacheExpiry(cards, tl, CTX, { project: '/my/repo' })
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'mine')
    assert.strictEqual(r.scope?.project, '/my/repo')
    assert.strictEqual(r.scope?.sessionsInScope, 1)
  })

  test('a sibling directory that merely shares a prefix is NOT in scope', async () => {
    const cards = [expiryCard('sibling', iso(1), '/my/repo-old')]
    const r = await handleCheckCacheExpiry(cards, tl, CTX, { project: '/my/repo' })
    assert.strictEqual(r.sessions.length, 0, '/my/repo-old must not match /my/repo')
    assert.strictEqual(r.scope?.sessionsInScope, 0)
  })

  test('a worktree UNDER the project root IS in scope', async () => {
    const cards = [expiryCard('wt', iso(1), '/my/repo/.claude/worktrees/w1')]
    const r = await handleCheckCacheExpiry(cards, tl, CTX, { project: '/my/repo/' })
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'wt')
  })

  test('an empty project string is the documented machine-wide opt-out, and --all is scoped too', async () => {
    const cards = [
      expiryCard('foreign', iso(1), '/other/repo'),
      expiryCard('mine', iso(30), '/my/repo'),
    ]
    const wide = await handleCheckCacheExpiry(cards, tl, CTX, { project: '' })
    assert.strictEqual(wide.sessions[0].sessionId, 'foreign', 'empty string must not filter')
    assert.strictEqual(wide.scope?.project, null)
    const scopedAll = await handleCheckCacheExpiry(cards, tl, CTX, { all: true, project: '/my/repo' })
    assert.deepStrictEqual(scopedAll.sessions.map(s => s.sessionId), ['mine'])
    assert.strictEqual(scopedAll.coverage?.sessionsConsidered, 1, 'coverage counts the SCOPED corpus')
  })

  test('an explicit sessionId still wins — a project filter can only contradict an exact id', async () => {
    const cards = [expiryCard('elsewhere', iso(1), '/other/repo')]
    const r = await handleCheckCacheExpiry(cards, tl, CTX, { sessionId: 'elsewhere', project: '/my/repo' })
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'elsewhere')
  })
})

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

// ── Default-path probe is reparse-free with a tail resolver (TRDD-CXPLAT01) ───
// scanWithBudget checks its deadline BETWEEN items, never during one, so the old probe (a full
// transcript reparse per candidate) was unbounded exactly on pathological transcripts: measured
// 20-40s cold calls, 163.6MB read for a 6-session pool. The fix ranks candidates by a bounded
// tail read (getLastRequestMs) and reuses the winner's tail timestamp in the final verdict.
suite('handleCheckCacheExpiry — tail-resolver probe (TRDD-CXPLAT01)', () => {
  const CTX: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }
  const REPARSE_SPIN_MS = 300 // stands in for the unbounded per-item reparse the fix removes

  test('a wired resolver makes the default probe reparse-free AND wall-clock bounded', async () => {
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    const cards = Array.from({ length: 6 }, (_, i) => expiryCard(`m${i}`, iso(i)))
    const reparsed: string[] = []
    // Pre-fix this ran once per candidate (6 × 300ms ≥ 1.8s) and the elapsed assertion below fails.
    const getTimeline = (id: string): unknown[] => {
      reparsed.push(id)
      const until = Date.now() + REPARSE_SPIN_MS
      while (Date.now() < until) { /* synchronous spin — the pathological reparse */ }
      return [apiRequestAt(iso(Number(id.slice(1))))]
    }
    // m2 carries the newest tail timestamp, so precision ranking must pick it over rank-1 m0.
    const getLast = (id: string): number | null => now - (id === 'm2' ? 0 : (Number(id.slice(1)) + 1) * 60_000)
    const t0 = Date.now()
    const r = await handleCheckCacheExpiry(cards, getTimeline, CTX, {}, DRILL_SCAN_TIME_BUDGET_MS, getLast)
    assert.deepStrictEqual(reparsed, [], 'with a tail resolver, no candidate may be reparsed — not even the winner')
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'm2')
    assert.strictEqual(r.sessions[0].lastRequestAt, new Date(now).toISOString(), 'the verdict must reuse the probed tail timestamp')
    assert.ok(Date.now() - t0 < REPARSE_SPIN_MS * cards.length, 'the probe must not pay the per-item reparse cost')
  })

  test('a tail miss ranks by cheap activity metadata; only the chosen winner falls back to ONE reparse', async () => {
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    const cards = Array.from({ length: 5 }, (_, i) => expiryCard(`m${i}`, iso(i)))
    const reparsed: string[] = []
    const getTimeline = (id: string): unknown[] => {
      reparsed.push(id)
      return [apiRequestAt(iso(0))]
    }
    const r = await handleCheckCacheExpiry(cards, getTimeline, CTX, {}, DRILL_SCAN_TIME_BUDGET_MS, () => null)
    // All tails missed → activity ranking (startTime here) picks m0; the single fallback reparse
    // is the winner's verdict, never a probe-loop cost.
    assert.strictEqual(r.sessions.length, 1)
    assert.strictEqual(r.sessions[0].sessionId, 'm0')
    assert.deepStrictEqual(reparsed, ['m0'], 'exactly one reparse — the winner only')
  })

  test('readTranscriptContext surfaces lastRequestAtMs from the LAST usage entry in the tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxplat01-'))
    const f = path.join(dir, 's.jsonl')
    try {
      const t1 = '2026-08-18T10:00:00.000Z'
      const t2 = '2026-08-18T10:05:00.000Z'
      fs.writeFileSync(f, [
        JSON.stringify({ timestamp: t1, message: { usage: { input_tokens: 10 } } }),
        JSON.stringify({ timestamp: t2, message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } }),
        JSON.stringify({ type: 'tool_result', timestamp: '2026-08-18T10:06:00.000Z' }),
      ].join('\n'))
      const ctx = readTranscriptContext(f, Date.now())
      assert.strictEqual(ctx.lastRequestAtMs, Date.parse(t2))
      assert.strictEqual(ctx.contextTokens, 25)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readTranscriptContext reports a null lastRequestAtMs when the tail holds no usage entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxplat01-'))
    const f = path.join(dir, 's.jsonl')
    try {
      fs.writeFileSync(f, JSON.stringify({ type: 'tool_result', timestamp: '2026-08-18T10:06:00.000Z' }))
      const ctx = readTranscriptContext(f, Date.now())
      assert.strictEqual(ctx.lastRequestAtMs, null)
      assert.strictEqual(ctx.contextTokens, null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Answer memoization (TRDD-YST9ZJ90) ────────────────────────────────────────
// The regression this exists to catch, falsified in BOTH directions: RED before the memo (a probe
// burst pays a full walk per call — this suite would fail against plain handleCheckCacheExpiry,
// asserted explicitly below), GREEN after (handleCheckCacheExpiryMemoized collapses the burst to
// one walk within the TTL window).
suite('handleCheckCacheExpiryMemoized — answer cache (TRDD-YST9ZJ90)', () => {
  const CTX: TtlContext = { auth: 'subscription', force5m: false, enable1h: false }

  test('RED: unmemoized handleCheckCacheExpiry pays one walk per call in a burst', async () => {
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    const cards = Array.from({ length: 4 }, (_, i) => expiryCard(`u${i}`, iso(i)))
    let walkCalls = 0
    const getTimeline = (): unknown[] => { walkCalls++; return [apiRequestAt(iso(0))] }
    for (let i = 0; i < 5; i++) await handleCheckCacheExpiry(cards, getTimeline, CTX, { all: true })
    assert.strictEqual(walkCalls, 4 * 5, 'unmemoized: each of the 5 calls re-walks all 4 cards')
  })

  test('GREEN: a 5-call burst inside one memo window issues at most ONE walk', async () => {
    _clearCacheExpiryAnswerCacheForTests()
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    const cards = Array.from({ length: 4 }, (_, i) => expiryCard(`m${i}`, iso(i)))
    let walkCalls = 0
    const getTimeline = (): unknown[] => { walkCalls++; return [apiRequestAt(iso(0))] }
    const results = []
    for (let i = 0; i < 5; i++) {
      results.push(await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { all: true }))
    }
    assert.strictEqual(walkCalls, 4, 'memoized: only the FIRST call walks; the other 4 hit the cache')
    for (const r of results) assert.deepStrictEqual(r, results[0], 'every call in the burst returns the same cached answer')
  })

  test('a different thresholdMinutes is a DIFFERENT question — never served from another threshold\'s cache slot', async () => {
    _clearCacheExpiryAnswerCacheForTests()
    const now = Date.now()
    const cards = [expiryCard('a', new Date(now - 40 * 60_000).toISOString())]
    const getTimeline = (): unknown[] => [apiRequestAt(new Date(now - 40 * 60_000).toISOString())]
    const r30 = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { all: true, thresholdMinutes: 30 })
    const r50 = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { all: true, thresholdMinutes: 50 })
    assert.strictEqual(r30.sessions[0].verdict, 'expired', '40m idle vs a 30m threshold must read expired')
    assert.strictEqual(r50.sessions[0].verdict, 'fresh', '40m idle vs a 50m threshold must read fresh — a shared key would have reused r30\'s verdict')
  })

  test('a project-scoped key never answers a DIFFERENT project from the cache', async () => {
    _clearCacheExpiryAnswerCacheForTests()
    const now = Date.now()
    const cards = [
      expiryCard('mine', new Date(now).toISOString(), '/my/repo'),
      expiryCard('other', new Date(now).toISOString(), '/other/repo'),
    ]
    const getTimeline = (): unknown[] => [apiRequestAt(new Date(now).toISOString())]
    const a = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { project: '/my/repo' })
    const b = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { project: '/other/repo' })
    assert.strictEqual(a.sessions[0]?.sessionId, 'mine')
    assert.strictEqual(b.sessions[0]?.sessionId, 'other')
  })

  test('a walk aborted mid-scan is never cached — the next call re-walks instead of inheriting a partial answer', async () => {
    _clearCacheExpiryAnswerCacheForTests()
    const now = Date.now()
    const iso = (minAgo: number): string => new Date(now - minAgo * 60_000).toISOString()
    const cards = Array.from({ length: 4 }, (_, i) => expiryCard(`a${i}`, iso(i)))
    let walkCalls = 0
    const getTimeline = (): unknown[] => { walkCalls++; return [apiRequestAt(iso(0))] }
    const ac = new AbortController()
    ac.abort() // aborted BEFORE the walk starts — the whole scan is skipped, a total partial result
    const aborted = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { all: true }, DRILL_SCAN_TIME_BUDGET_MS, null, ac.signal)
    assert.strictEqual(aborted.sessions.length, 0, 'an aborted scan yields no sessions')
    walkCalls = 0
    const fresh = await handleCheckCacheExpiryMemoized(cards, getTimeline, CTX, { all: true })
    assert.strictEqual(walkCalls, 4, 'the aborted answer must not have been cached — this call re-walks all 4 cards')
    assert.strictEqual(fresh.sessions.length, 4)
  })
})
