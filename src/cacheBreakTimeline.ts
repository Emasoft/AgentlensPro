// TRDD-6TQ2FBUR — cache-break ROOT-CAUSE timeline. Answers the last forensic question the
// cache_creation tools leave open: "WHICH specific element broke the prompt-cache prefix on this
// turn, and is the SAME element breaking it every turn (a systematic misconfiguration)?"
//
// MECHANICS (Anthropic prompt-caching docs, confirmed 2026-07-09): the cache is a PREFIX cache keyed
// on the EXACT byte sequence of [tools, system, messages], in that hierarchy. A change at any layer
// invalidates that layer AND everything after it, re-billing the tail as cache_creation (1.25x/2x the
// input rate) instead of cache_read (0.1x). Request-level parameters also key the cache: the MODEL,
// the extended-thinking / reasoning-effort setting, tool_choice, and adding/removing images. So a turn
// can re-write the whole prefix WITHOUT any block bytes changing (a pure model / effort switch), which
// is why those are classified from the request fields, not the block diff.
//
// TURN RECONSTRUCTION (proven on real data, TRDD-CCFORNSC + this TRDD): group REQUEST bodies by
// session_id (metadata.user_id blob), order by mtime; turn i's response id == turn i+1's
// diagnostics.previous_message_id (verified byte-exact). cache_creation of turn i is billed on turn i's
// request context, so the CULPRIT is the first element of prefix(req_i) that diverges from
// prefix(req_{i-1}). We diff in the docs hierarchy order (model -> tools -> effort -> system ->
// message-prefix) and STOP at the first divergence — the most-invalidating layer that changed is the
// root cause; deeper changes are its consequence.
//
// POINTER-ONLY: a prefix element carries a stable HASH of its cache-relevant bytes, never the bytes
// themselves. No raw block text, no base64 image data, no metadata.user_id token blob crosses the
// boundary — only derived identifiers (session_id, account_uuid), token counts, kinds, and labels.
//
// LAZY + BOUNDED: a single recency-first, capped scan (never the 30k+-file directory whole); every
// report carries a `coverage` block stating exactly what was scanned. Prefixes are extracted during
// the one scan pass and the multi-MB raw body is dropped immediately, so memory stays bounded.

import { parseUserId } from './rawBodyContext'
import { claudeProjectsDirs } from './logReader'
import { estimateTokensFromBytes } from './tokenEstimator'
import { calcTokenCostUsd } from './shared/pricing'
import {
  DEFAULT_BODIES_DIR, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, RESPONSE_SCAN_CAP,
  listBySuffix, boundedRecent, readJsonBounded,
  bucketValueOf, tokenCountsFullCost, tokenCountsTotal,
  type TokenCounts, type CacheCreationReport, type CacheCreationGroupRow,
  type CostBucket, type OutputSpike, type CacheCreationScanCoverage,
} from './cacheCreationForensics'
import * as fs from 'fs'
import * as path from 'path'

export { DEFAULT_BODIES_DIR }

// ── Cause taxonomy ──────────────────────────────────────────────────────────────
export type CacheBreakTimelineCause =
  | 'TOOLSET_CHANGED'            // a tool added/removed/definition-changed (the #1 structural cause)
  | 'TOOLS_REORDERED'           // identical tool set, different order (cache is byte-order sensitive)
  | 'TOOL_SEARCH_DEFERRED'      // a newly-present deferred (defer_loading) tool — tool-search loaded it mid-session
  | 'MCP_TOOLS_CHANGED'         // mcp__ tools added/removed (an MCP server / plugin toggled)
  | 'MODEL_SWITCH'              // model changed mid-session (caches are model-specific)
  | 'EFFORT_SWITCH'             // extended-thinking / reasoning-effort setting changed
  | 'HOOK_INJECTION'            // a per-turn injected hook block mutated (writes into the cached prefix)
  | 'SKILL_INJECTION'           // a skill catalog / skill block newly injected
  | 'SKILL_DESCRIPTION_TRUNCATION' // a skill description shrank (truncated) turn-to-turn
  | 'SKILL_CHANGED'             // a skill catalog / skill block changed content
  | 'INLINE_EXEC_RESULT_CHANGED'// a skill `!`-operator inline shell result differs turn-to-turn
  | 'CLAUDE_MD_CHANGED'         // an injected CLAUDE.md / rules instruction file changed
  | 'AGENT_METADATA_CHANGED'    // harness/agent metadata (billing header cc_version, agent-types list) changed
  | 'SYSTEM_TIMESTAMP'          // the only diff is a moving date/clock inside an otherwise-stable block
  | 'CONTEXT_ORDER_CHANGED'     // identical block content, different injection order (cache still breaks)
  | 'TTL_EXPIRY'                // no prefix change; a TTL gap let the cache entry expire (5m or 1h tier)
  | 'COLD_START'                // first turn / no prior cache_read to break / >1h resume
  | 'COMPACTION'                // conversation compaction rebuilt the message layer
  | 'SUBAGENT_INTERLEAVE'       // A→B→A: this request matches turn-2's stream, not turn-1's — a sub-agent's calls share the parent session id
  | 'NORMAL_GROWTH'             // append-only growth: the NEW tail cached for the first time (expected incremental write, NOT a break)
  | 'MESSAGE_TRIMMED'           // a cached message block was REMOVED (harness context-editing / tool-result clearing)
  | 'ATTACHMENT_CHANGED'        // a non-text block (image / tool_use input) inside the cached prefix changed
  | 'UNCLASSIFIED'              // a break with no localizable structural cause (raw diff summary attached)

// Causes that are EXPECTED cache behavior (unavoidable / not a misconfiguration): a cold warm, a
// compaction rebuild, incremental first-write of new content, and the interleave ARTIFACT (each stream
// keeps its own cache — the diff crossed streams, nothing actually broke). The verdict/ranking uses
// this to point the user at the top AVOIDABLE perpetrator instead of crowning the noise floor.
export const EXPECTED_CAUSES: ReadonlySet<CacheBreakTimelineCause> = new Set<CacheBreakTimelineCause>([
  'COLD_START', 'COMPACTION', 'NORMAL_GROWTH', 'SUBAGENT_INTERLEAVE',
])

// TTL tier a timing-driven break landed in (mirrors buildCacheBreakGapReport's gap buckets).
export type TtlTier = '5m' | '1h' | 'none'

const REMEDIATION: Record<CacheBreakTimelineCause, string> = {
  TOOLSET_CHANGED:            'A tool was added/removed/redefined mid-session. Keep the tool catalog byte-identical: use defer-loading stubs + tool-search rather than mutating the live tool set.',
  TOOLS_REORDERED:            'The tool set is the same but its ORDER shuffled. Emit tools in a stable sorted order so the catalog bytes never move.',
  TOOL_SEARCH_DEFERRED:       'A deferred tool keeps loading mid-session (tool-search). Pre-load the tools you know you need at session start, or accept the one-time load cost.',
  MCP_TOOLS_CHANGED:          'An MCP server / plugin toggled its non-deferred tools mid-session. Keep MCP servers connected for the whole session, or make their tools deferred.',
  MODEL_SWITCH:               'The model changed mid-session — caches are model-specific. Hand off to a sub-agent instead of switching model in place.',
  EFFORT_SWITCH:              'The extended-thinking / reasoning-effort setting changed. Fix the effort level once at session start; changing it invalidates system + messages.',
  HOOK_INJECTION:             'A per-turn hook writes a mutating block INTO the cached prefix. Move the hook output after the last cache breakpoint (into the current user message), or make it stable.',
  SKILL_INJECTION:            'A skill block was injected into the cached prefix. Load skills before the cache breakpoint stabilizes, or keep the skill set fixed.',
  SKILL_DESCRIPTION_TRUNCATION:'A skill description was truncated turn-to-turn, changing the catalog bytes. Keep skill descriptions stable-length within a session.',
  SKILL_CHANGED:              'A skill catalog / skill block changed content mid-session. Keep the available-skills set and their text fixed within a session.',
  INLINE_EXEC_RESULT_CHANGED: 'A skill `!`-operator shell result differs each turn (e.g. a clock/`date`/`git status`), so its injected block re-writes the prefix. Pin or remove the volatile inline command.',
  CLAUDE_MD_CHANGED:          'An injected instruction file (CLAUDE.md / a rule) changed mid-session. Do not edit instruction files during a live session; a date inside them is SYSTEM_TIMESTAMP, not this.',
  AGENT_METADATA_CHANGED:     'Harness/agent metadata (the billing header cc_version, the agent-types list) changed — usually a Claude Code upgrade. Unavoidable once; avoid resuming huge sessions right after upgrading.',
  SYSTEM_TIMESTAMP:           'A moving date/clock inside an otherwise-static block breaks the cache every day/turn. Move the timestamp out of the cached prefix into the current user message.',
  CONTEXT_ORDER_CHANGED:      'The same blocks are injected in a DIFFERENT order — the cache is byte-order sensitive, so this still breaks it. Fix the injection order to be deterministic.',
  TTL_EXPIRY:                 'No prefix change — the cache entry simply expired between turns. A heartbeat within the TTL (5m/1h) would convert these writes back to cache_read.',
  COLD_START:                 'A cold cache warm (first turn / resume / no prior cached prefix). Expected once per session; not an avoidable per-turn break.',
  COMPACTION:                 'Conversation compaction rebuilt the message layer. Expected once per compaction; avoid compacting more than necessary.',
  SUBAGENT_INTERLEAVE:        'A sub-agent stream interleaves with the parent under the SAME session id (A→B→A pattern) — each stream keeps its OWN cache, so nothing actually broke; the child bills its own (smaller) prefix. Pin the sub-agent\'s tools + model in its frontmatter to shrink that footprint.',
  NORMAL_GROWTH:              'Not a break — append-only growth: this turn\'s NEW content was cached for the first time (expected incremental write). Reduce it only by producing/ingesting less content per turn.',
  MESSAGE_TRIMMED:            'A block was REMOVED from the cached message prefix (harness context-editing / tool-result clearing / message deletion) — everything after the removal point re-writes. Prefer compaction or a fresh session over mid-session trimming of a huge transcript.',
  ATTACHMENT_CHANGED:         'A non-text block (image / tool_use input) inside the cached prefix changed or moved. Past attachments should be immutable; an image riding in the prefix re-bills the tail on any change.',
  UNCLASSIFIED:               'A break whose cause could not be localised from the prefix diff. Inspect the attached raw diff summary and the raw bodies around this turn.',
}

// ── Stable fingerprint + volatile normalization ──────────────────────────────────
// FNV-1a 32-bit — a cheap, dependency-free stable hash. We store this hash of a block's cache-relevant
// bytes, NEVER the bytes, so the prefix stays pointer-only. Two turns' blocks are "the same" iff their
// fingerprints match (which is exactly the cache's own byte-identity test, at hash granularity).
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// Strip the volatile bits (ISO dates, clock times, "Today's date is X", relative-time phrases) so two
// blocks that differ ONLY by a moving timestamp normalize to the same string — that is how a
// SYSTEM_TIMESTAMP break is told apart from a real content change (CLAUDE_MD_CHANGED etc.).
function normalizeVolatile(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>')
    .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?\b/g, '<TIME>')
    .replace(/Today'?s date is[^\n.]*/gi, "Today's date is <DATE>")
    .replace(/\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<AGO>')
}

// ── Content classification of an injected text block ──────────────────────────────
export type BlockContentKind =
  | 'claudemd' | 'rule' | 'agentmeta' | 'skillcatalog' | 'agentcatalog'
  | 'hook' | 'date' | 'execresult' | 'postcompact' | 'system' | 'usertext' | 'history' | 'attachment'

function classifyContentKind(text: string): BlockContentKind {
  if (/x-anthropic-billing-header|cc_version=|cc_entrypoint=/.test(text)) return 'agentmeta'
  if (/This session is being continued from a previous|conversation summary so far|compacted the (?:previous )?conversation|<compaction_summary|Analysis:[\s\S]{0,80}Summary:/i.test(text)) return 'postcompact'
  if (/Contents of .{0,300}CLAUDE\.md|^#\s*CLAUDE\.md/m.test(text)) return 'claudemd'
  if (/Contents of .{0,300}[/\\]\.claude[/\\]rules[/\\]/.test(text)) return 'rule'
  if (/<local-command-stdout>|<command-output>|command-stdout|<function_results>/.test(text)) return 'execresult'
  if (/skills are available for use with the Skill tool|The following skills are available|Available skills:/.test(text)) return 'skillcatalog'
  if (/Available agent types|available agent types for the Agent tool|subagent_type/.test(text)) return 'agentcatalog'
  // Per-turn injections that land INSIDE user messages (not <system-reminder>-wrapped): the
  // UserPromptSubmit / PostToolUse hook context (<pss-skills>, [janitor-memory], …) and the harness
  // task-list nudge. These previously fell to 'usertext', hiding chronic per-turn mutators in
  // UNCLASSIFIED — naming them is the whole point of the perpetrator backtrace.
  if (/<pss-skills>|\[janitor-memory\]|UserPromptSubmit hook additional context|PostToolUse:\S* hook additional context|task tools haven't been used recently/i.test(text)) return 'hook'
  if (/<system-reminder>/.test(text) && /hook|inbox|heartbeat|reminder/i.test(text)) return 'hook'
  if (/Today'?s date is|# *currentDate|Current date:/.test(text)) return 'date'
  if (/<system-reminder>/.test(text)) return 'system'
  return 'usertext'
}

function causeForContentKind(kind: BlockContentKind): CacheBreakTimelineCause {
  switch (kind) {
    case 'claudemd': case 'rule': return 'CLAUDE_MD_CHANGED'
    case 'agentmeta': case 'agentcatalog': return 'AGENT_METADATA_CHANGED'
    case 'skillcatalog': return 'SKILL_CHANGED'
    case 'hook': return 'HOOK_INJECTION'
    case 'date': return 'SYSTEM_TIMESTAMP'
    case 'execresult': return 'INLINE_EXEC_RESULT_CHANGED'
    case 'postcompact': return 'COMPACTION'
    case 'attachment': return 'ATTACHMENT_CHANGED'
    default: return 'UNCLASSIFIED'
  }
}

// Split one injected text block into classified SEGMENTS at "Contents of <path>" boundaries — Claude
// Code concatenates CLAUDE.md + every rule + memory + the skills list into ONE giant system-reminder,
// so segmenting lets the diff pinpoint the CLAUDE.md segment vs a rule vs the skills list vs a date,
// instead of blaming the whole mega-block. Fail-soft: a block with no boundary markers is one segment.
interface Segment { kind: BlockContentKind; label: string; text: string }
function segmentInjected(text: string, blockLabel: string): Segment[] {
  const boundary = /Contents of ([^\n(]+?\.[A-Za-z0-9_]+)/g
  const marks: { idx: number; label: string }[] = []
  let m: RegExpExecArray | null
  while ((m = boundary.exec(text)) !== null) marks.push({ idx: m.index, label: m[1].trim() })
  if (marks.length === 0) {
    const kind = classifyContentKind(text)
    return [{ kind, label: labelFor(kind, text, blockLabel), text }]
  }
  const segs: Segment[] = []
  // The leading region before the first "Contents of" (harness prose / billing header / date).
  if (marks[0].idx > 0) {
    const lead = text.slice(0, marks[0].idx)
    const kind = classifyContentKind(lead)
    segs.push({ kind, label: labelFor(kind, lead, blockLabel), text: lead })
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].idx : text.length
    const body = text.slice(marks[i].idx, end)
    const kind = classifyContentKind(body)
    segs.push({ kind, label: marks[i].label, text: body })
  }
  return segs
}

function labelForKind(kind: BlockContentKind, fallback: string): string {
  switch (kind) {
    case 'agentmeta': return 'harness/billing header'
    case 'skillcatalog': return 'available-skills catalog'
    case 'agentcatalog': return 'agent-types catalog'
    case 'hook': return 'hook injection'
    case 'date': return 'system date/clock'
    case 'execresult': return 'inline command result'
    default: return fallback
  }
}

// BACKTRACE TO THE PERPETRATOR (the user's core ask): a HOOK_INJECTION break must name WHICH injector
// wrote the mutating block, not a generic "hook injection" — because the culprit is the hook/skill/
// harness process, not the transcript it perturbed. We identify it from a stable content signature and
// keep ONLY the short name (pointer-only — never the block text). This name flows into the block label →
// mkBlock's culpritId → the repeat-offender rollup, so two breaks from the SAME injector collapse into
// ONE chronic perpetrator ("pss-skills broke the cache on 40 turns").
function hookSignature(text: string): string | null {
  if (/<pss-skills>/.test(text)) return 'pss-skills (perfect-skill-suggester)'
  if (/\[janitor-memory\]/.test(text)) return 'janitor-memory recall'
  if (/\[janitor-heartbeat\]/.test(text)) return 'janitor-heartbeat'
  if (/task tools haven't been used recently/i.test(text)) return 'harness task-list reminder'
  if (/UserPromptSubmit hook additional context/.test(text)) return 'UserPromptSubmit injection'
  if (/PostToolUse:\S* hook additional context/.test(text)) return 'PostToolUse injection'
  if (/token-guard|hard budget|token budget still exceeded/i.test(text)) return 'token-guard'
  if (/Context window:\s*\d|pre-tool-context-usage|context watchdog/i.test(text)) return 'context-usage watchdog'
  if (/post-mcp-sanitizer|prompt-injection shape/i.test(text)) return 'mcp-sanitizer'
  if (/AI Maestro|inbox notification|unread messages/i.test(text)) return 'ai-maestro inbox'
  if (/spyglass/i.test(text)) return 'spyglass'
  if (/worktree|task-notification/i.test(text)) return 'worktree/task notifier'
  return null
}

// Resolve the label for an injected segment, preferring the specific injector name for hook/system
// blocks so the backtrace points at the perpetrator, falling back to the generic per-kind label.
function labelFor(kind: BlockContentKind, text: string, fallback: string): string {
  if (kind === 'hook' || kind === 'system') {
    const sig = hookSignature(text)
    if (sig) return `hook: ${sig}`
  }
  return labelForKind(kind, fallback)
}

// The built-in tools the harness defer-loads and toggles via ToolSearch (AskUserQuestion/Cron*/Task*/
// Web*/…). When a cache break's changed tool set is entirely within this set, the perpetrator is the
// harness ToolSearch mechanism churning its deferred built-ins — NOT the user's own MCP/tool config —
// so we attribute it to a single stable actor instead of the volatile add/remove list.
const DEFERRED_BUILTINS = new Set<string>([
  'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'SendMessage',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'LSP', 'Monitor', 'PushNotification',
  'RemoteTrigger', 'DesignSync', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree',
  'ExitWorktree', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'ListMcpResourcesTool',
])

// Extract the distinct MCP server names from tool names of the form mcp__<server>__<tool>, so an
// MCP_TOOLS_CHANGED break backtraces to the SERVER that connected/disconnected (chrome-devtools,
// lean-ctx, agentlens, …) rather than to the individual tools it carried.
function mcpServersOf(names: string[]): string[] {
  const s = new Set<string>()
  for (const n of names) { const m = /^mcp__(.+?)__/.exec(n); if (m) s.add(m[1]) }
  return [...s].sort()
}

// ── Turn prefix (compact, pointer-only) ──────────────────────────────────────────
export interface PrefixTool { name: string; deferred: boolean; isMcp: boolean; fp: string }
export interface PrefixBlock {
  layer: 'system' | 'message'
  kind: BlockContentKind
  label: string
  fp: string        // fingerprint of the raw bytes (byte identity, hashed)
  norm: string      // fingerprint of the timestamp-normalized bytes (for SYSTEM_TIMESTAMP detection)
  len: number       // char length (SKILL_DESCRIPTION_TRUNCATION shrink detection)
  tokensApprox: number
}
export interface TurnPrefix {
  model: string
  effort: string    // normalized extended-thinking / speed signature
  tools: PrefixTool[]
  systemBlocks: PrefixBlock[]
  messageBlocks: PrefixBlock[]  // cached message-prefix injected blocks (up to the last message cache_control)
}

interface RawBlockLike { type?: string; text?: string; cache_control?: unknown; content?: unknown; source?: unknown }
interface RawMessageLike { role?: string; content?: string | RawBlockLike[] }
interface RawSystemLike { type?: string; text?: string; cache_control?: unknown }
interface RawToolLike { name?: string; description?: string; input_schema?: unknown; defer_loading?: unknown; cache_control?: unknown }
export interface RawRequestForBreak {
  model?: unknown
  thinking?: unknown
  speed?: unknown
  tool_choice?: unknown
  system?: string | RawSystemLike[]
  tools?: RawToolLike[]
  messages?: RawMessageLike[]
  metadata?: { user_id?: unknown }
  diagnostics?: { previous_message_id?: unknown }
}

function effortSignature(body: RawRequestForBreak): string {
  const t = body.thinking
  let thinking = 'none'
  if (t && typeof t === 'object') {
    const o = t as { type?: unknown; budget_tokens?: unknown }
    thinking = `${typeof o.type === 'string' ? o.type : '?'}:${typeof o.budget_tokens === 'number' ? o.budget_tokens : ''}`
  }
  const speed = typeof body.speed === 'string' ? body.speed : 'std'
  const toolChoice = body.tool_choice && typeof body.tool_choice === 'object'
    ? JSON.stringify(body.tool_choice) : String(body.tool_choice ?? 'auto')
  return `${thinking}|${speed}|${toolChoice}`
}

function toPrefixBlock(layer: 'system' | 'message', kind: BlockContentKind, label: string, text: string): PrefixBlock {
  return {
    layer, kind, label,
    fp: fnv1a(text),
    norm: fnv1a(normalizeVolatile(text)),
    len: text.length,
    tokensApprox: estimateTokensFromBytes(Buffer.byteLength(text)),
  }
}

// Non-text blocks (images, tool_use inputs) were previously SKIPPED from the prefix, so a change there
// was an invisible prefix mutation landing in UNCLASSIFIED. Fingerprint them by type+name+SIZE only —
// pointer-only (never the input JSON or base64 bytes) — so the diff can name ATTACHMENT_CHANGED.
function attachmentPrefixBlock(b: RawBlockLike & { name?: string; input?: unknown }, msgIndex: number): PrefixBlock | null {
  if (b.type !== 'tool_use' && b.type !== 'image') return null
  const name = typeof b.name === 'string' ? b.name : '?'
  const imgLen = typeof (b.source as { data?: string } | undefined)?.data === 'string'
    ? (b.source as { data: string }).data.length : 0
  const sig = b.type === 'tool_use' ? `tool_use:${name}:${JSON.stringify(b.input ?? {}).length}` : `image:${imgLen}`
  return {
    layer: 'message', kind: 'attachment',
    label: `msg[${msgIndex}] ${b.type}${b.type === 'tool_use' ? ' ' + name : ''}`,
    fp: fnv1a(sig), norm: fnv1a(sig), len: sig.length, tokensApprox: 0,
  }
}

// Flatten the injected TEXT of a message content block (string, {type:text}, tool_result text). We
// deliberately ignore tool_use inputs and base64 image data — the former is stable history, the latter
// is never touched (pointer-only). Returns '' for a non-text block (skipped from the diff).
function messageBlockText(b: RawBlockLike): string {
  if (b.type === 'text' && typeof b.text === 'string') return b.text
  if (b.type === 'tool_result') {
    const c = b.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map(x => (x && typeof x === 'object' && (x as { text?: string }).text) || '').join('\n')
  }
  return ''
}

/** Parse a raw request body into a compact, pointer-only TurnPrefix. The cached prefix = the whole
 *  tools array + the whole system array + the message blocks up to and including the LAST message-level
 *  cache_control breakpoint (everything after that is the volatile current-turn tail, expected to
 *  change — excluded from the break diff). Returns null for a body with no model (unparseable). */
export function extractTurnPrefix(body: RawRequestForBreak | null): TurnPrefix | null {
  if (!body || typeof body !== 'object') return null
  const model = typeof body.model === 'string' ? body.model : ''

  const tools: PrefixTool[] = (Array.isArray(body.tools) ? body.tools : []).map(t => {
    const name = typeof t.name === 'string' ? t.name : '?'
    const defBytes = `${typeof t.description === 'string' ? t.description : ''} ${JSON.stringify(t.input_schema ?? {})}`
    return { name, deferred: t.defer_loading === true, isMcp: name.startsWith('mcp__'), fp: fnv1a(defBytes) }
  })

  const systemBlocks: PrefixBlock[] = []
  if (typeof body.system === 'string' && body.system) {
    for (const seg of segmentInjected(body.system, 'system prompt')) {
      systemBlocks.push(toPrefixBlock('system', seg.kind, seg.label, seg.text))
    }
  } else if (Array.isArray(body.system)) {
    body.system.forEach((s, i) => {
      const text = typeof s?.text === 'string' ? s.text : ''
      if (!text) return
      for (const seg of segmentInjected(text, `system[${i}]`)) {
        systemBlocks.push(toPrefixBlock('system', seg.kind, seg.label, seg.text))
      }
    })
  }

  // Message cached prefix: find the LAST message index that carries (or whose content carries) a
  // cache_control marker — the cache breakpoint. Everything up to and including it is cached prefix.
  const messages = Array.isArray(body.messages) ? body.messages : []
  let lastBreakpoint = -1
  messages.forEach((mm, i) => {
    const c = mm?.content
    const hasCC = Array.isArray(c) && c.some(b => b && typeof b === 'object' && (b as RawBlockLike).cache_control)
    if (hasCC) lastBreakpoint = i
  })
  const messageBlocks: PrefixBlock[] = []
  const upTo = lastBreakpoint >= 0 ? lastBreakpoint : -1
  for (let i = 0; i <= upTo; i++) {
    const mm = messages[i]
    const content = mm?.content
    if (typeof content === 'string') {
      if (!content) continue
      for (const seg of segmentInjected(content, `msg[${i}] ${mm?.role ?? ''}`)) {
        // Plain conversation history rarely carries injected markers → 'usertext' segments are stable
        // history; keep them so a genuine reorder/compaction is still visible, but they classify as
        // UNCLASSIFIED (never falsely blamed for a specific cause).
        messageBlocks.push(toPrefixBlock('message', seg.kind, seg.label, seg.text))
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      const text = messageBlockText(b as RawBlockLike)
      if (!text) {
        const att = attachmentPrefixBlock(b as RawBlockLike, i)
        if (att) messageBlocks.push(att)
        continue
      }
      for (const seg of segmentInjected(text, `msg[${i}] ${mm?.role ?? ''}`)) {
        messageBlocks.push(toPrefixBlock('message', seg.kind, seg.label, seg.text))
      }
    }
  }

  return { model, effort: effortSignature(body), tools, systemBlocks, messageBlocks }
}

// ── The classifier ───────────────────────────────────────────────────────────────
export interface CacheBreakVerdict {
  cause: CacheBreakTimelineCause
  culpritLayer: 'model' | 'effort' | 'tools' | 'system' | 'message' | 'timing'
  culpritId: string          // STABLE identity of the offending element (grouping key for repeat-offenders)
  culpritSummary: string     // pointer-only, human-readable — never full content
  ttlTier?: TtlTier
  rawDiffSummary?: string     // attached only for UNCLASSIFIED
}

export interface BreakTiming {
  gapMs?: number
  cacheReadTokens: number
  cacheCreateTokens: number
  ephemeral5mTokens: number
  ephemeral1hTokens: number
}

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000

// Diff the tools layer: added/removed by set, then order, then per-tool definition change. Returns the
// most-specific tools cause, or null when the tool catalog is byte-identical.
function diffTools(prev: TurnPrefix, cur: TurnPrefix): CacheBreakVerdict | null {
  const prevNames = prev.tools.map(t => t.name)
  const curNames = cur.tools.map(t => t.name)
  const prevSet = new Set(prevNames)
  const curSet = new Set(curNames)
  const added = curNames.filter(n => !prevSet.has(n))
  const removed = prevNames.filter(n => !curSet.has(n))
  if (added.length || removed.length) {
    const changed = [...added, ...removed]
    // A newly-present DEFERRED tool (and no removals) = tool-search deferred loading — the most specific.
    const addedDeferred = added.filter(n => cur.tools.find(t => t.name === n)?.deferred)
    if (added.length > 0 && removed.length === 0 && addedDeferred.length === added.length) {
      return mkTools('TOOL_SEARCH_DEFERRED', added, `deferred tool(s) loaded mid-session: ${fmtList(added)}`)
    }
    // All changed tools are MCP — an MCP server / plugin toggled. Backtrace to the SERVER(s) so the
    // culpritId groups by the connecting/disconnecting server, not the individual tool churn.
    if (changed.every(n => n.startsWith('mcp__'))) {
      const servers = mcpServersOf(changed)
      const srvTag = servers.length ? ` [server: ${fmtList(servers)}]` : ''
      return mkTools('MCP_TOOLS_CHANGED', servers.length ? servers : changed,
        `MCP tool(s) ${added.length ? 'added ' + fmtList(added) : ''}${removed.length ? ' removed ' + fmtList(removed) : ''}${srvTag}`.trim())
    }
    // The changed set is entirely harness deferred built-ins (AskUserQuestion/Cron*/Task*/…) → the
    // perpetrator is the harness ToolSearch mechanism toggling its deferred set, attributed to ONE
    // stable actor so the repeat-offender rollup names the harness, not the volatile add/remove list.
    if (changed.every(n => DEFERRED_BUILTINS.has(n))) {
      return mkTools('TOOL_SEARCH_DEFERRED', ['harness:deferred-builtins'],
        `harness ToolSearch toggled deferred built-ins (${changed.length}): ${fmtList(changed)}`)
    }
    return mkTools('TOOLSET_CHANGED', changed, `tool(s) ${added.length ? 'added ' + fmtList(added) : ''}${removed.length ? ' removed ' + fmtList(removed) : ''}`.trim())
  }
  // Same set: order change?
  if (curNames.join(' ') !== prevNames.join(' ')) {
    const firstMoved = curNames.find((n, i) => prevNames[i] !== n) ?? curNames[0]
    return mkTools('TOOLS_REORDERED', [firstMoved], `same ${curNames.length} tools, order changed (first at "${firstMoved}")`)
  }
  // Same set + order: a tool DEFINITION (description/schema) changed?
  for (const t of cur.tools) {
    const p = prev.tools.find(x => x.name === t.name)
    if (p && p.fp !== t.fp) return mkTools('TOOLSET_CHANGED', [t.name], `tool definition changed: ${t.name}`)
  }
  return null
}

function mkTools(cause: CacheBreakTimelineCause, names: string[], summary: string): CacheBreakVerdict {
  return { cause, culpritLayer: 'tools', culpritId: `tools:${cause}:${names.slice(0, 3).sort().join(',')}`, culpritSummary: summary }
}
function fmtList(xs: string[]): string { return xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} +${xs.length - 3} more` }

// Diff a block layer POSITIONALLY — the prompt cache breaks at the first differing BYTE position, so
// the first differing block POSITION in the cached prefix is the true break point. This is what makes
// normal conversation GROWTH not a false break: appended blocks beyond the previous prefix's length are
// ignored (that's the one-time cache_creation of new content, expected); only a change/removal/reorder
// WITHIN the previously-cached common prefix is an avoidable break. Returns the classified verdict, or
// null when cur is a byte-identical extension of prev (pure growth).
function diffBlocks(prevBlocksRaw: PrefixBlock[], curBlocksRaw: PrefixBlock[], layer: 'system' | 'message'): CacheBreakVerdict | null {
  // Drop cache-transparent blocks BEFORE the positional diff. The harness billing header
  // (kind 'agentmeta' — the leading `cc_prev_req` block at system pos 0) changes on EVERY turn but is
  // EXCLUDED from Anthropic's prompt-cache key. Proven empirically: were it in the key, every turn
  // would rewrite the whole ~context-size prefix as cache_creation (it always changes), yet long
  // sessions measure >95% cache_read. So a divergence there is NOT a real break — comparing it would
  // pin every idle-TTL / message-prefix / sub-agent break on a constant ("billing header"), the exact
  // false-SYSTEMATIC verdict this masks. Skipping it lets the classifier fall through to the true
  // culprit (or to the TTL-timing check when the cache-relevant prefix is byte-identical).
  // NOTE: 'agentcatalog' (the agent-types list) is a DIFFERENT kind and IS cache-relevant — not dropped.
  const prevBlocks = prevBlocksRaw.filter(b => b.kind !== 'agentmeta')
  const curBlocks = curBlocksRaw.filter(b => b.kind !== 'agentmeta')
  const prevFps = new Set(prevBlocks.map(b => b.fp))
  const curFps = new Set(curBlocks.map(b => b.fp))
  const prevKinds = new Set(prevBlocks.map(b => b.kind))
  const n = Math.min(prevBlocks.length, curBlocks.length)
  for (let i = 0; i < n; i++) {
    const p = prevBlocks[i], c = curBlocks[i]
    if (p.fp === c.fp) continue
    // First divergence at position i. Classify most-specific-first.
    if (c.kind === 'postcompact' || p.kind === 'postcompact') return mkBlock('COMPACTION', layer, c, `conversation compaction rebuilt the ${layer} prefix at ${c.label}`)
    if (p.norm === c.norm) return mkBlock('SYSTEM_TIMESTAMP', layer, c, `moving date/clock in ${c.label}`)
    // Same content, different position (this block existed earlier in prev, and prev's block still
    // exists later in cur) → a pure reorder, not a content change.
    if (prevFps.has(c.fp) && curFps.has(p.fp)) {
      return { cause: 'CONTEXT_ORDER_CHANGED', culpritLayer: layer, culpritId: `${layer}:order`, culpritSummary: `${layer} blocks reordered at ${c.label} (identical content, different order)` }
    }
    // Skill-catalog specifics: a block whose kind prev never carried = a fresh injection; a shrink =
    // a truncation; otherwise a content change.
    if (c.kind === 'skillcatalog') {
      if (!prevKinds.has('skillcatalog')) return mkBlock('SKILL_INJECTION', layer, c, `skill catalog injected at pos ${i}: ${c.label}`)
      if (p.kind === 'skillcatalog' && c.len < p.len * 0.9) return mkBlock('SKILL_DESCRIPTION_TRUNCATION', layer, c, `skill catalog shrank ${p.len}→${c.len} chars: ${c.label}`)
    }
    const changed = causeForContentKind(c.kind)
    return mkBlock(changed, layer, c, `${c.kind} block changed at pos ${i}: ${c.label}`)
  }
  // No divergence within the common prefix.
  if (prevBlocks.length > curBlocks.length) {
    // The cached prefix SHRANK — a block that was cached got dropped (compaction or removal).
    const dropped = prevBlocks[curBlocks.length]
    if (dropped.kind === 'postcompact') return mkBlock('COMPACTION', layer, dropped, `compaction dropped ${layer} blocks from ${dropped.label}`)
    if (dropped.kind === 'skillcatalog') return mkBlock('SKILL_CHANGED', layer, dropped, `skill catalog removed from the ${layer} prefix: ${dropped.label}`)
    // A plain conversation/tool block dropped from the MESSAGE prefix = harness context-editing /
    // tool-result clearing / message deletion — a named cause, not UNCLASSIFIED: the removal point
    // invalidates everything after it, which is exactly the "trim a huge transcript mid-session" cost.
    if (layer === 'message' && (dropped.kind === 'usertext' || dropped.kind === 'history' || dropped.kind === 'attachment' || dropped.kind === 'execresult')) {
      return mkBlock('MESSAGE_TRIMMED', layer, dropped, `${dropped.kind} block removed from the message prefix (context-editing/trim): ${dropped.label}`)
    }
    return mkBlock(causeForContentKind(dropped.kind), layer, dropped, `${dropped.kind} block removed from the ${layer} prefix: ${dropped.label}`)
  }
  // cur is longer (pure append growth) or identical — NOT an avoidable break.
  return null
}

function mkBlock(cause: CacheBreakTimelineCause, layer: 'system' | 'message', b: PrefixBlock, summary: string): CacheBreakVerdict {
  return { cause, culpritLayer: layer, culpritId: `${layer}:${cause}:${b.kind}:${b.label.slice(0, 48)}`, culpritSummary: summary }
}

/** Classify ONE turn's cache_creation into a root cause by diffing its prefix against the previous
 *  turn's, in the docs hierarchy order (model → tools → effort → system → message-prefix). A structural
 *  prefix change ALWAYS beats a timing gap — the change is the real culprit. When the prefix is
 *  byte-identical, the break is timing (TTL expiry / cold start). */
export function classifyCacheBreak(prev: TurnPrefix | null, cur: TurnPrefix, timing: BreakTiming, prev2?: TurnPrefix | null): CacheBreakVerdict {
  if (!prev) {
    return { cause: 'COLD_START', culpritLayer: 'timing', culpritId: 'timing:COLD_START', culpritSummary: 'first observed turn for this session (cold cache warm)', ttlTier: 'none' }
  }
  // 0. Sub-agent INTERLEAVE artifact — checked BEFORE model/tools, because it explains both. Sub-agent
  //    API calls carry the PARENT's session_id, so the mtime-ordered "turn" sequence can alternate
  //    between two independent streams (parent A, child B): the diff then sees A→B→A "model switches"
  //    and 15-tools-removed-then-re-added-in-3ms "toolset churn" that never happened — each stream keeps
  //    its OWN cache. Signature: this turn matches turn-2's stream (model + tool catalog byte-identical)
  //    while differing from turn-1. Without this check those artifacts pollute MODEL_SWITCH and
  //    TOOLSET_CHANGED and make the avoidable-cause ranking dishonest.
  if (prev2) {
    const streamFp = (p: TurnPrefix) => `${p.model}|${p.tools.map(t => `${t.name}:${t.fp}`).join(' ')}`
    const differsFromPrev = prev.model !== cur.model || streamFp(prev) !== streamFp(cur)
    if (differsFromPrev && streamFp(cur) === streamFp(prev2)) {
      const pair = [prev.model || '?', cur.model || '?'].sort().join(' <-> ')
      return { cause: 'SUBAGENT_INTERLEAVE', culpritLayer: 'timing', culpritId: `interleave:${pair}`, culpritSummary: `A→B→A interleave (${pair}): this request matches turn-2's stream, not turn-1's — a sub-agent's calls share the parent session id`, ttlTier: 'none' }
    }
  }
  // 1. Model — model-specific cache, invalidates everything.
  if (prev.model !== cur.model) {
    return { cause: 'MODEL_SWITCH', culpritLayer: 'model', culpritId: 'model', culpritSummary: `model ${prev.model || '?'} → ${cur.model || '?'}` }
  }
  // 2. Tools — invalidates tools + system + messages (higher than effort, which keeps tools cached).
  const toolsV = diffTools(prev, cur)
  if (toolsV) return toolsV
  // 3. Effort / thinking / tool_choice — invalidates system + messages (bytes may be unchanged).
  if (prev.effort !== cur.effort) {
    return { cause: 'EFFORT_SWITCH', culpritLayer: 'effort', culpritId: 'effort', culpritSummary: `thinking/effort ${prev.effort} → ${cur.effort}` }
  }
  // 4. System blocks.
  const sysV = diffBlocks(prev.systemBlocks, cur.systemBlocks, 'system')
  if (sysV) return sysV
  // 5. Message cached-prefix blocks. Any structural change (even an unlocalised one) beats a timing
  //    gap — a real byte change in the cached prefix is the true culprit, never TTL expiry.
  const msgV = diffBlocks(prev.messageBlocks, cur.messageBlocks, 'message')
  if (msgV) {
    if (msgV.cause === 'UNCLASSIFIED') msgV.rawDiffSummary = `${msgV.culpritSummary}; sys=${cur.systemBlocks.length} msg=${cur.messageBlocks.length} (was ${prev.messageBlocks.length})`
    return msgV
  }

  // 6. No localizable structural change → timing. Pure-timing means the whole cached prefix is
  //    byte-identical to the previous turn, so the only thing that could have re-written it is a TTL
  //    expiry (the entry aged out) or a cold warm.
  const gap = timing.gapMs
  if (gap !== undefined) {
    if (gap >= ONE_HOUR) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:1h', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap > 1h TTL`, ttlTier: '1h' }
    if (gap >= 4.5 * 60_000 && gap < 6 * 60_000) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:5m', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap ≈ 5m TTL`, ttlTier: '5m' }
    if (gap >= FIVE_MIN) return { cause: 'TTL_EXPIRY', culpritLayer: 'timing', culpritId: 'timing:TTL_EXPIRY:5m', culpritSummary: `no prefix change; ${(gap / 60000).toFixed(1)}m gap > 5m TTL`, ttlTier: '5m' }
  }
  if (timing.cacheReadTokens === 0) {
    return { cause: 'COLD_START', culpritLayer: 'timing', culpritId: 'timing:COLD_START', culpritSummary: 'no cache_read this turn — nothing cached to break (cold warm)', ttlTier: 'none' }
  }
  // 6.5. Pure APPEND growth: the previously-cached prefix is byte-identical AND this turn's message
  //      prefix is LONGER — the cache_creation is the NEW tail (this turn's fresh content) being cached
  //      for the first time. That is the incremental cache WORKING, not a break. This was the single
  //      biggest population previously dumped into UNCLASSIFIED ("unlocalised re-write"), hiding the
  //      fact that most of it was expected cost.
  if (cur.messageBlocks.length > prev.messageBlocks.length) {
    const added = cur.messageBlocks.length - prev.messageBlocks.length
    return { cause: 'NORMAL_GROWTH', culpritLayer: 'message', culpritId: 'growth:new-tail', culpritSummary: `append-only growth: +${added} new message block(s) cached for the first time (expected incremental write, not a break)`, ttlTier: 'none' }
  }
  // 7. Every layer's fingerprints matched yet a real re-write happened — an effect we cannot localise
  //    (e.g. a cache_control breakpoint moved, or an estimator blind spot). Attach a diff summary
  //    rather than guess.
  const raw = `prefix byte-identical by fingerprint but cache_creation=${timing.cacheCreateTokens}; tools=${cur.tools.length} sys=${cur.systemBlocks.length} msg=${cur.messageBlocks.length}`
  return { cause: 'UNCLASSIFIED', culpritLayer: 'timing', culpritId: 'timing:UNCLASSIFIED', culpritSummary: 'unlocalised re-write', rawDiffSummary: raw }
}

// ── Bounded scan: reconstruct sessions' ordered turns ────────────────────────────
interface ScannedTurn {
  bodyRef: string
  mtimeMs: number
  previousMessageId?: string
  sessionId?: string
  accountUuid?: string
  prefix: TurnPrefix | null
}
// inputTokens/outputTokens are additive to TRDD-6TQ2FBUR's original shape — carried so
// buildCauseCostPeakReport (TRDD-6TQ2FBUR D2) can rank cause groups by ANY cost bucket, not just
// cache_creation; the single-session timeline itself still only uses cacheCreate/cacheRead/tiers.
interface ResponseUsage { cacheCreate: number; cacheRead: number; ephemeral5m: number; ephemeral1h: number; inputTokens: number; outputTokens: number; model?: string; ts: number }

export interface CacheBreakTimelineOptions {
  bodiesDir?: string
  sessionId?: string
  scope?: string
  minTokens?: number
  windowHours?: number
  scanCap?: number
  topN?: number   // cap on the returned `events` array (default 25, max 100) — repeatOffenders/causeHistogram are unaffected
  /** Claude projects roots searched for a sub-agent child's transcript (test override; defaults
   *  to claudeProjectsDirs() — the same roots the log reader ingests from). */
  projectsDirs?: string[]
}

function numOr0(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0 }
function strOrUndef(v: unknown): string | undefined { return typeof v === 'string' && v.length > 0 ? v : undefined }

interface RawResponseForBreak {
  id?: unknown
  model?: unknown
  usage?: {
    input_tokens?: unknown; output_tokens?: unknown
    cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown }
  }
}

// ── The timeline report ──────────────────────────────────────────────────────────
export interface CacheBreakEvent {
  turn: number
  ts: string
  cause: CacheBreakTimelineCause
  culpritLayer: string
  culpritId: string
  culprit: string            // pointer-only human summary
  cacheCreateTokens: number
  cacheReadTokens: number
  inputTokens: number        // TRDD-6TQ2FBUR D2 — carried for buildCauseCostPeakReport's bucket ranking
  outputTokens: number       // (billed ~5x; can be the real cost peak even when cacheCreate is modest)
  costUsd: number
  gapMinutes?: number
  ttlTier?: TtlTier
  model?: string
  remediation: string
  rawDiffSummary?: string
}

export interface RepeatOffender {
  cause: CacheBreakTimelineCause
  culpritId: string
  culprit: string
  occurrences: number        // turns this exact element broke the cache
  totalCacheCreateTokens: number
  medianCacheCreateTokens: number
  totalCostUsd: number
  pctOfSessionCacheCreate: number   // % of the session's total cache_creation
  firstTurn: number
  lastTurn: number
  systematic: boolean        // occurrences >= systematicThreshold
  verdict: string            // plain-language "here is your misconfigured X" line
}

export interface CacheBreakTimelineReport {
  sessionId?: string
  accountUuid?: string
  model?: string
  minTokens: number
  systematicThreshold: number
  turnsInSession: number
  turnsClassified: number             // TOTAL classified break events, before any topN truncation of `events`
  totalCacheCreateTokens: number       // Σ over the classified break events
  events: CacheBreakEvent[]            // most-recent-first-truncated to topN — see eventsNote when capped
  eventsNote?: string                  // set only when `events` was truncated; causeHistogram/repeatOffenders below are ALWAYS computed over the full set, never truncated
  causeHistogram: { cause: CacheBreakTimelineCause; events: number; cacheCreateTokens: number }[]
  repeatOffenders: RepeatOffender[]
  coverage: {
    bodiesDir: string
    dirExists: boolean
    requestFilesTotal: number
    requestFilesScanned: number
    responseFilesTotal: number
    responseFilesScanned: number
    sessionsFound: number
    scanCap: number
    windowHours?: number
    complete: boolean
    note: string
  }
}

const DEFAULT_MIN_TOKENS = 5000
const SYSTEMATIC_THRESHOLD = 3
const DEFAULT_EVENTS_TOPN = 25
const MAX_EVENTS_TOPN = 100

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

interface SessionScanResult {
  bySession: Map<string, ScannedTurn[]>
  respById: Map<string, ResponseUsage>
  coverage: CacheBreakTimelineReport['coverage']
}

// Shared bounded scan: index every response by message id -> usage, and every request into ordered
// per-session turns. Both buildCacheBreakTimeline (ONE target session) and buildCauseCostPeakReport
// (EVERY session, for the cost-peak finder's groupBy=cause) build on this ONE scan so the disk-read
// contract lives in exactly one place — caller must already have checked dirExists.
function scanSessionsAndResponses(bodiesDir: string, windowHours: number | undefined, scanCap: number): SessionScanResult {
  const allRequests = listBySuffix(bodiesDir, '.request.json')
  const allResponses = listBySuffix(bodiesDir, '.response.json')
  const { slice: reqSlice, matched: reqMatched } = boundedRecent(allRequests, { windowHours, cap: scanCap })
  const { slice: respSlice } = boundedRecent(allResponses, { windowHours, cap: scanCap })

  // Index responses by message id → usage.
  const respById = new Map<string, ResponseUsage>()
  for (const e of respSlice) {
    const body = readJsonBounded<RawResponseForBreak>(e.path, MAX_RESPONSE_BYTES)
    const id = strOrUndef(body?.id)
    if (!body?.usage || !id) continue
    const tier = body.usage.cache_creation
    respById.set(id, {
      cacheCreate: numOr0(body.usage.cache_creation_input_tokens),
      cacheRead: numOr0(body.usage.cache_read_input_tokens),
      ephemeral5m: numOr0(tier?.ephemeral_5m_input_tokens),
      ephemeral1h: numOr0(tier?.ephemeral_1h_input_tokens),
      inputTokens: numOr0(body.usage.input_tokens),
      outputTokens: numOr0(body.usage.output_tokens),
      model: strOrUndef(body.model),
      ts: e.mtimeMs,
    })
  }

  // Parse requests → compact turns, grouped by session. Drop each raw body immediately (memory-bounded).
  const bySession = new Map<string, ScannedTurn[]>()
  for (const e of reqSlice) {
    const body = readJsonBounded<RawRequestForBreak>(e.path, MAX_REQUEST_BYTES)
    if (!body) continue
    const uid = parseUserId(body.metadata?.user_id)
    const sid = uid.sessionId ?? '(no-session)'
    const turn: ScannedTurn = {
      bodyRef: e.path, mtimeMs: e.mtimeMs,
      previousMessageId: strOrUndef(body.diagnostics?.previous_message_id),
      sessionId: uid.sessionId, accountUuid: uid.accountUuid,
      prefix: extractTurnPrefix(body),
    }
    const list = bySession.get(sid)
    if (list) list.push(turn); else bySession.set(sid, [turn])
  }

  const complete = reqSlice.length === reqMatched
  const coverage: CacheBreakTimelineReport['coverage'] = {
    bodiesDir, dirExists: true,
    requestFilesTotal: allRequests.length, requestFilesScanned: reqSlice.length,
    responseFilesTotal: allResponses.length, responseFilesScanned: respSlice.length,
    sessionsFound: bySession.size, scanCap, windowHours, complete,
    note: complete
      ? `Scanned all ${reqMatched} request body file(s)${windowHours ? ` in the last ${windowHours}h` : ''} across ${bySession.size} session(s).`
      : `SAMPLE: ${reqSlice.length} most-recent of ${reqMatched} matching request body file(s) across ${bySession.size} session(s) (cap ${scanCap}). Not full history.`,
  }
  return { bySession, respById, coverage }
}

// ── agent-* child sessions (2026-07-11 field fix) ────────────────────────────────
// A sub-agent card's session id is `agent-<agentId>` (the subagents/*.jsonl filename convention),
// but the child's API calls carry the PARENT's session_id in metadata.user_id — so the raw-bodies
// scan groups every child turn under the parent, an exact `sessionId: 'agent-…'` lookup matched
// nothing, and every child timeline came back turnsClassified 0 (per-child cache forensics were
// impossible). The child's OWN transcript (<projects>/<mangled>/<parentSessionId>/subagents/
// agent-<agentId>.jsonl) holds the missing link: its assistant `message.id`s ARE the child's API
// response ids, and turn i+1 of the same stream carries turn i's response id as
// previous_message_id — so the child's turns are exactly the parent-bucket turns whose
// previous_message_id is one of the child's message ids, plus the stream head (recovered below).

const SUBAGENT_TRANSCRIPT_CAP = 64 * 1024 * 1024 // a child transcript beyond this is pathological — honest miss, never a hang

function findSubagentTranscript(fileName: string, projectsDirs: string[]): string | null {
  for (const dir of projectsDirs) {
    let projects: string[]
    try { projects = fs.readdirSync(dir) } catch { continue }
    for (const proj of projects) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(path.join(dir, proj), { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isDirectory()) continue // session dirs only — .jsonl siblings can never contain subagents/
        const candidate = path.join(dir, proj, e.name, 'subagents', fileName)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

interface SubagentStream { turns: ScannedTurn[]; note: string }

function resolveSubagentStream(
  sessionId: string,
  bySession: Map<string, ScannedTurn[]>,
  projectsDirs?: string[],
): SubagentStream | null {
  // Accept both the served card id (`agent-<agentId>`) and the bare agentId a spawn placeholder uses.
  const fileName = (sessionId.startsWith('agent-') ? sessionId : `agent-${sessionId}`) + '.jsonl'
  const transcript = findSubagentTranscript(fileName, projectsDirs ?? claudeProjectsDirs())
  if (!transcript) return null
  let raw: string
  try {
    if (fs.statSync(transcript).size > SUBAGENT_TRANSCRIPT_CAP) return null
    raw = fs.readFileSync(transcript, 'utf-8')
  } catch { return null }
  // The child's assistant message ids ARE its API response ids (verified byte-exact on real data).
  const ids = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.includes('"id":"msg_')) continue
    try {
      const e = JSON.parse(line) as { type?: string; message?: { id?: string } }
      if (e.type === 'assistant' && typeof e.message?.id === 'string' && e.message.id.startsWith('msg_')) ids.add(e.message.id)
    } catch { /* partial/foreign line — skip */ }
  }
  // The directory that CONTAINS subagents/ IS the parent session id (deterministic, no guessing —
  // the same linkage logReader uses to parent these transcripts at ingest).
  const parentSessionId = path.basename(path.dirname(path.dirname(transcript)))
  const parentTurns = bySession.get(parentSessionId)
  if (!parentTurns || ids.size === 0) return null
  // Chain membership: a request whose previous_message_id names one of the child's responses is
  // the child's NEXT call — that identifies every child turn except the stream head.
  const chained = parentTurns
    .filter(t => t.previousMessageId !== undefined && ids.has(t.previousMessageId))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (chained.length === 0) return null
  // Stream-head recovery: the child's FIRST request produced its first message id but carries no
  // chain link of its own. It shares the child conversation's first message block byte-for-byte
  // with the chained turns and, being a fresh stream, has NO previous_message_id — take the latest
  // such head before the first chained turn. (A fork child inherits the parent's history, so its
  // head DOES carry a previous id and is simply not recovered; the chain still covers every later
  // turn, and classifyTurns marks the earliest included turn COLD_START either way.)
  const head = chained[0]
  const headFp = head.prefix?.messageBlocks[0]?.fp
  let turns = chained
  if (headFp !== undefined) {
    const candidate = parentTurns
      .filter(t => t.previousMessageId === undefined && t.mtimeMs < head.mtimeMs && t.prefix?.messageBlocks[0]?.fp === headFp)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (candidate) turns = [candidate, ...chained]
  }
  return {
    turns,
    note: `Resolved '${sessionId}' as a sub-agent CHILD via its subagents transcript: ${turns.length} of ` +
      `parent ${parentSessionId}'s ${parentTurns.length} scanned turn(s) belong to this child ` +
      `(${ids.size} child response id(s) harvested from the transcript).`,
  }
}

/** Build a session's cache-break ROOT-CAUSE timeline + repeat-offender rollup. Reconstructs the
 *  session's ordered turns from the raw OTEL bodies, classifies each significant cache_creation turn's
 *  break, and rolls repeated (cause, culprit-element) pairs into chronic offenders (flagged SYSTEMATIC
 *  at ≥ threshold turns). `agent-<agentId>` child sessions resolve via their subagents transcript (see
 *  resolveSubagentStream). LAZY + BOUNDED: one recency-first capped scan; honest coverage. */
export async function buildCacheBreakTimeline(opts: CacheBreakTimelineOptions = {}): Promise<CacheBreakTimelineReport> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const dirExists = fs.existsSync(bodiesDir)
  const emptyCoverage = (note: string) => ({
    bodiesDir, dirExists, requestFilesTotal: 0, requestFilesScanned: 0, responseFilesTotal: 0,
    responseFilesScanned: 0, sessionsFound: 0, scanCap, windowHours: opts.windowHours, complete: true, note,
  })
  if (!dirExists) {
    return baseReport(minTokens, emptyCoverage(`No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`))
  }

  const { bySession, respById, coverage } = scanSessionsAndResponses(bodiesDir, opts.windowHours, scanCap)

  // Resolve the target session: exact sessionId > scope-prefix heaviest > overall heaviest by cache_creation.
  const target = resolveTarget(bySession, respById, opts)
  if (target) {
    return buildReportForSession(target.sid, target.turns, respById, minTokens, coverage, opts.topN)
  }
  if (opts.sessionId) {
    // Not a metadata session id — try the sub-agent child path before giving up (2026-07-11 fix).
    const sub = resolveSubagentStream(opts.sessionId, bySession, opts.projectsDirs)
    if (sub) {
      return buildReportForSession(opts.sessionId, sub.turns, respById, minTokens,
        { ...coverage, note: `${coverage.note} ${sub.note}` }, opts.topN)
    }
    if (opts.sessionId.startsWith('agent-')) {
      return baseReport(minTokens, {
        ...coverage,
        note: `${coverage.note} '${opts.sessionId}' looks like a sub-agent child id, but no subagents ` +
          `transcript (or no scanned parent turn) matched it — child timelines resolve via ` +
          `<projects>/<mangled>/<parentSessionId>/subagents/${opts.sessionId}.jsonl plus the parent's raw bodies.`,
      })
    }
  }
  return baseReport(minTokens, coverage)
}

function baseReport(minTokens: number, coverage: CacheBreakTimelineReport['coverage']): CacheBreakTimelineReport {
  return {
    minTokens, systematicThreshold: SYSTEMATIC_THRESHOLD, turnsInSession: 0, turnsClassified: 0,
    totalCacheCreateTokens: 0, events: [], causeHistogram: [], repeatOffenders: [], coverage,
  }
}

// The cache_creation billed on turn i is read from turn i's RESPONSE, whose id == turn i+1's
// previous_message_id (the proven chain link). Returns 0 for the last turn (no following request).
function ccOfTurn(turns: ScannedTurn[], i: number, respById: Map<string, ResponseUsage>): ResponseUsage | undefined {
  const next = turns[i + 1]
  const respId = next?.previousMessageId
  return respId ? respById.get(respId) : undefined
}

function sessionCacheCreate(turns: ScannedTurn[], respById: Map<string, ResponseUsage>): number {
  let sum = 0
  for (let i = 0; i < turns.length; i++) sum += ccOfTurn(turns, i, respById)?.cacheCreate ?? 0
  return sum
}

function resolveTarget(
  bySession: Map<string, ScannedTurn[]>,
  respById: Map<string, ResponseUsage>,
  opts: CacheBreakTimelineOptions,
): { sid: string; turns: ScannedTurn[] } | null {
  const sort = (turns: ScannedTurn[]) => [...turns].sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (opts.sessionId) {
    const t = bySession.get(opts.sessionId)
    return t ? { sid: opts.sessionId, turns: sort(t) } : null
  }
  const candidates = [...bySession.entries()].filter(([sid]) => sid !== '(no-session)' && (!opts.scope || sid.startsWith(opts.scope)))
  if (candidates.length === 0) return null
  let best: { sid: string; turns: ScannedTurn[]; cc: number } | null = null
  for (const [sid, turns] of candidates) {
    const cc = sessionCacheCreate(turns, respById)
    if (!best || cc > best.cc) best = { sid, turns: sort(turns), cc }
  }
  return best ? { sid: best.sid, turns: best.turns } : null
}

// Classify every significant cache_creation turn of ONE session into a break event. Shared by the
// single-session timeline AND the cross-session cause aggregator so the classification lives in one place.
function classifyTurns(turns: ScannedTurn[], respById: Map<string, ResponseUsage>, minTokens: number): CacheBreakEvent[] {
  const events: CacheBreakEvent[] = []
  for (let i = 0; i < turns.length; i++) {
    const usage = ccOfTurn(turns, i, respById)
    if (!usage || usage.cacheCreate < minTokens) continue
    const prevPrefix = i > 0 ? turns[i - 1].prefix : null
    const prev2Prefix = i > 1 ? turns[i - 2].prefix : null   // for the A→B→A interleave signature
    const curPrefix = turns[i].prefix
    if (!curPrefix) continue
    const gapMs = i > 0 ? turns[i].mtimeMs - turns[i - 1].mtimeMs : undefined
    const verdict = classifyCacheBreak(prevPrefix, curPrefix, {
      gapMs, cacheReadTokens: usage.cacheRead, cacheCreateTokens: usage.cacheCreate,
      ephemeral5mTokens: usage.ephemeral5m, ephemeral1hTokens: usage.ephemeral1h,
    }, prev2Prefix)
    const evModel = usage.model ?? curPrefix.model
    events.push({
      turn: i + 1,
      ts: new Date(turns[i].mtimeMs).toISOString(),
      cause: verdict.cause,
      culpritLayer: verdict.culpritLayer,
      culpritId: verdict.culpritId,
      culprit: verdict.culpritSummary,
      cacheCreateTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: evModel ? +calcTokenCostUsd(0, 0, usage.cacheCreate, 0, evModel).toFixed(4) : 0,
      gapMinutes: gapMs !== undefined ? +(gapMs / 60000).toFixed(1) : undefined,
      ttlTier: verdict.ttlTier,
      model: evModel,
      remediation: REMEDIATION[verdict.cause],
      rawDiffSummary: verdict.rawDiffSummary,
    })
  }
  return events
}

function buildReportForSession(
  sid: string,
  turns: ScannedTurn[],
  respById: Map<string, ResponseUsage>,
  minTokens: number,
  coverage: CacheBreakTimelineReport['coverage'],
  topN?: number,
): CacheBreakTimelineReport {
  const sessionCC = sessionCacheCreate(turns, respById)
  const events = classifyTurns(turns, respById, minTokens)
  const accountUuid = turns.find(t => t.accountUuid)?.accountUuid
  const model = events.find(e => e.model)?.model

  // Bound the returned `events` log to the most recent topN — histogram/repeatOffenders below are built
  // from the FULL `events` first (unaffected by this truncation), so the aggregate picture stays exact
  // even when the raw per-turn log is capped for a lean default payload.
  const cap = Math.min(Math.max(1, topN ?? DEFAULT_EVENTS_TOPN), MAX_EVENTS_TOPN)
  const shownEvents = events.length > cap ? events.slice(-cap) : events

  return {
    sessionId: sid, accountUuid, model,
    minTokens, systematicThreshold: SYSTEMATIC_THRESHOLD,
    turnsInSession: turns.length, turnsClassified: events.length,
    totalCacheCreateTokens: events.reduce((n, e) => n + e.cacheCreateTokens, 0),
    events: shownEvents,
    eventsNote: events.length > cap
      ? `Showing the most recent ${shownEvents.length} of ${events.length} classified break events (raise topN to see more, max ${MAX_EVENTS_TOPN}). repeatOffenders/causeHistogram below already summarize ALL ${events.length}.`
      : undefined,
    causeHistogram: buildHistogram(events),
    repeatOffenders: buildRepeatOffenders(events, sessionCC),
    coverage,
  }
}

function buildHistogram(events: CacheBreakEvent[]): CacheBreakTimelineReport['causeHistogram'] {
  const m = new Map<CacheBreakTimelineCause, { events: number; cacheCreateTokens: number }>()
  for (const e of events) {
    const g = m.get(e.cause) ?? { events: 0, cacheCreateTokens: 0 }
    g.events += 1; g.cacheCreateTokens += e.cacheCreateTokens
    m.set(e.cause, g)
  }
  return [...m.entries()].map(([cause, v]) => ({ cause, ...v })).sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)
}

// The CHRONIC-OFFENDER rollup (the point of the tool): group break events by (cause, culprit element
// identity) — NOT just cause — so two breaks from the SAME element are ONE recurring offender. Rank by
// recurrence × wasted tokens; flag ≥ SYSTEMATIC_THRESHOLD-turn recurrences as SYSTEMATIC with a
// plain-language verdict naming the exact element + its fix.
function buildRepeatOffenders(events: CacheBreakEvent[], sessionCacheCreate: number): RepeatOffender[] {
  interface Acc { cause: CacheBreakTimelineCause; culpritId: string; culprit: string; tokens: number[]; cost: number; first: number; last: number }
  const byKey = new Map<string, Acc>()
  for (const e of events) {
    const key = `${e.cause}::${e.culpritId}`
    const a = byKey.get(key) ?? { cause: e.cause, culpritId: e.culpritId, culprit: e.culprit, tokens: [], cost: 0, first: e.turn, last: e.turn }
    a.tokens.push(e.cacheCreateTokens)
    a.cost += e.costUsd
    a.first = Math.min(a.first, e.turn)
    a.last = Math.max(a.last, e.turn)
    byKey.set(key, a)
  }
  const rows: RepeatOffender[] = [...byKey.values()].map(a => {
    const total = a.tokens.reduce((n, t) => n + t, 0)
    const occurrences = a.tokens.length
    const systematic = occurrences >= SYSTEMATIC_THRESHOLD
    return {
      cause: a.cause, culpritId: a.culpritId, culprit: a.culprit,
      occurrences, totalCacheCreateTokens: total, medianCacheCreateTokens: median(a.tokens),
      totalCostUsd: +a.cost.toFixed(4),
      pctOfSessionCacheCreate: sessionCacheCreate > 0 ? +(100 * total / sessionCacheCreate).toFixed(1) : 0,
      firstTurn: a.first, lastTurn: a.last, systematic,
      verdict: (systematic ? `SYSTEMATIC — ` : '') + `${a.cause}: ${a.culprit} broke the cache on ${occurrences} turn(s) (${total.toLocaleString()} cache_creation tokens). ${REMEDIATION[a.cause]}`,
    }
  })
  // Rank by recurrence × wasted tokens (the chronic + costly first).
  return rows.sort((a, b) =>
    (b.occurrences * b.totalCacheCreateTokens) - (a.occurrences * a.totalCacheCreateTokens)
    || b.totalCacheCreateTokens - a.totalCacheCreateTokens)
}

// ── buildCauseCostPeakReport — the 'cause' dimension of the cost-peak finder ──────
// TRDD-6TQ2FBUR D2: get_cache_creation_report generalizes into a COST-PEAK finder with
// groupBy {session|account|model|cause}. The first three stay in buildCacheCreationReport
// (cacheCreationForensics.ts, a lightweight response-only scan); 'cause' needs the full prefix-diff
// classifier this module owns, so it lives here as a SEPARATE builder returning the identical
// CacheCreationReport shape — the MCP tool dispatches on groupBy and formats either result with the
// SAME formatCostPeaks, so callers see one uniform contract regardless of which builder ran.
export interface CauseCostPeakOptions {
  bodiesDir?: string
  windowHours?: number
  scanCap?: number
  minTokens?: number         // floor: only classify turns whose cache_creation >= this (default DEFAULT_MIN_TOKENS)
  bucket?: CostBucket
  topN?: number
}

function emptyCauseCostPeakReport(bucket: CostBucket, bodiesDir: string, scanCap: number, windowHours?: number): CacheCreationReport {
  return {
    bucket, groupBy: 'cause', windowHours,
    totalCacheCreateTokens: 0, totalCacheReadTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
    unattributed: { events: 0, cacheCreateTokens: 0, costUsd: 0, note: 'groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session.' },
    outputSpikes: { note: 'The biggest single OUTPUT-token break events (output is billed ~5x — sometimes the real cost peak, not the cache write).', top: [] },
    groups: [],
    coverage: {
      bodiesDir, dirExists: false, responseFilesTotal: 0, responseFilesScanned: 0,
      requestFilesTotal: 0, requestFilesIndexed: 0, scanCap, windowHours, complete: true,
      note: `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`,
    },
  }
}

/** The 'cause' dimension of the cost-peak finder: scans EVERY session in the bounded window (not just
 *  one target, unlike buildCacheBreakTimeline), classifies each session's significant cache_creation
 *  turns via the SAME root-cause classifier the timeline uses, and ranks CAUSES by the chosen cost
 *  bucket {cache_creation|output|input|total|billable_weighted} — answering "which BREAK CAUSE is
 *  burning the most money", not just "which session/account/model". LAZY + BOUNDED: one shared scan
 *  (scanSessionsAndResponses); classification cost is O(turns already read), not an extra disk pass. */
export async function buildCauseCostPeakReport(opts: CauseCostPeakOptions = {}): Promise<CacheCreationReport> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const bucket = opts.bucket ?? 'cache_creation'
  const topN = Math.min(opts.topN ?? 15, 50)
  if (!fs.existsSync(bodiesDir)) {
    return emptyCauseCostPeakReport(bucket, bodiesDir, scanCap, opts.windowHours)
  }

  const { bySession, respById, coverage: timelineCoverage } = scanSessionsAndResponses(bodiesDir, opts.windowHours, scanCap)
  // Adapt the timeline scan's coverage shape (sessionsFound/requestFilesScanned) into the cost-peak
  // finder's CacheCreationScanCoverage shape (responseFilesScanned/requestFilesIndexed) — same numbers,
  // different field names — so get_cache_creation_report's coverage contract is identical regardless
  // of which builder produced the report.
  const coverage: CacheCreationScanCoverage = {
    bodiesDir: timelineCoverage.bodiesDir, dirExists: timelineCoverage.dirExists,
    responseFilesTotal: timelineCoverage.responseFilesTotal, responseFilesScanned: timelineCoverage.responseFilesScanned,
    requestFilesTotal: timelineCoverage.requestFilesTotal, requestFilesIndexed: timelineCoverage.requestFilesScanned,
    scanCap: timelineCoverage.scanCap, windowHours: timelineCoverage.windowHours,
    complete: timelineCoverage.complete, note: timelineCoverage.note,
  }

  const groups = new Map<CacheBreakTimelineCause, CacheCreationGroupRow>()
  let totalCC = 0, totalCR = 0, totalIn = 0, totalOut = 0, totalCost = 0
  const outputEvents: OutputSpike[] = []

  for (const [sid, turnsRaw] of bySession) {
    if (sid === '(no-session)') continue
    const turns = [...turnsRaw].sort((a, b) => a.mtimeMs - b.mtimeMs)
    const accountUuid = turns.find(t => t.accountUuid)?.accountUuid
    for (const e of classifyTurns(turns, respById, minTokens)) {
      const t: TokenCounts = { inputTokens: e.inputTokens, cacheReadTokens: e.cacheReadTokens, cacheCreateTokens: e.cacheCreateTokens, outputTokens: e.outputTokens, model: e.model }
      const fullCost = tokenCountsFullCost(t)
      totalCC += e.cacheCreateTokens; totalCR += e.cacheReadTokens; totalIn += e.inputTokens; totalOut += e.outputTokens; totalCost += fullCost

      const g = groups.get(e.cause) ?? {
        key: e.cause, cacheCreateTokens: 0, cacheReadTokens: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        costUsd: 0, events: 0, maxSingleCacheCreateTokens: 0, maxSingleOutputTokens: 0, bucketValue: 0,
      }
      g.cacheCreateTokens += e.cacheCreateTokens
      g.cacheReadTokens += e.cacheReadTokens
      g.inputTokens += e.inputTokens
      g.outputTokens += e.outputTokens
      g.totalTokens += tokenCountsTotal(t)
      g.costUsd += fullCost
      g.events += 1
      g.maxSingleCacheCreateTokens = Math.max(g.maxSingleCacheCreateTokens, e.cacheCreateTokens)
      g.maxSingleOutputTokens = Math.max(g.maxSingleOutputTokens, e.outputTokens)
      g.bucketValue += bucketValueOf(t, bucket)
      groups.set(e.cause, g)

      if (e.outputTokens > 0) {
        outputEvents.push({ sessionId: sid, accountUuid, model: e.model, outputTokens: e.outputTokens, cacheCreateTokens: e.cacheCreateTokens, ts: e.ts })
      }
    }
  }

  const ranked = [...groups.values()]
    .map(g => ({ ...g, costUsd: +g.costUsd.toFixed(4), bucketValue: +g.bucketValue.toFixed(4) }))
    .sort((a, b) => b.bucketValue - a.bucketValue)

  const outputTop = [...outputEvents].sort((a, b) => b.outputTokens - a.outputTokens).slice(0, 5)

  return {
    bucket, groupBy: 'cause', windowHours: opts.windowHours,
    totalCacheCreateTokens: totalCC, totalCacheReadTokens: totalCR, totalInputTokens: totalIn, totalOutputTokens: totalOut,
    totalCostUsd: +totalCost.toFixed(4),
    unattributed: {
      events: 0, cacheCreateTokens: 0, costUsd: 0,
      note: 'groupBy=cause has no unattributed bucket — every classified turn already belongs to a known session (an un-joinable response is simply not part of any session\'s turn sequence, so it is never classified).',
    },
    outputSpikes: {
      note: 'The biggest single OUTPUT-token break events (output is billed ~5x the input rate — sometimes the real cost peak, not the cache write). Rank by bucket=output or bucket=billable_weighted to surface these in the groups.',
      top: outputTop,
    },
    groups: ranked.slice(0, topN),
    coverage,
  }
}

// ── Cross-session cause + actor backtrace (get_cache_break_causes) ────────────────
// The user's two-step forensic question, answered across ALL sessions at once: (1) which BREAK CAUSE is
// the most common / most expensive (the causeRanking) — and then (2) backtrace each break to the actual
// PERPETRATOR (the actorLeaderboard, keyed on the enriched culpritId = the MCP server / hook / sub-agent
// model / harness ToolSearch that CAUSED the tools/system/model change). The transcript is only ever the
// victim; this report names who keeps breaking it, ranked, across the whole bounded scan.
export interface CacheBreakCauseRow {
  cause: CacheBreakTimelineCause
  expected: boolean           // true = expected cache behavior (cold warm / compaction / growth / interleave artifact), not a misconfiguration
  events: number
  sessionsAffected: number
  cacheCreateTokens: number
  pct: number                 // % of total classified cache_creation
  remediation: string
}
export interface CacheBreakActorRow {
  actorId: string             // the enriched culpritId = the stable perpetrator identity
  cause: CacheBreakTimelineCause
  expected: boolean           // mirrors EXPECTED_CAUSES — the verdict ranks only the avoidable actors
  actor: string               // human-readable "who" (pointer-only)
  occurrences: number         // break turns caused by this actor
  sessionsAffected: number
  totalCacheCreateTokens: number
  totalCostUsd: number
  pct: number                 // % of total classified cache_creation
  remediation: string
}
export interface CacheBreakCausesReport {
  minTokens: number
  totalClassifiedEvents: number
  totalCacheCreateTokens: number
  causeRanking: CacheBreakCauseRow[]
  actorLeaderboard: CacheBreakActorRow[]
  verdict: string             // one-line plain-language "the dominant perpetrator is X"
  coverage: CacheBreakTimelineReport['coverage']
}

export interface CacheBreakCausesOptions {
  bodiesDir?: string
  windowHours?: number
  scanCap?: number
  minTokens?: number
  scope?: string              // optional session-id prefix filter
  topN?: number               // cap on the actorLeaderboard (default 20, max 100)
}

/** Cross-session cause ranking + perpetrator backtrace. Scans EVERY session in the bounded window,
 *  classifies each significant cache_creation turn via the SAME root-cause classifier, and returns both
 *  (1) the causes ranked by wasted cache_creation and (2) the actor leaderboard — grouped on the
 *  enriched culpritId, so "MCP server chrome-devtools" / "hook: pss-skills" / "harness ToolSearch" /
 *  "model claude-sonnet-5" surface as chronic perpetrators. LAZY + BOUNDED: one shared scan. */
export async function buildCacheBreakCauses(opts: CacheBreakCausesOptions = {}): Promise<CacheBreakCausesReport> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const scanCap = opts.scanCap ?? RESPONSE_SCAN_CAP
  const topN = Math.min(Math.max(1, opts.topN ?? 20), 100)
  const dirExists = fs.existsSync(bodiesDir)
  const emptyCoverage = (note: string): CacheBreakTimelineReport['coverage'] => ({
    bodiesDir, dirExists, requestFilesTotal: 0, requestFilesScanned: 0, responseFilesTotal: 0,
    responseFilesScanned: 0, sessionsFound: 0, scanCap, windowHours: opts.windowHours, complete: true, note,
  })
  if (!dirExists) {
    return { minTokens, totalClassifiedEvents: 0, totalCacheCreateTokens: 0, causeRanking: [], actorLeaderboard: [], verdict: 'no data', coverage: emptyCoverage(`No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`) }
  }

  const { bySession, respById, coverage } = scanSessionsAndResponses(bodiesDir, opts.windowHours, scanCap)

  interface CauseAcc { events: number; cc: number; sessions: Set<string> }
  interface ActorAcc { cause: CacheBreakTimelineCause; actor: string; occ: number; cc: number; cost: number; sessions: Set<string> }
  const causeMap = new Map<CacheBreakTimelineCause, CauseAcc>()
  const actorMap = new Map<string, ActorAcc>()
  let total = 0, totalEvents = 0

  for (const [sid, turnsRaw] of bySession) {
    if (sid === '(no-session)') continue
    if (opts.scope && !sid.startsWith(opts.scope)) continue
    const turns = [...turnsRaw].sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const e of classifyTurns(turns, respById, minTokens)) {
      total += e.cacheCreateTokens; totalEvents += 1
      const c = causeMap.get(e.cause) ?? { events: 0, cc: 0, sessions: new Set<string>() }
      c.events += 1; c.cc += e.cacheCreateTokens; c.sessions.add(sid); causeMap.set(e.cause, c)
      const a = actorMap.get(e.culpritId) ?? { cause: e.cause, actor: e.culprit, occ: 0, cc: 0, cost: 0, sessions: new Set<string>() }
      a.occ += 1; a.cc += e.cacheCreateTokens; a.cost += e.costUsd; a.sessions.add(sid); actorMap.set(e.culpritId, a)
    }
  }

  const pct = (n: number) => total > 0 ? +(100 * n / total).toFixed(1) : 0
  const causeRanking: CacheBreakCauseRow[] = [...causeMap.entries()]
    .map(([cause, v]) => ({ cause, expected: EXPECTED_CAUSES.has(cause), events: v.events, sessionsAffected: v.sessions.size, cacheCreateTokens: v.cc, pct: pct(v.cc), remediation: REMEDIATION[cause] }))
    .sort((a, b) => b.cacheCreateTokens - a.cacheCreateTokens)
  const actorLeaderboard: CacheBreakActorRow[] = [...actorMap.entries()]
    .map(([actorId, v]) => ({ actorId, cause: v.cause, expected: EXPECTED_CAUSES.has(v.cause), actor: v.actor, occurrences: v.occ, sessionsAffected: v.sessions.size, totalCacheCreateTokens: v.cc, totalCostUsd: +v.cost.toFixed(4), pct: pct(v.cc), remediation: REMEDIATION[v.cause] }))
    .sort((a, b) => b.totalCacheCreateTokens - a.totalCacheCreateTokens)
    .slice(0, topN)

  // The verdict names the top AVOIDABLE perpetrator — ranking by raw tokens alone crowns COLD_START /
  // NORMAL_GROWTH (expected behavior, unactionable) and buries the actual misconfiguration.
  const top = actorLeaderboard[0]
  const topAvoidable = actorLeaderboard.find(a => !a.expected)
  let verdict: string
  if (!top) {
    verdict = 'No significant cache_creation breaks classified in the scanned window.'
  } else if (!topAvoidable) {
    verdict = `All classified break cost is EXPECTED cache behavior (cold warms / compaction / incremental growth / interleave) — no avoidable perpetrator found. Largest: ${top.actor} (${top.cause}) at ${top.pct}%.`
  } else {
    const overallNote = topAvoidable.actorId !== top.actorId
      ? ` (Largest overall is ${top.actor} (${top.cause}) at ${top.pct}%, but that cause is expected/unavoidable.)`
      : ''
    verdict = `Dominant AVOIDABLE perpetrator: ${topAvoidable.actor} (${topAvoidable.cause}) — ${topAvoidable.totalCacheCreateTokens.toLocaleString()} cache_creation tokens across ${topAvoidable.sessionsAffected} session(s), ${topAvoidable.pct}% of all classified breaks. ${topAvoidable.remediation}${overallNote}`
  }

  return { minTokens, totalClassifiedEvents: totalEvents, totalCacheCreateTokens: total, causeRanking, actorLeaderboard, verdict, coverage }
}

// ── Output formatting ────────────────────────────────────────────────────────────
export type TimelineFormat = 'json' | 'table' | 'markdown' | 'timeline'

/** Render a timeline report in the requested format. json → the object itself; the others → a compact
 *  string wrapped as { format, text } so the MCP result stays JSON-serializable. */
export function formatTimeline(report: CacheBreakTimelineReport, format: TimelineFormat): unknown {
  if (format === 'json') return report
  const lines: string[] = []
  const hdr = `cache-break timeline — session ${report.sessionId ?? '(none)'}${report.model ? ` [${report.model}]` : ''}`
  if (format === 'markdown') {
    lines.push(`# ${hdr}`)
    lines.push('', `- turns: ${report.turnsInSession}, classified breaks: ${report.turnsClassified}, total cache_creation: ${report.totalCacheCreateTokens.toLocaleString()}`, '')
    lines.push('## Repeat offenders (chronic first)', '')
    lines.push('| cause | culprit | turns | tokens | % | systematic |', '|---|---|---|---|---|---|')
    for (const o of report.repeatOffenders) lines.push(`| ${o.cause} | ${o.culprit} | ${o.occurrences} | ${o.totalCacheCreateTokens.toLocaleString()} | ${o.pctOfSessionCacheCreate}% | ${o.systematic ? '⚠️ YES' : ''} |`)
    lines.push('', '## Timeline', '')
    for (const e of report.events) lines.push(`- turn ${e.turn} \`${e.ts}\` **${e.cause}** — ${e.culprit} (${e.cacheCreateTokens.toLocaleString()} tok${e.gapMinutes !== undefined ? `, +${e.gapMinutes}m` : ''})`)
  } else if (format === 'table') {
    lines.push(hdr)
    lines.push('turn  cause                       tokens      gap    culprit')
    for (const e of report.events) lines.push(`${String(e.turn).padStart(4)}  ${e.cause.padEnd(26)} ${String(e.cacheCreateTokens).padStart(9)}  ${(e.gapMinutes !== undefined ? e.gapMinutes + 'm' : '-').padStart(6)}  ${e.culprit}`)
    lines.push('', 'REPEAT OFFENDERS:')
    for (const o of report.repeatOffenders) lines.push(`  ${o.systematic ? '⚠️ ' : '  '}${o.cause} ×${o.occurrences} (${o.totalCacheCreateTokens} tok, ${o.pctOfSessionCacheCreate}%) — ${o.culprit}`)
  } else { // timeline
    lines.push(hdr)
    for (const e of report.events) {
      const bar = e.cause.startsWith('TOOL') ? '🔧' : e.cause === 'MODEL_SWITCH' ? '🔀' : e.cause === 'TTL_EXPIRY' ? '⏱️' : e.cause === 'COLD_START' ? '❄️' : e.cause.includes('SKILL') ? '📎' : e.cause === 'HOOK_INJECTION' ? '🪝' : '⚠️'
      lines.push(`${e.ts}  ${bar} turn ${e.turn}  ${e.cause}  ${e.cacheCreateTokens.toLocaleString()} tok — ${e.culprit}`)
    }
    const worst = report.repeatOffenders.find(o => o.systematic)
    if (worst) lines.push('', `VERDICT: ${worst.verdict}`)
  }
  if (report.eventsNote) lines.push('', report.eventsNote)
  return { format, text: lines.join('\n'), sessionId: report.sessionId, coverage: report.coverage }
}
