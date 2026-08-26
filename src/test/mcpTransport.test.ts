// WHY THIS FILE EXISTS (2026-08-13): the live MCP endpoint wedged permanently — every CLI call
// (tools/list included) returned `rpc error (undefined)` while the HTTP layer logged 200s. Raw
// probe answer: {"error":"Error: Already connected to a transport. Call close() before connecting
// to a new transport, or use a separate Protocol instance per connection."} The old shape shared
// ONE Server (Protocol) instance across requests; the SDK tracks exactly one transport per
// Protocol, so an overlapping client's connect() threw and the instance stayed wedged until
// restart. HONESTY NOTE on falsification: the wedge-producing interleave needs two connections
// overlapping inside the SDK's async machinery, and an in-process harness could not force it —
// a sync block serializes the single event loop, and fast requests close before colliding — so
// these tests were NOT observed red against the shared-instance code. The red for this defect is
// the LIVE PROBE above (recorded in TRDD-34B9JAZK's trail); these tests pin the fixed contract
// (per-request Server instances) so a revert to sharing has a place to fail when timing allows.
import * as assert from 'assert'
import * as http from 'http'
import { startMcpHttpServer, _clearCacheExpiryAnswerCacheForTests } from '../mcpServer'
import type { AddressInfo } from 'net'

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
})
const CALL_SESSIONS = JSON.stringify({
  jsonrpc: '2.0', id: 2, method: 'tools/call',
  params: { name: 'get_recent_sessions', arguments: {} },
})

/** Synchronous block inside the tool handler. NOTE: this blocks the single event loop, so it
 *  SERIALIZES the "concurrent" requests rather than overlapping them — it widens the exercised
 *  window but cannot force the SDK-internal interleave the live wedge needed (see header). */
function blockMs(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buf, 0, 0, ms)
}

function post(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

suite('mcp transport — one Server instance per connection, never shared', () => {
  let server: http.Server
  let port: number
  suiteSetup(async () => {
    // getSessions blocks 200ms so a tools/call HOLDS its connection — the collision-forcing shape.
    server = startMcpHttpServer({ getSessions: () => { blockMs(200); return [] } }, 0)
    await new Promise<void>((r) => server.once('listening', () => r()))
    port = (server.address() as AddressInfo).port
  })
  suiteTeardown(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  test('two CONCURRENT initializes both succeed — the shared-instance shape failed one with "Already connected"', async () => {
    const [a, b] = await Promise.all([post(port, INITIALIZE), post(port, INITIALIZE)])
    for (const r of [a, b]) {
      assert.ok(!r.body.includes('Already connected'), `a client collided with another connection: ${r.body.slice(0, 200)}`)
      assert.strictEqual(r.status, 200, `initialize must succeed, got ${r.status}: ${r.body.slice(0, 200)}`)
    }
  })

  test('two concurrent HELD tool calls both succeed — the shared instance threw "Already connected" on the overlap', async function () {
    this.timeout(20_000)
    const [a, b] = await Promise.all([post(port, CALL_SESSIONS), post(port, CALL_SESSIONS)])
    for (const r of [a, b]) {
      assert.ok(!r.body.includes('Already connected'), `a held connection collided with another: ${r.body.slice(0, 200)}`)
      assert.strictEqual(r.status, 200, `tools/call must succeed, got ${r.status}: ${r.body.slice(0, 200)}`)
    }
  })

  test('a request AFTER a concurrent burst still succeeds — the old shape stayed wedged until restart', async function () {
    this.timeout(20_000)
    await Promise.all([post(port, CALL_SESSIONS), post(port, CALL_SESSIONS), post(port, CALL_SESSIONS)])
    const late = await post(port, INITIALIZE)
    assert.ok(!late.body.includes('Already connected'), `endpoint wedged after the burst: ${late.body.slice(0, 200)}`)
    assert.strictEqual(late.status, 200)
  })
})

// ── Client-disconnect abandonment (TRDD-YST9ZJ90) ─────────────────────────────
// The CLI already gives up on its own timeout while the server used to walk to completion for an
// answer nobody would read. Proven STRUCTURALLY, not by a timing guess: a getTimeline spy counts
// exactly which sessions were actually scanned before the socket was destroyed, and the assertion
// is that the count STOPS GROWING once destroyed — not merely "the response came back fast".
suite('mcp transport — client disconnect abandons the check_cache_expiry walk', () => {
  let server: http.Server
  let port: number
  let scannedCount: number

  const CARD_COUNT = 40
  const PER_ITEM_MS = 40 // each session's "reparse" — synchronous, like the real pathological case

  suiteSetup(async () => {
    scannedCount = 0
    const cards = Array.from({ length: CARD_COUNT }, (_, i) => ({
      sessionId: `s${i}`, traceId: `t${i}`, source: 'claude_code' as const, dataSource: 'log' as const,
      workspace: '/ws', userRequest: 'req', model: 'claude-opus-4-8', turns: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0,
      durationMs: 1000, startTime: new Date(Date.now() - i * 60_000).toISOString(),
      filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
      toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
      outcome: 'text_response' as const, timeline: [], backgroundSpans: [], loopSignals: [],
    }))
    server = startMcpHttpServer({
      getSessions: () => cards,
      getTimeline: () => {
        scannedCount++
        const until = Date.now() + PER_ITEM_MS
        while (Date.now() < until) { /* synchronous spin, stands in for a real transcript reparse */ }
        return []
      },
    }, 0)
    await new Promise<void>((r) => server.once('listening', () => r()))
    port = (server.address() as AddressInfo).port
  })
  suiteTeardown(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  test('destroying the client socket mid-walk stops the server scanning further sessions', async function () {
    this.timeout(20_000)
    // The answer cache is a process-wide singleton keyed only by the args tuple (TRDD-YST9ZJ90) —
    // clear it so an unrelated test file's `{ all: true }` answer can't short-circuit this walk.
    _clearCacheExpiryAnswerCacheForTests()
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'check_cache_expiry', arguments: { all: true } },
    })
    await new Promise<void>((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
        () => { /* response arriving after our own destroy would be the bug this test catches */ },
      )
      req.on('error', () => resolve()) // destroying our own request legitimately errors it — expected
      req.end(body)
      // Let a few items scan (2-3 macrotasks' worth), then abandon — mid-walk, not before it starts.
      setTimeout(() => { req.destroy(); resolve() }, PER_ITEM_MS * 3)
    })
    assert.ok(scannedCount > 0, 'the walk must have started scanning before the disconnect')
    assert.ok(scannedCount < CARD_COUNT, 'the walk must not have finished the whole corpus by the time we disconnected')
    // A structural plateau, not a timing guess: one item may already be mid-flight when the abort
    // signal fires (scanWithBudget only checks between items), so take TWO snapshots well after the
    // disconnect and require them EQUAL — a server that ignores the abort keeps incrementing toward
    // CARD_COUNT and the two snapshots would differ.
    await new Promise(r => setTimeout(r, PER_ITEM_MS * 4))
    const plateauA = scannedCount
    await new Promise(r => setTimeout(r, PER_ITEM_MS * 4))
    const plateauB = scannedCount
    assert.strictEqual(plateauB, plateauA, 'the server kept scanning after the client disconnected — abort was not honoured')
    assert.ok(plateauA < CARD_COUNT, 'the plateau must be short of the full corpus, or nothing was actually abandoned')
  })
})
