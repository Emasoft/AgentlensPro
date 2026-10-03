import * as assert from 'assert'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { ApiRequestError, apiRequest, isConnectFailure, PROBE_TIMEOUT_MS } from '../cli/cliCore'
import { showStatus } from '../cli/serverControl'
import { runStoreCli } from '../cli/storeAdmin'
import { effectiveBodiesDir } from '../captureConfig'
import { freePort } from './helpers/freePort'

// Real sockets, no mocks. console output is only CAPTURED (never altered) so the verdict text can be asserted.
const held = new WeakMap<net.Server, net.Socket[]>()
const silentListener = (): Promise<net.Server> => new Promise(resolve => {
  const socks: net.Socket[] = []
  const s = net.createServer(sock => { socks.push(sock); sock.on('error', () => undefined) }) // accept, never answer
  held.set(s, socks)
  s.listen(0, '127.0.0.1', () => resolve(s))
})
const close = (s: net.Server): Promise<void> => new Promise(r => { held.get(s)?.forEach(k => k.destroy()); s.close(() => r()) })

async function capture(fn: () => Promise<unknown>): Promise<{ out: string; err: string; ret: unknown }> {
  const log = console.log, error = console.error
  let out = '', err = ''
  console.log = (...a: unknown[]) => { out += a.join(' ') + '\n' }
  console.error = (...a: unknown[]) => { err += a.join(' ') + '\n' }
  try { const ret = await fn(); return { out, err, ret } } finally { console.log = log; console.error = error }
}

suite('status / store-guard classification of apiRequest failures (typed codes, TRDD-9VX3WTGU A6)', () => {
  const saved = { d: process.env.AGENTLENS_DATA_DIR, u: process.env.AGENTLENS_UI_URL }
  let dir = ''
  const setEnv = (k: 'AGENTLENS_DATA_DIR' | 'AGENTLENS_UI_URL', v: string | undefined): void => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apist-'))
    process.env.AGENTLENS_DATA_DIR = dir
  })
  teardown(() => {
    setEnv('AGENTLENS_DATA_DIR', saved.d); setEnv('AGENTLENS_UI_URL', saved.u)
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const lockOwnedByUs = (): void => fs.writeFileSync(path.join(dir, 'server.pid'), String(process.pid))
  /** A data dir with one parked name whose file exists, so runStoreCli reaches the server guard. */
  const parkedStore = (): void => {
    fs.mkdirSync(path.join(dir, 'store'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'store', '.pass-state.json'), JSON.stringify({ strandedNames: ['parked.json'] }))
    fs.mkdirSync(effectiveBodiesDir(dir), { recursive: true })
    fs.writeFileSync(path.join(effectiveBodiesDir(dir), 'parked.json'), '{}')
  }

  test('nothing listening: ECONNFAIL, status says NOT RUNNING', async () => {
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${await freePort()}`
    await assert.rejects(apiRequest('GET', '/api/server-stats', undefined, PROBE_TIMEOUT_MS), (e: unknown) => e instanceof ApiRequestError && e.code === 'ECONNFAIL' && isConnectFailure(e))
    const { out } = await capture(showStatus)
    assert.match(out, /server: NOT RUNNING/)
  })

  test('🐌 a connect that times out (blackholed address): ECONNTIMEOUT, status says NOT RUNNING, never RUNNING', async function () {
    this.timeout(30_000)
    const drops = await new Promise<boolean>(res => {
      const s = net.connect({ host: '10.255.255.1', port: 3000 })
      const t = setTimeout(() => { s.destroy(); res(true) }, 1_200)
      t.unref?.()
      s.on('error', () => { clearTimeout(t); s.destroy(); res(false) })
      s.on('connect', () => { clearTimeout(t); s.destroy(); res(false) })
    })
    if (!drops) { this.skip(); return }
    process.env.AGENTLENS_UI_URL = 'http://10.255.255.1:3000'
    await assert.rejects(apiRequest('GET', '/api/server-stats', undefined, PROBE_TIMEOUT_MS), (e: unknown) => e instanceof ApiRequestError && e.code === 'ECONNTIMEOUT' && isConnectFailure(e))
    const { out } = await capture(showStatus)
    assert.match(out, /server: NOT RUNNING \(no connection to/)
    assert.doesNotMatch(out, /RUNNING but|accepted the connection/)
  })

  test('🐌 a TCP-silent listener: ERESPONSETIMEOUT, status says accepted-but-not-answering (not RUNNING)', async function () {
    this.timeout(30_000)
    const s = await silentListener()
    try {
      process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`
      await assert.rejects(apiRequest('GET', '/api/server-stats', undefined, 400), (e: unknown) => e instanceof ApiRequestError && e.code === 'ERESPONSETIMEOUT' && !isConnectFailure(e))
      const { out } = await capture(showStatus)
      assert.match(out, /accepted the connection but is not answering/)
      assert.doesNotMatch(out, /server: RUNNING|NOT RUNNING/)
    } finally { await close(s) }
  })

  test('🐌 a live lock owner + a silent listener: status says RUNNING (pid N) — did not answer … (busy?)', async function () {
    this.timeout(30_000)
    lockOwnedByUs()
    const s = await silentListener()
    try {
      process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`
      const { out } = await capture(showStatus)
      assert.match(out, new RegExp(`server: RUNNING \\(pid ${process.pid}\\) — did not answer within \\d+s \\(busy\\?\\)`))
    } finally { await close(s) }
  })

  test('store repair guard: a live lock owner is refused without needing any probe to answer', async () => {
    parkedStore(); lockOwnedByUs()
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${await freePort()}` // nothing listens: the lock alone must refuse
    const { err, ret } = await capture(() => runStoreCli(['repair-parked']))
    assert.strictEqual(ret, 1)
    assert.match(err, /REFUSED: the server is running/)
  })

  test('🐌 store repair guard: a TCP-silent listener (response timeout) counts as UP and is refused', async function () {
    this.timeout(30_000)
    parkedStore()
    const s = await silentListener()
    try {
      process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${(s.address() as net.AddressInfo).port}`
      const { err, ret } = await capture(() => runStoreCli(['repair-parked']))
      assert.strictEqual(ret, 1)
      assert.match(err, /REFUSED: the server is running/)
    } finally { await close(s) }
  })

  test('store repair guard: nothing listening and no lock proceeds past the server check', async () => {
    parkedStore()
    process.env.AGENTLENS_UI_URL = `http://127.0.0.1:${await freePort()}`
    const { err } = await capture(() => runStoreCli(['repair-parked']))
    // It may still stop at a LATER gate (a real writer process on this machine, the revive brake) — only the server-up refusal is excluded.
    assert.doesNotMatch(err, /REFUSED: the server is running/)
  })
})
