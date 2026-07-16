// Transcript sub-tab (TRDD-B22NYTOY) — the session as a readable CONVERSATION: each user prompt,
// the assistant's thinking + reply, every tool call with its paired output, compaction dividers.
// This is the CONTENT lens; the Trace/Context views remain the cost/composition lens. Data is the
// Conversation payload from /api/conversation/:id (verbatim ordered blocks, built server-side from
// the session .jsonl — never merged, never re-derived here).
import { useState, useEffect } from 'preact/hooks'
import { sessionConversations, requestConversation } from './state'
import { formatCompact } from './utils'
import type { Conversation, ConversationBlock, ConversationTurn, SessionSummaryCard } from './types'

// Role accents — theme vars with fallbacks matching the Traces tab's chart palette.
const ROLE_COLOR: Record<string, string> = {
  user: 'var(--vscode-charts-orange,#e2a03f)',
  assistant: 'var(--vscode-charts-blue,#6ea8dc)',
  system: 'var(--muted)',
  sidechain: 'var(--vscode-charts-purple,#b180d7)',
}

const fmtDur = (ms?: number): string => ms === undefined ? '' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(1)}s`
const firstLine = (s: string): string => { const i = s.indexOf('\n'); return i === -1 ? s : s.slice(0, i) }

// One collapsible block row. Text blocks (user/assistant) default OPEN — they ARE the narrative;
// everything else (thinking, tool in/out, attachments, system notes) defaults collapsed to a
// one-line summary. Expansion grows the page — NEVER an inner scrollbar (no-nested-scrollbars rule).
function BlockRow({ block }: { block: ConversationBlock }) {
  const openByDefault = block.kind === 'userText' || block.kind === 'assistantText'
  const [open, setOpen] = useState(openByDefault)
  const text = block.text ?? ''
  const tok = block.tokens ? ` · ${formatCompact(block.tokens)} tok` : ''

  let label: string
  switch (block.kind) {
    case 'userText': label = 'user'; break
    case 'assistantText': label = 'assistant'; break
    case 'thinking': label = `thinking${tok}`; break
    case 'toolUse': label = `→ ${block.toolName ?? 'tool'}(${firstLine(text).slice(0, 80)})`; break
    case 'toolResult': label = `← ${block.toolName ?? 'tool'} result${tok}: ${firstLine(text).slice(0, 80)}`; break
    case 'attachment': label = `⎘ ${String(block.meta?.['label'] ?? 'attachment')}${tok}`; break
    case 'systemNote': label = `sys ${String(block.meta?.['subtype'] ?? 'note')}${tok}: ${firstLine(text).slice(0, 80)}`; break
    case 'image': label = 'image (content not stored)'; break
    default: label = block.kind
  }

  if (block.kind === 'image') {
    return <div style="font-size:11px;color:var(--muted);padding:2px 0">🖼 {label}</div>
  }
  // Open text blocks render the content directly (no header chrome) — this IS the conversation.
  if (openByDefault) {
    return (
      <div style="font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;padding:2px 0">{text}</div>
    )
  }
  return (
    <div style="padding:1px 0">
      <div
        onClick={() => setOpen(!open)}
        style={`font-size:11px;color:var(--muted);cursor:pointer;font-family:var(--vscode-editor-font-family,monospace)`}
        title={open ? 'collapse' : 'expand'}
      >
        <span style={`display:inline-block;transform:rotate(${open ? 90 : 0}deg);transition:transform .1s;margin-right:4px`}>▶</span>
        {label}
      </div>
      {open && text && (
        <div style="font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:var(--fg);opacity:.9;border-left:2px solid var(--border);padding:4px 0 4px 10px;margin:2px 0 4px 8px">{text}</div>
      )}
    </div>
  )
}

function TurnRow({ turn }: { turn: ConversationTurn }) {
  const accent = turn.sidechain ? ROLE_COLOR.sidechain : (ROLE_COLOR[turn.role] ?? 'var(--border)')
  const u = turn.usage
  const meta = [
    turn.model,
    turn.durationMs !== undefined ? fmtDur(turn.durationMs) : '',
    u ? `↑${formatCompact(u.input)} ↓${formatCompact(u.output)}${u.cacheRead ? ` ⟳${formatCompact(u.cacheRead)}` : ''}` : '',
    turn.ts ? new Date(turn.ts).toLocaleTimeString() : '',
  ].filter(Boolean).join(' · ')
  return (
    <div style={`border-left:3px solid ${accent};padding:4px 0 4px 10px;margin:6px 0`}>
      <div style="font-size:10px;color:var(--muted);margin-bottom:2px">
        <span style={`color:${accent};font-weight:600`}>#{turn.turn} {turn.sidechain ? 'subagent' : turn.role}</span>
        {meta ? ` · ${meta}` : ''}
      </div>
      {turn.blocks.map((b, i) => <BlockRow key={i} block={b} />)}
    </div>
  )
}

function CompactionDivider({ c }: { c: Conversation['compactions'][number] }) {
  const nums = [
    c.preTokens !== undefined ? `${formatCompact(c.preTokens)} →` : '',
    c.postTokens !== undefined ? `${formatCompact(c.postTokens)} tok` : '',
    c.droppedTokens !== undefined ? `(${formatCompact(c.droppedTokens)} dropped so far)` : '',
  ].filter(Boolean).join(' ')
  return (
    <div style="display:flex;align-items:center;gap:8px;margin:10px 0;color:var(--vscode-charts-red,#d16969);font-size:11px">
      <div style="flex:1;border-top:1px dashed currentColor" />
      <span>✂ compaction ({c.trigger ?? '?'}) {nums}</span>
      <div style="flex:1;border-top:1px dashed currentColor" />
    </div>
  )
}

// Large sessions (thousands of turns) start on the most recent page — the reader almost always
// wants "what just happened"; earlier pages load on demand (simple paging, no virtualization until
// measurement says otherwise, per the plan).
const PAGE = 300

export function TranscriptView({ sess }: { sess: SessionSummaryCard }) {
  const [showFrom, setShowFrom] = useState<number | null>(null) // first VISIBLE turn number; null = auto (last page)
  useEffect(() => { requestConversation(sess.sessionId, sess.parentSessionId) }, [sess.sessionId])

  const conv = sessionConversations.value[sess.sessionId]
  if (conv === undefined) return <div style="color:var(--muted);font-size:12px">Reconstructing the conversation…</div>
  if (conv === null) {
    return <div style="color:var(--muted);font-size:12px">No local transcript to reconstruct (OTEL-only session, or its .jsonl is not on disk).</div>
  }
  if (conv.turns.length === 0) {
    return (
      <div style="color:var(--muted);font-size:12px">
        {conv.reconstructedFrom
          ? `This spawned session has no transcript of its own — its conversation lives in parent ${conv.reconstructedFrom}.`
          : 'The transcript holds no conversation turns.'}
      </div>
    )
  }

  const total = conv.turns.length
  const from = showFrom ?? Math.max(1, total - PAGE + 1)
  const visible = conv.turns.filter(t => t.turn >= from)
  // Compactions that fall inside the visible window, keyed by the turn they follow.
  const compByAfter = new Map<number, Conversation['compactions']>()
  for (const c of conv.compactions) {
    if (c.afterTurn >= from - 1) {
      const arr = compByAfter.get(c.afterTurn) ?? []
      arr.push(c)
      compByAfter.set(c.afterTurn, arr)
    }
  }
  const totalsLine = [
    `${total} turns`,
    `${conv.totals.toolCalls} tool calls`,
    conv.totals.durationMs > 0 ? fmtDur(conv.totals.durationMs) : '',
    conv.totals.usage.cacheRead > 0 ? `⟳${formatCompact(conv.totals.usage.cacheRead)} cache-read` : '',
    conv.totals.usage.tier1h > 0 ? `1h-tier ${formatCompact(conv.totals.usage.tier1h)}` : '',
    conv.compactions.length > 0 ? `${conv.compactions.length} compaction(s)` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div>
      <div style="margin-bottom:8px">
        <div style="font-size:13px;font-weight:600">
          {conv.title ?? conv.agentName ?? sess.sessionId.slice(0, 8)}
          {conv.entrypoint && <span style="margin-left:8px;font-size:10px;font-weight:400;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:1px 7px">{conv.entrypoint}</span>}
        </div>
        <div style="font-size:11px;color:var(--muted)">{totalsLine}{conv.truncated ? ' · ⚠ truncated (text budget)' : ''}</div>
      </div>
      {from > 1 && (
        <button
          onClick={() => setShowFrom(Math.max(1, from - PAGE))}
          style="font-size:11px;cursor:pointer;background:transparent;border:1px solid var(--border);border-radius:4px;color:var(--muted);padding:3px 10px;margin-bottom:6px"
        >▲ Show earlier turns (#{Math.max(1, from - PAGE)}–{from - 1} of {total})</button>
      )}
      {(compByAfter.get(from - 1) ?? []).map((c, i) => <CompactionDivider key={`c0-${i}`} c={c} />)}
      {visible.map(t => (
        <div key={t.turn}>
          <TurnRow turn={t} />
          {(compByAfter.get(t.turn) ?? []).map((c, i) => <CompactionDivider key={`c${t.turn}-${i}`} c={c} />)}
        </div>
      ))}
    </div>
  )
}
