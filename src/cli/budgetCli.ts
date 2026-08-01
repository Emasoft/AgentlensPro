// src/cli/budgetCli.ts — `agentlenspro budget`: can this timed run finish before the
// rate-limit window does, and abort it the moment the answer flips to no.
//
// WHY this exists as a command instead of a documented recipe: the recipe it replaces made the
// caller hand-roll a node one-liner around get_window_eta AND hand-update the minutes still to
// go at every checkpoint. Both are error-prone in the direction that costs money — a stale
// "90 minutes left" keeps saying GO for the whole run, which is exactly the case the check was
// supposed to catch. Here the deadline is fixed once at t0 and the remaining time is derived,
// so the answer sharpens by itself as the run proceeds.
//
// Projection is on COST, not tokens: Anthropic meters the 5h/7d windows by cost (cache-read is
// weighted ~0.1x), so a token-based projection is wrong. That arithmetic lives in the
// get_window_eta tool; this command only decides and reports.

import { init, callTool } from './cliCore'
import { sleep } from './cliCore'
import { getSubscriptionUsage, type SubscriptionUsage } from '../subscriptionUsage'
import { fetchBurnRisk } from './diagnosticsCli'
import { LineLog, clampFlushMs, DEFAULT_FLUSH_MS } from './lineLog'
import { numArg, strArg, clamp } from './argHelpers'
import { UsageError, EXIT } from './cliErrors'
import { whoIsBurning, formatCulprits } from './attribution'

/** Sink for every line this command prints, so `--log` mirrors stdout exactly — a log that
 *  differs from what the operator saw is worse than no log. Threaded as a parameter rather than
 *  held in a module variable: a mutable global emitter is not reentrant, and restoring it in a
 *  `finally` restores a fresh closure rather than the caller's. */
export type Say = (line: string) => void

export type BudgetVerdict = 'GO' | 'TIGHT' | 'NO_GO' | 'UNKNOWN'

/** One window's slice of the get_window_eta payload (fields verified against the live tool). */
export interface EtaWindow {
  label?: string
  willExhaustAtCurrentRate?: boolean
  etaMinutes?: number | null
  etaHuman?: string | null
  fillPct?: number
  costPerMin?: number
  capacity?: { source?: string }
}

export interface EtaPayload {
  fiveHour?: EtaWindow
  sevenDay?: EtaWindow
  bindingWindow?: string
}

export interface BudgetDecision {
  verdict: BudgetVerdict
  reason: string
  etaMinutes: number | null
  remainingMin: number
}

/** Budget's verdict codes ARE the shared CLI contract — aliased, not redefined, so the two can
 *  never disagree about what 1 means. `USAGE` (64) is added by the shared table. */
export const BUDGET_EXIT = { GO: EXIT.OK, ABORT: EXIT.ABORT, UNKNOWN: EXIT.UNKNOWN } as const
export const MIN_BUDGET_INTERVAL_SEC = 10
export const MAX_BUDGET_INTERVAL_SEC = 900

/** PURE decision core — no I/O, so the thresholds are unit-testable against real payloads.
 *
 *  The order of the branches is load-bearing. `willExhaustAtCurrentRate === false` wins over
 *  everything because a rolling window whose steady-state fill plateaus below the cap has no
 *  exhaustion time at all — treating a null ETA there as "unknown" would stall every healthy
 *  run. A null ETA with exhaustion PREDICTED is the opposite case: capacity is uncalibrated, so
 *  no projection exists and we say UNKNOWN rather than invent a number. */
export function decideBudget(w: EtaWindow | undefined, remainingMin: number, margin: number): BudgetDecision {
  const m = Math.max(1, margin)
  if (!w) return { verdict: 'UNKNOWN', reason: 'no such window in the ETA payload', etaMinutes: null, remainingMin }
  if (w.willExhaustAtCurrentRate === false) {
    return { verdict: 'GO', reason: "won't exhaust at this rate (rolling fill plateaus below the cap)", etaMinutes: null, remainingMin }
  }
  const eta = typeof w.etaMinutes === 'number' ? w.etaMinutes : null
  if (eta === null) {
    const src = w.capacity && w.capacity.source
    return {
      verdict: 'UNKNOWN',
      reason: src ? `no ETA projected (capacity source: ${src})` : 'no ETA projected — window capacity is not calibrated',
      etaMinutes: null,
      remainingMin,
    }
  }
  if (eta < remainingMin) {
    return { verdict: 'NO_GO', reason: `window exhausts in ${fmtMin(eta)} < ${fmtMin(remainingMin)} of run left`, etaMinutes: eta, remainingMin }
  }
  if (eta < remainingMin * m) {
    return { verdict: 'TIGHT', reason: `window exhausts in ${fmtMin(eta)} — under the ${m}x margin on ${fmtMin(remainingMin)} of run left`, etaMinutes: eta, remainingMin }
  }
  return { verdict: 'GO', reason: `window exhausts in ${fmtMin(eta)}, ${(eta / remainingMin).toFixed(1)}x the ${fmtMin(remainingMin)} of run left`, etaMinutes: eta, remainingMin }
}

/** The authoritative utilization for the window `budget` was asked about, taken from Anthropic's own
 *  figures rather than from our local capacity model.
 *
 *  WHY THIS EXISTS. The local projection divides consumption by a CAPACITY, and when no capacity has
 *  been observed for this account it falls back to a same-plan proxy borrowed from a different one.
 *  On 2026-08-01 that proxy put the 7d cap at $12,282 against $728 consumed and reported the window
 *  5.9% full, so `budget` answered GO — while the account was actually at 37%, and a stale cache was
 *  simultaneously claiming 96%. Three numbers, no agreement, and the verdict rode the one nobody had
 *  checked. Printing the account's own figure next to the projection makes that disagreement visible
 *  instead of leaving the reader to pick a number on faith. */
export function officialPct(u: SubscriptionUsage | null, windowKey: string): number | null {
  if (!u) return null
  const want = windowKey === '5h' ? (k: string) => k === 'session' : (k: string) => k.startsWith('weekly')
  const pcts = u.limits.filter(l => want(l.kind)).map(l => l.percent).filter(p => typeof p === 'number' && isFinite(p))
  // The BINDING bucket is the fullest one: `weekly_all` and a per-model `weekly_scoped` are separate
  // caps and either can be the one that stops you, so the max is the honest summary, not the mean.
  return pcts.length ? Math.max(...pcts) : null
}

/** Downgrade a projection-based verdict when the account's OWN numbers contradict it.
 *
 *  Applied ONLY to a reading that is live and account-verified — a stale or unattributed one is
 *  exactly what caused this bug, and acting on it would repeat the mistake in the other direction. */
export function applyOfficial(d: BudgetDecision, u: SubscriptionUsage | null, pct: number | null): BudgetDecision {
  if (!u || u.stale || u.accountVerified !== 'yes' || pct === null) return d
  const worse = (v: BudgetVerdict): BudgetDecision =>
    ({ ...d, verdict: v, reason: `${d.reason}; but the account's own figure says the window is ${pct}% full` })
  if (pct >= 95 && d.verdict !== 'NO_GO') return worse('NO_GO')
  if (pct >= 80 && (d.verdict === 'GO' || d.verdict === 'UNKNOWN')) return worse('TIGHT')
  return d
}

/** The line printed alongside every verdict: what Anthropic says, for WHICH account, and how much
 *  that statement can be trusted. Never silently omitted — an absent line would read as agreement. */
export function officialLine(u: SubscriptionUsage | null, windowKey: string): string {
  if (!u) return '[budget] official usage: UNAVAILABLE (no readable credential) — verdict rests on the local projection alone'
  const pct = officialPct(u, windowKey)
  const who = u.accountLabel ?? u.accountUuid?.slice(0, 8) ?? 'unidentified account'
  const shown = pct === null ? 'n/a' : `${pct}%`
  if (u.stale || u.accountVerified !== 'yes') {
    const why = u.accountVerified === 'no' ? 'belongs to a DIFFERENT account'
      : u.accountVerified === 'unknown' ? 'could not be attributed to the current account'
        : `is ${Math.round(u.ageSeconds / 3600)}h old`
    return `[budget] official usage: NOT USABLE — the cached reading ${why} (${u.reason}); ignoring it for the verdict`
  }
  return `[budget] official usage (${who}): ${windowKey} ${shown} full · 5h ${fmtPct(officialPct(u, '5h'))} · 7d ${fmtPct(officialPct(u, '7d'))} [Anthropic's own numbers, live]`
}

function fmtPct(p: number | null): string { return p === null ? 'n/a' : `${p}%` }

export function fmtMin(min: number): string {
  const t = Math.max(0, Math.round(min))
  if (t < 60) return `${t}m`
  return `${Math.floor(t / 60)}h ${t % 60}m`
}

/** Resolve which window binds. `binding` follows the payload's own choice, which is the string
 *  "5h" | "7d" — NOT an object; reading it as one silently yields undefined and would make every
 *  run look unprojectable. */
export function pickWindow(p: EtaPayload, want: string): { key: string; win: EtaWindow | undefined } {
  const key = want === 'binding' ? (p.bindingWindow || '5h') : want
  return { key, win: key === '7d' ? p.sevenDay : p.fiveHour }
}

export interface BudgetOptions {
  minutes: number
  window: string
  margin: number
  watch: boolean
  intervalSec: number
  json: boolean
  withRisks: boolean
  rateWindowMin?: number
  log: string | null
  flushMs: number
}

export function parseBudgetArgs(argv: string[]): BudgetOptions {
  const o: BudgetOptions = {
    minutes: 0, window: 'binding', margin: 2, watch: false, intervalSec: 60, json: false, withRisks: false,
    log: null, flushMs: DEFAULT_FLUSH_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--minutes' || a === '-m') o.minutes = numArg(argv[++i], '--minutes')
    else if (a === '--hours') o.minutes = numArg(argv[++i], '--hours') * 60
    else if (a === '--window' || a === '-w') {
      const v = argv[++i]
      if (v !== '5h' && v !== '7d' && v !== 'binding') throw new UsageError(`--window expects 5h|7d|binding, got "${v}"`)
      o.window = v
    } else if (a === '--margin') o.margin = numArg(argv[++i], '--margin')
    else if (a === '--rate-window-min') o.rateWindowMin = numArg(argv[++i], '--rate-window-min')
    else if (a === '--watch') {
      o.watch = true
      const next = argv[i + 1]
      if (next && /^\d+$/.test(next)) { o.intervalSec = Number(next); i++ }
    } else if (a === '--with-risks') o.withRisks = true
    else if (a === '--json') o.json = true
    else if (a === '--log') o.log = strArg(argv[++i], '--log')
    else if (a === '--flush-ms') o.flushMs = clampFlushMs(numArg(argv[++i], '--flush-ms'))
    else throw new UsageError(`unknown budget flag "${a}" — see: agentlenspro budget --help`)
  }
  if (!(o.minutes > 0)) throw new UsageError('budget needs the run length: --minutes N (or --hours H)')
  o.intervalSec = clamp(Math.round(o.intervalSec), MIN_BUDGET_INTERVAL_SEC, MAX_BUDGET_INTERVAL_SEC)
  return o
}

async function fetchEta(rateWindowMin: number | undefined): Promise<EtaPayload> {
  const args: Record<string, unknown> = {}
  if (rateWindowMin !== undefined) args.rate_window_min = rateWindowMin
  const r = await callTool('get_window_eta', args, true)
  return (typeof r === 'string' ? JSON.parse(r) : r) as EtaPayload
}

export const BUDGET_USAGE = `agentlenspro budget --minutes N [options]

Answers ONE question before a timed batch: will the rate-limit window outlast the run?
Projected on COST (how Anthropic meters the windows), never on raw tokens.

  --minutes N | --hours H   how long the run needs (required)
  --window 5h|7d|binding    which window must survive it (default: binding — the payload's own)
  --margin M                GO needs ETA >= remaining x M (default: 2)
  --watch [SEC]             keep watching (default 60s); remaining time derives from t0, so the
                            check sharpens by itself — exits 1 the moment the verdict is NO-GO
  --with-risks              also emit [burn-guard] risk transitions on the same stream, so ONE
                            Monitor covers both the budget and the realtime guard
  --rate-window-min N       minutes of history the $/min rate is measured over (default 30)
  --json                    machine-readable one-shot result
  --log <file>              also append every emitted line to a file
  --flush-ms N              coalesce log writes for N ms (default 1000, max 60000, 0 = write
                            through) — spares the SSD on a long watch; at most N ms of lines are
                            lost on an unclean kill, and a line is never torn

exit: 0 GO/TIGHT (or watch ran the full duration) · 1 NO-GO (abort the run) · 2 cannot project

  agentlenspro budget --minutes 90                       # preflight before launching
  agentlenspro budget --hours 2 --watch 120 --with-risks # arm in a Monitor for the whole run`

/** One-shot: decide once, print one line (or JSON), exit with the verdict's code. */
/** Anthropic's own utilization for the CURRENT account. `allowKeychain` because `budget` is a
 *  command the user typed and is watching: the opt-in exists to stop a status line or a hook from
 *  triggering a keychain prompt storm, which is not this call site. Without it, macOS never
 *  refreshes the reading at all and the cache silently ages into a wrong answer. */
async function fetchOfficial(): Promise<SubscriptionUsage | null> {
  try { return await getSubscriptionUsage({ allowKeychain: true }) } catch { return null }
}

async function runOnce(o: BudgetOptions, say: Say): Promise<number> {
  await init()
  const [eta, official] = await Promise.all([fetchEta(o.rateWindowMin), fetchOfficial()])
  const { key, win } = pickWindow(eta, o.window)
  const pct = officialPct(official, key)
  const d = applyOfficial(decideBudget(win, o.minutes, o.margin), official, pct)
  if (o.json) {
    say(JSON.stringify({
      verdict: d.verdict, window: key, runMinutes: o.minutes, margin: o.margin,
      etaMinutes: d.etaMinutes, reason: d.reason,
      capacitySource: (win && win.capacity && win.capacity.source) || null,
      costPerMin: (win && win.costPerMin) ?? null,
      fillPct: (win && win.fillPct) ?? null,
      // The projection's own fill (`fillPct`) and the account's own figure are DIFFERENT numbers
      // from different sources; emitting both under distinct keys is what lets a consumer notice
      // they disagree instead of trusting whichever one it happened to read.
      official: official ? {
        account: official.accountLabel ?? official.accountUuid,
        verified: official.accountVerified,
        stale: official.stale,
        ageSeconds: official.ageSeconds,
        reason: official.reason,
        windowPct: pct,
        fiveHourPct: officialPct(official, '5h'),
        sevenDayPct: officialPct(official, '7d'),
      } : null,
    }, null, 2))
  } else {
    const cap = win && win.capacity && win.capacity.source
    const capNote = cap === 'same-plan-proxy' ? ' [capacity is a same-plan proxy — treat the boundary as soft]' : ''
    say(officialLine(official, key))
    say(`[budget] ${d.verdict} — ${key} window vs ${fmtMin(o.minutes)} run: ${d.reason}${capNote}`)
  }
  return d.verdict === 'NO_GO' ? BUDGET_EXIT.ABORT : d.verdict === 'UNKNOWN' ? BUDGET_EXIT.UNKNOWN : BUDGET_EXIT.GO
}

/** Watch: poll until the run's own deadline passes, printing one line per verdict TRANSITION so
 *  the stream stays Monitor-friendly (each line = one notification). Exits 1 on NO-GO so a
 *  harness can kill the batch on a non-zero child.
 *
 *  A server outage does NOT abort: being unable to measure is not evidence of exhaustion, and
 *  killing a legitimate run on a transient blip is the worse failure. The outage is reported
 *  once per episode so the silence is never mistaken for a clean bill of health. */
async function runWatch(o: BudgetOptions, say: Say): Promise<number> {
  await init()
  const t0 = Date.now()
  const deadline = t0 + o.minutes * 60_000
  say(`[budget] armed — ${fmtMin(o.minutes)} run vs the ${o.window} window, margin ${o.margin}x, polling every ${o.intervalSec}s (silent unless the verdict changes)`)
  say(officialLine(await fetchOfficial(), o.window === 'binding' ? '7d' : o.window))
  let lastVerdict: BudgetVerdict | null = null
  let down = false
  const riskActive = new Set<string>()
  for (;;) {
    const remainingMin = (deadline - Date.now()) / 60_000
    if (remainingMin <= 0) {
      say(`[budget] run window elapsed (${fmtMin(o.minutes)}) — watch complete, never went NO-GO`)
      return BUDGET_EXIT.GO
    }
    try {
      const [eta, official] = await Promise.all([fetchEta(o.rateWindowMin), fetchOfficial()])
      if (down) { say('[budget] server back — resuming'); down = false }
      const { key, win } = pickWindow(eta, o.window)
      // Re-read the official figure every poll, not once at arm time: a long watch is exactly the
      // situation where the window fills underneath a verdict that was decided while it was empty.
      const d = applyOfficial(decideBudget(win, remainingMin, o.margin), official, officialPct(official, key))
      if (d.verdict === 'NO_GO') {
        // An abort without a culprit forces the operator to start an investigation at the worst
        // possible moment. fiveMin, not oneMin: an abort is about a SUSTAINED drain, and the
        // one-minute window would let a single fat turn misname the cause.
        const who = formatCulprits(await whoIsBurning('fiveMin'))
        say(`[budget] ABORT — ${key}: ${d.reason}${who ? ` — ${who}` : ''}`)
        return BUDGET_EXIT.ABORT
      }
      if (d.verdict !== lastVerdict) {
        // The reason already carries both numbers; appending the remaining time again read as
        // "…of run left (0m of run left)".
        const who = d.verdict === 'TIGHT' ? formatCulprits(await whoIsBurning('fiveMin')) : ''
        say(`[budget] ${d.verdict} — ${key}: ${d.reason}${who ? ` — ${who}` : ''}`)
        lastVerdict = d.verdict
      }
    } catch (e) {
      if (!down) { say(`[budget] server unreachable: ${(e as Error).message} — still watching, NOT aborting`); down = true }
    }
    if (o.withRisks) await emitRiskTransitions(riskActive, say)
    await sleep(o.intervalSec * 1000)
  }
}

/** Fold the realtime burn guard into the same stdout stream so one Monitor covers both. Same
 *  transition-only contract as `--guard`; a risk feed failure is swallowed because the budget
 *  verdict is the load-bearing signal here and must not be lost to a risk-endpoint hiccup. */
async function emitRiskTransitions(active: Set<string>, say: Say): Promise<void> {
  try {
    const rep = await fetchBurnRisk()
    for (const r of rep.risks || []) {
      if (r.active && !active.has(r.code)) { say(`[burn-guard] ${r.code}: ${r.detail}`); active.add(r.code) }
      else if (!r.active && active.has(r.code)) { say(`[burn-guard] ${r.code} cleared`); active.delete(r.code) }
    }
  } catch { /* risk feed is advisory here — the budget verdict above is the signal that matters */ }
}

export async function runBudgetCli(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') { console.log(BUDGET_USAGE); return 0 }
  let log: LineLog | null = null
  try {
    const o = parseBudgetArgs(argv)
    if (o.log) log = new LineLog(o.log, { flushMs: o.flushMs })
    const sink = log
    const say: Say = (line: string) => { console.log(line); if (sink) sink.write(line) }
    return await (o.watch ? runWatch(o, say) : runOnce(o, say))
  } catch (e) {
    // Mirror the failure onto STDOUT before rethrowing. The CLI convention puts `FAIL:` on
    // stderr, but Monitor only turns STDOUT lines into events — so a mistyped flag or an
    // unreachable server at arm time would produce a watch that emits NOTHING and ends, which
    // is indistinguishable from "armed and all quiet". Silence must never look like success.
    const msg = `[budget] FAIL: ${(e as Error).message}`
    console.log(msg)
    if (log) log.write(msg)
    if (e instanceof UsageError) {
      // EX_USAGE, not a throw: the shim maps every throw to exit 1, which is this command's ABORT
      // signal. A mistyped flag must never look to a harness like a legitimate abort.
      console.error(`FAIL: ${e.message}`)
      return EXIT.USAGE
    }
    throw e
  } finally {
    // The buffered tail must reach disk on EVERY exit path, the throw above included.
    if (log) log.close()
  }
}
