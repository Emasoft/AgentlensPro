// ts-recovery migration v1 -> v2 (TRDD-K3WDPR7M #56) — adversarial tests. This migration REWRITES
// the bodies table of the real 270 MB store, so the tests exercise the loss/corruption rails as hard
// as the happy path: an alias to a missing body must ABORT with the live store untouched, and a pure
// copy must be byte-faithful.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, openStore } from '../store/db'
import { bodyIdOf, ingestBody } from '../store/bodyStore'
import { CURRENT_SCHEMA, migrateStore, readManifest, writeManifest } from '../store/migrate'
import { emptyCorrections, makeTsRecoveryMigration, parseIdxTsMap, TsCorrections } from '../store/tsRecovery'
import { verifyBodyInStore } from '../store/verifyInStore'

function synthBody(tag: string): string {
  const tools = Array.from({ length: 4 }, (_, i) => ({ name: `tool_${i}`, schema: 'x'.repeat(300) }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages: [{ role: 'user', content: `q ${tag}` }] })
}

const CAPTURE = Date.UTC(2026, 6, 9, 6, 0, 0)   // the TRUE capture time
const INGEST = Date.UTC(2026, 6, 14, 19, 54, 0) // the wrong ingest-batch stamp the backfill wrote

/** Build a v1 store with two bodies mis-stamped at INGEST time + one correct body. */
async function seedStore(dir: string): Promise<{ rawA: string; rawB: string; rawC: string }> {
  const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  const rawA = synthBody('a'); const rawB = synthBody('b'); const rawC = synthBody('c')
  await ingestBody(store, 'a.request.json', rawA, INGEST)          // wrong ts, recoverable from idx
  await ingestBody(store, 'req_B.response.json', rawB, INGEST)     // wrong ts, recoverable from idx
  await ingestBody(store, 'c.request.json', rawC, CAPTURE + 7000)  // already correct — must survive as-is
  await flush(store)
  await store.close()
  writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
  return { rawA, rawB, rawC }
}

async function bodyTs(dir: string, srcName: string): Promise<number> {
  const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  try {
    const rows = (await store.con.runAndReadAll(
      `SELECT CAST(epoch_ms(ts) AS BIGINT) AS ts_ms FROM read_parquet(['${dir.replace(/'/g, "''")}/bodies/*.parquet']) WHERE src_name = '${srcName}'`,
    )).getRowObjects()
    assert.strictEqual(rows.length, 1, `expected exactly one row for ${srcName}`)
    return Number(rows[0].ts_ms)
  } finally { await store.close() }
}

suite('parseIdxTsMap — the .idx is the ground truth feeding a whole-table rewrite', () => {
  test('parses NDJSON entries and keeps the LAST mtime for a duplicated name', async () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-idx-')), 'x.wad.idx')
    fs.writeFileSync(p, [
      JSON.stringify({ n: 'a.request.json', o: 0, l: 10, s: 20, m: 111 }),
      JSON.stringify({ n: 'b.request.json', o: 10, l: 10, s: 20, m: 222 }),
      JSON.stringify({ n: 'a.request.json', o: 20, l: 10, s: 20, m: 333 }),
      '',
    ].join('\n'))
    const map = await parseIdxTsMap([p])
    assert.strictEqual(map.size, 2)
    assert.strictEqual(map.get('a.request.json'), 333)
    assert.strictEqual(map.get('b.request.json'), 222)
  })

  test('THROWS on a malformed idx line — silently skipping it would silently not correct rows', async () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-idx-')), 'bad.wad.idx')
    fs.writeFileSync(p, '{"n":"a.request.json"}\n') // no m
    await assert.rejects(() => parseIdxTsMap([p]), /malformed idx line/)
  })
})

suite('ts-recovery migration — corrects what the .idx proves, refuses what it cannot prove', () => {
  let dir: string
  setup(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-mig-')), 'store') })

  test('corrects mis-stamped rows, leaves correct rows alone, adds alias rows — with the old store kept', async () => {
    const { rawA, rawB } = await seedStore(dir)
    const c: TsCorrections = {
      tsBySrcName: new Map([
        ['a.request.json', CAPTURE],
        ['req_B.response.json', CAPTURE + 60_000],
      ]),
      // The same content as rawA was ALSO archived under a second name — v2 materializes its row.
      aliases: [{ srcName: 'alias-of-a.request.json', bodyId: bodyIdOf(rawA), tsMs: CAPTURE + 5_000 }],
    }
    const r = await migrateStore(dir, { migrations: [makeTsRecoveryMigration(c)] })
    assert.strictEqual(r.error, undefined)
    assert.strictEqual(r.migrated, true)
    assert.strictEqual(r.toVersion, CURRENT_SCHEMA)
    assert.strictEqual(r.missing.length, 0)
    assert.ok(r.validation?.valid, 'framework verify #1 must have run and passed')
    assert.strictEqual(readManifest(dir).schemaVersion, CURRENT_SCHEMA)
    assert.ok(fs.existsSync(r.backupDir!), 'the v1 store must be KEPT')

    assert.strictEqual(await bodyTs(dir, 'a.request.json'), CAPTURE)
    assert.strictEqual(await bodyTs(dir, 'req_B.response.json'), CAPTURE + 60_000)
    assert.strictEqual(await bodyTs(dir, 'c.request.json'), CAPTURE + 7000)
    assert.strictEqual(await bodyTs(dir, 'alias-of-a.request.json'), CAPTURE + 5_000)

    // The migrated store satisfies the universal delete gate for BOTH names of the deduped content —
    // this is exactly what later authorizes the .wad reclamation.
    const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      assert.strictEqual((await verifyBodyInStore(store, 'a.request.json', rawA, CAPTURE)).ok, true)
      assert.strictEqual((await verifyBodyInStore(store, 'alias-of-a.request.json', rawA, CAPTURE + 5_000)).ok, true)
      assert.strictEqual((await verifyBodyInStore(store, 'req_B.response.json', rawB, CAPTURE + 60_000)).ok, true)
    } finally { await store.close() }
  })

  test('ABORTS on an alias naming a body the store does not hold — live store untouched', async () => {
    await seedStore(dir)
    const before = fs.readdirSync(path.join(dir, 'bodies')).sort()
    const c: TsCorrections = {
      tsBySrcName: new Map(),
      aliases: [{ srcName: 'phantom.request.json', bodyId: 'f'.repeat(64), tsMs: CAPTURE }],
    }
    const r = await migrateStore(dir, { migrations: [makeTsRecoveryMigration(c)] })
    assert.strictEqual(r.migrated, false)
    assert.match(r.error!, /no such body in the store/)
    assert.strictEqual(readManifest(dir).schemaVersion, 1, 'manifest must still say v1')
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'bodies')).sort(), before, 'live parts untouched')
  })

  test('empty corrections = pure copy: every row survives byte-faithful (fresh-store upgrade path)', async () => {
    await seedStore(dir)
    const r = await migrateStore(dir, { migrations: [makeTsRecoveryMigration(emptyCorrections())] })
    assert.strictEqual(r.error, undefined)
    assert.strictEqual(r.migrated, true)
    assert.strictEqual(r.missing.length, 0)
    assert.strictEqual(await bodyTs(dir, 'a.request.json'), INGEST) // unchanged — no correction claimed
  })

  test('a pre-manifest (schema 0) store migrates 0 -> 2 through the same chain', async () => {
    await seedStore(dir)
    fs.rmSync(path.join(dir, 'manifest.json'))
    const r = await migrateStore(dir, { migrations: [makeTsRecoveryMigration(emptyCorrections())] })
    assert.strictEqual(r.error, undefined)
    assert.strictEqual(readManifest(dir).schemaVersion, CURRENT_SCHEMA)
  })
})
