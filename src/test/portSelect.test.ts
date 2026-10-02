import * as assert from 'assert'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { mcpEndpoint } from '../cli/cliCore'
import { chooseServerPorts, isPortFree, pickPort, readChosenPort, writePortsFile } from '../cli/portSelect'
import { freePort } from './helpers/freePort'

// Real sockets, real files — no mocks. Each test that opens a listener closes it in finally.
const hold = (port: number, host = '127.0.0.1'): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(port, host, () => resolve(s))
})
const release = (s: net.Server): Promise<void> => new Promise(r => s.close(() => r()))
const never = async (): Promise<boolean> => false
const always = async (): Promise<boolean> => true
const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'portsel-'))
/** A server.pid naming a live process (this one) — the legacy bare-number lock shape. */
const livePidfile = (dir: string): void => fs.writeFileSync(path.join(dir, 'server.pid'), String(process.pid))
/** A pid that provably belonged to a process that has exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' })
  return Number(r.stdout)
}
const none = { ui: false, mcp: false }

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

  test('a port held on ::1 only still counts as in use (clients say localhost)', async function () {
    const p = await freePort()
    let s: net.Server
    try { s = await hold(p, '::1') } catch { this.skip() }
    try { assert.strictEqual(await isPortFree(p), false) } finally { await release(s) }
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

  test('ports.json is read while server.pid names a live process, and absent reads undefined', () => {
    const dir = tmpDir()
    try {
      assert.strictEqual(readChosenPort(dir, 'ui'), undefined)
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4317 })
      livePidfile(dir)
      assert.deepStrictEqual([readChosenPort(dir, 'otlp'), readChosenPort(dir, 'ui'), readChosenPort(dir, 'mcp')], [4318, 3001, 4317])
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['ports.json', 'server.pid'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('a stale ports.json (server.pid names a dead process, or is missing) is ignored', () => {
    const dir = tmpDir()
    try {
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4317 })
      assert.strictEqual(readChosenPort(dir, 'ui'), undefined)
      fs.writeFileSync(path.join(dir, 'server.pid'), String(deadPid()))
      assert.strictEqual(readChosenPort(dir, 'ui'), undefined)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  test('env MCP_PORT beats ports.json; live ports.json beats the default; stale one does not', () => {
    const dir = tmpDir()
    const saved = { d: process.env.AGENTLENS_DATA_DIR, m: process.env.MCP_PORT, u: process.env.AGENTLENS_MCP_URL }
    try {
      process.env.AGENTLENS_DATA_DIR = dir
      delete process.env.AGENTLENS_MCP_URL
      delete process.env.MCP_PORT
      writePortsFile(dir, { otlp: 4318, ui: 3001, mcp: 4999 })
      assert.strictEqual(mcpEndpoint(), 'http://localhost:4316/mcp') // no live pidfile: stale file ignored
      livePidfile(dir)
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

  test('OTLP held by a stranger refuses, naming port + holder pid + remedy; held by us it is kept', async () => {
    const otlp = await freePort()
    const s = await hold(otlp)
    try {
      const pref = { otlp, ui: await freePort(), mcp: await freePort() }
      await assert.rejects(chooseServerPorts(pref, none, never), (e: Error) =>
        e.message.includes(`OTLP port ${otlp} is in use by pid ${process.pid}`) && e.message.includes('--install-otel'))
      assert.strictEqual((await chooseServerPorts(pref, none, always)).otlp, otlp)
    } finally { await release(s) }
  })

  test('an env-pinned UI/MCP port that is held refuses (naming the env var and holder); unpinned switches', async () => {
    const ui = await freePort()
    const s = await hold(ui)
    try {
      const pref = { otlp: await freePort(), ui, mcp: await freePort() }
      await assert.rejects(chooseServerPorts(pref, { ui: true, mcp: false }, never), (e: Error) =>
        e.message.includes(`UI port ${ui} is in use by pid ${process.pid}`) && e.message.includes('UI_PORT'))
      const r = await chooseServerPorts(pref, none, never)
      assert.notStrictEqual(r.ui, ui)
      const pinnedMcp = { ...pref, ui: await freePort(), mcp: ui }
      await assert.rejects(chooseServerPorts(pinnedMcp, { ui: false, mcp: true }, never), /MCP port .* MCP_PORT/s)
    } finally { await release(s) }
  })

  test('a pinned port that is free is kept exactly', async () => {
    const pref = { otlp: await freePort(), ui: await freePort(), mcp: await freePort() }
    assert.deepStrictEqual(await chooseServerPorts(pref, { ui: true, mcp: true }, never), pref)
  })

  test('on collision UI and MCP never share a port with each other or OTLP (exclude set)', async () => {
    const ui = await freePort()
    const s = await hold(ui)
    try {
      // MCP prefers the very port UI scans to first, so only the exclude set keeps them apart.
      const r = await chooseServerPorts({ otlp: await freePort(), ui, mcp: ui + 1 }, none, never)
      assert.strictEqual(new Set([r.otlp, r.ui, r.mcp]).size, 3)
      assert.notStrictEqual(r.ui, ui)
    } finally { await release(s) }
  })
})
