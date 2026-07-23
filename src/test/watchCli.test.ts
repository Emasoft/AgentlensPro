import * as assert from 'assert'
import {
  METRICS, findMetric, metricsWithPastSupport, newPeakState, stepPeak, exitThreshold,
  parseWatchArgs, projectSample, fmtValue, fmtDur, baselineSql, runWatchCli,
} from '../cli/watchCli'
import { UsageError, EXIT } from '../cli/cliErrors'

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

  // REGRESSION: the exit level was `threshold * hysteresis`, which INVERTS the band for a
  // negative threshold — at -100/0.9 the product is -90, above the trigger, so an excursion
  // closed at -95 while still past its own threshold. Reachable: a falling cumulative gives a
  // negative rate.
  test('the exit level always sits strictly BELOW the threshold, for either sign', () => {
    assert.strictEqual(exitThreshold(100, 0.9), 90)
    assert.strictEqual(exitThreshold(-100, 0.9), -110)
    assert.ok(exitThreshold(-100, 0.9) < -100, 'a negative threshold must not invert the band')
    assert.strictEqual(exitThreshold(100, 1), 100, 'hysteresis 1 = no band')
    assert.strictEqual(exitThreshold(0, 0.9), 0)
  })

  test('a negative threshold tracks an excursion instead of closing it immediately', () => {
    const NEG = -100
    const opened = stepPeak(newPeakState(), -100, 0, NEG, HYST)
    assert.strictEqual(opened.events.length, 1, 'reaching -100 opens the excursion')
    const held = stepPeak(opened.state, -95, 1_000, NEG, HYST)
    assert.deepStrictEqual(held.events, [], '-95 is above the threshold — it must NOT close here')
    const closed = stepPeak(held.state, -120, 2_000, NEG, HYST)
    assert.strictEqual(closed.events.length, 1, 'closes only once past the band at -110')
    assert.strictEqual(closed.events[0].value, -95, 'the excursion max is the LEAST negative value')
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

  test('refuses "since" on a machine-wide LIVE RATE with the rate-specific reason', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'tokens-per-min', '--mode', 'since', '--threshold', '1']),
      /already a rate/)
  })

  test('refuses "since" on a machine-wide GAUGE with the no-total reason', () => {
    // active-sessions is machine-scoped but not a rate, so it exercises the other rule.
    assert.throws(() => parseWatchArgs(['--metric', 'active-sessions', '--mode', 'since', '--threshold', '1']),
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

  test('refuses a PAST --since for a rolling gauge — it cannot be reconstructed', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'pct-5h', '--mode', 'since', '--since', '2020-01-01T00:00:00Z', '--threshold', '1']),
      /rolling gauges/)
  })

  // REGRESSION: the gate used to allow a past --since for ANY session metric while the
  // reconstruction path supported only the four token columns, so `--metric cost --mode since
  // --since <past>` parsed cleanly and then threw at runtime, after the watch had been armed.
  // Capability now lives on the metric (pastSql) and the gate reads it, so the two cannot drift.
  test('refuses a PAST --since for session metrics that cannot be reconstructed (cost, turns)', () => {
    for (const m of ['cost', 'turns']) {
      assert.throws(
        () => parseWatchArgs(['--metric', m, '--session', 'a', '--mode', 'since', '--since', '2020-01-01T00:00:00Z', '--threshold', '1']),
        /cannot be reconstructed/,
        `${m} must be refused at PARSE time, not at runtime`)
    }
  })

  test('allows a PAST --since for every metric that declares a pastSql', () => {
    for (const m of metricsWithPastSupport()) {
      const o = parseWatchArgs(['--metric', m, '--session', 'a', '--mode', 'since', '--since', '2020-01-01T00:00:00Z', '--threshold', '1'])
      assert.strictEqual(o.metric.name, m)
    }
  })

  test('every metric the gate accepts for a past --since really has the SQL to compute it', () => {
    // The invariant that makes the regression above impossible to reintroduce.
    for (const m of METRICS) {
      const accepted = (() => {
        try {
          parseWatchArgs(['--metric', m.name, ...(m.scope === 'session' ? ['--session', 'a'] : []),
            '--mode', 'since', '--since', '2020-01-01T00:00:00Z', '--threshold', '1'])
          return true
        } catch { return false }
      })()
      assert.strictEqual(accepted, Boolean(m.pastSql), `${m.name}: gate says ${accepted}, pastSql says ${Boolean(m.pastSql)}`)
    }
  })

  test('refuses a FUTURE --since instead of silently baselining from now', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString()
    assert.throws(() => parseWatchArgs(['--metric', 'input', '--session', 'a', '--mode', 'since', '--since', future, '--threshold', '1']),
      /FUTURE/)
  })

  test('refuses --session on a metric it cannot narrow, rather than ignoring the flag', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'pct-5h', '--session', 'abc', '--threshold', '1']),
      /does not narrow it/)
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
  const sql = baselineSql('2026-07-23T07:00:00Z', 'sum(cr)')

  test('groups by message id inside a subquery instead of summing rows directly', () => {
    assert.match(sql, /GROUP BY message\.id/)
    assert.match(sql, /max\(COALESCE\(message\.usage\.cache_read_input_tokens,0\)\)/)
  })

  test('filters on the timestamp and skips records with no usage', () => {
    // The instant is emitted in canonical toISOString() form, not echoed as the caller typed it.
    assert.match(sql, /"timestamp" >= '2026-07-23T07:00:00\.000Z'/)
    assert.match(sql, /message\.usage IS NOT NULL/)
  })

  test('is a single read-only SELECT', () => {
    assert.ok(sql.trim().startsWith('SELECT'))
    assert.ok(!/;/.test(sql), 'no statement separator — the tool takes one statement')
  })

  test('the instant is rebuilt canonically, so no injected text can survive into the SQL', () => {
    // Sanitising by stripping quotes only removes the metacharacter you thought of; rebuilding
    // the value with toISOString() makes it structurally incapable of carrying any.
    assert.match(baselineSql('2026-07-23T07:00:00+02:00', 'sum(i)'), /"timestamp" >= '2026-07-23T05:00:00\.000Z'/)
    assert.throws(() => baselineSql("2026-01-01' OR '1'='1", 'sum(i)'), /ISO datetime/)
    assert.throws(() => baselineSql('yesterday', 'sum(i)'), /ISO datetime/)
  })

  test("`tokens` reconstructs as input+output — get_agent_tokens' totalTokens EXCLUDES cache", () => {
    // Measured: input 1550 + output 614578 = totalTokens 616128, against 315M cache-read on the
    // same session. Summing all four here would disagree with the live gauge by ~500x.
    assert.strictEqual(findMetric('tokens').pastSql, 'sum(i) + sum(o)')
  })
})

suite('watch: metric readers pull from their own source payload', () => {
  // The registry owns extraction, so these run the SHIPPING readers against the field names the
  // live tools actually return (captured from get_agent_tokens / get_window_eta / get_burn_status).
  const agentTokens = {
    inputTokens: 1550, outputTokens: 614578, cacheReadTokens: 314999420,
    cacheCreateTokens: 5221518, totalTokens: 616128, cost_usd: 205.5064, turns: 775,
  }
  const eta = {
    fiveHour: { fillPct: 26.1, consumedCostUsd: 341.4, costPerMin: 2.22 },
    sevenDay: { fillPct: 8.8, consumedCostUsd: 1034.2 },
  }
  const burn = { activeSessions: 8, accountWindows: [{ fiveMinTokensPerMin: 1421678 }, { fiveMinTokensPerMin: 181342 }] }

  const reads = (name: string, p: Record<string, unknown>): number | null => findMetric(name).read(p)

  test('session metrics map onto the get_agent_tokens field names', () => {
    assert.strictEqual(reads('input', agentTokens), 1550)
    assert.strictEqual(reads('output', agentTokens), 614578)
    assert.strictEqual(reads('cache-read', agentTokens), 314999420)
    assert.strictEqual(reads('cache-create', agentTokens), 5221518)
    assert.strictEqual(reads('tokens', agentTokens), 616128)
    assert.strictEqual(reads('cost', agentTokens), 205.5064)
    assert.strictEqual(reads('turns', agentTokens), 775)
  })

  test('account metrics map onto the two get_window_eta windows', () => {
    assert.strictEqual(reads('pct-5h', eta), 26.1)
    assert.strictEqual(reads('pct-7d', eta), 8.8)
    assert.strictEqual(reads('cost-5h', eta), 341.4)
    assert.strictEqual(reads('cost-7d', eta), 1034.2)
    assert.strictEqual(reads('cost-per-min', eta), 2.22)
  })

  test('machine burn SUMS the per-account windows', () => {
    assert.strictEqual(reads('tokens-per-min', burn), 1421678 + 181342)
    assert.strictEqual(reads('active-sessions', burn), 8)
  })

  test('an absent or non-finite field reads as null, NEVER as 0', () => {
    // A fabricated 0 would make a threshold watcher either alert on nothing or go quiet on a
    // dead feed — both indistinguishable from a real measurement.
    assert.strictEqual(reads('cost', {}), null)
    assert.strictEqual(reads('pct-5h', {}), null)
    assert.strictEqual(reads('tokens-per-min', { accountWindows: [] }), null)
    assert.strictEqual(reads('input', { inputTokens: Number.NaN }), null)
  })
})

suite('watch: projectSample mode arithmetic', () => {
  const cumulative = findMetric('output')
  const alreadyRate = findMetric('tokens-per-min')
  const t0 = 1_000_000

  test('total reports the raw current value', () => {
    assert.strictEqual(projectSample('total', cumulative, 500, { v: 100, at: t0 }, t0 + 60_000, 0), 500)
  })

  test('since subtracts the baseline', () => {
    assert.strictEqual(projectSample('since', cumulative, 500, { v: 100, at: t0 }, t0 + 60_000, 300), 200)
  })

  test('rate differences a cumulative metric per minute', () => {
    assert.strictEqual(projectSample('rate', cumulative, 700, { v: 100, at: t0 }, t0 + 120_000, 0), 300)
  })

  test('rate reads an already-per-minute source straight through, never differencing it', () => {
    assert.strictEqual(projectSample('rate', alreadyRate, 42, { v: 10, at: t0 }, t0 + 60_000, 0), 42)
  })

  test('two samples at the same instant yield 0, not Infinity', () => {
    assert.strictEqual(projectSample('rate', cumulative, 700, { v: 100, at: t0 }, t0, 0), 0)
  })

  test('a falling cumulative gives a negative rate rather than being clamped away', () => {
    assert.strictEqual(projectSample('rate', cumulative, 100, { v: 700, at: t0 }, t0 + 60_000, 0), -600)
  })
})

suite('watch: a caller mistake must not look like a runtime abort', () => {
  // standalone/cli.ts maps every THROWN error to exit 1 — the same code `budget --watch` uses to
  // mean "abort the run". A mistyped flag therefore used to be indistinguishable from a real
  // abort: the harness kills the batch and the operator goes hunting a burn that never happened.
  test('every argument validation raises UsageError, not a bare Error', () => {
    const bad: string[][] = [
      [], ['--metric'], ['--metric', 'bananas'], ['--metric', 'input'],
      ['--metric', 'input', '--session', 'a', '--mode', 'sideways'],
      ['--metric', 'input', '--session', 'a', '--threshold', 'lots'],
      ['--metric', 'input', '--session', 'a', '--nope'],
      ['--metric', 'pct-5h', '--session', 'a', '--threshold', '1'],
      ['--metric', 'input', '--session', 'a', '--threshold', '1', '--for', '-5'],
    ]
    for (const argv of bad) {
      assert.throws(() => parseWatchArgs(argv), (e: Error) => e instanceof UsageError,
        `expected UsageError for: ${JSON.stringify(argv)}`)
    }
  })

  test('runWatchCli RETURNS EX_USAGE (64) for a bad command line instead of throwing', async () => {
    const orig = { log: console.log, error: console.error }
    const out: string[] = []
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')) }
    console.error = () => { /* captured, not printed */ }
    let code: number
    try { code = await runWatchCli(['--metric', 'bananas']) } finally { console.log = orig.log; console.error = orig.error }
    assert.strictEqual(code, EXIT.USAGE)
    assert.strictEqual(EXIT.USAGE, 64, 'sysexits EX_USAGE — the repo already uses EX_CONFIG 78')
    assert.ok(out.some(l => l.startsWith('[watch] FAIL:')), 'the reason must still reach STDOUT for Monitor')
  })

  test('no args prints usage and exits EX_USAGE; --help exits 0', async () => {
    const orig = console.log
    console.log = () => { /* silence the usage block */ }
    try {
      assert.strictEqual(await runWatchCli([]), EXIT.USAGE)
      assert.strictEqual(await runWatchCli(['--help']), EXIT.OK)
    } finally { console.log = orig }
  })

  test('an infinite numeric flag is refused rather than silently clamped', () => {
    assert.throws(() => parseWatchArgs(['--metric', 'input', '--session', 'a', '--threshold', '1', '--interval', '1e999']),
      /finite number/)
  })
})

suite('watch: --for bounds the lifetime', () => {
  const base = ['--metric', 'input', '--session', 'a', '--threshold', '1']

  test('defaults to 0, meaning run until killed (the Monitor/daemon case)', () => {
    assert.strictEqual(parseWatchArgs(base).forMinutes, 0)
  })

  test('accepts a positive duration and refuses a negative one', () => {
    assert.strictEqual(parseWatchArgs([...base, '--for', '90']).forMinutes, 90)
    assert.throws(() => parseWatchArgs([...base, '--for', '-1']), /non-negative/)
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
