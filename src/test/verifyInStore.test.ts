// verifyBodyInStore — the universal verify-before-delete gate (TRDD-K3WDPR7M, USER directive
// 2026-07-15). These tests are adversarial: the gate authorizes DELETING the user's files, so every
// way it can wrongly say "ok" (or wrongly say "fail") is a data-loss (or wedge) bug.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { verifyBodyInStore, verifyBodiesInStore, TS_TOLERANCE_MS } from '../store/verifyInStore'

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

suite('verifyBodiesInStore — the batched gate (KB17X5G2-P0) must prove exactly what the single-file gate proves', () => {
  let dir: string
  let store: Store
  const T = Date.UTC(2026, 6, 9, 6, 40, 57)

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-verify-bulk-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('agrees with the single-file gate on a healthy batch', async () => {
    const raws = ['p', 'q', 'r'].map((tag) => synthBody(tag))
    for (let i = 0; i < raws.length; i++) await ingestBody(store, `f${i}.request.json`, raws[i], T)
    await flush(store)
    const results = await verifyBodiesInStore(store, raws.map((raw, i) => ({ srcName: `f${i}.request.json`, raw, tsMs: T })))
    for (let i = 0; i < raws.length; i++) assert.deepStrictEqual(results.get(`f${i}.request.json`), { ok: true })
  })

  // THE central falsification for KB17X5G2-P0: a batch containing ONE body whose on-disk bytes do not
  // match what the store holds must (a) catch that ONE body — never delete it — and (b) still verify
  // every OTHER body in the batch correctly. A bulk rewrite that group-fails the whole batch on one
  // bad apple would be strictly worse than the per-file gate it replaces.
  test('a corrupted body in a batch is caught WITHOUT poisoning its batch-mates', async () => {
    const good1 = synthBody('good1')
    const bad = synthBody('bad')
    const good2 = synthBody('good2')
    await ingestBody(store, 'good1.request.json', good1, T)
    await ingestBody(store, 'bad.request.json', bad, T)
    await ingestBody(store, 'good2.request.json', good2, T)
    await flush(store)

    const results = await verifyBodiesInStore(store, [
      { srcName: 'good1.request.json', raw: good1, tsMs: T },
      // The "on-disk bytes" passed here diverge from what was ingested — exactly the scenario the
      // read-twice tamper test in ingestPass.test.ts provokes via the readFile seam, reproduced here
      // directly against the bulk gate.
      { srcName: 'bad.request.json', raw: `${bad} TAMPERED`, tsMs: T },
      { srcName: 'good2.request.json', raw: good2, tsMs: T },
    ])

    assert.deepStrictEqual(results.get('good1.request.json'), { ok: true })
    assert.deepStrictEqual(results.get('good2.request.json'), { ok: true })
    const badResult = results.get('bad.request.json')
    assert.strictEqual(badResult?.ok, false)
    assert.match(badResult!.reason!, /unknown body|reconstruction != source bytes/)
  })

  test('a batch larger than RECONSTRUCT_CHUNK still verifies every item (chunking must not drop any)', async () => {
    const n = 40 // > the 32-item reconstruct chunk
    const raws: string[] = []
    for (let i = 0; i < n; i++) {
      const raw = synthBody(`bulk-${i}`)
      raws.push(raw)
      await ingestBody(store, `bulk-${i}.request.json`, raw, T)
    }
    await flush(store)
    const results = await verifyBodiesInStore(store, raws.map((raw, i) => ({ srcName: `bulk-${i}.request.json`, raw, tsMs: T })))
    assert.strictEqual(results.size, n)
    for (let i = 0; i < n; i++) assert.deepStrictEqual(results.get(`bulk-${i}.request.json`), { ok: true })
  })

  test('ts mismatch is still caught in bulk (metadata is data too)', async () => {
    const raw = synthBody('ts-mismatch')
    await ingestBody(store, 'ts.request.json', raw, T)
    await flush(store)
    const results = await verifyBodiesInStore(store, [{ srcName: 'ts.request.json', raw, tsMs: T + 10 * 60_000 }])
    assert.strictEqual(results.get('ts.request.json')?.ok, false)
    assert.match(results.get('ts.request.json')!.reason!, /stored ts .* != capture time/)
  })
})
