import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { claudeProjectsDirs } from './logReader'
import type { ContextComposition, ContextCompositionTurn, ContextSource } from './summarizers/summarizerTypes'

// Hard caps so an on-demand parse of a huge session never blocks the host unbounded. A session
// past MAX_LINES is reported truncated=true (the breakdown covers what was read). Per turn only the
// TOP_SOURCES heaviest sources are returned; the rest fold into a single "other" bucket.
const MAX_LINES = 3_000_000
const TOP_SOURCES = 24
const MAX_TURNS = 2000

// Approximate tokens for a byte count (~4 bytes/token). Every figure built here is an estimate and
// is surfaced as such in the UI — exact per-turn totals come from the usage buckets.
function approxTokens(bytes: number): number { return Math.ceil(bytes / 4) }

function utf8Len(v: unknown): number { return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 0 }

// Sum the byte length of several string-valued fields on an object (0 for missing/non-string).
function sumFields(obj: Record<string, unknown>, keys: string[]): number {
  let n = 0
  for (const k of keys) n += utf8Len(obj[k])
  return n
}

// Hard cap on the excerpt text stored per source. P5 renders the ACTUAL injected bytes at a drill
// leaf, but a huge session (thousands of turns × sources) must never ship an unbounded payload —
// so only the first occurrence's leading EXCERPT_CAP chars are kept per source.
const EXCERPT_CAP = 1200

// The first string of `keys` on `obj` that is a non-empty string (for the content excerpt).
function firstText(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) { const v = obj[k]; if (typeof v === 'string' && v.length > 0) return v }
  return ''
}
function joinedText(v: unknown): string {
  if (Array.isArray(v)) return v.filter(s => typeof s === 'string').join('\n')
  return typeof v === 'string' ? v : ''
}

// Classify one `attachment` entry into a (label, kind, bytes, text). `text` is the primary injected
// content string used for the P5 drill-leaf excerpt. Returns null for attachment shapes that carry no
// meaningful injected content (pure deltas with counts only, etc.). The taxonomy is derived from real
// logs: hook injections (by hookName), the skill catalog, tool/agent/mcp catalog deltas, file reads,
// task reminders.
function classifyAttachment(att: Record<string, unknown>): { label: string; kind: string; bytes: number; text: string } | null {
  const t = String(att['type'] ?? '')
  const hookName = att['hookName'] ? String(att['hookName']) : undefined
  switch (t) {
    case 'hook_additional_context':
    case 'hook_success':
    case 'hook_non_blocking_error':
    case 'async_hook_response': {
      const bytes = sumFields(att, ['content', 'stdout', 'stderr', 'response'])
      if (bytes === 0) return null
      return { label: `hook: ${hookName ?? 'unknown'}`, kind: 'hook', bytes, text: firstText(att, ['content', 'stdout', 'stderr', 'response']) }
    }
    case 'skill_listing':
      return { label: 'skill catalog', kind: 'skill', bytes: utf8Len(att['content']), text: firstText(att, ['content']) }
    case 'deferred_tools_delta':
      return { label: 'tool catalog', kind: 'toolCatalog', bytes: joinedLen(att['addedLines']), text: joinedText(att['addedLines']) }
    case 'agent_listing_delta':
      return { label: 'agent catalog', kind: 'agentCatalog', bytes: joinedLen(att['addedLines']), text: joinedText(att['addedLines']) }
    case 'mcp_instructions_delta':
      return { label: 'mcp instructions', kind: 'mcp', bytes: joinedLen(att['addedBlocks']) + joinedLen(att['addedNames']), text: joinedText(att['addedBlocks']) || joinedText(att['addedNames']) }
    case 'file':
    case 'edited_text_file':
    case 'compact_file_reference': {
      const name = (att['displayPath'] ?? att['filename'] ?? att['path'] ?? 'file') as string
      const bytes = sumFields(att, ['content', 'text'])
      if (bytes === 0) return null
      return { label: `file: ${path.basename(name)}`, kind: 'file', bytes, text: firstText(att, ['content', 'text']) }
    }
    case 'task_reminder':
      return { label: 'task reminder', kind: 'reminder', bytes: utf8Len(att['content']), text: firstText(att, ['content']) }
    case 'invoked_skills':
    case 'skill':
      return { label: 'invoked skills', kind: 'skill', bytes: utf8Len(att['content']), text: firstText(att, ['content']) }
    default:
      return null
  }
}

function joinedLen(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, s) => n + utf8Len(s), 0)
  return utf8Len(v)
}

// Locate the .jsonl for a sessionId across all Claude project dirs (filename == sessionId).
function findSessionFile(sessionId: string): string | null {
  for (const dir of claudeProjectsDirs()) {
    let projects: string[]
    try { projects = fs.readdirSync(dir) } catch { continue }
    for (const proj of projects) {
      const candidate = path.join(dir, proj, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Reconstruct the per-turn context composition of a Claude session from its raw .jsonl, on demand.
 * Streams the file (never loads it whole — sessions can be multi-GB), attributes every injected
 * `attachment` to the turn it feeds (the upcoming assistant turn), and aggregates by source. Returns
 * null when the session file is not a Claude log (no local .jsonl to read). The heavy work stays
 * here in the host; only the capped, aggregated summary crosses to the webview (P3 DERIVED mandate).
 */
export async function buildContextComposition(sessionId: string): Promise<ContextComposition | null> {
  const file = findSessionFile(sessionId)
  if (!file) return null

  // turn → (source label → {kind, bytes, count, excerpt})
  const byTurn = new Map<number, Map<string, { kind: string; bytes: number; count: number; excerpt: string }>>()
  const seenMessageIds = new Set<string>()
  let assistantTurns = 0
  let lines = 0
  let truncated = false

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (++lines > MAX_LINES) { truncated = true; break }
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    const type = e['type']
    if (type === 'assistant') {
      const msg = e['message'] as Record<string, unknown> | undefined
      const id = msg?.['id'] as string | undefined
      if (!id || !seenMessageIds.has(id)) { assistantTurns++; if (id) seenMessageIds.add(id) }
      continue
    }
    if (type !== 'attachment') continue

    const att = e['attachment'] as Record<string, unknown> | undefined
    if (!att) continue
    const c = classifyAttachment(att)
    if (!c || c.bytes === 0) continue

    // Attribute to the turn this injected content feeds: the next assistant turn (1-based), matching
    // the timeline's user_input turn = assistantTurns + 1.
    const turn = assistantTurns + 1
    let sources = byTurn.get(turn)
    if (!sources) { sources = new Map(); byTurn.set(turn, sources) }
    const cur = sources.get(c.label) ?? { kind: c.kind, bytes: 0, count: 0, excerpt: '' }
    cur.bytes += c.bytes
    cur.count += 1
    // Keep the FIRST occurrence's leading text as the drill-leaf excerpt (capped). Later occurrences
    // only add to the byte/token total — one representative excerpt is enough to show the real content.
    if (!cur.excerpt && c.text) cur.excerpt = c.text.slice(0, EXCERPT_CAP)
    sources.set(c.label, cur)
  }
  rl.close()

  const turns: ContextCompositionTurn[] = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_TURNS)
    .map(([turn, sources]) => ({ turn, sources: capSources(sources) }))

  return { sessionId, turns, estimated: true, truncated }
}

// Heaviest-first, keep the top TOP_SOURCES, fold the remainder into one "other" source so the total
// stays honest without shipping an unbounded list.
function capSources(sources: Map<string, { kind: string; bytes: number; count: number; excerpt: string }>): ContextSource[] {
  const all: ContextSource[] = [...sources.entries()].map(([label, s]) => ({
    label, kind: s.kind, bytes: s.bytes, tokens: approxTokens(s.bytes), count: s.count,
    excerpt: s.excerpt || undefined,
  }))
  all.sort((a, b) => b.tokens - a.tokens)
  if (all.length <= TOP_SOURCES) return all
  const kept = all.slice(0, TOP_SOURCES)
  const rest = all.slice(TOP_SOURCES)
  const other: ContextSource = {
    label: `+${rest.length} more sources`, kind: 'other',
    bytes: rest.reduce((n, s) => n + s.bytes, 0),
    tokens: rest.reduce((n, s) => n + s.tokens, 0),
    count: rest.reduce((n, s) => n + s.count, 0),
  }
  kept.push(other)
  return kept
}
