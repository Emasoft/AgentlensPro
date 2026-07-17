import { useState, useEffect, useRef, useMemo } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionCompositions, blobCache,
  focusedSessionId, vscode, cacheHitSliThreshold, callContexts,
  timelineMetric, timelineSortByValue, timelineGroupByTurn, sessionGeneratedFiles, timeRange,
} from '../state'
import { GeneratedFilesList } from '../GeneratedFilesView'
import { CopyBranchButton } from '../CopyBranchButton'
import type { TimelineMetric } from '../state'
import {
  formatMs, formatCompact, syntaxHighlightJson,
  getAgentDotHtml, formatLlmLabel, formatToolLabel, formatToolResult,
  sessionDateKey, formatDayLabel, formatSessionTime,
} from '../utils'
import { calcEntryCost, calcSessionCost, fmtUsd } from '../sessionMetrics'
import { countTokens } from '../tokenEstimator'
import { buildCacheBreakReport, cacheBreaksByTurn, CAUSE_LABEL, diffTurnSources } from '../../../src/shared/cacheBreak'
import { contextTokens } from '../../../src/shared/tokenBuckets'
import { buildTokensByCause, CAUSE_DIMENSION_LABEL } from '../../../src/shared/tokensByCause'
import { entryBeforeWindow } from '../../../src/shared/timeWindow'
import { spawnKindBadge, hitRateColor, formatPct, SpawnCostPanel } from './cacheShared'
import { BlockRow } from './HistoryTab'
import type { SessionSummaryCard, TimelineEntry, BackgroundSpanSummary, CacheBreakTurn, ContextSource, CallContext, CauseDimension, TurnSourceDiff } from '../types'

// Colour per composition source-kind — shared with the ContextTab legend so the LLM-call context
// breakdown reads the same as the Context tab. Injected-block kinds (hook/skill/catalog/…) plus the
// exact usage buckets (cacheRead/input/cacheWrite/output).
const SOURCE_KIND_COLOR: Record<string, string> = {
  cacheRead: 'var(--vscode-charts-purple,#b392f0)', input: 'var(--vscode-charts-blue,#4fc3f7)',
  cacheWrite: 'var(--vscode-charts-orange,#e2a03f)', output: 'var(--vscode-charts-green,#81c784)',
  hook: '#e57373', skill: '#ba68c8', toolCatalog: '#4dd0e1', agentCatalog: '#7986cb',
  mcp: '#4db6ac', file: '#a1887f', reminder: '#fff176', tool: '#B8E986', other: 'var(--muted)',
  cost: 'var(--vscode-charts-yellow,#e2c08d)', user: '#F5A623', llm: 'var(--accent)',
}

export interface Step {
  entry: TimelineEntry
  offsetMs: number
  durationMs: number
}

// ── Timeline bar metric ───────────────────────────────────────────────────────
// The Trace waterfall can size each step's bar by elapsed Time (the chronological
// default) OR by a token/cost magnitude, so the same timeline doubles as a per-step
// token/cost bar chart. TimelineMetric now lives in state.ts (hoisted so the toggle is a
// single shared signal — P2.1) and is re-exported here for the components below.
export type { TimelineMetric } from '../state'

const TIMELINE_METRICS: Array<{ k: TimelineMetric; label: string }> = [
  { k: 'time',       label: 'Time' },
  { k: 'input',      label: 'Input' },
  { k: 'output',     label: 'Output' },
  { k: 'cacheRead',  label: 'Cache rd' },
  { k: 'cacheWrite', label: 'Cache wr' },
  { k: 'cost',       label: 'Cost' },
]

// Magnitude a step contributes for the chosen metric (bar width + sort key). 'time' is
// handled separately — it uses the chronological offset + duration, not this value.
function stepMetricValue(entry: TimelineEntry, metric: TimelineMetric, sessionModel: string): number {
  switch (metric) {
    case 'input':      return entry.inputTokens ?? 0
    case 'output':     return entry.outputTokens ?? 0
    case 'cacheRead':  return entry.cacheReadTokens ?? 0
    case 'cacheWrite': return entry.cacheCreateTokens ?? 0
    case 'cost':       return entry.type === 'llm' ? calcEntryCost(entry, sessionModel) : 0
    default:           return 0
  }
}

// Bar colour per metric — so flipping the metric visibly recolours the chart. 'time' keeps the
// per-step-type colour (set in StepRow); the rest match their token-composition colours elsewhere.
const METRIC_COLOR: Record<TimelineMetric, string> = {
  time:       'var(--accent)',
  input:      'var(--vscode-charts-blue,#4fc3f7)',
  output:     'var(--vscode-charts-green,#81c784)',
  cacheRead:  'var(--vscode-charts-purple,#b392f0)',
  cacheWrite: 'var(--vscode-charts-orange,#e2a03f)',
  cost:       'var(--vscode-charts-yellow,#e2c08d)',
}

// The wf-info label for a non-time metric: tokens compacted (1.2k), cost as ~$, '—' when zero
// (e.g. tool/user steps carry no token attribution — those belong to the LLM calls).
function formatMetricValue(metric: TimelineMetric, v: number): string {
  if (v <= 0) return '—'
  return metric === 'cost' ? '~' + fmtUsd(v) : formatCompact(v)
}

// Aggregate the 5 values across a set of steps (a turn = sum of its children). Tokens live on
// the first row of the assistant message, so a plain sum over the turn's steps is correct and
// never double-counts. cacheRead vs cacheWrite are kept DISTINCT — that split IS the per-turn
// cache-read vs cache-created diff the spec asks for.
interface TurnTotals { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; durationMs: number }
function sumSteps(steps: Step[], sessionModel: string): TurnTotals {
  const t: TurnTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, durationMs: 0 }
  for (const s of steps) {
    const e = s.entry
    t.input      += e.inputTokens ?? 0
    t.output     += e.outputTokens ?? 0
    t.cacheRead  += e.cacheReadTokens ?? 0
    t.cacheWrite += e.cacheCreateTokens ?? 0
    t.cost       += e.type === 'llm' ? calcEntryCost(e, sessionModel) : 0
    t.durationMs += s.durationMs
  }
  return t
}
// The value a turn contributes for the selected metric (drives the turn-header bar width + sort).
function turnMetricValue(t: TurnTotals, metric: TimelineMetric): number {
  switch (metric) {
    case 'time':       return t.durationMs
    case 'input':      return t.input
    case 'output':     return t.output
    case 'cacheRead':  return t.cacheRead
    case 'cacheWrite': return t.cacheWrite
    case 'cost':       return t.cost
    default:           return 0
  }
}

// The compact 5-value strip shown on every tree level (turn header AND the session summary).
// input ↑ · output ↓ · cache-read · cache-write (the diff split) · hit-rate · cost. cache-READ and
// cache-CREATED are kept as DISTINCT values so the prefix-cache reuse vs re-write split is legible.
function FiveValues({ t }: { t: TurnTotals }) {
  const cacheTotal = t.cacheRead + t.cacheWrite
  const hitRate = cacheTotal > 0 ? t.cacheRead / cacheTotal : null
  const hitColor = hitRate === null ? 'var(--muted)'
    : hitRate >= 0.9 ? 'var(--vscode-charts-green,#81c784)'
    : hitRate >= 0.5 ? 'var(--vscode-charts-orange,#e2a03f)' : 'var(--error,#f44747)'
  return (
    <span style="display:inline-flex;gap:8px;align-items:center;font-size:9px;white-space:nowrap;font-variant-numeric:tabular-nums">
      <span title="new input tokens" style={'color:' + METRIC_COLOR.input}>↑{formatCompact(t.input)}</span>
      <span title="output tokens" style={'color:' + METRIC_COLOR.output}>↓{formatCompact(t.output)}</span>
      <span title="cache-read tokens (re-read from cache — cheap)" style={'color:' + METRIC_COLOR.cacheRead}>⟳{formatCompact(t.cacheRead)}</span>
      <span title="cache-created tokens (newly written to cache — full write rate)" style={'color:' + METRIC_COLOR.cacheWrite}>✦{formatCompact(t.cacheWrite)}</span>
      {hitRate !== null && (
        <span title="cache hit rate this turn = cache-read / (cache-read + cache-created)" style={'color:' + hitColor}>
          {(hitRate * 100).toFixed(0)}% hit
        </span>
      )}
      {t.cost > 0 && <span title="cost" style={'color:' + METRIC_COLOR.cost}>~{fmtUsd(t.cost)}</span>}
    </span>
  )
}

// Searchable text for a step — the tool/command-bearing fields (label, action verb, raw tool
// input incl. bash command / file path, result summary, edited file paths). Lets the timeline
// filter match e.g. a bash `gh repo` call or a Read under `server/scripts`.
function stepHaystack(entry: TimelineEntry): string {
  const parts: string[] = [entry.label || '', entry.action || '', entry.toolInput || '', entry.resultSummary || '']
  if (entry.editDetails) for (const d of entry.editDetails) if (d.filePath) parts.push(d.filePath)
  // TRDD-UBEP5XY7: structured cause tokens so a "Tokens by cause" row click filters the trace to
  // exactly its calls via the existing filter box (`cause:agent=foo` never collides with free text).
  if (entry.querySource)   parts.push(`cause:querysource=${entry.querySource}`)
  if (entry.agentName)     parts.push(`cause:agent=${entry.agentName}`)
  if (entry.skillName)     parts.push(`cause:skill=${entry.skillName}`)
  if (entry.pluginName)    parts.push(`cause:plugin=${entry.pluginName}`)
  if (entry.mcpServerName) parts.push(`cause:mcpserver=${entry.mcpServerName}`)
  if (entry.mcpToolName)   parts.push(`cause:mcptool=${entry.mcpServerName ?? '?'}/${entry.mcpToolName}`)
  return parts.join('\n').toLowerCase()
}

// The filter token a by-cause row click applies — must produce the same string stepHaystack embeds.
// mcpTool keys as "server/tool" (mirrors tokensByCause causeKey) so same-named tools never merge.
function causeFilterToken(dim: CauseDimension, key: string): string {
  return `cause:${dim.toLowerCase()}=${key}`
}

// Compile the timeline filter into a predicate. '*' is a glob wildcard (any run of chars), every
// other char is literal — so `server/script_*.ts` matches that path while `gh repo` is a plain
// substring. All regex metachars except '*' are escaped, so user input can never throw. Empty → all.
function compileStepFilter(raw: string): (haystack: string) => boolean {
  const q = raw.trim().toLowerCase()
  if (!q) return () => true
  if (q.includes('*')) {
    const pattern = q.split('*').map(seg => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    const re = new RegExp(pattern)
    return h => re.test(h)
  }
  return h => h.includes(q)
}



function BgSummaryBlock({ bgSpans }: { bgSpans: BackgroundSpanSummary[] }) {
  const [open, setOpen] = useState(false)
  if (!bgSpans?.length) return null

  const groups: Record<string, { count: number; tokens: number; model: string }> = {}
  let totalTokens = 0
  bgSpans.forEach(bg => {
    const key = bg.purpose || bg.name || 'Unknown'
    if (!groups[key]) groups[key] = { count: 0, tokens: 0, model: bg.model || '' }
    groups[key].count++
    const tok = (bg.inputTokens ?? 0) + (bg.outputTokens ?? 0)
    groups[key].tokens += tok
    totalTokens += tok
  })

  const descriptions: Record<string, string> = {
    'Generate chat title': 'Creates the title shown in the chat history sidebar.',
    'Generate progress messages': 'Produces the status messages shown while the agent works.',
    'Extension language model call': 'LLM call made by a VS Code extension — often used for completions or inline suggestions.',
  }

  const purposes = Object.keys(groups).sort((a, b) => groups[b].tokens - groups[a].tokens)

  return (
    <div class="sw-bg-group">
      <div class="sw-bg-header" onClick={() => setOpen(v => !v)}>
        <span class="sw-bg-chevron">{open ? '▼' : '▶'}</span>{' '}
        <span>Background Overhead</span>
        <span class="sw-bg-summary">{bgSpans.length} calls · {totalTokens.toLocaleString()} tokens</span>
      </div>
      {open && (
        <div class="sw-bg-body">
          <div class="sw-bg-note">Automatic LLM calls that ran alongside this prompt. These are not part of your agent session but still consume tokens.</div>
          {purposes.map(purpose => (
            <div key={purpose} class="sw-bg-item">
              <div class="sw-bg-item-header">
                <span class="sw-bg-item-name">{purpose}</span>
                <span class="sw-bg-item-stats">{groups[purpose].count}× · {groups[purpose].tokens.toLocaleString()} tok · {groups[purpose].model}</span>
              </div>
              {descriptions[purpose] && <div class="sw-bg-item-desc">{descriptions[purpose]}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// One VERTICAL field in the expanded LLM-call detail: heading ON TOP, value FULL-WIDTH BELOW. This
// replaces the old `.sw-detail-section` flex-ROW (label 130px | value) that laid the call-detail
// fields out as side-by-side columns — the user asked for a single vertical stack so the context
// tree can grow full-width beneath the usage line (TRDD-ICHAVFCS layout fix). heading is a node so a
// field can carry an inline "Show full" button.
function LlmField({ heading, children }: { heading: ComponentChildren; children: ComponentChildren }) {
  return (
    <div style="padding:4px 0">
      <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin-bottom:3px">{heading}</div>
      <div style="color:var(--fg);word-break:break-word;font-size:12px">{children}</div>
    </div>
  )
}

// The per-call attribution line — WHO caused this call. Built from the rich api_request fields
// (mirror of summarizerTypes) when present; empty string when the call carries no attribution (a
// plain llm span). Rendered as "issued by: <query_source> · agent X · skill Y · plugin Z · mcp S/T".
function formatAttribution(entry: TimelineEntry): string {
  const parts: string[] = []
  if (entry.querySource) parts.push(entry.querySource)
  if (entry.agentName) parts.push(`agent ${entry.agentName}`)
  if (entry.skillName) parts.push(`skill ${entry.skillName}`)
  if (entry.pluginName) parts.push(`plugin ${entry.pluginName}`)
  if (entry.mcpServerName) parts.push(`mcp ${entry.mcpServerName}${entry.mcpToolName ? '/' + entry.mcpToolName : ''}`)
  return parts.join(' · ')
}

// Cache key for a call's reconstructed literal context. Prefer the request_id (the stable id that
// correlates the api_request event, the llm_request span, and the raw body file); fall back to the
// span id for plain llm spans that carry no request_id.
function ctxKey(sessionId: string, entry: TimelineEntry): string {
  return `${sessionId}::${entry.requestId ? 'req:' + entry.requestId : 'span:' + entry.spanId}`
}

// The WHOLE literal context of ONE llm call, reconstructed by the host from Claude Code's raw OTEL
// request body and served at /api/callcontext (TRDD-ICHAVFCS). LAZY: this component only mounts when
// the call row is expanded, and it fetches once per (session, call), caching in the `callContexts`
// module signal. Every block renders with the History-tab BlockRow (kind badge + tokens + role +
// expand → full text in a wrapping <pre>, no inner scrollbar). This is the fix for OTEL-only
// sessions that have no local .jsonl — the content comes from the raw body, not a transcript on disk.
function CallContextTree({ sessionId, entry }: { sessionId: string; entry: TimelineEntry }) {
  const key = ctxKey(sessionId, entry)
  const cc = callContexts.value[key]   // undefined = not fetched · null = fetched, none captured · CallContext = data
  useEffect(() => {
    if (callContexts.value[key] !== undefined) return
    let cancelled = false
    // requestId → path segment; otherwise the spanId goes on the ?span= query the host resolves.
    const url = entry.requestId
      ? `/api/callcontext/${encodeURIComponent(sessionId)}/${encodeURIComponent(entry.requestId)}`
      : `/api/callcontext/${encodeURIComponent(sessionId)}?span=${encodeURIComponent(entry.spanId)}`
    fetch(url)
      .then(r => r.json())
      .then((data: { callContext: CallContext | null }) => {
        if (cancelled) return
        callContexts.value = { ...callContexts.value, [key]: data.callContext ?? null }
      })
      .catch(() => { if (!cancelled) callContexts.value = { ...callContexts.value, [key]: null } })
    return () => { cancelled = true }
  }, [key])

  if (cc === undefined) return <div style="font-size:10px;color:var(--muted);padding:4px 0">Reconstructing the full context of this call from its raw request body…</div>
  // Honest terminal note — never a perpetual spinner, never "check the previous turn".
  if (cc === null) return <div style="font-size:10px;color:var(--muted);padding:4px 0">Raw body not captured for this call (recorded before raw-body logging was enabled, or OTEL-only pre-restart).</div>
  if (cc.blocks.length === 0) return <div style="font-size:10px;color:var(--muted);padding:4px 0">The raw request body was captured but held no context blocks.</div>
  const totalTok = cc.blocks.reduce((n, b) => n + b.tokens, 0)
  return (
    <div>
      <div style="font-size:9px;color:var(--muted);margin-bottom:4px">
        {cc.blocks.length} blocks · {formatCompact(totalTok)} tok — the whole literal context sent to {cc.model || 'the model'} on this call (system, every message, tool inputs/outputs, reasoning). Expand any block for its full text.
      </div>
      {cc.blocks.map(b => <BlockRow key={b.id} block={b} added={false} changed={false} isBreak={false} />)}
      {cc.truncated && <div style="font-size:9px;color:var(--muted);padding:4px 0;font-style:italic">… context truncated (very large body).</div>}
    </div>
  )
}

// The per-call context-composition breakdown shown when an LLM call is expanded — answers "why is
// this N cache-write / cache-read?" and lets the user DRILL each bucket down to the ACTUAL injected
// blocks and their content (P6). It renders the same recursive bar-tree the turn-level view uses
// (TreeBar + compositionNodes): the EXACT usage buckets (cache-read / new-input / cache-created) are
// the top bars, and the HOST-parsed injected blocks (CLAUDE.md, each rule, each memory, hooks,
// skill/tool/agent/mcp catalogs, file reads, reminders) nest under whichever bucket actually wrote
// them, each block drilling to its real excerpt text at a leaf. The un-itemized base system prompt +
// prior transcript is shown as an explicit remainder so the children reconcile to the exact bucket
// value — never fabricated. No inner scrollbar — the tree grows the page.
function LlmContextBreakdown({ entry, hostSources, compNote, hasCallContext }: { entry: TimelineEntry; hostSources?: ContextSource[]; compNote?: string; hasCallContext?: boolean }) {
  const cacheRead = entry.cacheReadTokens ?? 0
  const cacheCreate = entry.cacheCreateTokens ?? 0
  // Entries carry disjoint buckets: inputTokens IS the fresh uncached share (the old subtraction
  // compensated for incl-cache OTEL entries and would zero this out under the raw convention).
  const newInput = entry.inputTokens ?? 0
  const injectedNodes = compositionNodes(hostSources ?? [])
  const itemizedSum = (hostSources ?? []).reduce((n, s) => n + s.tokens, 0)
  // The identifiable injected blocks belong under cache-CREATED when this call newly wrote a prefix
  // big enough to contain them (the classic first-turn 100k+ write); on later turns cache_creation is
  // just the small changed delta and those same blocks are being RE-READ, so they nest under cache-read
  // instead. This keeps each block under the bucket that actually accounts for its tokens.
  const blocksAreNewWrites = injectedNodes.length > 0 && cacheCreate >= itemizedSum

  const nodes: BarNode[] = []

  if (cacheRead > 0) {
    if (injectedNodes.length > 0 && !blocksAreNewWrites) {
      const kids = budgetedKids(injectedNodes, cacheRead, 'cr-rem')
      nodes.push({ key: 'cacheread', label: 'Cache-read (resident prefix reused)', colorKind: 'cacheRead', weight: cacheRead, value: tokValue(cacheRead, false), children: kids })
    } else {
      nodes.push({ key: 'cacheread', label: 'Cache-read (resident prefix reused)', colorKind: 'cacheRead', weight: cacheRead, value: tokValue(cacheRead, false),
        leaf: { kind: 'text', text: `${cacheRead.toLocaleString()} tokens were re-read from the prompt cache this call — the resident transcript accumulated over the prior turns (billed ≈10% of the input rate).${hasCallContext ? ' Its actual bytes are itemized block-by-block in the full context tree below.' : " Its bytes are the earlier turns' content; open the preceding turns to inspect them."}` } })
    }
  }

  if (newInput > 0) {
    nodes.push({ key: 'newinput', label: 'New input tokens', colorKind: 'input', weight: newInput, value: tokValue(newInput, false),
      leaf: { kind: 'text', text: `${newInput.toLocaleString()} fresh input tokens entered the context this call — the new user message and/or the tool results appended since the previous call, none of it served from cache.` } })
  }

  if (cacheCreate > 0) {
    if (blocksAreNewWrites) {
      const kids = budgetedKids(injectedNodes, cacheCreate, 'cc-rem')
      nodes.push({ key: 'cachewrite', label: 'Cache-created (newly written to cache)', colorKind: 'cacheWrite', weight: cacheCreate, value: tokValue(cacheCreate, false), children: kids })
    } else {
      nodes.push({ key: 'cachewrite', label: 'Cache-created (newly written to cache)', colorKind: 'cacheWrite', weight: cacheCreate, value: tokValue(cacheCreate, false),
        leaf: { kind: 'text', text: injectedNodes.length > 0
          ? `${cacheCreate.toLocaleString()} tokens were newly written to the cache this call — the changed or first-seen prefix delta. The stable injected blocks it reuses are itemized under "Cache-read" above.`
          : `${cacheCreate.toLocaleString()} tokens were newly written to the prompt cache this call (full write rate).${hasCallContext ? ' The exact prefix content is itemized block-by-block in the full context tree below.' : " The identifiable injected blocks are listed here once the local log's session composition is available."}` } })
    }
  }

  if (nodes.length === 0) return null
  const max = Math.max(0, ...nodes.map(n => n.weight))
  const sortByValue = timelineSortByValue.value
  const metric = timelineMetric.value
  const ordered = sortByValue && metric !== 'time' ? [...nodes].sort((a, b) => b.weight - a.weight) : nodes
  // Vertical block (heading via the parent LlmField) — the cache-bucket summary bars stack above the
  // full context tree, never squeezed into a side column. When the raw-body tree is present the
  // OTEL-only "no local transcript" dead-end note is suppressed (the tree itemizes it for real).
  return (
    <div>
      <div style="font-size:9px;color:var(--muted);margin-bottom:4px">
        What the {formatCompact(contextTokens(entry))}-token prompt was made of — <span style={'color:' + SOURCE_KIND_COLOR.cacheRead}>cache-read</span> reused vs{' '}
        <span style={'color:' + SOURCE_KIND_COLOR.cacheWrite}>cache-created</span> re-written. Expand a bar to drill into the injected blocks (CLAUDE.md, rules, memories, catalogs, hooks…) down to their real content.
        {!hasCallContext && (hostSources?.length ?? 0) === 0 && <span>{compNote ?? ' Injected-block detail appears once the session composition finishes loading.'}</span>}
      </div>
      {ordered.map(n => <TreeBar key={n.key} node={n} depth={0} siblingMax={max} />)}
    </div>
  )
}

// The expanded body of an LLM call, laid out as a single VERTICAL stack (TRDD-ICHAVFCS layout fix —
// was side-by-side label|value columns): model → attribution (who caused the call) → exact usage →
// the cache-bucket summary → the FULL literal context tree of this call (reconstructed from the raw
// OTEL body, so it works even for OTEL-only sessions with no .jsonl) → cost → response + reasoning →
// timing. response/thinking are resolved by the parent (inline or blob) and passed in.
function LlmDetail({ entry, step, sessIdx, idx, sessionModel, hostSources, compNote, responseText, thinking, sessionId }: {
  entry: TimelineEntry; step: Step; sessIdx: number; idx: number; sessionModel: string
  hostSources?: ContextSource[]; compNote?: string; responseText: string; thinking: string; sessionId?: string
}) {
  const [showOutput, setShowOutput] = useState(false)
  const PREVIEW_LEN = 400
  const isLongResponse = responseText.length > PREVIEW_LEN
  const entryCost = calcEntryCost(entry, sessionModel)
  // Disjoint buckets: inputTokens IS the fresh/uncached share — no subtraction (see tokenBuckets.ts).
  const newInput = entry.inputTokens ?? 0
  const hasCache = (entry.cacheReadTokens ?? 0) > 0 || (entry.cacheCreateTokens ?? 0) > 0
  const attribution = formatAttribution(entry)
  // The reconstructed literal context is fetchable only when we know the session; when its blocks are
  // present they REPLACE the "open the preceding turns" dead-end (the cache-bucket note softens too).
  const ctx = sessionId ? callContexts.value[ctxKey(sessionId, entry)] : undefined
  const hasCallContext = !!ctx && ctx.blocks.length > 0
  return (
    <>
      <LlmField heading="Model">{entry.model || 'unknown'}</LlmField>
      {attribution && <LlmField heading="Issued by">{attribution}</LlmField>}
      {(contextTokens(entry) > 0 || (entry.outputTokens ?? 0) > 0) && (
        <LlmField heading="Token usage">
          <span class="sw-token-in">
            {hasCache ? `${newInput.toLocaleString()} new` : `${(entry.inputTokens ?? 0).toLocaleString()} input`}
            {(entry.cacheReadTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheReadTokens ?? 0).toLocaleString()} cached</span>}
            {(entry.cacheCreateTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheCreateTokens ?? 0).toLocaleString()} cache write</span>}
          </span>
          <span class="sw-token-arrow"> → </span>
          <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
        </LlmField>
      )}
      <LlmField heading="Context composition (this call)">
        <LlmContextBreakdown entry={entry} hostSources={hostSources} compNote={compNote} hasCallContext={hasCallContext} />
      </LlmField>
      {sessionId && (
        <LlmField heading="Full context of this call">
          <CallContextTree sessionId={sessionId} entry={entry} />
        </LlmField>
      )}
      {entryCost > 0 && (
        <LlmField heading="Cost">{entry.costUsd !== undefined ? `${fmtUsd(entry.costUsd)} (exact)` : fmtUsd(entryCost)}</LlmField>
      )}
      {responseText && (
        <LlmField heading={<>Response{isLongResponse && (
          <button class="sw-show-full-btn" style="margin-left:8px" onClick={() => setShowOutput(v => !v)}>
            {showOutput ? 'Collapse' : 'Show full response'}
          </button>
        )}</>}>
          <div style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5">
            {showOutput ? responseText : responseText.slice(0, PREVIEW_LEN)}
            {isLongResponse && !showOutput && <span style="color:var(--muted)">…</span>}
          </div>
        </LlmField>
      )}
      {thinking && <LongTextSection heading="Reasoning" text={thinking} id={'sw-thinking-' + sessIdx + '-' + idx} />}
      {(entry.ttft ?? 0) > 0 && <LlmField heading="Time to first token">{formatMs(entry.ttft!)}</LlmField>}
      <LlmField heading="Duration">{formatMs(step.durationMs)}</LlmField>
      {entry.action && <LlmField heading="Stop reason">{entry.action}</LlmField>}
      {entry.timestamp && <LlmField heading="Timestamp"><span class="sw-detail-muted">{entry.timestamp}</span></LlmField>}
    </>
  )
}

// Detail body for ONE expanded step. EVERY step type expands to its exact content + context
// structure — nothing is a dead stat card: LLM calls show the per-turn composition breakdown +
// full response/reasoning, tool calls show the FULL output, user/message steps show their full
// text. Blob fields absent from DB rows are lazy-fetched via loadBlob (live sessions carry them
// inline). All hooks run unconditionally at the top so hook order is stable across renders.
function StepDetail({ step, idx, sessIdx, sessionModel, hostSources, compNote, sessionId }: { step: Step; idx: number; sessIdx: number; sessionModel: string; hostSources?: ContextSource[]; compNote?: string; sessionId?: string }) {
  const entry = step.entry
  const blobs = blobCache.value
  // Lazy-fetch any blob fields this entry needs but didn't ship inline (DB-loaded sessions strip
  // them; live sessions carry them inline). One effect for all types → stable hook order.
  useEffect(() => {
    if (!entry.hasBlob || !vscode) return
    const want: Array<'full-result' | 'response' | 'thinking'> = []
    if (entry.type === 'tool' && !entry.fullResult) want.push('full-result')
    if ((entry.type === 'llm' || entry.type === 'user_input') && !entry.responseText) want.push('response')
    if (entry.type === 'llm' && !entry.thinking) want.push('thinking')
    for (const f of want) {
      if (blobCache.value[`${entry.spanId}:${f}`] === undefined) {
        vscode.postMessage({ type: 'loadBlob', spanId: entry.spanId, field: f })
      }
    }
  }, [entry.spanId])

  if (entry.type === 'llm') {
    return <LlmDetail entry={entry} step={step} sessIdx={sessIdx} idx={idx} sessionModel={sessionModel}
      hostSources={hostSources} compNote={compNote} sessionId={sessionId} responseText={entry.responseText || blobs[`${entry.spanId}:response`] || ''}
      thinking={entry.thinking || blobs[`${entry.spanId}:thinking`] || ''} />
  }

  if (entry.type === 'tool') {
    const toolParts = (entry.label ?? '').match(/^(\S+)\s*([\s\S]*)$/)
    const tName = toolParts ? toolParts[1] : entry.label
    const tArgs = toolParts ? toolParts[2] : ''
    // toolInput is a raw command, a file path, or a JSON args object.
    const isRaw = entry.toolInput && !entry.toolInput.trimStart().startsWith('{')
    const isFilePath = isRaw && (entry.toolInput!.startsWith('/') || entry.toolInput!.startsWith('~') || /^[A-Za-z]:[/\\]/.test(entry.toolInput!))
    const inputHeading = !isRaw ? 'Arguments' : isFilePath ? 'File' : 'Command'
    const inputText = isRaw ? entry.toolInput : (tArgs || entry.toolInput || '')
    // FULL tool output (lazy-fetched above for DB sessions; inline on live sessions).
    const resultText = entry.fullResult || blobs[`${entry.spanId}:full-result`] || entry.resultSummary || ''
    return (
      <>
        <div class="sw-detail-section"><div class="sw-detail-heading">Tool</div><div class="sw-detail-value"><code>{tName}</code></div></div>
        {inputText && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">{inputHeading}</div>
            <div class="sw-detail-value"><code style="white-space:pre-wrap;word-break:break-all">{inputText}</code></div>
          </div>
        )}
        <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
        {entry.decision && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Decision</div>
            <div class="sw-detail-value" style={entry.decision === 'rejected' ? 'color:var(--error)' : 'color:#8ec96b'}>{entry.decision}</div>
          </div>
        )}
        {resultText
          ? <LongTextSection heading="Full output" text={resultText} id={'sw-result-' + sessIdx + '-' + idx} isJson />
          : entry.hasBlob
            ? <div class="sw-detail-section"><div class="sw-detail-heading">Full output</div><div class="sw-detail-value sw-detail-muted">Loading…</div></div>
            : null}
        {entry.isError && <div class="sw-detail-section"><div class="sw-detail-heading err">Error</div><div class="sw-detail-value err">This step failed</div></div>}
        {/* Output files this tool call produced/referenced under the session scratch tree
            (TRDD-ZS1GDXVY): expandable leaves, content lazy-fetched on expand. */}
        {entry.generatedFiles && entry.generatedFiles.length > 0 &&
          <GeneratedFilesList files={entry.generatedFiles} heading="Output files" />}
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
  }

  if (entry.type === 'user_input') {
    const msgText = entry.responseText || blobs[`${entry.spanId}:response`] || entry.label || ''
    return (
      <>
        <div class="sw-detail-section"><div class="sw-detail-heading">Message</div><div class="sw-detail-value">{entry.decision && entry.decision !== 'unknown' ? entry.decision : 'user input'}</div></div>
        {msgText && <LongTextSection heading="Full text" text={msgText} id={'sw-msg-' + sessIdx + '-' + idx} />}
        <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
  }

  // Background task (or any other type): show its label + full text if any.
  return (
    <>
      <div class="sw-detail-section"><div class="sw-detail-heading">Background Task</div><div class="sw-detail-value">{entry.label || ''}</div></div>
      {entry.responseText && <LongTextSection heading="Full text" text={entry.responseText} id={'sw-bg-' + sessIdx + '-' + idx} />}
      <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
    </>
  )
}

function LongTextSection({ heading, text, id: _id, isJson }: { heading: string; text: string; id: string; isJson?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const maxPreviewChars = 600
  const isLong = text.length > maxPreviewChars

  let formatted = text.length > 6000 ? text.slice(0, 6000) + '\n... [truncated ' + (text.length - 6000).toLocaleString() + ' chars]' : text
  if (formatted.length <= 2000) {
    try { formatted = JSON.stringify(JSON.parse(formatted), null, 2) } catch { /* keep as-is */ }
  }

  return (
    <>
      <div class="sw-detail-section">
        <div class="sw-detail-heading">
          {heading}
          {isLong && (
            <button class="sw-show-full-btn" style="margin-left:8px" onClick={() => setExpanded(v => !v)}>
              {expanded ? 'Collapse' : 'Show full'}
            </button>
          )}
        </div>
      </div>
      {!isLong || !expanded ? (
        <pre class="sw-full-result-pre" style="margin:0 0 8px">
          {isJson && formatted.length <= 2000
            ? <span dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(isLong ? text.slice(0, maxPreviewChars) : formatted) }} />
            : (isLong ? text.slice(0, maxPreviewChars) + '…' : formatted)
          }
        </pre>
      ) : (
        <pre class="sw-full-result-pre" style="margin:0 0 8px">
          {isJson && formatted.length <= 2000
            ? <span dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(formatted) }} />
            : formatted
          }
        </pre>
      )}
    </>
  )
}

export function StepRow({ step, idx, sessIdx, sessionDur, sessionModel, metric, maxMetric, highlightSpanId, hostSources, compNote, sessionId }: { step: Step; idx: number; sessIdx: number; sessionDur: number; sessionModel: string; metric: TimelineMetric; maxMetric: number; highlightSpanId?: string; hostSources?: ContextSource[]; compNote?: string; sessionId?: string }) {
  const entry = step.entry
  // When the user clicks a point in the Growth chart we focus that exact turn (by spanId). The
  // matching row auto-expands so its token breakdown is immediately visible, and scrolls into view.
  // useState(initial) covers a fresh mount already-focused; the effect covers a focus change while
  // the row is already mounted (e.g. clicking a different point with the detail panel open).
  const isHighlighted = !!highlightSpanId && entry.spanId === highlightSpanId
  const [open, setOpen] = useState(isHighlighted)
  const rowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (isHighlighted) {
      setOpen(true)
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [isHighlighted])
  const entryCost = entry.type === 'llm' ? calcEntryCost(entry, sessionModel) : 0

  let badgeLabel: string, barColor: string
  if (entry.type === 'llm') { badgeLabel = 'LLM'; barColor = 'var(--accent)' }
  else if (entry.type === 'tool') { badgeLabel = 'TOOL'; barColor = '#B8E986' }
  else if (entry.type === 'user_input') { badgeLabel = 'USER'; barColor = '#F5A623' }
  else { badgeLabel = 'BG'; barColor = 'var(--muted)' }
  if (entry.isError) barColor = 'var(--error)'

  // The chosen metric's magnitude drives bar WIDTH, bar COLOUR and the info label. Time keeps the
  // per-type colour; a token/cost metric recolours to that metric so switching is visually obvious.
  const metricVal = metric === 'time' ? 0 : stepMetricValue(entry, metric, sessionModel)
  const barFill = metric === 'time' ? barColor : (entry.isError ? 'var(--error)' : METRIC_COLOR[metric])

  const rowLabel = entry.type === 'llm' ? formatLlmLabel(entry)
    : entry.type === 'tool' ? formatToolLabel(entry) + (formatToolResult(entry) ? ' → ' + formatToolResult(entry) : '')
    : entry.type === 'user_input' ? (entry.decision && entry.decision !== 'unknown' ? `${entry.label} (${entry.decision})` : entry.label)
    : entry.label || ''

  // Show a subtitle with the full bash command (when the label had to truncate it).
  const toolSubtitle = (() => {
    if (entry.type !== 'tool' || !entry.toolInput) return null
    const raw = entry.toolInput.trimStart()
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (parsed.command) {
          // Show full command as subtitle when it was truncated in the label
          const cmd = String(parsed.command)
          return cmd.length > 60 ? cmd : null
        }
      } catch { /* ignore */ }
      return null
    }
    // Raw string (Bash full_command or file path)
    const isFilePath = raw.startsWith('/') || raw.startsWith('~') || /^[A-Za-z]:[/\\]/.test(raw)
    if (isFilePath) return null  // file path already shown in label
    return raw.length > 60 ? raw : null  // only show subtitle if it was truncated
  })()

  const subtitle = toolSubtitle

  // Bar geometry depends on the selected metric: 'time' keeps the chronological waterfall
  // (offset + duration); a token/cost metric becomes a left-aligned bar whose width is the
  // step's share of the largest step's value.
  let left: number, width: number
  if (metric === 'time') {
    left = sessionDur > 0 ? (step.offsetMs / sessionDur * 100) : 0
    width = sessionDur > 0 ? Math.max(step.durationMs / sessionDur * 100, 0.5) : 100
  } else {
    left = 0
    width = maxMetric > 0 && metricVal > 0 ? Math.max(metricVal / maxMetric * 100, 0.5) : 0
  }

  return (
    <>
      <div ref={rowRef} class="wf-row" onClick={() => setOpen(v => !v)}
        style={isHighlighted ? 'outline:2px solid var(--accent);outline-offset:-2px;border-radius:3px' : undefined}>
        <div class="wf-label" title={subtitle ? rowLabel + ' — ' + subtitle : rowLabel}>
          <span class="wf-indent" />
          <span class="sw-chevron">{open ? '▼' : '▶'}</span>
          <span class="wf-type-badge" style={'background:' + barColor + ';color:#000'}>{badgeLabel}</span>
          <span style="display:inline-flex;flex-direction:column;min-width:0">
            <span class="wf-name">{rowLabel}</span>
            {subtitle && <span style="font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">{subtitle}</span>}
          </span>
        </div>
        <div class="wf-bar-area">
          <div class="wf-bar" style={`left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`}>
            <div class="wf-bar-inner" style={'background:' + barFill + ';opacity:' + (entry.isError ? '1' : '0.7')} />
          </div>
        </div>
        <div class="wf-info">
          {metric === 'time' ? (
            <>
              {formatMs(step.durationMs)}
              {entry.type === 'llm' && ((entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0) && (
                <div style="font-size:9px;color:var(--muted);margin-top:2px">
                  <div style="white-space:nowrap">↑{formatCompact(entry.inputTokens ?? 0)} ↓{formatCompact(entry.outputTokens ?? 0)}</div>
                  {(entry.cacheReadTokens ?? 0) > 0 && (
                    <div style="white-space:nowrap">{formatCompact(entry.cacheReadTokens ?? 0)} cached</div>
                  )}
                </div>
              )}
              {entryCost > 0 && (
                <div style="font-size:9px;color:var(--muted);white-space:nowrap">~{fmtUsd(entryCost)}</div>
              )}
            </>
          ) : (
            // Token/cost metric: show THAT value as the primary figure (the bug was showing ms
            // here regardless of metric); ms drops to a muted secondary line. '—' = no value.
            <>
              <span style={metricVal > 0 ? 'font-weight:600' : 'color:var(--muted)'}>{formatMetricValue(metric, metricVal)}</span>
              <div style="font-size:9px;color:var(--muted);margin-top:2px;white-space:nowrap">{formatMs(step.durationMs)}</div>
            </>
          )}
        </div>
      </div>
      {open && (
        <div class="sw-detail open">
          <StepDetail step={step} idx={idx} sessIdx={sessIdx} sessionModel={sessionModel} hostSources={hostSources} compNote={compNote} sessionId={sessionId} />
        </div>
      )}
    </>
  )
}

// ── P5: recursive bar-tree drill-down to raw content ──────────────────────────────────────────
// Every node is an expandable BAR carrying its own token weight; expanding a branch reveals its
// component bars (which make it up), and every drill path bottoms out at a LEAF that renders the
// ACTUAL content bytes — the real model response / reasoning / tool output / user message / injected
// file·rule·memory·hook text that occupied those tokens — never a dead stat card. Depth is shown by
// INDENTATION (the page scrolls; no nested scrollbars, per the project rule).
type LeafContent =
  | { kind: 'text'; text: string }
  | { kind: 'json'; text: string }
  | { kind: 'blob'; spanId: string; field: 'full-result' | 'response' | 'thinking'; inline: string }

interface BarNode {
  key: string
  label: string
  colorKind: string       // key into SOURCE_KIND_COLOR — the bar colour
  weight: number          // token magnitude — drives bar width (relative to siblings) + value-sort
  value: string           // formatted right-hand figure (e.g. "1.2k tok", "~$0.03")
  children?: BarNode[]     // a BRANCH — its component bars
  leaf?: LeafContent       // a LEAF — the actual content bytes
  hint?: string            // optional dim sub-label under the bar
}

function tokValue(tokens: number, estimate: boolean): string {
  return tokens > 0 ? formatCompact(tokens) + (estimate ? '~' : '') + ' tok' : '—'
}

// Render the ACTUAL content at a leaf. Blob-backed leaves (response / reasoning / full tool output)
// prefer the inline field (live + standalone sessions carry it) and lazy-fetch from the DB via
// loadBlob only when it is missing — the same contract StepDetail uses, so a leaf shows real bytes in
// both the extension (DB) and the standalone (in-memory) paths. Fetch happens on EXPAND (this mounts
// only when the parent node is open), so nothing is fetched eagerly.
function LeafBody({ leaf }: { leaf: LeafContent }) {
  const blobs = blobCache.value
  const isBlob = leaf.kind === 'blob'
  const spanId = isBlob ? leaf.spanId : ''
  const field = isBlob ? leaf.field : ''
  const inline = isBlob ? leaf.inline : ''
  useEffect(() => {
    if (!isBlob || inline || !vscode) return
    if (blobCache.value[`${spanId}:${field}`] === undefined) {
      vscode.postMessage({ type: 'loadBlob', spanId, field })
    }
  }, [spanId, field])

  const text = isBlob ? (inline || blobs[`${spanId}:${field}`] || '') : leaf.text
  if (isBlob && !text) return <pre class="sw-full-result-pre" style="margin:2px 0 4px"><span style="color:var(--muted)">Loading…</span></pre>
  if (!text) return <pre class="sw-full-result-pre" style="margin:2px 0 4px"><span style="color:var(--muted)">(empty)</span></pre>

  const isJson = leaf.kind === 'json'
  let shown = text.length > 6000 ? text.slice(0, 6000) + '\n… [truncated ' + (text.length - 6000).toLocaleString() + ' chars]' : text
  if (isJson && shown.length <= 2000) { try { shown = JSON.stringify(JSON.parse(shown), null, 2) } catch { /* keep as-is */ } }
  return (
    <pre class="sw-full-result-pre" style="margin:2px 0 4px;white-space:pre-wrap;word-break:break-word">
      {isJson && shown.length <= 2000
        ? <span dangerouslySetInnerHTML={{ __html: syntaxHighlightJson(shown) }} />
        : shown}
    </pre>
  )
}

// One node in the recursive tree: a bar sized by its token weight (relative to its siblings), an
// expand chevron, and — on expand — either its child bars (a branch) or the actual content (a leaf).
// Children are re-sorted heaviest-first when the value-sort toggle is on (same signal the flat view
// uses), so the drill-down obeys the same sort as the rest of the trace.
function TreeBar({ node, depth, siblingMax }: { node: BarNode; depth: number; siblingMax: number }) {
  const [open, setOpen] = useState(false)
  const sortByValue = timelineSortByValue.value
  const metric = timelineMetric.value
  const color = SOURCE_KIND_COLOR[node.colorKind] ?? 'var(--muted)'
  const width = siblingMax > 0 && node.weight > 0 ? Math.max(node.weight / siblingMax * 100, 0.5) : 0
  const expandable = !!node.children || !!node.leaf
  const kids = node.children ?? []
  const childMax = Math.max(0, ...kids.map(k => k.weight))
  const ordered = sortByValue && metric !== 'time' ? [...kids].sort((a, b) => b.weight - a.weight) : kids
  return (
    <div>
      <div style={`display:flex;align-items:center;min-height:20px;font-size:10px;${expandable ? 'cursor:pointer' : ''};padding-left:${depth * 14 + 6}px`}
        onClick={expandable ? () => setOpen(v => !v) : undefined}>
        <span style="width:12px;font-size:8px;color:var(--muted);text-align:center;flex:none">{expandable ? (open ? '▼' : '▶') : ''}</span>
        <span style="flex:1;min-width:0;display:inline-flex;flex-direction:column">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={node.label}>{node.label}</span>
          {node.hint && <span style="font-size:8px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{node.hint}</span>}
        </span>
        <div style="width:110px;position:relative;height:9px;margin:0 6px;flex:none">
          {width > 0 && <div style={`position:absolute;left:0;height:7px;top:1px;border-radius:2px;width:${width.toFixed(1)}%;background:${color};opacity:0.7`} />}
        </div>
        <span style="width:78px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted);flex:none">{node.value}</span>
      </div>
      {open && node.leaf && <div style={`padding-left:${depth * 14 + 24}px`}><LeafBody leaf={node.leaf} /></div>}
      {open && node.children && ordered.map(c => <TreeBar key={c.key} node={c} depth={depth + 1} siblingMax={childMax} />)}
    </div>
  )
}

const KIND_GROUP_LABEL: Record<string, string> = {
  file: 'Files (CLAUDE.md · rules · memories · reads)',
  hook: 'Hook injections',
  skill: 'Skill catalog',
  toolCatalog: 'Tool catalog',
  agentCatalog: 'Agent catalog',
  mcp: 'MCP instructions',
  reminder: 'Task reminders',
  other: 'Other sources',
}

// Merge injected blocks that share a (kind, label) identity, summing their tokens/bytes/occurrences
// and keeping the first non-empty excerpt. Used to fold a fork's inherited PARENT transcript (whose
// blocks are spread across the parent's turns) into one deduplicated inherited-context set — so the
// fork's per-call drill shows each distinct block once rather than N copies from N parent turns.
function mergeSources(sources: ContextSource[]): ContextSource[] {
  const byKey = new Map<string, ContextSource>()
  for (const s of sources) {
    const key = `${s.kind}::${s.label}`
    const cur = byKey.get(key)
    if (!cur) { byKey.set(key, { ...s }); continue }
    cur.bytes += s.bytes
    cur.tokens += s.tokens
    cur.count += s.count
    if (!cur.excerpt && s.excerpt) cur.excerpt = s.excerpt
  }
  return [...byKey.values()].sort((a, b) => b.tokens - a.tokens)
}

// The host-parsed injected blocks as bar nodes: grouped by kind (Files, Hooks, catalogs…), each group
// drilling to its individual sources, each source a LEAF that renders the ACTUAL injected text
// (excerpt). This is where "system prompt / CLAUDE.md / each rule / each memory / each hook injection"
// bottom out at real content.
function compositionNodes(hostSources: ContextSource[]): BarNode[] {
  if (!hostSources.length) return []
  const byKind = new Map<string, ContextSource[]>()
  for (const s of hostSources) {
    const arr = byKind.get(s.kind) ?? []
    arr.push(s)
    byKind.set(s.kind, arr)
  }
  const groups: BarNode[] = []
  for (const [kind, arr] of byKind) {
    const sum = arr.reduce((n, s) => n + s.tokens, 0)
    const kids: BarNode[] = arr.map((s, i) => ({
      key: `src:${kind}:${i}:${s.label}`, label: s.label, colorKind: s.kind, weight: s.tokens,
      value: tokValue(s.tokens, true),
      hint: s.count > 1 ? `${s.count} occurrences` : undefined,
      leaf: {
        kind: 'text' as const,
        text: s.excerpt
          ? s.excerpt + (s.excerpt.length >= 1200 ? '\n… [excerpt truncated]' : '')
          : `(${s.label} — ~${formatCompact(s.tokens)} tokens across ${s.count} occurrence${s.count !== 1 ? 's' : ''}; no content text was captured for this block type.)`,
      },
    }))
    groups.push({ key: `grp:${kind}`, label: KIND_GROUP_LABEL[kind] ?? kind, colorKind: kind, weight: sum, value: tokValue(sum, true), children: kids })
  }
  return groups
}

// Fit the itemized injected-block groups under a cache BUCKET so the children reconcile EXACTLY to
// the bucket value and never over-count it. Groups are taken heaviest-first until the next would
// exceed the budget; whatever is left of the bucket becomes the honest "system prompt + prior
// transcript (not itemized)" remainder. When the blocks all fit (own-log sessions) every block is
// shown plus the remainder; when they exceed it (a fork's inherited-context superset nested under one
// call's smaller bucket) the biggest real blocks are shown and the rest fold into the remainder —
// real content either way, exact sum always, nothing fabricated.
function budgetedKids(injectedNodes: BarNode[], budget: number, remKey: string): BarNode[] {
  const sorted = [...injectedNodes].sort((a, b) => b.weight - a.weight)
  const kept: BarNode[] = []
  let used = 0
  for (const n of sorted) {
    if (used + n.weight > budget) break
    kept.push(n)
    used += n.weight
  }
  const rem = budget - used
  if (rem > 0) kept.push(remainderNode(remKey, rem))
  return kept
}

// The un-itemized remainder of a cache bucket: the base system prompt + accumulated conversation
// transcript that the local-log parser does NOT break into individual blocks. Shown as an explicit
// bar so a bucket's itemized children + this remainder reconcile to the exact bucket token count —
// the honest alternative to silently omitting the difference or fabricating fake blocks for it.
function remainderNode(key: string, tokens: number): BarNode {
  return {
    key, label: 'System prompt + prior transcript (not individually itemized)', colorKind: 'other',
    weight: tokens, value: tokValue(tokens, true),
    leaf: { kind: 'text', text: `~${tokens.toLocaleString()} tokens are the base system prompt plus the accumulated conversation transcript, which the local-log parser does not itemize into individual blocks. The identifiable injected blocks (CLAUDE.md, rules, memories, catalogs, hooks, file reads, reminders) are listed above; this remainder is everything else in this cache bucket, shown so the parts add up to the exact bucket total rather than fabricating detail that was not captured.` },
  }
}

// Build the COMPONENT bars of one turn: the 5 usage values (each drilling to the real content that
// produced it) plus the injected-context blocks. Every branch ends at a LEAF that renders actual
// bytes — the user's ask: "each bar expandable into its component bars, and so on, until the actual
// content (input, output, etc.) is shown as a final leaf".
function buildTurnNodes(tSteps: Step[], totals: TurnTotals, hostSources: ContextSource[], sessionModel: string): BarNode[] {
  const nodes: BarNode[] = []
  const llmSteps = tSteps.filter(s => s.entry.type === 'llm')
  const toolSteps = tSteps.filter(s => s.entry.type === 'tool')
  const userSteps = tSteps.filter(s => s.entry.type === 'user_input')
  const newInput = Math.max(0, totals.input - totals.cacheRead - totals.cacheWrite)
  const turnTotalTok = totals.input + totals.output + totals.cacheRead + totals.cacheWrite

  // 1. OUTPUT → each LLM call's real response + reasoning text.
  const outKids: BarNode[] = []
  for (const s of llmSteps) {
    const e = s.entry
    const lbl = formatLlmLabel(e)
    const resp = e.responseText || ''
    const rTok = e.outputTokens ?? countTokens(resp)
    outKids.push({ key: e.spanId + ':resp', label: `Response — ${lbl}`, colorKind: 'output', weight: rTok, value: tokValue(rTok, e.outputTokens === undefined),
      leaf: { kind: 'blob', spanId: e.spanId, field: 'response', inline: resp } })
    if (e.thinking) {
      const tTok = countTokens(e.thinking)
      outKids.push({ key: e.spanId + ':think', label: `Reasoning — ${lbl}`, colorKind: 'output', weight: tTok, value: tokValue(tTok, true),
        leaf: { kind: 'blob', spanId: e.spanId, field: 'thinking', inline: e.thinking } })
    }
  }
  nodes.push({ key: 'output', label: 'Output (model response)', colorKind: 'output', weight: totals.output, value: tokValue(totals.output, false),
    children: outKids.length ? outKids : [{ key: 'output-none', label: 'No assistant output text this turn', colorKind: 'output', weight: 0, value: '—', leaf: { kind: 'text', text: 'This turn produced no model output text.' } }] })

  // 2. NEW INPUT → the fresh bytes that entered context this turn: user messages + tool results/inputs.
  const inKids: BarNode[] = []
  for (const s of userSteps) {
    const e = s.entry
    const txt = e.responseText || e.label || ''
    const mTok = countTokens(txt)
    inKids.push({ key: e.spanId + ':msg', label: 'User message', colorKind: 'user', weight: mTok, value: tokValue(mTok, true),
      leaf: { kind: 'blob', spanId: e.spanId, field: 'response', inline: txt } })
  }
  for (const s of toolSteps) {
    const e = s.entry
    const lbl = formatToolLabel(e)
    const out = e.fullResult || e.resultSummary || ''
    const oTok = countTokens(out)
    inKids.push({ key: e.spanId + ':toolres', label: `${lbl} → result`, colorKind: 'tool', weight: oTok, value: tokValue(oTok, true),
      leaf: { kind: 'blob', spanId: e.spanId, field: 'full-result', inline: e.fullResult || '' } })
    if (e.toolInput) {
      const iTok = countTokens(e.toolInput)
      inKids.push({ key: e.spanId + ':toolin', label: `${lbl} → input`, colorKind: 'tool', weight: iTok, value: tokValue(iTok, true),
        leaf: { kind: 'json', text: e.toolInput } })
    }
  }
  if (inKids.length) nodes.push({ key: 'newinput', label: 'New input (fresh bytes this turn)', colorKind: 'input', weight: newInput, value: tokValue(newInput, false), children: inKids })
  else if (newInput > 0) nodes.push({ key: 'newinput', label: 'New input (fresh bytes this turn)', colorKind: 'input', weight: newInput, value: tokValue(newInput, false),
    leaf: { kind: 'text', text: `${newInput.toLocaleString()} new input tokens entered the context this turn. The individual message / tool-result content is not separately recorded for this session.` } })

  // 3. CACHE-READ → the resident prefix reused from cache. Its bytes are the prior turns' content —
  //    an explanatory leaf points there (drilling all of it would duplicate every earlier turn).
  if (totals.cacheRead > 0) nodes.push({ key: 'cacheread', label: 'Cache-read (resident prefix reused)', colorKind: 'cacheRead', weight: totals.cacheRead, value: tokValue(totals.cacheRead, false),
    leaf: { kind: 'text', text: `${totals.cacheRead.toLocaleString()} tokens were re-read from the prompt cache this turn — the resident transcript accumulated over the prior turns (billed ≈10% of the input rate). Its bytes are the earlier turns' content; open the preceding turns to inspect them. The bytes NEWLY added this turn are under "New input"; the blocks (re)written to the cache are under "Cache-created".` } })

  // 4. CACHE-CREATED → newly written to cache. Drill the injected blocks that (re)entered the prefix.
  if (totals.cacheWrite > 0) {
    const compKids = compositionNodes(hostSources)
    nodes.push({ key: 'cachewrite', label: 'Cache-created (newly written to cache)', colorKind: 'cacheWrite', weight: totals.cacheWrite, value: tokValue(totals.cacheWrite, false),
      children: compKids.length ? compKids : undefined,
      leaf: compKids.length ? undefined : { kind: 'text', text: `${totals.cacheWrite.toLocaleString()} tokens were newly written to the prompt cache this turn (full write rate) — the prefix content that changed or first appeared. The identifiable injected blocks are listed under "Injected context" when the local log is available.` } })
  }

  // 5. COST → what the turn cost, drilled per LLM call (each → its response content).
  if (totals.cost > 0) {
    const costKids: BarNode[] = llmSteps.map(s => {
      const e = s.entry
      const c = calcEntryCost(e, sessionModel)
      return { key: e.spanId + ':cost', label: `${formatLlmLabel(e)} — ~${fmtUsd(c)}`, colorKind: 'cost',
        weight: (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreateTokens ?? 0), value: '~' + fmtUsd(c),
        leaf: { kind: 'blob' as const, spanId: e.spanId, field: 'response' as const, inline: e.responseText || '' } }
    })
    nodes.push({ key: 'cost', label: 'Cost (this turn)', colorKind: 'cost', weight: turnTotalTok, value: '~' + fmtUsd(totals.cost),
      children: costKids.length ? costKids : undefined,
      leaf: costKids.length ? undefined : { kind: 'text', text: `Estimated cost this turn: ~${fmtUsd(totals.cost)}.` } })
  }

  // 6. INJECTED CONTEXT → the parsed injected blocks (system-prompt attachments, CLAUDE.md, each
  //    rule, each memory, each hook injection, catalogs) as their own component bars → real text.
  const injected = compositionNodes(hostSources)
  if (injected.length) {
    const sum = hostSources.reduce((n, s) => n + s.tokens, 0)
    nodes.push({ key: 'injected', label: 'Injected context (parsed blocks)', colorKind: 'file', weight: sum, value: tokValue(sum, true), children: injected })
  }

  return nodes
}

// One excerpt pane (BEFORE or AFTER) with a lightweight line-level change highlight. Text WRAPS
// (pre-wrap + break-word) so there is never a horizontal inner scrollbar — the no-nested-scrollbars
// rule; the excerpt itself is already length-capped by the composition parser, so the pane's height
// is bounded and never needs a vertical scroller either.
function ExcerptPane({ title, lines, tone }: { title: string; lines: Array<{ text: string; changed: boolean }>; tone: 'before' | 'after' }) {
  const changedBg = tone === 'before' ? 'rgba(244,71,71,0.16)' : 'rgba(129,199,132,0.18)'
  return (
    <div style="margin-top:5px">
      <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:2px">{title}</div>
      <div style="font-family:var(--vscode-editor-font-family,ui-monospace,monospace);font-size:10px;line-height:1.45;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,0.08));border:1px solid var(--border);border-radius:4px;padding:6px 8px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere">
        {lines.map((l, i) => (
          <div key={i} style={l.changed ? `background:${changedBg};border-radius:2px` : ''}>{l.text || ' '}</div>
        ))}
      </div>
    </div>
  )
}

// Split two excerpts into per-line change flags (set-based: a line present in one side but not the
// other is "changed"). Good enough for the short, parser-capped excerpts and keeps the diff honest
// without shipping an LCS implementation into the bundle.
function splitDiffLines(before: string, after: string): { before: Array<{ text: string; changed: boolean }>; after: Array<{ text: string; changed: boolean }> } {
  const b = before.split('\n'); const a = after.split('\n')
  const bSet = new Set(b); const aSet = new Set(a)
  return {
    before: b.map(text => ({ text, changed: !aSet.has(text) })),
    after: a.map(text => ({ text, changed: !bSet.has(text) })),
  }
}

const DIFF_STATUS_COLOR: Record<TurnSourceDiff['status'], string> = {
  added: 'var(--vscode-charts-green,#81c784)',
  removed: 'var(--error,#f44747)',
  resized: 'var(--vscode-charts-orange,#e2a03f)',
  unchanged: 'var(--muted)',
}

// The block-level before/after content of the ONE block that broke the prefix cache. Degrades
// gracefully: an added block shows only AFTER, a removed block only BEFORE, and a block whose
// excerpt the parser didn't capture shows the token-size change with an explicit "raw-body capture"
// note — never fabricated text.
function OffenderContent({ o }: { o: TurnSourceDiff }) {
  const hasBefore = o.prevExcerpt !== undefined && o.prevExcerpt !== ''
  const hasAfter = o.curExcerpt !== undefined && o.curExcerpt !== ''
  if (o.status === 'resized' && hasBefore && hasAfter) {
    const d = splitDiffLines(o.prevExcerpt!, o.curExcerpt!)
    return <>
      <ExcerptPane title={`Before · turn was ${formatCompact(o.prevTokens)} tok`} lines={d.before} tone="before" />
      <ExcerptPane title={`After · now ${formatCompact(o.curTokens)} tok`} lines={d.after} tone="after" />
    </>
  }
  if (o.status === 'added') {
    return hasAfter
      ? <ExcerptPane title="After · new block (absent from the previous turn)" lines={o.curExcerpt!.split('\n').map(text => ({ text, changed: true }))} tone="after" />
      : <div style="margin-top:4px;color:var(--muted)">New block added this turn ({formatCompact(o.curTokens)} tok). Full text needs raw-body capture enabled.</div>
  }
  if (o.status === 'removed') {
    return hasBefore
      ? <ExcerptPane title="Before · block removed this turn" lines={o.prevExcerpt!.split('\n').map(text => ({ text, changed: true }))} tone="before" />
      : <div style="margin-top:4px;color:var(--muted)">Block present last turn ({formatCompact(o.prevTokens)} tok) was dropped this turn. Full text needs raw-body capture enabled.</div>
  }
  // resized but at least one excerpt missing → show the size change only, honestly labelled.
  return (
    <div style="margin-top:4px;color:var(--muted)">
      Block content changed: {formatCompact(o.prevTokens)} → {formatCompact(o.curTokens)} tok.
      {(!hasBefore || !hasAfter) && ' Full before/after text needs raw-body capture enabled.'}
    </div>
  )
}

// The cache-break POPUP (#92, TRDD-CB9POPUP): clicking the ⚡ badge opens this. It shows the
// before/after prompt-prefix BLOCK diff between the two consecutive turns, the first-divergent block
// (the one that actually broke the prefix cache) highlighted, plus every added/removed/resized block.
// Data is 100% client-reachable from the already-loaded ContextComposition (each block's `excerpt`
// is the real injected text) — no server round-trip. Non-block causes and missing/loading
// compositions degrade gracefully with an explicit note; nothing is fabricated.
// The card has NO overflow scroller (no-nested-scrollbars rule): the parser-capped excerpts + a
// capped changed-block list keep it bounded, and long text wraps.
const CHANGED_CAP = 14
function CacheBreakModal({ cb, turn, prevTurn, prevSources, curSources, onClose }: {
  cb: CacheBreakTurn
  turn: number
  prevTurn?: number
  prevSources?: ContextSource[]
  curSources?: ContextSource[]
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const diff = (prevSources && curSources) ? diffTurnSources(prevSources, curSources) : null
  // The first divergence is authoritative and, by construction (shared diffTurnSources), equals the
  // analyzer's named offender in cb.breakSourceLabel/Kind.
  const offender = diff?.find(e => e.isFirstDivergence)
    ?? (cb.breakSourceLabel ? diff?.find(e => e.label === cb.breakSourceLabel && e.kind === (cb.breakSourceKind ?? e.kind)) : undefined)
  const changed = (diff ?? []).filter(e => e.status !== 'unchanged')
    .sort((a, b) => (Number(b.isFirstDivergence) - Number(a.isFirstDivergence)) || (Math.abs(b.curTokens - b.prevTokens) - Math.abs(a.curTokens - a.prevTokens)))
  const unchangedCount = (diff ?? []).length - changed.length

  return (
    <>
      <div onClick={onClose} style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:400" />
      <div class="cache-break-diff-popup" role="dialog" aria-label="Cache break prefix diff"
        onClick={e => e.stopPropagation()}
        style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:401;width:calc(100vw - 32px);max-width:720px;background:var(--vscode-editor-background,var(--bg));color:var(--vscode-foreground,var(--fg));border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.5);padding:14px 16px;font-size:11px;line-height:1.5">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
          <span style="font-weight:700;color:var(--error,#f44747)">⚡ Cache break — {CAUSE_LABEL[cb.cause]}</span>
          <span style="color:var(--muted);font-size:10px">
            {prevTurn !== undefined ? `Turn ${prevTurn} → ${turn}` : `Turn ${turn}`} · prompt-prefix diff
          </span>
          <button onClick={onClose} title="Close (Esc)"
            style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);cursor:pointer;font-size:12px;line-height:1;padding:3px 8px">✕</button>
        </div>

        <div style="margin-bottom:10px">
          <span>Wasted re-write: <strong>{formatCompact(cb.wastedTokens)}</strong> cache-created tokens</span>
          {cb.wastedCostUsd > 0 && <span> · <strong>~{fmtUsd(cb.wastedCostUsd)}</strong></span>}
          {cb.idleGapMs !== undefined && cb.cause === 'IDLE_TTL_EXPIRY' && <span> · idle gap {formatMs(cb.idleGapMs)} (&gt; 5-min TTL)</span>}
          {cb.remediation && <div style="margin-top:3px;color:var(--muted)">→ {cb.remediation}</div>}
        </div>

        {diff === null ? (
          <div style="padding:8px 10px;border-left:3px solid var(--vscode-charts-orange,#e2a03f);background:rgba(226,160,63,0.08);border-radius:0 4px 4px 0;color:var(--muted)">
            {curSources === undefined
              ? 'Session composition is still loading — reopen in a moment for the block-level before/after.'
              : 'Previous-turn composition isn’t available (turn 1, or a fork/sub-agent whose context comes from the parent transcript), so a block-level before/after can’t be shown here. The cause and cost above are still exact.'}
          </div>
        ) : offender ? (
          <div style="margin-bottom:10px;padding:8px 10px;border-left:3px solid var(--error,#f44747);background:rgba(244,71,71,0.08);border-radius:0 4px 4px 0">
            <div style="margin-bottom:2px">
              <span style="font-weight:600">First divergence — this block broke the prefix cache:</span>
            </div>
            <div>
              <code style="color:var(--vscode-charts-orange,#e2a03f)">{offender.label}</code>
              <span style="color:var(--muted)"> ({offender.kind})</span>
              <span style={`margin-left:8px;font-size:9px;font-weight:700;text-transform:uppercase;color:${DIFF_STATUS_COLOR[offender.status]}`}>{offender.status}</span>
            </div>
            <OffenderContent o={offender} />
          </div>
        ) : (
          <div style="margin-bottom:10px;padding:8px 10px;border-left:3px solid var(--vscode-charts-orange,#e2a03f);background:rgba(226,160,63,0.08);border-radius:0 4px 4px 0;color:var(--muted)">
            This break is a session-level change ({CAUSE_LABEL[cb.cause]}), not a specific injected block — there is no single block-content before/after to show. Any block-size changes this turn are listed below.
          </div>
        )}

        {changed.length > 0 && (
          <div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">
              Changed blocks, turn {prevTurn ?? '—'} → {turn} · {changed.length}{unchangedCount > 0 ? ` (+${unchangedCount} unchanged share the prefix)` : ''}
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:10px;table-layout:fixed">
              <thead>
                <tr style="color:var(--muted);text-align:left">
                  <th style="font-weight:500;padding:2px 6px">Block</th>
                  <th style="font-weight:500;padding:2px 6px;width:70px">Kind</th>
                  <th style="font-weight:500;padding:2px 6px;width:110px;text-align:right">Before → after tok</th>
                  <th style="font-weight:500;padding:2px 6px;width:64px;text-align:right">Change</th>
                </tr>
              </thead>
              <tbody>
                {changed.slice(0, CHANGED_CAP).map(e => (
                  <tr key={e.key} style={`border-top:1px solid var(--border)${e.isFirstDivergence ? ';background:rgba(244,71,71,0.06)' : ''}`}>
                    <td style="padding:3px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={e.label}>{e.isFirstDivergence ? '⚡ ' : ''}{e.label}</td>
                    <td style="padding:3px 6px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{e.kind}</td>
                    <td style="padding:3px 6px;text-align:right;font-variant-numeric:tabular-nums">{formatCompact(e.prevTokens)} → {formatCompact(e.curTokens)}</td>
                    <td style={`padding:3px 6px;text-align:right;font-weight:600;text-transform:uppercase;font-size:9px;color:${DIFF_STATUS_COLOR[e.status]}`}>{e.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {changed.length > CHANGED_CAP && (
              <div style="font-size:10px;color:var(--muted);padding:3px 6px">+{changed.length - CHANGED_CAP} more changed blocks…</div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function TurnGroup({ turn, tSteps, sessIdx, sessionModel, metric, maxTurnMetric, highlightSpanId, subAgents, cacheBreak, hostSources, prevTurn, prevSources }: {
  turn: number
  tSteps: Array<{ step: Step; i: number }>
  sessIdx: number; sessionModel: string
  metric: TimelineMetric; maxTurnMetric: number
  highlightSpanId?: string
  subAgents?: SessionSummaryCard[]
  cacheBreak?: CacheBreakTurn
  hostSources?: ContextSource[]
  prevTurn?: number
  prevSources?: ContextSource[]
}) {
  const totals = sumSteps(tSteps.map(x => x.step), sessionModel)
  const hasHighlight = !!highlightSpanId && tSteps.some(x => x.step.entry.spanId === highlightSpanId)
  const [open, setOpen] = useState(true)
  const [breakOpen, setBreakOpen] = useState(false)
  // A focused turn (clicked from the growth chart) force-expands its group so the step is visible.
  useEffect(() => { if (hasHighlight) setOpen(true) }, [hasHighlight])

  const tv = turnMetricValue(totals, metric)
  const width = maxTurnMetric > 0 && tv > 0 ? Math.max(tv / maxTurnMetric * 100, 0.5) : 0
  const barColor = metric === 'time' ? 'var(--accent)' : METRIC_COLOR[metric]
  const broke = cacheBreak?.broke === true

  return (
    <div class="wf-turn-group">
      <div class="wf-row wf-turn-row" onClick={() => setOpen(v => !v)} style="font-weight:600">
        <div class="wf-label">
          <span class="sw-chevron">{open ? '▼' : '▶'}</span>
          <span class="wf-type-badge" style="background:var(--accent);color:#000">T{turn}</span>
          <span style="display:inline-flex;flex-direction:column;min-width:0">
            <span class="wf-name">
              Turn {turn} · {tSteps.length} step{tSteps.length !== 1 ? 's' : ''}
              {broke && (
                <span
                  onClick={e => { e.stopPropagation(); setBreakOpen(true) }}
                  title="Prompt cache broke this turn — click for the before/after prefix diff"
                  style="margin-left:8px;font-size:9px;padding:1px 6px;border-radius:8px;font-weight:700;cursor:pointer;background:var(--error,#f44747);color:#fff;white-space:nowrap">
                  ⚡ cache break: {CAUSE_LABEL[cacheBreak!.cause]}
                </span>
              )}
            </span>
            <FiveValues t={totals} />
          </span>
        </div>
        <div class="wf-bar-area">
          <div class="wf-bar" style={`left:0;width:${width.toFixed(2)}%`}>
            <div class="wf-bar-inner" style={'background:' + barColor + ';opacity:0.55'} />
          </div>
        </div>
        <div class="wf-info">
          <span style={tv > 0 ? 'font-weight:600' : 'color:var(--muted)'}>{formatMetricValue(metric, tv)}</span>
        </div>
      </div>
      {broke && breakOpen && (
        <CacheBreakModal cb={cacheBreak!} turn={turn} prevTurn={prevTurn}
          prevSources={prevSources} curSources={hostSources} onClose={() => setBreakOpen(false)} />
      )}
      {open && (
        <div class="wf-turn-children">
          {(() => {
            // The recursive P5 drill-tree: this turn's component bars (5 usage values + injected
            // blocks), each expanding down to the actual content bytes at a leaf.
            const nodes = buildTurnNodes(tSteps.map(x => x.step), totals, hostSources ?? [], sessionModel)
            const max = Math.max(0, ...nodes.map(n => n.weight))
            const ordered = timelineSortByValue.value && metric !== 'time' ? [...nodes].sort((a, b) => b.weight - a.weight) : nodes
            return ordered.map(n => <TreeBar key={n.key} node={n} depth={0} siblingMax={max} />)
          })()}
          {/* TRDD-62E8UU41: the spawn-cost rollup + antipattern detections for the children spawned by
              THIS turn — surfaced right above the sub-branch rows so the fan-out's aggregate cost and
              the cheaper-spawn advice sit on the spawning step. */}
          {(subAgents ?? []).length > 0 && (
            <SpawnCostPanel children={subAgents!} parentModel={sessionModel} heading="Spawn cost (this turn)" />
          )}
          {(subAgents ?? []).map(c => <SubAgentBranch key={c.sessionId} child={c} sessIdx={sessIdx} />)}
        </div>
      )}
    </div>
  )
}

// TRDD-06Q5AXYN Phase 3 (D2): the subtle boundary marker between turns/steps that are dimmed as
// "before this window" and the in-window content below. Text sits on the rule itself (Slack-style
// divider), theme-aware via the shared --border/--muted vars so it reads correctly in both themes.
function WindowBoundaryDivider() {
  return (
    <div class="wf-window-divider">
      <span>before this window</span>
    </div>
  )
}

// A sub-agent's reported footprint as a TurnTotals so it renders with the same FiveValues strip.
// Tokens come from the child card's buckets; cost is the token-mode session cost of the child.
function subAgentTotals(child: SessionSummaryCard): TurnTotals {
  return {
    input: child.inputTokens, output: child.outputTokens,
    cacheRead: child.cacheReadTokens, cacheWrite: child.cacheCreateTokens,
    cost: calcSessionCost(child, 'token').totalUsd, durationMs: child.durationMs,
  }
}

// One spawned sub-agent, rendered as an expandable sub-branch beneath the turn that spawned it.
// Collapsed: its type + 5-value footprint + a jump-to-session button. Expanded inline: its own
// trace (loaded on demand via loadSessionDetail), so the sub-agent is BOTH inline-expandable AND
// navigable to its own session (TRDD-TKN5VALS item 1).
function SubAgentBranch({ child, sessIdx }: { child: SessionSummaryCard; sessIdx: number }) {
  const [open, setOpen] = useState(false)
  const timelines = sessionTimelines.value
  const loaded = timelines[child.sessionId]
  const totals = subAgentTotals(child)

  useEffect(() => {
    if (open && loaded === undefined && vscode) vscode.postMessage({ type: 'loadSessionDetail', sessionId: child.sessionId })
  }, [child.sessionId, open])

  const timeline = loaded ?? child.timeline ?? []
  const steps: Step[] = timeline.map(entry => ({ entry, offsetMs: 0, durationMs: entry.durationMs || 0 }))
  const label = child.userRequest?.slice(0, 80) || (child.initiator === 'agent' ? 'sub-agent' : 'session')

  return (
    <div class="wf-turn-group" style="border-left:2px solid var(--vscode-charts-orange,#e2a03f);margin-left:6px">
      <div class="wf-row wf-turn-row" onClick={() => setOpen(v => !v)}>
        <div class="wf-label">
          <span class="sw-chevron">{open ? '▼' : '▶'}</span>
          <span class="wf-type-badge" style="background:var(--vscode-charts-orange,#e2a03f);color:#000" title="spawned sub-agent">↳</span>
          <span style="display:inline-flex;flex-direction:column;min-width:0">
            <span class="wf-name" title={label} style="display:inline-flex;align-items:center;gap:6px">
              {label}
              {spawnKindBadge(child)}
            </span>
            <FiveValues t={totals} />
          </span>
        </div>
        <div class="wf-bar-area" />
        <div class="wf-info" style="display:flex;gap:6px;align-items:center;justify-content:flex-end">
          <span style="color:var(--muted);font-size:9px">{child.model}</span>
          <button
            onClick={e => { e.stopPropagation(); focusedSessionId.value = child.sessionId; setOpen(true) }}
            style="padding:1px 6px;font-size:9px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7)"
            title="focus this sub-agent session">open →</button>
          <CopyBranchButton card={child} />
        </div>
      </div>
      {open && (
        <div class="wf-turn-children">
          {steps.length > 0
            ? <TimelineWaterfall steps={steps} sessionDur={child.durationMs || 1} sessionModel={child.model ?? ''} sessIdx={sessIdx} sessionId={child.sessionId} />
            : <div style="padding:8px 10px;font-size:10px;color:var(--muted)">Sub-agent has no separate transcript — Claude Code records only its final footprint ({formatCompact(totals.input + totals.output + totals.cacheRead + totals.cacheWrite)} tokens across {child.totalToolCalls} tool calls) in the parent.</div>}
        </div>
      )}
    </div>
  )
}

// Shared Trace waterfall: a STICKY metric toolbar (Time | token/cost | group-by-turn) above the
// step rows. With a token/cost metric the rows become a bar chart sortable by that value; Time
// keeps the chronological waterfall and its ruler. Grouped by turn it is a session → turn → step
// ── Tokens by cause (TRDD-UBEP5XY7) ───────────────────────────────────────────
// Session-view rollup of WHO spent the tokens, grouped from the per-call api_request ground truth
// (exact usage buckets + cost_usd) by src/shared/tokensByCause.ts (the same engine behind the
// get_cost_by_cause MCP tool, so both surfaces return the same numbers). Per-dimension toggle; clicking a named
// row filters the trace to exactly its calls via the structured `cause:<dim>=<key>` haystack token.
// The unattributed bucket is rendered explicitly (muted, pinned last) — counted, never dropped.
function TokensByCausePanel({ steps, card, activeFilter, onFilter }: {
  steps: Step[]; card?: SessionSummaryCard
  activeFilter: string; onFilter: (token: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [dim, setDim] = useState<CauseDimension | null>(null)
  // Session usage ground truth for the reconciliation footer. inputTokens is RAW on every card
  // (2026-07-10 normalization) — the four buckets are disjoint, so the total is a plain sum.
  const sessionTotal = useMemo(() => {
    if (!card) return null
    return card.inputTokens + card.cacheReadTokens + (card.cacheCreateTokens ?? 0) + card.outputTokens
  }, [card])
  const report = useMemo(
    () => buildTokensByCause(steps.map(s => s.entry), { sessionId: card?.sessionId, sessionTotalTokens: sessionTotal }),
    [steps, card?.sessionId, sessionTotal],
  )
  if (!report.hasAttribution) return null   // no api_request events → nothing to rank (not an error)

  // Dimensions worth a toggle: any named cause exists. Default = the first with named rows.
  const usable = report.dimensions.filter(d => d.attributedCalls > 0)
  const active = report.dimensions.find(d => d.dimension === dim && d.attributedCalls > 0)
    ?? usable[0] ?? report.dimensions[0]
  const maxTok = Math.max(1, ...active.rows.map(r => r.totalTokens))
  const rec = report.reconciliation

  return (
    <div style="border:1px solid var(--border);border-radius:4px;padding:6px 8px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:6px;cursor:pointer" onClick={() => setOpen(!open)}>
        <span style="font-size:10px;color:var(--muted)">{open ? '▾' : '▸'}</span>
        <span style="font-size:11px;font-weight:600">Tokens by cause</span>
        <span style="font-size:10px;color:var(--muted)">
          who spent the tokens — {report.apiRequestCalls} attributed call{report.apiRequestCalls !== 1 ? 's' : ''} · {formatCompact(rec.attributedTotalTokens)} tok · {fmtUsd(rec.attributedCostUsd)}{rec.costComplete ? '' : '+'}
        </span>
      </div>
      {open && (
        <div style="margin-top:6px">
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
            {usable.map(d => (
              <button key={d.dimension} onClick={() => setDim(d.dimension)}
                style={[
                  'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);',
                  d.dimension === active.dimension ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
                ].join('')}
              >{CAUSE_DIMENSION_LABEL[d.dimension]} ({d.rows.filter(r => !r.unattributed).length})</button>
            ))}
          </div>
          {active.rows.map(r => {
            const token = causeFilterToken(r.dimension, r.key)
            const isActive = !r.unattributed && activeFilter === token
            return (
              <div key={r.key}
                title={r.unattributed
                  ? 'Calls carrying no value for this dimension — counted here explicitly, never dropped. Not filterable (no cause token to match).'
                  : (isActive ? 'Click to clear the trace filter' : 'Click to filter the trace to exactly these calls')}
                onClick={r.unattributed ? undefined : () => onFilter(isActive ? '' : token)}
                style={[
                  'display:flex;align-items:center;gap:8px;padding:2px 4px;border-radius:3px;font-size:10px;',
                  r.unattributed ? 'color:var(--muted);font-style:italic' : 'cursor:pointer',
                  isActive ? ';background:var(--vscode-list-activeSelectionBackground,rgba(79,195,247,.15))' : '',
                ].join('')}
              >
                <span style="flex:0 0 180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.key}</span>
                <span style="flex:1;height:8px;background:var(--vscode-editorWidget-background,rgba(128,128,128,.15));border-radius:2px;overflow:hidden">
                  <span style={`display:block;height:100%;width:${Math.max(1, Math.round(r.totalTokens / maxTok * 100))}%;background:${r.unattributed ? 'var(--muted)' : 'var(--accent)'}`} />
                </span>
                <span style="flex:0 0 60px;text-align:right">{formatCompact(r.totalTokens)} tok</span>
                <span style="flex:0 0 52px;text-align:right">{fmtUsd(r.costUsd)}{r.costKnown ? '' : '+'}</span>
                <span style="flex:0 0 48px;text-align:right;color:var(--muted)">{r.calls} call{r.calls !== 1 ? 's' : ''}</span>
              </div>
            )
          })}
          {/* Reconciliation honesty: how much of the session's usage totals the api_request events cover.
              The remainder is SIGNED and explicit — never clamped, never hidden (FAIL-FAST). */}
          <div style="font-size:9px;color:var(--muted);margin-top:6px">
            {rec.sessionTotalTokens !== null && rec.unattributedTotalTokens !== null
              ? `Reconciliation: ${formatCompact(rec.attributedTotalTokens)} of ${formatCompact(rec.sessionTotalTokens)} session tokens attributed via api_request events; remainder ${rec.unattributedTotalTokens < 0 ? '−' : ''}${formatCompact(Math.abs(rec.unattributedTotalTokens))} tok not covered by any rich event.`
              : rec.note}
            {!rec.costComplete && ` Cost figures marked + are floors — ${rec.apiRequestCalls - rec.costCalls} call(s) carried no cost_usd.`}
          </div>
        </div>
      )}
    </div>
  )
}

// tree. Metric/sort/group are shared signals (P2.1) so every open trace agrees and the toggle
// lives in one sticky place. Used by the Sessions-detail Trace sub-tab.
export function TimelineWaterfall({ steps, sessionDur, sessionModel, sessIdx = 0, highlightSpanId, subAgents, sessionId }: {
  steps: Step[]; sessionDur: number; sessionModel: string; sessIdx?: number; highlightSpanId?: string
  subAgents?: SessionSummaryCard[]
  sessionId?: string
}) {
  const metric = timelineMetric.value
  const sortByValue = timelineSortByValue.value
  const groupByTurn = timelineGroupByTurn.value
  const [filterDraft, setFilterDraft] = useState('')     // live input value
  const [filterApplied, setFilterApplied] = useState('') // committed on Enter (not realtime)

  // Cache-break diagnosis for this session: reconstruct per-turn blocks from the host composition
  // (lazily requested on mount) + the resident timeline, diff turn-to-turn, and mark the turns whose
  // prefix cache broke. Recomputed only when the composition or the step set changes.
  const composition = sessionId ? sessionCompositions.value[sessionId] : undefined
  // A fork/sub-agent card has no own .jsonl — its transcript lives in the parent's log. Pass its
  // parentSessionId so the host parser can fall back to the parent's transcript (else the cache bars
  // would dead-end forever on "loading" for exactly these sessions — the bug this fixes).
  const parentSessionId = sessionSummary.value?.sessions.find(s => s.sessionId === sessionId)?.parentSessionId
  useEffect(() => {
    if (sessionId && composition === undefined && vscode) {
      vscode.postMessage({ type: 'loadContextComposition', sessionId, parentSessionId })
    }
  }, [sessionId, composition === undefined, parentSessionId])
  const breaksByTurn = useMemo(
    () => cacheBreaksByTurn(sessionId ? buildCacheBreakReport(sessionId, steps.map(s => s.entry), composition, sessionModel) : null),
    [sessionId, composition, steps.length, sessionModel],
  )
  // turn → the host-parsed injected blocks for that turn — passed into each LLM-call expansion so
  // clicking a call shows what its context was made of (the composition breakdown).
  const hostSourcesByTurn = new Map<number, ContextSource[]>()
  for (const t of composition?.turns ?? []) hostSourcesByTurn.set(t.turn, t.sources)
  // turn → its PREVIOUS turn, in chronological timeline order (INDEPENDENT of the display sort), so
  // the cache-break popup (#92) diffs turn N-1 → N against the real prior turn — the same pairing the
  // analyzer used, so the popup's first-divergence always matches the badge's cause.
  const chronoTurns = [...new Set(steps.map(s => s.entry.turn).filter((t): t is number => t !== undefined))].sort((a, b) => a - b)
  const prevTurnByTurn = new Map<number, number>()
  for (let i = 1; i < chronoTurns.length; i++) prevTurnByTurn.set(chronoTurns[i], chronoTurns[i - 1])
  // When the composition was reconstructed from a PARENT transcript (fork/sub-agent with no own log),
  // the parent's turn numbering doesn't line up with this session's own timeline turns, so a per-turn
  // lookup usually misses. Fall back to the UNION of all inherited injected blocks so the fork's calls
  // still drill into the REAL content it inherited; the per-call remainder node reconciles the exact
  // cache buckets so nothing is fabricated.
  const inheritedSources: ContextSource[] | undefined = composition?.reconstructedFrom
    ? mergeSources(composition.turns.flatMap(t => t.sources))
    : undefined
  const resolveHostSources = (turn: number | undefined): ContextSource[] | undefined => {
    const own = turn !== undefined ? hostSourcesByTurn.get(turn) : undefined
    return own && own.length ? own : inheritedSources
  }
  // Honest terminal note for a call whose injected blocks could NOT be itemized — never a perpetual
  // "loading". undefined composition = still loading; reconstructedFrom = fork/sub-agent whose blocks
  // come from the parent's transcript; null = OTEL-only/no local log at all.
  const compNote = composition === undefined
    ? ' Injected-block detail appears once the session composition finishes loading.'
    : composition && composition.reconstructedFrom
      ? ` This spawned session has no transcript of its own — its context was reconstructed from its parent ${composition.reconstructedFrom}. The inherited injected blocks are shown above; if none appear, the parent's transcript is not on disk.`
      : composition === null
        ? ' This session has no local transcript to itemize (OTEL-only, or its log was pruned) — the exact cache buckets are shown, but their injected blocks cannot be reconstructed.'
        : ' No injected blocks were itemized for this call.'

  const match = compileStepFilter(filterApplied)
  const valued = steps
    .map((step, i) => ({
      step, i,
      v: metric === 'time' ? step.durationMs : stepMetricValue(step.entry, metric, sessionModel),
    }))
    .filter(x => !filterApplied || match(stepHaystack(x.step.entry)))
  // maxMetric/sort are over the FILTERED set, so bars scale to what's visible.
  const maxMetric = Math.max(0, ...valued.map(x => x.v))
  const ordered = metric !== 'time' && sortByValue ? [...valued].sort((a, b) => b.v - a.v) : valued

  // Group into turns only when the data actually carries turn indices (log + OTEL Claude do).
  const hasTurns = valued.some(x => x.step.entry.turn !== undefined)
  const turnGroups: Array<{ turn: number; tSteps: Array<{ step: Step; i: number }>; agg: number }> = []
  if (groupByTurn && hasTurns) {
    const byTurn = new Map<number, Array<{ step: Step; i: number }>>()
    for (const x of valued) {
      const t = x.step.entry.turn ?? 0
      const arr = byTurn.get(t) ?? []
      arr.push({ step: x.step, i: x.i })
      byTurn.set(t, arr)
    }
    for (const [turn, tSteps] of byTurn) {
      const agg = turnMetricValue(sumSteps(tSteps.map(s => s.step), sessionModel), metric)
      turnGroups.push({ turn, tSteps, agg })
    }
    // Turns ordered chronologically (by turn number) unless the user asked to sort by value.
    turnGroups.sort((a, b) => (metric !== 'time' && sortByValue) ? b.agg - a.agg : a.turn - b.turn)
  }
  const maxTurnMetric = Math.max(0, ...turnGroups.map(g => g.agg))

  // TRDD-06Q5AXYN Phase 3 (D2): a turn/step whose entries are entirely before the active window's
  // `since` bound is still rendered (never hidden — the drilled conversation stays whole) but
  // dimmed behind a "before this window" divider, so the time-range picker's scope promise holds
  // even down here. A turn counts as before-window only when EVERY step in it is (conservative —
  // a turn straddling the boundary is left un-dimmed rather than over-marked). The divider only
  // makes sense in chronological order; sorted-by-value order scatters the boundary across the
  // list, so items still dim individually there but no divider line is drawn.
  const since = timeRange.value.since
  const isChronological = !(metric !== 'time' && sortByValue)
  let prevTurnBeforeWindow = false
  const turnDividers = turnGroups.map(g => {
    const beforeWindow = since !== undefined && g.tSteps.every(x => entryBeforeWindow(x.step.entry.timestamp, since))
    const showDivider = isChronological && !beforeWindow && prevTurnBeforeWindow
    prevTurnBeforeWindow = beforeWindow
    return { beforeWindow, showDivider }
  })
  let prevStepBeforeWindow = false
  const stepDividers = ordered.map(({ step }) => {
    const beforeWindow = entryBeforeWindow(step.entry.timestamp, since)
    const showDivider = isChronological && !beforeWindow && prevStepBeforeWindow
    prevStepBeforeWindow = beforeWindow
    return { beforeWindow, showDivider }
  })

  // Sub-agents spawned by this session nest under the turn that spawned them (spawnedByTurn). Any
  // whose spawn turn isn't among the rendered turns (or in flat mode) are shown after the list so
  // none are lost.
  const subsByTurn = new Map<number, SessionSummaryCard[]>()
  for (const c of subAgents ?? []) {
    const t = c.spawnedByTurn ?? -1
    const arr = subsByTurn.get(t) ?? []
    arr.push(c)
    subsByTurn.set(t, arr)
  }
  const renderedTurns = new Set(turnGroups.map(g => g.turn))
  const orphanSubs = (subAgents ?? []).filter(c => !(groupByTurn && hasTurns) || !renderedTurns.has(c.spawnedByTurn ?? -1))

  const mBtn = (m: { k: TimelineMetric; label: string }) => (
    <button
      onClick={() => { timelineMetric.value = m.k }}
      style={[
        'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);',
        metric === m.k ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
      ].join('')}
    >{m.label}</button>
  )

  return (
    <div>
      <div class="wf-sticky-toolbar">
        <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px">
          <span style="font-size:10px;color:var(--muted);margin-right:2px">Bars:</span>
          {TIMELINE_METRICS.map(mBtn)}
          {metric !== 'time' && (
            <button
              onClick={() => { timelineSortByValue.value = !sortByValue }}
              style="padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7);margin-left:4px"
            >{sortByValue ? '↓ Sorted by value' : '⏱ Chronological'}</button>
          )}
          {hasTurns && (
            <button
              onClick={() => { timelineGroupByTurn.value = !groupByTurn }}
              style={[
                'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);margin-left:4px;',
                groupByTurn ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
              ].join('')}
            >⤷ {groupByTurn ? 'Grouped by turn' : 'Flat'}</button>
          )}
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <input
            value={filterDraft}
            onInput={e => setFilterDraft((e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter') setFilterApplied(filterDraft)
              else if (e.key === 'Escape') { setFilterDraft(''); setFilterApplied('') }
            }}
            placeholder="Filter steps by content — e.g. gh repo · server/scripts · server/script_*.ts  (Enter; * = wildcard)"
            style="flex:1;min-width:160px;padding:3px 8px;font-size:11px;border-radius:3px;border:1px solid var(--border);background:var(--vscode-input-background,var(--bg));color:var(--vscode-input-foreground,var(--fg))"
          />
          {filterApplied && (
            <>
              <span style="font-size:10px;color:var(--muted);white-space:nowrap">{valued.length} / {steps.length}</span>
              <button
                onClick={() => { setFilterDraft(''); setFilterApplied('') }}
                style="padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--muted)"
              >Clear</button>
            </>
          )}
        </div>
      </div>
      {/* TRDD-UBEP5XY7 — who spent the tokens; rows drive the same filter the input box commits. */}
      <TokensByCausePanel steps={steps}
        card={sessionId ? sessionSummary.value?.sessions.find(s => s.sessionId === sessionId) : undefined}
        activeFilter={filterApplied}
        onFilter={token => { setFilterDraft(token); setFilterApplied(token) }} />
      {metric === 'time' && !groupByTurn && (
        <div class="wf-time-ruler">
          {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
        </div>
      )}
      {filterApplied && ordered.length === 0
        ? <div class="empty-state" style="padding:10px 0;font-size:11px">No steps match “{filterApplied}”</div>
        : groupByTurn && hasTurns
          ? turnGroups.map((g, gi) => (
              <div key={g.turn}>
                {turnDividers[gi].showDivider && <WindowBoundaryDivider />}
                <div class={turnDividers[gi].beforeWindow ? 'wf-before-window' : undefined}>
                  <TurnGroup turn={g.turn} tSteps={g.tSteps} sessIdx={sessIdx}
                    sessionModel={sessionModel} metric={metric}
                    maxTurnMetric={maxTurnMetric} highlightSpanId={highlightSpanId}
                    subAgents={subsByTurn.get(g.turn)} cacheBreak={breaksByTurn.get(g.turn)}
                    hostSources={resolveHostSources(g.turn)}
                    prevTurn={prevTurnByTurn.get(g.turn)}
                    prevSources={composition?.reconstructedFrom ? undefined : resolveHostSources(prevTurnByTurn.get(g.turn))} />
                </div>
              </div>
            ))
          : ordered.map(({ step, i }, oi) => (
              <div key={step.entry.spanId + i}>
                {stepDividers[oi].showDivider && <WindowBoundaryDivider />}
                <div class={stepDividers[oi].beforeWindow ? 'wf-before-window' : undefined}>
                  <StepRow step={step} idx={i} sessIdx={sessIdx}
                    sessionDur={sessionDur} sessionModel={sessionModel} metric={metric} maxMetric={maxMetric}
                    highlightSpanId={highlightSpanId} hostSources={resolveHostSources(step.entry.turn)} compNote={compNote} sessionId={sessionId} />
                </div>
              </div>
            ))
      }
      {orphanSubs.length > 0 && (
        <div class="wf-turn-children">
          <div style="font-size:9px;color:var(--muted);padding:2px 0 2px 6px">Sub-agents</div>
          {orphanSubs.map(c => <SubAgentBranch key={c.sessionId} child={c} sessIdx={sessIdx} />)}
        </div>
      )}
    </div>
  )
}

function SessionBlock({ sess, sessIdx, sessNum, totalCount, isFirst }: {
  sess: SessionSummaryCard; sessIdx: number; sessNum: number; totalCount: number; isFirst: boolean
}) {
  const [collapsed, setCollapsed] = useState(!isFirst)
  const [promptExpanded, setPromptExpanded] = useState(false)
  const isFocused = focusedSessionId.value === sess.sessionId
  const isLongPrompt = (sess.userRequest?.length ?? 0) > 100

  const sessionTime = formatSessionTime(sess)
  const sessionStartMs = sess.startTime ? new Date(sess.startTime).getTime() : 0
  let sessionDur = sess.durationMs || 1

  const timelines = sessionTimelines.value
  const loadedTimeline = timelines[sess.sessionId]
  const isLoading = !collapsed && loadedTimeline === undefined
  // TRDD-ZS1GDXVY: session-level "generated files" group (loaded lazily alongside the timeline).
  const sessionGenFiles = sessionGeneratedFiles.value[sess.sessionId]

  useEffect(() => {
    if (!collapsed && loadedTimeline === undefined) {
      if (vscode) vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }, [sess.sessionId, collapsed])

  const toggle = () => {
    const opening = collapsed
    setCollapsed(v => !v)
    if (opening && loadedTimeline === undefined) {
      if (vscode) vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }

  const timeline = loadedTimeline ?? sess.timeline ?? []
  const steps: Step[] = timeline.map(entry => {
    const entryStart = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const offset = sessionStartMs > 0 && entryStart > 0 ? entryStart - sessionStartMs : 0
    return { entry, offsetMs: Math.max(offset, 0), durationMs: entry.durationMs || 0 }
  })

  if (steps.length > 0) {
    const maxEnd = Math.max(...steps.map(s => s.offsetMs + s.durationMs))
    if (maxEnd > sessionDur) sessionDur = maxEnd
  }
  if (sessionDur <= 0) sessionDur = 1

  const errorCount = sess.errors || 0
  const outcomeLabel = sess.outcome === 'text_response' ? 'Responded' : sess.outcome === 'tool_calls' ? 'Tool calls' : null

  // Sub-agent sessions this one spawned (Claude Task/Agent). Rolled up on the header and nested
  // under their spawning turn inside the waterfall (TRDD-TKN5VALS item 1).
  const children = (sessionSummary.value?.sessions ?? []).filter(s => s.parentSessionId === sess.sessionId && s.sessionId !== sess.sessionId)
  const childTok = children.reduce((n, c) => n + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreateTokens, 0)
  const childCost = children.reduce((n, c) => n + calcSessionCost(c, 'token').totalUsd, 0)

  return (
    <div id={`trace-session-${sess.sessionId}`} class="wf-trace-group" style={isFocused ? 'outline:2px solid var(--vscode-focusBorder,#007fd4);border-radius:4px;outline-offset:1px' : ''}>
      <div class="wf-trace-header" onClick={toggle}>
        <span>
          <span class="wf-header-chevron">{collapsed ? '▶' : '▼'}</span>
          <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(sess.source) }} />{' '}
          <span style="font-size:10px;color:var(--muted);margin-right:4px">#{sessNum}</span>
          <span style="font-size:10px;color:var(--muted)">{sessionTime}</span>{' '}
          {sess.userRequest && sess.userRequest !== '[prompt unavailable]' && sess.userRequest !== '[session in progress]'
            ? <>"{sess.userRequest.slice(0, 100)}{isLongPrompt ? '…' : ''}"</>
            : <span style="color:var(--muted);font-style:italic">{sess.userRequest || '[no prompt]'}</span>
          }
          {isLongPrompt && (
            <button class="sw-show-full-btn" style="margin-left:8px" onClick={e => { e.stopPropagation(); setPromptExpanded(v => !v) }}>
              {promptExpanded ? 'Collapse' : 'Show full prompt'}
            </button>
          )}
        </span>
        <span class="wf-trace-stats">
          {steps.length} steps · {formatMs(sessionDur)} · {sess.model}
          {(sess.cacheReadTokens + sess.cacheCreateTokens) > 0 && sess.cacheHitRate < cacheHitSliThreshold.value && (
            <span
              title={`Low cache hit rate — ${formatPct(sess.cacheHitRate)} vs ${formatPct(cacheHitSliThreshold.value)} SLI. Cache breaks are re-writing the prefix; expand turns for the cause.`}
              style={`margin-left:6px;font-size:9px;padding:1px 6px;border-radius:8px;font-weight:600;border:1px solid ${hitRateColor(sess.cacheHitRate, cacheHitSliThreshold.value)};color:${hitRateColor(sess.cacheHitRate, cacheHitSliThreshold.value)}`}>
              ⚡ {formatPct(sess.cacheHitRate)} cache hit
            </span>
          )}
          {children.length > 0 && (
            <span style="color:var(--vscode-charts-orange,#e2a03f)" title="sub-agent tokens rolled up (spawned Task/Agent sessions)">
              {' · '}↳{children.length} sub-agent{children.length !== 1 ? 's' : ''} +{formatCompact(childTok)} tok{childCost > 0 ? ` +${fmtUsd(childCost)}` : ''}
            </span>
          )}
          {errorCount > 0 && <span class="err"> · {errorCount} errors</span>}
          {outcomeLabel && <>{' · '}{outcomeLabel}</>}
        </span>
      </div>

      {promptExpanded && (
        <div style="padding:6px 10px 6px 28px;background:var(--hover);border-left:1px solid var(--border);border-right:1px solid var(--border);font-size:11px;color:var(--fg);white-space:pre-wrap;word-break:break-word">
          {sess.userRequest}
        </div>
      )}
      {!collapsed && (
        <div class="wf-trace-body">
          {isLoading ? (
            <div style="padding:12px 16px;font-size:11px;color:var(--muted)">Loading timeline…</div>
          ) : (
            <>
              {/* TRDD-62E8UU41: session-level spawn-cost panel — the whole session's fan-out aggregate
                  + antipattern detections (FLEET-COLD / WORKTREE-SCATTER / MODEL-MIX). Sits at the top
                  of the trace body so the fleet burn is visible without expanding every turn. */}
              {children.length > 0 && (
                <div style="padding:2px 16px 0">
                  <SpawnCostPanel children={children} parentModel={sess.model ?? ''} />
                </div>
              )}
              <TimelineWaterfall steps={steps} sessionDur={sessionDur} sessionModel={sess.model ?? ''} sessIdx={sessIdx} subAgents={children} sessionId={sess.sessionId} />
            </>
          )}
          {/* Output-file / subfolder tracking (TRDD-ZS1GDXVY): the session-level "generated files"
              group — scratch-tree files + uncorrelated referenced outputs, lazy-loaded with the timeline. */}
          {!isLoading && sessionGenFiles && sessionGenFiles.files.length > 0 && (
            <div style="padding:6px 16px 10px">
              <GeneratedFilesList files={sessionGenFiles.files} truncated={sessionGenFiles.truncated} heading="Generated files" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DayGroup({ label, sessions, startNum, focusedId }: {
  label: string
  sessions: SessionSummaryCard[]
  startNum: number
  focusedId: string | null
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div style="margin-bottom:4px">
      <div
        style="display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;user-select:none;border-bottom:1px solid var(--vscode-panel-border)"
        onClick={() => setCollapsed(c => !c)}
      >
        <span style="font-size:10px;color:var(--muted)">{collapsed ? '▶' : '▼'}</span>
        <span style="font-size:12px;font-weight:600;color:var(--foreground)">{label}</span>
        <span style="font-size:10px;color:var(--muted)">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
      </div>
      {!collapsed && sessions.map((sess, idx) => (
        <SessionBlock
          key={sess.traceId + idx}
          sess={sess}
          sessIdx={idx}
          sessNum={startNum + idx}
          totalCount={sessions.length}
          isFirst={idx === 0 && focusedId === null}
        />
      ))}
    </div>
  )
}

export function Traces() {
  const base = filteredSessions.value
  const summary = sessionSummary.value
  const hasAny = (summary?.sessions?.length ?? 0) > 0
  const focusedId = focusedSessionId.value

  // Scroll to focused session when it changes
  useEffect(() => {
    if (!focusedId) return
    const el = document.getElementById(`trace-session-${focusedId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focusedId])

  if (!summary?.sessions?.length) {
    return <div id="summary-traces-content"><div class="empty-state">{hasAny ? 'No sessions match the active filters.' : 'No sessions recorded yet.'}</div></div>
  }

  // Sub-agent child sessions render nested under their spawning turn, so drop them from the
  // top-level list when their parent is also shown (avoids listing them twice). A child whose
  // parent is filtered out stays at top level so it is never lost (TRDD-TKN5VALS item 1).
  const shownIds = new Set(base.map(s => s.sessionId))
  const roots = base.filter(s => !s.parentSessionId || !shownIds.has(s.parentSessionId))
  const sessionsToShow = [...roots].reverse()
  const totalLlmCalls = sessionsToShow.reduce((s, sess) => s + sess.totalLlmCalls, 0)
  const totalToolCalls = sessionsToShow.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const totalTokens = sessionsToShow.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)

  // Group sessions by calendar day (newest day first)
  const dayGroups: Array<{ key: string; label: string; sessions: typeof sessionsToShow }> = []
  sessionsToShow.forEach(sess => {
    const dk = sessionDateKey(sess) || 'unknown'
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.key === dk) {
      last.sessions.push(sess)
    } else {
      dayGroups.push({ key: dk, label: dk === 'unknown' ? 'Unknown date' : formatDayLabel(dk), sessions: [sess] })
    }
  })

  return (
    <div id="summary-traces-content">
      <div class="tab-stats">
        <div><strong class="tab-stat-val">{sessionsToShow.length}</strong> sessions</div>
        <div><strong class="tab-stat-val">{totalLlmCalls}</strong> LLM calls</div>
        <div><strong class="tab-stat-val">{totalToolCalls}</strong> tool calls</div>
        <div><strong class="tab-stat-val">{formatCompact(totalTokens)}</strong> tokens</div>
      </div>
      <div class="waterfall">
        {sessionsToShow.length === 0 && (
          <div class="empty-state">No sessions in this time range</div>
        )}
        {(() => {
          let offset = 1
          return dayGroups.map(group => {
            const el = <DayGroup key={group.key} label={group.label} sessions={group.sessions} startNum={offset} focusedId={focusedId} />
            offset += group.sessions.length
            return el
          })
        })()}
      </div>
      {summary.backgroundSpans?.length > 0 && (
        <BgSummaryBlock bgSpans={summary.backgroundSpans} />
      )}
    </div>
  )
}
