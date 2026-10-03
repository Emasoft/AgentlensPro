import * as assert from 'assert'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { apiRequest, PROBE_TIMEOUT_MS } from '../cli/cliCore'
import { chooseServerPorts } from '../cli/portSelect'
import { findServerPid } from '../cli/serverControl'
import { freePort } from './helpers/freePort'

// A foreign listener that ACCEPTS TCP and never writes — the shape that hung `server start`. Real sockets, no mocks.
const held = new WeakMap<net.Server, net.Socket[]>()
const silentListener = (): Promise<net.Server> => new Promise(resolve => {
  const socks: net.Socket[] = []
  const s = net.createServer(sock => { socks.push(sock); sock.on('error', () => undefined) }) // accept, never answer
  held.set(s, socks)
  s.listen(0, '127.0.0.1', () => resolve(s))
})
// destroy the held sockets first, or server.close() waits on them forever
const close = (s: net.Server): Promise<void> => new Promise(r => { held.get(s)?.forEach(k => k.destroy()); s.close(() => r()) })

suite('apiRequest total response deadline', () => {
  const saved = { d: process.env.AGENTLENS_DATA_DIR, u: process.env.AGENTLENS_UI_URL }
  const restore = (): void => {
    if (saved.d === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = saved.d
    if (saved.u === undefined) delete process.env.AGENTLENS_UI_URL; else process.env.AGENTLENS_UI_URL = saved.u
  }

  test('an accept-and-never-answer listener fails within the deadline, naming the port', async () => {
    const s = await silentListener()
    const port = (s.address() as net.AddressInfo).port
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${port}`
    const t0 = Date.now()
    try {
      await assert.rejects(apiRequest('GET', '/api/server-stats', undefined, 600), (e: Error) =>
        e.message.includes('server did not answer') && e.message.includes(`port ${port}`) && e.message.includes('not an agentlens server'))
      assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`)
    } finally { restore(); await close(s) }
  })

  test('the port guard treats a silent squatter on the UI port as foreign and switches; OTLP squat still refuses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apidl-'))
    const s = await silentListener()
    const ui = (s.address() as net.AddressInfo).port
    process.env.AGENTLENS_DATA_DIR = dir
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${ui}`
    const t0 = Date.now()
    try {
      const ours = async (): Promise<boolean> => (await findServerPid().catch(() => null)) !== null
      const r = await chooseServerPorts({ otlp: await freePort(), ui, mcp: await freePort() }, { ui: false, mcp: false }, ours)
      assert.notStrictEqual(r.ui, ui)
      assert.ok(Date.now() - t0 < PROBE_TIMEOUT_MS + 3000, `took ${Date.now() - t0}ms — the probe must not hang`)
      await assert.rejects(chooseServerPorts({ otlp: ui, ui: await freePort(), mcp: await freePort() }, { ui: false, mcp: false }, ours), /OTLP port .* is in use/)
    } finally { restore(); await close(s); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
