// Conversation transcript parser (TRDD-B22NYTOY) — the narrative per-turn reconstruction of a
// Claude Code session from its .jsonl, on demand. Unlike contextHistory (which MERGES same-kind
// blocks per turn behind a `${kind}:${label}` Map for composition analytics), this parser
// preserves the VERBATIM ordered sequence: user prompt → assistant thinking → text → tool calls
// with their paired outputs. That ordering is the whole point — it is what makes the session
// readable as a conversation (the token-companion insight; research report
// reports/research/20260716_005512+0200-token-companion-jsonl-ingest-distill.md).
//
// It also harvests the transcript signals nothing else parses: system/turn_duration,
// system/compact_boundary (pre/post/dropped tokens), ai-title, agent-name, entrypoint, and the
// usage.cache_creation ephemeral 5m/1h TTL-tier split.

import * as fs from 'fs'
import * as readline from 'readline'
import { classifyAttachment, findSessionFile } from './contextComposition'
import { countTokens } from './tokenEstimator'
import type {
  Conversation, ConversationBlock, ConversationCompaction, ConversationTurn, ConversationUsage,
} from './shared/summarizerTypes'

// Bounds mirror contextHistory's: an on-demand parse of a huge session must never block the host
// unbounded, and the sum of stored text must never exhaust the heap (TRDD-PJC8N1HO lesson).
const MAX_LINES = 3_000_000
const MAX_TURNS = 5000
const BLOCK_TEXT_CAP = 20_000
const TEXT_BUDGET_BYTES = Math.max(1, Number(process.env.AGENTLENS_HISTORY_TEXT_BUDGET_MB) || 24) * 1024 * 1024

function zeroUsage(): ConversationUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, tier5m: 0, tier1h: 0 }
}

// Tiny FNV-1a hash — resume-duplicate detection only (a false "duplicate" needs a hash collision
// on same kind+toolUseId, astronomically unlikely; and the cost of one is a hidden repeat block).
function hashText(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

/** Full text of a message/tool_result content value (string, or text elements of a block array). */
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

/**
 * Build the Conversation from an explicit transcript file. Pure w.r.t. session resolution —
 * the test suite drives THIS function on tmp fixtures; buildConversation() adds the on-disk
 * session lookup + parent fallback. Returns null only when the file cannot be read.
 */
export async function buildConversationFromFile(filePath: string, sessionId: string): Promise<Conversation | null> {
  let stream: fs.ReadStream
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  } catch {
    return null
  }

  const turns: ConversationTurn[] = []
  const turnByMessageId = new Map<string, ConversationTurn>()
  // tool_use id → the turn that issued it (+ tool name) so its tool_result — which arrives inside
  // a LATER `user` record — is paired back where it belongs narratively.
  const toolUseIdToTurn = new Map<string, { turn: ConversationTurn; name: string }>()
  // Per-turn content fingerprints: a session RESUME re-appends byte-identical records; appending
  // their blocks again would duplicate the narrative. A genuinely new streaming chunk (different
  // content, same message.id) is appended; an identical one is skipped.
  const turnBlockKeys = new Map<ConversationTurn, Set<string>>()
  const seenUserUuids = new Set<string>()
  const compactions: ConversationCompaction[] = []
  const otherRecords: Record<string, number> = {}
  // Attachments are injected context for whatever comes next — queue and flush into the next turn.
  let pendingAttachments: ConversationBlock[] = []

  let title: string | undefined
  let agentName: string | undefined
  let entrypoint: string | undefined
  let cwd: string | undefined
  let model: string | undefined
  let truncated = false
  let lines = 0
  let textBytesStored = 0
  const totals = { turns: 0, toolCalls: 0, durationMs: 0, usage: zeroUsage() }

  function chargeText(candidate: string): string {
    if (!candidate) return ''
    if (textBytesStored >= TEXT_BUDGET_BYTES) { truncated = true; return '' }
    const capped = candidate.slice(0, BLOCK_TEXT_CAP)
    textBytesStored += Buffer.byteLength(capped, 'utf8')
    return capped
  }

  function makeBlock(kind: ConversationBlock['kind'], rawText: string, extra: Partial<ConversationBlock> = {}): ConversationBlock {
    const tokens = rawText ? countTokens(rawText) : undefined
    return { kind, ...(rawText ? { text: chargeText(rawText) } : {}), ...(tokens ? { tokens } : {}), ...extra }
  }

  function newTurn(role: ConversationTurn['role'], init: Partial<ConversationTurn> = {}): ConversationTurn {
    const t: ConversationTurn = { turn: turns.length + 1, role, blocks: [], ...init }
    if (turns.length >= MAX_TURNS) { truncated = true; return t } // built but not kept — bounded output
    // Injected attachments precede the turn's own content — that is their transcript position.
    if (pendingAttachments.length > 0) { t.blocks.push(...pendingAttachments); pendingAttachments = [] }
    turns.push(t)
    return t
  }

  function appendBlock(turn: ConversationTurn, block: ConversationBlock): void {
    const key = `${block.kind}|${block.toolUseId ?? ''}|${hashText(block.text ?? '')}`
    let keys = turnBlockKeys.get(turn)
    if (!keys) { keys = new Set(); turnBlockKeys.set(turn, keys) }
    if (keys.has(key)) return // resume-duplicate — the identical block is already in this turn
    keys.add(key)
    turn.blocks.push(block)
    if (block.kind === 'toolUse') totals.toolCalls++
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (++lines > MAX_LINES) { truncated = true; break }
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    const type = e['type']
    const ts = typeof e['timestamp'] === 'string' ? (e['timestamp'] as string) : undefined
    // entrypoint/cwd ride as top-level fields on MANY record types (user, assistant, attachment,
    // system — verified on live transcripts), so harvest them record-agnostically: first wins.
    // Harvesting only from assistant rows missed sessions whose first carrier is a user row.
    if (!entrypoint && typeof e['entrypoint'] === 'string') entrypoint = e['entrypoint'] as string
    if (!cwd && typeof e['cwd'] === 'string') cwd = e['cwd'] as string

    if (type === 'assistant') {
      const msg = e['message'] as Record<string, unknown> | undefined
      if (!msg) continue
      const rowModel = msg['model'] as string | undefined
      const usage = msg['usage'] as Record<string, unknown> | undefined
      // <synthetic> zero-usage records are title-gen noise (token-companion technique).
      if (rowModel === '<synthetic>') {
        const sum = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
          .reduce((n, k) => n + (Number(usage?.[k]) || 0), 0)
        if (sum === 0) continue
      }
      if (!model && rowModel && rowModel !== '<synthetic>') model = rowModel

      const id = (msg['id'] as string | undefined) ?? (e['requestId'] as string | undefined)
      let turn = id ? turnByMessageId.get(id) : undefined
      if (!turn) {
        // Usage is credited ONCE per message.id — every streaming chunk repeats the same numbers.
        let u: ConversationUsage | undefined
        if (usage) {
          const cc = usage['cache_creation'] as Record<string, unknown> | undefined
          u = {
            input: Number(usage['input_tokens']) || 0,
            output: Number(usage['output_tokens']) || 0,
            cacheRead: Number(usage['cache_read_input_tokens']) || 0,
            cacheCreate: Number(usage['cache_creation_input_tokens']) || 0,
            tier5m: Number(cc?.['ephemeral_5m_input_tokens']) || 0,
            tier1h: Number(cc?.['ephemeral_1h_input_tokens']) || 0,
          }
          totals.usage.input += u.input; totals.usage.output += u.output
          totals.usage.cacheRead += u.cacheRead; totals.usage.cacheCreate += u.cacheCreate
          totals.usage.tier5m += u.tier5m; totals.usage.tier1h += u.tier1h
        }
        turn = newTurn('assistant', {
          ...(id ? { messageId: id } : {}),
          ...(rowModel && rowModel !== '<synthetic>' ? { model: rowModel } : {}),
          ...(ts ? { ts } : {}),
          ...(e['isSidechain'] === true ? { sidechain: true } : {}),
          ...(u ? { usage: u } : {}),
        })
        if (id) turnByMessageId.set(id, turn)
      }
      const content = (msg['content'] as Array<Record<string, unknown>>) ?? []
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const bt = block['type']
        if (bt === 'text' && typeof block['text'] === 'string') {
          appendBlock(turn, makeBlock('assistantText', block['text'] as string))
        } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
          appendBlock(turn, makeBlock('thinking', block['thinking'] as string))
        } else if (bt === 'tool_use' && block['name']) {
          const name = String(block['name'])
          const bid = block['id'] as string | undefined
          const input = (block['input'] ?? {}) as Record<string, unknown>
          // Bash reads best as the bare command; every other tool as its serialized input.
          const text = name === 'Bash' && typeof input['command'] === 'string'
            ? (input['command'] as string)
            : JSON.stringify(input)
          appendBlock(turn, makeBlock('toolUse', text, { toolName: name, ...(bid ? { toolUseId: bid } : {}) }))
          if (bid) toolUseIdToTurn.set(bid, { turn, name })
        }
      }
      continue
    }

    if (type === 'user') {
      const uuid = e['uuid'] as string | undefined
      if (uuid) {
        if (seenUserUuids.has(uuid)) continue // resume rewrite — already rendered
        seenUserUuids.add(uuid)
      }
      const msg = e['message'] as Record<string, unknown> | undefined
      // Harness-injected meta (cron caveats, local-command wrappers) and compact summaries are not
      // things the human typed — render them dimmed as system notes, never as user prompts.
      if (e['isMeta'] === true || e['isCompactSummary'] === true) {
        const text = fullText(msg?.['content']) || (typeof e['summary'] === 'string' ? (e['summary'] as string) : '')
        if (text) {
          const t = newTurn('system', ts ? { ts } : {})
          appendBlock(t, makeBlock('systemNote', text, { meta: { subtype: e['isCompactSummary'] === true ? 'compact-summary' : 'meta' } }))
        }
        continue
      }
      const content = msg?.['content']
      if (typeof content === 'string') {
        const t = newTurn('user', ts ? { ts } : {})
        appendBlock(t, makeBlock('userText', content))
        continue
      }
      if (!Array.isArray(content)) continue
      // A user record can mix tool_results (which belong to the ISSUING assistant turn) with real
      // user text (a genuinely new user turn). Pair results first, then open the user turn lazily.
      let userTurn: ConversationTurn | null = null
      const openUserTurn = (): ConversationTurn => (userTurn ??= newTurn('user', ts ? { ts } : {}))
      for (const block of content as Array<Record<string, unknown>>) {
        const bt = block['type']
        if (bt === 'tool_result') {
          const tid = block['tool_use_id'] as string | undefined
          const issued = tid ? toolUseIdToTurn.get(tid) : undefined
          const text = fullText(block['content'])
          const resBlock = makeBlock('toolResult', text, {
            ...(issued ? { toolName: issued.name } : {}),
            ...(tid ? { toolUseId: tid } : {}),
          })
          // No issuing turn on record (parse started mid-file / foreign result): keep it visible
          // on a user turn rather than dropping it.
          if (issued) appendBlock(issued.turn, resBlock)
          else appendBlock(openUserTurn(), resBlock)
        } else if (bt === 'text' && typeof block['text'] === 'string') {
          appendBlock(openUserTurn(), makeBlock('userText', block['text'] as string))
        } else if (bt === 'image') {
          appendBlock(openUserTurn(), makeBlock('image', '', { meta: { note: 'image content (not stored)' } }))
        }
      }
      continue
    }

    if (type === 'system') {
      const subtype = String(e['subtype'] ?? 'unknown')
      if (subtype === 'turn_duration') {
        const ms = Number(e['durationMs'])
        if (Number.isFinite(ms) && ms > 0) {
          // Closes the most recent assistant turn.
          for (let i = turns.length - 1; i >= 0; i--) {
            if (turns[i].role === 'assistant') { turns[i].durationMs = ms; totals.durationMs += ms; break }
          }
        }
        continue
      }
      if (subtype === 'compact_boundary') {
        const m = (e['compactMetadata'] ?? {}) as Record<string, unknown>
        compactions.push({
          afterTurn: turns.length,
          ...(typeof m['trigger'] === 'string' ? { trigger: m['trigger'] as string } : {}),
          ...(Number.isFinite(Number(m['preTokens'])) ? { preTokens: Number(m['preTokens']) } : {}),
          ...(Number.isFinite(Number(m['postTokens'])) ? { postTokens: Number(m['postTokens']) } : {}),
          ...(Number.isFinite(Number(m['cumulativeDroppedTokens'])) ? { droppedTokens: Number(m['cumulativeDroppedTokens']) } : {}),
        })
        continue
      }
      // Every other system subtype is counted, never silently dropped (sink philosophy).
      otherRecords[`system/${subtype}`] = (otherRecords[`system/${subtype}`] ?? 0) + 1
      continue
    }

    if (type === 'attachment') {
      const att = e['attachment'] as Record<string, unknown> | undefined
      const c = att ? classifyAttachment(att) : null
      if (c && c.bytes > 0) {
        pendingAttachments.push(makeBlock('attachment', c.text, { meta: { label: c.label, attachmentKind: c.kind, bytes: c.bytes } }))
      } else {
        otherRecords['attachment'] = (otherRecords['attachment'] ?? 0) + 1
      }
      continue
    }

    if (type === 'ai-title') {
      if (typeof e['aiTitle'] === 'string' && e['aiTitle']) title = e['aiTitle'] as string // latest wins
      continue
    }
    if (type === 'agent-name') {
      if (typeof e['agentName'] === 'string' && e['agentName']) agentName = e['agentName'] as string
      continue
    }

    // Unknown / unrendered record types (mode, last-prompt, file-history-*, queue-operation,
    // future additions): COUNTED so nothing ever disappears silently.
    const key = typeof type === 'string' && type ? type : '(untyped)'
    otherRecords[key] = (otherRecords[key] ?? 0) + 1
  }
  rl.close()

  totals.turns = turns.length
  return {
    sessionId,
    ...(title ? { title } : {}),
    ...(agentName ? { agentName } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    turns,
    compactions,
    otherRecords,
    totals,
    truncated,
  }
}

/**
 * Resolve a sessionId to its transcript and build the Conversation. Mirrors buildContextHistory's
 * no-own-log fallback: a fork/sub-agent with no `<sessionId>.jsonl` is reconstructed from its
 * PARENT's log (tagged reconstructedFrom); with neither log but a known parent an HONEST empty
 * conversation is returned; only the pure OTEL/no-parent case yields null.
 */
export async function buildConversation(sessionId: string, parentSessionId?: string): Promise<Conversation | null> {
  let file = findSessionFile(sessionId)
  let reconstructedFrom: string | undefined
  if (!file && parentSessionId) {
    const parentFile = findSessionFile(parentSessionId)
    if (parentFile) { file = parentFile; reconstructedFrom = parentSessionId }
  }
  if (!file) {
    if (parentSessionId) {
      return {
        sessionId, turns: [], compactions: [], otherRecords: {},
        totals: { turns: 0, toolCalls: 0, durationMs: 0, usage: zeroUsage() },
        truncated: false, reconstructedFrom: parentSessionId,
      }
    }
    return null
  }
  const conv = await buildConversationFromFile(file, sessionId)
  if (conv && reconstructedFrom) conv.reconstructedFrom = reconstructedFrom
  return conv
}
