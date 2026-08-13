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
import { startMcpHttpServer } from '../mcpServer'
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
