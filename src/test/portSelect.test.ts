import * as assert from 'assert'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { mcpEndpoint } from '../cli/cliCore'
import { chooseServerPorts, isPortFree, pickPort, readChosenPort, writePortsFile } from '../cli/portSelect'
import { freePort } from './helpers/freePort'

// Real sockets, real files — no mocks. Each test that opens a listener closes it in finally.
const hold = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(port, '127.0.0.1', () => resolve(s))
})
const release = (s: net.Server): Promise<void> => new Promise(r => s.close(() => r()))
const never = async (): Promise<boolean> => false
const always = async (): Promise<boolean> => true

suite('portSelect', () => {
  test('a free port is returned unchanged, not switched', async () => {
    const p = await freePort()
    assert.deepStrictEqual(await pickPort(p, never), { port: p, switched: false })
  })

  test('a port held by another process yields a different free port, switched', async () => {
    const p = await freePort()
    const s = await hold(p)
    try {
      const r = await pickPort(p, never)
      assert.strictEqual(r.switched, true)
      assert.notStrictEqual(r.port, p)
      assert.strictEqual(await isPortFree(r.port), true)
    } finally { await release(s) }
  })

  test('a held port that is OURS is kept', async () => {
    const p = await freePort()
    const s = await hold(p)
    try {
      assert.deepStrictEqual(await pickPort(p, always), { port: p, switched: false })
    } finally { await release(s) }
  })

  test('an excluded port is never returned, even when free', async () => {
    const p = await freePort()
    const r = await pickPort(p, never, new Set([p]))
    assert.strictEqual(r.switched, true)
    assert.notStrictEqual(r.port, p)
  })

  test('ports.json round-trips and an absent file reads as undefined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portsel-'))
    try {
      assert.strictEqual(readChosenPort(dir, 'ui'), undefined)
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4317 })
      assert.deepStrictEqual([readChosenPort(dir, 'otlp'), readChosenPort(dir, 'ui'), readChosenPort(dir, 'mcp')], [4318, 3001, 4317])
      assert.deepStrictEqual(fs.readdirSync(dir), ['ports.json'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('env MCP_PORT beats ports.json; ports.json beats the default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portsel-'))
    const saved = { d: process.env.AGENTLENS_DATA_DIR, m: process.env.MCP_PORT, u: process.env.AGENTLENS_MCP_URL }
    try {
      process.env.AGENTLENS_DATA_DIR = dir
      delete process.env.AGENTLENS_MCP_URL
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4999 })
      delete process.env.MCP_PORT
      assert.strictEqual(mcpEndpoint(), 'http://localhost:4999/mcp')
      process.env.MCP_PORT = '5555'
      assert.strictEqual(mcpEndpoint(), 'http://localhost:5555/mcp')
    } finally {
      for (const [k, v] of [['AGENTLENS_DATA_DIR', saved.d], ['MCP_PORT', saved.m], ['AGENTLENS_MCP_URL', saved.u]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('OTLP held by a stranger refuses to start, naming the port; held by us it is kept', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portsel-'))
    const otlp = await freePort()
    const s = await hold(otlp)
    try {
      const pref = { otlp, ui: await freePort(), mcp: await freePort() }
      await assert.rejects(chooseServerPorts(pref, dir, never), (e: Error) => e.message.includes(`OTLP port ${otlp} is in use`) && e.message.includes('--install-otel'))
      assert.strictEqual((await chooseServerPorts(pref, dir, always)).otlp, otlp)
    } finally { await release(s); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('UI and MCP switch, never collide with each other or OTLP, and are persisted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portsel-'))
    const ui = await freePort()
    const s = await hold(ui)
    try {
      // MCP prefers the very port UI will scan to first, so only the exclude set keeps them apart.
      const pref = { otlp: await freePort(), ui, mcp: ui + 1 }
      const r = await chooseServerPorts(pref, dir, never)
      assert.strictEqual(new Set([r.otlp, r.ui, r.mcp]).size, 3)
      assert.notStrictEqual(r.ui, ui)
      assert.strictEqual(readChosenPort(dir, 'ui'), r.ui)
      assert.strictEqual(readChosenPort(dir, 'mcp'), r.mcp)
    } finally { await release(s); fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
