import { useEffect } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionCompositions,
  vscode, cacheHitSliThreshold,
} from '../state'
import { formatCompact, formatSessionTime, getAgentDotHtml } from '../utils'
import { fmtUsd, calcSessionCost } from '../sessionMetrics'
import { buildCacheBreakReport, CAUSE_LABEL } from '../cacheBreak'
import { spawnKindBadge, hitRateColor, formatPct } from './cacheShared'
import type { SessionSummaryCard, CacheBreakReport, CacheBreakCause } from '../types'

// How many sessions to eagerly hydrate (timeline + composition) for the cross-session cache-break
// aggregation. Bounded so opening the tab doesn't fire hundreds of parse requests at once; the
// hit-rate trend + worst-sessions use the card-level cacheHitRate and need no hydration.
const HYDRATE_LIMIT = 25

interface OffenderAgg { label: string; kind: string; cause: CacheBreakCause; occurrences: number; wastedTokens: number; wastedCostUsd: number; sessions: number }

// ── Section: cache-hit-rate SLI trend + worst sessions ────────────────────────
function HitRateSection({ sessions, threshold }: { sessions: SessionSummaryCard[]; threshold: number }) {
  const withCache = sessions.filter(s => (s.cacheReadTokens + s.cacheCreateTokens) > 0)
  const totalRead = withCache.reduce((n, s) => n + s.cacheReadTokens, 0)
  const totalCreate = withCache.reduce((n, s) => n + s.cacheCreateTokens, 0)
  const overall = (totalRead + totalCreate) > 0 ? totalRead / (totalRead + totalCreate) : 0
  const below = withCache.filter(s => s.cacheHitRate < threshold)
  const worst = [...withCache].sort((a, b) => a.cacheHitRate - b.cacheHitRate).slice(0, 12)

  return (
    <div style="margin-bottom:18px">
      <div style="display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px">
        <div>
          <span style={`font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:${overall >= threshold ? 'var(--vscode-charts-green,#81c784)' : 'var(--vscode-charts-orange,#e2a03f)'}`}>{formatPct(overall)}</span>
          <span style="font-size:11px;color:var(--muted);margin-left:6px">overall cache hit rate</span>
        </div>
        <div style="font-size:11px;color:var(--muted)">SLI {formatPct(threshold)} · {below.length} of {withCache.length} sessions below</div>
      </div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Worst sessions</div>
      {worst.length === 0
        ? <div style="font-size:11px;color:var(--muted)">No sessions with cache activity in range.</div>
        : worst.map(s => {
            const color = hitRateColor(s.cacheHitRate, threshold)
            const w = Math.max(s.cacheHitRate * 100, 1)
            return (
              <div key={s.sessionId} style="display:flex;align-items:center;gap:8px;font-size:11px;min-height:20px">
                <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(s.source) }} />
                <span style={`width:56px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:${color}`}>{formatPct(s.cacheHitRate)}</span>
                <div style="flex:1;position:relative;height:10px;max-width:220px">
                  <div style={`position:absolute;left:0;height:8px;top:1px;border-radius:2px;width:${w.toFixed(1)}%;background:${color};opacity:0.7`} />
                </div>
                <span style="flex:2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)" title={s.userRequest}>
                  {s.userRequest?.slice(0, 70) || formatSessionTime(s)}
                </span>
              </div>
            )
          })}
    </div>
  )
}

// ── Section: top cache-break causes (aggregated across hydrated sessions) ──────
function CausesSection({ reports }: { reports: CacheBreakReport[] }) {
  const byCause = new Map<CacheBreakCause, { occurrences: number; wastedTokens: number; wastedCostUsd: number }>()
  for (const r of reports) for (const o of r.offenders) {
    const cur = byCause.get(o.cause) ?? { occurrences: 0, wastedTokens: 0, wastedCostUsd: 0 }
    cur.occurrences += o.occurrences
    cur.wastedTokens += o.wastedTokens
    cur.wastedCostUsd += o.wastedCostUsd
    byCause.set(o.cause, cur)
  }
  const ranked = [...byCause.entries()].sort((a, b) => (b[1].wastedCostUsd - a[1].wastedCostUsd) || (b[1].wastedTokens - a[1].wastedTokens))
  const maxTok = Math.max(1, ...ranked.map(([, v]) => v.wastedTokens))

  return (
    <div style="margin-bottom:18px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Top cache-break causes</div>
      {ranked.length === 0
        ? <div style="font-size:11px;color:var(--muted)">No cache breaks localised yet — expand sessions in the trace or wait for composition to load.</div>
        : ranked.map(([cause, v]) => (
            <div key={cause} style="display:flex;align-items:center;gap:8px;font-size:11px;min-height:20px">
              <span style="width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={CAUSE_LABEL[cause]}>{CAUSE_LABEL[cause]}</span>
              <div style="flex:1;position:relative;height:10px;max-width:240px">
                <div style={`position:absolute;left:0;height:8px;top:1px;border-radius:2px;width:${Math.max(v.wastedTokens / maxTok * 100, 1).toFixed(1)}%;background:var(--error,#f44747);opacity:0.6`} />
              </div>
              <span style="width:70px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)">{formatCompact(v.wastedTokens)} tok</span>
              <span style="width:60px;text-align:right;font-variant-numeric:tabular-nums">{v.wastedCostUsd > 0 ? '~' + fmtUsd(v.wastedCostUsd) : '—'}</span>
              <span style="width:44px;text-align:right;color:var(--muted)">{v.occurrences}×</span>
            </div>
          ))}
    </div>
  )
}

// ── Section: wasted-$ leaderboard (rank the offending blocks: rules/memories/hooks/tools/files) ─
function LeaderboardSection({ reports }: { reports: CacheBreakReport[] }) {
  const byBlock = new Map<string, OffenderAgg>()
  for (const r of reports) for (const o of r.offenders) {
    const key = `${o.kind}::${o.label}`
    const cur = byBlock.get(key) ?? { label: o.label, kind: o.kind, cause: o.cause, occurrences: 0, wastedTokens: 0, wastedCostUsd: 0, sessions: 0 }
    cur.occurrences += o.occurrences
    cur.wastedTokens += o.wastedTokens
    cur.wastedCostUsd += o.wastedCostUsd
    cur.sessions += 1
    byBlock.set(key, cur)
  }
  const ranked = [...byBlock.values()].sort((a, b) => (b.wastedCostUsd - a.wastedCostUsd) || (b.wastedTokens - a.wastedTokens)).slice(0, 20)

  return (
    <div style="margin-bottom:18px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Wasted-$ leaderboard — blocks by cumulative cache-break cost</div>
      {ranked.length === 0
        ? <div style="font-size:11px;color:var(--muted)">No offending blocks localised yet.</div>
        : (
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead>
              <tr style="color:var(--muted);text-align:left">
                <th style="font-weight:500;padding:2px 6px">Block</th>
                <th style="font-weight:500;padding:2px 6px">Kind</th>
                <th style="font-weight:500;padding:2px 6px;text-align:right">Wasted tok</th>
                <th style="font-weight:500;padding:2px 6px;text-align:right">Wasted $</th>
                <th style="font-weight:500;padding:2px 6px;text-align:right">Breaks</th>
                <th style="font-weight:500;padding:2px 6px;text-align:right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(o => (
                <tr key={o.kind + o.label} style="border-top:1px solid var(--border)">
                  <td style="padding:3px 6px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={o.label}>{o.label}</td>
                  <td style="padding:3px 6px;color:var(--muted)">{o.kind}</td>
                  <td style="padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums">{formatCompact(o.wastedTokens)}</td>
                  <td style="padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">{o.wastedCostUsd > 0 ? '~' + fmtUsd(o.wastedCostUsd) : '—'}</td>
                  <td style="padding:3px 6px;text-align:right;color:var(--muted)">{o.occurrences}</td>
                  <td style="padding:3px 6px;text-align:right;color:var(--muted)">{o.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  )
}

// ── Section: fleet / sub-agent tree — parent + spawned children with cache-warmth badges ──────
// Bounded to the top FLEET_LIMIT fleets by total cost. Children come from a parent→children map
// built ONCE in Cache() — never rescanned per parent. The earlier version filtered allSessions per
// parent (O(roots × allSessions) ≈ 146M ops on a 12k-session dataset, pinning the main thread) AND
// rendered one card per fleet-parent unbounded (~15,900 DOM nodes). Both are fixed here.
const FLEET_LIMIT = 25
const KID_LIMIT = 12 // per-fleet child rows rendered; a giant workflow fleet can spawn hundreds

const kidTok = (c: SessionSummaryCard) => c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreateTokens

function FleetSection({ roots, childrenByParent }: { roots: SessionSummaryCard[]; childrenByParent: Map<string, SessionSummaryCard[]> }) {
  const fleets: { p: SessionSummaryCard; kids: SessionSummaryCard[]; total: number }[] = []
  for (const p of roots) {
    const kids = childrenByParent.get(p.sessionId)
    if (!kids || kids.length === 0) continue
    kids.sort((a, b) => kidTok(b) - kidTok(a)) // biggest children first so the bounded render shows them
    const total = calcSessionCost(p, 'token').totalUsd + kids.reduce((n, c) => n + calcSessionCost(c, 'token').totalUsd, 0)
    fleets.push({ p, kids, total })
  }
  fleets.sort((a, b) => b.total - a.total)

  if (fleets.length === 0) {
    return (
      <div style="margin-bottom:18px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Fleet / sub-agent tree</div>
        <div style="font-size:11px;color:var(--muted)">No sub-agent spawns in range.</div>
      </div>
    )
  }

  const shown = fleets.slice(0, FLEET_LIMIT)
  return (
    <div style="margin-bottom:18px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Fleet / sub-agent tree — aggregate cost + per-child cache-warmth{fleets.length > FLEET_LIMIT ? ` · top ${FLEET_LIMIT} of ${fleets.length}` : ''}</div>
      {shown.map(({ p, kids, total }) => (
        <div key={p.sessionId} style="border:1px solid var(--border);border-radius:4px;margin-bottom:6px;padding:6px 8px">
          <div style="display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:4px">
            <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(p.source) }} />
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={p.userRequest}>{p.userRequest?.slice(0, 80) || formatSessionTime(p)}</span>
            <span style="color:var(--vscode-charts-orange,#e2a03f)" title="parent + fleet total">
              ↳{kids.length} · Σ ~{fmtUsd(total)}
            </span>
          </div>
          {kids.slice(0, KID_LIMIT).map(c => (
            <div key={c.sessionId} style="display:flex;align-items:center;gap:8px;font-size:10px;padding:2px 0 2px 18px;border-left:2px solid var(--vscode-charts-orange,#e2a03f);margin-left:6px">
              {spawnKindBadge(c)}
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)" title={c.userRequest}>{c.userRequest?.slice(0, 60) || c.model}</span>
              <span style="color:var(--muted)">{formatCompact(kidTok(c))} tok</span>
              <span style="width:50px;text-align:right">~{fmtUsd(calcSessionCost(c, 'token').totalUsd)}</span>
            </div>
          ))}
          {kids.length > KID_LIMIT && (
            <div style="font-size:10px;color:var(--muted);padding:2px 0 2px 18px;margin-left:6px;border-left:2px solid var(--border)">+{kids.length - KID_LIMIT} more sub-agents…</div>
          )}
        </div>
      ))}
    </div>
  )
}

export function Cache() {
  const summary = sessionSummary.value
  const base = filteredSessions.value
  const threshold = cacheHitSliThreshold.value
  const allSessions = summary?.sessions ?? []

  // Top-level = sessions that are NOT a shown session's sub-agent (children fold into the fleet tree).
  const shownIds = new Set(base.map(s => s.sessionId))
  const roots = base.filter(s => !s.parentSessionId || !shownIds.has(s.parentSessionId))

  // Precompute parent→children ONCE (single O(allSessions) pass) so FleetSection does O(1) lookups
  // instead of an O(roots × allSessions) rescan per parent (see FleetSection note).
  const childrenByParent = new Map<string, SessionSummaryCard[]>()
  for (const s of allSessions) {
    if (!s.parentSessionId || s.parentSessionId === s.sessionId) continue
    const arr = childrenByParent.get(s.parentSessionId)
    if (arr) arr.push(s)
    else childrenByParent.set(s.parentSessionId, [s])
  }

  // Hydrate a bounded set (timeline + composition) so the cache-break aggregation has data. The
  // hit-rate trend + worst-sessions use the card-level cacheHitRate and don't need this.
  const toHydrate = roots.slice(0, HYDRATE_LIMIT)
  const timelines = sessionTimelines.value
  const compositions = sessionCompositions.value
  useEffect(() => {
    if (!vscode) return
    for (const s of toHydrate) {
      if (timelines[s.sessionId] === undefined) vscode.postMessage({ type: 'loadSessionDetail', sessionId: s.sessionId })
      if (compositions[s.sessionId] === undefined) vscode.postMessage({ type: 'loadContextComposition', sessionId: s.sessionId })
    }
  }, [toHydrate.map(s => s.sessionId).join(','), timelines, compositions])

  // Cache-break reports for every session whose timeline + composition are both resident.
  const reports: CacheBreakReport[] = []
  for (const s of toHydrate) {
    const tl = timelines[s.sessionId]
    const comp = compositions[s.sessionId]
    if (!tl || comp === undefined) continue
    const r = buildCacheBreakReport(s.sessionId, tl, comp, s.model ?? '')
    if (r) reports.push(r)
  }

  if (!allSessions.length) {
    return <div id="summary-cache-content"><div class="empty-state">No sessions recorded yet.</div></div>
  }

  const hydratedCount = reports.length
  const pending = toHydrate.length - toHydrate.filter(s => timelines[s.sessionId] && compositions[s.sessionId] !== undefined).length

  return (
    <div id="summary-cache-content">
      <div class="tab-stats" style="position:sticky;top:0;z-index:5;background:var(--vscode-editor-background,var(--bg))">
        <div><strong class="tab-stat-val">{roots.length}</strong> sessions</div>
        <div><strong class="tab-stat-val">{hydratedCount}</strong> analysed</div>
        <div style="font-size:10px;color:var(--muted)">prompt-cache health · hit-rate SLI, break causes, wasted-$ leaderboard{pending > 0 ? ` · loading ${pending}…` : ''}</div>
      </div>
      <div class="waterfall" style="padding:10px 12px">
        <HitRateSection sessions={roots} threshold={threshold} />
        <CausesSection reports={reports} />
        <LeaderboardSection reports={reports} />
        <FleetSection roots={roots} childrenByParent={childrenByParent} />
      </div>
    </div>
  )
}
