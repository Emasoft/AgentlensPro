// TRDD-TP3BA3ED — the TypeScript store twin must TOLERATE the Rust engine's `api_calls` table dir.
//
// The decision on the card is option 2: the Rust engine is the ONLY writer of `api_call` (the USER's
// standing ruling — DuckDB/parquet via Rust IS the memory), so this twin never writes that table.
// "Never writes it" is only safe if the twin also never TRIPS on it and never LOSES it, and the
// second half is the one with teeth: `stagedRewrite` swaps the whole store directory, so before this
// TRDD a migrate/repair would have left `api_calls` behind in the backup and handed the live store a
// store with zero api_call rows — silently, because both of the migration's verifies are body/blob
// only and would still have passed.
//
// Nothing here is mocked: a real store, a real DuckDB-written Parquet file in `api_calls/`, and the
// real validate / size / migrate paths.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { API_CALLS_DIR, flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { validateStore } from '../store/validate'
import { migrateStore, readManifest } from '../store/migrate'
import { emptyCorrections, makeTsRecoveryMigration } from '../store/tsRecovery'
import { queryStoreWriterTotals } from '../bodyWriters'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-apicalls-')) }

function body(turn: number): string {
  return JSON.stringify({
    model: 'claude-opus-4-8',
    tools: [{ name: 't', schema: 'x'.repeat(200) }],
    messages: Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(300)}` })),
  })
}

/** A populated, flushed store. */
async function seeded(dir: string, n: number): Promise<Store> {
  const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  for (let i = 1; i <= n; i++) await ingestBody(store, `b${i}.request.json`, body(i), 1_700_000_000_000 + i)
  await flush(store)
  return store
}

/**
 * Write a REAL Parquet file into `<dir>/api_calls/`, standing in for what `alstore` writes. Uses the
 * store's own DuckDB connection, so the file is genuinely readable Parquet rather than a named blob
 * — a fake would not prove the twin ignores a file DuckDB could otherwise be tempted to read.
 */
async function plantApiCallPart(store: Store, dir: string): Promise<string> {
  const d = path.join(dir, API_CALLS_DIR)
  fs.mkdirSync(d, { recursive: true })
  const p = path.join(d, 'part-1700000000000-1-0.parquet')
  await store.con.run(
    `COPY (SELECT 'msg_A' AS call_id, 'claude-opus-4-8' AS model, 42 AS input_tokens)
     TO '${p}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
  )
  return p
}

suite('TRDD-TP3BA3ED — the twin tolerates the Rust engine\'s api_calls dir', () => {
  test('validate and the size totals are IDENTICAL with and without the dir, and the parts are untouched', async () => {
    const withDir = tmp()
    const without = tmp()
    const a = await seeded(withDir, 5)
    const b = await seeded(without, 5)
    try {
      const part = await plantApiCallPart(a, withDir)
      const planted = fs.readFileSync(part)

      // The validator: a healthy store stays healthy, and every count matches the store that has no
      // api_calls dir at all. An extra directory must be inert, not merely survivable.
      const va = await validateStore(a)
      const vb = await validateStore(b)
      assert.strictEqual(va.valid, true, va.errors.join('; '))
      assert.deepStrictEqual(
        { bodies: va.bodies, bodiesOk: va.bodiesOk, blobs: va.blobs, blobsOk: va.blobsOk, dangling: va.danglingRefs },
        { bodies: vb.bodies, bodiesOk: vb.bodiesOk, blobs: vb.blobs, blobsOk: vb.blobsOk, dangling: vb.danglingRefs },
        'the api_calls dir must not add, drop or double-count anything the validator reports',
      )

      // The size path: same files, same bytes. A sum that walked the store root instead of the body
      // table would pick the api_call rows up here and inflate the corpus.
      const ta = await queryStoreWriterTotals(a, 0)
      const tb = await queryStoreWriterTotals(b, 0)
      assert.deepStrictEqual(
        ta.sessions.map(s => ({ files: s.files, bytes: s.bytes })),
        tb.sessions.map(s => ({ files: s.files, bytes: s.bytes })),
        'store size totals must be table-driven, so an extra table dir cannot change them',
      )
      assert.deepStrictEqual(ta.responses, tb.responses)

      // And nothing "repaired" it away: byte-identical, still the only file in the dir.
      assert.deepStrictEqual(fs.readdirSync(path.join(withDir, API_CALLS_DIR)), [path.basename(part)])
      assert.ok(planted.equals(fs.readFileSync(part)), 'the twin must never rewrite another engine\'s parts')
    } finally { await a.close(); await b.close() }
  })

  test('a REOPEN neither creates nor deletes api_calls — the twin asserts no writer it does not have', async () => {
    const dir = tmp()
    const first = await seeded(dir, 2)
    await first.close()
    // No api_calls dir yet: reopening must not invent one (that would claim a writer this engine
    // does not have, and an empty table dir reads as "the Rust pass ran and found nothing").
    const reopened = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    let part: string
    try {
      assert.strictEqual(fs.existsSync(path.join(dir, API_CALLS_DIR)), false)
      part = await plantApiCallPart(reopened, dir)
    } finally { await reopened.close() }

    const again = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      assert.ok(fs.existsSync(part), 'reopening a store must never remove another engine\'s table')
    } finally { await again.close() }
  })

  test('a staged migration SWAP carries api_calls into the new store (the silent-loss case)', async () => {
    const dir = tmp()
    const store = await seeded(dir, 4)
    const part = await plantApiCallPart(store, dir)
    const planted = fs.readFileSync(part)
    await store.close()
    assert.strictEqual(readManifest(dir).schemaVersion, 0, 'an unversioned store migrates via stagedRewrite')

    // The step is passed explicitly, never taken from the global MIGRATIONS registry: another suite
    // empties that array in its teardown, so relying on it makes this test's outcome depend on file
    // order within one mocha process.
    const r = await migrateStore(dir, { migrations: [makeTsRecoveryMigration(emptyCorrections())] })
    assert.strictEqual(r.error, undefined, r.error)
    assert.strictEqual(r.migrated, true)

    const carried = path.join(dir, API_CALLS_DIR, path.basename(part))
    assert.ok(fs.existsSync(carried), 'the swap must not strand api_calls in the backup dir')
    assert.ok(planted.equals(fs.readFileSync(carried)), 'carried across verbatim — immutable parts are copied, never rewritten')
    // The backup keeps its own copy: the migration copies, it does not move, so a crash mid-swap
    // still leaves one complete store.
    assert.ok(fs.existsSync(path.join(r.backupDir!, API_CALLS_DIR, path.basename(part))))

    const re = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      const v = await validateStore(re)
      assert.strictEqual(v.valid, true, v.errors.join('; '))
      assert.strictEqual(v.bodies, 4, 'no body may be lost by a migration that also carried api_calls')
    } finally { await re.close() }
  })
})
