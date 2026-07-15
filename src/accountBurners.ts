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
import { BILLABLE_WEIGHTS, type ConsumptionEvent, type ObservedAccountCapacity } from './burnMonitor'

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

/** One PROJECT/agent (grouped by workspace) inside one window — the cross-session rollup the
 *  "who is responsible" question actually wants: sessions come and go, the project persists. */
export interface ProjectBurnerRow {
  workspace: string | null            // null = events with no workspace on either the event or a card
  sessions: number
  events: number
  tokens: number
  costUsd: number
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  billableWeighted: number
  shareOfWindowPct: number
  /** The model carrying the most billable weight for this project in the window. */
  topModel: string | null
}

export interface WindowTotals {
  events: number; tokens: number; costUsd: number; billableWeighted: number
  input: number; output: number; cacheRead: number; cacheCreate: number
}

/** Capacity used for the fill% — the account's OWN observed calibration when it exists, else a
 *  SAME-PLAN account's as a labeled proxy, else null (fill undetermined, never guessed). */
export interface WindowCapacity {
  tokens: number | null
  costUsd: number | null
  source: 'observed' | 'same-plan-proxy' | null
  proxyAccountId: string | null
  observedAt: string | null
}

export interface WindowSection {
  label: '5h' | '7d'
  windowHours: number
  window: { fromIso: string; untilIso: string }
  totals: WindowTotals
  projects: ProjectBurnerRow[]
  burners: AccountBurnerRow[]
  totalProjects: number
  totalBurners: number
  capacity: WindowCapacity
  /** consumed raw tokens / capacity.tokens (or cost/cost when only cost is calibrated). */
  fillPct: number | null
}

export interface AccountBurnersReport {
  account: { accountId: string; email: string | null; plan: string | null; isCurrent: boolean }
  untilIso: string
  fiveHour: WindowSection
  sevenDay: WindowSection
  /** Which window most likely forced the rotation — the one nearer/over its capacity at `until`. */
  mostLikelyExhausted: '5h' | '7d' | 'undetermined'
  exhaustionReason: string
  /** Honesty: when the oldest available event is younger than the 7d window start, say so. */
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

/** Capacity for a window fill%: the target's OWN observed calibration first; else the calibration
 *  of a SAME-PLAN account as a labeled proxy (Max 20x limits are per plan tier); else null. */
export function resolveWindowCapacity(
  observed: Record<string, ObservedAccountCapacity>,
  target: ResolvedAccount,
  allSegments: AccountSegment[],
  label: '5h' | '7d',
): WindowCapacity {
  const pick = (cap: ObservedAccountCapacity): { tokens: number | null; costUsd: number | null } =>
    label === '5h'
      ? { tokens: cap.window5hTokens, costUsd: cap.window5hCostUsd }
      : { tokens: cap.window7dTokens, costUsd: cap.window7dCostUsd }
  const own = observed[target.accountId]
  if (own && (pick(own).tokens !== null || pick(own).costUsd !== null)) {
    return { ...pick(own), source: 'observed', proxyAccountId: null, observedAt: own.observedAt }
  }
  if (target.plan) {
    const planOf = new Map<string, string | null>()
    for (const seg of allSegments) planOf.set(seg.accountId, seg.plan) // last write wins = latest plan
    for (const [acct, cap] of Object.entries(observed)) {
      if (acct === target.accountId) continue
      if (planOf.get(acct) === target.plan && (pick(cap).tokens !== null || pick(cap).costUsd !== null)) {
        return { ...pick(cap), source: 'same-plan-proxy', proxyAccountId: acct, observedAt: cap.observedAt }
      }
    }
  }
  return { tokens: null, costUsd: null, source: null, proxyAccountId: null, observedAt: null }
}

/** One window's full aggregation: session rows AND the cross-session project (workspace) rollup. */
function buildWindowSection(opts: {
  events: ConsumptionEvent[]
  target: ResolvedAccount
  cardBy: Map<string, { sessionId: string; workspace: string; source: string; model?: string }>
  label: '5h' | '7d'
  windowHours: number
  untilMs: number
  nowMs: number
  limit: number
  capacity: WindowCapacity
}): WindowSection {
  const { events, target, cardBy, label, windowHours, untilMs, nowMs, limit, capacity } = opts
  const fromMs = untilMs - windowHours * 3600_000
  const inWindow = events.filter(e =>
    e.ts >= fromMs && e.ts < untilMs && inSegments(e.ts, target.segments, nowMs))

  const bySession = new Map<string, AccountBurnerRow & { attr: Map<string, number> }>()
  const totals: WindowTotals = { events: 0, tokens: 0, costUsd: 0, billableWeighted: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
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

  const rankedSessions = [...bySession.values()]
    .map(r => {
      r.shareOfWindowPct = totals.billableWeighted > 0 ? (r.billableWeighted / totals.billableWeighted) * 100 : 0
      r.topAttribution = [...r.attr.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      const { attr: _attr, ...row } = r
      return row as AccountBurnerRow
    })
    .sort((a, b) => b.billableWeighted - a.billableWeighted)

  // The PROJECT rollup — the same window totals re-grouped by workspace, because "who is
  // responsible" outlives any one session: an agent restarted five times is still ONE project.
  const byProject = new Map<string | null, ProjectBurnerRow & { modelW: Map<string, number> }>()
  for (const s of rankedSessions) {
    let p = byProject.get(s.workspace)
    if (!p) {
      p = {
        workspace: s.workspace, sessions: 0, events: 0, tokens: 0, costUsd: 0,
        input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
        billableWeighted: 0, shareOfWindowPct: 0, topModel: null, modelW: new Map(),
      }
      byProject.set(s.workspace, p)
    }
    p.sessions++; p.events += s.events; p.tokens += s.tokens; p.costUsd += s.costUsd
    p.input += s.input; p.output += s.output; p.cacheRead += s.cacheRead; p.cacheCreate += s.cacheCreate
    p.billableWeighted += s.billableWeighted
    if (s.model) p.modelW.set(s.model, (p.modelW.get(s.model) ?? 0) + s.billableWeighted)
  }
  const rankedProjects = [...byProject.values()]
    .map(p => {
      p.shareOfWindowPct = totals.billableWeighted > 0 ? (p.billableWeighted / totals.billableWeighted) * 100 : 0
      p.topModel = [...p.modelW.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      const { modelW: _modelW, ...row } = p
      return row as ProjectBurnerRow
    })
    .sort((a, b) => b.billableWeighted - a.billableWeighted)

  // Fill% against the calibrated capacity — tokens-based when a token cap exists (the calibration
  // snapshot and totals.tokens share units: raw tokens), else cost-based, else null (undetermined).
  const fillPct = capacity.tokens !== null && capacity.tokens > 0
    ? (totals.tokens / capacity.tokens) * 100
    : capacity.costUsd !== null && capacity.costUsd > 0
      ? (totals.costUsd / capacity.costUsd) * 100
      : null

  return {
    label, windowHours,
    window: { fromIso: new Date(fromMs).toISOString(), untilIso: new Date(untilMs).toISOString() },
    totals,
    projects: rankedProjects.slice(0, Math.max(1, limit)),
    burners: rankedSessions.slice(0, Math.max(1, limit)),
    totalProjects: rankedProjects.length,
    totalBurners: rankedSessions.length,
    capacity,
    fillPct,
  }
}

function projectTable(section: WindowSection, home: string): string[] {
  const lines: string[] = []
  lines.push('  share   equiv     cost   cache-created  cache-read   raw     sess  model / project')
  for (const p of section.projects) {
    const ws = p.workspace ? (home && p.workspace.startsWith(home) ? `~${p.workspace.slice(home.length)}` : p.workspace) : '(unattributed)'
    lines.push(
      `  ${p.shareOfWindowPct.toFixed(1).padStart(5)}%  ${fmtTok(p.billableWeighted).padStart(7)}  $${p.costUsd.toFixed(2).padStart(8)}` +
      `  ${fmtTok(p.cacheCreate).padStart(12)}  ${fmtTok(p.cacheRead).padStart(10)}  ${fmtTok(p.tokens).padStart(7)}` +
      `  ${String(p.sessions).padStart(4)}  ${p.topModel ?? '?'}  ${ws}`)
  }
  return lines
}

export function buildAccountBurnersReport(opts: {
  events: ConsumptionEvent[]
  target: ResolvedAccount
  allSegments: AccountSegment[]
  cards: { sessionId: string; workspace: string; source: string; model?: string }[]
  untilMs: number
  nowMs: number
  limit: number
  /** loadBurnConfig().observed — per-account calibrated capacities (may be empty). */
  observed: Record<string, ObservedAccountCapacity>
}): AccountBurnersReport {
  const { events, target, allSegments, cards, untilMs, nowMs, limit, observed } = opts
  const cardBy = new Map(cards.map(c => [c.sessionId, c]))

  const fiveHour = buildWindowSection({
    events, target, cardBy, label: '5h', windowHours: 5, untilMs, nowMs, limit,
    capacity: resolveWindowCapacity(observed, target, allSegments, '5h'),
  })
  const sevenDay = buildWindowSection({
    events, target, cardBy, label: '7d', windowHours: 168, untilMs, nowMs, limit,
    capacity: resolveWindowCapacity(observed, target, allSegments, '7d'),
  })

  // Which window forced the rotation? The one nearer/over its calibrated capacity at `until`.
  // With no capacity for either window the answer is UNDETERMINED — never guessed.
  let mostLikelyExhausted: '5h' | '7d' | 'undetermined' = 'undetermined'
  let exhaustionReason: string
  const f5 = fiveHour.fillPct, f7 = sevenDay.fillPct
  const capSrc = (s: WindowSection): string =>
    s.capacity.source === 'same-plan-proxy' ? `same-plan proxy ${s.capacity.proxyAccountId?.slice(0, 8)}` : (s.capacity.source ?? 'none')
  if (f5 === null && f7 === null) {
    exhaustionReason = 'No calibrated capacity for this account or a same-plan account — cannot tell which window hit its limit. A future rate-limit hit auto-calibrates it.'
  } else if ((f5 ?? -1) >= (f7 ?? -1)) {
    mostLikelyExhausted = '5h'
    exhaustionReason = `5h at ${f5!.toFixed(0)}% vs 7d at ${f7 === null ? 'unknown' : `${f7.toFixed(0)}%`} of capacity (${capSrc(fiveHour)}) at the rotation moment.`
  } else {
    mostLikelyExhausted = '7d'
    exhaustionReason = `7d at ${f7!.toFixed(0)}% vs 5h at ${f5 === null ? 'unknown' : `${f5.toFixed(0)}%`} of capacity (${capSrc(sevenDay)}) at the rotation moment.`
  }

  const oldest = events.length > 0 ? events.reduce((a, e) => Math.min(a, e.ts), Infinity) : null
  const sevenDayFromMs = untilMs - 168 * 3600_000
  const coverage = {
    oldestEventIso: oldest !== null && Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    coversWindow: oldest !== null && Number.isFinite(oldest) && oldest <= sevenDayFromMs,
  }

  const topOf = (s: WindowSection): string[] => s.projects.slice(0, 3).map(p => {
    const ws = p.workspace ? p.workspace.split('/').slice(-1)[0] : '(unattributed)'
    return `${ws} (${p.shareOfWindowPct.toFixed(0)}%, $${p.costUsd.toFixed(0)})`
  })
  const verdict = fiveHour.totalBurners === 0 && sevenDay.totalBurners === 0
    ? `No consumption events attribute to ${target.email ?? target.accountId} in either window — they may predate the event sources' retention (see coverage).`
    : `Most likely exhausted: ${mostLikelyExhausted === 'undetermined' ? 'undetermined' : `the ${mostLikelyExhausted} window`} — ${exhaustionReason} ` +
      `Top 5h projects: ${topOf(fiveHour).join('; ') || 'none'}. Top 7d projects: ${topOf(sevenDay).join('; ') || 'none'}.`

  const note = 'Attribution is TIME-based (the machine-wide account-state timeline decides which account each event burned), ' +
    'so sessions alive across a rotation split correctly between accounts. Projects group sessions by workspace. ' +
    'share/equiv rank by billable weight (input×1 + output×5 + cacheRead×0.1 + cacheCreate×1.25); cache columns are raw token counts.'
    + (coverage.coversWindow ? '' : ' ⚠ COVERAGE GAP: the oldest available event is younger than the 7d window start — 7d totals are a LOWER BOUND.')

  const home = process.env.HOME ?? ''
  const lines: string[] = []
  const acct = `${target.email ?? target.accountId}${target.isCurrent ? ' (CURRENT)' : ' (rotated out)'}`
  for (const s of [fiveHour, sevenDay]) {
    const mark = mostLikelyExhausted === s.label ? '  ◀ MOST LIKELY EXHAUSTED (forced the rotation)' : ''
    const fill = s.fillPct !== null ? ` · fill ${s.fillPct.toFixed(0)}% of ${capSrc(s)} capacity` : ' · fill unknown (no capacity)'
    lines.push(
      `━━ ${s.label} window of ${acct} ending ${s.window.untilIso} · ${s.totals.events} calls · ` +
      `${fmtTok(s.totals.billableWeighted)} equiv · $${s.totals.costUsd.toFixed(2)}${fill}${mark}`)
    lines.push(...projectTable(s, home))
  }
  lines.push(verdict)
  if (!coverage.coversWindow) lines.push(`⚠ coverage: oldest event ${coverage.oldestEventIso ?? 'none'} is inside the 7d window — 7d is a lower bound.`)

  return {
    account: { accountId: target.accountId, email: target.email, plan: target.plan, isCurrent: target.isCurrent },
    untilIso: new Date(untilMs).toISOString(),
    fiveHour, sevenDay,
    mostLikelyExhausted, exhaustionReason,
    coverage,
    verdict,
    note,
    text: lines.join('\n'),
  }
}
