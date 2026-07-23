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
import { fetchBurnRisk } from './diagnosticsCli'
import { LineLog, clampFlushMs, DEFAULT_FLUSH_MS } from './lineLog'

/** Every line this command prints goes through here, so `--log` mirrors stdout exactly — a log
 *  that differs from what the operator saw is worse than no log. Rebound in runBudgetCli. */
let say: (line: string) => void = (line: string) => console.log(line)

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

export const BUDGET_EXIT = { GO: 0, ABORT: 1, UNKNOWN: 2 } as const

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
    if (a === '--minutes' || a === '-m') o.minutes = num(argv[++i], '--minutes')
    else if (a === '--hours') o.minutes = num(argv[++i], '--hours') * 60
    else if (a === '--window' || a === '-w') {
      const v = argv[++i]
      if (v !== '5h' && v !== '7d' && v !== 'binding') throw new Error(`--window expects 5h|7d|binding, got "${v}"`)
      o.window = v
    } else if (a === '--margin') o.margin = num(argv[++i], '--margin')
    else if (a === '--rate-window-min') o.rateWindowMin = num(argv[++i], '--rate-window-min')
    else if (a === '--watch') {
      o.watch = true
      const next = argv[i + 1]
      if (next && /^\d+$/.test(next)) { o.intervalSec = Number(next); i++ }
    } else if (a === '--with-risks') o.withRisks = true
    else if (a === '--json') o.json = true
    else if (a === '--log') {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error('--log expects a file path')
      o.log = v
    } else if (a === '--flush-ms') o.flushMs = clampFlushMs(num(argv[++i], '--flush-ms'))
    else throw new Error(`unknown budget flag "${a}" — see: agentlenspro budget --help`)
  }
  if (!(o.minutes > 0)) throw new Error('budget needs the run length: --minutes N (or --hours H)')
  o.intervalSec = Math.max(10, Math.min(900, o.intervalSec))
  return o
}

function num(v: string | undefined, flag: string): number {
  const n = Number(v)
  if (!v || Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${v ?? ''}"`)
  return n
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
async function runOnce(o: BudgetOptions): Promise<number> {
  await init()
  const eta = await fetchEta(o.rateWindowMin)
  const { key, win } = pickWindow(eta, o.window)
  const d = decideBudget(win, o.minutes, o.margin)
  if (o.json) {
    say(JSON.stringify({
      verdict: d.verdict, window: key, runMinutes: o.minutes, margin: o.margin,
      etaMinutes: d.etaMinutes, reason: d.reason,
      capacitySource: (win && win.capacity && win.capacity.source) || null,
      costPerMin: (win && win.costPerMin) ?? null,
      fillPct: (win && win.fillPct) ?? null,
    }, null, 2))
  } else {
    const cap = win && win.capacity && win.capacity.source
    const capNote = cap === 'same-plan-proxy' ? ' [capacity is a same-plan proxy — treat the boundary as soft]' : ''
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
async function runWatch(o: BudgetOptions): Promise<number> {
  await init()
  const t0 = Date.now()
  const deadline = t0 + o.minutes * 60_000
  say(`[budget] armed — ${fmtMin(o.minutes)} run vs the ${o.window} window, margin ${o.margin}x, polling every ${o.intervalSec}s (silent unless the verdict changes)`)
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
      const eta = await fetchEta(o.rateWindowMin)
      if (down) { say('[budget] server back — resuming'); down = false }
      const { key, win } = pickWindow(eta, o.window)
      const d = decideBudget(win, remainingMin, o.margin)
      if (d.verdict === 'NO_GO') {
        say(`[budget] ABORT — ${key}: ${d.reason}`)
        return BUDGET_EXIT.ABORT
      }
      if (d.verdict !== lastVerdict) {
        // The reason already carries both numbers; appending the remaining time again read as
        // "…of run left (0m of run left)".
        say(`[budget] ${d.verdict} — ${key}: ${d.reason}`)
        lastVerdict = d.verdict
      }
    } catch (e) {
      if (!down) { say(`[budget] server unreachable: ${(e as Error).message} — still watching, NOT aborting`); down = true }
    }
    if (o.withRisks) await emitRiskTransitions(riskActive)
    await sleep(o.intervalSec * 1000)
  }
}

/** Fold the realtime burn guard into the same stdout stream so one Monitor covers both. Same
 *  transition-only contract as `--guard`; a risk feed failure is swallowed because the budget
 *  verdict is the load-bearing signal here and must not be lost to a risk-endpoint hiccup. */
async function emitRiskTransitions(active: Set<string>): Promise<void> {
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
    if (o.log) {
      log = new LineLog(o.log, { flushMs: o.flushMs })
      const sink = log
      say = (line: string) => { console.log(line); sink.write(line) }
    }
    return await (o.watch ? runWatch(o) : runOnce(o))
  } catch (e) {
    // Mirror the failure onto STDOUT before rethrowing. The CLI convention puts `FAIL:` on
    // stderr, but Monitor only turns STDOUT lines into events — so a mistyped flag or an
    // unreachable server at arm time would produce a watch that emits NOTHING and ends, which
    // is indistinguishable from "armed and all quiet". Silence must never look like success.
    const msg = `[budget] FAIL: ${(e as Error).message}`
    console.log(msg)
    if (log) log.write(msg)
    throw e
  } finally {
    // The buffered tail must reach disk on EVERY exit path, the throw above included.
    if (log) { log.close(); say = (line: string) => console.log(line) }
  }
}
