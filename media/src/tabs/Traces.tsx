import { useState, useEffect } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, focusedSessionId, vscode,
} from '../state'
import {
  formatMs, formatCompact, syntaxHighlightJson,
  getAgentDotHtml, formatLlmLabel, formatToolLabel, formatToolResult,
  sessionDateKey, formatDayLabel, formatSessionTime,
} from '../utils'
import { calcEntryCost, fmtUsd } from '../sessionMetrics'
import type { SessionSummaryCard, TimelineEntry, BackgroundSpanSummary } from '../types'

export interface Step {
  entry: TimelineEntry
  offsetMs: number
  durationMs: number
}

// ── Timeline bar metric ───────────────────────────────────────────────────────
// The Trace waterfall can size each step's bar by elapsed Time (the chronological
// default) OR by a token/cost magnitude, so the same timeline doubles as a per-step
// token/cost bar chart.
export type TimelineMetric = 'time' | 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'cost'

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

function StepDetail({ step, idx, sessIdx, sessionModel }: { step: Step; idx: number; sessIdx: number; sessionModel: string }) {
  const [showOutput, setShowOutput] = useState(false)
  const entry = step.entry

  if (entry.type === 'llm') {
    const PREVIEW_LEN = 400
    const isLongResponse = (entry.responseText?.length ?? 0) > PREVIEW_LEN
    const entryCost = calcEntryCost(entry, sessionModel)
    return (
      <>
        <div class="sw-detail-section"><div class="sw-detail-heading">Model</div><div class="sw-detail-value">{entry.model || 'unknown'}</div></div>
        {((entry.inputTokens ?? 0) > 0 || (entry.outputTokens ?? 0) > 0) && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Token Usage</div>
            <div class="sw-detail-value">
              {(entry.cacheReadTokens ?? 0) > 0 || (entry.cacheCreateTokens ?? 0) > 0 ? (
                <>
                  <span class="sw-token-in">
                    {Math.max(0, (entry.inputTokens ?? 0) - (entry.cacheReadTokens ?? 0) - (entry.cacheCreateTokens ?? 0)).toLocaleString()} new
                    {(entry.cacheReadTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheReadTokens ?? 0).toLocaleString()} cached</span>}
                    {(entry.cacheCreateTokens ?? 0) > 0 && <span style="color:var(--muted)"> + {(entry.cacheCreateTokens ?? 0).toLocaleString()} cache write</span>}
                  </span>
                  <span class="sw-token-arrow"> → </span>
                  <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
                </>
              ) : (
                <>
                  <span class="sw-token-in">{(entry.inputTokens ?? 0).toLocaleString()} input</span>
                  <span class="sw-token-arrow"> → </span>
                  <span class="sw-token-out">{(entry.outputTokens ?? 0).toLocaleString()} output</span>
                </>
              )}
            </div>
          </div>
        )}
        {entryCost > 0 && (
          <div class="sw-detail-section">
            <div class="sw-detail-heading">Cost</div>
            <div class="sw-detail-value">{fmtUsd(entryCost)}</div>
          </div>
        )}
        {entry.responseText && (
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
              {showOutput ? entry.responseText : entry.responseText.slice(0, PREVIEW_LEN)}
              {isLongResponse && !showOutput && <span style="color:var(--muted)">…</span>}
            </div>
          </div>
        )}
        {entry.thinking && <LongTextSection heading="Reasoning" text={entry.thinking} id={'sw-thinking-' + sessIdx + '-' + idx} />}
        {(entry.ttft ?? 0) > 0 && (
          <div class="sw-detail-section"><div class="sw-detail-heading">Time to First Token</div><div class="sw-detail-value">{formatMs(entry.ttft!)}</div></div>
        )}
        <div class="sw-detail-section"><div class="sw-detail-heading">Duration</div><div class="sw-detail-value">{formatMs(step.durationMs)}</div></div>
        {entry.action && <div class="sw-detail-section"><div class="sw-detail-heading">Stop reason</div><div class="sw-detail-value">{entry.action}</div></div>}
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
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
    const resultText = entry.fullResult || entry.resultSummary || ''
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
        {resultText && <LongTextSection heading="Result" text={resultText} id={'sw-result-' + sessIdx + '-' + idx} isJson />}
        {entry.isError && <div class="sw-detail-section"><div class="sw-detail-heading err">Error</div><div class="sw-detail-value err">This step failed</div></div>}
        {entry.timestamp && <div class="sw-detail-section"><div class="sw-detail-heading">Timestamp</div><div class="sw-detail-value sw-detail-muted">{entry.timestamp}</div></div>}
      </>
    )
  }

  return (
    <>
      <div class="sw-detail-section"><div class="sw-detail-heading">Background Task</div><div class="sw-detail-value">{entry.label || ''}</div></div>
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

export function StepRow({ step, idx, sessIdx, sessionDur, sessionModel, metric, maxMetric }: { step: Step; idx: number; sessIdx: number; sessionDur: number; sessionModel: string; metric: TimelineMetric; maxMetric: number }) {
  const [open, setOpen] = useState(false)
  const entry = step.entry
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
      <div class="wf-row" onClick={() => setOpen(v => !v)}>
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
          <StepDetail step={step} idx={idx} sessIdx={sessIdx} sessionModel={sessionModel} />
        </div>
      )}
    </>
  )
}

// Shared Trace waterfall: a metric toolbar (Time | token/cost) above the step rows. With a
// token/cost metric the rows become a bar chart that can be sorted by that value; Time keeps
// the chronological waterfall and its ruler. Used by the Traces tab AND the Sessions-detail
// Trace sub-tab so the toggle lives in one place.
export function TimelineWaterfall({ steps, sessionDur, sessionModel, sessIdx = 0 }: {
  steps: Step[]; sessionDur: number; sessionModel: string; sessIdx?: number
}) {
  const [metric, setMetric] = useState<TimelineMetric>('time')
  const [sortByValue, setSortByValue] = useState(false)
  const [filterDraft, setFilterDraft] = useState('')     // live input value
  const [filterApplied, setFilterApplied] = useState('') // committed on Enter (not realtime)

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

  const mBtn = (m: { k: TimelineMetric; label: string }) => (
    <button
      onClick={() => setMetric(m.k)}
      style={[
        'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);',
        metric === m.k ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
      ].join('')}
    >{m.label}</button>
  )

  return (
    <div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px">
        <span style="font-size:10px;color:var(--muted);margin-right:2px">Bars:</span>
        {TIMELINE_METRICS.map(mBtn)}
        {metric !== 'time' && (
          <button
            onClick={() => setSortByValue(v => !v)}
            style="padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7);margin-left:4px"
          >{sortByValue ? '↓ Sorted by value' : '⏱ Chronological'}</button>
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
      {metric === 'time' && (
        <div class="wf-time-ruler">
          {Array.from({ length: 6 }, (_, t) => <span key={t}>{formatMs(sessionDur * t / 5)}</span>)}
        </div>
      )}
      {filterApplied && ordered.length === 0
        ? <div class="empty-state" style="padding:10px 0;font-size:11px">No steps match “{filterApplied}”</div>
        : ordered.map(({ step, i }) => (
            <StepRow key={step.entry.spanId + i} step={step} idx={i} sessIdx={sessIdx}
              sessionDur={sessionDur} sessionModel={sessionModel} metric={metric} maxMetric={maxMetric} />
          ))
      }
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
            <TimelineWaterfall steps={steps} sessionDur={sessionDur} sessionModel={sess.model ?? ''} sessIdx={sessIdx} />
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

  const sessionsToShow = [...base].reverse()
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
