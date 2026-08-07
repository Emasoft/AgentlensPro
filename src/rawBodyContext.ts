// TRDD-ICHAVFCS — reconstruct the FULL literal context of ONE llm API call from Claude Code's raw
// OTEL request body. When OTEL_LOG_RAW_API_BODIES is set, Claude Code writes the exact, untruncated
// Anthropic Messages API request ({system, messages[], tools[]}) to a file and emits a
// `claude_code.api_request_body` LOG event carrying `body_ref` (the file path). That request body IS
// the whole context at that call — so this module turns it into an ordered ContextBlock[] the UI can
// drill into, WITHOUT needing a local `.jsonl` (works for OTEL-only sessions).
//
// Two responsibilities:
//  1. CallBodyRegistry — a bounded in-memory index the OTLP ingestors feed with lightweight POINTERS
//     (file path + ids), never the multi-MB body itself. A call is later resolved to its body file.
//  2. buildCallContext(bodyFilePath) — parse the (capped) request JSON into ContextBlock[].
import * as fs from 'fs'
import { countTokens, estimateTokensFromBytes } from './tokenEstimator'
import type { ContextBlock, ContextBlockKind, CallContext } from './shared/summarizerTypes'

// Image content blocks stay in the shared ContextBlockKind 'other' bucket (adding a dedicated 'image'
// kind would ripple into the residentCost Record + the webview mirror — out of scope here), but their
// label is given this stable prefix so a consumer (contextCompositionIndex) can re-classify them as
// images without re-parsing the body. Load-bearing: the composition index keys image detection on it.
export const IMAGE_BLOCK_LABEL_PREFIX = 'image'

// A request body can be a few MB; cap the file we are willing to read so a corrupt/huge file can
// never load unbounded into memory. JSON needs the whole document to parse, so the guard is a size
// gate (skip oversized files) rather than incremental streaming.
const MAX_RAW_BODY_BYTES = 64 * 1024 * 1024 // 64 MB
// Full text per block, capped so a single drill never ships an unbounded payload. The token count is
// still computed on the FULL text (TRDD-IQENK7JM) so a capped block's estimate reflects all its content.
const BLOCK_TEXT_CAP = 20000

/** A lightweight pointer to one raw request/response body — stored by the OTLP ingestors so a call
 *  can be resolved to its body file on demand. Never carries the body bytes themselves. */
export interface CallBodyPointer {
  requestId?: string
  spanId?: string
  bodyRef?: string      // absolute path to the <uuid>.request.json / <request_id>.response.json file
  inlineBody?: string   // only when Claude Code inlined the body (no file sink configured)
  kind: 'request' | 'response'
  ts: number            // arrival epoch-ms — used for nearest-preceding correlation
  model?: string
  querySource?: string
}

/** Bounded (LRU by session, capped per session) index of raw-body pointers. Both the extension-host
 *  OtlpCollector and the standalone server's inline log processor feed the SAME shared instance
 *  (the module singleton `callBodyRegistry`), so there is one source of truth regardless of runtime. */
export class CallBodyRegistry {
  private map = new Map<string, CallBodyPointer[]>()
  // TRDD-BURNWDGT — session_id → account_uuid. Populated at ingest from the raw body's metadata.user_id
  // (parseUserId) and the OTEL user.account_uuid attribute, so a session's account is attributable
  // WITHOUT re-reading the multi-MB body. account_uuid is an IDENTIFIER, not a secret (no token). Bounded
  // by the same maxSessions cap; oldest entries evict FIFO. Kept separate from `map` because account is
  // available even for sessions whose body pointers were LRU-evicted.
  private sessionAccounts = new Map<string, string>()
  constructor(
    private readonly maxSessions = 200,
    private readonly maxPerSession = 400,
  ) {}

  record(sessionId: string, ptr: CallBodyPointer): void {
    if (!sessionId || (!ptr.bodyRef && !ptr.inlineBody)) { return }
    // Re-insert to move this session to the MRU end of the Map's insertion order.
    const existing = this.map.get(sessionId)
    const list = existing ?? []
    if (existing) { this.map.delete(sessionId) }
    list.push(ptr)
    if (list.length > this.maxPerSession) { list.splice(0, list.length - this.maxPerSession) }
    this.map.set(sessionId, list)
    while (this.map.size > this.maxSessions) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) { break }
      this.map.delete(oldest)
    }
  }

  /** Resolve the REQUEST-body pointer for one call. The request-body event carries spanId + body_ref
   *  but not request_id (the API assigns it); the response-body event carries request_id. So when the
   *  caller only knows request_id we hop response→request via shared spanId, else nearest-preceding
   *  request by timestamp. Falls back to spanId match, then the session's latest request. */
  resolveRequest(sessionId: string, sel: { requestId?: string; spanId?: string }): CallBodyPointer | undefined {
    const list = this.map.get(sessionId)
    if (!list || list.length === 0) { return undefined }
    const requests = list.filter(p => p.kind === 'request')
    if (requests.length === 0) { return undefined }
    if (sel.requestId) {
      const direct = requests.find(p => p.requestId === sel.requestId)
      if (direct) { return direct }
      const resp = list.find(p => p.kind === 'response' && p.requestId === sel.requestId)
      if (resp) {
        if (resp.spanId) {
          const paired = requests.find(p => p.spanId === resp.spanId)
          if (paired) { return paired }
        }
        const preceding = requests.filter(p => p.ts <= resp.ts).sort((a, b) => b.ts - a.ts)[0]
        if (preceding) { return preceding }
      }
    }
    if (sel.spanId) {
      const bySpan = requests.find(p => p.spanId === sel.spanId)
      if (bySpan) { return bySpan }
    }
    return requests[requests.length - 1]
  }

  /** Session ids currently held, most-recently-used first (the Map's insertion order is MRU because
   *  record() re-inserts). The composition index enumerates a bounded, most-recent slice of these for
   *  a broad-scope query — the LAZY contract (never a full-disk sweep of the 20k+ body files). */
  sessionIds(): string[] {
    return [...this.map.keys()].reverse()
  }

  /** TRDD-BURNWDGT — remember a session's OAuth account (account_uuid identifier). Fail-soft: ignores
   *  empty ids. Re-inserts to keep FIFO eviction MRU-ish; bounded by maxSessions so it can't grow
   *  unbounded across a long-lived server. NEVER carries the OAuth token — only the account_uuid. */
  recordAccount(sessionId: string, accountUuid: string | undefined): void {
    if (!sessionId || !accountUuid) { return }
    if (this.sessionAccounts.has(sessionId)) { this.sessionAccounts.delete(sessionId) }
    this.sessionAccounts.set(sessionId, accountUuid)
    while (this.sessionAccounts.size > this.maxSessions) {
      const oldest = this.sessionAccounts.keys().next().value
      if (oldest === undefined) { break }
      this.sessionAccounts.delete(oldest)
    }
  }

  /** The account_uuid recorded for a session, or undefined when unknown (fail-soft — never fabricated). */
  accountFor(sessionId: string): string | undefined {
    return this.sessionAccounts.get(sessionId)
  }

  /** Request-body pointers for one session, oldest→newest by arrival ts. The index maps these to
   *  1-based turns (each request body is one llm call). */
  requestPointers(sessionId: string): CallBodyPointer[] {
    const list = this.map.get(sessionId)
    if (!list) { return [] }
    return list.filter(p => p.kind === 'request').sort((a, b) => a.ts - b.ts)
  }

  /** The RESPONSE-body pointer paired with a request, joined on the shared spanId (the request-body
   *  event lacks the API-assigned request_id; the response-body event carries both). Used to read the
   *  authoritative per-call `usage` totals. Falls back to requestId match when spanId is absent. */
  responseFor(sessionId: string, sel: { spanId?: string; requestId?: string }): CallBodyPointer | undefined {
    const list = this.map.get(sessionId)
    if (!list) { return undefined }
    const responses = list.filter(p => p.kind === 'response')
    if (sel.spanId) {
      const bySpan = responses.find(p => p.spanId === sel.spanId)
      if (bySpan) { return bySpan }
    }
    if (sel.requestId) {
      const byReq = responses.find(p => p.requestId === sel.requestId)
      if (byReq) { return byReq }
    }
    return undefined
  }
}

/** Parse Claude Code's `metadata.user_id` — a JSON STRING blob `{device_id, account_uuid, session_id}`
 *  (NOT a bare id). The pre-fix code assigned this whole blob to `sessionId`; this returns the real
 *  fields. account_uuid/device_id are identifiers, not secrets, but are pointer-only data — never
 *  persisted to disk by the composition index. Returns empty fields on any malformed input (fail-soft:
 *  a body with a non-JSON user_id must not throw the whole parse). */
export function parseUserId(raw: unknown): { sessionId?: string; accountUuid?: string; deviceId?: string } {
  if (typeof raw !== 'string' || raw.length === 0) { return {} }
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    return {
      sessionId: typeof o.session_id === 'string' ? o.session_id : undefined,
      accountUuid: typeof o.account_uuid === 'string' ? o.account_uuid : undefined,
      deviceId: typeof o.device_id === 'string' ? o.device_id : undefined,
    }
  } catch {
    return {}
  }
}

/** The shared registry both OTLP ingestors write to and the MCP/HTTP accessors read from. */
export const callBodyRegistry = new CallBodyRegistry()

interface RawTextBlock { type: 'text'; text?: string }
interface RawToolUse { type: 'tool_use'; id?: string; name?: string; input?: unknown }
interface RawToolResult { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
interface RawThinking { type: 'thinking'; thinking?: string }
type RawContentBlock = RawTextBlock | RawToolUse | RawToolResult | RawThinking | { type: string; [k: string]: unknown }
interface RawMessage { role?: string; content?: string | RawContentBlock[] }
interface RawSystemBlock { type?: string; text?: string }
interface RawTool { name?: string; description?: string }
interface RawRequestBody {
  model?: string
  betas?: unknown
  system?: string | RawSystemBlock[]
  messages?: RawMessage[]
  tools?: RawTool[]
  metadata?: { user_id?: string }
}

// Classify a system block: cheaply tag CLAUDE.md / rules injections so the tree labels them, else plain system.
function classifySystem(text: string): ContextBlockKind {
  if (/Contents of .*CLAUDE\.md|^#\s*CLAUDE\.md/m.test(text)) { return 'claudemd' }
  if (/Contents of .*[/\\]\.claude[/\\]rules[/\\]/.test(text)) { return 'rule' }
  return 'system'
}

// Flatten a tool_result content (string, or array of {type:'text',text}/image blocks) to plain text.
function flattenResultContent(content: unknown): string {
  if (typeof content === 'string') { return content }
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') { return c }
      const b = c as { type?: string; text?: string }
      if (b.type === 'text' && typeof b.text === 'string') { return b.text }
      if (b.type === 'image') { return '[image]' }
      return JSON.stringify(c)
    }).join('\n')
  }
  if (content == null) { return '' }
  return JSON.stringify(content)
}

// Turn a parsed request body into an ordered ContextBlock[]: system → tool catalog → messages, which
// mirrors the actual prompt-cache prefix order (stable prefix first, conversation after).
export function buildCallContextFromJson(body: RawRequestBody | null, opts?: { uncap?: boolean }): CallContext | null {
  if (!body || typeof body !== 'object') { return null }
  const blocks: ContextBlock[] = []
  let truncated = false
  // Text cap is lifted only for an explicit single-block drill (get_block_content full:true); every
  // ordinary parse stays capped so a call never ships an unbounded payload.
  const cap = opts?.uncap ? Infinity : BLOCK_TEXT_CAP

  const push = (kind: ContextBlockKind, label: string, rawText: string, role: 'input' | 'output', toolName?: string): void => {
    const full = rawText ?? ''
    // Count tokens on the FULL text (before the display cap), then cap the stored text for the payload.
    // The raw body IS the whole literal context of one call, but the exact per-call usage total is not
    // plumbed into the registry, so these stay 'estimated' (no calibration anchor available here yet).
    const tokens = countTokens(full)
    let text = full
    if (text.length > cap) { text = text.slice(0, cap); truncated = true }
    const bytes = Buffer.byteLength(text)
    blocks.push({ id: `${kind}:${blocks.length}`, kind, label, tokens, tokenSource: 'estimated', bytes, text, role, toolName })
  }

  // 1. system
  if (typeof body.system === 'string' && body.system) {
    push(classifySystem(body.system), 'system prompt', body.system, 'input')
  } else if (Array.isArray(body.system)) {
    body.system.forEach((s, i) => {
      const text = typeof s?.text === 'string' ? s.text : ''
      if (text) { push(classifySystem(text), `system[${i}]`, text, 'input') }
    })
  }

  // 2. tool catalog (one block)
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const catalog = body.tools.map(t => `- ${t.name ?? '?'}: ${(t.description ?? '').slice(0, 200)}`).join('\n')
    push('toolCatalog', `tool catalog (${body.tools.length} tools)`, catalog, 'input')
  }

  // 3. messages — map each content element to a block. tool_use → its name; tool_result inherits the
  //    name from the matching tool_use (earlier in the list) so Bash/MCP results tag correctly.
  const toolNameById = new Map<string, string>()
  for (const m of body.messages ?? []) {
    const role = m?.role
    const content = m?.content
    if (typeof content === 'string') {
      const kind: ContextBlockKind = role === 'assistant' ? 'assistantMsg' : role === 'system' ? 'reminder' : 'userMsg'
      const label = role === 'assistant' ? 'assistant' : role === 'system' ? 'system message' : 'user'
      push(kind, label, content, role === 'assistant' ? 'output' : 'input')
      continue
    }
    if (!Array.isArray(content)) { continue }
    for (const b of content) {
      const type = (b as { type?: string })?.type
      if (type === 'text') {
        const text = (b as RawTextBlock).text ?? ''
        push(role === 'assistant' ? 'assistantMsg' : 'userMsg', role === 'assistant' ? 'assistant' : 'user', text, role === 'assistant' ? 'output' : 'input')
      } else if (type === 'thinking') {
        push('reasoning', 'thinking', (b as RawThinking).thinking ?? '', 'output')
      } else if (type === 'tool_use') {
        const tu = b as RawToolUse
        const name = tu.name ?? ''
        if (tu.id) { toolNameById.set(tu.id, name) }
        const isMcp = name.startsWith('mcp__')
        const kind: ContextBlockKind = isMcp ? 'mcp' : name === 'Bash' ? 'bashInput' : 'toolInput'
        push(kind, name || 'tool_use', JSON.stringify(tu.input ?? {}), 'input', name || undefined)
      } else if (type === 'tool_result') {
        const tr = b as RawToolResult
        const name = (tr.tool_use_id ? toolNameById.get(tr.tool_use_id) : '') ?? ''
        const isMcp = name.startsWith('mcp__')
        const kind: ContextBlockKind = isMcp ? 'mcp' : name === 'Bash' ? 'bashOutput' : 'toolOutput'
        push(kind, name || 'tool_result', flattenResultContent(tr.content), 'output', name || undefined)
      } else if (type === 'image') {
        // Account the image's real token weight from its base64 LENGTH (≈ bytes/4, which matches the
        // observed 46–77k tokens/image ground truth) — the pre-fix '[image]' placeholder counted ~2
        // tokens and hid the ANIME2SVG 525k-token stuck-image burn. NEVER store the base64 bytes: the
        // stored text is a metadata stub, so this stays pointer-only (no PII/image bytes persisted).
        const src = (b as { source?: { data?: string; media_type?: string } }).source
        const b64len = typeof src?.data === 'string' ? src.data.length : 0
        const media = src?.media_type ?? 'unknown'
        blocks.push({
          id: `other:${blocks.length}`,
          kind: 'other',
          label: `${IMAGE_BLOCK_LABEL_PREFIX} ${media}`,
          tokens: estimateTokensFromBytes(b64len),
          tokenSource: 'estimated',
          bytes: b64len,
          text: b64len > 0 ? `[image ${media} — ${b64len} base64 bytes, not stored]` : '[image]',
          role: 'input',
        })
      } else {
        push('other', type ?? 'block', JSON.stringify(b), 'input')
      }
    }
  }

  // metadata.user_id is a JSON blob {device_id, account_uuid, session_id} — parse out the real ids
  // (the pre-fix code assigned the whole blob string to sessionId).
  const uid = parseUserId(body.metadata?.user_id)
  return {
    sessionId: uid.sessionId ?? '',
    accountUuid: uid.accountUuid,
    model: typeof body.model === 'string' ? body.model : undefined,
    // Kept verbatim (strings only) rather than pre-interpreted: `betas` is an open-ended list the API
    // grows independently of us, so anything that needs to ask a question of it does so at the point
    // of use. Absent/malformed stays undefined — an empty array would falsely assert "no betas sent".
    betas: Array.isArray(body.betas) ? body.betas.filter((b): b is string => typeof b === 'string') : undefined,
    blocks,
    truncated,
  }
}

/** Parse the raw request-body file (size-guarded) into a CallContext. Returns null when the file is
 *  missing, oversized, or not valid JSON. */
export async function buildCallContext(bodyFilePath: string, opts?: { uncap?: boolean }): Promise<CallContext | null> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(bodyFilePath)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > MAX_RAW_BODY_BYTES) { return null }
  let raw: string
  try {
    raw = await fs.promises.readFile(bodyFilePath, 'utf8')
  } catch {
    return null
  }
  let parsed: RawRequestBody | null
  try {
    parsed = JSON.parse(raw) as RawRequestBody
  } catch {
    return null
  }
  return buildCallContextFromJson(parsed, opts)
}

/** Resolve a call (sessionId + requestId/spanId) to its full CallContext via the shared registry.
 *  This is the accessor the MCP tool + the HTTP route call. */
export async function resolveCallContext(
  sessionId: string,
  sel: { requestId?: string; spanId?: string },
): Promise<CallContext | null> {
  const ptr = callBodyRegistry.resolveRequest(sessionId, sel)
  if (!ptr) { return null }
  let ctx: CallContext | null = null
  if (ptr.bodyRef) {
    ctx = await buildCallContext(ptr.bodyRef)
  } else if (ptr.inlineBody) {
    try { ctx = buildCallContextFromJson(JSON.parse(ptr.inlineBody) as RawRequestBody) } catch { ctx = null }
  }
  if (!ctx) { return null }
  ctx.sessionId = sessionId
  ctx.requestId = sel.requestId ?? ptr.requestId ?? ctx.requestId
  if (!ctx.model) { ctx.model = ptr.model }
  // TRDD-BURNWDGT — backfill the session→account map from the body we just parsed. This makes account
  // attribution work even for LOG/statusline sessions whose OTEL body events never carried the account
  // attribute: any call-context / composition read populates it. account_uuid is an identifier, not a secret.
  if (ctx.accountUuid) { callBodyRegistry.recordAccount(sessionId, ctx.accountUuid) }
  return ctx
}
