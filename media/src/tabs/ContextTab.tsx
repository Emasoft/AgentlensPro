import { useState, useEffect, useMemo, useRef, useCallback } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionCompositions, blobCache,
  focusedSessionId, focusedTurn, activeTab, vscode,
  sessionHistories, requestContextHistory,
} from '../state'
import { formatCompact, formatSessionTime, getAgentDotHtml, formatToolLabel } from '../utils'
import { fmtUsd, calcEntryCost } from '../sessionMetrics'
import { countTokens } from '../tokenEstimator'
import { ResidentCostList } from './HistoryTab'
import type { SessionSummaryCard, TimelineEntry, ContextSource, ContextComposition } from '../types'

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

// ── Virtualized flat-row rendering (TRDD-PW0H2NXC) ─────────────────────────────
// Before this, the Context tab mounted the FULL session → turn → sub-agent tree at once: on real
// data that was 141k–156k DOM nodes (~2.1 MB innerText), which hung interaction scripting, froze
// screenshots, and degraded scrolling/theming for everyone. The fix flattens the whole *visible*
// tree into ONE ordered row array and renders it INCREMENTALLY against the PAGE's own scroll — the
// exact append-on-sentinel pattern the Sessions tab uses (INITIAL_RENDER rows on first paint, then
// RENDER_BATCH more each time a viewport-anchored sentinel nears the screen). At rest only
// INITIAL_RENDER rows mount, so the DOM stays tiny no matter how large or deep the tree is. No inner
// overflow box is introduced (no-nested-scrollbars rule): the document's own scrollbar is the only
// one. Nothing is capped — every session/turn stays reachable by scrolling, and heavy block bodies
// (timeline, host composition, resident-cost, per-turn composition) are still fetched lazily, now
// only when a session's header row is actually on screen instead of eagerly for every root at once.

const INITIAL_RENDER = 60   // rows mounted on first paint
const RENDER_BATCH = 60     // rows appended per sentinel hit / Show-more click

// One row of the flattened Context list. A collapsed session is a single `session` row; expanding it
// contributes its `resident` row, its `turn` rows (or one `info` placeholder), then its sub-agent
// children (recursively) — which is why the at-rest row count tracks the number of VISIBLE nodes,
// not the total tree size.
type ContextRow =
  | { kind: 'session'; key: string; depth: number; sess: SessionSummaryCard; expanded: boolean; turnsCount: number; maxContext: number }
  | { kind: 'resident'; key: string; depth: number; sess: SessionSummaryCard }
  | { kind: 'turn'; key: string; depth: number; sess: SessionSummaryCard; point: TurnPoint; maxContext: number; hostSources: ContextSource[] }
  | { kind: 'info'; key: string; depth: number; text: string }

// Flatten the session → turn → sub-agent tree into the ordered rows the user would SEE if every
// expanded branch were fully drawn. The default expand state is IDENTICAL to the pre-virtualization
// behaviour: root sessions (depth 0) open, sub-agent branches (depth > 0) collapsed. The `toggled`
// set simply FLIPS that per-session default, so "expand any block on demand" is a one-line toggle and
// no data is ever lost — a collapsed session still shows its turns/peak in the header, and expanding
// it reveals the full content. Only EXPANDED sessions emit resident/turn/child rows.
function buildContextRows(
  sessionsToShow: SessionSummaryCard[],
  allSessions: SessionSummaryCard[],
  toggled: ReadonlySet<string>,
  timelines: Record<string, TimelineEntry[]>,
  compositions: Record<string, ContextComposition | null>,
): ContextRow[] {
  const rows: ContextRow[] = []
  const isExpanded = (id: string, depth: number) => (toggled.has(id) ? depth > 0 : depth === 0)

  // Precompute parent → children ONCE (O(n)). Each expanded node used to run
  // allSessions.filter(...) = O(n); with ~n root sessions expanded by default that was O(n²)
  // (≈146M ops on a 12k-session dataset — the same pathology fixed for the Cache-tab fleet tree).
  // Skips self-parented sessions (pid === own id) to match the old `s.sessionId !== sess.sessionId`
  // guard, and preserves allSessions order so nested branches render in the same sequence as before.
  const childrenByParent = new Map<string, SessionSummaryCard[]>()
  for (const s of allSessions) {
    const pid = s.parentSessionId
    if (!pid || pid === s.sessionId) continue
    const arr = childrenByParent.get(pid)
    if (arr) arr.push(s)
    else childrenByParent.set(pid, [s])
  }

  const walk = (sess: SessionSummaryCard, depth: number) => {
    const loaded = timelines[sess.sessionId]
    const timeline = loaded ?? sess.timeline ?? []
    // Header turns/peak are shown for collapsed sessions too, so points are derived for every node.
    // This is cheap for a collapsed session: it only has its lightweight card timeline until opened.
    const points = buildTurnPoints(timeline.filter(e => e.type !== 'background'), sess.model ?? '')
    const maxContext = Math.max(sess.peakContextPerTurn ?? 0, ...points.map(p => p.context), 1)
    const expanded = isExpanded(sess.sessionId, depth)
    rows.push({ kind: 'session', key: 's:' + sess.sessionId, depth, sess, expanded, turnsCount: points.length, maxContext })
    if (!expanded) return

    // TRDD-W0RRL2FZ: which blocks actually accumulated this session's context bill.
    rows.push({ kind: 'resident', key: 'r:' + sess.sessionId, depth, sess })
    if (loaded === undefined && vscode) {
      rows.push({ kind: 'info', key: 'load:' + sess.sessionId, depth, text: 'Loading context trace…' })
    } else if (points.length === 0) {
      rows.push({ kind: 'info', key: 'empty:' + sess.sessionId, depth, text: 'No per-turn token data for this session.' })
    } else {
      // turn number → host-parsed composition sources for that turn (empty when composition absent).
      const composition = compositions[sess.sessionId]
      const hostByTurn = new Map<number, ContextSource[]>()
      for (const t of composition?.turns ?? []) hostByTurn.set(t.turn, t.sources)
      for (const p of points) {
        rows.push({ kind: 'turn', key: `t:${sess.sessionId}:${p.turn}`, depth, sess, point: p, maxContext, hostSources: hostByTurn.get(p.turn) ?? [] })
      }
    }
    // Sub-agent / fork sessions spawned by this one render as nested sub-branches AFTER the parent's
    // turns (order unchanged). Uses the parentSessionId backbone against the FULL session list, not
    // the filtered view, so a child hidden by a filter still nests under its shown parent.
    const children = childrenByParent.get(sess.sessionId) ?? []
    for (const c of children) walk(c, depth + 1)
  }

  for (const s of sessionsToShow) walk(s, 0)
  return rows
}

function SessionHeaderRow({ row, onToggle }: { row: Extract<ContextRow, { kind: 'session' }>; onToggle: (id: string) => void }) {
  const { sess, depth, expanded, turnsCount, maxContext } = row

  // Fetch this session's heavy block bodies (timeline + host composition) lazily — only once its
  // header row is mounted (i.e. within the rendered window) AND it is expanded. This replaces the
  // pre-virtualization behaviour that fired a load for EVERY root session the instant the tab opened
  // (a postMessage thundering-herd on large datasets). `peek()` reads the cache without subscribing,
  // so a later cache update doesn't re-run this effect and re-post; the [sessionId, expanded] deps do.
  useEffect(() => {
    if (!expanded || !vscode) return
    if (sessionTimelines.peek()[sess.sessionId] === undefined) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
    if (sessionCompositions.peek()[sess.sessionId] === undefined) {
      vscode.postMessage({ type: 'loadContextComposition', sessionId: sess.sessionId })
    }
  }, [sess.sessionId, expanded])

  return (
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--hover);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px"
      onClick={() => onToggle(sess.sessionId)}>
      <span>
        <span style="font-size:10px;margin-right:6px">{expanded ? '▼' : '▶'}</span>
        <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(sess.source) }} />{' '}
        <span style="color:var(--muted)">{formatSessionTime(sess)}</span>{' '}
        {depth > 0 && <span style="color:var(--vscode-charts-orange,#e2a03f);font-size:9px;margin-right:4px">sub-agent</span>}
        {sess.userRequest ? <>"{sess.userRequest.slice(0, 80)}"</> : <span style="color:var(--muted)">[no prompt]</span>}
      </span>
      <span style="color:var(--muted)">
        {turnsCount} turns · peak {formatCompact(maxContext)} ctx
      </span>
    </div>
  )
}

// Render one flattened row. Depth indent + a left rule reproduce the old nested border-left staircase
// (a flat list can't wrap a whole branch in one box, but a per-row left rule reads the same).
function ContextRowView({ row, onToggle }: { row: ContextRow; onToggle: (id: string) => void }) {
  const indent = row.depth > 0 ? `margin-left:${row.depth * 10}px;border-left:2px solid var(--border);padding-left:2px` : ''
  let inner: ComponentChildren = null
  switch (row.kind) {
    case 'session':  inner = <SessionHeaderRow row={row} onToggle={onToggle} />; break
    case 'resident': inner = <SessionResidentCost sess={row.sess} />; break
    case 'turn':     inner = <TurnRow p={row.point} maxContext={row.maxContext} sessionId={row.sess.sessionId} hostSources={row.hostSources} />; break
    case 'info':     inner = <div style="padding:10px;font-size:11px;color:var(--muted)">{row.text}</div>; break
  }
  return <div style={indent}>{inner}</div>
}

export function Context() {
  const summary = sessionSummary.value
  const base = filteredSessions.value
  const timelines = sessionTimelines.value
  const compositions = sessionCompositions.value
  const allSessions = summary?.sessions ?? []

  // `toggled` flips the depth-based default expand state per session (see buildContextRows). A Set in
  // component state keeps expand/collapse local to this tab and rebuilds the row list on every toggle.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set())
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Rebuild the flat rows only when an input reference actually changes (signals hand back a new
  // reference on update), so a huge tree isn't re-flattened on every unrelated render.
  const { rows, rootCount } = useMemo(() => {
    // Top-level = sessions that are NOT a sub-agent of another shown session (children render nested).
    const shownIds = new Set(base.map(s => s.sessionId))
    const roots = base.filter(s => !s.parentSessionId || !shownIds.has(s.parentSessionId))
    const sessionsToShow = [...roots].reverse()
    return { rows: buildContextRows(sessionsToShow, allSessions, toggled, timelines, compositions), rootCount: sessionsToShow.length }
  }, [base, allSessions, toggled, timelines, compositions])

  const totalRef = useRef(0)
  totalRef.current = rows.length

  // Window-scroll incremental mount (no inner scroll box): grow the mounted slice when the sentinel
  // nears the viewport. Mirrors the Sessions tab so both large lists behave identically. rootMargin
  // 800px pre-loads the next batch just before it scrolls into view.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setRenderCount(c => (c < totalRef.current ? c + RENDER_BATCH : c)) },
      { root: null, rootMargin: '800px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rows.length === 0])

  const toggle = useCallback((id: string) => {
    setToggled(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  if (!summary?.sessions?.length) {
    return <div id="summary-context-content"><div class="empty-state">No sessions recorded yet.</div></div>
  }

  // Totals are derived from the session data, never from the mounted DOM (spec 3).
  const peakContext = Math.max(0, ...base.map(s => s.peakContextPerTurn ?? s.inputTokens + s.cacheReadTokens))

  return (
    <div id="summary-context-content">
      <div class="tab-stats" style="position:sticky;top:0;z-index:5;background:var(--vscode-editor-background,var(--bg))">
        <div><strong class="tab-stat-val">{rootCount}</strong> sessions</div>
        <div><strong class="tab-stat-val">{formatCompact(peakContext)}</strong> peak context</div>
        <div style="font-size:10px;color:var(--muted)">context size per turn · expand a turn for its composition</div>
      </div>
      {/* Plain block (no `.waterfall` inner-scroll box): the flat list uses the PAGE scroll so only
          one scrollbar exists and the incremental sentinel keys off the real viewport. */}
      <div>
        {rows.slice(0, renderCount).map(row => (
          <ContextRowView key={row.key} row={row} onToggle={toggle} />
        ))}
      </div>
      {/* Infinite-scroll sentinel — observed (rootMargin 800px) to append the next batch early. */}
      <div ref={sentinelRef} style="height:1px" />
      {renderCount < rows.length && (
        <div style="padding:6px 8px;font-size:11px;color:var(--muted);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button
            onClick={() => setRenderCount(c => Math.min(c + RENDER_BATCH, rows.length))}
            style="padding:2px 10px;font-size:11px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7)"
          >Show more</button>
          <span>Showing {Math.min(renderCount, rows.length).toLocaleString()} of {rows.length.toLocaleString()} rows</span>
        </div>
      )}
    </div>
  )
}
