import * as assert from 'assert'
import { StatuslineUsageReader, recordFromStatuslinePayload } from '../statuslineUsage'

// The reader's aggregates, fed by the capture (src/cli/statuslineCapture.ts → the server) rather than
// by tailing a file. The old source was `write_usage_jsonl` inside the user's personal
// ~/.claude/statusline.py; that script was replaced on 2026-07-31 20:28, the replacement dropped the
// writer, and this module went on "reading" a frozen file for 23 hours while every consumer
// (database/writer's authoritative cost, burnMonitor's billing events, get_account_status's window
// fill) quietly used stale or empty data. Hence the two things pinned here: the PROJECTION from a real
// payload, and the aggregate rules — latest-wins, max-observed, never SUM.

/** A payload shaped exactly as Claude Code sends it to the status line. */
function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 's1',
    workspace: { project_dir: '/p', current_dir: '/p' },
    model: { id: 'claude-opus-5', display_name: 'Opus' },
    context_window: {
      total_input_tokens: 100_000, total_output_tokens: 300, context_window_size: 1_000_000,
      used_percentage: 10,
      current_usage: { input_tokens: 2, output_tokens: 300, cache_creation_input_tokens: 500, cache_read_input_tokens: 99_498 },
    },
    cost: { total_cost_usd: 1 },
    ...over,
  }
}

const S = (sec: number): number => sec * 1000   // the API takes ms; records store seconds

suite('statuslineUsage — projecting a live payload onto the usage record', () => {
  test('maps the nested payload onto the flat record, including rate_limits', () => {
    const r = recordFromStatuslinePayload(payload({
      rate_limits: { five_hour: { used_percentage: 57.99999999999999 }, seven_day: { used_percentage: 71 } },
    }), S(100))
    assert.ok(r)
    assert.strictEqual(r.session_id, 's1')
    assert.strictEqual(r.model, 'Opus')
    assert.strictEqual(r.project_dir, '/p')
    assert.strictEqual(r.cache_read_input_tokens, 99_498)
    assert.strictEqual(r.total_input_tokens, 100_000)
    assert.strictEqual(r.total_cost_usd, 1)
    // The live payload spells it `used_percentage`; the record carries the legacy `utilization` name.
    assert.strictEqual(r.rate_limits?.five_hour?.utilization, 57.99999999999999,
      'full float precision must survive — it is what the endpoint integers cannot give')
    assert.strictEqual(r.rate_limits?.seven_day?.utilization, 71)
  })

  test('ts is epoch SECONDS, not milliseconds', () => {
    // getBillingEvents prunes against a seconds cutoff and burnMonitor.toMs() re-normalises with
    // `ts < 1e12 ? ts*1000 : ts`. Emitting ms makes every event look ~55,000 years old, and the
    // entire billing stream is silently pruned away.
    assert.strictEqual(recordFromStatuslinePayload(payload(), S(1_700_000_000))!.ts, 1_700_000_000)
  })

  test('a payload with no session_id yields null rather than an unattributable record', () => {
    assert.strictEqual(recordFromStatuslinePayload({ context_window: {} }), null)
    assert.strictEqual(recordFromStatuslinePayload({ session_id: '' }), null)
  })

  test('an absent rate_limits block is omitted, never fabricated as 0', () => {
    assert.strictEqual(recordFromStatuslinePayload(payload(), S(1))!.rate_limits, undefined)
    // A partial block keeps only the window that actually reported.
    const partial = recordFromStatuslinePayload(payload({ rate_limits: { five_hour: { used_percentage: 20 } } }), S(1))
    assert.strictEqual(partial!.rate_limits?.five_hour?.utilization, 20)
    assert.strictEqual(partial!.rate_limits?.seven_day, undefined)
  })

  test('missing nested blocks degrade to zeros instead of throwing', () => {
    const r = recordFromStatuslinePayload({ session_id: 's1' }, S(5))
    assert.ok(r)
    assert.strictEqual(r.total_input_tokens, 0)
    assert.strictEqual(r.model, '')
  })
})

suite('statuslineUsage — rate_limits ingestion (TRDD-VY1IUVUM Part-5)', () => {
  test('no sample carries rate_limits → getLatestRateLimits() is null (absent, not 0)', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload(), S(100))
    r.ingestSample(payload(), S(200))
    assert.strictEqual(r.getLatestRateLimits(), null)
  })

  test('captures the utilization when a sample carries the rate_limits block', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 37.5 }, seven_day: { used_percentage: 6 } } }), S(100))
    assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 100, fiveHourUtilization: 37.5, sevenDayUtilization: 6 })
  })

  test('latest-wins: a newer sample overrides an older snapshot; a stale one does not clobber it', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 2 } } }), S(100))
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 55 }, seven_day: { used_percentage: 9 } } }), S(300))
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 99 }, seven_day: { used_percentage: 99 } } }), S(200))
    assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 300, fiveHourUtilization: 55, sevenDayUtilization: 9 },
      'an out-of-order sample must not overwrite a fresher reading')
  })

  test('a partial block (only five_hour) leaves the missing window null, never 0', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 20 } } }), S(100))
    assert.deepStrictEqual(r.getLatestRateLimits(), { ts: 100, fiveHourUtilization: 20, sevenDayUtilization: null })
  })

  // MEASURED 2026-08-01: 13 concurrent sessions on one machine reported EIGHT distinct (5h,7d) pairs
  // — at least four accounts live at once. The machine-wide snapshot therefore returns whichever
  // session sampled LAST, and a caller labelling it "the current account" prints one account's
  // utilization under another's name.
  test('per-session lookup returns THAT account\'s window, not whoever sampled last', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ session_id: 'a', rate_limits: { five_hour: { used_percentage: 59 }, seven_day: { used_percentage: 51 } } }), S(100))
    r.ingestSample(payload({ session_id: 'b', rate_limits: { five_hour: { used_percentage: 8 }, seven_day: { used_percentage: 74 } } }), S(200))
    // Machine-wide latest-wins is session b — the trap.
    assert.strictEqual(r.getLatestRateLimits()?.fiveHourUtilization, 8)
    // Asking for session a's account gets session a's window.
    assert.strictEqual(r.getRateLimitsForSessions(['a'])?.fiveHourUtilization, 59)
    assert.strictEqual(r.getRateLimitsForSessions(['b'])?.sevenDayUtilization, 74)
    // Several sessions on ONE account share a window; the newest of them wins.
    assert.strictEqual(r.getRateLimitsForSessions(['a', 'b'])?.fiveHourUtilization, 8)
  })

  test('an unknown session yields null — absent, never a stand-in from another account', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ session_id: 'a', rate_limits: { five_hour: { used_percentage: 59 } } }), S(100))
    assert.strictEqual(r.getRateLimitsForSessions(['nobody']), null)
    assert.strictEqual(r.getRateLimitsForSessions([]), null)
  })

  test('a malformed sample is skipped without breaking ingestion', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample({ nonsense: true }, S(1))
    r.ingestSample(payload({ rate_limits: { five_hour: { used_percentage: 42 } } }), S(2))
    assert.strictEqual(r.getLatestRateLimits()?.fiveHourUtilization, 42)
  })
})

suite('statuslineUsage — the aggregate rules the consumers depend on', () => {
  test('LATEST-WINS for the point-in-time fields, MAX for the peak, COUNT for samples — never SUM', () => {
    // Summing is the tempting bug: the statusline can miss fast turns, so a sum is neither the
    // cumulative truth nor a sample of it. database/writer reads totalCostUsd as authoritative and
    // burnMonitor gates on samples > 0, so both rules are load-bearing.
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ context_window: { total_input_tokens: 500_000, context_window_size: 1_000_000, used_percentage: 50, current_usage: {} }, cost: { total_cost_usd: 5 } }), S(100))
    r.ingestSample(payload({ context_window: { total_input_tokens: 200_000, context_window_size: 1_000_000, used_percentage: 20, current_usage: {} }, cost: { total_cost_usd: 7 } }), S(200))
    const a = r.get('s1')!
    assert.strictEqual(a.totalCostUsd, 7, 'latest cumulative cost, NOT 5+7')
    assert.strictEqual(a.lastTotalInputTokens, 200_000, 'latest occupancy, not the max')
    assert.strictEqual(a.peakContextTokens, 500_000, 'the peak is the max ever observed')
    assert.strictEqual(a.samples, 2)
    assert.strictEqual(a.usedPercentage, 20)
  })

  test('billing events are per-turn deltas of the cumulative cost, never the cumulative value', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ cost: { total_cost_usd: 5 } }), S(100))
    r.ingestSample(payload({ cost: { total_cost_usd: 9 } }), S(200))
    const evs = r.getBillingEvents(S(300))
    assert.strictEqual(evs.length, 2)
    assert.strictEqual(evs[1].deltaCostUsd, 4, 'the increment, not 9')
    assert.strictEqual(evs[1].sessionId, 's1')
    // The four buckets ride along so the burn breakdown can attribute the split rather than
    // dumping the whole turn into `unknown`.
    assert.strictEqual(evs[1].deltaCacheRead, 99_498)
    assert.strictEqual(evs[1].deltaTokens, 2 + 300 + 500 + 99_498)
  })

  test('a cost that goes backwards never produces a negative delta', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ cost: { total_cost_usd: 9 } }), S(100))
    r.ingestSample(payload({ cost: { total_cost_usd: 2 } }), S(200))
    assert.ok(r.getBillingEvents(S(300)).every(e => e.deltaCostUsd >= 0))
  })

  test('overlay attaches the aggregate and never LOWERS an already-observed peak', () => {
    const r = new StatuslineUsageReader()
    r.ingestSample(payload({ context_window: { total_input_tokens: 300_000, context_window_size: 1_000_000, used_percentage: 30, current_usage: {} } }), S(100))
    const card = { sessionId: 's1', peakContextPerTurn: 900_000 } as unknown as Parameters<StatuslineUsageReader['overlay']>[0]
    r.overlay(card)
    assert.strictEqual((card as unknown as { statusline?: unknown }).statusline !== undefined, true)
    assert.strictEqual((card as unknown as { peakContextPerTurn: number }).peakContextPerTurn, 900_000,
      'a throttle-dropped turn must never lower a peak the transcript parser already saw')
  })

  test('a session with no samples is left completely alone by overlay', () => {
    const r = new StatuslineUsageReader()
    const card = { sessionId: 'other', peakContextPerTurn: 1 } as unknown as Parameters<StatuslineUsageReader['overlay']>[0]
    r.overlay(card)
    assert.strictEqual((card as unknown as { statusline?: unknown }).statusline, undefined)
  })
})
