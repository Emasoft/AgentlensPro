// src/cacheEventLog.ts — get_cache_event_log: the per-call CACHE LEDGER for ONE project.
//
// WHY THIS EXISTS: answering "did that compaction (or that command) burn tokens on a cache miss?"
// previously took ~8 turns of ad-hoc jq over the raw OTEL spool. Every number needed was already on
// disk; what was missing was ONE call that (a) scopes strictly to the caller's own project, (b) names
// the token buckets in full instead of abbreviations, and (c) surrounds the event of interest with the
// calls immediately BEFORE and AFTER it — a cold write is only interpretable next to the warm turns
// around it (a 137k write reads as a disaster alone, and as a cheap one-off next to the 613k prefix it
// replaced).
//
// PROJECT SCOPING IS A HARD BOUNDARY, NOT A FILTER: this machine runs ~20 concurrent sessions across
// many projects and their calls interleave in ONE shared bodies directory. Rows are emitted only for
// sessions this project owns, resolved through the authoritative on-disk fact
// ~/.claude/projects/<project-slug>/<sessionId>.jsonl. A call that cannot be proven to belong here is
// COUNTED in `excluded` and never printed — showing another project's traffic would be a privacy
// break, not a cosmetic bug, so the default is exclusion and the exclusions are always disclosed.
//
// SOURCE = the raw OTEL response bodies, NOT the session .jsonl transcript. This is load-bearing: a
// compaction's own summarization request is a real API call that NEVER appears in the transcript. Read
// from the .jsonl, a compaction looks free; read from the bodies, its full-prefix read is right there.

import * as fs from 'fs'
import * as path from 'path'
import { claudeProjectsDirs } from './logReader'
import {
  scanCacheCreationEvents, readJsonBounded, defaultBodiesDir, MAX_RESPONSE_BYTES,
  type CacheCreationEvent,
  type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import { scanOtelCallEvents } from './otelCallEvents'
import { projectSlugOf, resolveProjectSlugs } from './projectSlug'
import { calcTokenCostUsd, lookupRates } from './shared/pricing'

/** One API call, normalized from EITHER source. The OTEL path is preferred: it carries `session.id`
 *  directly (so a session's newest call and a compaction's own summarization call are attributable,
 *  which the body path's previous_message_id chain cannot do) and Claude Code's own tier-aware
 *  `cost_usd`. The body path fills in what OTEL does not carry — the 5m/1h write split and the
 *  cache-miss reason — and serves as the whole source when no span store is readable. */
interface NormalizedCall {
  ts: number
  sessionId?: string
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cacheCreate1h: number
  costUsd: number | null            // non-null only when the harness reported it
  querySource?: string
  cacheMissReason?: string
  cacheMissedTokens?: number
  source: 'otel' | 'body'
}

/** The `diagnostics` block Claude Code's cache-diagnosis beta puts on every response body. */
interface RawDiagnosticsBody {
  usage?: { cache_creation?: { ephemeral_1h_input_tokens?: unknown } }
  diagnostics?: { cache_miss_reason?: { type?: unknown; cache_missed_input_tokens?: unknown } | null } | null
}

export type CacheEventMode = 'peak' | 'recent'
export type CacheEventFormat = 'table' | 'json' | 'markdown'
export type CacheEventRole = 'peak' | 'before' | 'after' | 'recent'
export type CacheWriteTtl = '5-minute' | '1-hour'

export const WRITE_SCALE_EMOJI = '🔥'

// Cache-write size → a 1..5 marker. The steps are ~3-4x apart, so the marker tracks ORDERS OF
// MAGNITUDE rather than linear size: a 400k full-prefix rewrite must not look like a 12k suffix
// write, and on a linear scale it would (both are "big" next to a 300-token warm suffix).
export const WRITE_SCALE_THRESHOLDS: readonly number[] = [1, 10_000, 50_000, 150_000, 400_000]

export function writeScaleOf(cacheWriteTokens: number): number {
  let scale = 0
  for (const threshold of WRITE_SCALE_THRESHOLDS) {
    if (cacheWriteTokens >= threshold) scale += 1
  }
  return scale
}

// The slug rule lives in ./projectSlug — re-exported so this module's existing importers keep
// working while there is only ONE definition of how Claude Code names a project directory.
export { projectSlugOf }

/** sessionId → project slug, from directory names only (readdir, no file is opened). This is the
 *  authoritative ownership fact: Claude Code writes a session's transcript into exactly one
 *  project directory. */
export function buildSessionProjectIndex(): Map<string, string> {
  const index = new Map<string, string>()
  for (const root of claudeProjectsDirs()) {
    let slugs: string[]
    try { slugs = fs.readdirSync(root) } catch { continue }
    for (const slug of slugs) {
      let files: string[]
      try { files = fs.readdirSync(path.join(root, slug)) } catch { continue }
      for (const file of files) {
        if (file.endsWith('.jsonl')) index.set(file.slice(0, -'.jsonl'.length), slug)
      }
    }
  }
  return index
}

export interface CacheEventRow {
  role: CacheEventRole
  localTime: string                             // HH:MM:SS in the machine's own zone
  iso: string
  sessionId: string
  model: string | null
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  cacheWriteTtl: CacheWriteTtl | null
  /** What the request was: `repl_main_thread`, `compact` (a compaction's own summarization call),
   *  `agent:*`, `agent_summary`, `away_summary`, … Present only on the OTEL path. */
  querySource: string | null
  /** The API's OWN verdict on why the prefix missed, from the cache-diagnosis beta —
   *  `system_changed` | `tools_changed` | `messages_changed` | `model_changed` | … — not inferred. */
  cacheMissReason: string | null
  cacheMissedTokens: number | null
  /** 'harness' when the cost is Claude Code's own tier-aware figure; 'computed' when priced locally. */
  costSource: 'harness' | 'computed' | 'unpriced'
  // Cost-weighted size in INPUT-EQUIVALENT tokens: what this call would have cost had every token
  // been a plain input token. This is the only honest way to compare buckets, because Anthropic
  // meters the rate-limit windows by COST, not by raw token count (cache read ~0.1x, cache write
  // ~1.25x, output ~5x). null when the model has no rate entry — never a guessed number.
  weightedInputEquivalentTokens: number | null
  costUsd: number | null
  writeScale: number
  writeMarker: string
}

export interface CacheEventLogTotals {
  events: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  weightedInputEquivalentTokens: number
  costUsd: number
}

export interface CacheEventLog {
  project: string
  projectResolvedFrom: 'argument' | 'CLAUDE_PROJECT_DIR' | 'working directory'
  mode: CacheEventMode
  windowHours?: number
  timezone: string
  rows: CacheEventRow[]
  totals: CacheEventLogTotals
  /** Which feed the rows came from. 'otel' is exact (session.id per call, harness-reported
   *  tier-aware cost); 'raw-bodies' is the fallback and cannot attribute a session's newest call. */
  source: 'otel' | 'raw-bodies'
  // Split, because the two exclusions mean opposite things to the reader: `otherProject` is the
  // boundary working as intended, while `unattributable` is data about THIS project that could not be
  // proven to be ours. Reporting one number would hide a coverage gap behind a privacy guarantee.
  excluded: { calls: number; otherProject: number; unattributable: number; note: string }
  legend: string[]
  coverage: CacheCreationScanCoverage
}

export interface CacheEventLogOptions {
  project?: string
  sessionId?: string
  mode?: CacheEventMode
  contextEvents?: number
  limit?: number
  windowHours?: number
  bodiesDir?: string
  // Injectable so a test can point at an empty dir and get the raw-body fallback deterministically.
  // Without it a unit test would read the developer's REAL span store and assert against live data.
  spansDir?: string
  scanCap?: number
}

const DEFAULT_CONTEXT_EVENTS = 3
const MAX_CONTEXT_EVENTS = 25
const DEFAULT_RECENT_LIMIT = 12
const MAX_RECENT_LIMIT = 200

function rowOf(call: NormalizedCall, role: CacheEventRole): CacheEventRow {
  const rates = call.model ? lookupRates(call.model) : null
  // Prefer the harness's own figure: Claude Code prices the cache-write TTL tiers separately (a
  // 1-hour write bills at 2x base input, a 5-minute write at 1.25x), so recomputing locally can only
  // match it — and silently under-reports whenever the tier is unknown. We recompute ONLY when the
  // harness did not report a cost, and then we feed the 1h portion through so the tier is honored.
  const costUsd = call.costUsd !== null
    ? call.costUsd
    : call.model
      ? calcTokenCostUsd(call.input, call.cacheRead, call.cacheCreate, call.output, call.model, call.cacheCreate1h)
      : null
  const costSource: CacheEventRow['costSource'] =
    call.costUsd !== null ? 'harness' : costUsd !== null ? 'computed' : 'unpriced'
  const ttl: CacheWriteTtl | null = call.cacheCreate <= 0
    ? null
    : call.cacheCreate1h > 0 ? '1-hour' : call.source === 'body' ? '5-minute' : null
  // Divide the real dollar cost by the model's own base input rate. Doing it this way (rather than
  // hardcoding 0.1x/1.25x/5x) means the weighting stays correct for any model whose multipliers
  // differ from the Claude family — the ratios are read from pricing.ts, never assumed.
  const weighted = costUsd !== null && rates && rates.inputPerMTok > 0
    ? Math.round(costUsd / (rates.inputPerMTok / 1_000_000))
    : null
  const scale = writeScaleOf(call.cacheCreate)
  return {
    role,
    localTime: new Date(call.ts).toLocaleTimeString('en-GB', { hour12: false }),
    iso: new Date(call.ts).toISOString(),
    sessionId: call.sessionId ?? '',
    model: call.model ?? null,
    inputTokens: call.input,
    cacheWriteTokens: call.cacheCreate,
    cacheReadTokens: call.cacheRead,
    outputTokens: call.output,
    cacheWriteTtl: ttl,
    querySource: call.querySource ?? null,
    cacheMissReason: call.cacheMissReason ?? null,
    cacheMissedTokens: call.cacheMissedTokens ?? null,
    costSource,
    weightedInputEquivalentTokens: weighted,
    costUsd: costUsd === null ? null : +costUsd.toFixed(4),
    writeScale: scale,
    writeMarker: WRITE_SCALE_EMOJI.repeat(scale),
  }
}

/** Normalize a raw-body scan event. Used as the fallback source, and as the enrichment that adds the
 *  5m/1h write split and the cache-miss reason to an OTEL-sourced call. */
function fromBody(e: CacheCreationEvent): NormalizedCall {
  return {
    ts: e.ts, sessionId: e.sessionId, model: e.model,
    input: e.inputTokens, output: e.outputTokens,
    cacheRead: e.cacheReadTokens, cacheCreate: e.cacheCreateTokens,
    cacheCreate1h: e.cacheCreation1hTokens,
    costUsd: null,              // the body carries usage, never a cost — we price it ourselves
    source: 'body',
  }
}

/** Read the two things OTEL does not carry from a call's raw body, when it is still on the spool:
 *  the cache-write TTL split (OTEL reports one undifferentiated `cache_creation_tokens`) and the
 *  API's own `cache_miss_reason`. Keyed by `request_id`, which IS the body filename stem. */
function enrichFromBody(bodiesDir: string, requestId: string | undefined): Partial<NormalizedCall> {
  if (!requestId) return {}
  const body = readJsonBounded<RawDiagnosticsBody>(
    path.join(bodiesDir, `${requestId}.response.json`), MAX_RESPONSE_BYTES)
  if (!body) return {}
  const out: Partial<NormalizedCall> = {}
  const h1 = body.usage?.cache_creation?.ephemeral_1h_input_tokens
  if (typeof h1 === 'number') out.cacheCreate1h = h1
  const reason = body.diagnostics?.cache_miss_reason
  if (reason && typeof reason.type === 'string') {
    out.cacheMissReason = reason.type
    if (typeof reason.cache_missed_input_tokens === 'number') {
      out.cacheMissedTokens = reason.cache_missed_input_tokens
    }
  }
  return out
}

function totalsOf(rows: readonly CacheEventRow[]): CacheEventLogTotals {
  const totals: CacheEventLogTotals = {
    events: rows.length, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
    outputTokens: 0, weightedInputEquivalentTokens: 0, costUsd: 0,
  }
  for (const r of rows) {
    totals.inputTokens += r.inputTokens
    totals.cacheWriteTokens += r.cacheWriteTokens
    totals.cacheReadTokens += r.cacheReadTokens
    totals.outputTokens += r.outputTokens
    totals.weightedInputEquivalentTokens += r.weightedInputEquivalentTokens ?? 0
    totals.costUsd += r.costUsd ?? 0
  }
  totals.costUsd = +totals.costUsd.toFixed(4)
  return totals
}

/** The per-call cache ledger for ONE project.
 *
 *  mode 'peak'   — the costliest single call in the window (ties broken toward the MOST RECENT), with
 *                  the `contextEvents` calls before and after it, so the write is read in context.
 *  mode 'recent' — the last `limit` calls regardless of cost, for "what has this project been doing".
 *
 *  Both modes rank and total by cost-weighted input-equivalents, never by raw token count. */
export async function buildCacheEventLog(opts: CacheEventLogOptions = {}): Promise<CacheEventLog> {
  const mode: CacheEventMode = opts.mode === 'recent' ? 'recent' : 'peak'
  const contextEvents = Math.min(Math.max(0, opts.contextEvents ?? DEFAULT_CONTEXT_EVENTS), MAX_CONTEXT_EVENTS)
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_RECENT_LIMIT), MAX_RECENT_LIMIT)

  const explicit = opts.project?.trim()
  const envDir = process.env['CLAUDE_PROJECT_DIR']?.trim()
  const source: CacheEventLog['projectResolvedFrom'] =
    explicit ? 'argument' : envDir ? 'CLAUDE_PROJECT_DIR' : 'working directory'
  // Resolved against the directories that actually exist, not derived and hoped for: `ownedBy` below
  // comes from real directory names, so a path long enough for Claude Code to truncate-and-hash its
  // slug would never equal a naive derivation — and EVERY call would be excluded as another
  // project's. Normally one name; more than one only on a 200-char prefix collision, where owning
  // any of them is owning this project.
  const projects = resolveProjectSlugs(explicit || envDir || process.cwd())
  const project = projects[0] ?? ''

  // includeZeroCacheCreate: a ledger that hides warm turns cannot show that the call before a cold
  // write was warm — which is the whole comparison that separates a TTL expiry from a prefix break.
  const { events, coverage } = await scanCacheCreationEvents({
    bodiesDir: opts.bodiesDir, windowHours: opts.windowHours, scanCap: opts.scanCap,
    includeZeroCacheCreate: true,
  })

  // OTEL FIRST. Its api_request events carry session.id directly, so attribution is exact — no
  // previous_message_id chain, which means a session's newest call and a compaction's own
  // summarization call (query_source `compact`) finally appear instead of falling into the
  // unattributable bucket. Each is then enriched from its raw body via `request_id` (the body
  // filename stem) for the two things OTEL omits: the 5m/1h write split and cache_miss_reason.
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const otel = scanOtelCallEvents({ spansDir: opts.spansDir, windowHours: opts.windowHours })
  const calls: NormalizedCall[] = otel.events.length > 0
    ? otel.events.map(e => ({
        ts: e.ts, sessionId: e.sessionId, model: e.model,
        input: e.inputTokens, output: e.outputTokens,
        cacheRead: e.cacheReadTokens, cacheCreate: e.cacheCreateTokens,
        cacheCreate1h: 0, costUsd: e.costUsd, querySource: e.querySource,
        source: 'otel' as const,
        ...enrichFromBody(bodiesDir, e.requestId),
      }))
    : events.map(fromBody)
  const usingOtel = otel.events.length > 0

  const owner = buildSessionProjectIndex()
  const mine: NormalizedCall[] = []
  let otherProject = 0
  let unattributable = 0
  for (const e of calls) {
    const ownedBy = e.sessionId ? owner.get(e.sessionId) : undefined
    if (ownedBy === undefined) { unattributable += 1; continue }
    if (!projects.includes(ownedBy) || (opts.sessionId && e.sessionId !== opts.sessionId)) { otherProject += 1; continue }
    mine.push(e)
  }
  mine.sort((a, b) => a.ts - b.ts)

  let rows: CacheEventRow[] = []
  if (mine.length > 0 && mode === 'peak') {
    // Cost, not cache-write size: the costliest call is sometimes an OUTPUT spike (billed ~5x), and a
    // ledger that only ever points at the biggest write would never show it. Ties go to the most
    // recent so "the peak" means the one the user just watched happen.
    const costOf = (e: NormalizedCall): number => e.costUsd !== null
      ? e.costUsd
      : e.model ? calcTokenCostUsd(e.input, e.cacheRead, e.cacheCreate, e.output, e.model, e.cacheCreate1h) : 0
    let peakIndex = 0
    for (let i = 1; i < mine.length; i++) {
      if (costOf(mine[i]) >= costOf(mine[peakIndex])) peakIndex = i
    }
    const from = Math.max(0, peakIndex - contextEvents)
    const to = Math.min(mine.length - 1, peakIndex + contextEvents)
    for (let i = from; i <= to; i++) {
      rows.push(rowOf(mine[i], i === peakIndex ? 'peak' : i < peakIndex ? 'before' : 'after'))
    }
  } else {
    rows = mine.slice(-limit).map(e => rowOf(e, 'recent'))
  }

  return {
    project, projectResolvedFrom: source, mode, windowHours: opts.windowHours,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rows,
    totals: totalsOf(rows),
    excluded: {
      calls: otherProject + unattributable,
      otherProject,
      unattributable,
      note: `${otherProject} call(s) excluded as belonging to another project (the scoping boundary ` +
        `working as intended) and ${unattributable} as unattributable to any session. ` + (usingOtel
          ? 'Source is the OTEL span store, whose api_request events carry session.id directly, so ' +
            'attribution is exact and even a compaction\'s own summarization call (query_source ' +
            '`compact`) is attributed — an unattributable count here means an event with no session.id.'
          : 'Source is the raw-body scan (no OTEL span store readable): a call is attributed through ' +
            'the FOLLOWING request\'s previous_message_id, so a session\'s most recent call — and a ' +
            'compaction\'s own summarization call, which the next request does not chain to — cannot ' +
            'be attributed.') +
        ' They are never guessed into a project by timing.',
    },
    source: usingOtel ? 'otel' : 'raw-bodies',
    legend: [
      `Cache write marker: ${WRITE_SCALE_EMOJI} 1+ tokens · ${WRITE_SCALE_EMOJI.repeat(2)} 10,000+ · ` +
        `${WRITE_SCALE_EMOJI.repeat(3)} 50,000+ · ${WRITE_SCALE_EMOJI.repeat(4)} 150,000+ · ` +
        `${WRITE_SCALE_EMOJI.repeat(5)} 400,000+ (order-of-magnitude steps).`,
      'Weighted input-equivalents = the call\'s dollar cost expressed in plain-input tokens. The ' +
        'rate-limit windows are metered by COST, so raw token counts are not comparable across buckets.',
      'Cache write TTL: 1-hour = a main-conversation turn on a subscription; 5-minute = a subagent, ' +
        'or a usage-credits session. A 5-minute write with zero cache read is a fresh subagent paying ' +
        'for a cold copy of its parent\'s context.',
      'Never sourced from the session transcript: a compaction\'s own summarization call is a real ' +
        'API call that the .jsonl does not record, so read from there a compaction looks free.',
      'Cost source: `harness` rows carry Claude Code\'s own cost_usd, which prices the cache-write ' +
        'TTL tiers separately (1-hour writes bill at 2x base input, 5-minute at 1.25x). `computed` ' +
        'rows were priced locally from the rate table.',
    ],
    coverage,
  }
}

// Terminal display width, not code-point count. An emoji is ONE code point but occupies TWO columns,
// so sizing the marker column with .length (or even [...s].length) leaves every row after a wide
// marker visibly out of line — which in a table of numbers reads as a data error, not a font quirk.
function displayWidth(value: string): number {
  let width = 0
  for (const ch of value) width += (ch.codePointAt(0) ?? 0) > 0xFFFF ? 2 : 1
  return width
}

function pad(value: string, width: number, right = true): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(value)))
  return right ? fill + value : value + fill
}

const NUMBER = (n: number): string => n.toLocaleString('en-US')

/** Render the ledger. 'json' returns the object; 'table'/'markdown' return { format, text, coverage }
 *  so the MCP result stays JSON-serializable (same contract as the other forensic formatters). */
export function formatCacheEventLog(log: CacheEventLog, format: CacheEventFormat): unknown {
  if (format === 'json') return log

  const header = ['', 'Time', 'Query source', 'Input tokens', 'Cache write', '', 'Cache read',
                  'Output tokens', 'Cache write TTL', 'Cache miss reason', 'Weighted', 'Cost USD']
  const body = log.rows.map(r => [
    r.role === 'peak' ? '▶' : ' ',
    r.localTime,
    r.querySource ?? '—',
    NUMBER(r.inputTokens),
    NUMBER(r.cacheWriteTokens),
    r.writeMarker,
    NUMBER(r.cacheReadTokens),
    NUMBER(r.outputTokens),
    r.cacheWriteTtl ?? '—',
    r.cacheMissReason
      ? `${r.cacheMissReason}${r.cacheMissedTokens ? ` (${NUMBER(r.cacheMissedTokens)})` : ''}`
      : '—',
    r.weightedInputEquivalentTokens === null ? '—' : NUMBER(r.weightedInputEquivalentTokens),
    r.costUsd === null ? 'unpriced' : `$${r.costUsd.toFixed(4)}`,
  ])
  const totalRow = [
    '', 'TOTAL', '',
    NUMBER(log.totals.inputTokens), NUMBER(log.totals.cacheWriteTokens), '',
    NUMBER(log.totals.cacheReadTokens), NUMBER(log.totals.outputTokens), '', '',
    NUMBER(log.totals.weightedInputEquivalentTokens), `$${log.totals.costUsd.toFixed(4)}`,
  ]

  const lines: string[] = []
  const title = log.mode === 'peak'
    ? `Cache event ledger — costliest call in window, with ${(log.rows.length - 1) / 2 >= 1 ? 'surrounding' : 'no surrounding'} calls`
    : `Cache event ledger — ${log.rows.length} most recent call(s)`
  const costNote = log.rows.some(r => r.costSource === 'harness')
    ? 'cost reported by Claude Code (tier-aware)'
    : 'cost computed locally'
  const scope = `project ${log.project} (from ${log.projectResolvedFrom}) · source ${log.source} · `
    + `${costNote} · times local (${log.timezone})`

  if (format === 'markdown') {
    lines.push(`# ${title}`, '', scope, '')
    lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`)
    for (const row of body) lines.push(`| ${row.join(' | ')} |`)
    lines.push(`| ${totalRow.join(' | ')} |`)
  } else {
    const table = [header, ...body, totalRow]
    // Width by the widest CELL, not by the header — emoji and grouped digits both break naive sizing.
    const widths = header.map((_, c) => Math.max(...table.map(r => displayWidth(r[c] ?? ''))))
    lines.push(title, scope, '')
    lines.push(table[0].map((cell, c) => pad(cell, widths[c], c > 1)).join('  '))
    for (const row of body) lines.push(row.map((cell, c) => pad(cell, widths[c], c > 1)).join('  '))
    lines.push(totalRow.map((cell, c) => pad(cell, widths[c], c > 1)).join('  '))
  }

  lines.push('', ...log.legend.map(l => `· ${l}`))
  if (log.excluded.calls > 0) lines.push('', `· ${log.excluded.note}`)
  return { format, text: lines.join('\n'), coverage: log.coverage }
}
