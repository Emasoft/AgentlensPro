// Rate-limit forensics (TRDD-O981ZJKV item 12) — "what rate limits did I hit, EXACTLY how many
// tokens filled the window, and what behavior caused it?"
//
// Sources: StopFailure lifecycle hook events are the ground truth for WHEN a rate limit killed
// a turn (exact timestamps + session/cwd/error verbatim — the transcripts do not record these).
// The exact token accounting + culprit heuristics come from investigate_burn scanned over the
// 5h window ENDING at the stall: response bodies carry Anthropic's own billed usage, so "the
// combined requests that triggered the limit" is measured, not estimated.

import * as os from 'os'
import * as path from 'path'
import { readHookEvents, type HookEventRecord } from './hookEventStore'
import { investigateBurn } from './burnInvestigator'

export interface StallEpisode {
  startIso: string
  endIso: string
  /** StopFailure events inside the episode (each = one killed turn). */
  events: number
  /** Distinct sessions whose turns died, with workspace + the verbatim error head. */
  sessions: Array<{ session: string | null; cwd: string | null; error: string | null }>
}

/** Group StopFailure events into stall EPISODES: events ≤gapMs apart are one episode (one
 *  rate-limit incident kills many turns across sessions as they each retry into the wall). */
export function groupStallEpisodes(events: HookEventRecord[], gapMs = 600_000): StallEpisode[] {
  const asc = [...events].sort((a, b) => a.ts - b.ts)
  const episodes: StallEpisode[] = []
  let cur: { start: number; end: number; recs: HookEventRecord[] } | null = null
  for (const e of asc) {
    if (cur && e.ts - cur.end <= gapMs) {
      cur.end = e.ts
      cur.recs.push(e)
      continue
    }
    if (cur) episodes.push(finishEpisode(cur))
    cur = { start: e.ts, end: e.ts, recs: [e] }
  }
  if (cur) episodes.push(finishEpisode(cur))
  return episodes
}

function finishEpisode(c: { start: number; end: number; recs: HookEventRecord[] }): StallEpisode {
  const bySession = new Map<string, { session: string | null; cwd: string | null; error: string | null }>()
  for (const r of c.recs) {
    const sid = r.session ?? '?'
    if (bySession.has(sid)) continue
    const cwd = typeof r.payload?.cwd === 'string' ? r.payload.cwd : null
    const err = typeof r.payload?.error === 'string' ? r.payload.error.slice(0, 200) : null
    bySession.set(sid, { session: r.session ?? null, cwd, error: err })
  }
  return {
    startIso: new Date(c.start).toISOString(),
    endIso: new Date(c.end).toISOString(),
    events: c.recs.length,
    sessions: [...bySession.values()],
  }
}

export interface RateLimitReportOptions {
  windowHours?: number
  maxEpisodes?: number
  /** Body-scan cap for the deep attribution (forwarded to investigate_burn). */
  maxFiles?: number
  hookEventsDir?: string
  now?: number
  /** Test seam — replaces the real investigate_burn scan. */
  investigate?: (opts: { windowHours?: number; untilMs?: number; maxFiles?: number }) => unknown
}

export function buildRateLimitReport(opts: RateLimitReportOptions = {}): unknown {
  const now = opts.now ?? Date.now()
  const hours = Math.max(1, Math.min(24 * 14, opts.windowHours ?? 24))
  const maxEpisodes = Math.max(1, Math.min(20, opts.maxEpisodes ?? 5))
  const dir = opts.hookEventsDir ?? path.join(os.homedir(), '.agentlens', 'hook-events')
  const sinceMs = now - hours * 3600e3
  const window = { sinceIso: new Date(sinceMs).toISOString(), untilIso: new Date(now).toISOString(), hours }

  const events = readHookEvents(dir, { ev: 'StopFailure', sinceMs, untilMs: now, limit: 1000 })
  if (events.length === 0) {
    return {
      window,
      stallEvents: 0,
      episodes: [],
      note: 'no StopFailure (rate-limit/API turn-death) hook events in the window — either no stall happened, or lifecycle hook capture is not installed (agentlenspro-cli --install-hooks; needs a session restart).',
    }
  }

  const all = groupStallEpisodes(events)
  const episodes = all.slice(-maxEpisodes).reverse() // newest first
  const latest = episodes[0]

  // Deep-attribute the MOST RECENT episode only: the scan reads real bodies (bounded), and one
  // attribution answers the common question; older episodes stay queryable via investigate_burn
  // with untilIso = their startIso. Cost honesty > completeness here.
  const investigate = opts.investigate ?? investigateBurn
  let attributed: unknown = null
  try {
    const inv = investigate({ windowHours: 5, untilMs: Date.parse(latest.startIso), maxFiles: opts.maxFiles ?? 400 })
    // Hoist the essentials to FLAT fields: the lean shaper prunes deep nested objects from
    // the default view, and a rate-limit report without its verdict is useless. The full
    // investigation object stays nested for verbosity:"full" / --full callers.
    const o = (inv ?? {}) as Record<string, unknown>
    const totals = (o.totals ?? {}) as Record<string, unknown>
    const findings = Array.isArray(o.findings) ? o.findings : []
    attributed = {
      episodeStartIso: latest.startIso,
      meaning:
        'the 5h rate-limit window ENDING at this stall — exact billed usage (from response bodies) that ' +
        'filled the window, attributed by workspace/model, with ranked culprit findings and a verdict.',
      verdict: typeof o.verdict === 'string' ? o.verdict : null,
      windowEstCostUsd: typeof totals.estCostUsd === 'number' ? totals.estCostUsd : null,
      topFindings: findings.slice(0, 4).map(f => {
        const r = f as Record<string, unknown>
        const label = [r.code, r.summary ?? r.detail].filter(v => typeof v === 'string').join(': ')
        return label || JSON.stringify(r).slice(0, 160)
      }),
      investigation: inv,
    }
  } catch (e) {
    attributed = { episodeStartIso: latest.startIso, error: `attribution scan failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  return {
    window,
    stallEvents: events.length,
    episodesTotal: all.length,
    episodes,
    attributed,
    note:
      'episodes = StopFailure events grouped by ≤10min gaps (one incident kills many turns as sessions retry ' +
      'into the wall). Only the newest episode is deep-attributed (bounded body scan); for an older one run ' +
      'investigate_burn with untilIso set to that episode\'s startIso.',
  }
}
