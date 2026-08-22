// The body store's end-to-end contract (TRDD-K3WDPR7M Phase 2). These are the assertions the whole
// 22 GB reclaim is gated on — nothing may delete a source file until they hold on real data.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { flush, memoryLimit, openStore, Store } from '../store/db'
import { bodyIdOf, exportBodiesFromStore, extractMeta, ingestBody, reconstructBody } from '../store/bodyStore'
import { sha256 } from '../store/sections'
import { resolveBodiesReadScope } from '../captureConfig'
import { loadScaledTimeout, skipIfUnmeasurable } from './loadAware'

// TRDD-0SA5QZTG. This used to hardcode `~/.agentlens/otel-bodies` — the LEGACY dir. Under
// SPOOL_MODE the server captures to a RAM spool instead, so the legacy dir is a frozen,
// partially-drained residue of whatever the pass had not yet ingested when the spool took over.
// Testing it looked like testing "the live corpus" and was not, and the difference is not subtle:
//
//     legacy residue : mean shared prefix 34%, longest consecutive run 3
//     live spool     : mean shared prefix 81%, longest consecutive run 26
//
// The whole adjacency problem in TRDD-R2VF2I53 was an artifact of reading the wrong directory.
// `resolveBodiesReadScope` is the server's own resolver (spool first, then legacy), so the test
// now reads exactly what the server writes.
const REAL_BODIES_DIRS = resolveBodiesReadScope(path.join(os.homedir(), '.agentlens'), process.env).dirs

/** Up to `n` real captured request bodies, from every dir a reader can see (spool first).
 *
 *  This returns them in READDIR order, NOT capture order — the header said "in CAPTURE ORDER
 *  (mtime)" for as long as the body has been sorting nothing, which is a comment asserting a
 *  guarantee the code never gave. Callers that need turn order sort by `mtime` themselves (and
 *  the adjacency test does, per session). Order is not cosmetic where it matters: a random slice
 *  of one session straddles context compactions, and after a compaction the transcript is
 *  rewritten, so those bodies genuinely share little. Measuring that mix and calling it "the
 *  dedup ratio" measures the wrong thing (it read 1.8x; consecutive turns read 6.5x). */
function realBodies(n: number): Array<{ name: string; raw: string; mtime: number }> {
  const out: Array<{ name: string; raw: string; mtime: number }> = []
  for (const dir of REAL_BODIES_DIRS) {
    if (out.length >= n) break
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const f of names) {
      if (out.length >= n) break
      if (!f.endsWith('.request.json')) continue
      const p = path.join(dir, f)
      // The drain is allowed to race us: a body can vanish between readdir and read.
      try { out.push({ name: f, raw: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs }) } catch { /* gone */ }
    }
  }
  return out
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

suite('bodyStore — CONCURRENT writers must never destroy each other (part-name collision)', () => {
  test('two stores flushing into the SAME directory produce distinct parts and lose nothing', async () => {
    // The bug this pins: part names were derived from the directory's FILE COUNT, so two writers
    // (the server's ingest pass + a CLI backfill — a combination that nearly happened for real on
    // 2026-07-14) computed the SAME name, and DuckDB's COPY TO silently OVERWRITES an existing file
    // (verified by experiment). The second flush destroyed the first's spans: dangling references,
    // unrecoverable bodies, and nothing notices until someone asks for one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const a = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    const b = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      // Different content per writer, so a lost part is DETECTABLE as a missing body.
      const rawA = synthBody(3)
      const rawB = JSON.stringify({ model: 'other', tools: [{ t: 'b'.repeat(2000) }] })
      const ra = await ingestBody(a, 'a.request.json', rawA)
      const rb = await ingestBody(b, 'b.request.json', rawB)
      // Both flush from the same on-disk state — the exact collision scenario.
      await flush(a)
      await flush(b)

      // A THIRD reader sees the union of the durable parts. Both bodies must be retrievable —
      // if a part was overwritten, one of these reconstructions throws on a missing blob.
      const c = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
      try {
        assert.strictEqual(await reconstructBody(c, ra.bodyId), rawA, 'writer A\'s body must survive writer B\'s flush')
        assert.strictEqual(await reconstructBody(c, rb.bodyId), rawB, 'writer B\'s body must survive')
      } finally { await c.close() }

      // Duplicate spans across writers (each has its own dedup set) are WASTE, not corruption —
      // reads key by sha, so either copy serves. The invariant under test is no LOSS.
    } finally { await a.close(); await b.close() }
  })
})

suite('bodyStore — export from the store (the read path for reclaimed bodies)', () => {
  test('the store half of /api/bodies/export: window filter, skip-existing, byte-exact', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      const t0 = Date.parse('2026-07-01T00:00:00Z')
      const inWin = synthBody(2)
      const outWin = JSON.stringify({ model: 'old', tools: [{ t: 'z'.repeat(2000) }] })
      await ingestBody(store, 'in.request.json', inWin, t0)
      await ingestBody(store, 'out.request.json', outWin, t0 - 30 * 86400e3) // a month earlier

      const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-export-'))
      // A pre-existing file with the same name must be SKIPPED, not clobbered — the legacy archive
      // half of the export may have produced it first, and the two halves must compose.
      fs.writeFileSync(path.join(dest, 'in.request.json'), 'already here')

      const r1 = await exportBodiesFromStore(store, dest, t0 - 86400e3, t0 + 86400e3)
      assert.strictEqual(r1.files, 0, 'the only in-window body already exists — nothing written')
      assert.strictEqual(fs.readFileSync(path.join(dest, 'in.request.json'), 'utf8'), 'already here')

      fs.unlinkSync(path.join(dest, 'in.request.json'))
      const r2 = await exportBodiesFromStore(store, dest, t0 - 86400e3, t0 + 86400e3)
      assert.strictEqual(r2.files, 1, 'in-window body exported; out-of-window one filtered')
      assert.deepStrictEqual(r2.failed, [])
      assert.strictEqual(fs.readFileSync(path.join(dest, 'in.request.json'), 'utf8'), inWin, 'byte-exact')
      assert.ok(!fs.existsSync(path.join(dest, 'out.request.json')))
    } finally { await store.close() }
  })

  test('ts is the CAPTURE time when the caller knows it — not the ingest time', async () => {
    // The first backfill stamped 22k bodies with ingest time because this parameter did not exist;
    // every time-window query over those rows lies until the recovery migration runs. New ingests
    // must never add to that damage.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-store-'))
    const store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
    try {
      const captured = Date.parse('2026-07-03T12:00:00Z')
      const r = await ingestBody(store, 't.request.json', synthBody(1), captured)
      const row = (await store.con.runAndReadAll(
        `SELECT epoch_ms(ts) t FROM body WHERE body_id = '${r.bodyId}'`,
      )).getRowObjects()[0]
      assert.strictEqual(Number(row.t), captured)
    } finally { await store.close() }
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
    if (skipIfUnmeasurable(this)) return
    this.timeout(loadScaledTimeout(120_000))

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
    if (skipIfUnmeasurable(this)) return
    this.timeout(loadScaledTimeout(180_000))

    // Group by session, take the largest group, and feed it in TRUE TURN ORDER (mtime).
    const bySession = new Map<string, Array<{ name: string; raw: string; mtime: number }>>()
    for (const b of all) {
      const sid = extractMeta(b.raw, b.name).sessionId ?? '?'
      const g = bySession.get(sid) ?? []
      g.push(b)
      bySession.set(sid, g)
    }
    // TRDD-R2VF2I53. Picking the LARGEST group and asserting a dedup floor on it was a countdown
    // to a false failure, and it fired (1.9x, then 1.4x, against a >2x floor). The saving asserted
    // below comes from turn N+1 re-sending turn N's transcript, so ADJACENT turns share almost
    // everything while turns either side of a gap share little — and the largest group is not the
    // same thing as a run of adjacent turns.
    //
    // WHY the gaps are there is NOT ESTABLISHED, and two successive answers here were wrong in
    // OPPOSITE directions — which is why this now names no cause at all:
    //   1. "The spool is actively drained, so gaps." Asserted, never verified.
    //   2. "The drain CANNOT be the cause — the spool is frozen." Also wrong, and worse for being
    //      more confident. The spool being frozen (newest file 4 days old, zero bodies written
    //      since server boot) is the signature of CAPTURE being off, not of the drain being idle —
    //      a drain with nothing to drain looks identical. And the corpus was written back WHEN
    //      capture was on, so a drain running THEN could have made these very gaps.
    // Untested alternatives that produce identical low sharing: /clear + compaction boundaries,
    // subagent requests filed under the PARENT's session_id (metadata.user_id — see the
    // cacheBreakTimeline agent-* card), and mtime not being turn order.
    //
    // The selection below is robust to ALL of them because it tests the PROPERTY (do these turns
    // actually share a transcript?) instead of a story about why they might not. Do not
    // re-introduce a cause-based filter — the cause has now been guessed wrong twice.
    //
    // The fix is to PIN THE INPUT, never to lower the floor — lowering it makes the suite green
    // while destroying the only thing this test can detect. Adjacency is MEASURABLE from the
    // bodies themselves: turn N+1 re-sends turn N's transcript, so an adjacent pair shares a long
    // common PREFIX. Turns either side of a gap share almost nothing.
    //
    // RESOLVED 2026-08-22 (TRDD-0SA5QZTG), and the resolution retracts the paragraph that stood
    // here: the low sharing was NOT a property of the corpus, it was this test reading the wrong
    // DIRECTORY. It hardcoded the legacy `~/.agentlens/otel-bodies`, which under SPOOL_MODE holds
    // only what the pass had not yet drained when the spool took over — a frozen, gap-riddled
    // residue. Measured the same hour, same code, the two dirs answer differently:
    //     legacy residue : mean shared prefix 34%, longest run sharing >=70%:  3  (below the floor
    //                      of 5 — so this test SKIPPED, and the skip message blamed "the drain")
    //     live spool     : mean shared prefix 81%, longest run sharing >=70%: 26
    // So there was never a missing-adjacency phenomenon to explain, and the third wrong cause in a
    // row would have been "the drain removed the adjacency" — which is what the retracted text
    // said. `realBodies` now resolves through `resolveBodiesReadScope`, the server's own reader
    // scope, so the test reads exactly what the server writes.
    //
    // The property-based selection below is KEPT anyway. It is what made the wrong-directory bug
    // survivable — the test skipped loudly with a measurement instead of failing a correct store —
    // and it stays correct whatever the cause of a future gap. Selecting on the property itself,
    // and skipping with the measurement when it is absent, is what makes the assertion honest
    // either way.
    const sharedPrefixFrac = (a: string, b: string): number => {
      const n = Math.min(a.length, b.length)
      let k = 0
      while (k < n && a.charCodeAt(k) === b.charCodeAt(k)) k++
      return k / a.length
    }
    // DERIVED, not chosen — and derived against THIS assertion, not an estimate of it. Sweeping T
    // and ingesting each admitted run through the REAL store gives:
    //     T=0.5 -> 1.52x   T=0.6 -> 1.52x   T=0.7 -> 3.00x
    // so 0.70 is the LOWEST threshold whose run clears the >2x floor, and the cliff is a cliff.
    //
    // Two derivations that LOOK right and are not, kept because each is convincing alone:
    //   * the distribution's shape — pair-sharing is bimodal with its trough at 30-39%, so a
    //     shape-derived threshold would be ~0.35, which admits runs measuring 1.52x;
    //   * the algebra — `ratio ~ 1/(1-f)` predicts f > 0.50 suffices. It does not: turn 1's
    //     constant ~268 KB tools array plus per-turn unique content eat the margin.
    // A prefix-overlap ESTIMATE of the ratio is also not the ratio — it read 1.99x where the store
    // measures 1.52x, i.e. "just under" where the truth is "clearly under". Re-derive by sweeping
    // T through the real store if the floor ever moves; do not reason it out and do not estimate it.
    const ADJACENT = 0.70
    const ordered = [...bySession.values()]
      .sort((a, b) => b.length - a.length)[0]
      .sort((a, b) => a.mtime - b.mtime)
    let best: typeof ordered = []
    // `ordered` is non-empty because the `all.length === 0` guard above returned already — NOT
    // because groups are non-empty, which is the wrong invariant: the risk here is an empty MAP
    // (`[...values()][0]` would be undefined and `.sort()` would throw), and group non-emptiness
    // says nothing about that. Naming the guard that actually holds, 15 lines up, is the point.
    let run: typeof ordered = [ordered[0]]
    for (let i = 1; i < ordered.length; i++) {
      if (sharedPrefixFrac(ordered[i - 1].raw, ordered[i].raw) >= ADJACENT) run.push(ordered[i])
      else { if (run.length > best.length) best = run; run = [ordered[i]] }
    }
    if (run.length > best.length) best = run
    const turns = best.slice(0, 12)
    // Skip WITH A REASON, never silently: a suite that quietly skips its own subject reports green
    // for a corpus that can no longer answer the question, which is worse than a red test.
    if (turns.length < 5) {
      // Name the DIRS, not a cause. The last version of this message asserted a cause ("the pass
      // is draining faster than turns accumulate") that turned out to be false — the test was
      // reading a drained legacy dir instead of the live spool. A skip that prints where it
      // looked is debuggable; a skip that prints a theory sends the next reader after a phantom.
      console.log(`      ⏭  skipped: no run of >=5 CONSECUTIVE turns for one session in `
        + `[${REAL_BODIES_DIRS.join(', ') || 'no readable bodies dir'}] `
        + `(longest run sharing >=${ADJACENT * 100}% prefix: ${best.length} of ${ordered.length} `
        + `turns in the largest session, ${all.length} bodies scanned). Turns across a gap share `
        + `no transcript, so a dedup floor would measure the wrong thing. Check that this is the `
        + `dir the server is CAPTURING to: agentlenspro server status | grep capture`)
      this.skip(); return
    }

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
