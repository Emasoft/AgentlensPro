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
  scanCacheCreationEvents,
  type CacheCreationEvent,
  type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import { calcTokenCostUsd, lookupRates } from './shared/pricing'

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

/** Claude Code names a project's log directory after its absolute path with every non-alphanumeric
 *  character replaced by '-'. Accept EITHER form so `--project` works with a path the user can type
 *  from memory or the slug they copied out of a previous report. */
export function projectSlugOf(pathOrSlug: string): string {
  const value = pathOrSlug.trim()
  if (!value) return ''
  if (!value.includes('/') && !value.includes('\\')) return value
  return value.replace(/[^a-zA-Z0-9]/g, '-')
}

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
  scanCap?: number
}

const DEFAULT_CONTEXT_EVENTS = 3
const MAX_CONTEXT_EVENTS = 25
const DEFAULT_RECENT_LIMIT = 12
const MAX_RECENT_LIMIT = 200

function ttlOf(event: CacheCreationEvent): CacheWriteTtl | null {
  if (event.cacheCreation1hTokens > 0) return '1-hour'
  if (event.cacheCreation5mTokens > 0) return '5-minute'
  return null
}

function rowOf(event: CacheCreationEvent, role: CacheEventRole): CacheEventRow {
  const rates = event.model ? lookupRates(event.model) : null
  const costUsd = event.model
    ? calcTokenCostUsd(event.inputTokens, event.cacheReadTokens, event.cacheCreateTokens, event.outputTokens, event.model)
    : null
  // Divide the real dollar cost by the model's own base input rate. Doing it this way (rather than
  // hardcoding 0.1x/1.25x/5x) means the weighting stays correct for any model whose multipliers
  // differ from the Claude family — the ratios are read from pricing.ts, never assumed.
  const weighted = costUsd !== null && rates && rates.inputPerMTok > 0
    ? Math.round(costUsd / (rates.inputPerMTok / 1_000_000))
    : null
  const scale = writeScaleOf(event.cacheCreateTokens)
  return {
    role,
    localTime: new Date(event.ts).toLocaleTimeString('en-GB', { hour12: false }),
    iso: new Date(event.ts).toISOString(),
    sessionId: event.sessionId ?? '',
    model: event.model ?? null,
    inputTokens: event.inputTokens,
    cacheWriteTokens: event.cacheCreateTokens,
    cacheReadTokens: event.cacheReadTokens,
    outputTokens: event.outputTokens,
    cacheWriteTtl: ttlOf(event),
    weightedInputEquivalentTokens: weighted,
    costUsd: costUsd === null ? null : +costUsd.toFixed(4),
    writeScale: scale,
    writeMarker: WRITE_SCALE_EMOJI.repeat(scale),
  }
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
  const project = projectSlugOf(explicit || envDir || process.cwd())

  // includeZeroCacheCreate: a ledger that hides warm turns cannot show that the call before a cold
  // write was warm — which is the whole comparison that separates a TTL expiry from a prefix break.
  const { events, coverage } = await scanCacheCreationEvents({
    bodiesDir: opts.bodiesDir, windowHours: opts.windowHours, scanCap: opts.scanCap,
    includeZeroCacheCreate: true,
  })

  const owner = buildSessionProjectIndex()
  const mine: CacheCreationEvent[] = []
  let otherProject = 0
  let unattributable = 0
  for (const e of events) {
    const ownedBy = e.sessionId ? owner.get(e.sessionId) : undefined
    if (ownedBy === undefined) { unattributable += 1; continue }
    if (ownedBy !== project || (opts.sessionId && e.sessionId !== opts.sessionId)) { otherProject += 1; continue }
    mine.push(e)
  }
  mine.sort((a, b) => a.ts - b.ts)

  let rows: CacheEventRow[] = []
  if (mine.length > 0 && mode === 'peak') {
    // Cost, not cache-write size: the costliest call is sometimes an OUTPUT spike (billed ~5x), and a
    // ledger that only ever points at the biggest write would never show it. Ties go to the most
    // recent so "the peak" means the one the user just watched happen.
    const costOf = (e: CacheCreationEvent): number =>
      e.model ? calcTokenCostUsd(e.inputTokens, e.cacheReadTokens, e.cacheCreateTokens, e.outputTokens, e.model) : 0
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
        `working as intended) and ${unattributable} as unattributable to any session. A call is ` +
        'attributed through the FOLLOWING request\'s previous_message_id, so a session\'s most recent ' +
        'call — and a compaction\'s own summarization call, which the next request does not chain to — ' +
        'stay unattributable. They are never guessed into a project by timing.',
    },
    legend: [
      `Cache write marker: ${WRITE_SCALE_EMOJI} 1+ tokens · ${WRITE_SCALE_EMOJI.repeat(2)} 10,000+ · ` +
        `${WRITE_SCALE_EMOJI.repeat(3)} 50,000+ · ${WRITE_SCALE_EMOJI.repeat(4)} 150,000+ · ` +
        `${WRITE_SCALE_EMOJI.repeat(5)} 400,000+ (order-of-magnitude steps).`,
      'Weighted input-equivalents = the call\'s dollar cost expressed in plain-input tokens. The ' +
        'rate-limit windows are metered by COST, so raw token counts are not comparable across buckets.',
      'Cache write TTL: 1-hour = a main-conversation turn on a subscription; 5-minute = a subagent, ' +
        'or a usage-credits session. A 5-minute write with zero cache read is a fresh subagent paying ' +
        'for a cold copy of its parent\'s context.',
      'Source is the OTEL response bodies, not the session transcript — a compaction\'s own ' +
        'summarization call exists only there.',
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

  const header = ['', 'Time', 'Input tokens', 'Cache write', '', 'Cache read', 'Output tokens', 'Cache write TTL', 'Weighted', 'Cost USD']
  const body = log.rows.map(r => [
    r.role === 'peak' ? '▶' : ' ',
    r.localTime,
    NUMBER(r.inputTokens),
    NUMBER(r.cacheWriteTokens),
    r.writeMarker,
    NUMBER(r.cacheReadTokens),
    NUMBER(r.outputTokens),
    r.cacheWriteTtl ?? '—',
    r.weightedInputEquivalentTokens === null ? '—' : NUMBER(r.weightedInputEquivalentTokens),
    r.costUsd === null ? 'unpriced' : `$${r.costUsd.toFixed(4)}`,
  ])
  const totalRow = [
    '', 'TOTAL',
    NUMBER(log.totals.inputTokens), NUMBER(log.totals.cacheWriteTokens), '',
    NUMBER(log.totals.cacheReadTokens), NUMBER(log.totals.outputTokens), '',
    NUMBER(log.totals.weightedInputEquivalentTokens), `$${log.totals.costUsd.toFixed(4)}`,
  ]

  const lines: string[] = []
  const title = log.mode === 'peak'
    ? `Cache event ledger — costliest call in window, with ${(log.rows.length - 1) / 2 >= 1 ? 'surrounding' : 'no surrounding'} calls`
    : `Cache event ledger — ${log.rows.length} most recent call(s)`
  const scope = `project ${log.project} (from ${log.projectResolvedFrom}) · times local (${log.timezone})`

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
