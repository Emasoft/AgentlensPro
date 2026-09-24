// src/cli/hookContextCostCli.ts — `agentlenspro hook-context-cost`: how much text do hooks inject?
//
// WHY (TRDD-ZQQYRYBO increment I15). Since Claude Code 2.1.280 every `hook_execution_complete`
// OTEL event carries the size of what the hook produced (additional_context_chars, stdout_chars,
// system_message_chars, num_outputs_persisted). The rich-event gate does not turn that event into
// a span, so it lands in the gated-out log-event sink (<data>/log-events/YYYY-MM-DD.ndjsonl,
// src/logEventSink.ts) — and nothing read it. Measured 2026-09-24: SubagentStart alone added
// ~2.39M chars of additionalContext in one day, i.e. ~5.2k chars on EVERY subagent's opening
// prompt. A fresh subagent has a 5-minute TTL and no warm prefix, so that text is paid as a cold
// cache WRITE on every spawn (CLAUDE.md doctrine 3 and 5) — the resident cost of hooks, invisible
// until now. This verb sums those attributes per hook over a window. Read-only, disk-only.
//
// The token figure is an ESTIMATE: chars / 2.56, the chars-per-token ratio CLAUDE.md measured on
// this machine's content with count_tokens. It is labelled as such everywhere it is printed.
//
// Every row counts DISPATCHES, not hook fires: Claude Code emits one hook_execution_complete
// event per hook DISPATCH, and that event already sums every hook that matched it (its `num_hooks`
// attribute says how many — measured 2026-09-24: num_hooks='3' on 1,999 of 1,999 SubagentStart
// events sampled). For SubagentStart a dispatch IS one subagent spawn, so the per-event average is
// already the per-spawn figure — no multiplying by hooks-matched needed.
//
// `hook_name` (displayed as `match_target`) is `<event>:<tool or agent name>` (e.g.
// `SubagentStart:fork`, `PreToolUse:Bash`) — a bare event name with no colon when the event has no
// matcher (`Stop`, `UserPromptSubmit`, `SubagentStop`). `<event>:<target>` held in every value
// sampled on 2026-09-24 (this machine's own hook config): none carried a config-pattern character
// (`*`, `|`, or an empty segment after the colon) — so on this evidence it is the match TARGET the
// hook fired against, not the configured matcher pattern; a compound matcher surfacing verbatim
// (e.g. `"matcher": "Bash|Edit"`) is unverified, since none fired here. No captured attribute names
// the hook's command, plugin, or source file either way; `hook_source` is the config-merge origin
// ("merged"), not which hook ran. So the injecting hook cannot be named here.
//
// No attribute is a reliable per-event id: `spanId`/`traceId` are present on ~95% of captured
// events but absent on some (observed missing on early SessionStart events), so they cannot dedupe
// a line appearing twice in the sink. sumHookContextCost therefore counts every matching line once,
// with no dedup — a duplicated sink line (e.g. from a retried append) would double-count.

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { dataDir } from '../dataDir'
import { bucketDayMs } from '../ndjsonBuckets'
import { EXIT } from './cliErrors'
import { assertKnownFlags, flagValue, numArg } from './argHelpers'

/** CLAUDE.md "What is IN the context": 226,910 measured tokens over 2.56 chars/token. */
export const CHARS_PER_TOKEN_ESTIMATE = 2.56

export interface HookContextCostRow {
  hookEvent: string
  /** hook_name — `<event>:<tool or agent name>`, the match TARGET the hook fired against; see
   *  the file header for the sampling caveat on compound matchers. */
  matchTarget: string
  /** Count of hook_execution_complete events (dispatches), not hook fires — each event already
   *  sums every hook that matched it. For SubagentStart a dispatch is one subagent spawn. */
  dispatches: number
  additionalContextChars: number
  stdoutChars: number
  systemMessageChars: number
  outputsPersisted: number
  /** additionalContextChars / CHARS_PER_TOKEN_ESTIMATE — an estimate, never a count. */
  estContextTokens: number
}

export interface HookContextCostResult {
  sinceMs: number
  untilMs: number
  events: number
  rows: HookContextCostRow[]
}

const EVENT_MARK = '"ev":"hook_execution_complete"'

// OTLP intValue arrives as a string (logEventSink keeps it verbatim); a missing or non-numeric
// attribute counts as 0 rather than poisoning the sum with NaN.
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Sum hook_execution_complete size attributes per (hook_event, hook_name) over [sinceMs, untilMs].
 *  Streams each daily bucket line by line: a bucket is ~170 MB/day here, too large to read whole. */
export async function sumHookContextCost(dir: string, sinceMs: number, untilMs = Date.now()): Promise<HookContextCostResult> {
  const acc = new Map<string, HookContextCostRow>()
  let events = 0
  let buckets: string[] = []
  try {
    buckets = fs.readdirSync(dir).filter(f => bucketDayMs(f) !== null).sort()
  } catch {
    // no sink dir yet — an empty result, which the caller reports as "no events"
  }
  for (const b of buckets) {
    const dayStart = bucketDayMs(b) as number
    if (dayStart > untilMs || dayStart + 86_400_000 < sinceMs) continue
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, b)), crlfDelay: Infinity })
    for await (const line of rl) {
      // Cheap substring prefilter before JSON.parse: hook events are a small share of the sink.
      if (!line.includes(EVENT_MARK)) continue
      let rec: { ts?: number; attrs?: Record<string, unknown> }
      try { rec = JSON.parse(line) } catch { continue } // a torn tail line from a live append
      const ts = rec.ts ?? 0
      if (ts < sinceMs || ts > untilMs) continue
      const a = rec.attrs ?? {}
      const hookEvent = String(a['hook_event'] ?? '?')
      const matchTarget = String(a['hook_name'] ?? hookEvent)
      const key = `${hookEvent}\u0000${matchTarget}`
      let row = acc.get(key)
      if (!row) {
        row = { hookEvent, matchTarget, dispatches: 0, additionalContextChars: 0, stdoutChars: 0, systemMessageChars: 0, outputsPersisted: 0, estContextTokens: 0 }
        acc.set(key, row)
      }
      row.dispatches += 1
      row.additionalContextChars += num(a['additional_context_chars'])
      row.stdoutChars += num(a['stdout_chars'])
      row.systemMessageChars += num(a['system_message_chars'])
      row.outputsPersisted += num(a['num_outputs_persisted'])
      events += 1
    }
  }
  const rows = [...acc.values()]
  for (const r of rows) r.estContextTokens = Math.round(r.additionalContextChars / CHARS_PER_TOKEN_ESTIMATE)
  rows.sort((x, y) => y.additionalContextChars - x.additionalContextChars || y.stdoutChars - x.stdoutChars)
  return { sinceMs, untilMs, events, rows }
}

/** `--hours` cap: the sink is read in whole-day buckets (~170 MB/day here), so an unbounded
 *  window can force reading weeks of buckets off disk for one call. 168h = 7 days. */
export const MAX_HOURS = 168

export const HOOK_CONTEXT_COST_USAGE = `agentlenspro hook-context-cost [--hours N] [--json]

How much text do hooks inject? Sums, per hook event and matcher, what each hook DISPATCH produced
over a window: dispatches, additionalContext chars (added to the model's context), stdout chars,
systemMessage chars, and outputs persisted to a file. Source: the hook_execution_complete OTEL
events Claude Code emits since 2.1.280, read off the log-event sink on disk (works with the server
down), which is stored in whole-day buckets — a window is rounded outward to the buckets covering it.

Every row counts DISPATCHES: one hook_execution_complete event per dispatch, and each event already
sums every hook that matched it (num_hooks). For SubagentStart a dispatch IS one subagent spawn, so
the per-event average is already the per-spawn figure.

'match_target' is the hook_name attribute — the <event>:<tool or agent name> the hook fired
against (e.g. SubagentStart:fork), not the hook command, plugin, or source that ran; no captured
attribute identifies that.

est_tokens is an ESTIMATE of the additionalContext only: chars / ${CHARS_PER_TOKEN_ESTIMATE} (CLAUDE.md's
measured ratio). stdout_chars* is shown for reference only and is NOT counted in est_tokens: see
the footnote printed after the table — it reaches context as plain text only for SessionStart and
UserPromptSubmit hooks (a hook that prints JSON instead has its context already counted in
ctx_chars — never add the two columns together for those rows), and can be huge for other events
(e.g. PostToolUse:Agent) without ever reaching the model.

flags:
  --hours N   window length, ending now (default 24, max ${MAX_HOURS})
  --json      the rows as JSON — field names are the raw HookContextCostRow ones (matchTarget,
              stdoutChars, ...), NOT the table's display headers (match_target, stdout_chars)

exit:
  0 = answered · 2 = no hook_execution_complete events in the window · 64 = bad flags`

const KNOWN = new Set(['--hours', '--json', '--help', '-h'])
const VALUED = new Set(['--hours'])

export async function runHookContextCostCli(argv: string[], dir = path.join(dataDir(), 'log-events')): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HOOK_CONTEXT_COST_USAGE)
    return EXIT.OK
  }
  assertKnownFlags(argv, KNOWN, VALUED, 'agentlenspro hook-context-cost --help')
  const hoursRaw = flagValue(argv, '--hours', 'a number of hours')
  const hours = hoursRaw === undefined ? 24 : numArg(hoursRaw, '--hours')
  if (hours <= 0) {
    console.error('--hours expects a positive number')
    return EXIT.USAGE
  }
  if (hours > MAX_HOURS) {
    console.error(`--hours must be <= ${MAX_HOURS} (${MAX_HOURS / 24} days) — the sink is read in whole-day buckets and a wider window reads too much off disk`)
    return EXIT.USAGE
  }
  const untilMs = Date.now()
  const res = await sumHookContextCost(dir, untilMs - hours * 3_600_000, untilMs)

  if (res.events === 0) {
    // Cannot-answer, not "zero cost": the sink may be absent, capture off, or CC older than 2.1.280.
    console.error(`no hook_execution_complete events in the last ${hours}h under ${dir}`)
    return EXIT.UNKNOWN
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ windowHours: hours, charsPerTokenEstimate: CHARS_PER_TOKEN_ESTIMATE, ...res }, null, 2))
    return EXIT.OK
  }

  const header = ['hook_event', 'match_target', 'dispatches', 'ctx_chars', 'est_tokens', 'stdout_chars*', 'sysmsg_chars', 'persisted']
  const body = res.rows.map(r => [
    r.hookEvent, r.matchTarget, String(r.dispatches), String(r.additionalContextChars), String(r.estContextTokens),
    String(r.stdoutChars), String(r.systemMessageChars), String(r.outputsPersisted),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i].length)))
  const fmt = (cells: string[]): string => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  console.log(`hook output over the last ${hours}h — ${res.events} hook_execution_complete dispatches (each event sums every hook it matched; est_tokens = ctx_chars / ${CHARS_PER_TOKEN_ESTIMATE}, an estimate)`)
  console.log(fmt(header))
  for (const row of body) console.log(fmt(row))
  console.log('* stdout reaches context as plain text only for SessionStart/UserPromptSubmit hooks; a JSON-printing hook has its context already in ctx_chars — never add the two together. Not counted in est_tokens either way.')
  const sub = res.rows.filter(r => r.hookEvent === 'SubagentStart')
  const subDispatches = sub.reduce((s, r) => s + r.dispatches, 0)
  if (subDispatches > 0) {
    const perSpawn = Math.round(sub.reduce((s, r) => s + r.additionalContextChars, 0) / subDispatches)
    console.log(`note: SubagentStart context (~${perSpawn} chars per spawn) is part of that subagent's context on every later request of that subagent.`)
  }
  return EXIT.OK
}
