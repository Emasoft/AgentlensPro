import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { BodiesActivityTracker, extractResponseUsage } from '../bodiesActivity'

// ── BodiesActivityTracker (TRDD-GOD0108C) — real-filesystem tests ────────────
// Synthetic bodies dir; mtimes controlled with utimesSync, exactly like production
// files written by the OTEL collector (write-once, never rewritten).

let seq = 0
function tmpBodies(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-bodies-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

function responseFile(dir: string, ts: number, usage: { cc: number; cr: number }, model = 'claude-fable-5'): string {
  const name = `r${seq}-${Math.random().toString(36).slice(2)}.response.json`
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    id: `msg_${Math.random().toString(36).slice(2)}`,
    model,
    usage: { input_tokens: 10, cache_creation_input_tokens: usage.cc, cache_read_input_tokens: usage.cr, output_tokens: 50 },
  }))
  fs.utimesSync(path.join(dir, name), ts / 1000, ts / 1000)
  return name
}

function requestFile(dir: string, ts: number, bytes: number): void {
  const name = `q${seq}-${Math.random().toString(36).slice(2)}.request.json`
  // Pad to AT LEAST `bytes` (JSON wrapper adds ~10) so size assertions never sit 2 bytes short.
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ pad: 'z'.repeat(bytes) }))
  fs.utimesSync(path.join(dir, name), ts / 1000, ts / 1000)
}

const NOW = Date.now()

suite('bodiesActivity — CACHE_THRASH + incremental scan (TRDD-GOD0108C)', () => {
  test('quiet dir: available, no thrash, no huge requests', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.available, true)
      assert.strictEqual(r.thrash.active, false)
      assert.strictEqual(r.hugeRequests90s.count, 0)
    } finally { cleanup() }
  })

  test('thrash trips at 3 big-write/low-read responses in 5min, not at 2', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      responseFile(dir, NOW - 60_000, { cc: 300_000, cr: 1_000 })
      responseFile(dir, NOW - 120_000, { cc: 250_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      assert.strictEqual(t.report(NOW).thrash.active, false, '2 misses must not trip')
      responseFile(dir, NOW - 30_000, { cc: 400_000, cr: 20_000 })
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, true, '3 misses must trip')
      assert.strictEqual(r.thrash.count, 3)
      assert.strictEqual(r.thrash.rebilledTokens, 950_000)
      assert.strictEqual(r.thrash.model, 'claude-fable-5')
    } finally { cleanup() }
  })

  test('healthy cache traffic (big cache_read) never counts as thrash', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 5; i++) responseFile(dir, NOW - i * 20_000, { cc: 150_000, cr: 900_000 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, false, 'reads dominate — the cache is WORKING')
      assert.strictEqual(r.thrash.count, 0)
    } finally { cleanup() }
  })

  test('thrash responses older than the window do not count', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 4; i++) responseFile(dir, NOW - 8 * 60_000 - i * 1000, { cc: 300_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      assert.strictEqual(t.report(NOW).thrash.active, false)
    } finally { cleanup() }
  })

  test('incremental: a file landing after the first poll is picked up by the next', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      responseFile(dir, NOW - 90_000, { cc: 300_000, cr: 0 })
      responseFile(dir, NOW - 80_000, { cc: 300_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW - 60_000)
      assert.strictEqual(t.report(NOW).thrash.active, false)
      responseFile(dir, NOW - 10_000, { cc: 300_000, cr: 0 })
      t.poll(NOW)
      assert.strictEqual(t.report(NOW).thrash.active, true, 'the new file completes the pattern')
    } finally { cleanup() }
  })

  test('huge requests feed the 90s burst counter; small/old ones do not', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      requestFile(dir, NOW - 10_000, 2_000_000)
      requestFile(dir, NOW - 20_000, 2_000_000)
      requestFile(dir, NOW - 30_000, 500_000)      // small — ignored
      requestFile(dir, NOW - 5 * 60_000, 2_000_000) // old — outside 90s
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.hugeRequests90s.count, 2)
      assert.ok(r.hugeRequests90s.bytes >= 4_000_000)
    } finally { cleanup() }
  })

  test('premium share + last model come from the recent response ring', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      responseFile(dir, NOW - 40_000, { cc: 100, cr: 90_000 }, 'claude-fable-5')
      responseFile(dir, NOW - 30_000, { cc: 100, cr: 90_000 }, 'claude-fable-5')
      responseFile(dir, NOW - 20_000, { cc: 100, cr: 90_000 }, 'claude-haiku-4-5')
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.premium.sampled, 3)
      assert.ok(Math.abs(r.premium.share - 2 / 3) < 1e-9)
      assert.strictEqual(r.premium.lastModel, 'claude-haiku-4-5', 'newest by mtime, not readdir order')
    } finally { cleanup() }
  })

  test('oversized, truncated, and foreign files are skipped without breaking the poll', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      // Truncated mid-write (not yet valid JSON) — the archiver/writer race.
      const bad = path.join(dir, 'trunc.response.json')
      fs.writeFileSync(bad, '{"usage": {"cache_creation_input_tokens": 3')
      fs.utimesSync(bad, (NOW - 5000) / 1000, (NOW - 5000) / 1000)
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a body')
      responseFile(dir, NOW - 10_000, { cc: 300_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.available, true)
      assert.strictEqual(r.thrash.count, 1, 'only the valid response counted')
    } finally { cleanup() }
  })

  test('missing dir: poll is a no-op and the report says available:false', () => {
    const t = new BodiesActivityTracker('/nonexistent/agentlens-bodies')
    t.poll(NOW)
    const r = t.report(NOW)
    assert.strictEqual(r.available, false)
    assert.strictEqual(r.thrash.active, false)
  })

  test('extractResponseUsage tolerates nested shapes and rejects usage-less JSON', () => {
    assert.deepStrictEqual(
      extractResponseUsage({ model: 'm', usage: { cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } }),
      { model: 'm', cc: 5, cr: 7 })
    assert.deepStrictEqual(
      extractResponseUsage({ response: { model: 'm2', usage: { cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } }),
      { model: 'm2', cc: 1, cr: 2 })
    assert.strictEqual(extractResponseUsage({ nope: true }), null)
    assert.strictEqual(extractResponseUsage('str'), null)
    assert.strictEqual(extractResponseUsage(null), null)
  })
})
