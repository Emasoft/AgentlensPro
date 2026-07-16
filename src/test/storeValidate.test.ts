// The validator is the gate that authorizes DELETING the user's data and SWAPPING a migrated store
// over the live one. A validator that can be fooled is worse than none — it launders a corrupt store
// into a trusted one.
//
// So these tests are ADVERSARIAL: they deliberately corrupt a store in each way it can actually break
// and prove the validator REFUSES it. A suite that only checks "a good store validates" proves
// nothing about the only case that matters.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openStore, flush, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { validateStore } from '../store/validate'
import {
  CURRENT_SCHEMA, MIGRATIONS, Migration, migrateStore, readManifest, writeManifest,
} from '../store/migrate'
import { sha256 } from '../store/sections'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-val-')) }

function body(turn: number): string {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, schema: 'x'.repeat(400) }))
  const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(300)}` }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages })
}

/** A populated, flushed store. */
async function seeded(n = 5): Promise<{ dir: string; store: Store; raws: string[] }> {
  const dir = tmp()
  const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  const raws: string[] = []
  for (let i = 1; i <= n; i++) {
    const raw = body(i)
    raws.push(raw)
    await ingestBody(store, `b${i}.request.json`, raw)
  }
  await flush(store)
  return { dir, store, raws }
}

suite('validateStore — a healthy store', () => {
  test('passes both checks and reports honest counts', async () => {
    const { store } = await seeded(6)
    try {
      const r = await validateStore(store)
      assert.strictEqual(r.valid, true, r.errors.join('; '))
      assert.strictEqual(r.bodies, 6)
      assert.strictEqual(r.bodiesOk, 6)
      assert.strictEqual(r.blobsOk, r.blobs)
      assert.strictEqual(r.danglingRefs, 0)
    } finally { await store.close() }
  })

  test('an EMPTY store is NOT valid — "nothing to check" must never read as "all good"', async () => {
    // The dangerous default: a store that failed to load anything would otherwise sail through the
    // gate and authorize deleting the source data it never actually ingested.
    const store = await openStore({ dir: tmp(), memoryLimit: '2GB', threads: 2 })
    try {
      assert.strictEqual((await validateStore(store)).valid, false)
    } finally { await store.close() }
  })
})

suite('validateStore — ADVERSARIAL: it must REFUSE a corrupt store', () => {
  test('a CORRUPTED SPAN is caught (content no longer hashes to its own address)', async () => {
    const { store } = await seeded(4)
    try {
      assert.strictEqual((await validateStore(store)).valid, true)
      // A span whose bytes no longer match its content-address — exactly what a bad Parquet page, a
      // truncated write, or a botched encoding round trip produces. The STRUCTURE is still perfect;
      // only the bytes are wrong, which is the case a structural checker would wave through.
      await store.con.run(`INSERT INTO blob VALUES ('${'0'.repeat(64)}', 5, 'wrong')`)

      const r = await validateStore(store)
      assert.strictEqual(r.valid, false, 'a span whose content does not match its hash MUST fail')
      assert.ok(r.errors.some((e) => /CORRUPT|hashes to/.test(e)), r.errors.join('; '))
      assert.ok(r.blobsOk < r.blobs)
    } finally { await store.close() }
  })

  test('a DANGLING REFERENCE is caught (a body that cannot be rebuilt)', async () => {
    const { store } = await seeded(3)
    try {
      // A part pointing at a span that is not there — what a lost/never-flushed Parquet part looks like.
      await store.con.run(`INSERT INTO part VALUES ('ghost', 0, 'blob', NULL, 'deadbeef', 'messages', 0, 10)`)
      const r = await validateStore(store)
      assert.strictEqual(r.valid, false)
      assert.ok(r.danglingRefs > 0)
    } finally { await store.close() }
  })

  test('a body whose parts were REORDERED is caught — structure alone proves nothing', async () => {
    // Every span is individually perfect and every reference resolves; only the ASSEMBLY is wrong.
    // Precisely what V1 cannot see, and the reason V2 exists: reassembling the SAME spans in the wrong
    // ORDER yields different bytes, so the sha256 no longer equals the body_id.
    const store = await openStore({ dir: tmp(), memoryLimit: '2GB', threads: 2 })
    try {
      const r = await ingestBody(store, 'x.request.json', body(4))
      assert.strictEqual((await validateStore(store)).valid, true)

      await store.con.run(`
        UPDATE part SET pos = CASE WHEN pos = 0 THEN 1 WHEN pos = 1 THEN 0 ELSE pos END
        WHERE body_id = '${r.bodyId}'
      `)

      const v = await validateStore(store)
      assert.strictEqual(v.valid, false, 'a reordered body MUST fail — its bytes are no longer the original')
      assert.strictEqual(v.blobsOk, v.blobs, 'every SPAN is still perfect — only the assembly is wrong')
      assert.ok(v.bodiesOk < v.bodies)
    } finally { await store.close() }
  })

  test('the verdict rests on the ORIGINAL file hash, which the store cannot forge', async () => {
    // body_id is sha256 of the SOURCE FILE, taken at ingest before anything was stored. So V2 compares
    // today's reconstruction against a fingerprint of bytes that exist nowhere else. No amount of
    // internal self-consistency can satisfy it.
    const dir = tmp()
    const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      const raw = body(4)
      const r = await ingestBody(store, 'x.request.json', raw)
      assert.strictEqual(r.bodyId, sha256(raw))
    } finally { await store.close() }
  })
})

suite('store migration — a schema change must never corrupt or lose the corpus', () => {
  teardown(() => { MIGRATIONS.length = 0 }) // the registry is global — never leak a fake step

  test('an unversioned store is stamped v1 without touching any data', async () => {
    const { dir, store, raws } = await seeded(4)
    await store.close()
    assert.strictEqual(readManifest(dir).schemaVersion, 0, 'a store with no manifest is schema 0')

    const r = await migrateStore(dir)
    assert.strictEqual(r.error, undefined)
    assert.strictEqual(readManifest(dir).schemaVersion, CURRENT_SCHEMA)

    const re = await openStore({ dir })
    try {
      const v = await validateStore(re)
      assert.strictEqual(v.valid, true)
      assert.strictEqual(v.bodies, raws.length, 'no body may be lost by a stamp')
    } finally { await re.close() }
  })

  test('a store from a NEWER build is REFUSED, not downgraded', async () => {
    // Migrating "down" would silently discard whatever the newer build knew and we do not.
    const dir = tmp()
    writeManifest(dir, { schemaVersion: CURRENT_SCHEMA + 5, createdAt: new Date().toISOString() })
    const r = await migrateStore(dir)
    assert.strictEqual(r.migrated, false)
    assert.ok(/refusing/i.test(r.error ?? ''), r.error)
  })

  test('an UNREADABLE manifest is a hard error — never assumed to be "schema 0"', async () => {
    // Treating it as 0 would migrate a store whose real version we do not know. That is how you
    // corrupt one.
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not json')
    assert.throws(() => readManifest(dir), /unreadable/)
  })

  /** Copy the whole store v1 -> v2, optionally sabotaged. This is a REAL migration, so the safety
   *  rails are exercised for real rather than asserted in the abstract. */
  function copyMigration(sabotage: 'none' | 'drop-bodies' | 'corrupt-spans'): Migration {
    return {
      from: 1, to: 2, describe: `copy (${sabotage})`,
      async up(from, to) {
        const pq = (sub: string) => {
          const files = fs.readdirSync(path.join(from.dir, sub)).filter((f) => f.endsWith('.parquet'))
          return `read_parquet([${files.map((f) => `'${path.join(from.dir, sub, f)}'`).join(',')}])`
        }
        const ids = (await from.con.runAndReadAll(`SELECT DISTINCT body_id FROM ${pq('bodies')}`))
          .getRowObjects().map((x) => String(x.body_id))
        const keep = (sabotage === 'drop-bodies' ? ids.slice(0, Math.floor(ids.length / 2)) : ids)
          .map((i) => `'${i}'`).join(',')

        // A realistic corruption: the spans survive the copy with their bytes mangled (a bad encoding
        // round trip). Structure is perfect; content is not.
        const blobSel = sabotage === 'corrupt-spans'
          ? `SELECT sha, n, replace(data, 'y', 'Z') AS data FROM ${pq('blobs')}`
          : `SELECT * FROM ${pq('blobs')}`

        await to.con.run(`INSERT INTO blob ${blobSel}`)
        await to.con.run(`INSERT INTO body SELECT * FROM ${pq('bodies')} WHERE body_id IN (${keep})`)
        await to.con.run(`INSERT INTO part SELECT * FROM ${pq('parts')} WHERE body_id IN (${keep})`)
        for (const [t, sub] of [['blob', 'blobs'], ['body', 'bodies'], ['part', 'parts']] as const) {
          await to.con.run(`COPY ${t} TO '${path.join(to.dir, sub, 'part-000000.parquet')}' (FORMAT PARQUET, COMPRESSION ZSTD)`)
          await to.con.run(`DELETE FROM ${t}`)
        }
      },
    }
  }

  /** The live store must still hold every body, byte-perfect. Asserted after every failed migration. */
  async function assertLiveIntact(dir: string, n: number): Promise<void> {
    const re = await openStore({ dir })
    try {
      const v = await validateStore(re)
      assert.strictEqual(v.valid, true, `the live store must be untouched: ${v.errors.join('; ')}`)
      assert.strictEqual(v.bodies, n, 'no body may be lost by a FAILED migration')
    } finally { await re.close() }
  }

  test('A GOOD migration swaps, and KEEPS the old store as a backup', async () => {
    const { dir, store, raws } = await seeded(5)
    await store.close()
    writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
    MIGRATIONS.push(copyMigration('none'))

    const r = await migrateStore(dir, { target: 2 })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.migrated, true)
    assert.strictEqual(readManifest(dir).schemaVersion, 2)
    assert.deepStrictEqual(r.missing, [])
    assert.ok(r.backupDir && fs.existsSync(r.backupDir), 'the previous store must be KEPT, never deleted')
    await assertLiveIntact(dir, raws.length)
  })

  test('A MIGRATION THAT LOSES BODIES IS REJECTED — and the live store is untouched', async () => {
    // THE test. A migration that drops half the corpus passes CONTENT validation with flying colours:
    // everything it kept hashes perfectly. Only comparing the id SETS catches it. This is exactly why
    // verification #1 alone is not enough.
    const { dir, store, raws } = await seeded(6)
    await store.close()
    writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
    MIGRATIONS.push(copyMigration('drop-bodies'))

    const r = await migrateStore(dir, { target: 2 })
    assert.strictEqual(r.migrated, false)
    assert.ok(/LOST/.test(r.error ?? ''), r.error)
    assert.ok(r.missing.length > 0, 'the lost bodies must be NAMED, not just counted')
    assert.strictEqual(readManifest(dir).schemaVersion, 1, 'the live store must not be re-stamped')
    await assertLiveIntact(dir, raws.length)
  })

  test('A MIGRATION THAT CORRUPTS SPANS IS REJECTED — and the live store is untouched', async () => {
    // Nothing is missing; every body and part is present. Only the BYTES changed. Verification #2
    // catches it because body_id is the hash of the ORIGINAL file and cannot be forged.
    const { dir, store, raws } = await seeded(5)
    await store.close()
    writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
    MIGRATIONS.push(copyMigration('corrupt-spans'))

    const r = await migrateStore(dir, { target: 2 })
    assert.strictEqual(r.migrated, false)
    assert.ok(/FAILED validation/.test(r.error ?? ''), r.error)
    assert.strictEqual(readManifest(dir).schemaVersion, 1)
    await assertLiveIntact(dir, raws.length)
  })

  test('a failed migration leaves the STAGING dir for inspection, and never a blended store', async () => {
    const { dir, store } = await seeded(4)
    await store.close()
    writeManifest(dir, { schemaVersion: 1, createdAt: new Date().toISOString() })
    MIGRATIONS.push(copyMigration('drop-bodies'))

    const r = await migrateStore(dir, { target: 2 })
    assert.strictEqual(r.migrated, false)
    assert.ok(fs.existsSync(`${dir}.migrating`), 'staging is kept so a human can see what went wrong')
    assert.ok(!fs.existsSync(`${dir}.old-v1`), 'nothing was swapped, so no backup should exist')
  })
})
