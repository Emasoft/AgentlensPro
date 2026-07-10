import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { claudeProjectsDirs } from './logReader'
import { countTokens, estimateTokensFromBytes } from './tokenEstimator'
import type { ContextComposition, ContextCompositionTurn, ContextSource } from './shared/summarizerTypes'

// Hard caps so an on-demand parse of a huge session never blocks the host unbounded. A session
// past MAX_LINES is reported truncated=true (the breakdown covers what was read). Per turn only the
// TOP_SOURCES heaviest sources are returned; the rest fold into a single "other" bucket.
const MAX_LINES = 3_000_000
const TOP_SOURCES = 24
const MAX_TURNS = 2000
// TRDD-PJC8N1HO (OOM P0): whole-reconstruction excerpt budget — bounds the SUM of drill-excerpt bytes
// across every source/turn so a huge session can never materialize an unbounded excerpt buffer. Once
// spent, later sources ship no excerpt (byte/token metadata stays accurate) and the composition is
// marked truncated. Env-overridable; a normal session stores well under the default.
const EXCERPT_BUDGET_BYTES = Math.max(1, Number(process.env.AGENTLENS_COMPOSITION_TEXT_BUDGET_MB) || 16) * 1024 * 1024

// Per-source token figures use the real tokenEstimator segmenter (TRDD-IQENK7JM) on the injected text,
// not bytes/4. They stay ESTIMATES (tokenSource:'estimated') and are surfaced as such — composition
// aggregates attachments only (a subset of a turn's input), so it can't be calibrated to a usage total.
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

// Walk the parent chain from `sessionId` upward and return the FIRST ancestor that actually has a
// .jsonl on disk. A fork's immediate parent is often itself a logless sub-agent (agent-… → agent-… →
// real session), so a single-level parent lookup can still dead-end; this follows the chain until it
// hits the nearest ancestor whose transcript exists. `parentOf` maps a sessionId to its parent (from
// the session graph). Cycle-safe via the seen-set. Returns undefined when no ancestor has a log.
export function resolveLoggedAncestor(sessionId: string, parentOf: (id: string) => string | undefined): string | undefined {
  const seen = new Set<string>([sessionId])
  let cur = parentOf(sessionId)
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (findSessionFile(cur)) return cur
    cur = parentOf(cur)
  }
  return undefined
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

// One-pass index of every Claude session that actually has a .jsonl on disk (filename stem ==
// sessionId). The cross-session MCP aggregators (find_context_hogs, get_context_inflation_report,
// get_cache_break_report --workspace) filter their session pool through this BEFORE slicing.
//
// WHY this is load-bearing: getSessions() returns a recency-ordered mix that, during active work,
// is dominated by cards with NO reconstructable log — OTEL-only merged sessions (`synth-*`),
// sub-agent children whose id is an agentId not a file (`agent-*`), and Claude sessions whose log
// was deleted. buildContextComposition() returns null for all of those, so a plain
// `sessions.slice(0, 25)` spent its whole budget on dead cards and reported sessionsScanned:0 even
// though real logs existed lower in the list. Filtering by disk presence first guarantees the pool
// holds only reconstructable sessions. One readdir pass per call (on-demand diagnostic, not hot).
export function listSessionFileIds(): Set<string> {
  const ids = new Set<string>()
  for (const dir of claudeProjectsDirs()) {
    let projects: string[]
    try { projects = fs.readdirSync(dir) } catch { continue }
    for (const proj of projects) {
      let files: string[]
      try { files = fs.readdirSync(path.join(dir, proj)) } catch { continue }
      for (const f of files) if (f.endsWith('.jsonl')) ids.add(f.slice(0, -'.jsonl'.length))
    }
  }
  return ids
}

/**
 * Reconstruct the per-turn context composition of a Claude session from its raw .jsonl, on demand.
 * Streams the file (never loads it whole — sessions can be multi-GB), attributes every injected
 * `attachment` to the turn it feeds (the upcoming assistant turn), and aggregates by source. The
 * heavy work stays here in the host; only the capped, aggregated summary crosses to the webview
 * (P3 DERIVED mandate).
 *
 * NO-OWN-LOG FALLBACK (this fix): a fork / sub-agent session has NO `<sessionId>.jsonl` of its own —
 * its transcript lives in its PARENT's log (a fork inherits the parent's context verbatim). So when
 * findSessionFile(sessionId) is null we reconstruct from the PARENT's .jsonl and mark the result with
 * `reconstructedFrom: parentSessionId`, so the per-call cache bars can still drill into the REAL
 * injected blocks the fork inherited instead of dead-ending on a perpetual "loading". When neither a
 * own-log nor a parent-log exists on disk we return an HONEST empty composition (turns: []) that STILL
 * carries `reconstructedFrom` when a parent id is known — the UI turns that into a terminal
 * parent-link message rather than spinning forever. Only the pure OTEL/synth case (no file, no
 * parent) returns null, exactly as before.
 */
export async function buildContextComposition(sessionId: string, parentSessionId?: string): Promise<ContextComposition | null> {
  let file = findSessionFile(sessionId)
  let reconstructedFrom: string | undefined
  if (!file && parentSessionId) {
    const parentFile = findSessionFile(parentSessionId)
    if (parentFile) { file = parentFile; reconstructedFrom = parentSessionId }
  }
  if (!file) {
    // No transcript on disk anywhere. If we at least KNOW the parent, hand back an honest empty
    // composition tagged with it so the webview shows "transcript lives in parent <id>" (a terminal
    // truth) instead of a perpetual loading spinner. With no parent id at all there is nothing to
    // reconstruct from → null (pure OTEL-only / deleted-log card), unchanged behaviour.
    if (parentSessionId) return { sessionId, turns: [], estimated: true, truncated: false, reconstructedFrom: parentSessionId }
    return null
  }

  // turn → (source label → {kind, bytes, tokens, count, excerpt}). `tokens` accumulates the real
  // tokenEstimator count of the injected text (TRDD-IQENK7JM), summed across occurrences.
  const byTurn = new Map<number, Map<string, { kind: string; bytes: number; tokens: number; count: number; excerpt: string }>>()
  const seenMessageIds = new Set<string>()
  let assistantTurns = 0
  let lines = 0
  let truncated = false
  // TRDD-PJC8N1HO: running total of stored excerpt bytes, capped by EXCERPT_BUDGET_BYTES.
  let excerptBytesStored = 0

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
    const cur = sources.get(c.label) ?? { kind: c.kind, bytes: 0, tokens: 0, count: 0, excerpt: '' }
    cur.bytes += c.bytes
    // Real tokenizer on the injected text. c.text is the primary content field; when the attachment
    // spans multiple byte-bearing fields (c.bytes > the text's bytes) extrapolate by the byte ratio so
    // the estimate still reflects the full injected weight rather than just the first field.
    cur.tokens += c.text ? Math.round(countTokens(c.text) * (c.bytes / Math.max(1, utf8Len(c.text)))) : estimateTokensFromBytes(c.bytes)
    cur.count += 1
    // Keep the FIRST occurrence's leading text as the drill-leaf excerpt (capped). Later occurrences
    // only add to the byte/token total — one representative excerpt is enough to show the real content.
    // The excerpt is stored only while the whole-reconstruction budget has room (TRDD-PJC8N1HO); past
    // it, excerpts are dropped (byte/token totals stay accurate) and the composition is truncated.
    if (!cur.excerpt && c.text) {
      if (excerptBytesStored < EXCERPT_BUDGET_BYTES) {
        cur.excerpt = c.text.slice(0, EXCERPT_CAP)
        excerptBytesStored += Buffer.byteLength(cur.excerpt, 'utf8')
      } else {
        truncated = true
      }
    }
    sources.set(c.label, cur)
  }
  rl.close()

  const turns: ContextCompositionTurn[] = [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_TURNS)
    .map(([turn, sources]) => ({ turn, sources: capSources(sources) }))

  return { sessionId, turns, estimated: true, truncated, reconstructedFrom }
}

// Heaviest-first, keep the top TOP_SOURCES, fold the remainder into one "other" source so the total
// stays honest without shipping an unbounded list.
function capSources(sources: Map<string, { kind: string; bytes: number; tokens: number; count: number; excerpt: string }>): ContextSource[] {
  const all: ContextSource[] = [...sources.entries()].map(([label, s]) => ({
    // Fall back to the byte estimator only if the tokenizer produced nothing (empty/untokenizable text).
    label, kind: s.kind, bytes: s.bytes, tokens: s.tokens > 0 ? s.tokens : estimateTokensFromBytes(s.bytes),
    tokenSource: 'estimated' as const, count: s.count, excerpt: s.excerpt || undefined,
  }))
  all.sort((a, b) => b.tokens - a.tokens)
  if (all.length <= TOP_SOURCES) return all
  const kept = all.slice(0, TOP_SOURCES)
  const rest = all.slice(TOP_SOURCES)
  const other: ContextSource = {
    label: `+${rest.length} more sources`, kind: 'other',
    bytes: rest.reduce((n, s) => n + s.bytes, 0),
    tokens: rest.reduce((n, s) => n + s.tokens, 0),
    tokenSource: 'estimated',
    count: rest.reduce((n, s) => n + s.count, 0),
  }
  kept.push(other)
  return kept
}
