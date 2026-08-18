// src/test/rustStore.test.ts — P3c cross-engine store compatibility (TRDD-DMWOBWFH): the
// Parquet parts are the boundary — a store written by the TS engine must reconstruct
// byte-identically through the Rust engine, and vice versa, including on REAL captured bodies.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { openStore } from '../store/db'
import { ingestBody, reconstructBody, bodyIdOf } from '../store/bodyStore'
import { flushDetailed } from '../store/db'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'alstore')
const haveBin = fs.existsSync(BIN)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-xstore-'))

function realBody(): { raw: string; name: string } | null {
  for (const dir of ['/Volumes/AgentLensSpool/otel-bodies', path.join(os.homedir(), '.agentlens', 'otel-bodies')]) {
    try {
      const f = fs.readdirSync(dir).find(n => n.endsWith('.request.json'))
      if (f) return { raw: fs.readFileSync(path.join(dir, f), 'utf8'), name: f }
    } catch { /* try next */ }
  }
  return null
}

suite('rustStore — P3c cross-engine store compatibility', () => {
  const xTest = haveBin ? test : test.skip

  xTest('🐌 a TS-written store reconstructs byte-identically through the Rust engine (real body)', async function () {
    this.timeout(60_000)
    const body = realBody()
    if (!body) this.skip()
    const dir = path.join(tmpDir, 'ts-written')
    const store = await openStore({ dir, memoryLimit: '1GB', threads: 4 })
    try {
      const ts = Date.now() - 60_000
      const r = await ingestBody(store, body!.name, body!.raw, ts)
      await flushDetailed(store)
      const back = execFileSync(BIN, ['reconstruct', dir, r.bodyId], { maxBuffer: 1 << 28 }).toString()
      assert.strictEqual(back, body!.raw, 'Rust must return the exact bytes the TS store was given')
      const verdict = JSON.parse(execFileSync(BIN,
        ['verify', dir, body!.name, writeTmp(body!.raw), '--ts-ms', String(ts)], { maxBuffer: 1 << 26 }).toString())
      assert.strictEqual(verdict.ok, true, `Rust verify gate must pass on the TS-written store: ${verdict.reason}`)
    } finally { await store.close() }
  })

  xTest('🐌 a Rust-written store reconstructs byte-identically through the TS engine', async function () {
    this.timeout(60_000)
    const body = realBody() ?? { raw: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'y'.repeat(300) }] }), name: 'synth.request.json' }
    const dir = path.join(tmpDir, 'rust-written')
    const src = writeTmp(body.raw)
    execFileSync(BIN, ['ingest', dir, src, '--ts-ms', String(Date.now() - 60_000)], { maxBuffer: 1 << 26 })
    const store = await openStore({ dir, memoryLimit: '1GB', threads: 4 })
    try {
      const back = await reconstructBody(store, bodyIdOf(body.raw))
      assert.strictEqual(back, body.raw, 'TS must return the exact bytes the Rust store was given')
    } finally { await store.close() }
  })
})

function writeTmp(raw: string): string {
  const f = path.join(tmpDir, `body-${Math.random().toString(36).slice(2)}.request.json`)
  fs.writeFileSync(f, raw)
  return f
}
