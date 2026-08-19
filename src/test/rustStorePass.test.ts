// src/test/rustStorePass.test.ts — P4b engine bridge (TRDD-DMWOBWFH): the server-side wiring
// that execs `alstore pass` instead of the TS in-process ingestPass. Cross-engine parity on a
// fixture bodies dir, the routing/fail-fast contract, and the live-visibility claim the server
// wiring rests on (an OPEN TS store handle sees parts a separate Rust process wrote).
//
// The binary comes from the repo's own cargo build (rust-core/target/release/alstore). CI has no
// Rust toolchain, so those tests surface as PENDING there (visible, never silently green).

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { alstoreBin, rustIngestPass } from '../rustStorePass'
import { ingestPass } from '../store/ingestPass'
import { openStore, allOf } from '../store/db'
import { reconstructBody, bodyIdOf } from '../store/bodyStore'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'alstore')
const haveBin = fs.existsSync(BIN)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-rustpass-'))

const OLD_RAW = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'x'.repeat(400) }] })
const FRESH_RAW = JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'fresh'.repeat(80) }] })

/** A bodies dir with one aged-out body (must be ingested+reclaimed) and one fresh body (must be
 *  left alone under maxAgeMs) — the same live-window split the server's drain relies on. */
function makeBodiesDir(name: string): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const oldFile = path.join(dir, 'old-turn.request.json')
  fs.writeFileSync(oldFile, OLD_RAW)
  const oldSec = (Date.now() - 10 * 60_000) / 1000
  fs.utimesSync(oldFile, oldSec, oldSec)
  fs.writeFileSync(path.join(dir, 'fresh-turn.request.json'), FRESH_RAW)
  return dir
}

suite('rustStorePass — P4b engine bridge', () => {
  const xTest = haveBin ? test : test.skip

  test('alstoreBin: env wins, else the durable install location, else off — never auto-detection', () => {
    const missing = path.join(tmpDir, 'no-such-bin')
    assert.strictEqual(alstoreBin({}, missing), null)
    assert.strictEqual(alstoreBin({ AGENTLENS_ALSTORE: '  ' }, missing), null)
    assert.strictEqual(alstoreBin({ AGENTLENS_ALSTORE: '/x/alstore' }, missing), '/x/alstore')
    const installed = path.join(tmpDir, 'alstore')
    fs.writeFileSync(installed, '#!/bin/sh\n')
    assert.strictEqual(alstoreBin({}, installed), installed, 'the installed file IS the opt-in')
  })

  test('a broken binary path THROWS — opted-in means loud, never a silent TS fallback', async () => {
    await assert.rejects(
      () => rustIngestPass('/definitely/not/a/binary', {
        storeDir: path.join(tmpDir, 's'), bodiesDir: path.join(tmpDir, 'b'),
        maxAgeMs: 0, maxBytesPerPass: 1 << 20, durableSource: true,
      }),
      /alstore pass failed/)
  })

  xTest('🐌 cross-engine pass parity: same drain decisions, same result fields, TS-readable store', async function () {
    this.timeout(60_000)
    const MAX_AGE = 60_000
    const bodiesTs = makeBodiesDir('bodies-ts')
    const bodiesRust = makeBodiesDir('bodies-rust')
    const storeTsDir = path.join(tmpDir, 'store-ts')
    const storeRustDir = path.join(tmpDir, 'store-rust')

    const storeTs = await openStore({ dir: storeTsDir, memoryLimit: '1GB', threads: 4 })
    let rTs
    try {
      rTs = await ingestPass({
        bodiesDir: bodiesTs, store: storeTs, maxAgeMs: MAX_AGE,
        maxBytesPerPass: 1 << 24, deleteAfter: true, durableSource: true,
      })
    } finally { await storeTs.close() }

    const rRust = await rustIngestPass(BIN, {
      storeDir: storeRustDir, bodiesDir: bodiesRust,
      maxAgeMs: MAX_AGE, maxBytesPerPass: 1 << 24, durableSource: true,
    })
    assert.ok(rRust, 'no other pass holds this fresh store — a null (flock) result would be a bug')

    // Same drain decisions, field-for-field on the counters the server aggregates.
    for (const k of ['ingested', 'deleted', 'reclaimedDurable', 'bytesIn', 'bytesFreed', 'throttled'] as const) {
      assert.deepStrictEqual(rRust[k], rTs[k], `result field ${k} must match across engines`)
    }
    assert.deepStrictEqual(rRust.failed, [], 'nothing may fail verification')
    assert.strictEqual(rRust.ingested, 1, 'exactly the aged-out body is ingested')
    assert.strictEqual(rRust.deleted, 1, 'exactly the aged-out body is reclaimed')

    // Both engines must have made the same on-disk drain: old gone, fresh untouched.
    for (const dir of [bodiesTs, bodiesRust]) {
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['fresh-turn.request.json'], `${dir} drain state`)
    }

    // The Rust-written store reads back byte-identically through the TS engine.
    const back = await openStore({ dir: storeRustDir, memoryLimit: '1GB', threads: 4 })
    try {
      assert.strictEqual(await reconstructBody(back, bodyIdOf(OLD_RAW)), OLD_RAW)
    } finally { await back.close() }

    // The binary persists its skip state where the next invocation will find it.
    const state = JSON.parse(fs.readFileSync(path.join(storeRustDir, '.pass-state.json'), 'utf8'))
    assert.ok(state.skipNames.includes('old-turn.request.json'), 'skip state must persist across invocations')
  })

  xTest('🐌 an OPEN TS store handle sees parts a separate Rust pass wrote — no reopen needed', async function () {
    this.timeout(60_000)
    const storeDir = path.join(tmpDir, 'store-live')
    const bodies = makeBodiesDir('bodies-live')
    const store = await openStore({ dir: storeDir, memoryLimit: '1GB', threads: 4 })
    try {
      const count = async () =>
        Number((await store.con.runAndReadAll(`SELECT count(*) AS c FROM ${allOf(store, 'body')}`)).getRowObjects()[0].c)
      assert.strictEqual(await count(), 0, 'empty before the Rust pass')
      await rustIngestPass(BIN, {
        storeDir, bodiesDir: bodies, maxAgeMs: 60_000, maxBytesPerPass: 1 << 24, durableSource: true,
      })
      // Same handle, no reopen: parquetScan re-lists the parts dir per query (the server wiring
      // depends on exactly this — bodyStore stays open for reads while the binary writes).
      assert.strictEqual(await count(), 1, 'the Rust-written part is visible to the open handle')
    } finally { await store.close() }
  })
})
