// TRDD-8TM7I49X — parked-bodies gauge (rustStorePass.parkedBodiesGauge) and its rendering
// through bodiesCaptureLine's parkedSuffix clause.
//
// Why this test exists: parked names are pinned FOREVER on a durable target, never reclaimed by
// any pass. The gauge is the only visibility into that permanent state, and it has three ways to
// silently lie: counting a stat twice, rendering "0" for "I could not look", and rendering a
// permanent warning on a healthy server (which trains readers to ignore the line on the day it
// matters). Each test below pins one of those failure modes.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parkedBodiesGauge } from '../rustStorePass'
import { bodiesCaptureLine } from '../cli/serverControl'

suite('parkedBodiesGauge — the stat-once-across-dirs gauge over .pass-state.json', () => {
  let storeDir: string
  let liveA: string
  let liveB: string

  setup(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-parked-store-'))
    liveA = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-parked-liveA-'))
    liveB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-parked-liveB-'))
  })

  teardown(() => {
    fs.rmSync(storeDir, { recursive: true, force: true })
    fs.rmSync(liveA, { recursive: true, force: true })
    fs.rmSync(liveB, { recursive: true, force: true })
  })

  const writeState = (names: string[]) =>
    fs.writeFileSync(path.join(storeDir, '.pass-state.json'), JSON.stringify({ strandedNames: names }))

  test('3 stranded names all present in the first liveDir: files=3, onDisk=3, bytes = exact sum', () => {
    writeState(['a.jsonl', 'b.jsonl', 'c.jsonl'])
    fs.writeFileSync(path.join(liveA, 'a.jsonl'), Buffer.alloc(100))
    fs.writeFileSync(path.join(liveA, 'b.jsonl'), Buffer.alloc(250))
    fs.writeFileSync(path.join(liveA, 'c.jsonl'), Buffer.alloc(7))
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.deepStrictEqual(g, { files: 3, bytes: 357, onDisk: 3 })
  })

  test('a parked name found only in the SECOND liveDir is still counted (both dirs scanned)', () => {
    writeState(['second-dir-only.jsonl'])
    fs.writeFileSync(path.join(liveB, 'second-dir-only.jsonl'), Buffer.alloc(42))
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.deepStrictEqual(g, { files: 1, bytes: 42, onDisk: 1 })
  })

  test('a parked name with no file anywhere is a "ghost": counted in files, not onDisk, 0 bytes', () => {
    writeState(['ghost.jsonl'])
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.deepStrictEqual(g, { files: 1, bytes: 0, onDisk: 0 })
  })

  test('the same name present in BOTH liveDirs is counted ONCE, from the first dir only', () => {
    writeState(['dup.jsonl'])
    fs.writeFileSync(path.join(liveA, 'dup.jsonl'), Buffer.alloc(11))
    fs.writeFileSync(path.join(liveB, 'dup.jsonl'), Buffer.alloc(999))
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.deepStrictEqual(g, { files: 1, bytes: 11, onDisk: 1 })
  })

  test('a missing .pass-state.json returns null, never {files:0}', () => {
    // An absent reading and a zero are opposite claims: null says "I could not look", {files:0}
    // would say "I looked and there is nothing parked" — a server that never wrote the state
    // file must not be reported as clean.
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.strictEqual(g, null)
  })

  test('an unparseable .pass-state.json returns null', () => {
    fs.writeFileSync(path.join(storeDir, '.pass-state.json'), '{not valid json')
    const g = parkedBodiesGauge(storeDir, [liveA, liveB])
    assert.strictEqual(g, null)
  })

  test('a .pass-state.json whose strandedNames is not an array returns null', () => {
    fs.writeFileSync(path.join(storeDir, '.pass-state.json'), JSON.stringify({ strandedNames: 'nope' }))
    assert.strictEqual(parkedBodiesGauge(storeDir, [liveA, liveB]), null)
    fs.writeFileSync(path.join(storeDir, '.pass-state.json'), JSON.stringify({}))
    assert.strictEqual(parkedBodiesGauge(storeDir, [liveA, liveB]), null)
  })
})

suite('bodiesCaptureLine — parkedSuffix rendering', () => {
  const NOW = Date.parse('2026-08-22T21:00:00Z')
  const stats = (
    uptimeSec: number,
    live: { files: number; newestMs: number | null } | undefined,
    parked: { files: number; bytes: number; onDisk: number } | null | undefined,
  ) => ({ uptimeSec, bodies: { live, parked } })

  test('undefined parked (older server) and {files:0} parked (healthy server) both render silently', () => {
    // A permanent warning on a healthy server is exactly what gets filtered out on the day it
    // matters — so both "never sent" and "sent, zero" must produce no PARKED / parked: text.
    const undef = bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 1000 }, undefined), NOW)
    const zero = bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 1000 }, { files: 0, bytes: 0, onDisk: 0 }), NOW)
    assert.ok(!/PARKED/.test(undef) && !/parked:/.test(undef), undef)
    assert.ok(!/PARKED/.test(zero) && !/parked:/.test(zero), zero)
  })

  test('null parked renders "parked: unknown", never a zero; a real gauge renders count and MB', () => {
    const unknown = bodiesCaptureLine(stats(600, { files: 1, newestMs: NOW - 1000 }, null), NOW)
    assert.ok(/parked: unknown/.test(unknown), unknown)

    const real = bodiesCaptureLine(
      stats(600, { files: 1, newestMs: NOW - 1000 }, { files: 1045, bytes: 333050000, onDisk: 1045 }),
      NOW,
    )
    assert.ok(/PARKED 1045 file\(s\)/.test(real), real)
    assert.ok(/317\.6MB/.test(real), real)
  })
})
