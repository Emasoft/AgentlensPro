import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SegmentedSpanStore } from '../segmentedSpanStore'
import { scanOtelCallEvents, API_REQUEST_SPAN, COMPACTION_SPAN } from '../otelCallEvents'
import type { Span } from '../shared/telemetryTypes'

// This scan had NO tests while it was a `for (const s of spans) { … continue }` loop over an array.
// It is now a `forEachInRange` visitor whose skips are `return`s, so every branch that used to be a
// `continue` is re-verified here — a callback rewrite is exactly where a silently-dropped or
// silently-duplicated record hides. The reason for the rewrite is memory (TRDD-QK3L5QAS): the array
// form held every span in the window at once, so an unbounded query loaded ~1M span objects to keep
// a handful, and killed the server with a V8 heap OOM at ~4 GB.

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-otel-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

const T0 = Date.UTC(2026, 5, 1, 12, 0, 0)

function span(name: string, at: number, attrs: Record<string, string | number>, i: number): Span {
  return {
    traceId: `trace-${i}`,
    spanId: `span-${i}`,
    name,
    startTime: String(at * 1e6),
    endTime: String(at * 1e6),
    attributes: Object.entries(attrs).map(([key, v]) => ({
      key,
      value: typeof v === 'number' ? { intValue: v } : { stringValue: v },
    })),
    receivedAt: at,
  }
}

function seed(dir: string, spans: Span[]): void {
  const store = new SegmentedSpanStore(dir, () => {})
  for (const s of spans) store.append(s)
  store.flush()
}

suite('otelCallEvents — the visitor scan keeps only what it needs', () => {
  test('an api_request span becomes one event with its attributes carried through', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [span(API_REQUEST_SPAN, T0, {
        'session.id': 'sess-a', request_id: 'req_1', model: 'claude-opus-5',
        input_tokens: 11, output_tokens: 22, cache_read_tokens: 33, cache_creation_tokens: 44,
        cost_usd_micros: 2_500_000, query_source: 'repl_main_thread',
      }, 1)])
      const { events } = await scanOtelCallEvents({ spansDir: dir, sinceMs: 0, untilMs: Infinity })
      assert.strictEqual(events.length, 1)
      assert.strictEqual(events[0].sessionId, 'sess-a')
      assert.strictEqual(events[0].model, 'claude-opus-5')
      assert.strictEqual(events[0].cacheReadTokens, 33)
      // cost_usd_micros is the precise integer form and must win over the float.
      assert.strictEqual(events[0].costUsd, 2.5)
    } finally { cleanup() }
  })

  test('a compaction span lands in compactions and NOT in events', async () => {
    // This branch ended in `continue` before the rewrite; as a callback it must `return`, or the
    // compaction would fall through and be re-emitted as an api_request event too.
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [span(COMPACTION_SPAN, T0, {
        'session.id': 'sess-a', trigger: 'auto', pre_tokens: 900, post_tokens: 100,
      }, 1)])
      const r = await scanOtelCallEvents({ spansDir: dir, sinceMs: 0, untilMs: Infinity })
      assert.strictEqual(r.events.length, 0, 'a compaction must never be counted as an api_request')
      assert.deepStrictEqual(
        r.compactions.map(c => [c.sessionId, c.trigger, c.preTokens, c.postTokens]),
        [['sess-a', 'auto', 900, 100]],
      )
    } finally { cleanup() }
  })

  test('a skipped span does not stop the scan — the ones after it are still collected', async () => {
    // The failure a continue→return conversion invites is a skip that behaves like a break. Two
    // skip reasons sit BEFORE a good record here: a foreign span name, and a missing session.id.
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [
        span('claude_code.something_else', T0, { 'session.id': 'sess-a' }, 1),
        span(API_REQUEST_SPAN, T0 + 1, { model: 'no-session-id-here' }, 2),
        span(API_REQUEST_SPAN, T0 + 2, { 'session.id': 'sess-b', model: 'claude-sonnet-5' }, 3),
      ])
      const { events } = await scanOtelCallEvents({ spansDir: dir, sinceMs: 0, untilMs: Infinity })
      assert.deepStrictEqual(events.map(e => e.sessionId), ['sess-b'])
    } finally { cleanup() }
  })

  test('spansScanned counts PARSED candidates only — non-candidate lines never reach JSON.parse', async () => {
    // CONTRACT FLIP, deliberate (TRDD-9NAUEUUR): this test used to pin "counts EVERY span in the
    // window". That contract died with the line prefilter — parsing every span to count it was
    // the ~2GB/GC transient churn that killed the live server three times, so non-candidate
    // lines are now skipped BEFORE the parse and are deliberately uncountable. The two
    // tool_decision spans below must therefore be INVISIBLE to the counter; only the
    // api_request candidate is parsed. (CI caught the old pin going red on the prefilter
    // commit — this is the recorded decision, not an accident.)
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [
        span('claude_code.tool_decision', T0, {}, 1),
        span('claude_code.tool_decision', T0 + 1, {}, 2),
        span(API_REQUEST_SPAN, T0 + 2, { 'session.id': 'sess-a' }, 3),
      ])
      const r = await scanOtelCallEvents({ spansDir: dir, sinceMs: 0, untilMs: Infinity })
      assert.strictEqual(r.coverage.spansScanned, 1, 'only the candidate line is parsed and counted')
      assert.strictEqual(r.coverage.apiRequests, 1, 'and it was kept')
      assert.match(r.coverage.note, /Parsed 1 candidate span line\(s\)/)
    } finally { cleanup() }
  })

  test('the window excludes what falls outside it, and events come back time-ordered', async () => {
    const { dir, cleanup } = tmpDir()
    try {
      seed(dir, [
        span(API_REQUEST_SPAN, T0 - 10_000, { 'session.id': 'too-early' }, 1),
        span(API_REQUEST_SPAN, T0 + 500, { 'session.id': 'second' }, 2),
        span(API_REQUEST_SPAN, T0 + 100, { 'session.id': 'first' }, 3),
        span(API_REQUEST_SPAN, T0 + 99_000, { 'session.id': 'too-late' }, 4),
      ])
      const { events } = await scanOtelCallEvents({ spansDir: dir, sinceMs: T0, untilMs: T0 + 1000 })
      assert.deepStrictEqual(events.map(e => e.sessionId), ['first', 'second'])
    } finally { cleanup() }
  })

  test('a store directory that does not exist yet is an EMPTY scan, not an error', async () => {
    // A fresh install has no spans dir. The store swallows that readdir failure itself, so this
    // reports the ordinary "Scanned 0" note — NOT the fallback note. Asserting the fallback here
    // is what this test originally did, and it was wrong: that path has never fired for a merely
    // absent directory, before the rewrite or after.
    const gone = path.join(os.tmpdir(), `al-otel-absent-${process.pid}-${seq++}`)
    const r = await scanOtelCallEvents({ spansDir: gone, sinceMs: 0, untilMs: Infinity })
    assert.deepStrictEqual(r.events, [])
    assert.strictEqual(r.coverage.spansScanned, 0)
    assert.match(r.coverage.note, /Parsed 0 candidate span line\(s\)/)
  })

  test('a store path that cannot be a store returns empty rather than throwing', async () => {
    // The documented contract is "never throws, so a caller can always fall back to the raw-body
    // scan" — that is what is asserted, and only that. The `falling back to the raw-body scan`
    // NOTE is deliberately NOT asserted: it needs the constructor or the index load to throw, and
    // neither a missing dir nor a file-where-a-dir-should-be gets that far (the store catches its
    // own readdir and mkdir failures). Asserting a note this input cannot produce would be a test
    // of a path no fixture here reaches.
    const { dir, cleanup } = tmpDir()
    try {
      const notADir = path.join(dir, 'spans-but-actually-a-file')
      fs.writeFileSync(notADir, 'this is not a span store')
      const r = await scanOtelCallEvents({ spansDir: notADir, sinceMs: 0, untilMs: Infinity })
      assert.deepStrictEqual(r.events, [])
      assert.deepStrictEqual(r.compactions, [])
      assert.strictEqual(r.coverage.spansScanned, 0)
    } finally { cleanup() }
  })
})
