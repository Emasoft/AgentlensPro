import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  calibrateFromStopFailure, isRateLimitStopFailure, ROLLOVER_LOOKBACK_MS,
  type CalibrationDeps,
} from '../capacityCalibration'
import {
  loadBurnConfig, computeWindowBudget, computeAccountWindowBudgets, burnConfigPath,
  DEFAULT_THRESHOLDS, type BurnConfig, type ConsumptionEvent,
} from '../burnMonitor'
import type { HookEventRecord } from '../hookEventStore'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// P5 window auto-calibration — REAL tests: the calibration writes a real burn-config.json in a
// per-test temp HOME and reads it back through the real loadBurnConfig; computeWindowBudget then
// consumes the observed capacity. Nothing under test is mocked — inputs are plain data fixtures.

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'al-cal-'))
}

function stopFailure(over: Partial<HookEventRecord> & { error?: string } = {}): HookEventRecord {
  const { error, ...rest } = over
  return {
    ts: NOW,
    ev: 'StopFailure',
    session: 'sess-1',
    payload: {
      hook_event_name: 'StopFailure', session_id: 'sess-1', cwd: '/ws/proj',
      error: error ?? '429 rate_limit_error: exceeded',
    },
    ...rest,
  }
}

function ev(over: Partial<ConsumptionEvent> = {}): ConsumptionEvent {
  return {
    ts: NOW - HOUR, sessionId: 'sess-1', accountUuid: 'acct-A',
    costUsd: 0.5, tokens: 100_000, source: 'statusline', ...over,
  }
}

function card(over: Partial<SessionSummaryCard> = {}): SessionSummaryCard {
  return {
    sessionId: 'sess-1', traceId: 't1', source: 'claude_code', dataSource: 'log',
    workspace: '/ws/proj', userRequest: 'do a thing', model: 'claude-sonnet-4-5',
    turns: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreateTokens: 0,
    cacheHitRate: 0, durationMs: 1000, startTime: new Date(NOW - 1000).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
    toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0, outcome: 'text_response',
    timeline: [], backgroundSpans: [], loopSignals: [], accountId: 'acct-A', ...over,
  }
}

function deps(home: string, over: Partial<CalibrationDeps> = {}): CalibrationDeps {
  return {
    // A clean 2h-old window: 3 events, 300k tokens, $1.50 — nothing near the 5h boundary.
    events: [
      ev({ ts: NOW - 2 * HOUR }),
      ev({ ts: NOW - 1 * HOUR }),
      ev({ ts: NOW - 60_000 }),
    ],
    sessions: [card()],
    currentAccountUuid: null,
    env: {},
    homeDir: home,
    ...over,
  }
}

function readConfigFile(home: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(burnConfigPath({}, home), 'utf8')) as Record<string, unknown>
}

suite('capacityCalibration — rate-limit classification', () => {
  test('recognizes the rate-limit-class StopFailure error signatures', () => {
    for (const err of [
      '429 rate_limit_error: exceeded',
      'usage limit reached — resets 6pm',
      'Rate limit exceeded, try again later',
      'overloaded_error: Overloaded',
      'HTTP 529: too many requests',
      'you have hit your usage quota',
    ]) {
      assert.strictEqual(isRateLimitStopFailure({ error: err }), true, `should match: ${err}`)
    }
  })

  test('rejects non-rate-limit turn deaths (they carry no capacity information)', () => {
    for (const err of ['connection reset by peer', 'authentication_error: invalid api key', 'ETIMEDOUT']) {
      assert.strictEqual(isRateLimitStopFailure({ error: err }), false, `should NOT match: ${err}`)
    }
    assert.strictEqual(isRateLimitStopFailure({}), false, 'no error field = no classification')
    // The signature must live in a dedicated error field — a cwd/prompt mentioning "rate limit"
    // must not classify (that is content, not an error).
    assert.strictEqual(isRateLimitStopFailure({ cwd: '/ws/rate-limit-tool' }), false)
  })
})

suite('capacityCalibration — calibrate + persist (real fs)', () => {
  test('a rate-limit StopFailure persists the observed 5h/7d capacity for the account', () => {
    const home = tmpHome()
    const out = calibrateFromStopFailure(stopFailure(), deps(home))
    assert.strictEqual(out.calibrated, true, out.reason)
    assert.strictEqual(out.accountUuid, 'acct-A')

    const cfg = loadBurnConfig({}, home)
    assert.strictEqual(cfg.capacitySource, 'observed')
    const obs = cfg.observed['acct-A']
    assert.ok(obs, 'observed entry for acct-A must exist')
    assert.strictEqual(obs.window5hTokens, 300_000)          // the 3 events inside the window
    assert.strictEqual(obs.window7dTokens, 300_000)          // trailing-7d floor = same events here
    assert.strictEqual(obs.window5hCostUsd, 1.5)
    assert.strictEqual(obs.observedAt, new Date(NOW).toISOString())
  })

  test('computeWindowBudget consumes the observed capacity: pct + time-to-exhaustion with zero manual config', () => {
    const home = tmpHome()
    const d = deps(home)
    assert.strictEqual(calibrateFromStopFailure(stopFailure(), d).calibrated, true)
    const cfg = loadBurnConfig({}, home)

    // The same account keeps burning in a NEW window: 150k consumed of the observed 300k cap.
    const later = NOW + 6 * HOUR
    const newEvents = [ev({ ts: later - 30 * 60_000, tokens: 150_000, costUsd: 0.75 })]
    const budget = computeWindowBudget(newEvents, cfg, 1000, later, 'acct-A')
    assert.strictEqual(budget.capacitySource, 'observed')
    assert.strictEqual(budget.capacityObservedAt, new Date(NOW).toISOString())
    assert.strictEqual(budget.fiveHour.capacityTokens, 300_000)
    assert.strictEqual(budget.fiveHour.pctConsumed, 50)
    // 150k remaining at 1000 tok/min → 150 minutes to exhaustion. The projection is ALIVE
    // with zero manual config — the whole point of P5.
    assert.strictEqual(budget.fiveHour.minutesToExhaustion, 150)
    assert.ok(budget.note?.includes('auto-calibrated'), 'note must state the capacity is observed')

    // The per-account splitter passes the account through too.
    const perAccount = computeAccountWindowBudgets(newEvents, cfg, later)
    assert.strictEqual(perAccount[0].budget.capacitySource, 'observed')
  })

  test('a second observation with LOWER consumption does not lower the observed capacity', () => {
    const home = tmpHome()
    assert.strictEqual(calibrateFromStopFailure(stopFailure(), deps(home)).calibrated, true)
    const before = readConfigFile(home)

    // A later stall after a window that consumed only 50k — proves nothing about the cap.
    const later = NOW + 12 * HOUR
    const out = calibrateFromStopFailure(
      stopFailure({ ts: later }),
      deps(home, { events: [ev({ ts: later - HOUR, tokens: 50_000, costUsd: 0.2 })] }),
    )
    assert.strictEqual(out.calibrated, false)
    assert.ok(out.reason.includes('never lowers'), out.reason)
    assert.deepStrictEqual(readConfigFile(home), before, 'the config file must be untouched')
  })

  test('a later observation with HIGHER consumption raises the capacity and re-dates it', () => {
    const home = tmpHome()
    assert.strictEqual(calibrateFromStopFailure(stopFailure(), deps(home)).calibrated, true)

    const later = NOW + 12 * HOUR
    const out = calibrateFromStopFailure(
      stopFailure({ ts: later }),
      deps(home, { events: [ev({ ts: later - HOUR, tokens: 900_000, costUsd: 4 })] }),
    )
    assert.strictEqual(out.calibrated, true, out.reason)
    const obs = loadBurnConfig({}, home).observed['acct-A']
    assert.strictEqual(obs.window5hTokens, 900_000)
    // The trailing-7d floor measured 900k this time (> the prior 300k) — ratchets up too.
    assert.strictEqual(obs.window7dTokens, 900_000)
    assert.strictEqual(obs.observedAt, new Date(later).toISOString(), 'the date follows the RAISING observation')
  })

  test('user-configured capacity is NEVER overwritten (file cap)', () => {
    const home = tmpHome()
    const p = burnConfigPath({}, home)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ window5hTokens: 123_456 }))
    const out = calibrateFromStopFailure(stopFailure(), deps(home))
    assert.strictEqual(out.calibrated, false)
    assert.ok(out.reason.includes('user-configured'), out.reason)
    assert.deepStrictEqual(readConfigFile(home), { window5hTokens: 123_456 }, 'file must be byte-identical in content')
  })

  test('user-configured capacity is NEVER overwritten (env cap)', () => {
    const home = tmpHome()
    const out = calibrateFromStopFailure(
      stopFailure(),
      deps(home, { env: { AGENTLENS_WINDOW_5H_TOKENS: '5000000' } }),
    )
    assert.strictEqual(out.calibrated, false)
    assert.ok(out.reason.includes('user-configured'), out.reason)
    assert.strictEqual(fs.existsSync(burnConfigPath({}, home)), false, 'no file may be created')
  })

  test('a natural 5h window rollover does NOT calibrate (consumption straddles the boundary)', () => {
    const home = tmpHome()
    // The account was already burning just before (stall − 5h): its real window started >5h ago
    // and rolled — the rolling 5h sum mixes two windows and measures elapsed time, not the cap.
    const out = calibrateFromStopFailure(stopFailure(), deps(home, {
      events: [
        ev({ ts: NOW - 5 * HOUR - Math.floor(ROLLOVER_LOOKBACK_MS / 2) }),   // inside the lookback margin
        ev({ ts: NOW - 4 * HOUR }),
        ev({ ts: NOW - 1 * HOUR }),
      ],
    }))
    assert.strictEqual(out.calibrated, false)
    assert.ok(out.reason.includes('rolled'), out.reason)
    assert.strictEqual(fs.existsSync(burnConfigPath({}, home)), false, 'no observed capacity may be written')
  })

  test('a non-rate-limit StopFailure does not calibrate', () => {
    const home = tmpHome()
    const out = calibrateFromStopFailure(stopFailure({ error: 'connection reset by peer' }), deps(home))
    assert.strictEqual(out.calibrated, false)
    assert.strictEqual(fs.existsSync(burnConfigPath({}, home)), false)
  })

  test('resolves the account from the stalled session card, falling back to the current account', () => {
    const home = tmpHome()
    // The stalled session is attributed to acct-B — calibrate B, not the current account A.
    const out = calibrateFromStopFailure(stopFailure(), deps(home, {
      sessions: [card({ accountId: 'acct-B' })],
      events: [ev({ ts: NOW - HOUR, accountUuid: 'acct-B', tokens: 42_000 })],
      currentAccountUuid: 'acct-A',
    }))
    assert.strictEqual(out.calibrated, true, out.reason)
    assert.strictEqual(out.accountUuid, 'acct-B')

    // No card for the stalled session → the live account is the best key we have.
    const home2 = tmpHome()
    const out2 = calibrateFromStopFailure(stopFailure({ session: 'sess-unknown' }), deps(home2, {
      sessions: [],
      currentAccountUuid: 'acct-A',
    }))
    assert.strictEqual(out2.calibrated, true, out2.reason)
    assert.strictEqual(out2.accountUuid, 'acct-A')

    // Neither resolvable → skip (an observation with no account key would pool rotated accounts).
    const home3 = tmpHome()
    const out3 = calibrateFromStopFailure(stopFailure({ session: 'sess-unknown' }), deps(home3, {
      sessions: [], currentAccountUuid: null,
    }))
    assert.strictEqual(out3.calibrated, false)
  })

  test('an existing-but-unparseable config is refused, never replaced', () => {
    const home = tmpHome()
    const p = burnConfigPath({}, home)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{ this is not json')
    const out = calibrateFromStopFailure(stopFailure(), deps(home))
    assert.strictEqual(out.calibrated, false)
    assert.ok(out.reason.includes('unparseable'), out.reason)
    assert.strictEqual(fs.readFileSync(p, 'utf8'), '{ this is not json', 'the corrupt file must be preserved verbatim')
  })

  test('unrelated config fields (thresholds, notify) survive a calibration write verbatim', () => {
    const home = tmpHome()
    const p = burnConfigPath({}, home)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // notify + thresholds do NOT set a capacity, so capacitySource stays 'none' and calibration runs.
    fs.writeFileSync(p, JSON.stringify({ notify: true, thresholds: { windowPct: 70 } }))
    const out = calibrateFromStopFailure(stopFailure(), deps(home))
    assert.strictEqual(out.calibrated, true, out.reason)
    const raw = readConfigFile(home)
    assert.strictEqual(raw.notify, true)
    assert.deepStrictEqual(raw.thresholds, { windowPct: 70 })
    const cfg = loadBurnConfig({}, home)
    assert.strictEqual(cfg.notify, true)
    assert.strictEqual(cfg.thresholds.windowPct, 70)
    assert.strictEqual(cfg.observed['acct-A'].window5hTokens, 300_000)
  })
})

suite('burnMonitor — computeWindowBudget with observed capacity (P5 consumption rules)', () => {
  function cfgWith(observed: BurnConfig['observed'], over: Partial<BurnConfig> = {}): BurnConfig {
    return {
      window5hTokens: null, window7dTokens: null, window5hCostUsd: null, window7dCostUsd: null,
      capacitySource: Object.keys(observed).length > 0 ? 'observed' : 'none',
      observed, notify: false, thresholds: { ...DEFAULT_THRESHOLDS }, ...over,
    }
  }
  const OBS = { window5hTokens: 200_000, window7dTokens: 1_000_000, window5hCostUsd: null, window7dCostUsd: null, observedAt: '2026-07-10T00:00:00.000Z' }

  test('a manual cap always outranks an observed one (never clobbered even at read time)', () => {
    const cfg = cfgWith({ 'acct-A': OBS }, { window5hTokens: 999_999, capacitySource: 'config' })
    const budget = computeWindowBudget([ev({ ts: NOW - 1000 })], cfg, 0, NOW, 'acct-A')
    assert.strictEqual(budget.capacitySource, 'config')
    assert.strictEqual(budget.fiveHour.capacityTokens, 999_999)
    assert.strictEqual(budget.capacityObservedAt, null)
  })

  test('an uncalibrated account and the unknown bucket honestly report capacitySource none', () => {
    const cfg = cfgWith({ 'acct-A': OBS })
    const other = computeWindowBudget([ev({ ts: NOW - 1000, accountUuid: 'acct-B' })], cfg, 0, NOW, 'acct-B')
    assert.strictEqual(other.capacitySource, 'none')
    assert.strictEqual(other.fiveHour.pctConsumed, null)
    const unknown = computeWindowBudget([ev({ ts: NOW - 1000, accountUuid: undefined })], cfg, 0, NOW, null)
    assert.strictEqual(unknown.capacitySource, 'none')
  })

  test('the machine-wide pooled budget uses observed capacity only on a single-calibrated-account machine', () => {
    // One calibrated account → the pooled events ARE that account's (modulo unknown) — apply it.
    const one = computeWindowBudget([ev({ ts: NOW - 1000, tokens: 100_000 })], cfgWith({ 'acct-A': OBS }), 0, NOW)
    assert.strictEqual(one.capacitySource, 'observed')
    assert.strictEqual(one.fiveHour.capacityTokens, 200_000)
    assert.strictEqual(one.fiveHour.pctConsumed, 50)
    // Two calibrated accounts → pooled consumption has no single cap; guessing would over-promise.
    const two = computeWindowBudget(
      [ev({ ts: NOW - 1000 })],
      cfgWith({ 'acct-A': OBS, 'acct-B': { ...OBS, window5hTokens: 50_000 } }), 0, NOW)
    assert.strictEqual(two.capacitySource, 'none')
    assert.strictEqual(two.fiveHour.capacityTokens, null)
  })
})
