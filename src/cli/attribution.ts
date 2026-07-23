// src/cli/attribution.ts — "WHO is causing this?" attached to every peak and every abort.
//
// A peak line that says only "cache-create hit 2M/min" is half an alert. The operator's next
// question is always the same one: is that MY project's session, or a sub-agent, or some other
// workdir on this machine entirely? Answering it required leaving the alert and running a second
// investigation, by which time the excursion is often over. The burn feed already carries the
// answer — get_burn_status.topSessions has per-session workspace + tokensPerMin — so the alert
// carries it too.
//
// Cost discipline: this runs ONLY when a peak/abort actually fires, never on the polling path. A
// quiet watch makes exactly one call per interval, unchanged.
//
// Attribution is ADDITIVE and must never be load-bearing: if the lookup fails or the feed is
// empty, the alert still goes out without it. An alert suppressed because its garnish failed
// would be the worst possible trade.

import { callTool } from './cliCore'

export interface BurnWindowSlice { tokensPerMin?: number; costPerMin?: number }
export interface BurnSession {
  sessionId?: string
  workspace?: string
  oneMin?: BurnWindowSlice
  fiveMin?: BurnWindowSlice
}
export interface BurnStatusPayload { topSessions?: BurnSession[] }

export interface Contributor {
  sessionId: string
  /** Bare directory name — the full path is noise in a one-line alert. */
  project: string
  workspace: string
  tokensPerMin: number
  /** Fraction of the ranked total, 0..1. */
  share: number
}

/** PURE ranking. `oneMin` is the right window for a peak (it is what spiked); `fiveMin` smooths
 *  and is better for a sustained-drain verdict like budget's ABORT. */
export function rankContributors(
  payload: BurnStatusPayload | null | undefined, window: 'oneMin' | 'fiveMin' = 'oneMin',
): Contributor[] {
  const rows = (payload && payload.topSessions) || []
  const scored = rows.map(r => {
    const slice = (window === 'fiveMin' ? r.fiveMin : r.oneMin) || {}
    const tpm = typeof slice.tokensPerMin === 'number' && Number.isFinite(slice.tokensPerMin) ? slice.tokensPerMin : 0
    const workspace = r.workspace || ''
    return {
      sessionId: r.sessionId || '',
      workspace,
      project: projectName(workspace),
      tokensPerMin: tpm,
      share: 0,
    }
  }).filter(c => c.tokensPerMin > 0)
  const total = scored.reduce((a, c) => a + c.tokensPerMin, 0)
  // total is > 0 here because every kept row has tokensPerMin > 0 — no divide-by-zero branch.
  if (total > 0) for (const c of scored) c.share = c.tokensPerMin / total
  return scored.sort((a, b) => b.tokensPerMin - a.tokensPerMin)
}

/** The last path segment, which is what a human calls "the project". An empty workspace becomes a
 *  visible placeholder rather than an empty string that would silently collapse the field. */
export function projectName(workspace: string): string {
  if (!workspace) return '(unknown workdir)'
  const parts = workspace.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workspace
}

function short(id: string): string {
  return id ? id.slice(0, 8) : '????????'
}

function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}k`
  return String(Math.round(n))
}

/** One line naming the culprits, most-expensive first. `selfSessionId` (the session a watch is
 *  scoped to, when there is one) is marked so the reader can answer the actual question — "is it
 *  me or another workdir?" — without comparing ids by eye. */
export function formatCulprits(list: Contributor[], selfSessionId?: string | null, max = 3): string {
  if (list.length === 0) return ''
  const shown = list.slice(0, Math.max(1, max))
  const parts = shown.map(c => {
    const self = selfSessionId && c.sessionId === selfSessionId ? ' ←THIS' : ''
    return `${c.project} (${short(c.sessionId)}, ${compact(c.tokensPerMin)}/min, ${Math.round(c.share * 100)}%)${self}`
  })
  const rest = list.length - shown.length
  return `who: ${parts.join(' · ')}${rest > 0 ? ` · +${rest} more` : ''}`
}

/** Structured form for `--json` consumers — the same ranking, unformatted. */
export function culpritsJson(list: Contributor[], max = 3): Array<Record<string, unknown>> {
  return list.slice(0, Math.max(1, max)).map(c => ({
    sessionId: c.sessionId, project: c.project, workspace: c.workspace,
    tokensPerMin: c.tokensPerMin, share: Number(c.share.toFixed(4)),
  }))
}

/** Fetch + rank. NEVER throws: attribution is additive to an alert that must go out regardless. */
export async function whoIsBurning(window: 'oneMin' | 'fiveMin' = 'oneMin'): Promise<Contributor[]> {
  try {
    const p = await callTool('get_burn_status', {}, true) as BurnStatusPayload
    return rankContributors(p, window)
  } catch {
    return []
  }
}
