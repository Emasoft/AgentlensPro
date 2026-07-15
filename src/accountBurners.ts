// get_account_burners (TRDD-1XM0YSWQ) — who exhausted a given OAuth account's rate-limit window.
// Rate limits are PER ACCOUNT (one keychain OAuth token active machine-wide at a time), and the
// user rotates accounts when a window exhausts — so "who burned the PREVIOUS account's window"
// needs per-account scoping × per-session ranking, which neither investigate_burn (no account
// filter) nor get_window_budget (no per-session ranking) provides.
//
// Attribution is TIME-based, not card-based: running sessions pick up a rotated token, so a session
// alive across a rotation burns TWO accounts' windows. ConsumptionEvent.accountUuid is one value per
// session (card.accountId) and cannot express that — instead an event belongs to the target account
// iff its ts falls inside one of the target's ACTIVE SEGMENTS (from the machine's change-detected
// account-state timeline) intersected with the requested window.

import * as fs from 'fs'
import { accountStateTimelinePath } from './accountStateTimeline'
import { BILLABLE_WEIGHTS, type ConsumptionEvent } from './burnMonitor'

export interface AccountSegment {
  accountId: string
  email: string | null
  plan: string | null
  startMs: number
  /** null = still the active account. */
  endMs: number | null
}

/** Collapse the timeline's change-records into contiguous per-account segments. Records whose
 *  accountId is null (unresolved state) CLOSE the previous segment — consumption during an
 *  unresolved stretch must not be attributed to the last known account. */
export function segmentsFromRecords(records: { ts: number; accountId: string | null; email?: string | null; plan?: string | null }[]): AccountSegment[] {
  const sorted = [...records].sort((a, b) => a.ts - b.ts)
  const out: AccountSegment[] = []
  for (const r of sorted) {
    const open = out.length > 0 && out[out.length - 1].endMs === null ? out[out.length - 1] : null
    if (open && open.accountId === r.accountId) continue // same account re-recorded (plan/mode change)
    if (open) open.endMs = r.ts
    if (r.accountId !== null) {
      out.push({ accountId: r.accountId, email: r.email ?? null, plan: r.plan ?? null, startMs: r.ts, endMs: null })
    }
  }
  return out
}

/** Read + parse the account-state NDJSON into segments. A torn line is skipped, an absent file
 *  yields [] — callers turn that into an explicit "no timeline" error, never a crash. */
export function readAccountSegments(filePath = accountStateTimelinePath()): AccountSegment[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const records = raw.split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l) as { ts: number; accountId: string | null; email?: string; plan?: string } } catch { return null } })
    .filter((r): r is { ts: number; accountId: string | null; email?: string; plan?: string } => r !== null && typeof r?.ts === 'number')
  return segmentsFromRecords(records)
}

export interface ResolvedAccount {
  accountId: string
  email: string | null
  plan: string | null
  /** Every segment of THIS account (it can have several stints inside a 7d window). */
  segments: AccountSegment[]
  /** The last instant the account was active — the natural `until` for its exhausted window. */
  lastActiveMs: number
  isCurrent: boolean
}

/** Resolve `previous` / `current` / a uuid-prefix / an email against the segment timeline. */
export function resolveTargetAccount(segments: AccountSegment[], spec: string, nowMs: number): ResolvedAccount | null {
  if (segments.length === 0) return null
  const current = segments[segments.length - 1].endMs === null ? segments[segments.length - 1] : null
  let accountId: string | undefined
  const s = spec.trim().toLowerCase()
  if (s === 'current') {
    accountId = current?.accountId
  } else if (s === 'previous') {
    // The account of the segment immediately before the CURRENT account's last contiguous run —
    // i.e. the one the user rotated away from, even if the timeline re-recorded the current account.
    for (let i = segments.length - 1; i >= 0; i--) {
      if (current && segments[i].accountId === current.accountId) continue
      accountId = segments[i].accountId
      break
    }
  } else {
    const hit = [...segments].reverse().find(seg =>
      seg.accountId.toLowerCase().startsWith(s) || (seg.email ?? '').toLowerCase() === s)
    accountId = hit?.accountId
  }
  if (!accountId) return null
  const own = segments.filter(seg => seg.accountId === accountId)
  const last = own[own.length - 1]
  return {
    accountId,
    email: own.map(seg => seg.email).filter(Boolean).pop() ?? null,
    plan: own.map(seg => seg.plan).filter(Boolean).pop() ?? null,
    segments: own,
    lastActiveMs: last.endMs ?? nowMs,
    isCurrent: last.endMs === null,
  }
}

export interface AccountBurnerRow {
  sessionId: string
  workspace: string | null
  source: string | null
  model: string | null
  events: number
  tokens: number
  costUsd: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Fresh-input-token equivalents (BILLABLE_WEIGHTS) — the ranking key and the share denominator. */
  billableWeighted: number
  shareOfWindowPct: number
  /** Top attribution bucket among this session's events (agent:… / skill:… / compaction / main). */
  topAttribution: string | null
  firstMs: number
  lastMs: number
}

export interface AccountBurnersReport {
  account: { accountId: string; email: string | null; plan: string | null; isCurrent: boolean }
  windowHours: number
  window: { fromIso: string; untilIso: string }
  totals: { events: number; tokens: number; costUsd: number; billableWeighted: number; input: number; output: number; cacheRead: number; cacheCreate: number }
  burners: AccountBurnerRow[]
  totalBurners: number
  /** Honesty: when the oldest available event is younger than the window start, say so. */
  coverage: { oldestEventIso: string | null; coversWindow: boolean }
  verdict: string
  note: string
  text: string
}

const inSegments = (ts: number, segments: AccountSegment[], nowMs: number): boolean =>
  segments.some(seg => ts >= seg.startMs && ts < (seg.endMs ?? nowMs))

function weighted(e: ConsumptionEvent): number {
  const known = (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreateTokens ?? 0)
  return (e.inputTokens ?? 0) * BILLABLE_WEIGHTS.input
    + (e.outputTokens ?? 0) * BILLABLE_WEIGHTS.output
    + (e.cacheReadTokens ?? 0) * BILLABLE_WEIGHTS.cacheRead
    + (e.cacheCreateTokens ?? 0) * BILLABLE_WEIGHTS.cacheCreate
    + Math.max(0, e.tokens - known) * BILLABLE_WEIGHTS.unknown
}

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  return `${(n / 1e3).toFixed(0)}k`
}

export function buildAccountBurnersReport(opts: {
  events: ConsumptionEvent[]
  target: ResolvedAccount
  cards: { sessionId: string; workspace: string; source: string; model?: string }[]
  windowHours: number
  untilMs: number
  nowMs: number
  limit: number
}): AccountBurnersReport {
  const { events, target, cards, windowHours, untilMs, nowMs, limit } = opts
  const fromMs = untilMs - windowHours * 3600_000
  const cardBy = new Map(cards.map(c => [c.sessionId, c]))

  const inWindow = events.filter(e =>
    e.ts >= fromMs && e.ts < untilMs && inSegments(e.ts, target.segments, nowMs))

  const bySession = new Map<string, AccountBurnerRow & { attr: Map<string, number> }>()
  const totals = { events: 0, tokens: 0, costUsd: 0, billableWeighted: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  for (const e of inWindow) {
    let r = bySession.get(e.sessionId)
    if (!r) {
      const card = cardBy.get(e.sessionId)
      r = {
        sessionId: e.sessionId,
        workspace: e.workspace ?? card?.workspace ?? null,
        source: card?.source ?? null,
        model: card?.model ?? null,
        events: 0, tokens: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
        billableWeighted: 0, shareOfWindowPct: 0, topAttribution: null,
        firstMs: e.ts, lastMs: e.ts, attr: new Map(),
      }
      bySession.set(e.sessionId, r)
    }
    const w = weighted(e)
    r.events++; r.tokens += e.tokens; r.costUsd += e.costUsd; r.billableWeighted += w
    r.input += e.inputTokens ?? 0; r.output += e.outputTokens ?? 0
    r.cacheRead += e.cacheReadTokens ?? 0; r.cacheCreate += e.cacheCreateTokens ?? 0
    if (e.ts < r.firstMs) r.firstMs = e.ts
    if (e.ts > r.lastMs) r.lastMs = e.ts
    if (e.attribution) r.attr.set(e.attribution, (r.attr.get(e.attribution) ?? 0) + w)
    totals.events++; totals.tokens += e.tokens; totals.costUsd += e.costUsd; totals.billableWeighted += w
    totals.input += e.inputTokens ?? 0; totals.output += e.outputTokens ?? 0
    totals.cacheRead += e.cacheReadTokens ?? 0; totals.cacheCreate += e.cacheCreateTokens ?? 0
  }

  const ranked = [...bySession.values()]
    .map(r => {
      r.shareOfWindowPct = totals.billableWeighted > 0 ? (r.billableWeighted / totals.billableWeighted) * 100 : 0
      r.topAttribution = [...r.attr.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      const { attr: _attr, ...row } = r
      return row as AccountBurnerRow
    })
    .sort((a, b) => b.billableWeighted - a.billableWeighted)
  const burners = ranked.slice(0, Math.max(1, limit))

  const oldest = events.length > 0 ? events.reduce((a, e) => Math.min(a, e.ts), Infinity) : null
  const coverage = {
    oldestEventIso: oldest !== null && Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    coversWindow: oldest !== null && Number.isFinite(oldest) && oldest <= fromMs,
  }

  const who = ranked.slice(0, 3).map(r => {
    const ws = r.workspace ? r.workspace.split('/').slice(-1)[0] : r.sessionId.slice(0, 8)
    return `${ws} (${r.shareOfWindowPct.toFixed(0)}%, ${fmtTok(r.billableWeighted)} equiv, $${r.costUsd.toFixed(0)})`
  })
  const verdict = ranked.length === 0
    ? `No consumption events attribute to ${target.email ?? target.accountId} in this window — the window may predate the event sources' retention (see coverage).`
    : `${ranked.length} session(s) drew on this window; the top ${Math.min(3, ranked.length)} account for ` +
      `${ranked.slice(0, 3).reduce((a, r) => a + r.shareOfWindowPct, 0).toFixed(0)}% of its billable weight: ${who.join('; ')}.`

  const note = 'Attribution is TIME-based (the machine-wide account-state timeline decides which account each event burned), ' +
    'so sessions alive across a rotation split correctly between accounts. billableWeighted = input×1 + output×5 + ' +
    'cacheRead×0.1 + cacheCreate×1.25 (fresh-input-token equivalents) — the window-fill ranking metric; raw tokens over-state cache reads.'
    + (coverage.coversWindow ? '' : ' ⚠ COVERAGE GAP: the oldest available event is younger than the window start — totals are a LOWER BOUND.')

  const home = process.env.HOME ?? ''
  const lines: string[] = []
  lines.push(
    `window burners of ${target.email ?? target.accountId}${target.isCurrent ? ' (CURRENT)' : ' (rotated out)'} — ` +
    `${windowHours}h ending ${new Date(untilMs).toISOString()} · ${totals.events} calls · ` +
    `${fmtTok(totals.billableWeighted)} equiv · $${totals.costUsd.toFixed(2)}`)
  for (const r of burners) {
    const ws = r.workspace ? (home && r.workspace.startsWith(home) ? `~${r.workspace.slice(home.length)}` : r.workspace) : '?'
    lines.push(
      `${r.shareOfWindowPct.toFixed(1).padStart(5)}%  ${r.sessionId.slice(0, 8)}…  ${fmtTok(r.billableWeighted).padStart(7)} equiv` +
      `  $${r.costUsd.toFixed(2).padStart(7)}  ${fmtTok(r.tokens).padStart(7)} raw (rd ${fmtTok(r.cacheRead)}, wr ${fmtTok(r.cacheCreate)}, out ${fmtTok(r.output)})` +
      `  ${r.topAttribution ?? '?'}  ${r.model ?? '?'}  ${ws}`)
  }
  lines.push(verdict)
  if (!coverage.coversWindow) lines.push(`⚠ coverage: oldest event ${coverage.oldestEventIso ?? 'none'} > window start ${new Date(fromMs).toISOString()} — lower bound.`)

  return {
    account: { accountId: target.accountId, email: target.email, plan: target.plan, isCurrent: target.isCurrent },
    windowHours,
    window: { fromIso: new Date(fromMs).toISOString(), untilIso: new Date(untilMs).toISOString() },
    totals,
    burners,
    totalBurners: ranked.length,
    coverage,
    verdict,
    note,
    text: lines.join('\n'),
  }
}
