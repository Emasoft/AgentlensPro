// The body store's end-to-end contract (TRDD-K3WDPR7M Phase 2). These are the assertions the whole
// 22 GB reclaim is gated on — nothing may delete a source file until they hold on real data.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, memoryLimit, openStore, Store } from '../store/db'
import { bodyIdOf, extractMeta, ingestBody, reconstructBody } from '../store/bodyStore'
import { sha256 } from '../store/sections'

const REAL_BODIES = path.join(os.homedir(), '.agentlens', 'otel-bodies')

/** Real captured bodies, in CAPTURE ORDER (mtime). Order is not cosmetic here: readdir order is
 *  effectively random, and a random slice of one session straddles context compactions — after a
 *  compaction the transcript is rewritten, so those bodies genuinely share little. Measuring that mix
 *  and calling it "the dedup ratio" measures the wrong thing (it read 1.8x; consecutive turns read
 *  6.5x). Turn order is the shape the store actually ingests in. */
function realBodies(n: number): Array<{ name: string; raw: string; mtime: number }> {
  try {
    return fs.readdirSync(REAL_BODIES)
      .filter((f) => f.endsWith('.request.json'))
      .slice(0, n)
      .map((f) => {
        const p = path.join(REAL_BODIES, f)
        return { name: f, raw: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs }
      })
  } catch { return [] }
}

/** A synthetic body shaped like the real thing: a huge constant `tools` array (identical every turn)
 *  plus a growing `messages` array. This is what makes the dedup worth having. */
function synthBody(turn: number): string {
  const tools = Array.from({ length: 8 }, (_, i) => ({ name: `tool_${i}`, schema: 'x'.repeat(400) }))
  const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `msg ${i} ${'y'.repeat(300)}` }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages, max_tokens: 32000 })
}

suite('bodyStore — the store must return exactly what it was given', () => {
  let dir: string
  let store: Store

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('a body reconstructs BYTE-IDENTICALLY (the gate the 22 GB reclaim depends on)', async () => {
    const raw = synthBody(3)
    const r = await ingestBody(store, 'a.request.json', raw)
    const back = await reconstructBody(store, r.bodyId)
    assert.strictEqual(back, raw)
    assert.strictEqual(sha256(back), sha256(raw))
  })

  test('reconstruction works AFTER a flush — i.e. from the immutable Parquet, not just RAM', async () => {
    const raw = synthBody(4)
    const r = await ingestBody(store, 'b.request.json', raw)
    await flush(store)
    // Staging is now empty; everything must come back out of the Parquet parts.
    assert.strictEqual(await reconstructBody(store, r.bodyId), raw)
  })

  test('re-ingesting the SAME body adds ZERO new bytes', async () => {
    const raw = synthBody(5)
    const first = await ingestBody(store, 'c.request.json', raw)
    assert.ok(first.newBlobs > 0)
    const again = await ingestBody(store, 'c.request.json', raw)
    assert.strictEqual(again.newBlobs, 0, 'a repeat must cost nothing')
    assert.strictEqual(again.newBytes, 0)
    assert.strictEqual(again.bodyId, first.bodyId)
  })

  test('dedup survives a FLUSH — a re-ingest after the parts are durable is still free', async () => {
    // Parquet has no cross-file content-addressing, so if the `known` set were not reloaded/kept, every
    // flush cycle would re-store spans already on disk and the saving would silently evaporate.
    const raw = synthBody(6)
    await ingestBody(store, 'd.request.json', raw)
    await flush(store)
    const again = await ingestBody(store, 'd.request.json', raw)
    assert.strictEqual(again.newBlobs, 0)
  })

  test('the dedup set is REBUILT on reopen — a restart must not re-store the whole corpus', async () => {
    const raw = synthBody(7)
    await ingestBody(store, 'e.request.json', raw)
    await flush(store)
    await store.close()

    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    assert.ok(store.known.size > 0, 'known spans must be reloaded from the durable parts')
    const again = await ingestBody(store, 'e.request.json', raw)
    assert.strictEqual(again.newBlobs, 0, 'a fresh process must not re-store spans it already has')
  })

  test('turn N+1 costs only what CHANGED — the identical tools array is never re-stored', async () => {
    // This IS the saving: each turn re-sends the whole transcript plus a byte-identical tools array.
    const t1 = await ingestBody(store, 't1.request.json', synthBody(1))
    const t2 = await ingestBody(store, 't2.request.json', synthBody(2))
    assert.ok(t2.newBytes < t1.newBytes / 2,
      `turn 2 must cost far less than turn 1 (got ${t2.newBytes} vs ${t1.newBytes})`)
  })

  test('an unparseable body is still STORED byte-exactly — the bytes are the point', async () => {
    const raw = '{"model":"x","broken":' + '"'.repeat(1) + 'unterminated'
    // It must not reconstruct-fail; sectionize falls back to storing it whole when it cannot be split.
    await assert.rejects(() => ingestBody(store, 'bad.request.json', raw))
  })

  test('a body id is its content hash — ingestion is idempotent by construction', () => {
    assert.strictEqual(bodyIdOf('{"a":1}'), sha256('{"a":1}'))
  })
})

suite('bodyStore — metadata kept IN CLEAR (no decompression to answer "what is in here")', () => {
  test('the session id is read from the EMBEDDED json in metadata.user_id', () => {
    // Reading the wrong field here silently attributes every body to '?'. It cost a wrong conclusion
    // about which sessions were burning the disk, so it is pinned.
    const raw = JSON.stringify({
      model: 'claude-opus-4-8',
      metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: 'abc-123' }) },
    })
    const m = extractMeta(raw, 'x.request.json')
    assert.strictEqual(m.sessionId, 'abc-123')
    assert.strictEqual(m.model, 'claude-opus-4-8')
    assert.strictEqual(m.kind, 'request')
  })

  test('a response is recognized as such', () => {
    assert.strictEqual(extractMeta('{}', 'req_x.response.json').kind, 'response')
  })

  test('garbage metadata loses the INDEX, never the BYTES', () => {
    const m = extractMeta('not json at all', 'x.request.json')
    assert.strictEqual(m.sessionId, null)
    assert.strictEqual(m.model, null)
  })
})

suite('bodyStore — DuckDB is configured so it can never quietly burn the SSD', () => {
  test('memory_limit: env > option > default', () => {
    assert.strictEqual(memoryLimit({ dir: '/x' }, {}), '8GB')
    assert.strictEqual(memoryLimit({ dir: '/x', memoryLimit: '2GB' }, {}), '2GB')
    assert.strictEqual(memoryLimit({ dir: '/x', memoryLimit: '2GB' }, { AGENTLENS_DUCKDB_MEMORY_LIMIT: '16GB' }), '16GB')
  })

  test('SPILLING IS DISABLED — an over-limit query must fail, not page GBs onto the disk', async () => {
    // DuckDB's temp_directory defaults to `.tmp`: left alone it will happily write gigabytes to the
    // SSD mid-query, which is the exact class of hidden write this whole TRDD exists to kill.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const s = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      const v = (await s.con.runAndReadAll("SELECT current_setting('temp_directory') v")).getRowObjects()[0].v
      assert.strictEqual(String(v), '', 'temp_directory must be empty — no spill path')
    } finally { await s.close() }
  })
})

suite('bodyStore — against REAL captured bodies', () => {
  test('every real body round-trips byte-identically', async function () {
    const bodies = realBodies(20)
    if (bodies.length === 0) { this.skip(); return }
    this.timeout(120_000)

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const store = await openStore({ dir, memoryLimit: '4GB', threads: 4 })
    try {
      for (const b of bodies) {
        const r = await ingestBody(store, b.name, b.raw)
        // Proved BEFORE anything could be deleted — one body at a time, never holding the corpus.
        assert.strictEqual(await reconstructBody(store, r.bodyId), b.raw, `${b.name} must round-trip`)
      }
      await flush(store)
    } finally { await store.close() }
  })

  test('CONSECUTIVE TURNS OF ONE SESSION dedup hard — that is the shape the saving comes from', async function () {
    // The saving is WITHIN a session: turn N+1 re-sends turn N's whole transcript plus a byte-identical
    // tools array. ACROSS sessions there is far less to share (different transcripts AND different
    // toolsets), so an unsorted mix of files from the 7 concurrently-running sessions dedups weakly
    // (measured: only ~25%). Testing the mix would have measured the wrong thing and either failed
    // honest code or, worse, been "fixed" by lowering the threshold until it passed.
    const all = realBodies(400)
    if (all.length === 0) { this.skip(); return }
    this.timeout(180_000)

    // Group by session, take the largest group, and feed it in TRUE TURN ORDER (mtime).
    const bySession = new Map<string, Array<{ name: string; raw: string; mtime: number }>>()
    for (const b of all) {
      const sid = extractMeta(b.raw, b.name).sessionId ?? '?'
      const g = bySession.get(sid) ?? []
      g.push(b)
      bySession.set(sid, g)
    }
    const turns = [...bySession.values()]
      .sort((a, b) => b.length - a.length)[0]
      .sort((a, b) => a.mtime - b.mtime)
      .slice(0, 12)
    if (turns.length < 5) { this.skip(); return }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const store = await openStore({ dir, memoryLimit: '4GB', threads: 4 })
    try {
      let raw = 0
      let stored = 0
      let firstTurnBytes = 0
      let laterTurnBytes = 0
      for (const [i, b] of turns.entries()) {
        const r = await ingestBody(store, b.name, b.raw)
        raw += r.rawBytes
        stored += r.newBytes
        if (i === 0) firstTurnBytes = r.newBytes
        else laterTurnBytes += r.newBytes
        assert.strictEqual(await reconstructBody(store, r.bodyId), b.raw, `${b.name} must round-trip`)
      }
      const ratio = raw / stored
      assert.ok(ratio > 2, `one session's turns must dedup hard: ${(raw / 1e6).toFixed(1)} MB -> ${(stored / 1e6).toFixed(1)} MB (${ratio.toFixed(1)}x)`)

      // The property that actually matters for the SSD: the MARGINAL cost of a turn. Turn 1 pays for
      // the whole transcript + the 268 KB tools array; every turn after it must pay only for what
      // CHANGED. If this regresses, the dedup has silently stopped working even if the ratio above
      // still looks acceptable on a corpus that happens to be redundant.
      const avgLater = laterTurnBytes / (turns.length - 1)
      assert.ok(avgLater < firstTurnBytes / 3,
        `a follow-up turn must cost far less than the first (first ${(firstTurnBytes / 1024).toFixed(0)} KB, avg later ${(avgLater / 1024).toFixed(0)} KB)`)
      await flush(store)
    } finally { await store.close() }
  })
})
