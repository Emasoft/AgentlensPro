import * as assert from 'assert'
import {
  METRICS, findMetric, newPeakState, stepPeak, parseWatchArgs, fmtValue, fmtDur, baselineSql,
} from '../cli/watchCli'

// ── `agentlenspro watch` (generic metric peak watcher) ────────────────────────
// The peak engine and the option gate are pure, so these exercise the real logic — no mocks.

suite('watch: peak excursion engine', () => {
  const T = 100, HYST = 0.9   // exits below 90

  test('stays silent while the value is under the threshold', () => {
    const r = stepPeak(newPeakState(), 50, 1000, T, HYST)
    assert.deepStrictEqual(r.events, [])
    assert.strictEqual(r.state.above, false)
  })

  test('emits ONE onset when the value first crosses the threshold', () => {
    const r = stepPeak(newPeakState(), 120, 1000, T, HYST)
    assert.strictEqual(r.events.length, 1)
    assert.strictEqual(r.events[0].kind, 'onset')
    assert.strictEqual(r.events[0].value, 120)
  })

  test('does NOT emit per sample while above — a line per sample would flood the monitor', () => {
    let s = stepPeak(newPeakState(), 120, 1000, T, HYST).state
    for (const v of [130, 140, 135, 150]) {
      const r = stepPeak(s, v, 2000, T, HYST)
      assert.deepStrictEqual(r.events, [], `unexpected emit at ${v}`)
      s = r.state
    }
    assert.strictEqual(s.peak, 150, 'the maximum is tracked silently')
  })

  test('reports the excursion MAXIMUM, not the last value, when it ends', () => {
    let s = stepPeak(newPeakState(), 120, 0, T, HYST).state
    s = stepPeak(s, 300, 5_000, T, HYST).state       // the real peak
    s = stepPeak(s, 150, 10_000, T, HYST).state
    const r = stepPeak(s, 10, 20_000, T, HYST)       // falls under 90 → excursion closes
    assert.strictEqual(r.events.length, 1)
    assert.strictEqual(r.events[0].kind, 'peak')
    assert.strictEqual(r.events[0].value, 300)
    assert.strictEqual(r.events[0].durationMs, 20_000)
    assert.strictEqual(r.state.above, false, 'state resets so the next excursion is independent')
  })

  test('hysteresis holds the excursion open between threshold*F and threshold (no flapping)', () => {
    const opened = stepPeak(newPeakState(), 120, 0, T, HYST).state
    const held = stepPeak(opened, 95, 1_000, T, HYST)   // under 100 but above 90
    assert.deepStrictEqual(held.events, [], 'must not close at 95 with a 0.9 hysteresis')
    assert.strictEqual(stepPeak(held.state, 89, 2_000, T, HYST).events.length, 1, 'closes once under 90')
  })

  test('a flapping value with hysteresis 1 closes every dip — the reason the default is 0.9', () => {
    const s = stepPeak(newPeakState(), 120, 0, T, 1).state
    const r = stepPeak(s, 99, 1_000, T, 1)
    assert.strictEqual(r.events.length, 1, 'with no hysteresis band, a 1-unit dip already ends it')
  })

  test('reports every peak, never stopping: three excursions produce three peak events', () => {
    let s = newPeakState()
    const peaks: number[] = []
    const series: Array<[number, number]> = [
      [120, 0], [200, 1_000], [10, 2_000],      // excursion 1, max 200
      [150, 3_000], [10, 4_000],                // excursion 2, max 150
      [400, 5_000], [10, 6_000],                // excursion 3, max 400
    ]
    for (const [v, at] of series) {
      const r = stepPeak(s, v, at, T, HYST)
      s = r.state
      for (const e of r.events) if (e.kind === 'peak') peaks.push(e.value)
    }
    assert.deepStrictEqual(peaks, [200, 150, 400])
  })

  test('a value exactly AT the threshold opens an excursion (>= not >)', () => {
    assert.strictEqual(stepPeak(newPeakState(), 100, 0, T, HYST).events.length, 1)
  })
})

suite('watch: metric registry', () => {
  test('covers every value class the watcher advertises', () => {
    for (const n of ['input', 'output', 'cache-read', 'cache-create', 'tokens', 'cost', 'turns',
      'pct-5h', 'pct-7d', 'cost-5h', 'cost-7d', 'cost-per-min', 'tokens-per-min', 'active-sessions']) {
      assert.ok(METRICS.some(m => m.name === n), `missing metric ${n}`)
    }
  })

  test('rejects an unknown metric and lists the valid ones', () => {
    assert.throws(() => findMetric('bananas'), /unknown metric "bananas".*cache-create/s)
  })

  test('only session-scoped metrics claim to be cumulative — gauges must not', () => {
    for (const m of METRICS) {
      if (m.cumulative) assert.strictEqual(m.scope, 'session', `${m.name} claims cumulative outside session scope`)
    }
  })
})

suite('watch: option gate refuses dishonest combinations', () => {
  const base = ['--metric', 'input', '--session', 'abc', '--threshold', '10']

  test('accepts a well-formed session watch and applies the defaults', () => {
    const o = parseWatchArgs(base)
    assert.strictEqual(o.metric.name, 'input')
    assert.strictEqual(o.mode, 'total')
    assert.strictEqual(o.intervalSec, 30)
    assert.strictEqual(o.hysteresis, 0.9)
  })

  test('demands a --session for session-scoped metrics instead of guessing one', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'cost', '--threshold', '1']), /needs --session/)
  })

  test('refuses a per-run total for a machine-wide live rate', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'tokens-per-min', '--mode', 'since', '--threshold', '1']),
      /no per-run total/)
  })

  test('accepts the two modes a machine-wide live rate CAN answer', () => {
    assert.strictEqual(parseWatchArgs(['--metric', 'tokens-per-min', '--mode', 'total', '--threshold', '1']).mode, 'total')
    assert.strictEqual(parseWatchArgs(['--metric', 'tokens-per-min', '--mode', 'rate', '--threshold', '1']).mode, 'rate')
  })

  test('refuses "since" on a metric that is already a rate', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'cost-per-min', '--mode', 'since', '--threshold', '1']),
      /already a rate/)
  })

  test('refuses a PAST --since for a non-session metric — it cannot be reconstructed', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'pct-5h', '--mode', 'since', '--since', '2020-01-01T00:00:00Z', '--threshold', '1']),
      /only be reconstructed for session-scoped/)
  })

  test('refuses --since outside --mode since rather than ignoring it', () => {
    assert.throws(() => parseWatchArgs([...base, '--since', '2020-01-01T00:00:00Z']), /only applies to --mode since/)
  })

  test('rejects a malformed --since', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'input', '--session', 'a', '--mode', 'since', '--since', 'yesterday', '--threshold', '1']),
      /ISO datetime/)
  })

  test('requires --threshold or --every so a watch always has something to report', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'input', '--session', 'a']), /--threshold N.*--every/s)
    assert.strictEqual(parseWatchArgs(['--metric', 'input', '--session', 'a', '--every']).threshold, null)
  })

  test('clamps the interval to [5,900] and hysteresis to [0,1]', () => {
    assert.strictEqual(parseWatchArgs([...base, '--interval', '1']).intervalSec, 5)
    assert.strictEqual(parseWatchArgs([...base, '--interval', '99999']).intervalSec, 900)
    assert.strictEqual(parseWatchArgs([...base, '--hysteresis', '5']).hysteresis, 1)
    assert.strictEqual(parseWatchArgs([...base, '--hysteresis', '-2']).hysteresis, 0)
  })

  test('rejects an unknown flag and a missing flag value rather than silently continuing', () => {
    assert.throws(() => parseWatchArgs([...base, '--nope']), /unknown watch flag/)
    assert.throws(() => parseWatchArgs(['--metric']), /--metric expects a value/)
  })

  test('rejects a bad --mode', () => {
    assert.throws(() => parseWatchArgs([...base, '--mode', 'sideways']), /total\|rate\|since/)
  })
})

suite('watch: past-baseline SQL dedupes by message id', () => {
  // Claude Code repeats one message's full usage on every content-block row; the naive sum
  // over-counted cache_read 1.7x and output 2.1x on a real session. The GROUP BY is the fix and
  // must never be dropped.
  const sql = baselineSql('2026-07-23T07:00:00Z')

  test('groups by message id inside a subquery instead of summing rows directly', () => {
    assert.match(sql, /GROUP BY message\.id/)
    assert.match(sql, /max\(COALESCE\(message\.usage\.cache_read_input_tokens,0\)\)/)
  })

  test('filters on the timestamp and skips records with no usage', () => {
    assert.match(sql, /"timestamp" >= '2026-07-23T07:00:00Z'/)
    assert.match(sql, /message\.usage IS NOT NULL/)
  })

  test('is a single read-only SELECT', () => {
    assert.ok(sql.trim().startsWith('SELECT'))
    assert.ok(!/;/.test(sql), 'no statement separator — the tool takes one statement')
  })
})

suite('watch: formatting', () => {
  test('scales token counts and keeps money and percentages readable', () => {
    assert.strictEqual(fmtValue(1_500_000_000, 'tokens'), '1.50B')
    assert.strictEqual(fmtValue(2_400_000, 'tokens'), '2.40M')
    assert.strictEqual(fmtValue(1500, 'tokens'), '1.5k')
    assert.strictEqual(fmtValue(42, 'tokens'), '42')
    assert.strictEqual(fmtValue(5.25, 'usd'), '$5.2500')
    assert.strictEqual(fmtValue(205.5, 'usd'), '$205.50')
    assert.strictEqual(fmtValue(26.44, 'pct'), '26.4%')
    assert.strictEqual(fmtValue(8, 'count'), '8')
  })

  test('formats a negative rate — a falling cumulative delta must stay readable', () => {
    assert.strictEqual(fmtValue(-2_400_000, 'tokens'), '-2.40M')
  })

  test('renders durations in s and m', () => {
    assert.strictEqual(fmtDur(45_000), '45s')
    assert.strictEqual(fmtDur(120_000), '2m')
    assert.strictEqual(fmtDur(150_000), '2m 30s')
  })
})
