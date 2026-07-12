// Per-branch "copy fully-expanded tree" button (TRDD-4CH9QLAH, Phase 3c). Mounts on a session
// header + each subagent-branch header (Traces) and the Flow toolbar. On click it materializes the
// whole branch — root session + every recursive subagent, each session's timeline entries, and the
// lazily-stripped big tool-output blobs — then hands it to the PURE src/shared/branchSerialize which
// returns a self-describing text tree (session id + project slug header, per-node OTEL match keys,
// and over-threshold bodies replaced by @@DUMP@@ placeholders). Over-threshold bodies are POSTed to
// /api/branch-dump (written under the Claude projects tree) and their real paths spliced back in;
// then the text goes to the clipboard.
import { useState } from 'preact/hooks'
import { vscode, sessionSummary, sessionTimelines, blobCache } from './state'
import { serializeBranch, type SerialNode, type SerialHeader, type DumpEntry } from '../../src/shared/branchSerialize'
import type { SessionSummaryCard, TimelineEntry } from '../../src/shared/summarizerTypes'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const LOAD_DEADLINE_MS = 4000

// Encode a project path into the Claude projects-dir slug (~/.claude/projects/<slug>): every path
// separator and dot becomes '-', matching Claude Code's on-disk encoding. The server re-validates it
// against real dirs and 400s on a mismatch (non-Claude sources have no such dir), in which case
// resolveDumps() inlines an honest "omitted" marker instead — the copy still succeeds.
function projectSlug(card: SessionSummaryCard): string {
  return (card.projectPath || card.workspace || '').replace(/[/\\.]/g, '-')
}

// The timeline the tree renders: the lazy cache wins, card.timeline is the inline fallback.
function timelineOf(card: SessionSummaryCard): TimelineEntry[] {
  return sessionTimelines.value[card.sessionId] ?? card.timeline ?? []
}

function childrenOf(card: SessionSummaryCard, all: SessionSummaryCard[]): SessionSummaryCard[] {
  return all.filter((s) => s.parentSessionId === card.sessionId && s.sessionId !== card.sessionId)
}

// Which stripped blob fields an entry needs fetched to serialize its FULL output. Mirrors StepDetail.
function neededBlobFields(e: TimelineEntry): Array<'full-result' | 'response' | 'thinking'> {
  if (!e.hasBlob) return []
  const want: Array<'full-result' | 'response' | 'thinking'> = []
  if (e.type === 'tool' && !e.fullResult) want.push('full-result')
  if ((e.type === 'llm' || e.type === 'user_input') && !e.responseText) want.push('response')
  if (e.type === 'llm' && !e.thinking) want.push('thinking')
  return want
}

// Root + every recursive subagent descendant, cycle-guarded (a self/loop parent link can't hang us).
function collectBranch(root: SessionSummaryCard, all: SessionSummaryCard[]): SessionSummaryCard[] {
  const out: SessionSummaryCard[] = []
  const seen = new Set<string>()
  const stack = [root]
  while (stack.length) {
    const c = stack.pop()
    if (!c || seen.has(c.sessionId)) continue
    seen.add(c.sessionId)
    out.push(c)
    for (const kid of childrenOf(c, all)) if (!seen.has(kid.sessionId)) stack.push(kid)
  }
  return out
}

// Best-effort: ask the host to load any not-yet-fetched branch timelines, then poll until they land
// (or a short deadline). Uses the same postMessage the tree uses (proxied to /api in standalone);
// without a bridge we just serialize whatever card.timeline already holds.
async function ensureTimelines(cards: SessionSummaryCard[]): Promise<void> {
  if (!vscode) return
  const missing = cards.filter((c) => sessionTimelines.peek()[c.sessionId] === undefined)
  if (!missing.length) return
  for (const c of missing) vscode.postMessage({ type: 'loadSessionDetail', sessionId: c.sessionId })
  const deadline = Date.now() + LOAD_DEADLINE_MS
  while (Date.now() < deadline && missing.some((c) => sessionTimelines.peek()[c.sessionId] === undefined)) await sleep(80)
}

// Best-effort: fetch every hasBlob entry's stripped full output across the branch, then poll.
async function ensureBlobs(cards: SessionSummaryCard[]): Promise<void> {
  if (!vscode) return
  const wants: Array<[string, string]> = []
  for (const c of cards) {
    for (const e of timelineOf(c)) {
      for (const f of neededBlobFields(e)) {
        const key = `${e.spanId}:${f}`
        if (blobCache.peek()[key] === undefined) { vscode.postMessage({ type: 'loadBlob', spanId: e.spanId, field: f }); wants.push([e.spanId, f]) }
      }
    }
  }
  if (!wants.length) return
  const deadline = Date.now() + LOAD_DEADLINE_MS
  while (Date.now() < deadline && wants.some(([s, f]) => blobCache.peek()[`${s}:${f}`] === undefined)) await sleep(80)
}

function entryTitle(e: TimelineEntry): string {
  const bits: string[] = [`[${e.type}]`, e.label || e.action || e.type]
  if (e.model) bits.push(`· ${e.model}`)
  if (typeof e.outputTokens === 'number' && e.outputTokens > 0) bits.push(`· ${e.outputTokens}tok`)
  if (typeof e.costUsd === 'number' && e.costUsd > 0) bits.push(`· $${e.costUsd.toFixed(4)}`)
  return bits.join(' ')
}

function entryBodies(e: TimelineEntry): Array<{ label: string; text: string }> {
  const blobs = blobCache.value
  const out: Array<{ label: string; text: string }> = []
  const add = (label: string, text?: string): void => { if (text && text.trim()) out.push({ label, text }) }
  add('thinking', e.thinking || blobs[`${e.spanId}:thinking`])
  add('response', e.responseText || blobs[`${e.spanId}:response`])
  add('input', e.toolInput)
  add('result', e.fullResult || blobs[`${e.spanId}:full-result`] || e.resultSummary)
  add('error', e.errorMessage)
  return out
}

function entryNode(e: TimelineEntry): SerialNode {
  const kind: SerialNode['kind'] = e.type === 'llm' ? 'llm' : e.type === 'tool' ? 'tool' : 'event'
  const match: NonNullable<SerialNode['match']> = {}
  if (e.spanId) match.spanId = e.spanId
  if (e.requestId) match.requestId = e.requestId
  return { kind, title: entryTitle(e), match: Object.keys(match).length ? match : undefined, bodies: entryBodies(e) }
}

function cardNode(card: SessionSummaryCard, all: SessionSummaryCard[], seen: Set<string>): SerialNode {
  seen.add(card.sessionId)
  const req = card.userRequest ? ` · ${card.userRequest.replace(/\s+/g, ' ').slice(0, 120)}` : ''
  const children: SerialNode[] = timelineOf(card).map(entryNode)
  for (const kid of childrenOf(card, all)) {
    if (seen.has(kid.sessionId)) continue
    children.push(cardNode(kid, all, seen))
  }
  return { kind: 'session', title: `session ${card.sessionId}${req}`, match: card.traceId ? { traceId: card.traceId } : undefined, children }
}

// POST the over-threshold bodies; splice the returned file paths into the text. On ANY failure (server
// down, non-Claude source rejected with 400) each placeholder becomes an honest "omitted" marker with
// the size — the copy still succeeds, and the per-node OTEL match key already in the text still lets
// the user find the raw call. This is graceful degradation of a COPY action, not a hidden fallback.
async function resolveDumps(card: SessionSummaryCard, dumps: DumpEntry[], text: string): Promise<string> {
  let paths: Record<string, string> = {}
  try {
    const res = await fetch('/api/branch-dump', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: projectSlug(card), sessionId: card.sessionId, dumps }),
    })
    if (res.ok) paths = ((await res.json()) as { paths?: Record<string, string> }).paths ?? {}
  } catch { /* keep paths empty → markers below */ }
  let out = text
  for (const d of dumps) {
    const repl = paths[d.id] ?? `«${d.content.length} chars omitted — dump unavailable; use the OTEL match key above»`
    out = out.split(`@@DUMP:${d.id}@@`).join(repl)
  }
  return out
}

async function runCopy(card: SessionSummaryCard): Promise<void> {
  const all = sessionSummary.value?.sessions ?? []
  const branch = collectBranch(card, all)
  await ensureTimelines(branch)
  await ensureBlobs(branch)
  const header: SerialHeader = { sessionId: card.sessionId, slug: projectSlug(card), source: card.source, dataSource: card.dataSource }
  const { text, dumps } = serializeBranch(header, cardNode(card, all, new Set<string>()))
  const finalText = dumps.length ? await resolveDumps(card, dumps, text) : text
  await navigator.clipboard.writeText(finalText)
}

/** A tiny floating button that copies the whole branch (this session + its subagents) as a
 *  fully-expanded, self-describing text tree. Stops row-toggle propagation so it can live inside a
 *  clickable header. */
export function CopyBranchButton({ card }: { card: SessionSummaryCard }): preact.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'working' | 'copied' | 'error'>('idle')
  const onClick = (e: Event): void => {
    e.stopPropagation()
    if (status === 'working') return
    setStatus('working')
    runCopy(card)
      .then(() => { setStatus('copied'); setTimeout(() => setStatus('idle'), 2000) })
      .catch(() => { setStatus('error'); setTimeout(() => setStatus('idle'), 3000) })
  }
  const label = status === 'working' ? '⋯' : status === 'copied' ? '✓ tree' : status === 'error' ? '⚠ tree' : '⧉ tree'
  const color = status === 'error'
    ? 'color:var(--vscode-errorForeground,#f14c4c)'
    : status === 'copied'
      ? 'color:var(--vscode-testing-iconPassed,#4bb543)'
      : 'color:var(--muted)'
  return (
    <button
      onClick={onClick}
      disabled={status === 'working'}
      style={'padding:1px 6px;font-size:9px;cursor:pointer;border-radius:3px;border:1px solid var(--border);background:transparent;white-space:nowrap;' + color}
      title="Copy this branch as a fully-expanded text tree (session id + project slug header, OTEL match keys per node, big output → dump-file path)"
    >
      {label}
    </button>
  )
}
