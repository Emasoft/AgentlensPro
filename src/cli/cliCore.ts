// src/cli/cliCore.ts — shared transport + formatting layer of the single `agentlenspro`
// executable (TRDD-7284WCW7). Ported from scripts/agentlens-cli.js so the whole CLI is ONE
// type-checked codebase bundled into standalone/cli.js instead of five loose bin scripts.
//
// Everything here reads its endpoints/paths through FUNCTIONS (not module-load constants):
// the unit tests call these helpers in-process after pointing AGENTLENS_MCP_URL /
// AGENTLENS_UI_URL / DATA_DIR at ephemeral fixtures, and a load-time constant would freeze
// the real machine's values before the test could override them.

import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { UsageError } from './cliErrors'

/** MCP JSON-RPC endpoint of the running server. */
export function mcpEndpoint(): string {
  return process.env.AGENTLENS_MCP_URL || 'http://localhost:4316/mcp'
}

/** The UI/dashboard server's default base — ONE definition so dashboardUrl and uiBaseUrl can never
 *  drift on the fallback port. Each still honors its own env override. */
const DEFAULT_UI_URL = 'http://localhost:3000'

/** Dashboard URL (UI port). */
export function dashboardUrl(): string {
  return process.env.AGENTLENS_DASHBOARD_URL || DEFAULT_UI_URL
}

/** Base URL for the server's plain REST /api/* routes (UI port). */
export function uiBaseUrl(): string {
  return process.env.AGENTLENS_UI_URL || DEFAULT_UI_URL
}

/** The AgentlensPro data directory (span store, logs, pidfile, forensics.db).
 *  Implementation moved to src/dataDir.ts so the server and the src/ modules can share it without
 *  importing the CLI; re-exported here so existing callers are untouched. */
export { dataDir } from '../dataDir'

/** ~/.claude/settings.json — overridable ONLY for tests; production always targets the real file. */
export function claudeSettingsPath(): string {
  return process.env.AGENTLENS_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json')
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** How long a polling loop should sleep before its next tick: the poll interval, or whatever is left
 *  until its deadline when that is shorter.
 *
 *  Lives beside `sleep` because BOTH long-lived watchers got this wrong in the same way. Sleeping the
 *  full interval unconditionally means the loop can only notice its deadline on an interval boundary,
 *  so it overruns by up to one whole interval — and both then reported the REQUESTED duration, which
 *  is what made the overrun invisible. MEASURED: `watch --for 1 --interval 900` ran ~15 minutes and
 *  printed "elapsed (1m)"; `budget --minutes 0.25 --watch 30` took 33 s for a 15 s window.
 *
 *  A deadline that is not a deadline is worse than none, because a harness sizes its own timeout
 *  around it. `deadlineMs` is Infinity when no deadline was set, which yields the plain interval. */
export function nextSleepMs(nowMs: number, deadlineMs: number, intervalMs: number): number {
  return Math.max(0, Math.min(intervalMs, deadlineMs - nowMs))
}

export const fmtGb = (b: number): string => `${(b / 1024 ** 3).toFixed(2)}GB`
export const fmtMb = (b: number): string => `${(b / 1048576).toFixed(1)}MB`

interface JsonRpcError { code?: number; message?: string }
interface JsonRpcResponse { error?: JsonRpcError; result?: unknown }

/** How long to wait for the TCP CONNECT before giving up. Deliberately bounds the CONNECT and not
 *  the response: a legitimate call can take a long time SERVER-side (`ctxvis` spawns an agent and
 *  measures two of its turns), so an idle-socket timeout would kill correct work, while an
 *  unanswered connect is never anything but a dead endpoint.
 *
 *  MEASURED, and this is why it exists: with no bound at all, `agentlenspro cache-expired` took
 *  **75 seconds** against an address that DROPS — the OS connect timeout — on a verb documented to
 *  answer with the server down. The hand-fix that bounded `hook`/`gate`/`statusline` (TRDD-E8XIC2PM)
 *  covered a different transport; everything on this one was still unbounded, which the latency
 *  guard caught on its first run. A closed port REFUSES instantly and hides this completely. */
const CONNECT_TIMEOUT_MS = Math.max(200, Number(process.env.AGENTLENS_CONNECT_TIMEOUT_MS) || 800)

/** Arm a connect deadline on an in-flight request. Cleared the moment the socket connects or the
 *  response starts; on expiry the request is destroyed with a precise reason, so the caller gets a
 *  fail-fast error instead of a process that looks wedged. Returns the clear function. */
function armConnectDeadline(req: http.ClientRequest, endpoint: string): () => void {
  const timer = setTimeout(() => {
    req.destroy(new Error(
      `no connection to ${endpoint} within ${CONNECT_TIMEOUT_MS}ms — the address is not answering ` +
      '(a DROP, not a refusal); raise AGENTLENS_CONNECT_TIMEOUT_MS if this endpoint is simply slow to accept'
    ))
  }, CONNECT_TIMEOUT_MS)
  timer.unref?.()
  const clear = () => clearTimeout(timer)
  req.on('socket', s => {
    // `connecting` is the ONLY reliable test. Waiting for the 'connect' event alone silently turns
    // this into a RESPONSE deadline — the very thing this must not be — because a socket that is
    // already established (agent pool reuse, or one assigned after connecting) never emits it.
    // MEASURED when it was wrong: TCP connect to a live, listening server took 1 ms and the request
    // was still destroyed at 800 ms, because the loaded server took longer than that to REPLY. Every
    // diagnostics verb would have failed against a busy-but-healthy server.
    if (!s.connecting) { clear(); return }
    s.once('connect', clear)
  })
  req.on('response', clear)
  req.on('error', clear)
  return clear
}

/** One JSON-RPC call over the server's Streamable-HTTP MCP transport. */
export function rpc(method: string, params: unknown): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  const u = new URL(mcpEndpoint())
  const opts: http.RequestOptions = {
    hostname: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The Streamable-HTTP transport requires the client to accept BOTH content types.
      Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c })
      // Without this, a socket reset AFTER headers but BEFORE 'end' never fires 'end' and the promise
      // hangs forever (the req 'error' handler only covers pre-response failures).
      res.on('error', e => reject(new Error(`response stream error from ${mcpEndpoint()}: ${e.message}`)))
      res.on('end', () => {
        // The transport may answer as SSE ("event: message\ndata: {...}") or as plain JSON.
        const line = raw.split('\n').find(l => l.startsWith('data:'))
        const payload = line ? line.slice(5).trim() : raw
        try {
          const j = JSON.parse(payload) as JsonRpcResponse
          if (j.error) return reject(new Error(`${j.error.message || 'rpc error'} (${j.error.code})`))
          resolve(j.result)
        } catch {
          reject(new Error(`bad response (${res.statusCode}): ${raw.slice(0, 300)}`))
        }
      })
    })
    armConnectDeadline(req, mcpEndpoint())
    req.on('error', e => reject(new Error(`cannot reach ${mcpEndpoint()}: ${e.message}`)))
    req.write(body)
    req.end()
  })
}

/** The MCP handshake: initialize, then the session is usable on this stateless endpoint. */
export async function init(): Promise<void> {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentlenspro', version: '2.0.0' },
  })
}

export interface ToolSchema {
  properties?: Record<string, { type?: string; description?: string }>
  required?: string[]
}
export interface ToolInfo { name: string; description?: string; inputSchema?: ToolSchema }

// Keyed by endpoint, not a single slot: the whole module reads endpoints per-call so a test can
// repoint AGENTLENS_MCP_URL mid-process (see the header). A single-slot cache would freeze the first
// endpoint's tools and return them after a repoint — the exact invariant this file exists to keep.
const toolCache = new Map<string, ToolInfo[]>()
export async function fetchTools(): Promise<ToolInfo[]> {
  const ep = mcpEndpoint()
  const cached = toolCache.get(ep)
  if (cached) return cached
  const tools = ((await rpc('tools/list', {}) as { tools?: ToolInfo[] }).tools) || []
  toolCache.set(ep, tools)
  return tools
}

/** Tool names use underscores; accept the dashed spelling too (CLI muscle memory). */
export function resolveTool(tools: ToolInfo[], name: string): ToolInfo | null {
  const norm = name.replace(/-/g, '_').toLowerCase()
  return tools.find(t => t.name.toLowerCase() === norm) || null
}

interface ToolCallResult { content?: Array<{ text?: unknown }> }
export function textOf(result: unknown): string {
  const c = (result as ToolCallResult | null)?.content?.[0]
  return c && typeof c.text === 'string' ? c.text : JSON.stringify(result)
}

/** A one-line digest so the agent's context receives the ANSWER, not the payload. */
export function digest(obj: unknown): string {
  if (obj && typeof obj === 'object') {
    const o = obj as { verdict?: unknown; text?: unknown }
    if (typeof o.verdict === 'string') return o.verdict
    if (typeof o.text === 'string') return o.text.split('\n').slice(0, 3).join(' | ')
  }
  const s = JSON.stringify(obj)
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

export async function callTool(tool: string, args: Record<string, unknown> | undefined, full: boolean): Promise<unknown> {
  const a: Record<string, unknown> = { ...(args || {}) }
  if (full) a.verbosity = 'full'
  const res = await rpc('tools/call', { name: tool, arguments: a })
  const text = textOf(res)
  try { return JSON.parse(text) } catch { return text }
}

export function firstSentence(s: unknown): string {
  const one = String(s || '').trim().split('. ')[0]
  return one.length > 140 ? `${one.slice(0, 140)}…` : one
}

/** Plain HTTP JSON helper for the server's /api/* routes (REST on the UI port, not JSON-RPC). */
export function apiRequest(method: string, apiPath: string, payload?: unknown): Promise<Record<string, unknown>> {
  const u = new URL(apiPath, uiBaseUrl())
  const body = payload === undefined ? null : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let raw = ''
      res.on('data', (c: Buffer) => { raw += c })
      // A socket reset mid-response never fires 'end' — settle the promise instead of hanging forever.
      res.on('error', e => reject(new Error(`response stream error from ${uiBaseUrl()}: ${e.message}`)))
      res.on('end', () => {
        try {
          const j = JSON.parse(raw) as Record<string, unknown>
          if (res.statusCode !== 200) return reject(new Error(String(j.error || `HTTP ${res.statusCode}`)))
          resolve(j)
        } catch { reject(new Error(`bad response (${res.statusCode}): ${raw.slice(0, 200)}`)) }
      })
    })
    // Same unbounded-connect exposure as rpc() above — same bound, for the same reason.
    armConnectDeadline(req, uiBaseUrl())
    req.on('error', e => reject(new Error(`server unreachable at ${uiBaseUrl()}: ${e.message}`)))
    if (body) req.write(body)
    req.end()
  })
}

export function parseWhen(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined
  if (/^\d+(\.\d+)?$/.test(v)) return Date.now() - Number(v) * 3600e3 // bare number = hours ago
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new UsageError(`--${flag} expects an ISO date or a number of hours, got "${v}"`)
  return t
}
