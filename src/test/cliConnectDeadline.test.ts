import * as assert from 'assert'
import * as http from 'http'
import * as net from 'net'
import { rpc } from '../cli/cliCore'

// TRDD-E8XIC2PM / M8SV6LK5 — the deadline on the MCP transport bounds the CONNECT, not the response.
//
// It shipped bounding the wrong thing, and every unit test and gate stayed green while it did. The
// implementation waited for the socket's 'connect' event to clear its timer — but a socket that is
// ALREADY established (agent-pool reuse, or one assigned post-connect) never emits it, so the timer
// survived into the response phase and destroyed healthy requests.
//
// MEASURED at the moment it was caught: TCP connect to the live, listening server took 1 ms and the
// CLI still reported "no connection within 800ms", because the loaded server took longer than that
// to REPLY. Every diagnostics verb would have failed against a busy-but-healthy server — the exact
// population most likely to be asked a diagnostic question.
//
// So the two cases here are not symmetric decoration. The first is the regression; the second is the
// property the deadline exists for, and neither alone would have caught the defect.

/** A server that ACCEPTS immediately and answers only after `delayMs`. */
function slowServer(delayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const srv = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
      }, delayMs)
    })
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>(done => srv.close(() => done())),
      })
    })
  })
}

suite('MCP transport: the deadline bounds the CONNECT, never the response', () => {
  test('a server that accepts instantly and replies SLOWLY is not aborted', async function () {
    this.timeout(20_000)
    // 1.5x the default 800ms deadline. Under the broken version the request was destroyed here.
    const srv = await slowServer(1_200)
    const prev = process.env.AGENTLENS_MCP_URL
    process.env.AGENTLENS_MCP_URL = srv.url
    try {
      const t0 = Date.now()
      const result = await rpc('tools/list', {}) as { ok?: boolean }
      const ms = Date.now() - t0
      assert.deepStrictEqual(result, { ok: true }, 'a slow answer is still an answer')
      assert.ok(ms >= 1_200, `expected to wait for the slow reply, returned in ${ms}ms`)
    } finally {
      if (prev === undefined) delete process.env.AGENTLENS_MCP_URL; else process.env.AGENTLENS_MCP_URL = prev
      await srv.close()
    }
  })

  test('🐌 an address that DROPS fails fast, with a reason naming the connect', async function () {
    this.timeout(30_000)
    // A closed port REFUSES instantly and would pass against an unbounded transport — only a
    // blackholed address exercises this. Skip loudly where the sandbox answers instead.
    const drops = await new Promise<boolean>(res => {
      const s = net.connect({ host: '10.255.255.1', port: 3000 })
      const t = setTimeout(() => { s.destroy(); res(true) }, 1_200)
      t.unref?.()
      s.on('error', () => { clearTimeout(t); s.destroy(); res(false) })
      s.on('connect', () => { clearTimeout(t); s.destroy(); res(false) })
    })
    if (!drops) { this.skip(); return }

    const prev = process.env.AGENTLENS_MCP_URL
    process.env.AGENTLENS_MCP_URL = 'http://10.255.255.1:3000/mcp'
    try {
      const t0 = Date.now()
      await assert.rejects(rpc('tools/list', {}), (e: Error) => /no connection to .* within \d+ms/.test(e.message))
      const ms = Date.now() - t0
      assert.ok(ms < 5_000, `took ${ms}ms — the OS connect timeout (~75s) is what this exists to bound`)
    } finally {
      if (prev === undefined) delete process.env.AGENTLENS_MCP_URL; else process.env.AGENTLENS_MCP_URL = prev
    }
  })
})
