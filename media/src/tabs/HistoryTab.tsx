import { useState, useEffect, useMemo } from 'preact/hooks'
import { sessionSummary, sessionHistories, focusedSessionId, sessionGeneratedFiles, requestContextHistory } from '../state'
import { GeneratedFilesList } from '../GeneratedFilesView'
import { formatCompact, formatSessionTime, getAgentDotHtml } from '../utils'
import { fmtUsd } from '../sessionMetrics'
import { lookupRates, calcTokenCost } from '../../../src/shared/pricing'
import { buildResidentCostReport } from '../../../src/shared/residentCost'
import type { ContextHistory, ContextHistoryStep, ContextBlock, ContextBlockKind, GeneratedFileRef, TokenSource, ResidentCostBlock } from '../types'

// Exact/calibrated/estimated marker for a token figure (TRDD-IQENK7JM). Exact = no marker; calibrated
// (estimate scaled to a usage total) = ≈; estimated (raw estimate) = ~. The tooltip spells it out.
function tokenMark(src: TokenSource | undefined): { mark: string; title: string } {
  if (src === 'exact') return { mark: '', title: 'exact — from the usage bucket' }
  if (src === 'calibrated') return { mark: '≈', title: 'calibrated — estimate scaled to the step’s exact usage total' }
  return { mark: '~', title: 'estimated — tokenizer estimate (no exact total to anchor it)' }
}

// One colour per block-kind, grouped by family so a step's blocks read at a glance. All colours are
// picked to stay legible on both the light and dark VS Code themes (they're saturated mid-tones, not
// near-white / near-black), so no per-theme override is needed here.
const KIND_COLOR: Record<ContextBlockKind, string> = {
  // messages + reasoning — greenish
  userMsg: '#81c784', assistantMsg: '#66bb6a', reasoning: '#aed581',
  // tool in/out + bash — blueish
  toolInput: '#4fc3f7', toolOutput: '#29b6f6', bashInput: '#4dabf5', bashOutput: '#42a5f5',
  // hooks / harness / cron / reminder — orange (injected, cache-fragile)
  hook: '#e2a03f', harness: '#ffb74d', cron: '#ffa726', reminder: '#ffcc80',
  // catalogs / mcp / skill+agent prompts — purple
  toolCatalog: '#ba68c8', skillCatalog: '#ab47bc', agentCatalog: '#9575cd', mcp: '#7986cb',
  skillPrompt: '#ce93d8', agentPrompt: '#b39ddb',
  // file reads — teal
  file: '#4dd0e1',
  // post-compaction / sub-agent output — red-ish
  postCompact: '#e57373', subagentOutput: '#ef5350',
  // system / claude.md / rules / other — grey
  system: '#90a4ae', claudemd: '#b0bec5', rule: '#78909c', other: 'var(--muted)',
}

interface BurnEvent { label: string; cause: string }

// R-H burn-event detection — the whole point of this tab. Each rule flags a step whose usage/blocks
// show a cache-hostile event; a step can carry several. `prev` is the chronologically-previous step.
function detectBurnEvents(step: ContextHistoryStep, prev: ContextHistoryStep | undefined): BurnEvent[] {
  const events: BurnEvent[] = []
  const u = step.usage
  // MASSIVE CACHE WRITE — a huge prefix was (re)written to cache this call.
  if (u && u.cacheCreate >= 50000) {
    events.push({ label: `🔴 CACHE-CREATE ${formatCompact(u.cacheCreate)} tok`, cause: 'prefix re-written this call' })
  }
  // CACHE BREAK — cache was both read AND (re)written while a block changed: the prefix diverged so
  // everything after the break point had to be re-cached. Point at the first divergent block.
  if (u && u.cacheCreate > 0 && u.cacheRead > 0 && step.diff.changed.length > 0) {
    const bid = step.diff.firstChangeBlockId
    const blk = bid ? step.blocks.find(b => b.id === bid) : undefined
    const where = blk ? `${blk.kind}:${blk.label}` : (bid ?? step.diff.changed[0])
    events.push({ label: '⚡ CACHE BREAK', cause: `prefix mutated at ${where}` })
  }
  // MODEL SWITCH — a different model than the previous step means a full cache miss (cache is per-model).
  if (prev && step.model && prev.model && step.model !== prev.model) {
    events.push({ label: `🔴 MODEL SWITCH ${prev.model}→${step.model}`, cause: 'separate cache per model — full miss' })
  }
  // FLEET SPAWN — a sub-agent was launched (Agent/Task/Workflow tool_use, or a sub-agent output block).
  // The child re-bills the inherited prefix, so a spawn multiplies context cost.
  const SPAWN = new Set(['Agent', 'Task', 'Workflow'])
  let spawnName: string | undefined
  for (const b of step.blocks) {
    if (b.kind === 'toolInput' && (SPAWN.has(b.toolName ?? '') || SPAWN.has(b.label ?? ''))) {
      spawnName = b.toolName || b.label; break
    }
    if (b.kind === 'subagentOutput') { spawnName = b.toolName || b.label || 'sub-agent'; break }
  }
  if (spawnName) events.push({ label: `⚠ SPAWN ${spawnName}`, cause: 'child re-bills the inherited prefix' })
  return events
}

// Per-step cost: uncached input billed at the input rate, cache read/write at their own rates.
function stepCostUsd(step: ContextHistoryStep, sessionModel: string): number {
  const u = step.usage
  if (!u) return 0
  const rates = lookupRates(step.model || sessionModel)
  if (!rates) return 0
  const uncached = Math.max(0, u.input - u.cacheRead - u.cacheCreate)
  return calcTokenCost(uncached, u.cacheRead, u.cacheCreate, u.output, rates)
}

function KindBadge({ kind }: { kind: ContextBlockKind }) {
  const color = KIND_COLOR[kind] ?? 'var(--muted)'
  return (
    <span style={`display:inline-block;font-size:8px;font-weight:600;padding:1px 5px;border-radius:3px;border:1px solid ${color};color:${color};letter-spacing:.02em;white-space:nowrap`}>
      {kind}
    </span>
  )
}

// Exported so the Sessions-tab per-call context tree (Traces.tsx) renders reconstructed raw-body
// blocks with the exact same kind-badge + token + role + full-text drill as the History tab —
// one rendering, one source of truth. Call it with added/changed/isBreak=false (no turn-diff there).
export function BlockRow({ block, added, changed, isBreak }: { block: ContextBlock; added: boolean; changed: boolean; isBreak: boolean }) {
  const [open, setOpen] = useState(false)
  const text = block.text ?? ''
  return (
    <div style="border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;min-height:22px;font-size:10px;cursor:pointer;padding:0 4px" onClick={() => setOpen(v => !v)}>
        <span style="width:10px;font-size:7px;color:var(--muted);text-align:center">{open ? '▼' : '▶'}</span>
        <KindBadge kind={block.kind} />
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={block.label}>{block.label}</span>
        {added && <span style="font-size:8px;font-weight:700;color:#81c784">+new</span>}
        {changed && <span style="font-size:8px;font-weight:700;color:var(--vscode-charts-orange,#e2a03f)">⚡changed</span>}
        {isBreak && <span style="font-size:8px;font-weight:700;color:var(--error,#f44747)">break point</span>}
        <span style="font-size:8px;color:var(--muted);text-transform:uppercase">{block.role}</span>
        <span style="width:64px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)" title={tokenMark(block.tokenSource).title}>{tokenMark(block.tokenSource).mark}{formatCompact(block.tokens)} tok</span>
      </div>
      {open && (
        <pre style="margin:2px 4px 8px 28px;padding:6px 8px;font-size:10px;line-height:1.4;white-space:pre-wrap;overflow:visible;background:var(--vscode-editorWidget-background,var(--bg));border:1px solid var(--border);border-radius:3px;color:var(--fg)">
          {text.trim() ? text : '(no text)'}
        </pre>
      )}
    </div>
  )
}

// ── Resident-cost itemization panel (TRDD-W0RRL2FZ) ─────────────────────────────
// Ranks every context block by residentCost = tokens × turns-resident (compaction-aware) — the
// blocks that cost the most not because they are big but because they RODE the transcript for many
// turns. Derived in the webview from the already-loaded history (media/src/residentCost.ts mirror).
// Exported so the Context tab renders the same panel per session — one rendering, one source of truth.

function ResidentCostRow({ b, history, rank }: { b: ResidentCostBlock; history: ContextHistory; rank: number }) {
  const [open, setOpen] = useState(false)
  // The block drill: the full (capped) text of the block's FIRST occurrence, already in memory —
  // no extra fetch. Empty text still renders an explicit placeholder, never a silent blank.
  const drillText = open
    ? (history.steps.find(s => s.turn === b.firstSeenTurn)?.blocks.find(x => x.id === b.id)?.text ?? '')
    : ''
  return (
    <div style="border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;min-height:22px;font-size:10px;cursor:pointer;padding:0 4px" onClick={() => setOpen(v => !v)}>
        <span style="width:10px;font-size:7px;color:var(--muted);text-align:center">{open ? '▼' : '▶'}</span>
        <span style="width:18px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums">{rank}</span>
        <KindBadge kind={b.kind} />
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={b.label}>{b.label}</span>
        <span style="color:var(--muted);font-variant-numeric:tabular-nums" title="occurrences × span: how many steps (re-)injected this block, over which turn range">
          {b.occurrences}× · T{b.firstSeenTurn}–T{b.lastResidentTurn} ({b.turnsResident} turns)
        </span>
        <span style="width:80px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)" title="Σ tokens injected across all occurrences">{formatCompact(b.tokens)} tok</span>
        <span style="width:96px;text-align:right;font-variant-numeric:tabular-nums;font-weight:700" title="resident cost = Σ tokens × turns-resident (token·turns) — the cumulative context weight while riding the transcript">
          {formatCompact(b.residentCost)} tok·turns
        </span>
      </div>
      {open && (
        <div style="margin:2px 4px 8px 38px">
          <div style="font-size:9px;color:var(--vscode-charts-orange,#e2a03f);padding:2px 0">↳ {b.remediation}</div>
          <pre style="margin:2px 0 0;padding:6px 8px;font-size:10px;line-height:1.4;white-space:pre-wrap;overflow:visible;background:var(--vscode-editorWidget-background,var(--bg));border:1px solid var(--border);border-radius:3px;color:var(--fg)">
            {drillText.trim() ? drillText : '(no text captured for this block — token/byte weight is still accurate)'}
          </pre>
        </div>
      )}
    </div>
  )
}

export function ResidentCostList({ history, defaultOpen }: { history: ContextHistory; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  // useMemo: the derivation walks every step×block; recompute only when the history object changes
  // (live-tail invalidation replaces the object), not on every unrelated signal render.
  const report = useMemo(() => buildResidentCostReport(history), [history])
  const top = report.blocks.slice(0, 10)
  const pct = report.totalContextTokens > 0 ? Math.round(report.itemizedResidentTokens / report.totalContextTokens * 100) : null
  return (
    <div style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;min-height:24px;font-size:11px;cursor:pointer;padding:0 6px" onClick={() => setOpen(v => !v)}>
        <span style="width:12px;font-size:8px;color:var(--muted);text-align:center">{open ? '▼' : '▶'}</span>
        <span style="font-weight:700">Top resident-cost blocks</span>
        <span style="font-size:9px;color:var(--muted)">tokens × turns-resident — what actually accumulated the context bill</span>
        {pct !== null && (
          <span style="margin-left:auto;font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums" title={report.note}>
            itemized {pct}% of {formatCompact(report.totalContextTokens)} tok cumulative context · {report.compactionTurns.length} compaction{report.compactionTurns.length === 1 ? '' : 's'}
          </span>
        )}
        {pct === null && (
          // FAIL-FAST honesty: with no usage buckets there is no exact base to reconcile against.
          <span style="margin-left:auto;font-size:10px;color:var(--vscode-charts-orange,#e2a03f)" title={report.note}>no usage buckets — unreconciled estimates</span>
        )}
      </div>
      {open && (
        <div style="padding:0 6px 6px 20px">
          {top.length === 0
            ? <div style="font-size:10px;color:var(--muted);padding:4px 0">No blocks reconstructed for this session.</div>
            : top.map((b, i) => <ResidentCostRow key={b.id} b={b} history={history} rank={i + 1} />)}
          {report.blocks.length > 10 && (
            <div style="font-size:9px;color:var(--muted);padding:4px 0 0;font-style:italic">
              +{report.blocks.length - 10} more blocks itemized ({formatCompact(report.blocks.slice(10).reduce((n, b) => n + b.residentCost, 0))} tok·turns) — full list via the get_context_inflation_report MCP tool
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StepRow({ step, prev, sessionModel }: { step: ContextHistoryStep; prev: ContextHistoryStep | undefined; sessionModel: string }) {
  const [open, setOpen] = useState(false)
  const events = detectBurnEvents(step, prev)
  const burning = events.length > 0
  const u = step.usage
  const blockTokens = step.blocks.reduce((n, b) => n + b.tokens, 0)
  const cost = stepCostUsd(step, sessionModel)
  const added = new Set(step.diff.added)
  const changed = new Set(step.diff.changed)

  // Theme-aware low-opacity red tint on burn rows via color-mix so it reads correctly in both themes
  // (a plain hex8 wouldn't follow the theme's --error token). color-mix is supported by the Chromium
  // webview + standalone browser this renders in.
  const rowBg = burning ? 'background:color-mix(in srgb, var(--error,#f44747) 12%, transparent)' : ''

  return (
    <div style={`border-bottom:1px solid var(--border);${rowBg}`}>
      <div style="display:flex;align-items:center;min-height:26px;font-size:11px;cursor:pointer;padding:0 6px;flex-wrap:wrap" onClick={() => setOpen(v => !v)}>
        <span style="width:12px;font-size:8px;color:var(--muted);text-align:center">{open ? '▼' : '▶'}</span>
        <span style={`width:52px;font-weight:700;color:${burning ? 'var(--error,#f44747)' : 'var(--vscode-textLink-foreground,#4fc3f7)'}`}>T{step.turn}</span>
        {u ? (
          <span style="display:flex;gap:10px;font-variant-numeric:tabular-nums;color:var(--muted);font-size:10px;margin-right:8px">
            <span title="new input tokens">in {formatCompact(u.input)}</span>
            <span title="output tokens">out {formatCompact(u.output)}</span>
            <span title="cache-read tokens">rd {formatCompact(u.cacheRead)}</span>
            <span title="cache-created tokens" style={u.cacheCreate >= 50000 ? 'color:var(--error,#f44747);font-weight:700' : ''}>wr {formatCompact(u.cacheCreate)}</span>
          </span>
        ) : <span style="color:var(--muted);font-size:10px;margin-right:8px">no usage</span>}
        <span style="color:var(--muted);font-size:10px;margin-right:8px" title="block count · total block tokens">{step.blocks.length} blk · {formatCompact(blockTokens)} tok</span>
        {cost > 0 && <span style="color:var(--muted);font-size:10px;margin-right:8px">~{fmtUsd(cost)}</span>}
        {/* Burn-event labels — bold, coloured, each with its one-line cause as a tooltip. */}
        {events.map((ev, i) => (
          <span key={i} style="font-size:10px;font-weight:700;color:var(--error,#f44747);margin-right:8px;white-space:nowrap" title={ev.cause}>{ev.label}</span>
        ))}
      </div>
      {burning && (
        <div style="padding:0 6px 3px 64px;font-size:9px;color:var(--muted)">
          {events.map((ev, i) => <div key={i}>↳ {ev.cause}</div>)}
        </div>
      )}
      {open && (
        <div style="padding:2px 6px 8px 32px;background:var(--vscode-editorWidget-background,var(--bg))">
          {step.blocks.length === 0
            ? <div style="font-size:10px;color:var(--muted);padding:4px 0">No blocks reconstructed for this step.</div>
            : step.blocks.map(b => (
                <BlockRow key={b.id} block={b} added={added.has(b.id)} changed={changed.has(b.id)} isBreak={step.diff.firstChangeBlockId === b.id} />
              ))}
          {step.diff.removed.length > 0 && (
            <div style="font-size:9px;color:var(--muted);padding:4px 4px 0;font-style:italic">
              removed since prev: {step.diff.removed.join(', ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function History() {
  const summary = sessionSummary.value
  const sessions = summary?.sessions ?? []
  const histories = sessionHistories.value
  const [picked, setPicked] = useState('')

  // Default to the focused session (if any) else the first session that actually recorded turns —
  // an OTEL-only card with 0 turns has no transcript to reconstruct.
  const focusId = focusedSessionId.value
  const defaultId = (focusId && sessions.some(s => s.sessionId === focusId))
    ? focusId
    : (sessions.find(s => (s.turns ?? 0) > 0)?.sessionId ?? sessions[0]?.sessionId ?? '')
  const selectedId = picked || defaultId
  const card = sessions.find(s => s.sessionId === selectedId)
  const cached = selectedId in histories
  const history = cached ? histories[selectedId] : undefined
  // pending is DERIVED (no local state): an absent key means the request is in flight (the state
  // helper dedupes) — the reply always lands as a cached key, null being the honest terminal state.
  const pending = !!selectedId && !cached

  // TRDD-W0RRL2FZ: history loading goes through the runtime-agnostic state helper (VS Code:
  // postMessage → dashboardPanel; standalone: shim/fetch → /api/history) instead of a direct fetch,
  // which the VS Code webview CSP (connect-src unset) silently blocked before.
  useEffect(() => {
    if (!selectedId) return
    const c = sessions.find(s => s.sessionId === selectedId)
    requestContextHistory(selectedId, c?.parentSessionId)
  }, [selectedId, cached])

  // TRDD-ZS1GDXVY: fetch the session-level "generated files" group (rides the /api/timeline payload)
  // so the History tab lists a session's output/scratch files alongside its per-step blocks. Shares
  // the sessionGeneratedFiles cache with the Traces tab, so an already-opened session is instant.
  useEffect(() => {
    if (!selectedId || selectedId in sessionGeneratedFiles.value) return
    let cancelled = false
    fetch(`/api/timeline/${encodeURIComponent(selectedId)}`)
      .then(r => r.json())
      .then((data: { generatedFiles?: GeneratedFileRef[]; generatedFilesTruncated?: boolean }) => {
        if (cancelled) return
        sessionGeneratedFiles.value = {
          ...sessionGeneratedFiles.value,
          [selectedId]: { files: data.generatedFiles ?? [], truncated: !!data.generatedFilesTruncated },
        }
      })
      .catch(() => { /* non-fatal — group just stays empty */ })
    return () => { cancelled = true }
  }, [selectedId])

  const genFiles = sessionGeneratedFiles.value[selectedId]

  if (!sessions.length) {
    return <div id="summary-history-content"><div class="empty-state">No sessions recorded yet.</div></div>
  }

  const steps = history?.steps ?? []
  const sessionModel = card?.model ?? ''
  const totalCacheCreate = steps.reduce((n, s) => n + (s.usage?.cacheCreate ?? 0), 0)
  const peakCacheCreate = steps.length ? Math.max(0, ...steps.map(s => s.usage?.cacheCreate ?? 0)) : 0
  const burnStepCount = steps.filter((s, i) => detectBurnEvents(s, steps[i - 1]).length > 0).length

  return (
    <div id="summary-history-content">
      <div class="tab-stats" style="position:sticky;top:0;z-index:5;background:var(--vscode-editor-background,var(--bg))">
        <div>
          <select
            value={selectedId}
            onChange={e => setPicked((e.target as HTMLSelectElement).value)}
            style="max-width:360px;padding:2px 5px;font-size:11px;cursor:pointer;border-radius:3px;background:var(--vscode-input-background,#3c3c3c);border:1px solid var(--vscode-input-border,#555);color:var(--fg);outline:none"
          >
            {sessions.map(s => (
              <option key={s.sessionId} value={s.sessionId}>
                {formatSessionTime(s)} · {(s.userRequest || '[no prompt]').slice(0, 60)} · {s.turns} turns
              </option>
            ))}
          </select>
        </div>
        {history && steps.length > 0 && <>
          <div><strong class="tab-stat-val">{steps.length}</strong> steps</div>
          <div><strong class="tab-stat-val">{formatCompact(totalCacheCreate)}</strong> cache-created</div>
          <div><strong class="tab-stat-val">{formatCompact(peakCacheCreate)}</strong> peak step cache-create</div>
          <div><strong class="tab-stat-val" style={burnStepCount > 0 ? 'color:var(--error,#f44747)' : ''}>{burnStepCount}</strong> burn-event steps</div>
        </>}
        <div style="font-size:10px;color:var(--muted)">
          {card && <span dangerouslySetInnerHTML={{ __html: getAgentDotHtml(card.source) }} />} per-step context history · expand a step for its blocks · red = burn event
          <span title="per-block token counts: exact from usage, ≈ calibrated to the step’s usage total, ~ raw estimate" style="margin-left:8px;opacity:.85">· tokens: exact · <span style="font-variant-numeric:tabular-nums">≈</span> calibrated · ~ estimated</span>
        </div>
      </div>
      {genFiles && genFiles.files.length > 0 && (
        <div style="padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border)">
          <GeneratedFilesList files={genFiles.files} truncated={genFiles.truncated} heading="Generated files" />
        </div>
      )}
      {/* TRDD-W0RRL2FZ: the resident-cost summary — which blocks cost the most as tokens × turns-resident. */}
      {history && steps.length > 0 && <ResidentCostList history={history} defaultOpen={true} />}
      <div class="waterfall">
        {pending && !cached
          ? <div style="padding:14px;font-size:11px;color:var(--muted)">Reconstructing context history…</div>
          : history === null
            ? <div style="padding:14px;font-size:11px;color:var(--muted)">No local Claude transcript to reconstruct — OTEL-only session.</div>
            : history && history.reconstructedFrom && steps.length === 0
              ? <div style="padding:14px;font-size:11px;color:var(--muted)">transcript lives in parent {history.reconstructedFrom}</div>
              : steps.length === 0
                ? <div style="padding:14px;font-size:11px;color:var(--muted)">No steps reconstructed for this session.</div>
                : steps.map((s, i) => <StepRow key={s.turn + ':' + i} step={s} prev={steps[i - 1]} sessionModel={sessionModel} />)}
      </div>
    </div>
  )
}
