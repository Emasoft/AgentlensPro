import * as assert from 'assert'
import { decideBudget, pickWindow, parseBudgetArgs, fmtMin, BUDGET_EXIT, runBudgetCli, EtaPayload } from '../cli/budgetCli'

// ── `agentlenspro budget` (timed-run window budgeting) ────────────────────────
// The decision core is pure, so these are real tests over real payload shapes — the fixtures
// below are the field set the live get_window_eta actually returns (verified against the tool,
// not invented): willExhaustAtCurrentRate / etaMinutes / etaHuman / capacity.source, plus the
// bindingWindow STRING ("5h" | "7d").

const plateau = { label: '5h', willExhaustAtCurrentRate: false, etaMinutes: null, etaHuman: null, capacity: { source: 'observed' } }
const willExhaust = (min: number, src = 'observed') => ({
  label: '5h', willExhaustAtCurrentRate: true, etaMinutes: min, etaHuman: fmtMin(min), capacity: { source: src },
})

suite('budget: decideBudget', () => {
  test('returns GO when the rolling window plateaus below the cap, even with a null ETA', () => {
    const d = decideBudget(plateau, 90, 2)
    assert.strictEqual(d.verdict, 'GO')
    assert.match(d.reason, /plateaus below the cap/)
  })

  test('returns NO_GO when the window exhausts before the run finishes', () => {
    const d = decideBudget(willExhaust(45), 90, 2)
    assert.strictEqual(d.verdict, 'NO_GO')
    assert.strictEqual(d.etaMinutes, 45)
  })

  test('returns TIGHT when the run fits but under the safety margin', () => {
    // 120m ETA vs a 90m run = 1.33x — fits, but below the 2x margin.
    assert.strictEqual(decideBudget(willExhaust(120), 90, 2).verdict, 'TIGHT')
  })

  test('returns GO once the ETA clears the margin', () => {
    assert.strictEqual(decideBudget(willExhaust(200), 90, 2).verdict, 'GO')
  })

  test('treats the margin boundary as TIGHT-below / GO-at (no gap between the bands)', () => {
    assert.strictEqual(decideBudget(willExhaust(179), 90, 2).verdict, 'TIGHT')
    assert.strictEqual(decideBudget(willExhaust(180), 90, 2).verdict, 'GO')
  })

  test('returns UNKNOWN rather than inventing a number when capacity is not calibrated', () => {
    const uncalibrated = { label: '5h', willExhaustAtCurrentRate: true, etaMinutes: null }
    const d = decideBudget(uncalibrated, 90, 2)
    assert.strictEqual(d.verdict, 'UNKNOWN')
    assert.match(d.reason, /not calibrated/)
  })

  test('names the capacity source in the UNKNOWN reason when the payload carries one', () => {
    const d = decideBudget({ willExhaustAtCurrentRate: true, etaMinutes: null, capacity: { source: 'same-plan-proxy' } }, 60, 2)
    assert.strictEqual(d.verdict, 'UNKNOWN')
    assert.match(d.reason, /same-plan-proxy/)
  })

  test('returns UNKNOWN for a window missing from the payload instead of throwing', () => {
    assert.strictEqual(decideBudget(undefined, 90, 2).verdict, 'UNKNOWN')
  })

  test('clamps a margin below 1 to 1 — a margin can never make an abort look safe', () => {
    // eta 80 < run 90 must stay NO_GO no matter how permissive the caller sets the margin.
    assert.strictEqual(decideBudget(willExhaust(80), 90, 0.1).verdict, 'NO_GO')
  })

  test('sharpens as the run proceeds: the same ETA flips GO→NO_GO only when time runs short', () => {
    // A fixed 60m ETA against a shrinking remaining-time is the whole point of the watch loop.
    assert.strictEqual(decideBudget(willExhaust(60), 20, 2).verdict, 'GO')
    assert.strictEqual(decideBudget(willExhaust(60), 40, 2).verdict, 'TIGHT')
    assert.strictEqual(decideBudget(willExhaust(60), 90, 2).verdict, 'NO_GO')
  })
})

suite('budget: pickWindow', () => {
  const payload: EtaPayload = {
    fiveHour: willExhaust(30), sevenDay: willExhaust(6000), bindingWindow: '7d',
  }

  test('follows the payload bindingWindow STRING when asked for binding', () => {
    const { key, win } = pickWindow(payload, 'binding')
    assert.strictEqual(key, '7d')
    assert.strictEqual(win!.etaMinutes, 6000)
  })

  test('honours an explicit window over the binding one', () => {
    assert.strictEqual(pickWindow(payload, '5h').win!.etaMinutes, 30)
    assert.strictEqual(pickWindow(payload, '7d').win!.etaMinutes, 6000)
  })

  test('falls back to 5h when the payload names no binding window', () => {
    assert.strictEqual(pickWindow({ fiveHour: willExhaust(30) }, 'binding').key, '5h')
  })
})

suite('budget: parseBudgetArgs', () => {
  test('accepts --minutes and applies the documented defaults', () => {
    const o = parseBudgetArgs(['--minutes', '90'])
    assert.strictEqual(o.minutes, 90)
    assert.strictEqual(o.window, 'binding')
    assert.strictEqual(o.margin, 2)
    assert.strictEqual(o.watch, false)
  })

  test('converts --hours to minutes', () => {
    assert.strictEqual(parseBudgetArgs(['--hours', '2']).minutes, 120)
  })

  test('takes an optional interval after --watch and defaults it to 60s', () => {
    assert.strictEqual(parseBudgetArgs(['--minutes', '10', '--watch']).intervalSec, 60)
    assert.strictEqual(parseBudgetArgs(['--minutes', '10', '--watch', '120']).intervalSec, 120)
  })

  test('clamps the poll interval into [10, 900] so a watch can neither hammer nor sleep through a run', () => {
    assert.strictEqual(parseBudgetArgs(['--minutes', '10', '--watch', '1']).intervalSec, 10)
    assert.strictEqual(parseBudgetArgs(['--minutes', '10', '--watch', '99999']).intervalSec, 900)
  })

  test('fails fast without a run length — a budget with no duration has no question to answer', () => {
    assert.throws(() => parseBudgetArgs([]), /needs the run length/)
  })

  test('rejects an unknown window instead of silently defaulting', () => {
    assert.throws(() => parseBudgetArgs(['--minutes', '5', '--window', '1h']), /5h\|7d\|binding/)
  })

  test('rejects an unknown flag rather than ignoring it', () => {
    assert.throws(() => parseBudgetArgs(['--minutes', '5', '--nope']), /unknown budget flag/)
  })

  test('rejects a non-numeric duration', () => {
    assert.throws(() => parseBudgetArgs(['--minutes', 'soon']), /expects a number/)
  })

  test('parses --with-risks and --json', () => {
    const o = parseBudgetArgs(['--minutes', '5', '--with-risks', '--json'])
    assert.strictEqual(o.withRisks, true)
    assert.strictEqual(o.json, true)
  })
})

suite('budget: failures reach STDOUT, not only stderr', () => {
  // Monitor turns only STDOUT lines into events. A mistyped flag whose error went solely to
  // stderr produced a watch that emitted nothing and ended — indistinguishable from "armed and
  // quiet". This pins the mirror so that regression cannot come back.
  test('runBudgetCli prints a [budget] FAIL line on stdout and still rethrows', async () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    let threw = false
    try {
      await runBudgetCli(['--minutes', '5', '--window', '1h'])
    } catch {
      threw = true
    } finally {
      console.log = orig
    }
    assert.strictEqual(threw, true, 'the error must still propagate for the non-zero exit')
    assert.ok(lines.some(l => l.startsWith('[budget] FAIL:')), `expected a stdout FAIL line, got ${JSON.stringify(lines)}`)
    assert.ok(lines.some(l => l.includes('5h|7d|binding')), 'the stdout line must carry the actual reason')
  })

  test('--help answers on stdout with exit 0 and never touches the server', async () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
    let code: number
    try { code = await runBudgetCli(['--help']) } finally { console.log = orig }
    assert.strictEqual(code, 0)
    assert.ok(lines.join('\n').includes('--minutes N | --hours H'))
  })
})

suite('budget: exit-code contract', () => {
  test('pins the codes a harness scripts against', () => {
    assert.deepStrictEqual(BUDGET_EXIT, { GO: 0, ABORT: 1, UNKNOWN: 2 })
  })
})

suite('budget: fmtMin', () => {
  test('renders sub-hour durations in minutes and longer ones in h m', () => {
    assert.strictEqual(fmtMin(45), '45m')
    assert.strictEqual(fmtMin(90), '1h 30m')
    assert.strictEqual(fmtMin(-5), '0m')
  })
})
