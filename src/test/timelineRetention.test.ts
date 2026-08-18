import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'
import {
  pushBounded, capTimeline, capText, attachFullResult, stripTimeline, entryCost,
  timelineMaxEntries, timelineMaxBytes,
  DEFAULT_TIMELINE_MAX_ENTRIES, DEFAULT_TIMELINE_MAX_BYTES, FIELD_MAX_CHARS,
  TIMELINE_MAX_ENTRIES_ENV, TIMELINE_MAX_BYTES_ENV, type TimelineHolder,
} from '../timelineRetention'
import type { TimelineEntry } from '../shared/summarizerTypes'

// ── Bounded in-memory timeline retention (TRDD-66IXMIGN, fix for TRDD-MFSUMOJ9) ──
// The parent card's heap autopsy: the server OOMs on retained ENTRY COUNT (2.83M strings at
// death), so the cap pins the count. These tests pin the eviction mechanics AND that a real
// parse of an over-cap transcript retains a bounded timeline while aggregates stay correct.

const entry = (i: number): TimelineEntry =>
  ({ type: 'user_input', spanId: `e-${i}`, label: 'User', durationMs: 0, isError: false, timestamp: '' })

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

suite('timelineRetention — bounded in-memory timelines (TRDD-66IXMIGN)', () => {
  test('pushBounded evicts oldest-first with amortized slack and counts evictions', () => {
    // Amortized policy: overflow is allowed up to max + max/4, then ONE splice trims to max.
    const holder: TimelineHolder = { timeline: [] }
    const max = 100 // slack 25
    for (let i = 0; i < 130; i++) pushBounded(holder, entry(i), max)
    // 126th push crossed max+slack → spliced down to max; 4 more pushes since.
    assert.strictEqual(holder.timeline.length, 104)
    assert.strictEqual(holder.timelineTruncatedCount, 26)
    // Oldest evicted, tail intact and ordered.
    assert.strictEqual(holder.timeline[0].spanId, 'e-26')
    assert.strictEqual(holder.timeline[holder.timeline.length - 1].spanId, 'e-129')
  })

  test('pushBounded never evicts under the cap', () => {
    const holder: TimelineHolder = { timeline: [] }
    for (let i = 0; i < 100; i++) pushBounded(holder, entry(i), 100)
    assert.strictEqual(holder.timeline.length, 100)
    assert.strictEqual(holder.timelineTruncatedCount, undefined)
  })

  test('capTimeline trims to exactly max keeping the newest tail', () => {
    const tl = Array.from({ length: 250 }, (_, i) => entry(i))
    const evicted = capTimeline(tl, 100)
    assert.strictEqual(evicted, 150)
    assert.strictEqual(tl.length, 100)
    assert.strictEqual(tl[0].spanId, 'e-150')
    assert.strictEqual(tl[99].spanId, 'e-249')
    assert.strictEqual(capTimeline(tl, 100), 0)
  })

  test('byte budget evicts oldest entries even under the count cap', () => {
    const holder: TimelineHolder = { timeline: [] }
    const big = 'x'.repeat(1000)
    // 10 entries × ~1KB against a 4KB budget, count cap far away.
    for (let i = 0; i < 10; i++) {
      pushBounded(holder, { ...entry(i), responseText: big }, 100, 4096)
    }
    assert.ok(holder.timeline.length < 10, `byte budget should have evicted, len=${holder.timeline.length}`)
    assert.ok((holder.timelineRetainedBytes ?? 0) <= 4096)
    // Newest survives.
    assert.strictEqual(holder.timeline[holder.timeline.length - 1].spanId, 'e-9')
    // Accounting matches reality.
    const real = holder.timeline.reduce((n, e) => n + entryCost(e), 0)
    assert.strictEqual(holder.timelineRetainedBytes, real)
  })

  test('capText truncates with a marker; attachFullResult caps and keeps accounting true', () => {
    assert.strictEqual(capText('short'), 'short')
    const capped = capText('y'.repeat(FIELD_MAX_CHARS + 500))
    assert.ok(capped.length < FIELD_MAX_CHARS + 100)
    assert.ok(capped.includes('[retention: 500 chars truncated]'))

    const holder: TimelineHolder = { timeline: [] }
    const e = entry(0)
    pushBounded(holder, e, 100, DEFAULT_TIMELINE_MAX_BYTES)
    attachFullResult(holder, e, 'z'.repeat(FIELD_MAX_CHARS * 2))
    assert.ok((e.fullResult ?? '').length <= FIELD_MAX_CHARS + 100)
    const real = holder.timeline.reduce((n, x) => n + entryCost(x), 0)
    assert.strictEqual(holder.timelineRetainedBytes, real)
  })

  test('stripTimeline drops the retained view and keeps the truncation counter honest', () => {
    const holder: TimelineHolder = { timeline: Array.from({ length: 7 }, (_, i) => entry(i)), timelineTruncatedCount: 3 }
    stripTimeline(holder)
    assert.strictEqual(holder.timeline.length, 0)
    assert.strictEqual(holder.timelineTruncatedCount, 10)
    assert.strictEqual(holder.timelineRetainedBytes, 0)
    stripTimeline(holder) // idempotent on empty
    assert.strictEqual(holder.timelineTruncatedCount, 10)
  })

  test('capTimeline byte bound keeps the newest tail within budget', () => {
    const big = 'x'.repeat(1000)
    const tl = Array.from({ length: 20 }, (_, i) => ({ ...entry(i), responseText: big }))
    const evicted = capTimeline(tl, 100, 5000)
    assert.ok(evicted >= 15, `expected most evicted, got ${evicted}`)
    assert.strictEqual(tl[tl.length - 1].spanId, 'e-19')
    assert.ok(tl.reduce((n, e) => n + entryCost(e), 0) <= 5000)
    // A single over-budget entry is still kept (never trim to zero).
    const one = [{ ...entry(0), responseText: 'q'.repeat(9000) }]
    assert.strictEqual(capTimeline(one, 100, 5000), 0)
    assert.strictEqual(one.length, 1)
  })

  test('timelineMaxBytes: default, explicit, floor, malformed throws', () => {
    assert.strictEqual(timelineMaxBytes({}), DEFAULT_TIMELINE_MAX_BYTES)
    assert.strictEqual(timelineMaxBytes({ [TIMELINE_MAX_BYTES_ENV]: '10000000' }), 10_000_000)
    assert.strictEqual(timelineMaxBytes({ [TIMELINE_MAX_BYTES_ENV]: '10' }), 64 * 1024)
    assert.throws(() => timelineMaxBytes({ [TIMELINE_MAX_BYTES_ENV]: 'big' }))
  })

  test('timelineMaxEntries: default, explicit value, floor clamp, malformed throws', () => {
    assert.strictEqual(timelineMaxEntries({}), DEFAULT_TIMELINE_MAX_ENTRIES)
    assert.strictEqual(timelineMaxEntries({ [TIMELINE_MAX_ENTRIES_ENV]: '5000' }), 5000)
    // Below the usability floor → clamped up, not honored.
    assert.strictEqual(timelineMaxEntries({ [TIMELINE_MAX_ENTRIES_ENV]: '3' }), 50)
    // Fail-fast: a present-but-garbage knob must crash, not silently run unbounded.
    assert.throws(() => timelineMaxEntries({ [TIMELINE_MAX_ENTRIES_ENV]: 'lots' }))
    assert.throws(() => timelineMaxEntries({ [TIMELINE_MAX_ENTRIES_ENV]: '-1' }))
  })

  test('a parsed over-cap Claude transcript retains a bounded timeline; aggregates unaffected', () => {
    // Env-isolated fixture, same pattern as logReader.generatedFiles.test.ts.
    const cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), `al-tlr-cfg-${process.pid}-`))
    const projDir = path.join(cfgRoot, 'projects', 'proj')
    fs.mkdirSync(projDir, { recursive: true })
    const jsonlPath = path.join(projDir, `tlr-${process.pid}.jsonl`)
    const savedEnv = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = cfgRoot
    try {
      // 2600 user rows against the DEFAULT cap 2000 (slack 500): the 2501st push splices 501 off,
      // then 99 more append → deterministic final shape.
      const total = 2600
      const cwd = path.join(cfgRoot, 'workspace')
      const rows: string[] = []
      for (let i = 0; i < total; i++) {
        rows.push(JSON.stringify({
          type: 'user',
          timestamp: `2026-07-07T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
          cwd, message: { content: `message number ${i}` },
        }))
      }
      fs.writeFileSync(jsonlPath, rows.join('\n') + '\n')

      const results = scanClaude(new LogReader())
      assert.strictEqual(results.length, 1)
      const card = results[0].card
      assert.strictEqual(card.timeline.length, 2099)
      assert.strictEqual(card.timelineTruncatedCount, 501)
      // Oldest evicted, newest retained.
      assert.strictEqual(card.timeline[0].spanId, 'log-u-501')
      assert.strictEqual(card.timeline[card.timeline.length - 1].spanId, `log-u-${total - 1}`)
      assert.strictEqual(card.timeline[card.timeline.length - 1].responseText, `message number ${total - 1}`)
      // Aggregates come from the accumulator, not the retained timeline — eviction must not touch them.
      assert.strictEqual(card.userRequest, 'message number 0')
      assert.ok(card.startTime.startsWith('2026-07-07T10:00:00'), `startTime kept the evicted first entry's ts: ${card.startTime}`)
    } finally {
      if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedEnv
      fs.rmSync(cfgRoot, { recursive: true, force: true })
    }
  })
})
