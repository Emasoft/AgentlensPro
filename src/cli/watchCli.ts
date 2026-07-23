// src/cli/watchCli.ts — `agentlenspro watch`: a threshold-and-peak watcher over ANY usage
// metric. Sibling of `budget`, deliberately NOT the same command:
//   budget  answers ONE question (does the window outlast a timed run) and EXITS on the answer.
//   watch   observes ONE metric indefinitely and never stops on an alert — peaks are reported
//           as they happen and the watch keeps running, which is what "alert at every peak
//           without stopping" requires.
//
// Four things here are load-bearing and were each established by measurement, not assumption:
//
// 1. `get_cost_rollup --sinceIso T` is NOT a delta. Its token totals are WHOLE-SESSION for every
//    session overlapping the window (its own coverage note says so): a one-minute window on this
//    machine reported 320M tokens. So "used since T" is computed by SAMPLE-AND-SUBTRACT against
//    a baseline, never by asking the rollup for a narrow window.
// 2. A past `--since` cannot be sampled retroactively, so its baseline is seeded ONCE from the
//    transcript with a timestamp-sliced SQL query — and that query MUST dedupe by message id.
//    Claude Code writes one message as many content-block rows repeating the full usage; the
//    naive sum over-counted cache_read by 1.7x and output by 2.1x on a real session.
// 3. `totalTokens` in get_agent_tokens is input + output and EXCLUDES cache (measured: 1550 +
//    614578 = 616128 exactly, against 315M cache-read on the same session). The `tokens` past
//    baseline therefore sums input+output only; summing all four would make the delta disagree
//    with the live gauge by two orders of magnitude.
// 4. Only session-scope token/cost metrics are truly cumulative. Account-window percentages are
//    ROLLING gauges (old usage falls out), so their "since" delta can legitimately go negative,
//    and machine-wide burn is a rate that no baseline can turn into a total. Each is labeled or
//    refused rather than quietly presented as a total.
//
// Every metric owns its own reader and its own past-baseline SQL in ONE registry entry, so the
// option gate can ask a metric what it supports instead of duplicating that knowledge. The
// earlier shape had the gate allow `--metric cost --mode since --since <past>` while the
// reconstruction path threw on it — validation and capability must not be able to disagree.

import { init, callTool, sleep } from './cliCore'
import { LineLog, clampFlushMs, DEFAULT_FLUSH_MS } from './lineLog'
import { numArg, strArg, clamp } from './argHelpers'

export type MetricScope = 'session' | 'account' | 'machine'
export type WatchMode = 'total' | 'rate' | 'since'
export type MetricUnit = 'tokens' | 'usd' | 'pct' | 'count'

export const MIN_INTERVAL_SEC = 5
export const MAX_INTERVAL_SEC = 900
export const DEFAULT_INTERVAL_SEC = 30
export const DEFAULT_HYSTERESIS = 0.9

interface EtaWindowSlice { fillPct?: number; consumedCostUsd?: number; costPerMin?: number }

/** The union of the three source payloads. Their fields are disjoint, so one optional-field
 *  shape lets each reader touch only its own without a cast per call site. */
export interface MetricPayload {
  // get_agent_tokens (session scope)
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number
  cacheCreateTokens?: number; totalTokens?: number; cost_usd?: number; turns?: number
  // get_window_eta (account scope)
  fiveHour?: EtaWindowSlice; sevenDay?: EtaWindowSlice
  // get_burn_status (machine scope)
  activeSessions?: number; accountWindows?: Array<{ fiveMinTokensPerMin?: number }>
}

export interface MetricDef {
  name: string
  scope: MetricScope
  unit: MetricUnit
  describe: string
  /** Already a per-minute rate at the source — `--mode rate` reads it directly. */
  isRate?: boolean
  /** Cumulative and monotone, so a baseline subtraction is exact. Gauges are not. */
  cumulative?: boolean
  /** Pull this metric's current value out of its source payload. */
  read: (p: MetricPayload) => number | null
  /** SQL expression over the deduped transcript subquery. Its PRESENCE is what makes a PAST
   *  `--since` legal for this metric — the gate reads this field rather than keeping a second
   *  list that could drift out of step with what the query can actually compute. */
  pastSql?: string
}

/** null, not 0: a feed that has no number must not be reported as having measured zero. */
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export const METRICS: MetricDef[] = [
  { name: 'input', scope: 'session', unit: 'tokens', cumulative: true, describe: 'input tokens', read: p => n(p.inputTokens), pastSql: 'sum(i)' },
  { name: 'output', scope: 'session', unit: 'tokens', cumulative: true, describe: 'output tokens', read: p => n(p.outputTokens), pastSql: 'sum(o)' },
  { name: 'cache-read', scope: 'session', unit: 'tokens', cumulative: true, describe: 'cache-read tokens', read: p => n(p.cacheReadTokens), pastSql: 'sum(cr)' },
  { name: 'cache-create', scope: 'session', unit: 'tokens', cumulative: true, describe: 'cache-creation tokens (the expensive prefix re-writes)', read: p => n(p.cacheCreateTokens), pastSql: 'sum(cc)' },
  // totalTokens is input+output and excludes cache — see header note 3.
  { name: 'tokens', scope: 'session', unit: 'tokens', cumulative: true, describe: 'total tokens (input + output, cache excluded)', read: p => n(p.totalTokens), pastSql: 'sum(i) + sum(o)' },
  // No pastSql: cost needs per-message model pricing the transcript slice does not carry, and a
  // token-count stand-in would be a fabricated dollar figure.
  { name: 'cost', scope: 'session', unit: 'usd', cumulative: true, describe: 'session cost in USD', read: p => n(p.cost_usd) },
  // No pastSql: `turns` counts assistant records, which is not provably the same population as
  // "messages carrying usage" — close, unverified, and therefore not asserted.
  { name: 'turns', scope: 'session', unit: 'count', cumulative: true, describe: 'assistant turns', read: p => n(p.turns) },
  { name: 'pct-5h', scope: 'account', unit: 'pct', describe: 'percent of the 5h rate-limit window consumed', read: p => n(p.fiveHour?.fillPct) },
  { name: 'pct-7d', scope: 'account', unit: 'pct', describe: 'percent of the 7d rate-limit window consumed', read: p => n(p.sevenDay?.fillPct) },
  { name: 'cost-5h', scope: 'account', unit: 'usd', describe: 'USD consumed in the rolling 5h window', read: p => n(p.fiveHour?.consumedCostUsd) },
  { name: 'cost-7d', scope: 'account', unit: 'usd', describe: 'USD consumed in the rolling 7d window', read: p => n(p.sevenDay?.consumedCostUsd) },
  { name: 'cost-per-min', scope: 'account', unit: 'usd', isRate: true, describe: 'account burn in USD/min', read: p => n(p.fiveHour?.costPerMin) },
  {
    name: 'tokens-per-min', scope: 'machine', unit: 'tokens', isRate: true, describe: 'machine-wide live burn in tokens/min',
    read: p => (p.accountWindows?.length ? p.accountWindows.reduce((a, w) => a + (w.fiveMinTokensPerMin || 0), 0) : null),
  },
  { name: 'active-sessions', scope: 'machine', unit: 'count', describe: 'sessions receiving turns right now', read: p => n(p.activeSessions) },
]

/** scope → the one tool that serves it. */
const SOURCE: Record<MetricScope, (session: string | null) => { tool: string; args: Record<string, unknown> }> = {
  session: s => ({ tool: 'get_agent_tokens', args: { agentId: s } }),
  account: () => ({ tool: 'get_window_eta', args: {} }),
  machine: () => ({ tool: 'get_burn_status', args: {} }),
}

export function findMetric(name: string): MetricDef {
  const m = METRICS.find(x => x.name === name)
  if (m) return m
  throw new Error(`unknown metric "${name}" — one of: ${METRICS.map(x => x.name).join(', ')}`)
}

export function metricsWithPastSupport(): string[] {
  return METRICS.filter(m => m.pastSql).map(m => m.name)
}

// ── peak engine ──────────────────────────────────────────────────────────────────────────────

export interface PeakState { above: boolean; peak: number; peakAtMs: number; startedAtMs: number }
export interface PeakEvent { kind: 'onset' | 'peak'; value: number; atMs: number; durationMs?: number }

export function newPeakState(): PeakState {
  return { above: false, peak: 0, peakAtMs: 0, startedAtMs: 0 }
}

/** PURE excursion tracker. An "excursion" starts when the value reaches the threshold and ends
 *  when it falls back under `threshold * hysteresis`; the PEAK event carries the maximum reached
 *  in between. Reporting only at the two edges is what keeps this Monitor-safe — a line per
 *  sample while the value sits above the threshold would be a notification flood, and a monitor
 *  that floods is stopped automatically, so a chatty alert destroys itself.
 *
 *  Hysteresis exists because a value oscillating around the threshold would otherwise open and
 *  close an excursion on every sample and report a "peak" each time. */
export function stepPeak(
  st: PeakState, value: number, atMs: number, threshold: number, hysteresis: number,
): { state: PeakState; events: PeakEvent[] } {
  const events: PeakEvent[] = []
  const exitAt = threshold * clamp(hysteresis, 0, 1)
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

export function fmtValue(v: number, unit: MetricUnit): string {
  if (unit === 'usd') return `$${Math.abs(v) < 10 ? v.toFixed(4) : v.toFixed(2)}`
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
  let mode: WatchMode = 'total'
  let threshold: number | null = null
  let sinceIso: string | null = null
  let session: string | null = null
  let intervalSec = DEFAULT_INTERVAL_SEC
  let hysteresis = DEFAULT_HYSTERESIS
  let every = false
  let json = false
  let log: string | null = null
  let flushMs = DEFAULT_FLUSH_MS

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--metric': metricName = strArg(argv[++i], '--metric'); break
      case '--mode': {
        const v = strArg(argv[++i], '--mode')
        if (v !== 'total' && v !== 'rate' && v !== 'since') throw new Error(`--mode expects total|rate|since, got "${v}"`)
        mode = v
        break
      }
      case '--threshold': threshold = numArg(argv[++i], '--threshold'); break
      case '--since': sinceIso = strArg(argv[++i], '--since'); break
      case '--session': session = strArg(argv[++i], '--session'); break
      case '--interval': intervalSec = numArg(argv[++i], '--interval'); break
      case '--hysteresis': hysteresis = numArg(argv[++i], '--hysteresis'); break
      case '--log': log = strArg(argv[++i], '--log'); break
      case '--flush-ms': flushMs = clampFlushMs(numArg(argv[++i], '--flush-ms')); break
      case '--every': every = true; break
      case '--json': json = true; break
      default: throw new Error(`unknown watch flag "${a}" — see: agentlenspro watch --help`)
    }
  }

  if (!metricName) throw new Error(`watch needs a metric: --metric <name> — one of: ${METRICS.map(m => m.name).join(', ')}`)
  const metric = findMetric(metricName)
  validateCombination(metric, mode, sinceIso, session, threshold, every)

  return {
    metric, mode, threshold, sinceIso, session,
    intervalSec: clamp(Math.round(intervalSec), MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
    hysteresis: clamp(hysteresis, 0, 1),
    every, json, log, flushMs,
  }
}

/** Reject every combination that cannot be answered honestly, naming the reason and the way out.
 *  A silently-wrong number here is worse than no number, because it would be acted on. Each rule
 *  asks the METRIC what it supports, so this can never drift from what the code can compute. */
function validateCombination(
  metric: MetricDef, mode: WatchMode, sinceIso: string | null,
  session: string | null, threshold: number | null, every: boolean,
): void {
  if (metric.scope === 'session' && !session) {
    throw new Error(`--metric ${metric.name} is session-scoped and needs --session <id> (find one: agentlenspro get_recent_sessions)`)
  }
  if (metric.scope !== 'session' && session) {
    throw new Error(`--metric ${metric.name} is ${metric.scope}-scoped; --session does not narrow it (drop the flag, or pick a session-scoped metric)`)
  }
  if (metric.isRate && mode === 'since') {
    throw new Error(`--metric ${metric.name} is already a rate; "since" has no meaning for it — use --mode total`)
  }
  if (metric.scope === 'machine' && mode === 'since') {
    throw new Error(`--metric ${metric.name} is machine-wide live state with no per-run total — use --mode total or rate`)
  }
  if (sinceIso !== null) {
    if (mode !== 'since') throw new Error('--since only applies to --mode since')
    const t = Date.parse(sinceIso)
    if (Number.isNaN(t)) throw new Error(`--since expects an ISO datetime, got "${sinceIso}"`)
    if (t > Date.now()) throw new Error(`--since is in the FUTURE (${sinceIso}); omit it to baseline from now`)
    if (!metric.pastSql) {
      throw new Error(
        `a PAST --since cannot be reconstructed for ${metric.name}`
        + (metric.scope === 'session'
          ? ` (its value is not recoverable from the transcript slice) — reconstructable metrics: ${metricsWithPastSupport().join(', ')}`
          : ` because ${metric.scope}-scoped values are rolling gauges`)
        + '. Omit --since to baseline from now.')
    }
  }
  if (threshold === null && !every) {
    throw new Error('watch needs --threshold N (report peaks above it) or --every (echo every sample)')
  }
}

// ── sampling ─────────────────────────────────────────────────────────────────────────────────

/** Read one metric's CURRENT value. null means the feed genuinely has no number for it — never
 *  0, because 0 is a measurement and absence is not, and a threshold watcher must not alert (or
 *  stay silent) on a fabricated one. */
export async function sampleMetric(m: MetricDef, session: string | null): Promise<number | null> {
  const { tool, args } = SOURCE[m.scope](session)
  const payload = await callTool(tool, args, true) as MetricPayload
  return m.read(payload)
}

/** The deduped, timestamp-sliced transcript query behind a PAST `--since`. Grouping by message
 *  id is mandatory: Claude Code repeats one message's full usage on every content-block row, so
 *  the naive sum over-counts (measured 1.7x on cache_read, 2.1x on output). */
export function baselineSql(sinceIso: string, expr: string): string {
  const iso = sinceIso.replace(/'/g, '')   // the value is ISO-validated upstream; strip quotes so
                                           // it can never terminate the literal regardless.
  return `SELECT ${expr} AS v FROM (`
    + 'SELECT message.id AS mid, '
    + 'max(COALESCE(message.usage.input_tokens,0)) AS i, '
    + 'max(COALESCE(message.usage.output_tokens,0)) AS o, '
    + 'max(COALESCE(message.usage.cache_read_input_tokens,0)) AS cr, '
    + 'max(COALESCE(message.usage.cache_creation_input_tokens,0)) AS cc '
    + `FROM transcripts WHERE "timestamp" >= '${iso}' AND message.usage IS NOT NULL GROUP BY message.id)`
}

/** The metric's value AT a past instant = its current cumulative total minus what has been
 *  consumed since. Only reachable for metrics carrying `pastSql`; the gate guarantees that. */
async function pastBaseline(m: MetricDef, session: string, sinceIso: string, current: number): Promise<number> {
  const sql = baselineSql(sinceIso, m.pastSql as string)
  const r = await callTool('run_transcript_sql', { sessionId: session, sql }, true) as { rows?: Array<Record<string, string>> }
  const row = (r.rows || [])[0]
  if (!row) throw new Error(`no transcript rows at or after ${sinceIso} for session ${session}`)
  const consumedSince = Number(row.v || 0)
  if (Number.isNaN(consumedSince)) throw new Error(`transcript baseline for ${m.name} returned a non-numeric value`)
  return current - consumedSince
}

export const WATCH_USAGE = `agentlenspro watch --metric <name> [options]

Watch ONE usage metric and report every PEAK above a threshold, without ever stopping.
(To decide whether a timed run fits the rate-limit window and abort it, use "budget".)

  --metric <name>        what to watch (required):
${METRICS.map(m => `      ${m.name.padEnd(16)} ${m.scope.padEnd(8)} ${m.describe}`).join('\n')}
  --mode total|rate|since   total = the current value (default)
                            rate  = change per minute
                            since = consumed since --since (default: the moment watch started)
  --since <ISO>          start instant for --mode since. A PAST instant is reconstructed from the
                         transcript, deduped by message id (${metricsWithPastSupport().join(', ')})
  --session <id>         required for session-scoped metrics (agentlenspro get_recent_sessions)
  --threshold N          report peaks at or above this value (required unless --every)
  --hysteresis F         an excursion ends below threshold x F (default ${DEFAULT_HYSTERESIS}) — stops flapping
  --interval SEC         poll period, ${MIN_INTERVAL_SEC}..${MAX_INTERVAL_SEC} (default ${DEFAULT_INTERVAL_SEC})
  --every                also echo every sample, not just peaks (noisy — Monitor may stop it)
  --json                 emit one JSON object per line instead of text
  --log <file>           also append every emitted line to a file (created if absent)
  --flush-ms N           coalesce log writes for N ms before touching the disk (default ${DEFAULT_FLUSH_MS},
                         max 60000, 0 = write through). Spares the SSD on a long watch; at most
                         N ms of lines are lost if the process is killed uncleanly, and a line is
                         never torn — flushes are whole lines in one append

  agentlenspro watch --metric cache-create --session <id> --mode rate --threshold 50000
  agentlenspro watch --metric pct-5h --threshold 80
  agentlenspro watch --metric tokens-per-min --threshold 1000000 --interval 15
  agentlenspro watch --metric cost --session <id> --mode since --threshold 5`

export type Emit = (line: string, obj: Record<string, unknown>) => void

/** Turn one raw sample into the number the chosen mode reports. Pure, so the mode arithmetic is
 *  testable without a server — `rate` differencing in particular used to be buried in the loop. */
export function projectSample(
  mode: WatchMode, metric: MetricDef, value: number,
  prev: { v: number; at: number }, nowMs: number, baseline: number,
): number {
  if (mode === 'since') return value - baseline
  if (mode !== 'rate') return value
  if (metric.isRate) return value          // already per-minute at the source
  const minutes = (nowMs - prev.at) / 60_000
  if (minutes <= 0) return 0               // two samples at the same instant carry no rate
  return (value - prev.v) / minutes
}

export async function runWatchLoop(o: WatchOptions, emit: Emit): Promise<number> {
  await init()
  const m = o.metric
  const suffix = o.mode === 'rate' ? '/min' : ''

  const first = await sampleMetric(m, o.session)
  if (first === null) {
    emit(`[watch] FAIL: ${m.name} has no value on this machine right now (the feed answered but carried no number — not reporting a fabricated 0)`,
      { event: 'fail', metric: m.name })
    return 2
  }

  let baseline = first
  if (o.mode === 'since' && o.sinceIso) {
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
      // An unreachable server is not evidence about the metric. Report the outage once per
      // episode so the silence is never read as "nothing to report", and keep watching.
      if (!down) { emit(`[watch] server unreachable: ${(e as Error).message} — still watching`, { event: 'down' }); down = true }
      continue
    }
    if (value === null) continue

    const now = Date.now()
    const shown = projectSample(o.mode, m, value, prev, now, baseline)
    prev = { v: value, at: now }

    if (o.every) {
      emit(`[watch] ${m.name} ${o.mode} = ${fmtValue(shown, m.unit)}${suffix}`,
        { event: 'sample', metric: m.name, mode: o.mode, value: shown })
    }
    if (o.threshold === null) continue

    const stepped = stepPeak(peak, shown, now, o.threshold, o.hysteresis)
    peak = stepped.state
    for (const ev of stepped.events) {
      if (ev.kind === 'onset') {
        emit(`[watch] PEAK-START ${m.name} ${o.mode} = ${fmtValue(ev.value, m.unit)}${suffix} (>= ${fmtValue(o.threshold, m.unit)})`,
          { event: 'peak_start', metric: m.name, value: ev.value, threshold: o.threshold })
      } else {
        emit(`[watch] PEAK ${m.name} ${o.mode} max ${fmtValue(ev.value, m.unit)}${suffix} over ${fmtDur(ev.durationMs || 0)}, now ${fmtValue(shown, m.unit)}`,
          { event: 'peak', metric: m.name, peak: ev.value, durationMs: ev.durationMs, current: shown })
      }
    }
  }
}

export async function runWatchCli(argv: string[]): Promise<number> {
  if (argv.length === 0) { console.log(WATCH_USAGE); return 2 }
  if (argv[0] === '--help' || argv[0] === '-h') { console.log(WATCH_USAGE); return 0 }

  let log: LineLog | null = null
  try {
    const o = parseWatchArgs(argv)
    if (o.log) log = new LineLog(o.log, { flushMs: o.flushMs })
    const sink = log
    const emit: Emit = (line, obj) => {
      const out = o.json ? JSON.stringify({ ts: new Date().toISOString(), ...obj }) : line
      console.log(out)
      if (sink) sink.write(out)
    }
    return await runWatchLoop(o, emit)
  } catch (e) {
    // Monitor turns only STDOUT into events, so an error that went to stderr alone would leave a
    // watch that emitted nothing — indistinguishable from "armed and quiet". Silence must never
    // look like success.
    const msg = `[watch] FAIL: ${(e as Error).message}`
    console.log(msg)
    if (log) log.write(msg)
    throw e
  } finally {
    // The buffered tail must reach disk on EVERY exit path, the throw above included — an error
    // is exactly the line a reader will come looking for.
    if (log) log.close()
  }
}
