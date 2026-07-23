// src/cli/watchCli.ts — `agentlenspro watch`: a threshold-and-peak watcher over ANY usage
// metric (TRDD-WATCHANY). Sibling of `budget`, deliberately NOT the same command:
//   budget  answers ONE question (does the window outlast a timed run) and EXITS on the answer.
//   watch   observes ONE metric indefinitely and never stops on an alert — peaks are reported
//           as they happen and the watch keeps running, which is what "alert at every peak
//           without stopping" requires.
//
// Three things here are load-bearing and were each established by measurement, not assumption:
//
// 1. `get_cost_rollup --sinceIso T` is NOT a delta. Its token totals are WHOLE-SESSION for every
//    session overlapping the window (its own coverage note says so): a one-minute window on this
//    machine reported 320M tokens. So "used since T" is computed by SAMPLE-AND-SUBTRACT against
//    a baseline, never by asking the rollup for a narrow window.
// 2. A past `--since` cannot be sampled retroactively, so its baseline is seeded ONCE from the
//    transcript with a timestamp-sliced SQL query — and that query MUST dedupe by message id.
//    Claude Code writes one message as many content-block rows repeating the full usage; the
//    naive sum over-counted cache_read by 1.7x and output by 2.1x on a real session.
// 3. Only session-scope token/cost metrics are truly cumulative. Account-window percentages are
//    ROLLING gauges (old usage falls out), so their "since" delta can legitimately go negative,
//    and machine-wide burn is a rate that no baseline can turn into a total. Each is labeled or
//    refused rather than quietly presented as a total.

import { init, callTool } from './cliCore'
import { sleep } from './cliCore'
import { LineLog, clampFlushMs, DEFAULT_FLUSH_MS } from './lineLog'

export type MetricScope = 'session' | 'account' | 'machine'
export type WatchMode = 'total' | 'rate' | 'since'

export interface MetricDef {
  name: string
  scope: MetricScope
  unit: 'tokens' | 'usd' | 'pct' | 'count'
  /** Already a per-minute rate at the source — `--mode rate` reads it directly instead of differencing. */
  isRate?: boolean
  /** Cumulative and monotone, so a baseline subtraction is exact. Gauges are not. */
  cumulative?: boolean
  describe: string
}

export const METRICS: MetricDef[] = [
  { name: 'input', scope: 'session', unit: 'tokens', cumulative: true, describe: 'input tokens' },
  { name: 'output', scope: 'session', unit: 'tokens', cumulative: true, describe: 'output tokens' },
  { name: 'cache-read', scope: 'session', unit: 'tokens', cumulative: true, describe: 'cache-read tokens' },
  { name: 'cache-create', scope: 'session', unit: 'tokens', cumulative: true, describe: 'cache-creation tokens (the expensive prefix re-writes)' },
  { name: 'tokens', scope: 'session', unit: 'tokens', cumulative: true, describe: 'total tokens' },
  { name: 'cost', scope: 'session', unit: 'usd', cumulative: true, describe: 'session cost in USD' },
  { name: 'turns', scope: 'session', unit: 'count', cumulative: true, describe: 'assistant turns' },
  { name: 'pct-5h', scope: 'account', unit: 'pct', describe: 'percent of the 5h rate-limit window consumed' },
  { name: 'pct-7d', scope: 'account', unit: 'pct', describe: 'percent of the 7d rate-limit window consumed' },
  { name: 'cost-5h', scope: 'account', unit: 'usd', describe: 'USD consumed in the rolling 5h window' },
  { name: 'cost-7d', scope: 'account', unit: 'usd', describe: 'USD consumed in the rolling 7d window' },
  { name: 'cost-per-min', scope: 'account', unit: 'usd', isRate: true, describe: 'account burn in USD/min' },
  { name: 'tokens-per-min', scope: 'machine', unit: 'tokens', isRate: true, describe: 'machine-wide live burn in tokens/min' },
  { name: 'active-sessions', scope: 'machine', unit: 'count', describe: 'sessions receiving turns right now' },
]

export function findMetric(name: string): MetricDef {
  const m = METRICS.find(x => x.name === name)
  if (m) return m
  throw new Error(`unknown metric "${name}" — one of: ${METRICS.map(x => x.name).join(', ')}`)
}

// ── peak engine ──────────────────────────────────────────────────────────────────────────────

export interface PeakState { above: boolean; peak: number; peakAtMs: number; startedAtMs: number }
export interface PeakEvent { kind: 'onset' | 'peak'; value: number; atMs: number; durationMs?: number }

export function newPeakState(): PeakState {
  return { above: false, peak: 0, peakAtMs: 0, startedAtMs: 0 }
}

/** PURE excursion tracker. An "excursion" starts when the value crosses the threshold and ends
 *  when it falls back under `threshold * hysteresis`; the PEAK event carries the maximum reached
 *  in between. Reporting only at the two edges is what keeps this Monitor-safe — emitting a line
 *  per sample while the value sits above the threshold would be a notification flood, and a
 *  monitor that floods gets stopped automatically, so the alert would destroy itself.
 *
 *  Hysteresis exists because a value oscillating around the threshold would otherwise open and
 *  close an excursion on every sample and report a "peak" each time. */
export function stepPeak(
  st: PeakState, value: number, atMs: number, threshold: number, hysteresis: number,
): { state: PeakState; events: PeakEvent[] } {
  const events: PeakEvent[] = []
  const exitAt = threshold * Math.min(1, Math.max(0, hysteresis))
  let s = st
  if (!s.above) {
    if (value >= threshold) {
      s = { above: true, peak: value, peakAtMs: atMs, startedAtMs: atMs }
      events.push({ kind: 'onset', value, atMs })
    }
  } else {
    if (value > s.peak) s = { ...s, peak: value, peakAtMs: atMs }
    if (value < exitAt) {
      events.push({ kind: 'peak', value: s.peak, atMs: s.peakAtMs, durationMs: atMs - s.startedAtMs })
      s = newPeakState()
    }
  }
  return { state: s, events }
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────

export function fmtValue(v: number, unit: MetricDef['unit']): string {
  if (unit === 'usd') return `$${v < 10 ? v.toFixed(4) : v.toFixed(2)}`
  if (unit === 'pct') return `${v.toFixed(1)}%`
  if (unit === 'count') return String(Math.round(v))
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(Math.round(v))
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
}

// ── options ──────────────────────────────────────────────────────────────────────────────────

export interface WatchOptions {
  metric: MetricDef
  mode: WatchMode
  threshold: number | null
  sinceIso: string | null
  session: string | null
  intervalSec: number
  hysteresis: number
  every: boolean
  json: boolean
  log: string | null
  flushMs: number
}

export function parseWatchArgs(argv: string[]): WatchOptions {
  let metricName = ''
  const o: { mode: WatchMode; threshold: number | null; sinceIso: string | null; session: string | null; intervalSec: number; hysteresis: number; every: boolean; json: boolean; log: string | null; flushMs: number } = {
    mode: 'total', threshold: null, sinceIso: null, session: null, intervalSec: 30, hysteresis: 0.9, every: false, json: false,
    log: null, flushMs: DEFAULT_FLUSH_MS,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--metric') metricName = str(argv[++i], '--metric')
    else if (a === '--mode') {
      const v = str(argv[++i], '--mode')
      if (v !== 'total' && v !== 'rate' && v !== 'since') throw new Error(`--mode expects total|rate|since, got "${v}"`)
      o.mode = v
    } else if (a === '--threshold') o.threshold = num(argv[++i], '--threshold')
    else if (a === '--since') o.sinceIso = str(argv[++i], '--since')
    else if (a === '--session') o.session = str(argv[++i], '--session')
    else if (a === '--interval') o.intervalSec = num(argv[++i], '--interval')
    else if (a === '--hysteresis') o.hysteresis = num(argv[++i], '--hysteresis')
    else if (a === '--every') o.every = true
    else if (a === '--json') o.json = true
    else if (a === '--log') o.log = str(argv[++i], '--log')
    else if (a === '--flush-ms') o.flushMs = clampFlushMs(num(argv[++i], '--flush-ms'))
    else throw new Error(`unknown watch flag "${a}" — see: agentlenspro watch --help`)
  }
  if (!metricName) throw new Error(`watch needs a metric: --metric <name> — one of: ${METRICS.map(m => m.name).join(', ')}`)
  const metric = findMetric(metricName)
  const mode = o.mode

  // Fail fast on combinations that cannot be answered honestly, naming the reason and the way
  // out. A silently-wrong number here is worse than no number: it would be acted on.
  if (metric.scope === 'session' && !o.session) {
    throw new Error(`--metric ${metric.name} is session-scoped and needs --session <id> (find one: agentlenspro get_recent_sessions)`)
  }
  if (metric.scope === 'machine' && mode !== 'total' && !(metric.isRate && mode === 'rate')) {
    throw new Error(`--metric ${metric.name} is machine-wide and has no per-run total — use --mode total (it is already a live rate)`)
  }
  if (metric.isRate && mode === 'since') {
    throw new Error(`--metric ${metric.name} is already a rate; "since" has no meaning for it — use --mode total`)
  }
  if (o.sinceIso !== null) {
    if (mode !== 'since') throw new Error('--since only applies to --mode since')
    if (Number.isNaN(Date.parse(o.sinceIso))) throw new Error(`--since expects an ISO datetime, got "${o.sinceIso}"`)
    if (Date.parse(o.sinceIso) < Date.now() && metric.scope !== 'session') {
      throw new Error(`a PAST --since can only be reconstructed for session-scoped metrics (${metric.name} is ${metric.scope}-scoped); omit --since to baseline from now`)
    }
  }
  if (o.threshold === null && !o.every) {
    throw new Error('watch needs --threshold N (report peaks above it) or --every (echo every sample)')
  }
  return {
    metric, mode, threshold: o.threshold, sinceIso: o.sinceIso, session: o.session,
    intervalSec: Math.max(5, Math.min(900, o.intervalSec)),
    hysteresis: Math.min(1, Math.max(0, o.hysteresis)),
    every: o.every, json: o.json, log: o.log, flushMs: o.flushMs,
  }
}

function num(v: string | undefined, flag: string): number {
  const n = Number(v)
  if (v === undefined || Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${v ?? ''}"`)
  return n
}
function str(v: string | undefined, flag: string): string {
  if (!v || v.startsWith('--')) throw new Error(`${flag} expects a value`)
  return v
}

// ── sampling ─────────────────────────────────────────────────────────────────────────────────

interface AgentTokens { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreateTokens?: number; totalTokens?: number; cost_usd?: number; turns?: number }
interface EtaWin { fillPct?: number; consumedCostUsd?: number; costPerMin?: number }
interface EtaPayload { fiveHour?: EtaWin; sevenDay?: EtaWin }
interface BurnStatus { activeSessions?: number; accountWindows?: Array<{ fiveMinTokensPerMin?: number }> }

/** Read one metric's CURRENT value. Returns null when the feed genuinely has no number for it
 *  (uncalibrated capacity, unknown session) — never 0, because 0 is a measurement and null is
 *  the absence of one, and a threshold watcher must not alert or stay silent on a fabricated 0. */
export async function sampleMetric(m: MetricDef, session: string | null): Promise<number | null> {
  if (m.scope === 'session') {
    const r = await callTool('get_agent_tokens', { agentId: session }, true) as AgentTokens
    const map: Record<string, number | undefined> = {
      input: r.inputTokens, output: r.outputTokens, 'cache-read': r.cacheReadTokens,
      'cache-create': r.cacheCreateTokens, tokens: r.totalTokens, cost: r.cost_usd, turns: r.turns,
    }
    const v = map[m.name]
    return typeof v === 'number' ? v : null
  }
  if (m.scope === 'account') {
    const r = await callTool('get_window_eta', {}, true) as EtaPayload
    const five = r.fiveHour || {}
    const seven = r.sevenDay || {}
    const map: Record<string, number | undefined> = {
      'pct-5h': five.fillPct, 'pct-7d': seven.fillPct,
      'cost-5h': five.consumedCostUsd, 'cost-7d': seven.consumedCostUsd,
      'cost-per-min': five.costPerMin,
    }
    const v = map[m.name]
    return typeof v === 'number' ? v : null
  }
  const r = await callTool('get_burn_status', {}, true) as BurnStatus
  if (m.name === 'active-sessions') return typeof r.activeSessions === 'number' ? r.activeSessions : null
  const wins = r.accountWindows || []
  if (wins.length === 0) return null
  return wins.reduce((a, w) => a + (w.fiveMinTokensPerMin || 0), 0)
}

/** Seed a PAST `--since` baseline from the transcript. Deduped by message id: Claude Code
 *  repeats the full usage on every content-block row of one message, so the naive sum
 *  over-counts (measured 1.7x on cache_read, 2.1x on output). */
export function baselineSql(sinceIso: string): string {
  return `SELECT sum(i) AS input, sum(o) AS output, sum(cr) AS cache_read, sum(cc) AS cache_create, count(*) AS msgs FROM (`
    + `SELECT message.id AS mid, max(COALESCE(message.usage.input_tokens,0)) AS i, `
    + `max(COALESCE(message.usage.output_tokens,0)) AS o, `
    + `max(COALESCE(message.usage.cache_read_input_tokens,0)) AS cr, `
    + `max(COALESCE(message.usage.cache_creation_input_tokens,0)) AS cc `
    + `FROM transcripts WHERE "timestamp" >= '${sinceIso}' AND message.usage IS NOT NULL GROUP BY message.id)`
}

const SQL_COLUMN: Record<string, string> = {
  input: 'input', output: 'output', 'cache-read': 'cache_read', 'cache-create': 'cache_create',
}

/** value AT the past instant = current cumulative − what was consumed since it. */
async function pastBaseline(m: MetricDef, session: string, sinceIso: string, current: number): Promise<number> {
  const col = SQL_COLUMN[m.name]
  if (!col) {
    throw new Error(`a past --since is reconstructable for input|output|cache-read|cache-create only (not ${m.name}) — omit --since to baseline from now`)
  }
  const r = await callTool('run_transcript_sql', { sessionId: session, sql: baselineSql(sinceIso) }, true) as { rows?: Array<Record<string, string>> }
  const row = (r.rows || [])[0]
  if (!row) throw new Error(`no transcript rows at or after ${sinceIso} for session ${session}`)
  const consumedSince = Number(row[col] || 0)
  return current - consumedSince
}

export const WATCH_USAGE = `agentlenspro watch --metric <name> [options]

Watch ONE usage metric and report every PEAK above a threshold, without ever stopping.
(To decide whether a timed run fits the rate-limit window and abort it, use \`budget\`.)

  --metric <name>        what to watch (required):
${METRICS.map(m => `      ${m.name.padEnd(16)} ${m.scope.padEnd(8)} ${m.describe}`).join('\n')}
  --mode total|rate|since   total = the current value (default)
                            rate  = change per minute
                            since = consumed since --since (default: the moment watch started)
  --since <ISO>          start instant for --mode since. A PAST instant is reconstructed from the
                         transcript (session-scoped token metrics only, deduped by message id)
  --session <id>         required for session-scoped metrics (agentlenspro get_recent_sessions)
  --threshold N          report peaks at or above this value (required unless --every)
  --hysteresis F         an excursion ends below threshold x F (default 0.9) — stops flapping
  --interval SEC         poll period, 5..900 (default 30)
  --every                also echo every sample, not just peaks (noisy — Monitor may stop it)
  --json                 emit one JSON object per line instead of text
  --log <file>           also append every emitted line to a file (created if absent)
  --flush-ms N           coalesce log writes for N ms before touching the disk (default 1000,
                         max 60000, 0 = write through). Spares the SSD on a long watch; at most
                         N ms of lines are lost if the process is killed uncleanly, and a line is
                         never torn — flushes are whole lines in one append

  agentlenspro watch --metric cache-create --session <id> --mode rate --threshold 50000
  agentlenspro watch --metric pct-5h --threshold 80
  agentlenspro watch --metric tokens-per-min --threshold 1000000 --interval 15
  agentlenspro watch --metric cost --session <id> --mode since --threshold 5`

interface Emit { (line: string, obj: Record<string, unknown>): void }

export async function runWatchLoop(o: WatchOptions, emit: Emit, forever = true): Promise<number> {
  await init()
  const m = o.metric
  const first = await sampleMetric(m, o.session)
  if (first === null) {
    emit(`[watch] FAIL: ${m.name} has no value on this machine right now (feed present but the number is absent — not reporting a fabricated 0)`,
      { event: 'fail', metric: m.name })
    return 2
  }
  let baseline = first
  if (o.mode === 'since' && o.sinceIso && Date.parse(o.sinceIso) < Date.now()) {
    baseline = await pastBaseline(m, o.session as string, o.sinceIso, first)
  }
  const t0 = Date.now()
  let prev = { v: first, at: t0 }
  const scopeLabel = m.scope === 'session' ? `session ${String(o.session).slice(0, 8)}` : m.scope
  emit(`[watch] armed — ${m.name} (${m.describe}) ${o.mode} on ${scopeLabel}, `
    + `${o.threshold === null ? 'every sample' : `peaks >= ${fmtValue(o.threshold, m.unit)}`}, polling ${o.intervalSec}s`,
    { event: 'armed', metric: m.name, mode: o.mode, threshold: o.threshold, intervalSec: o.intervalSec })
  if (o.mode === 'since' && !m.cumulative) {
    emit(`[watch] note: ${m.name} is a ROLLING gauge, so its "since" delta can go negative as old usage leaves the window`,
      { event: 'note', metric: m.name })
  }

  let peak = newPeakState()
  let down = false
  for (;;) {
    await sleep(o.intervalSec * 1000)
    let value: number | null
    try {
      value = await sampleMetric(m, o.session)
      if (down) { emit('[watch] server back — resuming', { event: 'resumed' }); down = false }
    } catch (e) {
      if (!down) { emit(`[watch] server unreachable: ${(e as Error).message} — still watching`, { event: 'down' }); down = true }
      if (!forever) return 0
      continue
    }
    const now = Date.now()
    if (value === null) { if (!forever) return 0; continue }

    let shown: number
    if (o.mode === 'rate') {
      // A source that is already a rate is read straight; anything else is differenced against
      // the previous sample, which is why `prev` advances on every poll and not only on a peak.
      shown = m.isRate ? value : (value - prev.v) / Math.max(1 / 60, (now - prev.at) / 60_000)
    } else if (o.mode === 'since') {
      shown = value - baseline
    } else {
      shown = value
    }
    prev = { v: value, at: now }

    if (o.every) {
      emit(`[watch] ${m.name} ${o.mode} = ${fmtValue(shown, m.unit)}${o.mode === 'rate' ? '/min' : ''}`,
        { event: 'sample', metric: m.name, mode: o.mode, value: shown })
    }
    if (o.threshold !== null) {
      const r = stepPeak(peak, shown, now, o.threshold, o.hysteresis)
      peak = r.state
      for (const ev of r.events) {
        if (ev.kind === 'onset') {
          emit(`[watch] PEAK-START ${m.name} ${o.mode} = ${fmtValue(ev.value, m.unit)}${o.mode === 'rate' ? '/min' : ''} (>= ${fmtValue(o.threshold, m.unit)})`,
            { event: 'peak_start', metric: m.name, value: ev.value, threshold: o.threshold })
        } else {
          emit(`[watch] PEAK ${m.name} ${o.mode} max ${fmtValue(ev.value, m.unit)}${o.mode === 'rate' ? '/min' : ''} over ${fmtDur(ev.durationMs || 0)}, now ${fmtValue(shown, m.unit)}`,
            { event: 'peak', metric: m.name, peak: ev.value, durationMs: ev.durationMs, current: shown })
        }
      }
    }
    if (!forever) return 0
  }
}

export async function runWatchCli(argv: string[]): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) { console.log(WATCH_USAGE); return argv.length === 0 ? 2 : 0 }
  let log: LineLog | null = null
  try {
    const o = parseWatchArgs(argv)
    if (o.log) log = new LineLog(o.log, { flushMs: o.flushMs })
    const emit: Emit = (line, obj) => {
      const out = o.json ? JSON.stringify({ ts: new Date().toISOString(), ...obj }) : line
      console.log(out)
      if (log) log.write(out)
    }
    return await runWatchLoop(o, emit)
  } catch (e) {
    // Same reason as budget: Monitor turns only STDOUT into events, so an error that went to
    // stderr alone would leave a watch that emitted nothing — indistinguishable from "armed and
    // quiet". Silence must never look like success.
    const msg = `[watch] FAIL: ${(e as Error).message}`
    console.log(msg)
    if (log) log.write(msg)
    throw e
  } finally {
    // The buffered tail must reach disk on EVERY exit path, including the throw above — an
    // error is exactly the line a reader will come looking for.
    if (log) log.close()
  }
}
