// Spool evacuation (TRDD-MW573BGT) — falsifies the exact failure the card exists to prevent: a
// spool overflow must never lose a body. The redirect (KB17X5G2) only protects sessions that start
// AFTER it fires; an already-running session keeps writing into the spool, so this is the layer
// that frees space fast enough for those writers to survive. Two halves, matching the card's two
// acceptance boxes: the PURE planner (no filesystem) and the real-fs mover (temp dirs standing in
// for spool/dest).
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  planEvacuation, evacuateFile, runSpoolEvacuation, listEvacuationCandidates,
  EVAC_QUIESCENCE_MS, DEFAULT_SPOOL_EVAC_BYTES, spoolEvacThresholdBytes, SPOOL_EVAC_MB_ENV,
  DEFAULT_SPOOL_FLOOR_BYTES,
  type EvacCandidate,
} from '../spoolBackpressure'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-evac-')) }

// ── Box 1: the pure planner ─────────────────────────────────────────────────────────────────────
suite('planEvacuation — pure oldest-first, quiescent-only, budget-bounded selection', () => {
  test('picks oldest-first among quiescent files, skips a too-fresh one, and stops at the byte budget', () => {
    const nowMs = 1_000_000
    const files: EvacCandidate[] = [
      { name: 'a.request.json', mtime: nowMs - 10_000, size: 100 }, // oldest
      { name: 'b.request.json', mtime: nowMs - 8_000, size: 100 },
      { name: 'c.request.json', mtime: nowMs - 6_000, size: 100 }, // newest quiescent
      { name: 'd.request.json', mtime: nowMs - 1_000, size: 100 }, // too fresh (< 3s old)
    ]
    // targetFreeBytes way above freeBytes so only the byte budget (200) limits selection.
    const plan = planEvacuation({ freeBytes: 0, targetFreeBytes: Number.MAX_SAFE_INTEGER, files, nowMs, maxBytesPerTick: 200 })
    assert.deepStrictEqual(plan.toEvacuate.map((f) => f.name), ['a.request.json', 'b.request.json'])
    assert.strictEqual(plan.bytesPlanned, 200)
  })

  test('a file younger than the quiescence gate is never selected, even alone and under budget', () => {
    const nowMs = 1_000_000
    const files: EvacCandidate[] = [{ name: 'fresh.request.json', mtime: nowMs - (EVAC_QUIESCENCE_MS - 1), size: 10 }]
    const plan = planEvacuation({ freeBytes: 0, targetFreeBytes: Number.MAX_SAFE_INTEGER, files, nowMs })
    assert.deepStrictEqual(plan.toEvacuate, [])
    assert.strictEqual(plan.bytesPlanned, 0)
  })

  test('a file exactly at the quiescence boundary IS selected (>= , not >)', () => {
    const nowMs = 1_000_000
    const files: EvacCandidate[] = [{ name: 'boundary.request.json', mtime: nowMs - EVAC_QUIESCENCE_MS, size: 10 }]
    const plan = planEvacuation({ freeBytes: 0, targetFreeBytes: Number.MAX_SAFE_INTEGER, files, nowMs })
    assert.deepStrictEqual(plan.toEvacuate.map((f) => f.name), ['boundary.request.json'])
  })

  test('stops once the projected free bytes reach the target, before the byte budget is hit', () => {
    const nowMs = 1_000_000
    const files: EvacCandidate[] = [
      { name: 'a.request.json', mtime: nowMs - 10_000, size: 50 },
      { name: 'b.request.json', mtime: nowMs - 9_000, size: 50 },
      { name: 'c.request.json', mtime: nowMs - 8_000, size: 50 },
    ]
    // freeBytes 0, target 60: after 'a' (50) projected free is 50 (< 60), after 'b' it's 100 (>= 60) — stop.
    const plan = planEvacuation({ freeBytes: 0, targetFreeBytes: 60, files, nowMs, maxBytesPerTick: 1_000_000 })
    assert.deepStrictEqual(plan.toEvacuate.map((f) => f.name), ['a.request.json', 'b.request.json'])
  })

  test('nothing to do when free bytes already meet the target', () => {
    const nowMs = 1_000_000
    const files: EvacCandidate[] = [{ name: 'a.request.json', mtime: nowMs - 10_000, size: 50 }]
    const plan = planEvacuation({ freeBytes: 1000, targetFreeBytes: 1000, files, nowMs })
    assert.deepStrictEqual(plan.toEvacuate, [])
  })
})

suite('spoolEvacThresholdBytes — env override, tolerant parse, above the redirect floor by default', () => {
  test('default is 256MB and sits above the 64MB redirect floor', () => {
    assert.strictEqual(spoolEvacThresholdBytes({}), DEFAULT_SPOOL_EVAC_BYTES)
    assert.ok(DEFAULT_SPOOL_EVAC_BYTES > DEFAULT_SPOOL_FLOOR_BYTES, 'the evac threshold must stay above the redirect floor')
  })
  test('env override and nonsense fall back to default', () => {
    assert.strictEqual(spoolEvacThresholdBytes({ [SPOOL_EVAC_MB_ENV]: '512' }), 512 * 1024 * 1024)
    assert.strictEqual(spoolEvacThresholdBytes({ [SPOOL_EVAC_MB_ENV]: 'nope' }), DEFAULT_SPOOL_EVAC_BYTES)
    assert.strictEqual(spoolEvacThresholdBytes({ [SPOOL_EVAC_MB_ENV]: '0' }), DEFAULT_SPOOL_EVAC_BYTES)
  })
})

// ── Box 2: real-fs mover + end-to-end evacuation ────────────────────────────────────────────────
suite('evacuateFile — copy→fsync→rename→fsync dir→unlink, byte-identical, crash-safe collision', () => {
  let spoolDir: string
  let destDir: string
  setup(() => { spoolDir = tmp(); destDir = tmp() })
  teardown(() => { fs.rmSync(spoolDir, { recursive: true, force: true }); fs.rmSync(destDir, { recursive: true, force: true }) })

  test('moves one file verbatim: byte-identical in dest, source gone, no leftover tmp', async () => {
    const content = JSON.stringify({ hello: 'world', n: 12345 })
    fs.writeFileSync(path.join(spoolDir, 'req-1.request.json'), content)
    await evacuateFile(spoolDir, destDir, 'req-1.request.json')
    assert.strictEqual(fs.existsSync(path.join(spoolDir, 'req-1.request.json')), false, 'source must be gone')
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'req-1.request.json'), 'utf8'), content, 'dest must be byte-identical')
    assert.strictEqual(fs.existsSync(path.join(destDir, 'req-1.request.json.evac.tmp')), false, 'no leftover tmp file')
  })

  test('a same-name collision in dest is overwritten cleanly via the same temp+rename', async () => {
    fs.writeFileSync(path.join(destDir, 'req-1.request.json'), 'STALE-OLD-CONTENT')
    const fresh = JSON.stringify({ turn: 2 })
    fs.writeFileSync(path.join(spoolDir, 'req-1.request.json'), fresh)
    await evacuateFile(spoolDir, destDir, 'req-1.request.json')
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'req-1.request.json'), 'utf8'), fresh)
    assert.strictEqual(fs.existsSync(path.join(spoolDir, 'req-1.request.json')), false)
  })
})

suite('runSpoolEvacuation — end-to-end batch, real fs, mixed quiescent/fresh/collision', () => {
  let spoolDir: string
  let destDir: string
  setup(() => { spoolDir = tmp(); destDir = tmp() })
  teardown(() => { fs.rmSync(spoolDir, { recursive: true, force: true }); fs.rmSync(destDir, { recursive: true, force: true }) })

  test('evacuates only quiescent files, leaves the too-fresh one, byte-identical, sources removed', async () => {
    const oldContent = JSON.stringify({ turn: 1, big: 'x'.repeat(500) })
    const newContent = JSON.stringify({ turn: 2 })
    fs.writeFileSync(path.join(spoolDir, 'old.request.json'), oldContent)
    fs.writeFileSync(path.join(spoolDir, 'fresh.request.json'), newContent)
    // Backdate the "old" file's mtime past the quiescence gate; leave "fresh" at its real (just-now) mtime.
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(path.join(spoolDir, 'old.request.json'), past, past)

    const result = await runSpoolEvacuation({
      spoolDir, destDir,
      freeBytes: 0,
      thresholdBytes: 1_000_000_000, // huge target so the whole quiescent set is planned
    })

    assert.strictEqual(result.moved, 1)
    assert.strictEqual(result.failed.length, 0)
    assert.strictEqual(fs.existsSync(path.join(spoolDir, 'old.request.json')), false, 'quiescent file evacuated')
    assert.strictEqual(fs.existsSync(path.join(spoolDir, 'fresh.request.json')), true, 'too-fresh file left untouched in spool')
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'old.request.json'), 'utf8'), oldContent, 'dest content byte-identical')
  })

  test('a collision in dest is overwritten via the same temp+rename during a real batch', async () => {
    fs.writeFileSync(path.join(destDir, 'dup.request.json'), 'STALE')
    const fresh = JSON.stringify({ v: 2 })
    fs.writeFileSync(path.join(spoolDir, 'dup.request.json'), fresh)
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(path.join(spoolDir, 'dup.request.json'), past, past)

    const result = await runSpoolEvacuation({ spoolDir, destDir, freeBytes: 0, thresholdBytes: 1_000_000_000 })
    assert.strictEqual(result.moved, 1)
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'dup.request.json'), 'utf8'), fresh)
  })

  test('one bad file (unreadable source) is logged and skipped without aborting the rest of the batch', async () => {
    const good = JSON.stringify({ ok: true })
    fs.writeFileSync(path.join(spoolDir, 'good.request.json'), good)
    const past = new Date(Date.now() - 10_000)
    fs.utimesSync(path.join(spoolDir, 'good.request.json'), past, past)

    const warns: string[] = []
    // moveFile seam: simulate a bad file that throws on move for one specific name, real for the rest.
    const result = await runSpoolEvacuation({
      spoolDir, destDir, freeBytes: 0, thresholdBytes: 1_000_000_000,
      listFiles: () => [
        { name: 'bad.request.json', mtime: Date.now() - 10_000, size: 5 },
        { name: 'good.request.json', mtime: Date.now() - 10_000, size: good.length },
      ],
      moveFile: async (s, d, name) => {
        if (name === 'bad.request.json') throw new Error('simulated I/O failure')
        return evacuateFile(s, d, name)
      },
      onWarn: (m) => warns.push(m),
    })

    assert.strictEqual(result.moved, 1, 'the good file still gets moved')
    assert.strictEqual(result.failed.length, 1)
    assert.ok(result.failed[0].includes('bad.request.json'))
    assert.strictEqual(warns.length, 1, 'the failure is logged')
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'good.request.json'), 'utf8'), good)
  })

  test('a dest tmp left over from a previous crash never blocks a fresh evacuation of the same name', async () => {
    // Simulates a crash between "copy to tmp" and "rename": a stale .evac.tmp already sits in dest.
    fs.writeFileSync(path.join(destDir, 'crashed.request.json.evac.tmp'), 'PARTIAL-FROM-CRASH')
    const fresh = JSON.stringify({ recovered: true })
    fs.writeFileSync(path.join(spoolDir, 'crashed.request.json'), fresh)
    await evacuateFile(spoolDir, destDir, 'crashed.request.json')
    assert.strictEqual(fs.readFileSync(path.join(destDir, 'crashed.request.json'), 'utf8'), fresh, 'the fresh copy wins — stale tmp overwritten, never blocks')
    assert.strictEqual(fs.existsSync(path.join(spoolDir, 'crashed.request.json')), false)
  })
})

suite('listEvacuationCandidates — mirrors ingestPass.bodyFiles filename filter exactly', () => {
  let dir: string
  setup(() => { dir = tmp() })
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('only .request.json / .response.json are candidates; everything else is ignored', () => {
    fs.writeFileSync(path.join(dir, 'a.request.json'), '{}')
    fs.writeFileSync(path.join(dir, 'a.response.json'), '{}')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me')
    fs.writeFileSync(path.join(dir, '.DS_Store'), '')
    const names = listEvacuationCandidates(dir).map((f) => f.name).sort()
    assert.deepStrictEqual(names, ['a.request.json', 'a.response.json'])
  })

  test('a nonexistent directory returns an empty list rather than throwing', () => {
    assert.deepStrictEqual(listEvacuationCandidates(path.join(dir, 'does-not-exist')), [])
  })
})
