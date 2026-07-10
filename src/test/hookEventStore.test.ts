import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  appendHookEvent, readHookEvents, purgeHookEventBuckets, hookEventsDiskUsage,
  type HookEventRecord,
} from '../hookEventStore'

// ── Lifecycle hook-event store (TRDD-Q6ZOUVK5) — real-filesystem tests ───────
// Every test drives the real append/read/purge functions against a real tmpdir: the store IS a
// filesystem contract (append-only NDJSON daily buckets), so a mocked fs would test nothing.

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-hev-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Day-bucket filename for a ts, mirroring the store's own UTC-date naming. */
function bucketName(ts: number): string {
  return `${new Date(ts).toISOString().slice(0, 10)}.ndjsonl`
}

/** Seed a bucket with records carrying controlled timestamps (append uses Date.now()). */
function seedBucket(dir: string, ts: number, recs: Partial<HookEventRecord>[]): void {
  fs.mkdirSync(dir, { recursive: true })
  const lines = recs.map(r => JSON.stringify({ ts, ev: 'Stop', payload: {}, ...r })).join('\n')
  fs.writeFileSync(path.join(dir, bucketName(ts)), `${lines}\n`)
}

const DAY = 86_400_000

suite('hookEventStore — append + read + retention (TRDD-Q6ZOUVK5)', () => {
  test('appendHookEvent writes one NDJSON line into today\'s bucket and returns its byte length', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const bytes = appendHookEvent(dir, { hook_event_name: 'StopFailure', session_id: 's1', reason: 'rate_limit' })
      const file = path.join(dir, bucketName(Date.now()))
      const raw = fs.readFileSync(file, 'utf-8')
      assert.strictEqual(bytes, Buffer.byteLength(raw), 'returned bytes must equal what landed on disk')
      assert.ok(raw.endsWith('\n'), 'every record is newline-terminated so the next append starts a fresh line')
      const rec = JSON.parse(raw.trim()) as HookEventRecord
      assert.strictEqual(rec.ev, 'StopFailure')
      assert.strictEqual(rec.session, 's1')
      assert.deepStrictEqual(rec.payload.reason, 'rate_limit', 'raw payload is stored verbatim')
    } finally { cleanup() }
  })

  test('appendHookEvent appends (never rewrites) — the 420GB-incident invariant', () => {
    const { dir, cleanup } = tmpDir()
    try {
      appendHookEvent(dir, { hook_event_name: 'SessionStart', session_id: 's1' })
      appendHookEvent(dir, { hook_event_name: 'Stop', session_id: 's1' })
      appendHookEvent(dir, { hook_event_name: 'SessionEnd', session_id: 's1' })
      const raw = fs.readFileSync(path.join(dir, bucketName(Date.now())), 'utf-8')
      assert.strictEqual(raw.trim().split('\n').length, 3, 'three appends produce three lines, none rewritten')
    } finally { cleanup() }
  })

  test('appendHookEvent leaves session undefined when the payload carries no session_id', () => {
    const { dir, cleanup } = tmpDir()
    try {
      appendHookEvent(dir, { hook_event_name: 'Notification' })
      const rec = JSON.parse(readHookEvents(dir).length ? fs.readFileSync(path.join(dir, bucketName(Date.now())), 'utf-8').trim() : '{}') as HookEventRecord
      assert.strictEqual(rec.session, undefined)
      assert.strictEqual(rec.ev, 'Notification')
    } finally { cleanup() }
  })

  test('readHookEvents returns [] when the store directory does not exist yet', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.deepStrictEqual(readHookEvents(path.join(dir, 'never-created')), [])
    } finally { cleanup() }
  })

  test('readHookEvents returns newest-first across buckets and honours limit', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now - DAY, [{ ev: 'Stop', ts: now - DAY }])
      seedBucket(dir, now, [{ ev: 'SessionStart', ts: now - 2000 }, { ev: 'Stop', ts: now - 1000 }])
      const all = readHookEvents(dir)
      assert.deepStrictEqual(all.map(r => r.ts), [now - 1000, now - 2000, now - DAY], 'newest first, across buckets')
      assert.strictEqual(readHookEvents(dir, { limit: 2 }).length, 2, 'limit truncates the newest-first stream')
    } finally { cleanup() }
  })

  test('readHookEvents clamps limit into [1, 1000] so a caller cannot ask for an unbounded scan', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now, [{ ts: now }, { ts: now - 1 }, { ts: now - 2 }])
      assert.strictEqual(readHookEvents(dir, { limit: 0 }).length, 1, 'limit 0 clamps up to 1')
      assert.strictEqual(readHookEvents(dir, { limit: -5 }).length, 1, 'negative limit clamps up to 1')
      assert.strictEqual(readHookEvents(dir, { limit: 99_999 }).length, 3, 'huge limit clamps down, returns all available')
    } finally { cleanup() }
  })

  test('readHookEvents filters by session and by event name', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now, [
        { ts: now - 3, ev: 'Stop', session: 'a' },
        { ts: now - 2, ev: 'StopFailure', session: 'a' },
        { ts: now - 1, ev: 'Stop', session: 'b' },
      ])
      assert.deepStrictEqual(readHookEvents(dir, { session: 'a' }).map(r => r.ev), ['StopFailure', 'Stop'])
      assert.deepStrictEqual(readHookEvents(dir, { ev: 'Stop' }).map(r => r.session), ['b', 'a'])
      assert.deepStrictEqual(readHookEvents(dir, { session: 'b', ev: 'StopFailure' }), [], 'both filters must match')
    } finally { cleanup() }
  })

  test('readHookEvents applies the since/until window to record timestamps', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now, [{ ts: now - 5000 }, { ts: now - 3000 }, { ts: now - 1000 }])
      assert.deepStrictEqual(readHookEvents(dir, { sinceMs: now - 3500 }).map(r => r.ts), [now - 1000, now - 3000])
      assert.deepStrictEqual(readHookEvents(dir, { untilMs: now - 2000 }).map(r => r.ts), [now - 3000, now - 5000])
      assert.deepStrictEqual(readHookEvents(dir, { sinceMs: now - 3500, untilMs: now - 2000 }).map(r => r.ts), [now - 3000])
    } finally { cleanup() }
  })

  test('readHookEvents skips whole buckets outside the window (the day-bound fast path)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      const old = now - 5 * DAY
      seedBucket(dir, old, [{ ts: old }])
      seedBucket(dir, now, [{ ts: now }])
      // A window entirely after the old bucket's day must not surface its record.
      assert.deepStrictEqual(readHookEvents(dir, { sinceMs: now - DAY }).map(r => r.ts), [now])
      // ...and the same record IS reachable when the window covers its day.
      assert.strictEqual(readHookEvents(dir, { sinceMs: old - DAY, untilMs: old + 1 }).length, 1)
    } finally { cleanup() }
  })

  test('readHookEvents skips a corrupt tail line instead of throwing (crash-truncated append)', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now, [{ ts: now - 1 }])
      fs.appendFileSync(path.join(dir, bucketName(now)), '{"ts":123,"ev":"Stop"')  // torn write, no newline
      const got = readHookEvents(dir)
      assert.strictEqual(got.length, 1, 'the intact record still reads back')
      assert.strictEqual(got[0].ts, now - 1)
    } finally { cleanup() }
  })

  test('readHookEvents ignores files that are not day buckets', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      seedBucket(dir, now, [{ ts: now }])
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a bucket')
      // Shape-valid but calendar-invalid names: both match /\d{4}-\d{2}-\d{2}/, both must be ignored.
      fs.writeFileSync(path.join(dir, '2026-13-99.ndjsonl'), '{"ts":1,"ev":"X","payload":{}}\n')  // parses to NaN
      fs.writeFileSync(path.join(dir, '2026-02-31.ndjsonl'), '{"ts":2,"ev":"X","payload":{}}\n')  // Date.parse overflows to Mar 3
      assert.strictEqual(readHookEvents(dir).length, 1)
    } finally { cleanup() }
  })

  test('calendar-invalid bucket names are never counted, scanned, or purged', () => {
    const { dir, cleanup } = tmpDir()
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '2026-13-99.ndjsonl'), '{"ts":1,"ev":"X","payload":{}}\n')
      fs.writeFileSync(path.join(dir, '2026-02-31.ndjsonl'), '{"ts":2,"ev":"X","payload":{}}\n')
      assert.deepStrictEqual(hookEventsDiskUsage(dir), { files: 0, bytes: 0 }, 'not ours — not counted')
      // Purge with retention 0 would delete every real bucket; these must survive untouched, since
      // a string-compare purge would have skipped them forever while disk-usage kept counting them.
      assert.deepStrictEqual(purgeHookEventBuckets(dir, 0).removed, [])
      assert.strictEqual(fs.readdirSync(dir).length, 2, 'foreign files left alone')
    } finally { cleanup() }
  })

  test('purgeHookEventBuckets deletes only buckets older than the retention window', () => {
    const { dir, cleanup } = tmpDir()
    try {
      const now = Date.now()
      const stale = now - 40 * DAY
      const fresh = now - 2 * DAY
      seedBucket(dir, stale, [{ ts: stale }])
      seedBucket(dir, fresh, [{ ts: fresh }])
      seedBucket(dir, now, [{ ts: now }])
      const staleBytes = fs.statSync(path.join(dir, bucketName(stale))).size

      const r = purgeHookEventBuckets(dir, 31)
      assert.deepStrictEqual(r.removed, [bucketName(stale)], 'only the >31d bucket is removed')
      assert.strictEqual(r.freedBytes, staleBytes, 'freed bytes equal the removed bucket size')
      assert.ok(fs.existsSync(path.join(dir, bucketName(fresh))), 'in-window bucket survives')
      assert.ok(fs.existsSync(path.join(dir, bucketName(now))), 'today\'s bucket survives')
    } finally { cleanup() }
  })

  test('purgeHookEventBuckets is a no-op on a missing dir and never touches foreign files', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.deepStrictEqual(purgeHookEventBuckets(path.join(dir, 'nope'), 31), { removed: [], freedBytes: 0 })
      fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x')
      purgeHookEventBuckets(dir, 0)
      assert.ok(fs.existsSync(path.join(dir, 'keep-me.txt')), 'a non-bucket file is never deleted')
    } finally { cleanup() }
  })

  test('hookEventsDiskUsage counts only day buckets, and reports zero for a missing dir', () => {
    const { dir, cleanup } = tmpDir()
    try {
      assert.deepStrictEqual(hookEventsDiskUsage(path.join(dir, 'nope')), { files: 0, bytes: 0 })
      const now = Date.now()
      seedBucket(dir, now, [{ ts: now }])
      seedBucket(dir, now - DAY, [{ ts: now - DAY }])
      fs.writeFileSync(path.join(dir, 'stray.json'), '{}')
      const expected = fs.statSync(path.join(dir, bucketName(now))).size
        + fs.statSync(path.join(dir, bucketName(now - DAY))).size
      assert.deepStrictEqual(hookEventsDiskUsage(dir), { files: 2, bytes: expected })
    } finally { cleanup() }
  })
})
