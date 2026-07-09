// HEARTBEAT COST — the EXACT token + dollar cost of one janitor heartbeat fire, end to end.
//
// WHAT COUNTS AS "THE FIRE": every API call in the heartbeat's session from the moment the cron injected
// its prompt until the next fire (or now). That deliberately INCLUDES everything the heartbeat causes —
// the dispatcher-stub turn, hook/security injections riding in the prefix, skills it loads, logs it
// reads, and the sub-agents it spawns (sub-agent calls carry the PARENT session_id, so a session+window
// scope captures them automatically). Calls from OTHER sessions inside the same time span are reported
// separately under `concurrent`, never folded in and never hidden.
//
// WHY THE DEFAULT IS THE *LAST COMPLETED* FIRE (a hard constraint, not a preference):
// a request body carries no request_id — the ONLY link to its usage is the chain
// `response(turn i).id == request(turn i+1).diagnostics.previous_message_id`. A call's usage therefore
// becomes knowable only once the NEXT call is written. Since this command is meant to run INSIDE the
// heartbeat's own turn, that turn's final response does not exist on disk yet. Reporting the in-flight
// fire would silently under-count its largest output. So we report the last fire whose calls have all
// settled — exact, never estimated — and disclose the in-flight remainder in `inFlight`.
// At a 5-minute cadence this means: fire N tells you exactly what fire N-1 cost.
//
// POINTER-ONLY: token counts, model ids, timings. Never message text, never the user_id blob.

import * as fs from 'fs'
import * as path from 'path'
import { calcTokenCostUsd } from './pricing'
import { DEFAULT_BODIES_DIR } from './cacheCreationForensics'
import { sessionIdOf } from './sessionBurnProfile'

const MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MARKER = '[janitor-heartbeat]'
const rxMsgId = /"id"\s*:\s*"(msg_[A-Za-z0-9]+)"/
const rxPrev = /"previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)"/
const rxModel = /"model"\s*:\s*"([^"]+)"/
const rxIn = /"input_tokens"\s*:\s*(\d+)/
const rxOut = /"output_tokens"\s*:\s*(\d+)/
const rxRead = /"cache_read_input_tokens"\s*:\s*(\d+)/
const rxCreate = /"cache_creation_input_tokens"\s*:\s*(\d+)/
const rx5m = /"ephemeral_5m_input_tokens"\s*:\s*(\d+)/
const rx1h = /"ephemeral_1h_input_tokens"\s*:\s*(\d+)/

export interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreateTokens: number
  ephemeral5mTokens: number
  ephemeral1hTokens: number
  totalTokens: number
}
export interface CostBreakdown {
  inputUsd: number
  outputUsd: number
  cacheReadUsd: number
  cacheWriteUsd: number
  totalUsd: number
}
export interface HeartbeatCostReport {
  marker: string
  sessionId: string | null
  fireDetected: boolean
  fireStartedAt: string | null
  fireEndedAt: string | null
  durationSeconds: number
  apiCalls: number
  agentSpawns: number                 // Agent/Task tool_use blocks issued during the fire
  callsByToolSurface: { tools: number; calls: number }[]   // a differing tool count ⇒ a sub-agent stream
  byModel: { model: string; calls: number; tokens: number; costUsd: number }[]
  tokens: TokenBreakdown
  cost: CostBreakdown
  inFlight: { calls: number; note: string } | null
  concurrent: { calls: number; sessions: number; note: string }
  verdict: string
  coverage: { bodiesDir: string; filesScanned: number; windowHours: number; complete: boolean; note: string }
}

interface Req { p: string; mtime: number; model: string; prev: string | null; session: string | null }
interface Usage { input: number; output: number; read: number; create: number; e5m: number; e1h: number; model: string }

function zeroTokens(): TokenBreakdown {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, ephemeral5mTokens: 0, ephemeral1hTokens: 0, totalTokens: 0 }
}
function zeroCost(): CostBreakdown {
  return { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, totalUsd: 0 }
}

function emptyReport(marker: string, bodiesDir: string, windowHours: number, note: string): HeartbeatCostReport {
  return {
    marker, sessionId: null, fireDetected: false, fireStartedAt: null, fireEndedAt: null,
    durationSeconds: 0, apiCalls: 0, agentSpawns: 0, callsByToolSurface: [], byModel: [],
    tokens: zeroTokens(), cost: zeroCost(), inFlight: null,
    concurrent: { calls: 0, sessions: 0, note: 'no data' },
    verdict: `No ${marker} fire found in the scanned window.`,
    coverage: { bodiesDir, filesScanned: 0, windowHours, complete: true, note },
  }
}

function flattenText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  // tool_result / tool_use / image blocks carry no `.text`, so they flatten to '' — which is what makes
  // a follow-up call (whose last user block is a tool_result) correctly NOT look like a fire start.
  return c.map(b => (b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
}

/** Injected context the harness appends AFTER the real user message (UserPromptSubmit / PostToolUse hook
 *  output, system-reminders). It must be skipped when looking for "what the user actually said". */
function isInjectedContext(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('UserPromptSubmit hook additional context')
    || t.startsWith('PostToolUse')
    || t.startsWith('<system-reminder>')
}

/** Is this request the FIRST call of a fire? True iff the CURRENT TURN's real user message starts with
 *  the marker.
 *
 *  Two traps, both hit for real:
 *  1. `raw.includes(marker)` is WRONG — the marker persists in the transcript history of every later
 *     call, and appears in any conversation that merely discusses the janitor. (Measured: 1412 request
 *     bodies contain the literal marker; zero are fires.)
 *  2. The LAST message is NOT the user's. Claude Code appends the UserPromptSubmit hook's output as a
 *     trailing `role:"system"` message, so a naive last-message check never matches a real fire. We walk
 *     backwards past injected context to the real user message, stopping at the first assistant message
 *     (which means we have left the current turn's user block).
 */
function isFireStart(p: string, marker: string): boolean {
  let body: { messages?: { role?: string; content?: unknown }[] }
  try { body = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return false }
  const msgs = Array.isArray(body.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'assistant') return false       // left the current turn's user block
    if (m.role !== 'user') continue                // trailing hook/system context
    const text = flattenText(m.content)
    if (isInjectedContext(text)) continue          // hook context delivered as a user message
    return text.trimStart().startsWith(marker)     // the real current user message
  }
  return false
}

/** Count Agent/Task spawns + the tool-surface of a call. A sub-agent's calls carry the parent session id
 *  but a DIFFERENT tool count, which is how they surface in callsByToolSurface. */
function inspectCall(p: string): { agentSpawns: number; toolCount: number } {
  let body: { tools?: unknown[]; messages?: { content?: unknown }[] }
  try { body = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return { agentSpawns: 0, toolCount: 0 } }
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0
  let agentSpawns = 0
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && Array.isArray(lastMsg.content)) {
    for (const b of lastMsg.content as { type?: string; name?: string }[]) {
      if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) agentSpawns++
    }
  }
  return { agentSpawns, toolCount }
}

function addUsage(t: TokenBreakdown, u: Usage): void {
  t.inputTokens += u.input
  t.outputTokens += u.output
  t.cacheReadTokens += u.read
  t.cacheCreateTokens += u.create
  t.ephemeral5mTokens += u.e5m
  t.ephemeral1hTokens += u.e1h
  t.totalTokens += u.input + u.output + u.read + u.create
}

/** Per-component dollars: isolate each bucket through the same pricing table the rest of AgentLens uses,
 *  so the four numbers always sum to the total the dashboard reports. */
function costOf(u: Usage): CostBreakdown {
  const inputUsd = calcTokenCostUsd(u.input, 0, 0, 0, u.model)
  const cacheReadUsd = calcTokenCostUsd(0, u.read, 0, 0, u.model)
  const cacheWriteUsd = calcTokenCostUsd(0, 0, u.create, 0, u.model)
  const outputUsd = calcTokenCostUsd(0, 0, 0, u.output, u.model)
  return { inputUsd, outputUsd, cacheReadUsd, cacheWriteUsd, totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd }
}

export interface HeartbeatCostOptions {
  marker?: string
  sessionId?: string
  windowHours?: number
  bodiesDir?: string
  fire?: 'last-complete' | 'current'
}

/** Exact cost of one heartbeat fire. Default `fire: 'last-complete'` — see the module header for why the
 *  in-flight fire cannot be measured exactly from inside itself. */
export async function buildHeartbeatCost(opts: HeartbeatCostOptions = {}): Promise<HeartbeatCostReport> {
  const bodiesDir = opts.bodiesDir ?? DEFAULT_BODIES_DIR
  const marker = opts.marker ?? DEFAULT_MARKER
  const windowHours = opts.windowHours ?? 3
  const wantCurrent = opts.fire === 'current'
  if (!fs.existsSync(bodiesDir)) {
    return emptyReport(marker, bodiesDir, windowHours, `No OTEL raw-body directory at ${bodiesDir} — set OTEL_LOG_RAW_API_BODIES to capture bodies.`)
  }

  const cutoff = Date.now() - windowHours * 3600e3
  const reqs: Req[] = []
  const respById = new Map<string, Usage>()
  let scanned = 0

  for (const f of fs.readdirSync(bodiesDir)) {
    const isReq = f.endsWith('.request.json')
    const isResp = f.endsWith('.response.json')
    if (!isReq && !isResp) continue
    const p = path.join(bodiesDir, f)
    let st: fs.Stats
    try { st = fs.statSync(p) } catch { continue }
    if (st.mtimeMs < cutoff || st.size > MAX_BYTES) continue
    let s: string
    try { s = fs.readFileSync(p, 'utf8') } catch { continue }
    scanned++
    if (isResp) {
      const id = rxMsgId.exec(s)?.[1]
      if (!id) continue
      respById.set(id, {
        input: Number(rxIn.exec(s)?.[1] ?? 0), output: Number(rxOut.exec(s)?.[1] ?? 0),
        read: Number(rxRead.exec(s)?.[1] ?? 0), create: Number(rxCreate.exec(s)?.[1] ?? 0),
        e5m: Number(rx5m.exec(s)?.[1] ?? 0), e1h: Number(rx1h.exec(s)?.[1] ?? 0),
        model: rxModel.exec(s)?.[1] ?? '',
      })
    } else {
      reqs.push({ p, mtime: st.mtimeMs, model: rxModel.exec(s)?.[1] ?? '', prev: rxPrev.exec(s)?.[1] ?? null, session: sessionIdOf(s) })
    }
  }
  reqs.sort((a, b) => a.mtime - b.mtime)
  const note = `Scanned ${scanned} body file(s) modified in the last ${windowHours}h (files >${MAX_BYTES / 1e6}MB skipped).`

  // Locate the fire starts, newest first, restricted to the requested session when given.
  const candidates = reqs.filter(r => !opts.sessionId || (r.session ?? '').startsWith(opts.sessionId))
  const fireStarts: number[] = []
  for (let i = candidates.length - 1; i >= 0 && fireStarts.length < 3; i--) {
    if (isFireStart(candidates[i].p, marker)) fireStarts.unshift(i)
  }
  if (fireStarts.length === 0) return emptyReport(marker, bodiesDir, windowHours, note)

  // 'current' = the newest fire (its tail may be unsettled). 'last-complete' = the fire before it when a
  // newer one exists; otherwise the newest, with its unsettled tail reported under inFlight.
  const startIdx = wantCurrent || fireStarts.length === 1 ? fireStarts[fireStarts.length - 1] : fireStarts[fireStarts.length - 2]
  const endIdx = wantCurrent || fireStarts.length === 1 ? candidates.length - 1 : fireStarts[fireStarts.length - 1] - 1
  const sessionId = candidates[startIdx].session

  const tokens = zeroTokens()
  const cost = zeroCost()
  const byModel = new Map<string, { calls: number; tokens: number; costUsd: number }>()
  const toolSurface = new Map<number, number>()
  let apiCalls = 0, agentSpawns = 0, unsettled = 0

  for (let i = startIdx; i <= endIdx; i++) {
    const r = candidates[i]
    apiCalls++
    const ins = inspectCall(r.p)
    agentSpawns += ins.agentSpawns
    toolSurface.set(ins.toolCount, (toolSurface.get(ins.toolCount) ?? 0) + 1)

    // Usage of call i lives on the response whose id == call i+1's previous_message_id (the proven chain).
    const nxt = candidates[i + 1]
    const u = nxt?.prev ? respById.get(nxt.prev) : undefined
    if (!u) { unsettled++; continue }
    if (!u.model) u.model = r.model
    addUsage(tokens, u)
    const c = costOf(u)
    cost.inputUsd += c.inputUsd; cost.outputUsd += c.outputUsd
    cost.cacheReadUsd += c.cacheReadUsd; cost.cacheWriteUsd += c.cacheWriteUsd; cost.totalUsd += c.totalUsd
    const m = byModel.get(u.model) ?? { calls: 0, tokens: 0, costUsd: 0 }
    m.calls++; m.tokens += u.input + u.output + u.read + u.create; m.costUsd += c.totalUsd
    byModel.set(u.model, m)
  }

  const startMs = candidates[startIdx].mtime
  const endMs = candidates[Math.max(startIdx, endIdx)].mtime
  const round = (n: number) => +n.toFixed(4)
  cost.inputUsd = round(cost.inputUsd); cost.outputUsd = round(cost.outputUsd)
  cost.cacheReadUsd = round(cost.cacheReadUsd); cost.cacheWriteUsd = round(cost.cacheWriteUsd); cost.totalUsd = round(cost.totalUsd)

  // Concurrent activity: other sessions' calls inside the same span — disclosed, never folded in.
  const otherSessions = new Set<string>()
  let otherCalls = 0
  for (const r of reqs) {
    if (r.mtime < startMs || r.mtime > endMs) continue
    if (!r.session || r.session === sessionId) continue
    otherSessions.add(r.session); otherCalls++
  }

  // Phrased to be quoted verbatim by the janitor at the NEXT fire ("the last heartbeat cost …"), which is
  // the only way to state an EXACT figure — the in-flight fire's final response is not on disk yet.
  const t = tokens
  const label = wantCurrent ? 'Current heartbeat (in flight)' : 'The last heartbeat'
  const verdict =
    `${label} [${new Date(startMs).toISOString()}] cost ${t.totalTokens.toLocaleString()} tokens = $${cost.totalUsd.toFixed(4)} — ` +
    `input ${t.inputTokens.toLocaleString()} | output ${t.outputTokens.toLocaleString()} | ` +
    `cache_read ${t.cacheReadTokens.toLocaleString()} | cache_write ${t.cacheCreateTokens.toLocaleString()} ` +
    `(${apiCalls} API call${apiCalls === 1 ? '' : 's'}, ${agentSpawns} agent spawn${agentSpawns === 1 ? '' : 's'}, ${((endMs - startMs) / 1000).toFixed(1)}s)` +
    (unsettled > 0 ? ` ⚠ ${unsettled} call(s) not yet settled — EXCLUDED` : '')

  return {
    marker, sessionId, fireDetected: true,
    fireStartedAt: new Date(startMs).toISOString(),
    fireEndedAt: new Date(endMs).toISOString(),
    durationSeconds: +((endMs - startMs) / 1000).toFixed(1),
    apiCalls, agentSpawns,
    callsByToolSurface: [...toolSurface.entries()].map(([tools, calls]) => ({ tools, calls })).sort((a, b) => b.calls - a.calls),
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, calls: v.calls, tokens: v.tokens, costUsd: round(v.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    tokens, cost,
    inFlight: unsettled > 0
      ? { calls: unsettled, note: 'A call\'s usage is only written once the NEXT call happens (requests carry no request_id; the only link is previous_message_id). These calls have not settled yet and are EXCLUDED from the totals above — re-run after the next fire for their exact cost.' }
      : null,
    concurrent: {
      calls: otherCalls, sessions: otherSessions.size,
      note: otherCalls > 0
        ? `${otherCalls} call(s) from ${otherSessions.size} OTHER session(s) overlapped this fire's time span. They are NOT included in the totals (they are not the heartbeat's cost), but they did compete for the same rate-limit window.`
        : 'No other session made API calls during this fire.',
    },
    verdict,
    coverage: { bodiesDir, filesScanned: scanned, windowHours, complete: true, note },
  }
}
