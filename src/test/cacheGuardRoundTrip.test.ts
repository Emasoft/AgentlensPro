import * as assert from 'assert'
import * as http from 'http'
import { runGateCheck } from '../cli/hookHandlers'

// ── the cache-guard's cost control, tested where it actually matters ──────────
// Adding `Read` to GATE_MATCHER puts the gate hook on the hottest tool in a session. The guard is
// only affordable because runGateCheck answers most Reads LOCALLY — one JSON parse, no process
// beyond the hook itself, no HTTP. That is a claim about I/O, not about a return value, so these
// tests count REQUESTS the server actually received; asserting only on the returned string would
// pass just as happily if every read hit the network.
//
// A real socket, not a fetch stub: the thing under test is "did a request leave this process".

interface Probe { url: string; server: http.Server; hits: Array<Record<string, unknown>>; close: () => Promise<void> }

async function probe(reply = ''): Promise<Probe> {
  const hits: Array<Record<string, unknown>> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try { hits.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>) } catch { hits.push({}) }
      res.writeHead(reply ? 200 : 204, reply ? { 'Content-Type': 'application/json' } : undefined)
      res.end(reply)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`, server, hits,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

const payload = (tool_name: string, file_path?: string): Buffer =>
  Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: file_path ? { file_path } : {} }))

suite('cache-guard — when a Read is worth a round-trip', () => {
  const saved = { gate: process.env.AGENTLENS_GATE, guard: process.env.AGENTLENS_CACHE_GUARD }
  let p: Probe

  suiteSetup(async () => { p = await probe() })
  suiteTeardown(async () => { await p.close() })

  setup(() => { delete process.env.AGENTLENS_GATE; delete process.env.AGENTLENS_CACHE_GUARD; p.hits.length = 0 })
  suiteTeardown(() => {
    if (saved.gate === undefined) delete process.env.AGENTLENS_GATE; else process.env.AGENTLENS_GATE = saved.gate
    if (saved.guard === undefined) delete process.env.AGENTLENS_CACHE_GUARD; else process.env.AGENTLENS_CACHE_GUARD = saved.guard
  })

  test('an ordinary source Read never reaches the server — the guard must not tax every read', async () => {
    for (const f of ['/repo/src/server.ts', '/repo/notes.md', '/repo/pkg.json', '/repo/icon.svg']) {
      assert.strictEqual(await runGateCheck(payload('Read', f), { baseUrl: p.url }), '')
    }
    assert.strictEqual(p.hits.length, 0, `no request should have been sent, got ${p.hits.length}`)
  })

  test('an IMAGE Read does reach the server — the guard is still armed', async () => {
    await runGateCheck(payload('Read', '/tmp/shot.png'), { baseUrl: p.url })
    assert.strictEqual(p.hits.length, 1)
    assert.strictEqual(p.hits[0].tool_name, 'Read')
  })

  test('AGENTLENS_CACHE_GUARD=off short-circuits BEFORE any network call', async () => {
    process.env.AGENTLENS_CACHE_GUARD = 'off'
    assert.strictEqual(await runGateCheck(payload('Read', '/tmp/shot.png'), { baseUrl: p.url }), '')
    assert.strictEqual(p.hits.length, 0)
  })

  test('...but it leaves the agent-launch gate armed — one switch must not disarm the other', async () => {
    process.env.AGENTLENS_CACHE_GUARD = 'off'
    await runGateCheck(payload('Task'), { baseUrl: p.url })
    assert.strictEqual(p.hits.length, 1, 'Task is not a Read; the image switch must not touch it')
    assert.strictEqual(p.hits[0].tool_name, 'Task')
  })

  test('AGENTLENS_GATE=off still disarms everything, image reads included', async () => {
    process.env.AGENTLENS_GATE = 'off'
    await runGateCheck(payload('Read', '/tmp/shot.png'), { baseUrl: p.url })
    await runGateCheck(payload('Task'), { baseUrl: p.url })
    assert.strictEqual(p.hits.length, 0)
  })

  test('an unparseable payload falls THROUGH to the server (fail-open on an unknown shape)', async () => {
    await runGateCheck(Buffer.from('{not json'), { baseUrl: p.url })
    assert.strictEqual(p.hits.length, 1, 'a shape we cannot read is not a shape we may decide on')
  })

  test('the server verdict is returned verbatim — the body IS the hook stdout', async () => {
    const talker = await probe(JSON.stringify({ systemMessage: 'hi' }))
    try {
      const out = await runGateCheck(payload('Read', '/tmp/shot.png'), { baseUrl: talker.url })
      assert.strictEqual(out, JSON.stringify({ systemMessage: 'hi' }))
    } finally { await talker.close() }
  })
})
