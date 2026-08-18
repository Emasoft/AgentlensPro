import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SegmentedSpanStore } from '../segmentedSpanStore'
import { scanOtelCallEvents, API_REQUEST_SPAN, COMPACTION_SPAN } from '../otelCallEvents'
import { scanOtelCallEventsIndexed } from '../otelCallIndex'
import type { Span } from '../shared/telemetryTypes'

// TRDD-7I5805QM — the incremental call-events index. The contract under test is the one that
// killed a core for minutes per call: an unbounded query must NOT re-parse sealed segments after
// their one-time extraction. The decisive test corrupts a sealed segment on disk AFTER the index
// was built — a second query that still answers correctly PROVES the store was not re-read.

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-callidx-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// Fixed clock: "today" is 2026-06-03 (UTC); 06-01 and 06-02 are sealed days.
const NOW = Date.UTC(2026, 5, 3, 12, 0, 0)
const DAY1 = Date.UTC(2026, 5, 1, 10, 0, 0)
const DAY2 = Date.UTC(2026, 5, 2, 10, 0, 0)
const TODAY = Date.UTC(2026, 5, 3, 10, 0, 0)

function span(name: string, at: number, attrs: Record<string, string | number>, i: number): Span {
  return {
    traceId: `trace-${i}`, spanId: `span-${i}`, name,
    startTime: String(at * 1e6), endTime: String(at * 1e6),
    attributes: Object.entries(attrs).map(([key, v]) => ({
      key, value: typeof v === 'number' ? { intValue: v } : { stringValue: v },
    })),
    receivedAt: at,
  }
}

function call(at: number, i: number, session = 'sess-a'): Span {
  return span(API_REQUEST_SPAN, at, { 'session.id': session, request_id: `req_${i}`, input_tokens: i }, i)
}

function seed(dir: string, spans: Span[]): void {
  const store = new SegmentedSpanStore(dir, () => {})
  for (const s of spans) store.append(s)
  store.flush()
}

suite('otelCallIndex — sealed days are extracted once, never re-parsed (TRDD-7I5805QM)', () => {
  test('an all-history indexed scan matches the direct scan exactly (parity)', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [
        call(DAY1, 1), call(DAY1 + 60_000, 2),
        span(COMPACTION_SPAN, DAY2, { 'session.id': 'sess-a', trigger: 'auto', pre_tokens: 900, post_tokens: 100 }, 3),
        call(DAY2 + 60_000, 4), call(TODAY, 5),
      ])
      const direct = await scanOtelCallEvents({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      const indexed = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(
        indexed.events.map(e => e.requestId),
        direct.events.map(e => e.requestId),
        'the index must be an implementation change, never an answer change',
      )
      assert.deepStrictEqual(
        indexed.compactions.map(c => [c.sessionId, c.trigger]),
        direct.compactions.map(c => [c.sessionId, c.trigger]),
      )
    } finally { cleanup() }
  })

  test('THE POINT: after extraction, a sealed segment is never read again — proven by corrupting it', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [call(DAY1, 1), call(DAY2, 2), call(TODAY, 3)])
      const first = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(first.events.map(e => e.requestId), ['req_1', 'req_2', 'req_3'])
      assert.ok(fs.existsSync(path.join(dir, '.call-events-index', '2026-06-01.calls.json')), 'sidecar written for sealed day 1')
      assert.ok(fs.existsSync(path.join(dir, '.call-events-index', '2026-06-02.calls.json')), 'sidecar written for sealed day 2')

      // Replace the sealed segments with garbage. A re-parse would now either fail or change the
      // answer; answering identically proves the query was served from the sidecars alone.
      fs.writeFileSync(path.join(dir, '2026-06-01.ndjson'), 'not json at all\n')
      fs.writeFileSync(path.join(dir, '2026-06-02.ndjson'), 'not json at all\n')

      const second = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(second.events.map(e => e.requestId), ['req_1', 'req_2', 'req_3'],
        'sealed history must come from the index, not a re-parse of the store')
      assert.match(second.coverage.note, /2 sealed day\(s\) served from sidecars, 0 extracted/)
    } finally { cleanup() }
  })

  test('the live (today) segment is always parsed fresh — new calls appear without any rebuild', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [call(DAY1, 1), call(TODAY, 2)])
      const first = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(first.events.map(e => e.requestId), ['req_1', 'req_2'])

      seed(dir, [call(TODAY + 60_000, 3)]) // a new call lands in today's live segment
      const second = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW + 3_600_000, nowMs: NOW })
      assert.deepStrictEqual(second.events.map(e => e.requestId), ['req_1', 'req_2', 'req_3'])
    } finally { cleanup() }
  })

  test('a bounded window only touches the sidecars it needs and filters by ts', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [call(DAY1, 1), call(DAY2, 2), call(TODAY, 3)])
      const r = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: DAY2 - 1, untilMs: DAY2 + 1, nowMs: NOW })
      assert.deepStrictEqual(r.events.map(e => e.requestId), ['req_2'])
      assert.ok(!fs.existsSync(path.join(dir, '.call-events-index', '2026-06-01.calls.json')),
        'a day outside the window must not be extracted')
    } finally { cleanup() }
  })

  test('a retention-purged segment drops its sidecar — the index never remembers what the store forgot', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [call(DAY1, 1), call(DAY2, 2)])
      await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      const sidecar1 = path.join(dir, '.call-events-index', '2026-06-01.calls.json')
      assert.ok(fs.existsSync(sidecar1))

      fs.unlinkSync(path.join(dir, '2026-06-01.ndjson')) // retention purge
      const after = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(after.events.map(e => e.requestId), ['req_2'])
      assert.ok(!fs.existsSync(sidecar1), 'the orphan sidecar must be dropped')
    } finally { cleanup() }
  })

  test('a fresh install (no spans dir) answers empty without throwing, like the direct scan', async () => {
    const gone = path.join(os.tmpdir(), `al-callidx-absent-${process.pid}-${seq++}`)
    const r = await scanOtelCallEventsIndexed({ spansDir: gone, sinceMs: 0, untilMs: NOW, nowMs: NOW })
    assert.deepStrictEqual(r.events, [])
    assert.strictEqual(r.coverage.spansScanned, 0)
  })

  test('a corrupt sidecar is rebuilt from the segment, never trusted', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [call(DAY1, 1)])
      await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      const sidecar = path.join(dir, '.call-events-index', '2026-06-01.calls.json')
      fs.writeFileSync(sidecar, '{broken')
      const r = await scanOtelCallEventsIndexed({ spansDir: dir, sinceMs: 0, untilMs: NOW, nowMs: NOW })
      assert.deepStrictEqual(r.events.map(e => e.requestId), ['req_1'], 'rebuilt from the still-intact segment')
      assert.match(r.coverage.note, /1 extracted this call/)
    } finally { cleanup() }
  })
})
