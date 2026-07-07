import { useState, useEffect } from 'preact/hooks'
import { sessionSummary, sessionHistories, focusedSessionId } from '../state'
import { formatCompact, formatSessionTime, getAgentDotHtml } from '../utils'
import { fmtUsd } from '../sessionMetrics'
import { lookupRates, calcTokenCost } from '../pricing'
import type { ContextHistory, ContextHistoryStep, ContextBlock, ContextBlockKind } from '../types'

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
        <span style="width:64px;text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)">{formatCompact(block.tokens)} tok</span>
      </div>
      {open && (
        <pre style="margin:2px 4px 8px 28px;padding:6px 8px;font-size:10px;line-height:1.4;white-space:pre-wrap;overflow:visible;background:var(--vscode-editorWidget-background,var(--bg));border:1px solid var(--border);border-radius:3px;color:var(--fg)">
          {text.trim() ? text : '(no text)'}
        </pre>
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
  const [pending, setPending] = useState(false)

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

  useEffect(() => {
    if (!selectedId || selectedId in sessionHistories.value) { setPending(false); return }
    let cancelled = false
    setPending(true)
    const c = sessions.find(s => s.sessionId === selectedId)
    const parent = c?.parentSessionId
    const url = `/api/history/${encodeURIComponent(selectedId)}${parent ? '?parent=' + encodeURIComponent(parent) : ''}`
    fetch(url)
      .then(r => r.json())
      .then((data: { history: ContextHistory | null }) => {
        if (cancelled) return
        sessionHistories.value = { ...sessionHistories.value, [selectedId]: data.history ?? null }
        setPending(false)
      })
      .catch(() => {
        if (cancelled) return
        sessionHistories.value = { ...sessionHistories.value, [selectedId]: null }
        setPending(false)
      })
    return () => { cancelled = true }
  }, [selectedId])

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
        </div>
      </div>
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
