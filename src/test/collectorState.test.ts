// TRDD-PJC8N1HO — unit tests for durable collector state: log offsets, lifecycle, downtime gaps.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  loadLogOffsets, saveLogOffsets, loadPersistedCards, savePersistedCards,
  recordCollectorStart, recordCollectorHeartbeat, recordCollectorStop, computeCollectorGaps,
  LOG_INGEST_VERSION,
  type LifecycleStore,
} from '../collectorState'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-state-'))
  return path.join(dir, name)
}

suite('collectorState — log offsets', () => {
  test('save then load round-trips the offset map', () => {
    const f = tmpFile('offsets.json')
    const offsets = { '/a.jsonl': { bytesRead: 100, mtimeMs: 5, ino: 42, size: 100 } }
    saveLogOffsets(f, offsets)
    assert.deepStrictEqual(loadLogOffsets(f), offsets)
  })

  test('load returns null for a missing or corrupt file (→ safe cold rescan)', () => {
    assert.strictEqual(loadLogOffsets('/no/such/file.json'), null)
    const f = tmpFile('bad.json')
    fs.writeFileSync(f, '{not json')
    assert.strictEqual(loadLogOffsets(f), null)
  })

  test('load skips records missing the load-bearing bytesRead/mtimeMs (fail-fast)', () => {
    const f = tmpFile('partial.json')
    fs.writeFileSync(f, JSON.stringify({ v: LOG_INGEST_VERSION, offsets: { '/good.jsonl': { bytesRead: 1, mtimeMs: 2 }, '/bad.jsonl': { mtimeMs: 2 } } }))
    assert.deepStrictEqual(loadLogOffsets(f), { '/good.jsonl': { bytesRead: 1, mtimeMs: 2, ino: undefined, size: undefined } })
  })

  test('load rejects a version-stale or legacy-unversioned offsets file (→ cold rescan)', () => {
    // Resuming version-stale offsets would SKIP unchanged files whose cards were built under old
    // ingest semantics, silently freezing the old numbers — so both shapes must return null.
    const legacy = tmpFile('legacy.json')
    fs.writeFileSync(legacy, JSON.stringify({ '/a.jsonl': { bytesRead: 1, mtimeMs: 2 } }))
    assert.strictEqual(loadLogOffsets(legacy), null)
    const stale = tmpFile('stale.json')
    fs.writeFileSync(stale, JSON.stringify({ v: LOG_INGEST_VERSION - 1, offsets: { '/a.jsonl': { bytesRead: 1, mtimeMs: 2 } } }))
    assert.strictEqual(loadLogOffsets(stale), null)
  })
})

suite('collectorState — persisted cards', () => {
  const card = (id: string): SessionSummaryCard => ({ sessionId: id } as SessionSummaryCard)

  test('save then load round-trips the card list', () => {
    const f = tmpFile('cards.json')
    savePersistedCards(f, [card('a'), card('b')])
    const loaded = loadPersistedCards(f)
    assert.strictEqual(loaded?.length, 2)
    assert.deepStrictEqual(loaded?.map(c => c.sessionId), ['a', 'b'])
  })

  test('load returns null for a non-array / corrupt file', () => {
    const f = tmpFile('bad.json')
    fs.writeFileSync(f, '{"not":"an array"}')
    assert.strictEqual(loadPersistedCards(f), null)
    assert.strictEqual(loadPersistedCards('/no/such.json'), null)
  })

  test('load rejects a legacy bare-array or version-stale cards file (→ cold rescan rebuilds them)', () => {
    const legacy = tmpFile('legacy-cards.json')
    fs.writeFileSync(legacy, JSON.stringify([{ sessionId: 'old' }]))
    assert.strictEqual(loadPersistedCards(legacy), null)
    const stale = tmpFile('stale-cards.json')
    fs.writeFileSync(stale, JSON.stringify({ v: LOG_INGEST_VERSION - 1, cards: [{ sessionId: 'old' }] }))
    assert.strictEqual(loadPersistedCards(stale), null)
  })
})

suite('collectorState — lifecycle', () => {
  test('start appends a run with startedAt === lastHeartbeat and no stoppedAt', () => {
    const f = tmpFile('lc.json')
    const store = recordCollectorStart(f, new Date('2026-07-07T10:00:00Z'))
    assert.strictEqual(store.runs.length, 1)
    assert.strictEqual(store.runs[0].startedAt, store.runs[0].lastHeartbeat)
    assert.strictEqual(store.runs[0].stoppedAt, undefined)
    // Persisted to disk and reloadable across a "restart".
    const store2 = recordCollectorStart(f, new Date('2026-07-07T10:05:00Z'))
    assert.strictEqual(store2.runs.length, 2)
  })

  test('heartbeat advances the current run lastHeartbeat; stop sets stoppedAt', () => {
    const f = tmpFile('lc.json')
    const store = recordCollectorStart(f, new Date('2026-07-07T10:00:00Z'))
    recordCollectorHeartbeat(f, store, new Date('2026-07-07T10:00:30Z'))
    assert.strictEqual(store.runs[0].lastHeartbeat, '2026-07-07T10:00:30.000Z')
    recordCollectorStop(f, store, new Date('2026-07-07T10:01:00Z'))
    assert.strictEqual(store.runs[0].stoppedAt, '2026-07-07T10:01:00.000Z')
  })
})

suite('collectorState — computeCollectorGaps', () => {
  const run = (startedAt: string, lastHeartbeat: string, stoppedAt?: string) => ({ startedAt, lastHeartbeat, stoppedAt })

  test('a crash gap (no stoppedAt on the prior run) is reason=crash, spanning lastHeartbeat→next start', () => {
    const store: LifecycleStore = { runs: [
      run('2026-07-07T10:00:00Z', '2026-07-07T10:00:30Z'),          // crashed ~10:00:30
      run('2026-07-07T10:10:00Z', '2026-07-07T10:10:00Z'),          // restarted 10:10
    ] }
    const gaps = computeCollectorGaps(store)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].reason, 'crash')
    assert.strictEqual(gaps[0].startedAt, '2026-07-07T10:00:30.000Z')
    assert.strictEqual(gaps[0].endedAt, '2026-07-07T10:10:00.000Z')
    assert.strictEqual(gaps[0].durationMs, 570_000)
  })

  test('a clean shutdown gap (prior run has stoppedAt) is reason=shutdown', () => {
    const store: LifecycleStore = { runs: [
      run('2026-07-07T10:00:00Z', '2026-07-07T10:05:00Z', '2026-07-07T10:05:00Z'),
      run('2026-07-07T10:10:00Z', '2026-07-07T10:10:00Z'),
    ] }
    const gaps = computeCollectorGaps(store)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].reason, 'shutdown')
    assert.strictEqual(gaps[0].startedAt, '2026-07-07T10:05:00.000Z')
  })

  test('a sub-threshold gap (fast supervised restart) is not reported', () => {
    const store: LifecycleStore = { runs: [
      run('2026-07-07T10:00:00Z', '2026-07-07T10:00:00Z'),
      run('2026-07-07T10:00:03Z', '2026-07-07T10:00:03Z'),   // 3s later — under the 15s default
    ] }
    assert.strictEqual(computeCollectorGaps(store).length, 0)
  })

  test('a single run (or none) yields no gaps', () => {
    assert.strictEqual(computeCollectorGaps({ runs: [] }).length, 0)
    assert.strictEqual(computeCollectorGaps({ runs: [run('2026-07-07T10:00:00Z', '2026-07-07T10:05:00Z')] }).length, 0)
  })
})
