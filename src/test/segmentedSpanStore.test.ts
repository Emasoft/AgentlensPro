import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SegmentedSpanStore, migrateLegacySpansFile, spanTimestampMs } from '../segmentedSpanStore'
import type { Span } from '../shared/telemetryTypes'

// ── Segmented span store (P4) — real-filesystem tests ────────────────────────
// Every test drives the real store against a real tmpdir: the store IS a filesystem contract
// (daily append-only NDJSON segments + index), so a mocked fs would test nothing. The three
// P4 acceptance criteria are covered explicitly:
//   1. a >50k-span ingest survives a simulated restart with ZERO spans lost (no cap/eviction),
//   2. retention deletes whole EXPIRED segments only — loudly,
//   3. append never rewrites a segment (existing bytes are untouched; cost is O(record)).

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-seg-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Minimal real span with a controlled receive time (the store's bucketing timestamp). */
function mkSpan(receivedAt: number, i: number): Span {
  return {
    traceId: `trace-${i}`,
    spanId: `span-${i}`,
    name: `op-${i}`,
    startTime: String(receivedAt * 1e6), // OTLP unix-nano string, matching the real parser output
    endTime: String((receivedAt + 5) * 1e6),
    attributes: [],
    receivedAt,
  }
}

/** Collect the store's log lines so tests can assert what was (and was NOT) said. */
function logCollector(): { lines: string[]; log: (m: string) => void } {
  const lines: string[] = []
  return { lines, log: (m) => lines.push(m) }
}

const DAY = 86_400_000
// Fixed UTC anchors — segment names derive from toISOString, so tests must be TZ-independent.
const D1 = Date.UTC(2026, 5, 1, 12, 0, 0)  // 2026-06-01
const D2 = Date.UTC(2026, 5, 5, 12, 0, 0)  // 2026-06-05
const D3 = Date.UTC(2026, 6, 9, 12, 0, 0)  // 2026-07-09

suite('segmentedSpanStore — daily append-only segments (P4)', () => {
  test('append + flush lands one JSON span per line in the correct UTC daily segment, with an index carrying count + time range', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.append(mkSpan(D1, 1))
      store.append(mkSpan(D1 + 1000, 2))
      store.append(mkSpan(D2, 3))
      assert.strictEqual(store.pendingAppends, 3, 'append only buffers — disk is touched by flush')
      const r = store.flush()
      assert.strictEqual(r.appendedSpans, 3)
      assert.ok(r.appendedBytes > 0)

      const seg1 = fs.readFileSync(path.join(dir, '2026-06-01.ndjson'), 'utf-8')
      const seg2 = fs.readFileSync(path.join(dir, '2026-06-05.ndjson'), 'utf-8')
      assert.strictEqual(seg1.trim().split('\n').length, 2, 'two spans on day 1')
      assert.strictEqual(seg2.trim().split('\n').length, 1, 'one span on day 2')
      assert.ok(seg1.endsWith('\n'), 'newline-terminated so the next append starts a fresh line')
      const first = JSON.parse(seg1.split('\n')[0]) as Span
      assert.strictEqual(first.spanId, 'span-1')

      const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf-8')) as {
        version: number; segments: Record<string, { count: number; minTs: number; maxTs: number; bytes: number }>
      }
      assert.strictEqual(idx.version, 1)
      assert.strictEqual(idx.segments['2026-06-01'].count, 2)
      assert.strictEqual(idx.segments['2026-06-01'].minTs, D1)
      assert.strictEqual(idx.segments['2026-06-01'].maxTs, D1 + 1000)
      assert.strictEqual(idx.segments['2026-06-01'].bytes, Buffer.byteLength(seg1))
      assert.strictEqual(idx.segments['2026-06-05'].count, 1)
    } finally { cleanup() }
  })

  test('P4 acceptance: a >50,000-span ingest survives a simulated restart with ZERO spans lost (no cap, no eviction)', function () {
    this.timeout(30_000)
    const { dir, cleanup } = tmpDir()
    try {
      // 50,050 spans — deliberately past the old MAX_SPANS=50,000 cap that was measured losing
      // 1,700 spans in one restart ("Loaded 50000 spans (capped from 51700)").
      const TOTAL = 50_050
      const store = new SegmentedSpanStore(dir, () => {})
      for (let i = 0; i < TOTAL; i++) {
        store.append(mkSpan(D1 + (i % 3) * DAY + i, i)) // spread across 3 daily segments
        if (i % 10_000 === 0) store.flush()             // interleave flushes like the real 5s tick
      }
      store.flush()

      // Simulated restart: a fresh instance over the same directory (what boot does).
      const reopened = new SegmentedSpanStore(dir, () => {})
      const all = reopened.loadRange(0, Infinity)
      assert.strictEqual(all.length, TOTAL, `every one of the ${TOTAL} spans must survive the restart`)
      const ids = new Set(all.map(s => s.spanId))
      assert.strictEqual(ids.size, TOTAL, 'no duplicates either')
      const st = reopened.stats()
      assert.strictEqual(st.totalSpans, TOTAL)
      assert.strictEqual(st.segments, 3)
    } finally { cleanup() }
  })

  test('P4 acceptance: append never rewrites a segment — prior bytes are untouched and growth equals exactly the appended bytes', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      for (let i = 0; i < 100; i++) store.append(mkSpan(D1 + i, i))
      store.flush()
      const file = path.join(dir, '2026-06-01.ndjson')
      const before = fs.readFileSync(file, 'utf-8')

      for (let i = 100; i < 150; i++) store.append(mkSpan(D1 + i, i))
      const r = store.flush()
      const after = fs.readFileSync(file, 'utf-8')
      assert.ok(after.startsWith(before), 'the previously-written bytes must be byte-identical (append-only, no rewrite)')
      assert.strictEqual(Buffer.byteLength(after) - Buffer.byteLength(before), r.appendedBytes,
        'the file grew by exactly the appended chunk — nothing else was written')
    } finally { cleanup() }
  })

  test('P4 acceptance: retention deletes whole EXPIRED segments only, logging an explicit line per deletion', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const { lines, log } = logCollector()
      const store = new SegmentedSpanStore(dir, log)
      const now = Date.UTC(2026, 6, 10, 12, 0, 0) // 2026-07-10
      store.append(mkSpan(D1, 1)) // 2026-06-01 — age 39d, expired at 30d retention
      store.append(mkSpan(D1 + 1, 2))
      store.append(mkSpan(D1 + 2, 3))
      store.append(mkSpan(now - 10 * DAY, 4)) // 2026-06-30 — inside retention
      store.append(mkSpan(now, 5))            // today
      store.flush()
      const keptFile = path.join(dir, '2026-06-30.ndjson')
      const keptBefore = fs.readFileSync(keptFile)

      const deleted = store.runRetention(30, now)
      assert.strictEqual(deleted.length, 1, 'only the expired segment is deleted')
      assert.deepStrictEqual(deleted[0], { segment: '2026-06-01.ndjson', spans: 3, ageDays: 39 })
      assert.ok(!fs.existsSync(path.join(dir, '2026-06-01.ndjson')), 'expired segment removed')
      assert.ok(fs.readFileSync(keptFile).equals(keptBefore), 'surviving segments are byte-identical')
      assert.ok(fs.existsSync(path.join(dir, `${new Date(now).toISOString().slice(0, 10)}.ndjson`)), 'today survives')
      assert.ok(
        lines.some(l => l.includes('retention: deleted segment 2026-06-01.ndjson, 3 spans, age 39d')),
        `an explicit per-segment deletion line is mandatory — got: ${JSON.stringify(lines)}`,
      )
      assert.strictEqual(store.stats().totalSpans, 2, 'index reflects the deletion')
    } finally { cleanup() }
  })

  test('retention never touches files that are not calendar-valid daily segments', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      // A foreign file, a lookalike with an impossible date, and the index itself.
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
      fs.writeFileSync(path.join(dir, '2026-13-99.ndjson'), 'calendar-invalid — never parse, never delete')
      const deleted = store.runRetention(1, Date.UTC(2030, 0, 1))
      assert.strictEqual(deleted.length, 0)
      assert.ok(fs.existsSync(path.join(dir, 'notes.txt')))
      assert.ok(fs.existsSync(path.join(dir, '2026-13-99.ndjson')))
    } finally { cleanup() }
  })

  test('loadRange reads ONLY the segments overlapping the requested range — out-of-range segments are never even parsed', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const { lines, log } = logCollector()
      const store = new SegmentedSpanStore(dir, log)
      store.append(mkSpan(D1, 1))
      store.append(mkSpan(D2, 2))
      store.append(mkSpan(D2 + 1000, 3))
      store.flush()
      // Poison the out-of-range segment with a line that WOULD log "corrupt" if parsed.
      fs.appendFileSync(path.join(dir, '2026-06-01.ndjson'), 'this is not json\n')

      // Reopen (the index reconciler recounts by newline scan — no JSON parse, no corrupt log).
      const reopened = new SegmentedSpanStore(dir, log)
      const got = reopened.loadRange(D2 - 1000, D2 + DAY)
      assert.deepStrictEqual(got.map(s => s.spanId).sort(), ['span-2', 'span-3'])
      assert.ok(!lines.some(l => l.includes('corrupt')),
        'the poisoned out-of-range segment must never be parsed — proof it was not read')

      // Widening the range DOES read it — and the corrupt line is skipped loudly, not fatally.
      const all = reopened.loadRange(0, Infinity)
      assert.deepStrictEqual(all.map(s => s.spanId).sort(), ['span-1', 'span-2', 'span-3'])
      assert.ok(lines.some(l => l.includes('skipped 1 corrupt line(s) in 2026-06-01.ndjson')))
    } finally { cleanup() }
  })

  test('loadRange filters per-span inside a partially-overlapping segment', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      for (let i = 0; i < 10; i++) store.append(mkSpan(D1 + i * 60_000, i))
      store.flush()
      const got = store.loadRange(D1 + 2 * 60_000, D1 + 5 * 60_000)
      assert.deepStrictEqual(got.map(s => s.spanId), ['span-2', 'span-3', 'span-4', 'span-5'])
    } finally { cleanup() }
  })

  test('a truncated final line (crash mid-append) is skipped without losing the rest of the segment', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.append(mkSpan(D1, 1))
      store.append(mkSpan(D1 + 1, 2))
      store.flush()
      const file = path.join(dir, '2026-06-01.ndjson')
      const whole = fs.readFileSync(file, 'utf-8')
      fs.writeFileSync(file, whole + '{"traceId":"tr", "spanId":"half') // no closing brace, no newline
      const { lines, log } = logCollector()
      const reopened = new SegmentedSpanStore(dir, log)
      const got = reopened.loadRange(0, Infinity)
      assert.deepStrictEqual(got.map(s => s.spanId).sort(), ['span-1', 'span-2'])
      assert.ok(lines.some(l => l.includes('skipped 1 corrupt line(s)')))
    } finally { cleanup() }
  })

  test('index self-heals: a deleted index.json is rebuilt from the segment files; a stale count is recounted from disk', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      for (let i = 0; i < 5; i++) store.append(mkSpan(D1 + i, i))
      store.append(mkSpan(D2, 99))
      store.flush()

      // Case 1: index destroyed entirely.
      fs.unlinkSync(path.join(dir, 'index.json'))
      const rebuilt = new SegmentedSpanStore(dir, () => {})
      assert.strictEqual(rebuilt.stats().totalSpans, 6, 'counts recovered by scanning the segments')
      assert.strictEqual(rebuilt.stats().segments, 2)

      // Case 2: a crash between append and index write — the segment has bytes the index missed.
      const extra = `${JSON.stringify(mkSpan(D1 + 100, 100))}\n`
      fs.appendFileSync(path.join(dir, '2026-06-01.ndjson'), extra)
      const healed = new SegmentedSpanStore(dir, () => {})
      assert.strictEqual(healed.stats().totalSpans, 7, 'byte-size disagreement triggers a recount')
      assert.strictEqual(healed.loadRange(0, Infinity).length, 7)
    } finally { cleanup() }
  })

  test('clear removes all segments + the index but leaves foreign files alone', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.append(mkSpan(D1, 1))
      store.append(mkSpan(D3, 2))
      store.flush()
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
      store.clear()
      assert.deepStrictEqual(fs.readdirSync(dir), ['notes.txt'])
      assert.strictEqual(store.stats().totalSpans, 0)
      assert.strictEqual(store.pendingAppends, 0)
      assert.deepStrictEqual(store.loadRange(0, Infinity), [])
    } finally { cleanup() }
  })

  test('spanTimestampMs prefers receivedAt, falls back to unix-nano and ISO start times', () => {
    assert.strictEqual(spanTimestampMs(mkSpan(D1, 1)), D1)
    const nano: Span = { ...mkSpan(D1, 2), receivedAt: undefined, startTime: String(D2 * 1e6), endTime: '' }
    assert.strictEqual(spanTimestampMs(nano), D2)
    const iso: Span = { ...mkSpan(D1, 3), receivedAt: undefined, startTime: new Date(D3).toISOString(), endTime: '' }
    assert.strictEqual(spanTimestampMs(iso), D3)
  })
})

suite('segmentedSpanStore — one-time migration from the single-file spans.json', () => {
  test('an NDJSON spans.json is split into daily segments; the original is preserved byte-identical as spans.json.bak', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const legacy = path.join(dir, 'spans.json')
      const spans = [mkSpan(D1, 1), mkSpan(D2, 2), mkSpan(D3, 3)]
      const body = `${spans.map(s => JSON.stringify(s)).join('\n')}\nnot-json-corrupt-tail\n`
      fs.writeFileSync(legacy, body)
      const { lines, log } = logCollector()
      const store = new SegmentedSpanStore(path.join(dir, 'spans'), log)

      const r = migrateLegacySpansFile(legacy, store, log)
      assert.ok(r, 'migration must run when the legacy file exists')
      assert.strictEqual(r?.migratedSpans, 3)
      assert.strictEqual(r?.skippedLines, 1, 'the corrupt line is counted, not fatal')
      assert.ok(!fs.existsSync(legacy), 'the legacy file is renamed away — never re-migrated')
      assert.strictEqual(fs.readFileSync(path.join(dir, 'spans.json.bak'), 'utf-8'), body,
        'the original is preserved byte-identical (renamed, NEVER deleted)')
      assert.strictEqual(store.stats().segments, 3)
      assert.deepStrictEqual(store.loadRange(0, Infinity).map(s => s.spanId).sort(), ['span-1', 'span-2', 'span-3'])
      assert.ok(lines.some(l => l.includes('migration: split spans.json into 3 daily segment(s)')),
        'the migration is logged explicitly')

      // Second boot: the legacy file is gone → migration is a no-op returning null.
      assert.strictEqual(migrateLegacySpansFile(legacy, store, log), null)
      assert.strictEqual(store.stats().totalSpans, 3, 'no duplicate ingestion on the next boot')
    } finally { cleanup() }
  })

  test('the ancient whole-JSON-array spans.json format migrates too', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const legacy = path.join(dir, 'spans.json')
      fs.writeFileSync(legacy, JSON.stringify([mkSpan(D1, 1), mkSpan(D1 + 1, 2)]))
      const store = new SegmentedSpanStore(path.join(dir, 'spans'), () => {})
      const r = migrateLegacySpansFile(legacy, store, () => {})
      assert.strictEqual(r?.migratedSpans, 2)
      assert.ok(fs.existsSync(path.join(dir, 'spans.json.bak')))
      assert.strictEqual(store.loadRange(0, Infinity).length, 2)
    } finally { cleanup() }
  })

  test('a pre-existing spans.json.bak is never overwritten — a second migration gets a timestamped suffix', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const legacy = path.join(dir, 'spans.json')
      fs.writeFileSync(`${legacy}.bak`, 'earlier backup — must survive')
      fs.writeFileSync(legacy, `${JSON.stringify(mkSpan(D1, 1))}\n`)
      const store = new SegmentedSpanStore(path.join(dir, 'spans'), () => {})
      const r = migrateLegacySpansFile(legacy, store, () => {})
      assert.ok(r, 'migration must run')
      assert.strictEqual(r.migratedSpans, 1)
      assert.strictEqual(fs.readFileSync(`${legacy}.bak`, 'utf-8'), 'earlier backup — must survive')
      assert.ok(r.bakPath.startsWith(`${legacy}.bak-`), 'the new backup takes a timestamped name')
      assert.ok(fs.existsSync(r.bakPath))
    } finally { cleanup() }
  })

  test('no legacy file → migration returns null and creates nothing', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(path.join(dir, 'spans'), () => {})
      assert.strictEqual(migrateLegacySpansFile(path.join(dir, 'spans.json'), store, () => {}), null)
      assert.strictEqual(store.stats().totalSpans, 0)
    } finally { cleanup() }
  })
})

// ── S3-F3b: read-time attribute overlay (injectSpanAttribute) ────────────────────────────────
// gen_ai response content arrives as a SEPARATE log event, before OR after its LLM span, and must
// merge into the span WITHOUT rewriting the persisted NDJSON. Because the merge happens on read
// (loadRange), arrival order is irrelevant — the four cases the parent TRDD-DYG4ZTXW named:
// (a) attr recorded AFTER the span, (b) BEFORE the span, (c) cap eviction, (d) span never arrives.
function attrOf(span: Span, key: string): string | undefined {
  return span.attributes.find((a) => a.key === key)?.value.stringValue
}

suite('segmentedSpanStore — read-time attribute overlay (S3-F3b)', () => {
  test('(a) attribute recorded AFTER the span is stored is merged on the next read', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.append(mkSpan(D1, 1))
      store.flush() // span is on disk before the overlay is recorded
      assert.strictEqual(store.injectSpanAttribute('trace-1', 'span-1', 'gen_ai.output.messages', 'HELLO'), true)
      const got = store.loadRange(0, Infinity)
      assert.strictEqual(got.length, 1)
      assert.strictEqual(attrOf(got[0], 'gen_ai.output.messages'), 'HELLO', 'flushed disk span picks up the overlay on read')
    } finally { cleanup() }
  })

  test('(b) attribute recorded BEFORE the span arrives is merged once the span is stored', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.injectSpanAttribute('trace-2', 'span-2', 'gen_ai.output.messages', 'EARLY') // no span yet
      assert.strictEqual(store.loadRange(0, Infinity).length, 0, 'no phantom span is materialized from an overlay alone')
      store.append(mkSpan(D1, 2))
      store.flush()
      const got = store.loadRange(0, Infinity)
      assert.strictEqual(got.length, 1)
      assert.strictEqual(attrOf(got[0], 'gen_ai.output.messages'), 'EARLY', 'the later-arriving span picks up the earlier overlay')
    } finally { cleanup() }
  })

  test('overlay upserts: re-recording a key overwrites, a pre-existing same-key attribute is replaced, other keys are preserved', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      const span = mkSpan(D1, 3)
      span.attributes.push({ key: 'gen_ai.output.messages', value: { stringValue: 'ORIGINAL' } })
      span.attributes.push({ key: 'model', value: { stringValue: 'gpt-x' } })
      store.append(span)
      store.flush()
      store.injectSpanAttribute('trace-3', 'span-3', 'gen_ai.output.messages', 'FIRST')
      store.injectSpanAttribute('trace-3', 'span-3', 'gen_ai.output.messages', 'SECOND') // overwrite
      const got = store.loadRange(0, Infinity)[0]
      assert.strictEqual(attrOf(got, 'gen_ai.output.messages'), 'SECOND', 'existing attr replaced by the latest overlay value')
      assert.strictEqual(attrOf(got, 'model'), 'gpt-x', 'unrelated attributes are untouched')
      assert.strictEqual(got.attributes.filter((a) => a.key === 'gen_ai.output.messages').length, 1, 'no duplicate key is appended')
    } finally { cleanup() }
  })

  test('(c) overlay is cap-evicted oldest-first past OVERLAY_MAX (500) so a never-arriving span cannot leak memory', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      // 501 overlay entries → the very first (trace-0:span-0) is evicted; the last survives.
      for (let i = 0; i <= 500; i++) {
        store.injectSpanAttribute(`trace-${i}`, `span-${i}`, 'gen_ai.output.messages', `v${i}`)
      }
      store.append(mkSpan(D1, 0))   // the evicted key's span
      store.append(mkSpan(D1, 500)) // the surviving key's span
      store.flush()
      const byId = new Map(store.loadRange(0, Infinity).map((s) => [s.spanId, s]))
      assert.strictEqual(attrOf(byId.get('span-0')!, 'gen_ai.output.messages'), undefined, 'oldest overlay entry was evicted')
      assert.strictEqual(attrOf(byId.get('span-500')!, 'gen_ai.output.messages'), 'v500', 'newest overlay entry survives')
    } finally { cleanup() }
  })

  test('(d) an overlay whose span never arrives materializes nothing and never throws', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.injectSpanAttribute('ghost-trace', 'ghost-span', 'gen_ai.output.messages', 'ORPHAN')
      assert.deepStrictEqual(store.loadRange(0, Infinity), [], 'no span, no phantom, no crash')
    } finally { cleanup() }
  })

  test('clear() drops the overlay so a re-used key on a fresh span is not stale-merged', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const store = new SegmentedSpanStore(dir, () => {})
      store.injectSpanAttribute('trace-1', 'span-1', 'gen_ai.output.messages', 'STALE')
      store.clear()
      store.append(mkSpan(D1, 1))
      store.flush()
      assert.strictEqual(attrOf(store.loadRange(0, Infinity)[0], 'gen_ai.output.messages'), undefined, 'overlay cleared with the store')
    } finally { cleanup() }
  })
})
