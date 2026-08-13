// ingestPass DELETES THE USER'S FILES. Every test here exists to prove it cannot delete a body it
// cannot give back (TRDD-K3WDPR7M Phase 3/5).
//
// The failure this guards against is not "a test goes red" — it is: the 22 GB is reclaimed, months
// later someone needs a body, and it is gone or corrupt. So the tests attack the DELETE decision from
// every angle: unverifiable body, un-flushed store, mid-pass crash, and the throttle that stops a
// boot pass from doing 694 MB/min to the disk again.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openStore, Store } from '../store/db'
import { reconstructBody, bodyIdOf } from '../store/bodyStore'
import { DEFAULT_MAX_BYTES_PER_PASS, ingestPass } from '../store/ingestPass'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-pass-')) }

function body(turn: number): string {
  const tools = Array.from({ length: 6 }, (_, i) => ({ name: `tool_${i}`, schema: 'x'.repeat(500) }))
  const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(400)}` }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages })
}

/** A bodies dir with `n` turn-ordered request files. */
function corpus(n: number): { dir: string; names: string[] } {
  const dir = tmp()
  const names: string[] = []
  for (let i = 1; i <= n; i++) {
    const name = `body-${String(i).padStart(3, '0')}.request.json`
    fs.writeFileSync(path.join(dir, name), body(i))
    names.push(name)
  }
  return { dir, names }
}

suite('ingestPass — it must never delete what it cannot give back', () => {
  let store: Store
  let storeDir: string

  setup(async () => {
    storeDir = tmp()
    store = await openStore({ dir: storeDir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('bodies are ingested, verified, and only THEN deleted', async () => {
    const { dir, names } = corpus(6)
    const raws = names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))

    const r = await ingestPass({ bodiesDir: dir, store, batchSize: 3 })
    assert.strictEqual(r.ingested, 6)
    assert.strictEqual(r.deleted, 6)
    assert.deepStrictEqual(r.failed, [])
    assert.strictEqual(fs.readdirSync(dir).length, 0, 'sources reclaimed')

    // The bodies must still be retrievable, byte-for-byte, AFTER their files are gone.
    for (const raw of raws) {
      assert.strictEqual(await reconstructBody(store, bodyIdOf(raw)), raw)
    }
  })

  test('THE CENTRAL GUARANTEE: a body must be readable from the store after its file is deleted', async () => {
    const { dir } = corpus(4)
    const raws = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
    await ingestPass({ bodiesDir: dir, store, batchSize: 2 })
    await store.close()

    // A FRESH process, reading only the durable Parquet parts — the state the user is left in.
    store = await openStore({ dir: storeDir, memoryLimit: '2GB', threads: 2 })
    for (const raw of raws) {
      assert.strictEqual(await reconstructBody(store, bodyIdOf(raw)), raw,
        'the file is gone; if this fails the data is LOST')
    }
  })

  test('deleteAfter=false ingests but reclaims NOTHING — prove a backfill before committing to it', async () => {
    const { dir } = corpus(5)
    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: false })
    assert.strictEqual(r.ingested, 5)
    assert.strictEqual(r.deleted, 0)
    assert.strictEqual(fs.readdirSync(dir).length, 5, 'every source file must survive a dry ingest')
  })

  test('an UNVERIFIABLE body is reported and NOT deleted', async () => {
    const { dir } = corpus(3)
    // A body the sectioner cannot handle must be kept, named, and never silently dropped.
    fs.writeFileSync(path.join(dir, 'broken.request.json'), '{"a": "unterminated')

    const r = await ingestPass({ bodiesDir: dir, store })
    assert.strictEqual(r.failed.length, 1)
    assert.ok(r.failed[0].startsWith('broken.request.json'), r.failed[0])
    assert.ok(fs.existsSync(path.join(dir, 'broken.request.json')), 'a body we cannot store must survive')
    assert.strictEqual(r.deleted, 3, 'the healthy ones are still reclaimed')
  })

  test('a source that does NOT match the store is caught by the post-flush compare and NOT deleted', async () => {
    // THE most important failure mode in the file: if the round trip through DuckDB/Parquet ever
    // returned something other than the source bytes, this compare is the only thing standing between
    // the user and silent data loss. Provoked via the readFile seam — the source reads back different
    // on the VERIFY read (2nd read) than it did on ingest.
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'a.request.json'), body(3))
    let seen = 0
    const r = await ingestPass({
      bodiesDir: dir,
      store,
      readFile: (p) => {
        const out = fs.readFileSync(p, 'utf8')
        return p.endsWith('a.request.json') && ++seen === 2 ? `${out} TAMPERED` : out
      },
    })
    assert.strictEqual(r.deleted, 0, 'a mismatch MUST abort the delete')
    assert.strictEqual(r.failed.length, 1)
    assert.ok(fs.existsSync(path.join(dir, 'a.request.json')), 'the file must survive')
  })

  // KB17X5G2-P0 falsification: the SAME tamper scenario, but inside a multi-file batch, to prove the
  // bulk verify (verifyBodiesInStore) does not let one bad body take its batch-mates down with it.
  test('a batch with ONE tampered file still deletes its healthy batch-mates', async () => {
    const { dir } = corpus(5)
    const names = fs.readdirSync(dir).sort()
    const victim = names[2] // tamper the middle file
    let seen = 0
    const r = await ingestPass({
      bodiesDir: dir,
      store,
      batchSize: 5, // all 5 settle together — the batch IS the unit under test
      readFile: (p) => {
        const out = fs.readFileSync(p, 'utf8')
        return p.endsWith(victim) && ++seen === 2 ? `${out} TAMPERED` : out
      },
    })
    assert.strictEqual(r.deleted, 4, 'the 4 healthy files in the batch must still be reclaimed')
    assert.strictEqual(r.failed.length, 1)
    assert.ok(r.failed[0].startsWith(victim), r.failed[0])
    assert.ok(fs.existsSync(path.join(dir, victim)), 'the tampered file must survive')
    for (const n of names) {
      if (n !== victim) assert.ok(!fs.existsSync(path.join(dir, n)), `${n} should have been reclaimed`)
    }
  })

  // KB17X5G2-P0.5 falsification: the fsync barrier fires ONLY when the caller declares the source
  // durable (the legacy SSD dir), never for a volatile RAM-spool source. Injected via the `fsyncPath`
  // seam (not a direct fs.fsyncSync stub): TS's `import * as fs` copies fsyncSync onto the module
  // namespace as a getter-only accessor, so reassigning it throws "has only a getter" — the same
  // reason ingestPass already has a `readFile` seam instead of stubbing fs.readFileSync.
  test('durableSource=true fsyncs the flushed parts before deleting; durableSource=false (default) does not', async () => {
    let calls = 0
    const fsyncPath = (p: string) => { calls++; const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
    // corpus() names/contents are deterministic by turn count, so two calls with the SAME src_name +
    // SAME content would dedup on the SECOND ingest (no new body row, nothing to flush, nothing to
    // fsync) — a false negative that would prove nothing about the barrier. Distinct dirs alone are
    // NOT enough: the store keys on src_name (the filename), not the source path. Use distinct file
    // names per dir so each ingest actually writes a fresh body row.
    const distinctCorpus = (tag: string): string => {
      const dir = tmp()
      for (let i = 1; i <= 2; i++) fs.writeFileSync(path.join(dir, `${tag}-${i}.request.json`), body(i))
      return dir
    }

    const dirA = distinctCorpus('spool')
    const rA = await ingestPass({ bodiesDir: dirA, store, durableSource: false, fsyncPath })
    assert.strictEqual(rA.deleted, 2)
    assert.strictEqual(calls, 0, 'a volatile (spool) source must never take the fsync barrier')

    const dirB = distinctCorpus('ssd')
    const rB = await ingestPass({ bodiesDir: dirB, store, durableSource: true, fsyncPath })
    assert.strictEqual(rB.deleted, 2)
    assert.ok(calls > 0, 'a durable (legacy SSD) source must fsync its flushed parts + directories')
  })
})

suite('ingestPass — throttle and selection', () => {
  let store: Store
  setup(async () => { store = await openStore({ dir: tmp(), memoryLimit: '2GB', threads: 2 }) })
  teardown(async () => { await store.close() })

  test('THE THROTTLE: a pass stops at its byte budget instead of churning the disk', async () => {
    // The archiver this replaces ran an unbounded pass on every boot — measured at 694 MB/min of
    // device writes. A restart must never again be a disk-punishing event.
    const { dir } = corpus(20)
    const r = await ingestPass({ bodiesDir: dir, store, maxBytesPerPass: 20_000, batchSize: 100 })
    assert.ok(r.throttled, 'the budget must stop the pass')
    assert.ok(r.bytesIn <= 20_000 + 60_000, `consumed ${r.bytesIn} B — must respect the budget`)
    assert.ok(fs.readdirSync(dir).length > 0, 'the rest waits for the next pass')
  })

  test('a budget never blocks progress entirely — one oversized body still gets through', async () => {
    // With a naive `if (bytesIn + size > budget) break`, a single body larger than the budget would
    // stall the pass FOREVER and the corpus would never drain.
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'huge.request.json'), body(40))
    const r = await ingestPass({ bodiesDir: dir, store, maxBytesPerPass: 10 })
    assert.strictEqual(r.ingested, 1, 'an oversized body must not deadlock the pass')
  })

  test('maxAgeMs leaves the live window alone', async () => {
    const { dir } = corpus(3)
    const r = await ingestPass({ bodiesDir: dir, store, maxAgeMs: 3600_000 }) // only >1h old
    assert.strictEqual(r.ingested, 0, 'freshly written bodies stay as plain files')
    assert.strictEqual(fs.readdirSync(dir).length, 3)
  })

  test('bodies are processed OLDEST FIRST — which is also the turn order that dedups', async () => {
    const { dir } = corpus(8)
    // Same content, ingested in turn order: later turns must cost far less than the first.
    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: false })
    assert.ok(r.bytesStored < r.bytesIn / 2,
      `turn-ordered ingest must dedup: stored ${r.bytesStored} of ${r.bytesIn}`)
  })

  test('an empty or missing dir is a no-op, not a crash', async () => {
    assert.strictEqual((await ingestPass({ bodiesDir: tmp(), store })).ingested, 0)
    assert.strictEqual((await ingestPass({ bodiesDir: '/nope/nothing/here', store })).ingested, 0)
  })

  test('the default budget is bounded — an unbounded default is how the 694 MB/min happened', () => {
    assert.ok(DEFAULT_MAX_BYTES_PER_PASS > 0 && DEFAULT_MAX_BYTES_PER_PASS <= 1024 ** 3)
  })
})
