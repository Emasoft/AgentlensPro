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

function responseFile(dir: string, ts: number, usage: { cc: number; cr: number }, model = 'claude-fable-5', id?: string): string {
  const name = `r${seq}-${Math.random().toString(36).slice(2)}.response.json`
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    id: id ?? `msg_${Math.random().toString(36).slice(2)}`,
    model,
    usage: { input_tokens: 10, cache_creation_input_tokens: usage.cc, cache_read_input_tokens: usage.cr, output_tokens: 50 },
  }))
  fs.utimesSync(path.join(dir, name), ts / 1000, ts / 1000)
  return name
}

function requestFile(dir: string, ts: number, bytes: number, attrib?: { session?: string; model?: string; previousMessageId?: string }): void {
  const name = `q${seq}-${Math.random().toString(36).slice(2)}.request.json`
  // Mirrors the real body layout: "model" in the first 2KB, metadata.user_id (an ESCAPED
  // JSON string carrying session_id) and diagnostics.previous_message_id (plain JSON — the
  // chain link that attributes the previous response to this session) at the very tail —
  // bounded reads must find all three.
  const head = attrib?.model ? `{"model":"${attrib.model}","pad":"` : '{"pad":"'
  const diag = attrib?.previousMessageId ? `,"diagnostics":{"previous_message_id":"${attrib.previousMessageId}"}` : ''
  const tail = attrib?.session
    ? `","metadata":{"user_id":"{\\"device_id\\":\\"d1\\",\\"session_id\\":\\"${attrib.session}\\"}"}${diag}}`
    : '"}'
  // Pad to AT LEAST `bytes` (the JSON wrapper adds a little) so size assertions never sit short.
  fs.writeFileSync(path.join(dir, name), head + 'z'.repeat(bytes) + tail)
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
      // Attributed to ONE session via the request chain: since TRDD-THRGX41P only an ATTRIBUTED
      // repeat-writer can flip `active`, so the threshold test must ride attribution.
      responseFile(dir, NOW - 60_000, { cc: 300_000, cr: 1_000 }, 'claude-fable-5', 'msg_th0')
      requestFile(dir, NOW - 58_000, 500_000, { session: S1, model: 'claude-fable-5', previousMessageId: 'msg_th0' })
      responseFile(dir, NOW - 120_000, { cc: 250_000, cr: 0 }, 'claude-fable-5', 'msg_th1')
      requestFile(dir, NOW - 118_000, 500_000, { session: S1, model: 'claude-fable-5', previousMessageId: 'msg_th1' })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      assert.strictEqual(t.report(NOW).thrash.active, false, '2 misses must not trip')
      responseFile(dir, NOW - 30_000, { cc: 400_000, cr: 20_000 }, 'claude-fable-5', 'msg_th2')
      requestFile(dir, NOW - 28_000, 500_000, { session: S1, model: 'claude-fable-5', previousMessageId: 'msg_th2' })
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
      // Unattributed misses count via `unattributed` since TRDD-THRGX41P (they no longer flip
      // `active`) — the incremental-pickup intent of this test is unchanged: 2 before, 3 after.
      assert.strictEqual(t.report(NOW).thrash.unattributed.count, 2)
      responseFile(dir, NOW - 10_000, { cc: 300_000, cr: 0 })
      t.poll(NOW)
      assert.strictEqual(t.report(NOW).thrash.unattributed.count, 3, 'the new file completes the pattern')
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

  test('fat requests (≥400KB) get sender attribution; thrash suspects name session + model', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      requestFile(dir, NOW - 40_000, 600_000, { session: '249c4216-4db4-4b64-9a10-b994b9aa0001', model: 'claude-fable-5' })
      requestFile(dir, NOW - 30_000, 600_000, { session: '249c4216-4db4-4b64-9a10-b994b9aa0001', model: 'claude-fable-5' })
      requestFile(dir, NOW - 20_000, 500_000) // unattributed fat request
      for (let i = 0; i < 3; i++) responseFile(dir, NOW - i * 15_000 - 5_000, { cc: 300_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      // The misses carry no request chain, so since TRDD-THRGX41P they cannot flip `active` —
      // sender attribution and suspect naming, this test's actual subject, are unchanged.
      assert.strictEqual(r.thrash.active, false, 'unattributed misses alone do not activate')
      assert.strictEqual(r.thrash.unattributed.count, 3)
      assert.strictEqual(r.thrash.suspects[0].session, '249c4216-4db4-4b64-9a10-b994b9aa0001')
      assert.strictEqual(r.thrash.suspects[0].model, 'claude-fable-5')
      assert.strictEqual(r.thrash.suspects[0].count, 2)
      assert.strictEqual(r.thrash.suspects[1].session, null, 'unattributed sender grouped, never dropped')
      assert.strictEqual(r.hugeRequests90s.count, 0, '600KB is fat, not huge — burst threshold unchanged')
    } finally { cleanup() }
  })

  test('huge-request senders are named in hugeRequests90s.senders', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 3; i++) {
        requestFile(dir, NOW - 10_000 - i * 10_000, 2_000_000, { session: '777b8f52-aaaa-bbbb-cccc-000000000001', model: 'claude-fable-5' })
      }
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.hugeRequests90s.count, 3)
      assert.strictEqual(r.hugeRequests90s.senders[0].session, '777b8f52-aaaa-bbbb-cccc-000000000001')
      assert.strictEqual(r.hugeRequests90s.senders[0].count, 3)
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
      extractResponseUsage({ model: 'm', id: 'msg_a1', usage: { cache_creation_input_tokens: 5, cache_read_input_tokens: 7 } }),
      { model: 'm', cc: 5, cr: 7, id: 'msg_a1' })
    assert.deepStrictEqual(
      extractResponseUsage({ response: { model: 'm2', usage: { cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } }),
      { model: 'm2', cc: 1, cr: 2, id: null })
    assert.strictEqual(extractResponseUsage({ nope: true }), null)
    assert.strictEqual(extractResponseUsage('str'), null)
    assert.strictEqual(extractResponseUsage(null), null)
  })

  // ── Per-SOURCE thrash attribution (2026-07-11 field fix) ─────────────────────
  // The chain: a request from session S carrying previous_message_id=m attributes response m to S.
  const S1 = '11111111-aaaa-bbbb-cccc-000000000001'
  const S2 = '22222222-aaaa-bbbb-cccc-000000000002'
  const S3 = '33333333-aaaa-bbbb-cccc-000000000003'
  const S4 = '44444444-aaaa-bbbb-cccc-000000000004'

  test('MEASURED FALSE POSITIVE: 4 distinct sessions\' single cold-start writes are NOT thrash — they are FAN_OUT_COLD_START', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      // Each fresh agent pays ONE big cold write, then its next request attributes it.
      const sessions = [S1, S2, S3, S4]
      // NOTE: real Anthropic ids are msg_<base62> — no second underscore; the bounded tail regex
      // is faithful to that shape, so the fixture ids must be too.
      sessions.forEach((s, i) => {
        responseFile(dir, NOW - 100_000 + i * 10_000, { cc: 115_000, cr: 500 }, 'claude-fable-5', `msg_cold${i}`)
        requestFile(dir, NOW - 95_000 + i * 10_000, 500_000, { session: s, model: 'claude-fable-5', previousMessageId: `msg_cold${i}` })
      })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, false, '4 sessions × 1 write each must NOT trip thrash')
      assert.strictEqual(r.thrash.count, 4, 'the misses are still counted honestly')
      assert.strictEqual(r.thrash.coldStartSessions, 4)
      assert.strictEqual(r.thrash.coldStartRebilledTokens, 4 * 115_000)
    } finally { cleanup() }
  })

  test('the SAME session re-writing its prefix 3× IS thrash; topSource and suspects name it exactly', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      // S1 thrashes: 3 big low-read writes, each attributed by S1's next request.
      for (let i = 0; i < 3; i++) {
        responseFile(dir, NOW - 120_000 + i * 30_000, { cc: 300_000, cr: 1_000 }, 'claude-fable-5', `msg_t${i}`)
        requestFile(dir, NOW - 115_000 + i * 30_000, 1_200_000, { session: S1, model: 'claude-fable-5', previousMessageId: `msg_t${i}` })
      }
      // An INNOCENT warm parent (S2) sends fat requests concurrently — it must NOT be blamed.
      responseFile(dir, NOW - 60_000, { cc: 10_000, cr: 240_000 }, 'claude-fable-5', 'msg_warm1')
      requestFile(dir, NOW - 55_000, 1_000_000, { session: S2, model: 'claude-fable-5', previousMessageId: 'msg_warm1' })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, true)
      assert.strictEqual(r.thrash.topSource?.session, S1)
      assert.strictEqual(r.thrash.topSource?.count, 3)
      assert.strictEqual(r.thrash.topSource?.rebilledTokens, 900_000)
      assert.ok(r.thrash.suspects.every(s => s.session === S1), `suspects must be narrowed to the thrashing session, got ${JSON.stringify(r.thrash.suspects)}`)
      assert.strictEqual(r.thrash.coldStartSessions, 0, 'the warm parent has no miss — not a cold start either')
    } finally { cleanup() }
  })

  test('pooled unattributed misses do NOT flip active — a phantom source must not deny launches (TRDD-THRGX41P)', () => {
    // The old rule pooled every unattributable miss into one pseudo-source and let it trip
    // `active`, on the premise that total attribution failure is rare. Measured in the field
    // (2026-08-02): attribution is the COMMON failure (~14% attributed), so N fresh agents'
    // one-time boot writes read as ONE thrashing session and the gate denied an unrelated
    // advisor launch. The pool is still counted and surfaced — it just cannot deny on its own.
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 4; i++) responseFile(dir, NOW - 30_000 - i * 20_000, { cc: 250_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, false, 'an unattributed pool alone must not read as one thrashing session')
      assert.strictEqual(r.thrash.topSource, null, 'topSource is the heaviest ATTRIBUTED source — none exists here')
      assert.strictEqual(r.thrash.count, 4, 'the misses are still counted and surfaced')
      assert.deepStrictEqual(r.thrash.unattributed, { count: 4, rebilledTokens: 1_000_000 }, 'the pool is surfaced, not dropped')
      assert.strictEqual(r.thrash.coldStartSessions, 0, 'the unattributed pool is never counted as distinct cold-start sessions')
    } finally { cleanup() }
  })

  test('an attributed thrasher is found even behind a BIGGER unattributed pool', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 3; i++) {
        responseFile(dir, NOW - 150_000 + i * 30_000, { cc: 300_000, cr: 1_000 }, 'claude-fable-5', `msg_a${i}`)
        requestFile(dir, NOW - 145_000 + i * 30_000, 500_000, { session: S1, model: 'claude-fable-5', previousMessageId: `msg_a${i}` })
      }
      for (let i = 0; i < 4; i++) responseFile(dir, NOW - 40_000 - i * 15_000, { cc: 200_000, cr: 0 })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.strictEqual(r.thrash.active, true)
      assert.strictEqual(r.thrash.topSource?.session, S1, 'the ATTRIBUTED repeat-writer wins over the larger anonymous pool')
    } finally { cleanup() }
  })

  test('a suspect whose model contradicts the thrashing model is dropped from the likely-source list', () => {
    // The field incident printed "thrash (model claude-fable-5). Likely source: <an opus session>"
    // — a self-contradiction: a sender on a different model cannot be the prefix-mutating caller.
    const { dir, cleanup } = tmpBodies()
    try {
      for (let i = 0; i < 3; i++) responseFile(dir, NOW - 90_000 + i * 20_000, { cc: 260_000, cr: 0 }, 'claude-fable-5', `msg_m${i}`)
      requestFile(dir, NOW - 20_000, 1_500_000, { session: S2, model: 'claude-opus-5' })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      const r = t.report(NOW)
      assert.ok(!r.thrash.suspects.some(s => s.model === 'claude-opus-5'),
        `an opus sender cannot be the source of fable thrash: ${JSON.stringify(r.thrash.suspects)}`)
    } finally { cleanup() }
  })

  test('sessionWarmSince: warm evidence disarms only for the right session, after the stall, never on cc-heavy calls', () => {
    const { dir, cleanup } = tmpBodies()
    try {
      const stallTs = NOW - 4 * 60_000
      // BEFORE the stall: a warm response from S1 — must not count.
      responseFile(dir, stallTs - 60_000, { cc: 8_000, cr: 220_000 }, 'claude-fable-5', 'msg_pre')
      requestFile(dir, stallTs - 55_000, 900_000, { session: S1, previousMessageId: 'msg_pre' })
      // AFTER the stall: a cc-heavy (still cold) response from S1 — not warm evidence.
      responseFile(dir, stallTs + 60_000, { cc: 200_000, cr: 10_000 }, 'claude-fable-5', 'msg_cold')
      requestFile(dir, stallTs + 65_000, 900_000, { session: S1, previousMessageId: 'msg_cold' })
      const t = new BodiesActivityTracker(dir)
      t.poll(NOW)
      assert.strictEqual(t.sessionWarmSince(S1, stallTs), false, 'pre-stall warmth / post-stall cold writes are not recovery evidence')
      // The measured recovery shape: cacheRead 215-247k with cacheCreate 6-21k, post-stall, from S1.
      responseFile(dir, stallTs + 2 * 60_000, { cc: 12_000, cr: 230_000 }, 'claude-fable-5', 'msg_recov')
      requestFile(dir, stallTs + 2 * 60_000 + 5_000, 950_000, { session: S1, previousMessageId: 'msg_recov' })
      t.poll(NOW)
      assert.strictEqual(t.sessionWarmSince(S1, stallTs), true)
      assert.strictEqual(t.sessionWarmSince(S2, stallTs), false, 'another session\'s warmth proves nothing about the stalled one')
    } finally { cleanup() }
  })
})
