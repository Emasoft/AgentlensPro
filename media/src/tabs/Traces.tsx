import { useState, useEffect, useRef, useMemo } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionCompositions, blobCache,
  focusedSessionId, vscode, cacheHitSliThreshold,
  timelineMetric, timelineSortByValue, timelineGroupByTurn,
} from '../state'
import type { TimelineMetric } from '../state'
import {
  formatMs, formatCompact, syntaxHighlightJson,
  getAgentDotHtml, formatLlmLabel, formatToolLabel, formatToolResult,
  sessionDateKey, formatDayLabel, formatSessionTime,
} from '../utils'
import { calcEntryCost, calcSessionCost, fmtUsd } from '../sessionMetrics'
import { buildCacheBreakReport, cacheBreaksByTurn, CAUSE_LABEL } from '../cacheBreak'
import { spawnKindBadge, hitRateColor, formatPct } from './cacheShared'
import type { SessionSummaryCard, TimelineEntry, BackgroundSpanSummary, CacheBreakTurn, ContextSource } from '../types'

// Colour per composition source-kind — shared with the ContextTab legend so the LLM-call context
// breakdown reads the same as the Context tab. Injected-block kinds (hook/skill/catalog/…) plus the
// exact usage buckets (cacheRead/input/cacheWrite/output).
const SOURCE_KIND_COLOR: Record<string, string> = {
  cacheRead: 'var(--vscode-charts-purple,#b392f0)', input: 'var(--vscode-charts-blue,#4fc3f7)',
  cacheWrite: 'var(--vscode-charts-orange,#e2a03f)', output: 'var(--vscode-charts-green,#81c784)',
  hook: '#e57373', skill: '#ba68c8', toolCatalog: '#4dd0e1', agentCatalog: '#7986cb',
  mcp: '#4db6ac', file: '#a1887f', reminder: '#fff176', tool: '#B8E986', other: 'var(--muted)',
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
  return parts.join('\n').toLowerCase()
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

// The per-turn context-composition breakdown shown when an LLM call is expanded — answers "why is
// this N cache-write / cache-read?". Combines the EXACT usage buckets for the call (resident
// cache-read transcript, new input, cache-created) with the HOST-parsed injected blocks for that
// turn (hooks, skill/tool/agent/mcp catalogs, files, reminders), sorted heaviest-first. Host
// figures are estimates (bytes/4, marked ~); the buckets are exact. No inner scrollbar — the list
// grows the page.
function LlmContextBreakdown({ entry, hostSources }: { entry: TimelineEntry; hostSources?: ContextSource[] }) {
  const newInput = Math.max(0, (entry.inputTokens ?? 0) - (entry.cacheReadTokens ?? 0) - (entry.cacheCreateTokens ?? 0))
  const rows: Array<{ label: string; tokens: number; kind: string; exact: boolean }> = []
  if ((entry.cacheReadTokens ?? 0) > 0) rows.push({ label: 'Cache-read (resident transcript)', tokens: entry.cacheReadTokens!, kind: 'cacheRead', exact: true })
  if (newInput > 0) rows.push({ label: 'New input tokens', tokens: newInput, kind: 'input', exact: true })
  if ((entry.cacheCreateTokens ?? 0) > 0) rows.push({ label: 'Cache-created (newly written)', tokens: entry.cacheCreateTokens!, kind: 'cacheWrite', exact: true })
  for (const s of hostSources ?? []) rows.push({ label: s.label, tokens: s.tokens, kind: s.kind, exact: false })
  rows.sort((a, b) => b.tokens - a.tokens)
  if (rows.length === 0) return null
  const max = rows[0].tokens || 1
  return (
    <div class="sw-detail-section">
      <div class="sw-detail-heading">Context composition (this turn)</div>
      <div style="font-size:9px;color:var(--muted);margin-bottom:4px">
        What the {formatCompact((entry.inputTokens ?? 0))}-token prompt was made of — <span style={'color:' + SOURCE_KIND_COLOR.cacheRead}>cache-read</span> reused vs{' '}
        <span style={'color:' + SOURCE_KIND_COLOR.cacheWrite}>cache-created</span> re-written, plus the injected blocks the host parsed from the raw log.
        {(hostSources?.length ?? 0) === 0 && <span> Injected-block detail loads with the session composition.</span>}
      </div>
      {rows.map((r, i) => {
        const w = Math.max(r.tokens / max * 100, 0.5)
        return (
          <div key={r.label + i} style="display:flex;align-items:center;font-size:10px;min-height:16px">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px" title={r.label}>{r.label}</span>
            <div style="width:120px;position:relative;height:9px;margin:0 6px">
              <div style={`position:absolute;left:0;height:7px;top:1px;border-radius:2px;width:${w.toFixed(1)}%;background:${SOURCE_KIND_COLOR[r.kind] ?? 'var(--muted)'};opacity:0.7`} />
            </div>
            <span style="width:78px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)">{formatCompact(r.tokens)}{r.exact ? '' : '~'} tok</span>
          </div>
        )
      })}
    </div>
  )
}

// The expanded body of an LLM call: model, exact token usage, the per-turn context-composition
// breakdown (why the prompt is this size), cost, the full response + reasoning. response/thinking
// are resolved by the parent (inline or blob) and passed in.
function LlmDetail({ entry, step, sessIdx, idx, sessionModel, hostSources, responseText, thinking }: {
  entry: TimelineEntry; step: Step; sessIdx: number; idx: number; sessionModel: string
  hostSources?: ContextSource[]; responseText: string; thinking: string
}) {
  const [showOutput, setShowOutput] = useState(false)
  const PREVIEW_LEN = 400
  const isLongResponse = responseText.length > PREVIEW_LEN
  const entryCost = calcEntryCost(entry, sessionModel)
  const newInput = Math.max(0, (entry.inputTokens ?? 0) - (entry.cacheReadTokens ?? 0) - (entry.cacheCreateTokens ?? 0))
  const hasCache = (entry.cacheReadTokens ?? 0) > 0 || (entry.cacheCreateTokens ?? 0) > 0
  return (
    <>
      <div class="sw-detail-section"><div class="sw-detail-heading">Model</div><div class="sw-detail-value">{entry.model || 'unknown'}</div></div>
      {((entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0) && (
        <div class="sw-detail-section">
          <div class="sw-detail-heading">Token Usage</div>
          <div class="sw-detail-value">
            <span class="sw-token-in">
              {hasCache ? `${newInput.toLocaleString()} new` : `${(entry.inputTokens ?? 0).toLocaleString()} input`}
              {(entry.cacheReadTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheReadTokens ?? 0).toLocaleString()} cached</span>}
              {(entry.cacheCreateTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheCreateTokens ?? 0).toLocaleString()} cache write</span>}
            </span>
            <span class="sw-token-arrow"> → </span>
            <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
          </div>
        </div>
      )}
      <LlmContextBreakdown entry={entry} hostSources={hostSources} />
      {entryCost > 0 && (
        <div class="sw-detail-section"><div class="sw-detail-heading">Cost</div><div class="sw-detail-value">{fmtUsd(entryCost)}</div></div>
      )}
      {responseText && (
        <div class="sw-detail-section">
          <div class="sw-detail-heading">
            Response
            {isLongResponse && (
              <button class="sw-show-full-btn" style="margin-left:8px" onClick={() => setShowOutput(v => !v)}>
                {showOutput ? 'Collapse' : 'Show full response'}
              </button>
            )}
          </div>
          <div class="sw-detail-value" style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.5">
            {showOutput ? responseText : responseText.slice(0, PREVIEW_LEN)}
            {isLongResponse && !showOutput && <span style="color:var(--muted)">…</span>}
          </div>
        </div>
      )}
      {thinking && <LongTextSection heading="Reasoning" text={thinking} id={'sw-thinking-' + sessIdx + '-' + idx} />}
      {(entry.ttft ?? 0) > 0 && (
        <div class="sw-detail-section"><div class="sw-detail-heading">Time to First Token</div><div class="sw-detail-value">{formatMs(entry.ttft!)}</div></div>
      )}
      <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
      {entry.action && <div class="sw-detail-section"><div class="sw-detail-heading">Stop reason</div><div class="sw-detail-value">{entry.action}</div></div>}
      {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
    </>
  )
}

// Detail body for ONE expanded step. EVERY step type expands to its exact content + context
// structure — nothing is a dead stat card: LLM calls show the per-turn composition breakdown +
// full response/reasoning, tool calls show the FULL output, user/message steps show their full
// text. Blob fields absent from DB rows are lazy-fetched via loadBlob (live sessions carry them
// inline). All hooks run unconditionally at the top so hook order is stable across renders.
function StepDetail({ step, idx, sessIdx, sessionModel, hostSources }: { step: Step; idx: number; sessIdx: number; sessionModel: string; hostSources?: ContextSource[] }) {
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
      hostSources={hostSources} responseText={entry.responseText || blobs[`${entry.spanId}:response`] || ''}
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

export function StepRow({ step, idx, sessIdx, sessionDur, sessionModel, metric, maxMetric, highlightSpanId, hostSources }: { step: Step; idx: number; sessIdx: number; sessionDur: number; sessionModel: string; metric: TimelineMetric; maxMetric: number; highlightSpanId?: string; hostSources?: ContextSource[] }) {
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
          <StepDetail step={step} idx={idx} sessIdx={sessIdx} sessionModel={sessionModel} hostSources={hostSources} />
        </div>
      )}
    </>
  )
}

// One turn = a collapsible parent row whose value is the SUM of its child steps. Shows all 5
// values (input/output/cache-read/cache-write/cost) and a bar of the selected metric; expands to
// the child StepRows. This is the session → turn → step tree the spec (P2.2) asks for.
// The expandable detail beneath a turn flagged as an avoidable cache break: the cause, the exact
// offending block, the wasted cache-created tokens/cost, and the one-line remediation hint.
function CacheBreakDetail({ cb }: { cb: CacheBreakTurn }) {
  return (
    <div style="margin:2px 0 4px 24px;padding:8px 10px;border-left:3px solid var(--error,#f44747);background:rgba(244,71,71,0.08);border-radius:0 4px 4px 0;font-size:10px;line-height:1.5">
      <div style="font-weight:600;color:var(--error,#f44747);margin-bottom:3px">Cache break — {CAUSE_LABEL[cb.cause]}</div>
      {cb.breakSourceLabel && (
        <div>Offending block: <code style="color:var(--vscode-charts-orange,#e2a03f)">{cb.breakSourceLabel}</code>{cb.breakSourceKind ? ` (${cb.breakSourceKind})` : ''}</div>
      )}
      <div>
        Wasted re-write: <strong>{formatCompact(cb.wastedTokens)}</strong> cache-created tokens
        {cb.wastedCostUsd > 0 && <> · <strong>~{fmtUsd(cb.wastedCostUsd)}</strong></>}
      </div>
      {cb.idleGapMs !== undefined && cb.cause === 'IDLE_TTL_EXPIRY' && (
        <div>Idle gap: {formatMs(cb.idleGapMs)} (&gt; 5-min TTL)</div>
      )}
      {cb.remediation && <div style="margin-top:3px;color:var(--muted)">→ {cb.remediation}</div>}
    </div>
  )
}

function TurnGroup({ turn, tSteps, sessIdx, sessionDur, sessionModel, metric, maxStepMetric, maxTurnMetric, highlightSpanId, subAgents, cacheBreak, hostSources }: {
  turn: number
  tSteps: Array<{ step: Step; i: number }>
  sessIdx: number; sessionDur: number; sessionModel: string
  metric: TimelineMetric; maxStepMetric: number; maxTurnMetric: number
  highlightSpanId?: string
  subAgents?: SessionSummaryCard[]
  cacheBreak?: CacheBreakTurn
  hostSources?: ContextSource[]
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
                  onClick={e => { e.stopPropagation(); setBreakOpen(v => !v) }}
                  title="Prompt cache broke this turn — click for the cause + wasted cost"
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
      {broke && breakOpen && <CacheBreakDetail cb={cacheBreak!} />}
      {open && (
        <div class="wf-turn-children">
          {tSteps.map(({ step, i }) => (
            <StepRow key={step.entry.spanId + i} step={step} idx={i} sessIdx={sessIdx}
              sessionDur={sessionDur} sessionModel={sessionModel} metric={metric} maxMetric={maxStepMetric}
              highlightSpanId={highlightSpanId} hostSources={hostSources} />
          ))}
          {(subAgents ?? []).map(c => <SubAgentBranch key={c.sessionId} child={c} sessIdx={sessIdx} />)}
        </div>
      )}
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
  useEffect(() => {
    if (sessionId && composition === undefined && vscode) {
      vscode.postMessage({ type: 'loadContextComposition', sessionId })
    }
  }, [sessionId, composition === undefined])
  const breaksByTurn = useMemo(
    () => cacheBreaksByTurn(sessionId ? buildCacheBreakReport(sessionId, steps.map(s => s.entry), composition, sessionModel) : null),
    [sessionId, composition, steps.length, sessionModel],
  )
  // turn → the host-parsed injected blocks for that turn — passed into each LLM-call expansion so
  // clicking a call shows what its context was made of (the composition breakdown).
  const hostSourcesByTurn = new Map<number, ContextSource[]>()
  for (const t of composition?.turns ?? []) hostSourcesByTurn.set(t.turn, t.sources)

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
      {metric === 'time' && !groupByTurn && (
        <div class="wf-time-ruler">
          {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
        </div>
      )}
      {filterApplied && ordered.length === 0
        ? <div class="empty-state" style="padding:10px 0;font-size:11px">No steps match “{filterApplied}”</div>
        : groupByTurn && hasTurns
          ? turnGroups.map(g => (
              <TurnGroup key={g.turn} turn={g.turn} tSteps={g.tSteps} sessIdx={sessIdx}
                sessionDur={sessionDur} sessionModel={sessionModel} metric={metric}
                maxStepMetric={maxMetric} maxTurnMetric={maxTurnMetric} highlightSpanId={highlightSpanId}
                subAgents={subsByTurn.get(g.turn)} cacheBreak={breaksByTurn.get(g.turn)}
                hostSources={hostSourcesByTurn.get(g.turn)} />
            ))
          : ordered.map(({ step, i }) => (
              <StepRow key={step.entry.spanId + i} step={step} idx={i} sessIdx={sessIdx}
                sessionDur={sessionDur} sessionModel={sessionModel} metric={metric} maxMetric={maxMetric}
                highlightSpanId={highlightSpanId} hostSources={hostSourcesByTurn.get(step.entry.turn ?? -1)} />
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
            <TimelineWaterfall steps={steps} sessionDur={sessionDur} sessionModel={sess.model ?? ''} sessIdx={sessIdx} subAgents={children} sessionId={sess.sessionId} />
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
