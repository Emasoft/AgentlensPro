// verifyBodyInStore — the universal verify-before-delete gate (TRDD-K3WDPR7M, USER directive
// 2026-07-15). These tests are adversarial: the gate authorizes DELETING the user's files, so every
// way it can wrongly say "ok" (or wrongly say "fail") is a data-loss (or wedge) bug.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { verifyBodyInStore, TS_TOLERANCE_MS } from '../store/verifyInStore'

function synthBody(tag: string): string {
  const tools = Array.from({ length: 4 }, (_, i) => ({ name: `tool_${i}`, schema: 'x'.repeat(300) }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages: [{ role: 'user', content: `q ${tag}` }] })
}

suite('verifyBodyInStore — a source may be deleted only when bytes AND metadata are provably durable', () => {
  let dir: string
  let store: Store
  const T = Date.UTC(2026, 6, 9, 6, 40, 57) // a realistic capture time, distinct from "now"

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-verify-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('passes for an ingested+flushed body whose ts matches the capture time', async () => {
    const raw = synthBody('a')
    await ingestBody(store, 'a.request.json', raw, T)
    await flush(store)
    const v = await verifyBodyInStore(store, 'a.request.json', raw, T)
    assert.deepStrictEqual(v, { ok: true })
  })

  test('FAILS when the stored ts is not the capture time (the first backfill bug, made undeletable)', async () => {
    const raw = synthBody('b')
    await ingestBody(store, 'b.request.json', raw, T)
    await flush(store)
    const v = await verifyBodyInStore(store, 'b.request.json', raw, T + 10 * 60_000)
    assert.strictEqual(v.ok, false)
    assert.match(v.reason!, /stored ts .* != capture time/)
  })

  test('tolerates sub-tolerance mtime jitter (float mtimes must not wedge the reclaim)', async () => {
    const raw = synthBody('c')
    await ingestBody(store, 'c.request.json', raw, T)
    await flush(store)
    const v = await verifyBodyInStore(store, 'c.request.json', raw, T + TS_TOLERANCE_MS - 1)
    assert.strictEqual(v.ok, true)
  })

  test('FAILS when the content exists only under a DIFFERENT src_name (bytes alone are not enough)', async () => {
    const raw = synthBody('d')
    await ingestBody(store, 'd.request.json', raw, T)
    await flush(store)
    const v = await verifyBodyInStore(store, 'UNRELATED.request.json', raw, T)
    assert.strictEqual(v.ok, false)
    assert.match(v.reason!, /no body row for this src_name/)
  })

  test('FAILS for content the store has never seen (nothing to delete against)', async () => {
    const v = await verifyBodyInStore(store, 'ghost.request.json', synthBody('ghost'), T)
    assert.strictEqual(v.ok, false)
    assert.match(v.reason!, /unknown body/)
  })

  test('a deduped second capture gets its OWN row+ts, and verifies under its own name', async () => {
    const raw = synthBody('e')
    await ingestBody(store, 'first.request.json', raw, T)
    const again = await ingestBody(store, 'second.request.json', raw, T + 3_600_000)
    assert.strictEqual(again.existed, true)
    await flush(store)
    // Each capture event verifies against ITS name and ITS capture time — this is what lets the
    // reclaim delete BOTH files instead of keeping the duplicate forever.
    assert.strictEqual((await verifyBodyInStore(store, 'first.request.json', raw, T)).ok, true)
    assert.strictEqual((await verifyBodyInStore(store, 'second.request.json', raw, T + 3_600_000)).ok, true)
    // And the second name does NOT satisfy the first's capture time.
    assert.strictEqual((await verifyBodyInStore(store, 'second.request.json', raw, T)).ok, false)
  })

  test('re-ingesting the SAME name+content twice stays idempotent (no duplicate rows)', async () => {
    const raw = synthBody('f')
    await ingestBody(store, 'f.request.json', raw, T)
    await ingestBody(store, 'f.request.json', raw, T)
    await flush(store)
    const rows = (await store.con.runAndReadAll(
      `SELECT count(*) c FROM (SELECT * FROM read_parquet(['${dir.replace(/'/g, "''")}/bodies/*.parquet']) UNION ALL SELECT * FROM body) WHERE src_name = 'f.request.json'`,
    )).getRowObjects()
    assert.strictEqual(Number(rows[0].c), 1)
  })
})
