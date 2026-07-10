import { useState, useEffect, useRef } from 'preact/hooks'
import {
  filteredSessions, sessionSummary, sessionTimelines, sessionFileOps, burnRateData,
  serverBurnStatus,
  focusedSessionId, focusedTurn, vscode, ignoredInsightKeys,
  sessionSortKey, sessionSortDir, type SortKey,
  workspaceFilter, shortWorkspaceName,
} from '../state'
import {
  getAgentColor, getAgentSourceLabel, formatMs, formatCompact, formatSessionTime,
  getDataSourceBadgeHtml, getInitiatorBadgeHtml, getTokensSourceChipHtml,
} from '../utils'
import { calcSessionCost, isUnpriced } from '../sessionMetrics'
import { estimateTokensFromBytes } from '../tokenEstimator'
import { fmtUsd } from './Cost'
import { generateInsights, InsightCard } from './Insights'
import { buildDisplaySummary, tokenBreakdown, formatTokenBreakdown } from '../utils'
import { Step, TimelineWaterfall } from './Traces'
import { SpawnCostPanel } from './cacheShared'
import { computeKeepWarm } from '../../../src/shared/keepWarm'
import { FlowCanvas } from './Flow'
import { ToolsChart } from './Tools'
import type { SessionSummaryCard, FileOpSummary } from '../types'

// ── Session detail panel (shown in expanded row) ──────────────────────────────

type Section = 'overview' | 'trace' | 'files' | 'flow' | 'tools'

function PromptBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW_CHARS = 300
  const truncated = !expanded && text.length > PREVIEW_CHARS
  const display = truncated ? text.slice(0, PREVIEW_CHARS).trimEnd() + '…' : text
  return (
    <div style="margin-bottom:10px">
      <div style="font-size:9px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:4px">Prompt</div>
      <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:7px 10px;font-size:11px;white-space:pre-wrap;word-break:break-word;line-height:1.5;color:var(--foreground);max-height:200px;overflow-y:auto">
        {display}
      </div>
      {text.length > PREVIEW_CHARS && (
        <button
          onClick={() => setExpanded(e => !e)}
          style="margin-top:4px;font-size:10px;color:var(--vscode-textLink-foreground,#4fc3f7);background:none;border:none;cursor:pointer;padding:0"
        >
          {expanded ? 'Show less' : 'Show full prompt'}
        </button>
      )}
    </div>
  )
}

// ── Per-file I/O view (Files sub-tab) ─────────────────────────────────────────
// Renders sess.fileOps (per-file read/write/edit byte volumes) as sortable, filterable
// rows with a stacked size bar. Falls back to the flat filesChanged list for sessions
// with no per-file capture (non-Claude sources, which record only paths).
type FileSortKey = 'total' | 'name' | 'reads' | 'writes'

function fmtKB(bytes: number): string {
  if (bytes <= 0) return '0'
  const kb = bytes / 1024
  return kb < 10 ? kb.toFixed(1) : Math.round(kb).toLocaleString()
}

// Small inline loading spinner (CSS in styles/components.css). Shown while a session's detail
// is fetched on demand — detail (timeline + per-file ops) is no longer inlined in the bulk
// payload, so it arrives a moment after the row is expanded.
function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div class="al-spinner-wrap"><span class="al-spinner" />{label}</div>
}

function FilesView({ sess }: { sess: SessionSummaryCard }) {
  const [sortKey, setSortKey] = useState<FileSortKey>('total')
  const [filter, setFilter] = useState('')
  // Prefer lazily-fetched per-file ops; fall back to any inlined ops (VS Code/DB path).
  const ops = sessionFileOps.value[sess.sessionId] ?? sess.fileOps ?? []

  if (ops.length === 0) {
    // No per-file capture for this source — show the legacy modified-files list.
    if (sess.filesChanged.length === 0) {
      return <div class="empty-state" style="padding:12px 0">No file activity recorded</div>
    }
    return (
      <div style="display:flex;flex-direction:column;gap:3px">
        {sess.filesChanged.map(f => (
          <div
            key={f}
            style={`display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--hover);border-radius:4px;font-size:11px${vscode ? ';cursor:pointer' : ''}`}
            onClick={() => vscode?.postMessage({ type: 'openFile', filePath: f })}
            title={vscode ? 'Click to open in editor' : f}
          >
            <span style="color:var(--vscode-charts-green,#81c784);font-size:10px;flex-shrink:0">M</span>
            <span style={`font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${vscode ? ';color:var(--vscode-textLink-foreground,#4fc3f7)' : ''}`}>{f}</span>
          </div>
        ))}
        {sess.filesChangedNote && (
          <div style="font-size:10px;color:var(--muted);margin-top:3px">{sess.filesChangedNote}</div>
        )}
      </div>
    )
  }

  const READ_C = 'var(--vscode-charts-blue,#4fc3f7)'
  const WRITE_C = 'var(--vscode-charts-green,#81c784)'
  const EDIT_C = 'var(--vscode-charts-orange,#e2a03f)'

  const total = (o: FileOpSummary) => o.readBytes + o.writeBytes + o.editBytes
  const q = filter.trim().toLowerCase()
  const rows = ops
    .filter(o => !q || o.path.toLowerCase().includes(q))
    .sort((a, b) => {
      switch (sortKey) {
        case 'name':   return a.path.localeCompare(b.path)
        case 'reads':  return b.readBytes - a.readBytes
        case 'writes': return (b.writeBytes + b.editBytes) - (a.writeBytes + a.editBytes)
        default:       return total(b) - total(a)
      }
    })
  const maxTotal = Math.max(1, ...rows.map(total))
  const agg = rows.reduce((s, o) => ({ r: s.r + o.readBytes, w: s.w + o.writeBytes, e: s.e + o.editBytes }), { r: 0, w: 0, e: 0 })

  const sortBtn = (k: FileSortKey, label: string) => (
    <button
      onClick={() => setSortKey(k)}
      style={[
        'padding:2px 8px;font-size:10px;cursor:pointer;border-radius:3px;border:1px solid var(--border);',
        sortKey === k ? 'background:var(--accent);color:var(--vscode-button-foreground,#fff);font-weight:600' : 'background:transparent;color:var(--muted)',
      ].join('')}
    >{label}</button>
  )

  return (
    <div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px">
        <input
          value={filter}
          onInput={e => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by filename…"
          style="flex:1;min-width:120px;padding:3px 8px;font-size:11px;border-radius:3px;border:1px solid var(--border);background:var(--card-bg);color:var(--foreground)"
        />
        <span style="font-size:10px;color:var(--muted)">Sort:</span>
        {sortBtn('total', 'Size')}
        {sortBtn('reads', 'Reads')}
        {sortBtn('writes', 'Writes')}
        {sortBtn('name', 'Name')}
      </div>

      <div style="font-size:10px;color:var(--muted);margin-bottom:8px">
        <span style={`color:${READ_C}`}>● read {fmtKB(agg.r)} KB</span>
        <span style={`color:${WRITE_C};margin-left:10px`}>● write {fmtKB(agg.w)} KB</span>
        <span style={`color:${EDIT_C};margin-left:10px`}>● edit {fmtKB(agg.e)} KB</span>
        <span style="margin-left:10px;opacity:.75">~tokens ≈ bytes / 4</span>
      </div>

      {rows.length === 0
        ? <div class="empty-state" style="padding:12px 0">No files match “{filter}”</div>
        : (
          <div style="display:flex;flex-direction:column;gap:6px">
            {rows.map(o => {
              const pct = (n: number) => (n / maxTotal * 100).toFixed(2)
              const tokens = estimateTokensFromBytes(total(o))
              return (
                <div
                  key={o.path}
                  style={`padding:5px 8px;background:var(--hover);border-radius:4px${vscode ? ';cursor:pointer' : ''}`}
                  onClick={() => vscode?.postMessage({ type: 'openFile', filePath: o.path })}
                  title={vscode ? `${o.path}\nClick to open in editor` : o.path}
                >
                  <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:3px">
                    <span style={`font-family:monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap${vscode ? ';color:var(--vscode-textLink-foreground,#4fc3f7)' : ''}`}>{o.path}</span>
                    <span style="font-size:10px;color:var(--muted);flex-shrink:0;white-space:nowrap">{fmtKB(total(o))} KB · ~{formatCompact(tokens)} tok</span>
                  </div>
                  <div style="height:6px;border-radius:3px;background:var(--border);display:flex;overflow:hidden">
                    <div style={`width:${pct(o.readBytes)}%;background:${READ_C}`} />
                    <div style={`width:${pct(o.writeBytes)}%;background:${WRITE_C}`} />
                    <div style={`width:${pct(o.editBytes)}%;background:${EDIT_C}`} />
                  </div>
                  <div style="font-size:9px;color:var(--muted);margin-top:2px">
                    {o.readCount > 0 && <span style={`color:${READ_C}`}>R {o.readCount}× {fmtKB(o.readBytes)}KB</span>}
                    {o.writeCount > 0 && <span style={`color:${WRITE_C};margin-left:8px`}>W {o.writeCount}× {fmtKB(o.writeBytes)}KB</span>}
                    {o.editCount > 0 && <span style={`color:${EDIT_C};margin-left:8px`}>E {o.editCount}× {fmtKB(o.editBytes)}KB</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )
      }
    </div>
  )
}

function SessionDetail({ sess }: { sess: SessionSummaryCard }) {
  const [section, setSection] = useState<Section>('overview')
  // When a Context Growth point was clicked for THIS session, jump straight to the
  // trace tab so the clicked event (and its token count) is what the user lands on.
  const ft = focusedTurn.value
  const highlightSpanId = ft && ft.sessionId === sess.sessionId ? ft.spanId : undefined
  useEffect(() => {
    if (ft && ft.sessionId === sess.sessionId) setSection('trace')
  }, [ft?.sessionId, ft?.spanId])
  const timelines = sessionTimelines.value
  const timeline = timelines[sess.sessionId] ?? sess.timeline ?? []
  // Detail (timeline + file ops) is fetched on demand; `undefined` means the fetch is still in
  // flight (only meaningful when a host exists to answer it). Drives the per-section spinner.
  const detailLoading = timelines[sess.sessionId] === undefined && !!vscode
  const loadedFileOps = sessionFileOps.value[sess.sessionId]
  const fileCount = (loadedFileOps?.length ?? sess.fileOps?.length ?? 0) || sess.filesChanged.length
  const cost = calcSessionCost(sess, 'token')
  const cacheRate = sess.inputTokens > 0 ? Math.round(sess.cacheReadTokens / sess.inputTokens * 100) : 0
  const burnRate = burnRateData.value
  // P6 keep-warm: measured from the same lazily-fetched timeline the trace uses — the shared
  // engine (src/shared/keepWarm.ts) is the ONE implementation (never mirrored, per check-no-mirrors).
  const keepWarm = computeKeepWarm(timeline)
  // TRDD-62E8UU41: sub-agent children this session spawned. Passed into the trace waterfall so the
  // fan-out nests under its spawning turn (SubAgentBranch) with the per-turn spawn-cost rollup, and
  // rendered as the session-level "spawn cost" panel above the trace (aggregate + antipattern advice).
  const children = (sessionSummary.value?.sessions ?? []).filter(s => s.parentSessionId === sess.sessionId && s.sessionId !== sess.sessionId)

  useEffect(() => {
    if (!timelines[sess.sessionId] && vscode) {
      vscode.postMessage({ type: 'loadSessionDetail', sessionId: sess.sessionId })
    }
  }, [sess.sessionId])

  const ignored = ignoredInsightKeys.value
  const summary = buildDisplaySummary([sess])
  const sessInsights = generateInsights(summary, [sess]).filter(i => !ignored.has(i.title))

  const visibleEntries = timeline.filter(e => e.type !== 'background')
  const sessionStartMs = sess.startTime ? new Date(sess.startTime).getTime() : 0
  let sessionDur = sess.durationMs || 1

  const steps: Step[] = visibleEntries.map(entry => {
    const entryStart = entry.timestamp ? new Date(entry.timestamp).getTime() : 0
    const offset = sessionStartMs > 0 && entryStart > 0 ? entryStart - sessionStartMs : 0
    return { entry, offsetMs: Math.max(offset, 0), durationMs: entry.durationMs || 0 }
  })
  if (steps.length > 0) {
    const maxEnd = Math.max(...steps.map(s => s.offsetMs + s.durationMs))
    if (maxEnd > sessionDur) sessionDur = maxEnd
  }
  if (sessionDur <= 0) sessionDur = 1

  const navBtn = (s: Section, label: string) => (
    <button
      onClick={e => { e.stopPropagation(); setSection(s) }}
      style={[
        'padding:3px 10px;font-size:11px;cursor:pointer;border:none;border-bottom:2px solid transparent;background:transparent;',
        section === s ? 'color:var(--fg);border-bottom-color:var(--accent);font-weight:600' : 'color:var(--muted)',
      ].join('')}
    >{label}</button>
  )

  return (
    <div style="border-top:1px solid var(--border)" onClick={e => e.stopPropagation()}>
      <div style="display:flex;gap:0;padding:0 8px;border-bottom:1px solid var(--border);background:var(--vscode-editorWidget-background,var(--bg));overflow-x:auto">
        {navBtn('overview', 'Overview')}
        {navBtn('trace', `Trace${visibleEntries.length > 0 ? ' (' + visibleEntries.length + ')' : ''}`)}
        {navBtn('flow', `Flow${sess.totalLlmCalls > 0 ? ' (' + sess.totalLlmCalls + ')' : ''}`)}
        {navBtn('tools', `Tools${sess.totalToolCalls > 0 ? ' (' + sess.totalToolCalls + ')' : ''}`)}
        {navBtn('files', `Files${fileCount > 0 ? ' (' + fileCount + ')' : ''}`)}
      </div>

      <div style="padding:12px 14px">

        {section === 'overview' && (
          <div>
            {sess.dataSource === 'log' && (() => {
              const isCopilot = sess.source === 'copilot'
              const isOpenCode = sess.source === 'opencode'
              // Pre-~Feb 2026 Copilot Chat sessions (.json snapshot format): VS Code did not
              // record token counts at all — outputTokens=0 with turns>0 is the fingerprint.
              if (isCopilot && sess.outputTokens === 0 && sess.turns > 0) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorWarning-foreground,#cca700);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorWarning-foreground,#cca700);font-weight:600">Log-only session — no token data</span>
                    {' — '}
                    VS Code Copilot Chat did not record token counts in this era. Token counts and cost estimates are unavailable and cannot be recovered.
                  </div>
                )
              }
              if (isOpenCode) {
                return (
                  <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorInfo-foreground,#4fc3f7);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                    <span style="color:var(--vscode-editorInfo-foreground,#4fc3f7);font-weight:600">OpenCode SQLite session</span>
                    {' — '}
                    Token counts, tools, and files sourced from OpenCode&apos;s local database. OTEL traces and TTFT are not available for OpenCode.
                  </div>
                )
              }
              const missingTokens = isCopilot && sess.inputTokens === 0
              // For Claude Code / Codex log sessions, token, cost, tool and file data
              // ARE fully captured from the local logs — the ONLY thing OTEL adds is
              // live per-span trace timing (TTFT, waterfall). So this is an INFO note,
              // not a warning: don't paint it amber or tell the user something is
              // "not available" when their tokens/cost are right there. (Copilot logs
              // can genuinely lack token counts — call that out separately.)
              return (
                <div style="margin-bottom:10px;padding:7px 10px;border-radius:4px;border-left:3px solid var(--vscode-editorInfo-foreground,#4fc3f7);background:var(--hover);font-size:11px;color:var(--muted);line-height:1.5">
                  <span style="color:var(--vscode-editorInfo-foreground,#4fc3f7);font-weight:600">Sourced from local logs</span>
                  {' — '}
                  {missingTokens
                    ? 'this Copilot log did not record token counts. '
                    : 'token, cost, tool and file data are fully captured. '}
                  Per-span trace timing (TTFT &amp; waterfall) is the one extra that needs OTEL — optional, and it can&apos;t be turned on automatically because the agent itself must be configured to send traces (see the Help tab).
                </div>
              )
            })()}

            {sess.userRequest
              ? <PromptBlock text={sess.userRequest} />
              : sess.turns === 0
                ? <div style="margin-bottom:10px;font-size:11px;color:var(--muted);font-style:italic">Waiting for first turn…</div>
                : <div style="margin-bottom:10px;font-size:11px;color:var(--muted)">Prompt not captured for this session</div>
            }
            {/* P7 token-provenance chip — which feed backs the numbers below. A card persisted
                before the field renders "unknown" (honest absence), never a guess. */}
            <div style="margin-bottom:8px">
              <span dangerouslySetInnerHTML={{ __html: getTokensSourceChipHtml(sess.tokensSource, sess.coverageNote) }} />
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:10px">
              {[
                { k: 'LLM calls',  v: String(sess.totalLlmCalls) },
                { k: 'Tool calls', v: String(sess.totalToolCalls) },
                { k: 'Fresh input', v: formatCompact(tokenBreakdown(sess).fresh) },
                { k: 'Output tokens', v: formatCompact(sess.outputTokens) },
                { k: 'Cache read', v: formatCompact(sess.cacheReadTokens) },
                { k: 'Cache hit',  v: cacheRate + '%' },
                { k: 'Total context', v: formatCompact(sess.inputTokens) },
                ...(sess.peakContextPerTurn ? [{ k: 'Peak ctx/turn', v: formatCompact(sess.peakContextPerTurn) }] : []),
                { k: 'Duration',   v: formatMs(sess.durationMs) },
                ...(sess.errors > 0 ? [{ k: 'Errors', v: String(sess.errors) }] : []),
                // Fail-loud (TRDD-ZK37VG4X): a model missing from the pricing table must show
                // UNPRICED, not silently drop the cost cell — hiding it is how stale rates go
                // unnoticed while sessions bill $0.
                ...(isUnpriced(sess)
                  ? [{ k: 'Est. cost', v: 'UNPRICED' }]
                  : (!cost.modelUnknown && cost.totalUsd > 0 ? [{ k: 'Est. cost', v: fmtUsd(cost.totalUsd) }] : [])),
              ].map(({ k, v }) => (
                <div key={k} style="background:var(--card-bg);border:1px solid var(--border);border-radius:4px;padding:5px 8px">
                  <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.3px">{k}</div>
                  <div style="font-size:14px;font-weight:600;color:var(--vscode-textLink-foreground,#4fc3f7)">{v}</div>
                </div>
              ))}
            </div>

            {/* P6 keep-warm / cache-gap badge — same pill pattern as the resident-blob flag. Only
                rendered when the api_request ground truth measured at least one turn: a session
                without that data gets NO badge (honest absence), never a zeroed one. */}
            {keepWarm && keepWarm.warmTurns + keepWarm.coldTurns > 0 && (
              <div style="margin-bottom:10px">
                {keepWarm.coldTurns > 0
                  ? <span
                      title={`Prompt-cache gaps: ${keepWarm.coldTurns} turn(s) landed after the ~5-min cache TTL expired and re-WROTE ~${formatCompact(keepWarm.wastedWriteTokens)} tokens of prefix at the 1.25× write rate (a kept-warm cadence reads them at 0.1×). Worst gap ${keepWarm.worstGapMin}min. Keep turns inside the TTL — or batch the long pauses — to avoid the re-write.`}
                      style="padding:1px 6px;border-radius:3px;background:rgba(246,166,35,0.18);color:#f6a623;font-size:9px;font-weight:600;vertical-align:middle"
                    >❄ {keepWarm.coldTurns} cold turn{keepWarm.coldTurns !== 1 ? 's' : ''} · ~{formatCompact(keepWarm.wastedWriteTokens)} re-written · worst gap {keepWarm.worstGapMin}min</span>
                  : <span
                      title={`All ${keepWarm.warmTurns} measured turn(s) landed inside the ~5-min prompt-cache TTL — the prefix was read from cache at 0.1×, no expiry re-writes. Worst gap ${keepWarm.worstGapMin}min.`}
                      style="padding:1px 6px;border-radius:3px;background:rgba(129,199,132,0.15);color:var(--vscode-charts-green,#81c784);font-size:9px;font-weight:600;vertical-align:middle"
                    >♨ cache kept warm · {keepWarm.warmTurns} turn{keepWarm.warmTurns !== 1 ? 's' : ''}</span>
                }
              </div>
            )}

            {burnRate && burnRate.sessionId === sess.sessionId && (
              <div style="margin-bottom:10px;padding:6px 10px;border-radius:4px;border-left:3px solid #56D364;background:var(--hover);font-size:11px">
                <span style="color:#56D364;font-weight:600">{formatCompact(Math.round(burnRate.burnRate.tokensPerMinute))} tok/min</span>
                {burnRate.burnRate.costPerHour > 0.001 && <span style="color:var(--muted);margin-left:8px">~{fmtUsd(burnRate.burnRate.costPerHour)}/hr</span>}
                {burnRate.projection && <span style="color:var(--muted);margin-left:8px">{burnRate.projection.contextFillPct.toFixed(0)}% context used</span>}
              </div>
            )}

            {sessInsights.length > 0 && (
              <div>
                <div style="font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:6px">Insights</div>
                {sessInsights.slice(0, 4).map(ins => (
                  <InsightCard key={ins.title} ins={ins} isIgnored={false} sessions={[sess]} />
                ))}
              </div>
            )}

          </div>
        )}

        {section === 'trace' && (
          <div>
            {children.length > 0 && (
              <SpawnCostPanel children={children} parentModel={sess.model ?? ''} />
            )}
            {steps.length === 0
              ? (detailLoading
                  ? <Spinner label="Loading trace…" />
                  : children.length > 0
                    ? <div class="empty-state" style="padding:12px 0">No parent trace steps recorded — the spawn-cost panel above summarizes this session's sub-agent fan-out.</div>
                    : <div class="empty-state" style="padding:12px 0">No trace data for this session</div>)
              : (
                <div class="waterfall">
                  <TimelineWaterfall steps={steps} sessionDur={sessionDur} sessionModel={sess.model ?? ''} highlightSpanId={highlightSpanId} subAgents={children} sessionId={sess.sessionId} />
                </div>
              )
            }
          </div>
        )}

        {section === 'flow' && (
          <FlowCanvas sess={sess} height={420} />
        )}

        {section === 'tools' && (
          <ToolsChart sessions={[sess]} fileOps={loadedFileOps ?? sess.fileOps} />
        )}

        {section === 'files' && (detailLoading
          ? <Spinner label="Loading file activity…" />
          : <FilesView sess={sess} />)}

      </div>
    </div>
  )
}

// ── Table row ─────────────────────────────────────────────────────────────────

// Per-row token-composition bar: fresh-input / cache-read / cache-write / output as
// a share of THIS row's own total. Cross-session magnitude lives in the Tokens
// number and the Session Charts tab — normalising bar LENGTH across rows broke the
// moment one marathon session's per-turn cache reads summed to billions (it crushed
// every other row's bar to an invisible sliver). A within-row composition is always
// readable regardless of how large any single session got.
function TokenBar({ sess }: { sess: SessionSummaryCard }) {
  const b = tokenBreakdown(sess)
  const total = b.fresh + b.cacheRead + b.cacheWrite + b.output
  if (total <= 0) return null
  const w = (n: number) => (n / total * 100).toFixed(2)
  return (
    <div
      title={formatTokenBreakdown(sess)}
      style="height:4px;border-radius:2px;background:var(--border);display:flex;overflow:hidden;margin-top:2px;width:100%;min-width:48px"
    >
      <div style={`width:${w(b.fresh)}%;background:var(--vscode-charts-blue,#4fc3f7)`} />
      <div style={`width:${w(b.cacheRead)}%;background:var(--vscode-charts-purple,#b392f0)`} />
      <div style={`width:${w(b.cacheWrite)}%;background:var(--vscode-charts-orange,#e2a03f)`} />
      <div style={`width:${w(b.output)}%;background:var(--vscode-charts-green,#81c784)`} />
    </div>
  )
}

function SessionRow({ sess, showWorkspace }: { sess: SessionSummaryCard; showWorkspace: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const isFocused = focusedSessionId.value === sess.sessionId
  const rowRef = useRef<HTMLTableRowElement>(null)
  const cost = calcSessionCost(sess, 'token')
  const color = getAgentColor(sess.source)
  const prompt = sess.userRequest ?? ''
  // TRDD-CTXQUERY (dashboard piece 3): the proactive resident-blob flag for THIS session, if the
  // server's slow scan found a big block re-read across many turns. Cross-referenced from the burn
  // status (no per-card field) so a card can badge without the composition parse firing eagerly.
  const residentBlob = serverBurnStatus.value?.residentBlobs?.find(rb => rb.sessionId === sess.sessionId)

  useEffect(() => {
    if (focusedSessionId.value === sess.sessionId) {
      setExpanded(true)
      rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [focusedSessionId.value])

  function toggle() {
    const next = !expanded
    setExpanded(next)
    focusedSessionId.value = next ? sess.sessionId : null
  }

  const rowBg = isFocused ? 'var(--hover)' : 'transparent'

  return (
    <>
      <tr
        ref={rowRef}
        onClick={toggle}
        style={`cursor:pointer;background:${rowBg};border-bottom:1px solid var(--vscode-panel-border)`}
      >
        {/* Chevron */}
        <td style="padding:4px 4px 4px 8px;width:16px;color:var(--muted);font-size:9px;white-space:nowrap">
          {expanded ? '▼' : '▶'}
        </td>

        {/* Agent dot + data source badge */}
        <td style="padding:4px 4px;width:auto;white-space:nowrap">
          <span style={`display:inline-block;width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;vertical-align:middle`} />
          <span style="margin-left:4px" dangerouslySetInnerHTML={{ __html: getDataSourceBadgeHtml(sess.dataSource ?? 'otel') }} />
          <span dangerouslySetInnerHTML={{ __html: getInitiatorBadgeHtml(sess.initiator) }} />
          {residentBlob && (
            <span
              title={`Resident blob re-read every turn: ${residentBlob.label} — ${formatCompact(residentBlob.peakTokens)} tok, ${residentBlob.residentTurns}× resident, ~${fmtUsd(residentBlob.cumulativeReadCostUsd)} wasted re-read. Open the Context tab → OTEL context composition to drill/evict.`}
              style="margin-left:4px;padding:0 5px;border-radius:3px;background:rgba(246,166,35,0.18);color:#f6a623;font-size:9px;font-weight:600;vertical-align:middle"
            >⚠ {residentBlob.isImage ? '🖼' : 'resident'} {formatCompact(residentBlob.peakTokens)}</span>
          )}
        </td>

        {/* Timestamp + optional workspace label */}
        <td style="padding:4px 6px;white-space:nowrap;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums">
          {formatSessionTime(sess)}
          {showWorkspace && sess.workspace && (
            <span
              title={'Project: ' + sess.workspace}
              style="margin-left:6px;padding:0 5px;border-radius:3px;background:var(--vscode-badge-background,var(--border));color:var(--vscode-badge-foreground,var(--fg));font-size:9px;font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:150px;display:inline-block;vertical-align:middle"
            >
              {shortWorkspaceName(sess.workspace)}
            </span>
          )}
        </td>

        {/* Prompt */}
        <td style="padding:4px 6px;max-width:0;width:100%">
          {prompt
            ? <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-style:italic;color:var(--foreground)" title={prompt}>{prompt}</span>
            : sess.turns === 0
              ? <span style="color:var(--muted);font-size:11px">…</span>
              : <span style="color:var(--muted);font-size:11px">—</span>
          }
        </td>

        {/* Model */}
        <td style="padding:4px 6px;white-space:nowrap;font-size:10px;color:var(--muted);max-width:130px;overflow:hidden;text-overflow:ellipsis">
          {sess.model || '—'}
        </td>

        {/* Tokens + composition bar */}
        <td style="padding:4px 6px;text-align:right;white-space:nowrap;font-size:10px;color:var(--muted);min-width:60px" title={formatTokenBreakdown(sess) + ` · ${tokenBreakdown(sess).totalContext.toLocaleString()} total context (cache re-read every turn)`}>
          {formatCompact(tokenBreakdown(sess).fresh + sess.outputTokens)}
          <TokenBar sess={sess} />
        </td>

        {/* Duration */}
        <td style="padding:4px 6px;text-align:right;white-space:nowrap;font-size:10px;color:var(--muted)">
          {formatMs(sess.durationMs)}
        </td>

        {/* Cost */}
        <td style="padding:4px 8px 4px 6px;text-align:right;white-space:nowrap;font-size:10px">
          {/* UNPRICED beats the silent em-dash: cost unknown ≠ cost zero (TRDD-ZK37VG4X). */}
          {isUnpriced(sess)
            ? <span title={`No pricing-table entry for model "${sess.model || '(none)'}" — cost unknown, excluded from totals`} style="color:var(--vscode-charts-yellow,#e5c07b);font-weight:600">UNPRICED</span>
            : !cost.modelUnknown && cost.totalUsd > 0
              ? <span style="color:var(--vscode-charts-green,#81c784)">{fmtUsd(cost.totalUsd)}</span>
              : sess.errors > 0
                ? <span style="color:var(--error)">{sess.errors} err</span>
                : <span style="color:var(--muted)">—</span>
          }
        </td>
      </tr>

      {expanded && (
        <tr style="border-bottom:1px solid var(--vscode-panel-border)">
          <td colspan={8} style="padding:0">
            <SessionDetail sess={sess} />
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main Sessions component ───────────────────────────────────────────────────

const INITIAL_RENDER = 60   // rows mounted on first paint
const RENDER_BATCH = 60     // rows added per sentinel hit / Show-more click

export function Sessions() {
  const sessions = filteredSessions.value
  // Render incrementally (window-scroll infinite scroll): the list can be tens of thousands of
  // rows and mounting them all at once freezes the browser. Show INITIAL_RENDER, then RENDER_BATCH
  // more each time the sentinel nears the viewport (or Show-more is clicked). Nothing is capped —
  // every session stays reachable by scrolling; detail is fetched lazily only when a row is opened.
  const isEmpty = sessions.length === 0
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const totalRef = useRef(0)
  totalRef.current = sessions.length

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return   // empty list → no sentinel; effect re-runs (dep isEmpty) when rows appear
    const io = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) setRenderCount(c => (c < totalRef.current ? c + RENDER_BATCH : c)) },
      { root: null, rootMargin: '800px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [isEmpty])

  const hasAny = (sessionSummary.value?.sessions?.length ?? 0) > 0
  const wsFilter = workspaceFilter.value
  const uniqueWorkspaces = new Set(sessions.map(s => s.workspace ?? ''))
  const showWorkspace = wsFilter === 'all' && uniqueWorkspaces.size > 1

  if (isEmpty) {
    return (
      <div id="sessions-content">
        <div class="empty-state">{hasAny ? 'No sessions match the active filters.' : 'No sessions recorded yet.'}</div>
      </div>
    )
  }

  const sortKey = sessionSortKey.value
  const sortDir = sessionSortDir.value

  function sortArrow(key: SortKey) {
    if (sortKey !== key) return <span style="opacity:0.5;margin-left:3px" title="Click to sort">↕</span>
    return <span style="margin-left:3px;color:var(--accent)">{sortDir === 'desc' ? '▼' : '▲'}</span>
  }

  function onSortClick(key: SortKey) {
    if (sessionSortKey.value === key) {
      sessionSortDir.value = sessionSortDir.value === 'desc' ? 'asc' : 'desc'
    } else {
      sessionSortKey.value = key
      sessionSortDir.value = 'desc'
    }
  }

  const thBase = 'padding:3px 6px;font-size:10px;font-weight:600;white-space:nowrap;user-select:none'
  const thSort = thBase + ';cursor:pointer;color:var(--fg)'
  const thMuted = thBase + ';color:var(--muted);font-weight:500'

  return (
    <div id="sessions-content" style="padding-top:8px">
      <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead>
          <tr style="border-bottom:2px solid var(--vscode-panel-border)">
            <th style="width:16px;padding:3px 4px 3px 8px" />
            <th style={'width:10px;padding:3px 4px;' + thSort} onClick={() => onSortClick('source')} title="Sort by agent">{sortArrow('source')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('start_time')}>Time{sortArrow('start_time')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('prompt')}>Prompt{sortArrow('prompt')}</th>
            <th style={'text-align:left;' + thSort} onClick={() => onSortClick('model')}>Model{sortArrow('model')}</th>
            <th style={'text-align:right;' + thSort} onClick={() => onSortClick('total_tokens')} title="Fresh input + output tokens (the comparable headline number). The bar below each value shows the full composition including cache reads; hover a value for exact fresh / cache-read / cache-write / output counts.">Tokens{sortArrow('total_tokens')}</th>
            <th style={'text-align:right;' + thSort} onClick={() => onSortClick('duration_ms')}>Duration{sortArrow('duration_ms')}</th>
            <th style={'text-align:right;padding:3px 8px 3px 6px;' + thSort} onClick={() => onSortClick('cost')}>Cost{sortArrow('cost')}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.slice(0, renderCount).map(sess => (
            <SessionRow key={sess.sessionId} sess={sess} showWorkspace={showWorkspace} />
          ))}
        </tbody>
      </table>
      </div>
      {/* Infinite-scroll sentinel — observed (rootMargin 800px) to load the next batch early. */}
      <div ref={sentinelRef} style="height:1px" />
      <div style="padding:6px 8px;font-size:11px;color:var(--muted);border-top:1px solid var(--vscode-panel-border);display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        {renderCount < sessions.length && (
          <button
            onClick={() => setRenderCount(c => Math.min(c + RENDER_BATCH, sessions.length))}
            style="padding:2px 10px;font-size:11px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--vscode-textLink-foreground,#4fc3f7)"
          >Show more</button>
        )}
        <span>
          Showing {Math.min(renderCount, sessions.length).toLocaleString()} of {sessions.length.toLocaleString()}
          {sessions.length !== (sessionSummary.value?.sessions?.length ?? 0) ? ' (filtered)' : ''}
          {' · '}{(sessionSummary.value?.sessions?.length ?? 0).toLocaleString()} stored
        </span>
      </div>
    </div>
  )
}
