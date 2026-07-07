import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { claudeProjectsDirs } from './logReader'
import type {
  ContextHistory, ContextHistoryStep, ContextBlock, ContextBlockKind, StepDiff,
} from './summarizers/summarizerTypes'

// Hard caps so an on-demand parse of a huge session never blocks the host unbounded. A session past
// MAX_LINES is reported truncated=true (the reconstruction covers what was read). Only the first
// MAX_STEPS assistant turns are returned; each step keeps at most MAX_BLOCKS_PER_STEP blocks (the
// remainder folds into one "other" block). Any single block's text is capped at BLOCK_TEXT_CAP so the
// payload stays bounded even when a step injected megabytes of file/tool content.
const MAX_LINES = 3_000_000
const MAX_STEPS = 2000
const MAX_BLOCKS_PER_STEP = 200
const BLOCK_TEXT_CAP = 20_000

// TODO(R-G): replace with a real tokenizer — this is the same bytes/4 estimate the rest of the
// context tracer uses. Every figure built here is surfaced as an estimate (estimated: true).
function approxTokens(bytes: number): number { return Math.ceil(bytes / 4) }

function utf8Len(v: unknown): number { return typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 0 }

function sumFields(obj: Record<string, unknown>, keys: string[]): number {
  let n = 0
  for (const k of keys) n += utf8Len(obj[k])
  return n
}

function firstText(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) { const v = obj[k]; if (typeof v === 'string' && v.length > 0) return v }
  return ''
}

function joinedText(v: unknown): string {
  if (Array.isArray(v)) return v.filter(s => typeof s === 'string').join('\n')
  return typeof v === 'string' ? v : ''
}

function joinedLen(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((n: number, s) => n + utf8Len(s), 0)
  return utf8Len(v)
}

// Locate the .jsonl for a sessionId across all Claude project dirs (filename == sessionId). Copied
// from contextComposition.ts (not exported there) so this module resolves session files identically.
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

// Classify one `attachment` entry into a (label, kind, bytes, text). Copied from contextComposition.ts
// so the injected-content taxonomy is identical; the kind returned here is mapped to a ContextBlockKind
// by the caller. Returns null for attachment shapes that carry no meaningful injected content.
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

// Map classifyAttachment's kind string onto a ContextBlockKind for the block taxonomy.
function attachmentKind(kind: string): ContextBlockKind {
  switch (kind) {
    case 'hook': return 'hook'
    case 'skill': return 'skillPrompt'
    case 'toolCatalog': return 'toolCatalog'
    case 'agentCatalog': return 'agentCatalog'
    case 'mcp': return 'mcp'
    case 'file': return 'file'
    case 'reminder': return 'reminder'
    default: return 'other'
  }
}

// Extract the FULL text of a message/tool_result content value (string, or an array of blocks whose
// text elements are concatenated). No truncation here — the per-block cap is applied at add time.
function fullText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
      else if (typeof block['content'] === 'string') parts.push(block['content'])
    }
    return parts.join('\n')
  }
  return ''
}

// A tiny FNV-1a string hash (no imports) used only to detect that a block's text CHANGED between two
// steps. Collisions are irrelevant here — a false "unchanged" on a real change is astronomically
// unlikely and the diff is an advisory overlay, not a correctness gate.
function hashText(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

interface BlockAcc { id: string; kind: ContextBlockKind; label: string; text: string; bytes: number; role: 'input' | 'output'; toolName?: string }
interface StepAcc {
  turn: number
  timestamp?: string
  model?: string
  usage?: { input: number; output: number; cacheRead: number; cacheCreate: number }
  blocks: Map<string, BlockAcc>   // insertion-ordered; keyed by block id so same-id occurrences merge
}

/**
 * Reconstruct the per-STEP context history of a Claude session from its raw .jsonl, on demand.
 * Streams the file (never loads it whole), groups every context block by the assistant turn it
 * belongs to (input-side blocks — user messages, attachments, tool results — attribute to the UPCOMING
 * assistant turn; output-side blocks — the assistant's text/thinking/tool_use — to that same turn),
 * computes a per-block token estimate + taxonomy, and diffs each step against the previous one.
 *
 * NO-OWN-LOG FALLBACK: mirrors buildContextComposition — a fork / sub-agent with no `<sessionId>.jsonl`
 * is reconstructed from its PARENT's log (marked reconstructedFrom). With neither own- nor parent-log
 * but a known parent, an HONEST empty history is returned (still tagged reconstructedFrom) so the UI
 * shows a terminal parent-link message instead of spinning. Only the pure OTEL/no-parent case → null.
 */
export async function buildContextHistory(sessionId: string, parentSessionId?: string): Promise<ContextHistory | null> {
  let file = findSessionFile(sessionId)
  let reconstructedFrom: string | undefined
  if (!file && parentSessionId) {
    const parentFile = findSessionFile(parentSessionId)
    if (parentFile) { file = parentFile; reconstructedFrom = parentSessionId }
  }
  if (!file) {
    if (parentSessionId) return { sessionId, steps: [], estimated: true, truncated: false, reconstructedFrom: parentSessionId }
    return null
  }

  const steps = new Map<number, StepAcc>()
  const seenMessageIds = new Set<string>()
  const toolUseIdToName = new Map<string, string>()  // tool_use id → tool name (for tool_result kind)
  const taskToolUseIds = new Set<string>()           // ids whose tool_use was Task/Agent/Workflow
  let assistantTurns = 0
  let lines = 0
  let truncated = false

  function getStep(turn: number): StepAcc {
    let s = steps.get(turn)
    if (!s) { s = { turn, blocks: new Map() }; steps.set(turn, s) }
    return s
  }

  // Add a block to a step, merging same-id occurrences (bytes sum uncapped; text concatenated up to
  // BLOCK_TEXT_CAP so identity stays stable while the payload stays bounded).
  function addBlock(turn: number, kind: ContextBlockKind, label: string, rawText: string, role: 'input' | 'output', toolName?: string): void {
    const id = `${kind}:${label}`
    const bytes = utf8Len(rawText)
    const step = getStep(turn)
    const existing = step.blocks.get(id)
    if (existing) {
      existing.bytes += bytes
      if (existing.text.length < BLOCK_TEXT_CAP && rawText) {
        existing.text = (existing.text ? existing.text + '\n' + rawText : rawText).slice(0, BLOCK_TEXT_CAP)
      }
    } else {
      step.blocks.set(id, { id, kind, label, text: rawText.slice(0, BLOCK_TEXT_CAP), bytes, role, toolName })
    }
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (++lines > MAX_LINES) { truncated = true; break }
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    const type = e['type']
    const ts = typeof e['timestamp'] === 'string' ? (e['timestamp'] as string) : undefined

    if (type === 'assistant') {
      const msg = e['message'] as Record<string, unknown> | undefined
      const id = msg?.['id'] as string | undefined
      const isNew = !id || !seenMessageIds.has(id)
      if (isNew) { assistantTurns++; if (id) seenMessageIds.add(id) }
      const turn = assistantTurns
      const step = getStep(turn)
      if (isNew) {
        if (ts && !step.timestamp) step.timestamp = ts
        const rowModel = msg?.['model'] as string | undefined
        if (rowModel && rowModel !== '<synthetic>' && !step.model) step.model = rowModel
        const usage = msg?.['usage'] as Record<string, number> | undefined
        if (usage && !step.usage) {
          step.usage = {
            input: usage['input_tokens'] ?? 0,
            output: usage['output_tokens'] ?? 0,
            cacheRead: usage['cache_read_input_tokens'] ?? 0,
            cacheCreate: usage['cache_creation_input_tokens'] ?? 0,
          }
        }
      }
      const content = (msg?.['content'] as Array<Record<string, unknown>>) ?? []
      for (const block of content) {
        const bt = block['type']
        if (bt === 'text' && typeof block['text'] === 'string') {
          addBlock(turn, 'assistantMsg', 'assistant', block['text'] as string, 'output')
        } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
          addBlock(turn, 'reasoning', 'thinking', block['thinking'] as string, 'output')
        } else if (bt === 'tool_use' && block['name']) {
          const name = String(block['name'])
          const bid = block['id'] as string | undefined
          if (bid) { toolUseIdToName.set(bid, name); if (name === 'Task' || name === 'Agent' || name === 'Workflow') taskToolUseIds.add(bid) }
          const input = (block['input'] ?? {}) as Record<string, unknown>
          if (name === 'Bash') {
            const cmd = typeof input['command'] === 'string' ? (input['command'] as string) : JSON.stringify(input)
            addBlock(turn, 'bashInput', 'Bash', cmd, 'output', 'Bash')
          } else {
            addBlock(turn, 'toolInput', name, JSON.stringify(input), 'output', name)
          }
        }
      }
      continue
    }

    if (type === 'user') {
      // Input-side content feeds the UPCOMING assistant turn (assistantTurns + 1), matching the
      // context-composition attribution and the timeline's user_input turn.
      const turn = assistantTurns + 1
      // A compaction summary carried on a meta/compact record → one postCompact block.
      if (e['isCompactSummary'] === true || e['isMeta'] === true) {
        const msg = e['message'] as Record<string, unknown> | undefined
        const summary = typeof e['summary'] === 'string' ? (e['summary'] as string) : fullText(msg?.['content'])
        if (summary) { addBlock(turn, 'postCompact', 'compact summary', summary, 'input'); continue }
      }
      const msg = e['message'] as Record<string, unknown> | undefined
      const content = msg?.['content']
      if (typeof content === 'string') {
        const kind: ContextBlockKind = content.includes('<system-reminder>') ? 'harness' : 'userMsg'
        addBlock(turn, kind, kind === 'harness' ? 'system-reminder' : 'user', content, 'input')
      } else if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          const bt = block['type']
          if (bt === 'text' && typeof block['text'] === 'string') {
            const txt = block['text'] as string
            const kind: ContextBlockKind = txt.includes('<system-reminder>') ? 'harness' : 'userMsg'
            addBlock(turn, kind, kind === 'harness' ? 'system-reminder' : 'user', txt, 'input')
          } else if (bt === 'tool_result') {
            const id = block['tool_use_id'] as string | undefined
            const toolName = id ? toolUseIdToName.get(id) : undefined
            const text = fullText(block['content'])
            if (id && taskToolUseIds.has(id)) {
              addBlock(turn, 'subagentOutput', toolName ?? 'subagent', text, 'input', toolName)
            } else if (toolName === 'Bash') {
              addBlock(turn, 'bashOutput', 'Bash', text, 'input', 'Bash')
            } else {
              addBlock(turn, 'toolOutput', toolName ?? 'tool', text, 'input', toolName)
            }
          } else if (bt === 'image') {
            addBlock(turn, 'other', 'image', '', 'input')
          }
        }
      }
      continue
    }

    if (type === 'attachment') {
      const att = e['attachment'] as Record<string, unknown> | undefined
      if (!att) continue
      const c = classifyAttachment(att)
      if (!c || c.bytes === 0) continue
      addBlock(assistantTurns + 1, attachmentKind(c.kind), c.label, c.text, 'input')
      continue
    }

    if (type === 'summary') {
      const summary = typeof e['summary'] === 'string' ? (e['summary'] as string) : ''
      if (summary) addBlock(assistantTurns + 1, 'postCompact', 'compact summary', summary, 'input')
      continue
    }
  }
  rl.close()

  // Finalize: order by turn, cap to MAX_STEPS, then diff each kept step against the previous one.
  const ordered = [...steps.values()].sort((a, b) => a.turn - b.turn).slice(0, MAX_STEPS)
  const outSteps: ContextHistoryStep[] = []
  let prev: Map<string, string> | null = null  // previous step's block-id → text-hash
  for (const s of ordered) {
    const blocks = finalizeBlocks(s.blocks)
    const curHashes = new Map<string, string>()
    for (const b of blocks) curHashes.set(b.id, hashText(b.text))
    const diff = diffSteps(blocks, prev, curHashes)
    outSteps.push({ turn: s.turn, timestamp: s.timestamp, model: s.model, usage: s.usage, blocks, diff })
    prev = curHashes
  }

  return { sessionId, steps: outSteps, estimated: true, truncated, reconstructedFrom }
}

// Convert a step's ordered BlockAcc map into ContextBlock[]; fold everything past
// MAX_BLOCKS_PER_STEP into one summary "other" block so the payload stays bounded.
function finalizeBlocks(map: Map<string, BlockAcc>): ContextBlock[] {
  const accs = [...map.values()]
  const toBlock = (a: BlockAcc): ContextBlock => ({
    id: a.id, kind: a.kind, label: a.label, tokens: approxTokens(a.bytes), bytes: a.bytes,
    text: a.text, role: a.role, toolName: a.toolName,
  })
  if (accs.length <= MAX_BLOCKS_PER_STEP) return accs.map(toBlock)
  const kept = accs.slice(0, MAX_BLOCKS_PER_STEP - 1).map(toBlock)
  const rest = accs.slice(MAX_BLOCKS_PER_STEP - 1)
  const bytes = rest.reduce((n, a) => n + a.bytes, 0)
  kept.push({
    id: `other:+${rest.length} more blocks`, kind: 'other', label: `+${rest.length} more blocks`,
    tokens: approxTokens(bytes), bytes, text: '', role: 'input',
  })
  return kept
}

// Diff a step's blocks against the previous step's id→hash map. First step (prev === null) → every
// block is "added". firstChangeBlockId is the first block, in order, that is added or changed.
function diffSteps(blocks: ContextBlock[], prev: Map<string, string> | null, curHashes: Map<string, string>): StepDiff {
  if (!prev) {
    const added = blocks.map(b => b.id)
    return { added, removed: [], changed: [], firstChangeBlockId: added[0] }
  }
  const added: string[] = []
  const changed: string[] = []
  for (const b of blocks) {
    const before = prev.get(b.id)
    if (before === undefined) added.push(b.id)
    else if (before !== curHashes.get(b.id)) changed.push(b.id)
  }
  const removed: string[] = []
  for (const id of prev.keys()) if (!curHashes.has(id)) removed.push(id)
  const changedOrAdded = new Set([...added, ...changed])
  const firstChangeBlockId = blocks.find(b => changedOrAdded.has(b.id))?.id
  return { added, removed, changed, firstChangeBlockId }
}
