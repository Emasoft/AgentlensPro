import { useState, useEffect } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionCompositions, blobCache,
  focusedSessionId, focusedTurn, activeTab, vscode,
  sessionHistories, requestContextHistory,
} from '../state'
import { formatCompact, formatSessionTime, getAgentDotHtml, formatToolLabel } from '../utils'
import { fmtUsd, calcEntryCost } from '../sessionMetrics'
import { countTokens } from '../tokenEstimator'
import { ResidentCostList } from './HistoryTab'
import type { SessionSummaryCard, TimelineEntry, ContextSource } from '../types'

interface TurnPoint {
  turn: number
  input: number        // NEW (uncached) input tokens this turn
  cacheRead: number    // resident transcript re-read from cache
  cacheWrite: number   // newly written to cache this turn
  output: number
  cost: number
  context: number      // true context window occupancy this turn = input + cacheRead + cacheWrite
  entries: TimelineEntry[]
}

// Fold a session's timeline into one point per turn: the token buckets (exact) + the entries that
// belong to the turn (for the composition drill-down). Context size = input + cacheRead + cacheWrite,
// the real prompt size sent that turn (this is what GROWS turn over turn as the transcript caches up).
function buildTurnPoints(timeline: TimelineEntry[], sessionModel: string): TurnPoint[] {
  const byTurn = new Map<number, TurnPoint>()
  for (const e of timeline) {
    const turn = e.turn ?? 0
    let p = byTurn.get(turn)
    if (!p) {
      p = { turn, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, context: 0, entries: [] }
      byTurn.set(turn, p)
    }
    p.input     += e.inputTokens ?? 0
    p.cacheRead += e.cacheReadTokens ?? 0
    p.cacheWrite += e.cacheCreateTokens ?? 0
    p.output    += e.outputTokens ?? 0
    p.cost      += e.type === 'llm' ? calcEntryCost(e, sessionModel) : 0
    p.entries.push(e)
  }
  const points = [...byTurn.values()].sort((a, b) => a.turn - b.turn)
  for (const p of points) p.context = p.input + p.cacheRead + p.cacheWrite
  return points
}

interface Source { label: string; tokens: number; exact: boolean; kind: string }

// The composition of one turn, sorted heaviest-first. Three layers:
//  1) EXACT token buckets from usage (cache-read = resident transcript, new input, cache-created, output).
//  2) HOST-parsed injected blocks (hook / skill / tool-agent-mcp catalog / file / reminder) from the
//     raw .jsonl — the exact WHICH-block-was-injected data the cache-break diagnosis rests on. These
//     are tokenizer estimates but authoritative about identity; absent until the composition loads.
//  3) ESTIMATED content-level sources (each tool's full output, the assistant response, user text)
//     so you can see WHICH event added the weight — approximated from blob/char length.
function buildSources(p: TurnPoint, blobs: Record<string, string>, hostSources: ContextSource[]): Source[] {
  const out: Source[] = []
  if (p.cacheRead > 0)  out.push({ label: 'Cache-read (resident transcript)', tokens: p.cacheRead, exact: true, kind: 'cacheRead' })
  if (p.input > 0)      out.push({ label: 'New input tokens', tokens: p.input, exact: true, kind: 'input' })
  if (p.cacheWrite > 0) out.push({ label: 'Cache-created (newly cached)', tokens: p.cacheWrite, exact: true, kind: 'cacheWrite' })
  if (p.output > 0)     out.push({ label: 'Model output', tokens: p.output, exact: true, kind: 'output' })

  // Host composition sources for this turn (hooks, catalogs, files, reminders) — the injected blocks
  // the client-side timeline can't see. Their `kind` drives the color legend below.
  for (const s of hostSources) {
    out.push({ label: s.label, tokens: s.tokens, exact: false, kind: s.kind })
  }

  for (const e of p.entries) {
    if (e.type === 'tool') {
      const result = e.fullResult ?? blobs[`${e.spanId}:full-result`] ?? e.resultSummary ?? ''
      if (result) out.push({ label: `${formatToolLabel(e)} → output`, tokens: countTokens(result), exact: false, kind: 'tool' })
      if (e.toolInput) out.push({ label: `${formatToolLabel(e)} → input`, tokens: countTokens(e.toolInput), exact: false, kind: 'tool' })
    } else if (e.type === 'llm' && e.responseText) {
      out.push({ label: 'Assistant response', tokens: countTokens(e.responseText), exact: false, kind: 'llm' })
    } else if (e.type === 'user_input' && e.responseText) {
      out.push({ label: 'User message', tokens: countTokens(e.responseText), exact: false, kind: 'user' })
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

const KIND_COLOR: Record<string, string> = {
  cacheRead:  'var(--vscode-charts-purple,#b392f0)',
  input:      'var(--vscode-charts-blue,#4fc3f7)',
  cacheWrite: 'var(--vscode-charts-orange,#e2a03f)',
  output:     'var(--vscode-charts-green,#81c784)',
  tool:       '#B8E986',
  llm:        'var(--accent)',
  user:       '#F5A623',
  // Host-composition kinds (injected blocks parsed from the raw .jsonl).
  hook:         '#e57373',
  skill:        '#ba68c8',
  toolCatalog:  '#4dd0e1',
  agentCatalog: '#7986cb',
  mcp:          '#4db6ac',
  file:         '#a1887f',
  reminder:     '#fff176',
  other:        'var(--muted)',
}

function TurnRow({ p, maxContext, sessionId, hostSources }: { p: TurnPoint; maxContext: number; sessionId: string; hostSources: ContextSource[] }) {
  const [open, setOpen] = useState(false)
  const blobs = blobCache.value
  const width = maxContext > 0 ? Math.max(p.context / maxContext * 100, 0.5) : 0

  // Clicking a turn jumps to the Sessions tab, opens this session's trace, and highlights the
  // heaviest step of the turn — the same focusedTurn contract the growth chart uses.
  function jumpToTrace() {
    const heaviest = [...p.entries].sort((a, b) =>
      ((b.cacheReadTokens ?? 0) + (b.inputTokens ?? 0)) - ((a.cacheReadTokens ?? 0) + (a.inputTokens ?? 0)))[0]
    focusedSessionId.value = sessionId
    if (heaviest) focusedTurn.value = { sessionId, spanId: heaviest.spanId }
    activeTab.value = 'sessions'
  }

  return (
    <div style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;min-height:26px;font-size:11px;cursor:pointer" onClick={() => setOpen(v => !v)}>
        <span style="width:12px;font-size:8px;color:var(--muted);text-align:center">{open ? '▼' : '▶'}</span>
        <span style="width:56px;font-weight:600;color:var(--vscode-textLink-foreground,#4fc3f7)">Turn {p.turn}</span>
        <div style="flex:1;position:relative;height:16px;margin:0 8px">
          <div style={`position:absolute;left:0;height:14px;top:1px;border-radius:3px;width:${width.toFixed(2)}%;background:${KIND_COLOR.cacheRead};opacity:0.6`} />
        </div>
        <span style="width:120px;text-align:right;padding-right:8px;font-variant-numeric:tabular-nums" title="context window occupancy this turn (new input + cache-read + cache-created)">
          {formatCompact(p.context)} ctx
        </span>
        {p.cost > 0 && <span style="width:64px;text-align:right;padding-right:8px;color:var(--muted)">~{fmtUsd(p.cost)}</span>}
      </div>
      {open && (
        <div style="padding:4px 8px 8px 68px;background:var(--vscode-editorWidget-background,var(--bg))">
          <div style="font-size:9px;color:var(--muted);margin-bottom:4px">
            Composition (sources by weight) — <span style="color:var(--vscode-charts-purple,#b392f0)">cache-read</span> and{' '}
            <span style="color:var(--vscode-charts-orange,#e2a03f)">cache-created</span> shown as distinct buckets.
            <button onClick={e => { e.stopPropagation(); jumpToTrace() }}
              style="margin-left:8px;padding:1px 6px;font-size:9px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7)">Open in trace →</button>
          </div>
          {buildSources(p, blobs, hostSources).map((s, i) => {
            const maxTok = buildSources(p, blobs, hostSources)[0]?.tokens || 1
            const sw = Math.max(s.tokens / maxTok * 100, 0.5)
            return (
              <div key={s.label + i} style="display:flex;align-items:center;font-size:10px;min-height:18px">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px" title={s.label}>{s.label}</span>
                <div style="width:120px;position:relative;height:10px;margin:0 6px">
                  <div style={`position:absolute;left:0;height:8px;top:1px;border-radius:2px;width:${sw.toFixed(2)}%;background:${KIND_COLOR[s.kind] ?? 'var(--muted)'};opacity:0.7`} />
                </div>
                <span style="width:90px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)">
                  {formatCompact(s.tokens)}{s.exact ? '' : '~'} tok
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// TRDD-W0RRL2FZ: lazy per-session resident-cost panel. The full per-step history is a heavy parse
// (a whole-transcript stream on the host), so it is requested ONLY when the user opens the panel —
// never eagerly for every session block on the tab. Shares the sessionHistories cache with the
// History tab, so a session already drilled there renders instantly here (and vice versa).
function SessionResidentCost({ sess }: { sess: SessionSummaryCard }) {
  const [open, setOpen] = useState(false)
  const cached = sess.sessionId in sessionHistories.value
  const history = cached ? sessionHistories.value[sess.sessionId] : undefined

  useEffect(() => {
    if (open) requestContextHistory(sess.sessionId, sess.parentSessionId)
  }, [open, sess.sessionId, cached])

  if (!open) {
    return (
      <div style="display:flex;align-items:center;gap:10px;min-height:24px;font-size:11px;cursor:pointer;padding:0 6px;border-top:1px solid var(--border)" onClick={() => setOpen(true)}>
        <span style="width:12px;font-size:8px;color:var(--muted);text-align:center">▶</span>
        <span style="font-weight:700">Top resident-cost blocks</span>
        <span style="font-size:9px;color:var(--muted)">tokens × turns-resident — click to reconstruct from the transcript</span>
      </div>
    )
  }
  if (!cached) {
    return <div style="padding:6px 26px;font-size:10px;color:var(--muted);border-top:1px solid var(--border)">Reconstructing context history…</div>
  }
  if (!history || history.steps.length === 0) {
    // Honest terminal states — an OTEL-only session (null) or a fork whose transcript lives in the
    // parent (empty steps) cannot be itemized; say so instead of spinning.
    return (
      <div style="padding:6px 26px;font-size:10px;color:var(--muted);border-top:1px solid var(--border)">
        {history?.reconstructedFrom
          ? `transcript lives in parent ${history.reconstructedFrom}`
          : 'No local Claude transcript to reconstruct — OTEL-only session.'}
      </div>
    )
  }
  return <ResidentCostList history={history} defaultOpen={true} />
}

function ContextSessionBlock({ sess, depth }: { sess: SessionSummaryCard; depth: number }) {
  const [collapsed, setCollapsed] = useState(depth > 0)
  const timelines = sessionTimelines.value
  const loaded = timelines[sess.sessionId]
  const loading = !collapsed && loaded === undefined && !!vscode

  // Host-parsed per-turn composition (injected blocks). Lazily requested on open, same lifecycle
  // as the timeline; a plain undefined means "not yet fetched", null means "no local Claude log".
  const composition = sessionCompositions.value[sess.sessionId]

  useEffect(() => {
    if (!collapsed && loaded === undefined && vscode) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
    if (!collapsed && composition === undefined && vscode) {
      vscode.postMessage({ type: 'loadContextComposition', sessionId: sess.sessionId })
    }
  }, [sess.sessionId, collapsed])

  const timeline = loaded ?? sess.timeline ?? []
  const points = buildTurnPoints(timeline.filter(e => e.type !== 'background'), sess.model ?? '')
  const maxContext = Math.max(sess.peakContextPerTurn ?? 0, ...points.map(p => p.context), 1)

  // turn number → the host composition sources for that turn (empty when composition absent).
  const hostByTurn = new Map<number, ContextSource[]>()
  for (const t of composition?.turns ?? []) hostByTurn.set(t.turn, t.sources)

  // Sub-agent / fork sessions spawned by this one render as nested sub-branches (P2.3). Uses the
  // parentSessionId backbone; inert until the extension-side session-to-session linkage populates it.
  const children = (sessionSummary.value?.sessions ?? []).filter(s => s.parentSessionId === sess.sessionId && s.sessionId !== sess.sessionId)

  return (
    <div style={depth > 0 ? 'border-left:2px solid var(--border);margin-left:10px' : ''}>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--hover);border:1px solid var(--border);border-radius:4px 4px 0 0;cursor:pointer;font-size:11px"
        onClick={() => setCollapsed(v => !v)}>
        <span>
          <span style="font-size:10px;margin-right:6px">{collapsed ? '▶' : '▼'}</span>
          <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(sess.source) }} />{' '}
          <span style="color:var(--muted)">{formatSessionTime(sess)}</span>{' '}
          {depth > 0 && <span style="color:var(--vscode-charts-orange,#e2a03f);font-size:9px;margin-right:4px">sub-agent</span>}
          {sess.userRequest ? <>"{sess.userRequest.slice(0, 80)}"</> : <span style="color:var(--muted)">[no prompt]</span>}
        </span>
        <span style="color:var(--muted)">
          {points.length} turns · peak {formatCompact(maxContext)} ctx
        </span>
      </div>
      {!collapsed && (
        <div style="border:1px solid var(--border);border-top:none;border-radius:0 0 4px 4px;margin-bottom:10px">
          {/* TRDD-W0RRL2FZ: which blocks actually accumulated this session's context bill. */}
          <SessionResidentCost sess={sess} />
          {loading
            ? <div style="padding:10px;font-size:11px;color:var(--muted)">Loading context trace…</div>
            : points.length === 0
              ? <div style="padding:10px;font-size:11px;color:var(--muted)">No per-turn token data for this session.</div>
              : points.map(p => <TurnRow key={p.turn} p={p} maxContext={maxContext} sessionId={sess.sessionId} hostSources={hostByTurn.get(p.turn) ?? []} />)}
          {children.map(c => <ContextSessionBlock key={c.sessionId} sess={c} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

export function Context() {
  const summary = sessionSummary.value
  const base = filteredSessions.value
  if (!summary?.sessions?.length) {
    return <div id="summary-context-content"><div class="empty-state">No sessions recorded yet.</div></div>
  }
  // Top-level = sessions that are NOT a sub-agent of another shown session (children render nested).
  const shownIds = new Set(base.map(s => s.sessionId))
  const roots = base.filter(s => !s.parentSessionId || !shownIds.has(s.parentSessionId))
  const sessionsToShow = [...roots].reverse()

  return (
    <div id="summary-context-content">
      <div class="tab-stats" style="position:sticky;top:0;z-index:5;background:var(--vscode-editor-background,var(--bg))">
        <div><strong class="tab-stat-val">{sessionsToShow.length}</strong> sessions</div>
        <div><strong class="tab-stat-val">{formatCompact(Math.max(0, ...base.map(s => s.peakContextPerTurn ?? s.inputTokens + s.cacheReadTokens)))}</strong> peak context</div>
        <div style="font-size:10px;color:var(--muted)">context size per turn · expand a turn for its composition</div>
      </div>
      <div class="waterfall">
        {sessionsToShow.map(sess => <ContextSessionBlock key={sess.sessionId} sess={sess} depth={0} />)}
      </div>
    </div>
  )
}
