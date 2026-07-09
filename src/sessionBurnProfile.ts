// SESSION BURN PROFILE — "why is THIS session burning my window?" in ONE call.
//
// WHY: diagnosing a runaway session used to take four ad-hoc probes (call sequence, gap histogram,
// tool-surface breakdown, is-it-still-alive). Each probe is an agent turn, and an agent turn re-reads
// the whole transcript — so the diagnosis cost more than the finding. This tool answers all four
// questions server-side and returns the VERDICT plus the few numbers that support it.
//
// THE COST MODEL it measures: cost ≈ turns × context_size. A session is expensive because it takes many
// turns, because each turn re-reads a large transcript, or both. Two structural sub-terms are broken
// out because they are separately fixable:
//   • the TOOL SURFACE — every tool's (name+description+schema) sits at the TOP of the cached prefix and
//     is re-sent on every turn. Grouped by source (built-in vs each MCP server) so the caller knows
//     exactly which server to remove. `deferred` counts tools excluded from the prefix until used.
//   • the TRANSCRIPT — everything else; only compaction or a fresh session shrinks it.
//
// MEMORY SAFETY (learned the hard way — a naive version JSON.parsed ~18k bodies and blew a 4GB heap):
// filter by mtime BEFORE reading, cap file size, and full-parse exactly ONE request (the newest) for the
// tool surface. Everything else is extracted with bounded regex over the raw text.
//
// POINTER-ONLY: tool NAMES, byte sizes, token counts, usage numbers. Never schemas, never message text,
// never the metadata.user_id token blob.

import * as fs from 'fs'
import * as path from 'path'
import { calcTokenCostUsd } from './pricing'
import { DEFAULT_BODIES_DIR } from './cacheCreationForensics'

const MAX_BYTES = 8 * 1024 * 1024
const CHARS_PER_TOKEN = 4
const COLD_CREATE_FLOOR = 50_000   // a "cold" call: nothing read, yet a large prefix written
const LARGE_CREATE_FLOOR = 20_000  // above pure append-growth: something in the prefix actually changed
const ACTIVE_WITHIN_MIN = 3
// Anthropic's billing multipliers relative to the base input rate. A cache_read is nearly free per
// token (0.1x) but a cache_create is a PREMIUM write (1.25x on the 5-min tier) — so 20k of create can
// outweigh 200k of read. Comparing the WEIGHTED terms is the only honest way to name the dominant cost.
const READ_WEIGHT = 0.1
const CREATE_WEIGHT = 1.25

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const rxMsgId = /"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/
const rxPrev = /"previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)"/
const rxModel = /"model"\s*:\s*"([^"]+)"/
const rxRead = /"cache_read_input_tokens"\s*:\s*(\d+)/
const rxCreate = /"cache_creation_input_tokens"\s*:\s*(\d+)/

export interface ToolSourceRow {
  source: string          // 'built-in' | 'built-in (deferred)' | 'MCP: <server>'
  tools: number
  tokensPerTurn: number   // re-sent in the cached prefix on EVERY turn of this session
  examples: string[]
}

export interface GapHistogram {
  under10s: number; s10to30: number; s30to60: number; m1to5: number; over5m: number
}

export interface SessionBurnProfile {
  sessionId: string
  windowHours: number
  requests: number
  spanMinutes: number
  turnsPerHour: number
  gapHistogram: GapHistogram
  cacheReadTotal: number
  cacheCreateTotal: number
  avgContextTokens: number      // mean cache_read per call — the per-turn re-read
  coldCalls: number
  coldPct: number
  costUsd: number
  // THE DECISIVE DIAGNOSTIC (does the prefix mutate EVERY turn, or is it stable-and-appending?):
  // a mutating prefix re-writes a LARGE cache_create on essentially every turn, so the MEDIAN is large.
  // Stable append-only growth writes only the new tail — a few k — so the median is small and the total
  // is concentrated in a handful of cold/break events. Median + concentration tell these apart; the
  // billable-weighted split then says which term actually dominates the bill (read 0.1x vs create 1.25x).
  cacheCreateMedian: number
  cacheCreateP90: number
  turnsWithLargeCreate: number      // calls whose cache_create exceeded LARGE_CREATE_FLOOR
  createConcentrationPct: number    // % of total cache_create contributed by those calls
  weighted: { readWeighted: number; createWeighted: number; dominantTerm: 'transcript-reread' | 'prefix-rewrite' }
  transcriptMessages: number
  toolSurface: {
    total: number
    deferred: number
    tokensPerTurn: number
    pctOfContext: number
    bySource: ToolSourceRow[]
  }
  toolStability: ToolStability   // THE test for "are the MCP tools the culprit?" — measured, not assumed
  topToolUse: { name: string; count: number }[]
  lastCallMinutesAgo: number | null
  active: boolean
  verdict: string
  remediation: string[]
  coverage: { bodiesDir: string; dirExists: boolean; filesScanned: number; windowHours: number; complete: boolean; note: string }
}

export interface SessionBurnProfileOptions {
  sessionId: string          // full id or a unique prefix
  windowHours?: number
  bodiesDir?: string
}

interface ReqEntry { p: string; mtime: number; size: number; model: string; prev: string | null; toolNames: string[] }

/** Extract the tool NAMES from a raw request body without parsing the whole (MB-sized) document: find
 *  the `"tools":[` key and bracket-match to its close, then pull the names inside that slice. This is
 *  what lets us fingerprint tools[] on EVERY turn cheaply — the diff of consecutive fingerprints is the
 *  direct, measured answer to "do the MCP tools change per turn?" (never an assumption). */
export function extractToolNames(raw: string): string[] {
  const key = raw.indexOf('"tools":')
  if (key < 0) return []
  const open = raw.indexOf('[', key)
  if (open < 0) return []
  let depth = 0
  let end = -1
  for (let i = open; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') { // skip strings (they may contain brackets)
      i++
      while (i < raw.length && !(raw[i] === '"' && raw[i - 1] !== '\\')) i++
      continue
    }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return []
  const slice = raw.slice(open, end)
  const names: string[] = []
  const rx = /"name"\s*:\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(slice)) !== null) names.push(m[1])
  return names
}

/** Read the session id from `metadata.user_id` ONLY.
 *
 *  BUG THIS FIXES (found by dogfooding, 2026-07-09): a naive `/"session_id":"(...)"/ ` over the raw body
 *  matches the FIRST occurrence anywhere — including inside CONVERSATION TEXT. A transcript that merely
 *  *mentions* a session id (e.g. an agent discussing another session's burn) was therefore attributed to
 *  that session, and two different queries returned byte-identical profiles. The id must come from the
 *  metadata field, never from message content — so we anchor on `"user_id"`, searched from the END
 *  (metadata is emitted last), and parse its escaped JSON blob. Returns null when absent/unparseable —
 *  fail-closed, never a guess. Pointer-only: the raw user_id token blob never leaves this function.
 */
export function sessionIdOf(raw: string): string | null {
  const at = raw.lastIndexOf('"user_id"')
  if (at < 0) return null
  const m = /"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw.slice(at))
  if (!m) return null
  try {
    const blob = JSON.parse(`"${m[1]}"`) as string    // unescape the JSON-in-a-JSON-string
    const parsed = JSON.parse(blob) as { session_id?: unknown }
    return typeof parsed.session_id === 'string' ? parsed.session_id : null
  } catch { return null }
}

function sourceOf(tool: string): string {
  const m = /^mcp__(.+?)__/.exec(tool)
  return m ? `MCP: ${m[1]}` : 'built-in'
}

export interface ToolChangeEvent { turn: number; added: string[]; removed: string[]; sources: string[] }
export interface ToolStability {
  turnsCompared: number
  turnsChanged: number
  changePct: number
  culpritSources: { source: string; turns: number }[]
  changes: ToolChangeEvent[]     // first few, for evidence
  verdict: string
}

/** Diff tools[] across consecutive turns. A change ANYWHERE in tools[] invalidates the whole prefix
 *  (tools sit above system and messages), so this is the single highest-leverage stability metric. */
function analyzeToolStability(reqs: ReqEntry[]): ToolStability {
  let turnsChanged = 0
  const bySource = new Map<string, number>()
  const changes: ToolChangeEvent[] = []
  for (let i = 1; i < reqs.length; i++) {
    const prev = reqs[i - 1].toolNames
    const cur = reqs[i].toolNames
    if (prev.length === 0 && cur.length === 0) continue
    if (prev.join(' ') === cur.join(' ')) continue
    turnsChanged++
    const ps = new Set(prev), cs = new Set(cur)
    const added = cur.filter(n => !ps.has(n))
    const removed = prev.filter(n => !cs.has(n))
    const sources = [...new Set([...added, ...removed].map(sourceOf))]
    if (added.length === 0 && removed.length === 0) sources.push('(reorder — same set, different order)')
    for (const s of sources) bySource.set(s, (bySource.get(s) ?? 0) + 1)
    if (changes.length < 5) {
      changes.push({ turn: i + 1, added: added.slice(0, 5), removed: removed.slice(0, 5), sources })
    }
  }
  const turnsCompared = Math.max(0, reqs.length - 1)
  const changePct = turnsCompared > 0 ? +(100 * turnsChanged / turnsCompared).toFixed(1) : 0
  const culpritSources = [...bySource.entries()].map(([source, turns]) => ({ source, turns })).sort((a, b) => b.turns - a.turns)
  const verdict = turnsChanged === 0
    ? 'tools[] is BYTE-STABLE across every turn — the tool catalog is NOT breaking this session\'s cache.'
    : `tools[] changed on ${turnsChanged}/${turnsCompared} turns (${changePct}%) — each change invalidates the ENTIRE prefix. Sources: ${culpritSources.map(c => `${c.source}×${c.turns}`).join(', ')}.`
  return { turnsCompared, turnsChanged, changePct, culpritSources, changes, verdict }
}

function emptyProfile(sessionId: string, windowHours: number, bodiesDir: string, dirExists: boolean, note: string): SessionBurnProfile {
  return {
    sessionId, windowHours, requests: 0, spanMinutes: 0, turnsPerHour: 0,
    gapHistogram: { under10s: 0, s10to30: 0, s30to60: 0, m1to5: 0, over5m: 0 },
    cacheReadTotal: 0, cacheCreateTotal: 0, avgContextTokens: 0, coldCalls: 0, coldPct: 0, costUsd: 0,
    cacheCreateMedian: 0, cacheCreateP90: 0, turnsWithLargeCreate: 0, createConcentrationPct: 0,
    weighted: { readWeighted: 0, createWeighted: 0, dominantTerm: 'transcript-reread' },
    transcriptMessages: 0,
    toolSurface: { total: 0, deferred: 0, tokensPerTurn: 0, pctOfContext: 0, bySource: [] },
    toolStability: { turnsCompared: 0, turnsChanged: 0, changePct: 0, culpritSources: [], changes: [], verdict: 'no data' },
    topToolUse: [], lastCallMinutesAgo: null, active: false,
    verdict: 'No requests found for this session in the scanned window.',
    remediation: [],
    coverage: { bodiesDir, dirExists, filesScanned: 0, windowHours, complete: true, note },
  }
}

/** Full-parse EXACTLY ONE request (the newest) to break the tool surface down by source, and to count
 *  the transcript length + the tool_use frequency that reveals what the session is doing. */
function inspectNewest(p: string): Pick<SessionBurnProfile, 'toolSurface' | 'topToolUse' | 'transcriptMessages'> {
  interface RawTool { name?: string; description?: string; input_schema?: unknown; defer_loading?: boolean }
  interface RawBlock { type?: string; name?: string }
  interface RawMsg { content?: unknown }
  let body: { tools?: RawTool[]; messages?: RawMsg[] }
  try { body = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {
    return { toolSurface: { total: 0, deferred: 0, tokensPerTurn: 0, pctOfContext: 0, bySource: [] }, topToolUse: [], transcriptMessages: 0 }
  }
  const tools = Array.isArray(body.tools) ? body.tools : []
  const groups = new Map<string, { tools: number; bytes: number; examples: string[] }>()
  let totalBytes = 0
  let deferred = 0
  for (const t of tools) {
    const name = typeof t.name === 'string' ? t.name : '?'
    const bytes = Buffer.byteLength(`${name}${t.description ?? ''}${JSON.stringify(t.input_schema ?? {})}`)
    totalBytes += bytes
    if (t.defer_loading === true) deferred++
    const m = /^mcp__(.+?)__/.exec(name)
    const source = m ? `MCP: ${m[1]}` : (t.defer_loading === true ? 'built-in (deferred)' : 'built-in')
    const g = groups.get(source) ?? { tools: 0, bytes: 0, examples: [] }
    g.tools++; g.bytes += bytes
    if (g.examples.length < 3) g.examples.push(name)
    groups.set(source, g)
  }
  const bySource: ToolSourceRow[] = [...groups.entries()]
    .map(([source, g]) => ({ source, tools: g.tools, tokensPerTurn: Math.round(g.bytes / CHARS_PER_TOKEN), examples: g.examples }))
    .sort((a, b) => b.tokensPerTurn - a.tokensPerTurn)

  const messages = Array.isArray(body.messages) ? body.messages : []
  const freq = new Map<string, number>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content as RawBlock[]) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string') freq.set(b.name, (freq.get(b.name) ?? 0) + 1)
    }
  }
  const topToolUse = [...freq.entries()].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 8)

  return {
    toolSurface: { total: tools.length, deferred, tokensPerTurn: Math.round(totalBytes / CHARS_PER_TOKEN), pctOfContext: 0, bySource },
    topToolUse,
    transcriptMessages: messages.length,
  }
}

function bucketGap(sec: number, h: GapHistogram): void {
  if (sec < 10) h.under10s++
  else if (sec < 30) h.s10to30++
  else if (sec < 60) h.s30to60++
  else if (sec < 300) h.m1to5++
  else h.over5m++
}

/** Build the one-line verdict + the ordered, honest remediation list. Ranked by what actually dominates
 *  the cost model (turns × context), never by what is merely easy to change. */
function judge(p: SessionBurnProfile): { verdict: string; remediation: string[] } {
  const rem: string[] = []
  const readM = (p.cacheReadTotal / 1e6).toFixed(1)
  const createM = (p.cacheCreateTotal / 1e6).toFixed(1)

  if (p.requests === 0) return { verdict: 'No activity in the window.', remediation: [] }

  // ── The decisive branch: is the PREFIX MUTATING, or is the transcript merely being re-read? ────────
  // A mutating prefix re-writes on essentially every turn → a LARGE median create. Stable append-only
  // growth writes only the new tail → a SMALL median, with the total concentrated in a few break events.
  const mutating = p.cacheCreateMedian > LARGE_CREATE_FLOOR
  const toolsUnstable = p.toolStability.changePct >= 5

  if (toolsUnstable) {
    const srcs = p.toolStability.culpritSources
    const mcpSrcs = srcs.filter(s => s.source.startsWith('MCP:')).map(s => s.source.slice(5))
    rem.push(
      `MAKE tools[] FIXED — it changed on ${p.toolStability.turnsChanged}/${p.toolStability.turnsCompared} turns (${p.toolStability.changePct}%), and a tool change invalidates the ENTIRE prefix. ` +
      `Sources: ${srcs.map(s => `${s.source}×${s.turns}`).join(', ')}.`,
    )
    if (mcpSrcs.length) {
      rem.push(
        `Pin those MCP servers so their tool set never moves: keep them connected for the WHOLE session (a disconnect/reconnect or lazy start adds/removes their tools), do not run /reload-plugins mid-session, and do not toggle them. Affected: ${mcpSrcs.join(', ')}.`,
      )
    }
    rem.push('Pin `tools:` in every sub-agent frontmatter — an agent with no `tools:` inherits the LIVE tool set, so its catalog drifts whenever any server connects or disconnects.')
    rem.push('Keep tool-search/deferral OFF: a defer/undefer re-load also mutates tools[]. Resident-but-stable beats deferred-but-churning.')
  } else if (p.toolSurface.total > 0) {
    rem.push(`tools[] is stable (${p.toolStability.changePct}% of turns changed) — the tool catalog is NOT the culprit here; its ${p.toolSurface.tokensPerTurn.toLocaleString()} tok/turn are cached and re-READ, not re-written.`)
  }

  if (p.coldPct >= 50) {
    rem.push('The cache never warms: calls arrive further apart than the TTL, so each pays a full cold prefix write. Fire within the 5-min TTL, or stop the periodic trigger.')
  }
  if (mutating) {
    rem.push(`The prefix is re-written on MOST turns (median cache_create ${p.cacheCreateMedian.toLocaleString()}). Something above the transcript changes every turn — check toolStability, hook injections into the cached prefix, and model switches.`)
  } else if (p.avgContextTokens > 200_000) {
    rem.push(`Prefix is stable (median cache_create ${p.cacheCreateMedian.toLocaleString()} = append-only growth); the cost is the RE-READ: ~${Math.round(p.avgContextTokens / 1000)}k tokens × ${p.requests} turns (${p.transcriptMessages} messages). Compact or start a fresh session.`)
  }
  if (p.turnsPerHour > 60) {
    rem.push(`~${Math.round(p.turnsPerHour)} turns/hour: an unattended loop. Turns are a linear multiplier on both terms — stop it or batch its work.`)
  }

  const loop = p.gapHistogram.under10s + p.gapHistogram.s10to30
  const dominant = p.coldPct >= 50
    ? `COLD-START LOOP — ${p.coldCalls}/${p.requests} calls read zero cache`
    : mutating
      ? `PREFIX REWRITTEN EVERY TURN — median cache_create ${p.cacheCreateMedian.toLocaleString()}`
      : p.avgContextTokens > 200_000 && p.requests > 100
        ? `MARATHON RE-READ — ${p.requests} turns × ~${Math.round(p.avgContextTokens / 1000)}k context = ${readM}M tokens re-read`
        : `${p.requests} turns, ~${Math.round(p.avgContextTokens / 1000)}k avg context`

  // Weighted comparison is the ONLY honest way to say which term dominates the bill: a cache_read is
  // 0.1x but a cache_create is 1.25x, so 20k of create can outweigh 200k of read.
  const dom = p.weighted.dominantTerm === 'prefix-rewrite'
    ? `DOMINANT COST = prefix-rewrite (${(p.weighted.createWeighted / 1e6).toFixed(1)}M weighted vs ${(p.weighted.readWeighted / 1e6).toFixed(1)}M for re-reads)`
    : `DOMINANT COST = transcript re-read (${(p.weighted.readWeighted / 1e6).toFixed(1)}M weighted vs ${(p.weighted.createWeighted / 1e6).toFixed(1)}M for rewrites)`

  const verdict = `${dominant}. ${dom}. ${readM}M cache_read + ${createM}M cache_create ≈ $${p.costUsd.toFixed(2)} in ${p.spanMinutes.toFixed(0)} min; ` +
    `median create ${p.cacheCreateMedian.toLocaleString()}, p90 ${p.cacheCreateP90.toLocaleString()}, ${p.turnsWithLargeCreate} big-write turns holding ${p.createConcentrationPct}% of all writes. ` +
    `${p.toolStability.verdict} ${loop} of ${p.requests - 1} gaps under 30s. ${p.active ? 'STILL ACTIVE' : `idle ${p.lastCallMinutesAgo?.toFixed(0)} min`}.`

  return { verdict, remediation: rem }
}

/** One-call burn diagnosis for a single session. Bounded by mtime window + file-size cap; the newest
 *  request is the only body fully parsed. Coverage is always reported honestly. */
export async function buildSessionBurnProfile(opts: SessionBurnProfileOptions): Promise<SessionBurnProfile> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const windowHours = opts.windowHours ?? 6
  const target = opts.sessionId
  if (!fs.existsSync(bodiesDir)) {
    return emptyProfile(target, windowHours, bodiesDir, false, `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`)
  }

  const cutoff = Date.now() - windowHours * 3600e3
  const reqs: ReqEntry[] = []
  const respById = new Map<string, { read: number; create: number }>()
  let scanned = 0

  for (const f of fs.readdirSync(bodiesDir)) {
    const isReq = f.endsWith('.request.json')
    const isResp = f.endsWith('.response.json')
    if (!isReq && !isResp) continue
    const p = path.join(bodiesDir, f)
    let st: fs.Stats
    try { st = fs.statSync(p) } catch { continue }
    if (st.mtimeMs < cutoff || st.size > MAX_BYTES) continue
    let s: string
    try { s = fs.readFileSync(p, 'utf8') } catch { continue }
    scanned++
    if (isResp) {
      const id = rxMsgId.exec(s)?.[1]
      if (id) respById.set(id, { read: Number(rxRead.exec(s)?.[1] ?? 0), create: Number(rxCreate.exec(s)?.[1] ?? 0) })
    } else {
      const sess = sessionIdOf(s)
      if (sess && sess.startsWith(target)) {
        reqs.push({
          p, mtime: st.mtimeMs, size: st.size,
          model: rxModel.exec(s)?.[1] ?? '', prev: rxPrev.exec(s)?.[1] ?? null,
          toolNames: extractToolNames(s),
        })
      }
    }
  }

  const note = `Scanned ${scanned} body file(s) modified in the last ${windowHours}h (files >${MAX_BYTES / 1e6}MB skipped).`
  if (reqs.length === 0) return emptyProfile(target, windowHours, bodiesDir, true, note)

  reqs.sort((a, b) => a.mtime - b.mtime)
  const gapHistogram: GapHistogram = { under10s: 0, s10to30: 0, s30to60: 0, m1to5: 0, over5m: 0 }
  let cacheReadTotal = 0, cacheCreateTotal = 0, coldCalls = 0, usable = 0, costUsd = 0
  const creates: number[] = []
  for (let i = 0; i < reqs.length; i++) {
    if (i > 0) bucketGap((reqs[i].mtime - reqs[i - 1].mtime) / 1000, gapHistogram)
    // turn i's usage lives on the response whose id == turn i+1's previous_message_id (the proven chain).
    const prev = reqs[i + 1]?.prev
    const u = prev ? respById.get(prev) : undefined
    if (!u) continue
    usable++
    cacheReadTotal += u.read
    cacheCreateTotal += u.create
    creates.push(u.create)
    if (u.read === 0 && u.create > COLD_CREATE_FLOOR) coldCalls++
    costUsd += calcTokenCostUsd(0, u.read, u.create, 0, reqs[i].model)
  }

  // Does the prefix mutate EVERY turn, or is it stable-and-appending? The median settles it.
  const largeCreates = creates.filter(c => c > LARGE_CREATE_FLOOR)
  const largeSum = largeCreates.reduce((n, c) => n + c, 0)
  const readWeighted = Math.round(cacheReadTotal * READ_WEIGHT)
  const createWeighted = Math.round(cacheCreateTotal * CREATE_WEIGHT)

  const spanMinutes = (reqs[reqs.length - 1].mtime - reqs[0].mtime) / 60000
  const newest = inspectNewest(reqs[reqs.length - 1].p)
  const avgContextTokens = usable > 0 ? Math.round(cacheReadTotal / usable) : 0
  const lastCallMinutesAgo = (Date.now() - reqs[reqs.length - 1].mtime) / 60000

  const profile: SessionBurnProfile = {
    sessionId: target,
    windowHours,
    requests: reqs.length,
    spanMinutes: +spanMinutes.toFixed(1),
    turnsPerHour: spanMinutes > 0 ? +(reqs.length / (spanMinutes / 60)).toFixed(1) : 0,
    gapHistogram,
    cacheReadTotal, cacheCreateTotal, avgContextTokens,
    coldCalls,
    coldPct: usable > 0 ? +(100 * coldCalls / usable).toFixed(1) : 0,
    costUsd: +costUsd.toFixed(2),
    cacheCreateMedian: median(creates),
    cacheCreateP90: percentile(creates, 90),
    turnsWithLargeCreate: largeCreates.length,
    createConcentrationPct: cacheCreateTotal > 0 ? +(100 * largeSum / cacheCreateTotal).toFixed(1) : 0,
    weighted: {
      readWeighted, createWeighted,
      dominantTerm: createWeighted > readWeighted ? 'prefix-rewrite' : 'transcript-reread',
    },
    transcriptMessages: newest.transcriptMessages,
    toolSurface: {
      ...newest.toolSurface,
      pctOfContext: avgContextTokens > 0 ? +(100 * newest.toolSurface.tokensPerTurn / avgContextTokens).toFixed(1) : 0,
    },
    toolStability: analyzeToolStability(reqs),
    topToolUse: newest.topToolUse,
    lastCallMinutesAgo: +lastCallMinutesAgo.toFixed(1),
    active: lastCallMinutesAgo < ACTIVE_WITHIN_MIN,
    verdict: '', remediation: [],
    coverage: { bodiesDir, dirExists: true, filesScanned: scanned, windowHours, complete: true, note },
  }
  const j = judge(profile)
  profile.verdict = j.verdict
  profile.remediation = j.remediation
  return profile
}
