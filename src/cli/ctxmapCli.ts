// src/cli/ctxmapCli.ts — `agentlenspro ctxmap`: decompose a captured raw API request into every
// element that occupies context, count each one's tokens, and diff two requests.
//
// WHY THIS EXISTS. Every other surface in this product measures what a request COST. None of them
// could say what was IN it. The session JSONL is not a substitute: it records neither the system
// prompt, nor the tool schemas, nor the injected context block — so grepping a transcript to ask
// "does a subagent receive CLAUDE.md?" measures nothing and answers confidently wrong (it did,
// twice, on 2026-07-30, in both directions). The captured raw body IS the ground truth: it is
// literally the bytes that went to the API.
//
// TOKEN ACCURACY — WHAT IS SOLID AND WHAT IS NOT. The DECOMPOSITION is solid: which elements are
// present and how many bytes each occupies is read straight out of the request. The RELATIVE shares
// are nearly as solid, since one estimator is applied uniformly to every element. The ABSOLUTE
// total is the weak link, twice over:
//   1. The estimator (src/tokenEstimator.ts) is not ±10-15% on this content — measured on a captured
//      subagent request it read 161,685 against 225,825 billed (2.56 chars/token; dense markdown and
//      JSON tool schemas tokenize far below the prose rate the estimator assumes).
//   2. Calibration corrects (1) only if the paired response really is this request's, and that
//      pairing is a HEURISTIC — see pairUsage for the two deterministic routes that were tried and
//      measured as unavailable.
// Hence the output never prints a bare "EXACT": it names the pairing method, shows the implied
// scale, and says how many responses could have been the one. A number that looks certain and is
// not is worse than no number.

import * as fs from 'fs'
import * as path from 'path'
import { resolveDataDir } from '../dataDir'
import { resolveBodiesReadScope } from '../captureConfig'
import { countTokens, calibrateTokens } from '../tokenEstimator'
import type { TokenSource } from '../shared/summarizerTypes'
import {
  resolveAnthropicAuth, countTokensExact, mapLimit, countable,
  type AnthropicAuth, type CountableRequest,
} from '../exactTokens'
import { readBody, type ContentBlock, type Message, type ToolDef, type RequestBody, type Usage, type ResponseBody } from '../capturedBody'
import { EXIT } from './cliErrors'

export type { ContentBlock, Message, ToolDef, RequestBody, Usage, ResponseBody }

export const CTXMAP_USAGE = `agentlenspro ctxmap — what is actually inside a captured API request

  ctxmap <request.json>            decompose one request; every element, with tokens
  ctxmap --diff <A> <B>            what changed in the context between two requests
  ctxmap --find <text>             list captured requests containing <text> anywhere
  ctxmap --list [--limit N]        most recent captured requests

  --top N     how many individual elements to show (default 20)
  --json      machine-readable output
  --out FILE  write the full report to FILE; print only a one-line digest
  --estimate  skip exact measurement (no network); use the estimator instead

By default every count is MEASURED with Anthropic's count_tokens endpoint — one call per element,
free of inference charges — so the numbers are the real ones, not an estimate. Needs
ANTHROPIC_API_KEY or a Claude Code login. With --estimate, counts fall back to the local estimator,
which reads ~40% low on this content.`

// ── shapes ────────────────────────────────────────────────────────────────────
// Declared once in src/capturedBody.ts — ctxvis needs the same shapes and a second copy is the
// drift this repo fails builds over. Re-exported here so existing importers of ctxmapCli are
// unaffected.

/** Which top-level request fields were accounted for, so "nothing was missed" is a checked claim
 *  rather than an assurance. `unknown` is the future-proofing: a content-bearing field added by the
 *  API later shows up here instead of being silently ignored. */
export interface CtxCoverage {
  decomposed: string[]
  parameters: string[]
  unknown: string[]
  /** exact total minus the sum of measured elements; should be ~0. Non-zero is shown, never hidden. */
  residual: number
}

// Fields that carry no tokenizable content — they configure the call. count_tokens accepts only
// model/system/tools/messages, and the measured total (226,910) exceeding the billed input (225,825)
// on a captured request confirms nothing tokenizable lives outside those four.
const PARAMETER_FIELDS = new Set([
  'model', 'max_tokens', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences',
  'metadata', 'betas', 'thinking', 'context_management', 'output_config', 'tool_choice',
  'service_tier', 'diagnostics', 'anthropic_version', 'anthropic_beta', 'mcp_servers',
])
const CONTENT_FIELDS = new Set(['system', 'tools', 'messages'])

export function auditCoverage(body: Record<string, unknown>): CtxCoverage {
  const decomposed: string[] = [], parameters: string[] = [], unknown: string[] = []
  for (const k of Object.keys(body)) {
    if (CONTENT_FIELDS.has(k)) decomposed.push(k)
    else if (PARAMETER_FIELDS.has(k)) parameters.push(k)
    else unknown.push(k)
  }
  return { decomposed, parameters, unknown, residual: 0 }
}

/** Where this element ENDS in the request, so an exact prefix can be rebuilt for it. Differencing
 *  consecutive prefixes is what turns count_tokens into per-element attribution. */
export type CtxCut =
  | { kind: 'system'; upto: number }
  | { kind: 'tool'; upto: number }
  | { kind: 'msg'; mi: number; bi: number; textEnd?: number }

/** One thing that occupies context: a system block, a tool schema, a message block, or a named
 *  section carved out of a large injected block. */
export interface CtxElement {
  section: string
  label: string
  detail: string
  chars: number
  /** Uncalibrated estimator output; kept so a caller can recalibrate against a different total. */
  raw: number
  tokens: number
  cut?: CtxCut
  /** Per-element provenance. 'exact' = its own prefix difference was measured. 'merged' = the API
   *  forbids a request ending at this block (an assistant message may not end with `thinking`; a
   *  `tool_use` requires its `tool_result`), so its tokens are counted inside the next element —
   *  nothing is lost, only the granularity at that one boundary. */
  tokenSource?: TokenSource | 'exact' | 'merged'
}
export interface CtxReport {
  file: string
  model: string
  messageCount: number
  toolCount: number
  agent: string
  exact: number | null
  usage: Usage | null
  source: TokenSource
  /** How many responses could have been this request's. >1 is normal; see pairAmbiguous. */
  pairCandidates: number
  /** True when the viable responses disagree enough that the choice changes the answer. */
  pairAmbiguous: boolean
  /** exact = every number measured by count_tokens; calibrated = estimator scaled to a paired
   *  response total; estimated = estimator only. */
  mode: 'exact' | 'calibrated' | 'estimated'
  /** How many elements got their own measured prefix difference (mode 'exact' only). */
  exactElements: number
  coverage: CtxCoverage
  total: number
  elements: CtxElement[]
}

// ── io ────────────────────────────────────────────────────────────────────────

/** A dir in the read scope stat'd as a directory when the scope was resolved, but permissions can
 *  still deny the listing — and a scan that dies on one dir reports nothing about the others. */
function safeReaddir(d: string): string[] {
  try { return fs.readdirSync(d) } catch { return [] }
}

/** Dirs that may hold captured bodies. NEVER hardcode `<dataDir>/otel-bodies`: a configured spool
 *  moves the live traffic elsewhere and the legacy dir then reads as "no traffic" (ATOM-INVB-BLIND
 *  — the same defect once blinded investigate_burn). */
function bodyDirs(): string[] {
  const { dir } = resolveDataDir()
  return resolveBodiesReadScope(dir, process.env).dirs
}

const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function resolveRequestPath(arg: string): string {
  // isFile, not existsSync: a directory passes existsSync and then fails deep inside readFileSync
  // with EISDIR, which reads as a corrupt capture rather than "that's a folder".
  if (isFile(arg)) return arg
  const dirs = bodyDirs()
  for (const d of dirs) {
    const direct = path.join(d, arg)
    if (isFile(direct)) return direct
    // Accept a bare id prefix — the capture filenames are uuids nobody types in full. A prefix that
    // matches several is REFUSED rather than resolved to whichever readdir happened to return
    // first: silently analyzing a different request than the one asked for is the one failure this
    // tool must never have.
    const hits = safeReaddir(d).filter(f => f.startsWith(arg) && f.endsWith('.request.json'))
    if (hits.length === 1) return path.join(d, hits[0])
    if (hits.length > 1) {
      throw Object.assign(
        new Error(`${JSON.stringify(arg)} matches ${hits.length} captured requests — use a longer prefix:\n  ${hits.slice(0, 10).join('\n  ')}`),
        { exitCode: EXIT.USAGE })
    }
  }
  throw Object.assign(new Error(`no captured request matches ${JSON.stringify(arg)} (looked in: ${dirs.join(', ') || 'no readable body dirs'})`), { exitCode: EXIT.USAGE })
}

export interface Pairing { usage: Usage; exact: number; candidates: number; ambiguous: boolean }

// A response lands within seconds of its request. The small negative slop absorbs mtime granularity
// and flush ordering; the upper bound is generous because a long generation delays the write.
const PAIR_WINDOW_MS = 180_000
const PAIR_MIN_DT_MS = -2_000
// Enough to cover any realistic burst; a bound so a pathological spool cannot turn one analysis
// into thousands of parses.
const PAIR_MAX_CANDIDATES = 64
// Size is a REJECTION filter, never a ranking key. The estimator is biased LOW on this content
// (measured: 161,685 estimated vs 225,825 billed on a captured subagent request — 2.56 chars/token),
// so ranking candidates by closeness to the estimate would systematically prefer a too-small
// response, i.e. the wrong one. These bounds are deliberately loose enough that the bias cannot flip
// a decision — they exist only to throw out a neighbour that is plainly a different call.
const PAIR_MIN_RATIO = 0.4
const PAIR_MAX_RATIO = 3.0

/** THE PAIRING IS A HEURISTIC AND THE OUTPUT MUST SAY SO. The spool names requests by uuid and
 *  responses by `req_<id>`, so they cannot be paired by name, and nothing on disk links one to the
 *  other: the correlation the server keeps in `callBodyRegistry` is live-only (an empty map in a
 *  fresh CLI process). Two deterministic routes were tried and both failed on real captures —
 *  `diagnostics.previous_message_id` chains a request to its PREDECESSOR's response, but resolving
 *  it needs the successor call, which 0 of 3 sampled requests had inside a 300s window (and the
 *  newest request, the one you most want to analyze, can never have one); and `metadata.session_id`
 *  cannot group a chain because concurrent streams share one session id (measured: interleaved
 *  57/276/323-message conversations under session 04332240).
 *
 *  So: rank by ARRIVAL TIME, which is physically grounded (a response is written milliseconds after
 *  its request), and use size only to REJECT a candidate that is plainly some other call. Size must
 *  not rank — see PAIR_MIN_RATIO. `ambiguous` is then simply "more than one candidate survived",
 *  which is the honest statement: the pairing was not verifiable. */
function pairUsage(requestPath: string, model: string | undefined, rawTotal: number): Pairing | null {
  const dir = path.dirname(requestPath)
  let t0: number
  try { t0 = fs.statSync(requestPath).mtimeMs } catch { return null }

  const near: { p: string; dt: number }[] = []
  for (const f of safeReaddir(dir)) {
    if (!f.endsWith('.response.json')) continue
    const p = path.join(dir, f)
    let dt: number
    try { dt = fs.statSync(p).mtimeMs - t0 } catch { continue }
    if (dt < PAIR_MIN_DT_MS || dt > PAIR_WINDOW_MS) continue
    near.push({ p, dt })
  }
  // Closest in time first, so an exact tie on size resolves to the response that actually followed
  // this request rather than to readdir order.
  near.sort((a, b) => Math.abs(a.dt) - Math.abs(b.dt))

  const bodies: ResponseBody[] = []
  for (const c of near.slice(0, PAIR_MAX_CANDIDATES)) {
    try { bodies.push(readBody(c.p) as ResponseBody) } catch { continue }
  }
  return selectPairing(bodies, model, rawTotal)
}


/** The pairing rule, separated from the io so it can be tested directly. `cands` arrives ordered
 *  closest-in-time first, which is what breaks an exact tie on size. */
export function selectPairing(cands: ResponseBody[], model: string | undefined, rawTotal: number): Pairing | null {
  let best: { usage: Usage; exact: number } | undefined
  let survivors = 0
  for (const r of cands) {
    if (model && r.model && r.model !== model) continue
    const u = r.usage ?? {}
    const exact = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    if (exact <= 0) continue
    const ratio = exact / Math.max(1, rawTotal)
    if (ratio < PAIR_MIN_RATIO || ratio > PAIR_MAX_RATIO) continue
    survivors++
    // cands arrive closest-in-time first, so the FIRST survivor is the nearest one.
    if (!best) best = { usage: u, exact }
  }
  if (!best) return null
  return { usage: best.usage, exact: best.exact, candidates: survivors, ambiguous: survivors > 1 }
}

// ── classification ────────────────────────────────────────────────────────────

// Ordered; first match wins. Data, not branches, so a new harness marker is one line.
const RULES: [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/^x-anthropic-billing-header:/, 'billing-header'],
  [/^You are Claude Code, Anthropic's official CLI/, 'harness-identity'],
  [/<command-message>([^<]+)<\/command-message>/, m => `skill:${m[1]}`],
  [/^# claudeMd\b/m, 'claudeMd'],
  [/^Contents of (\S+)/m, m => `file:${path.basename(m[1])}`],
  [/Available agent types for the Agent tool/i, 'agent-listing'],
  [/The following skills are available/i, 'skill-listing'],
  [/MCP servers have provided instructions/i, 'mcp-instructions'],
  [/^gitStatus:/m, 'git-status'],
  [/^<system-reminder>/, 'system-reminder'],
]
function classify(text: string): string {
  for (const [re, label] of RULES) {
    const m = re.exec(text)
    if (m) return typeof label === 'function' ? label(m) : label
  }
  return 'text'
}

/** Carve a large injected block into named sections, so "218k tokens of context" becomes a list of
 *  files. Every byte lands in exactly one section (the leading remainder becomes `preamble`) — a
 *  decomposer that drops bytes misreports the total it is meant to explain. */
export function splitInjected(text: string): { label: string; text: string }[] {
  const marks: { at: number; label: string }[] = []
  const push = (re: RegExp, make: (name: string) => string): void => {
    for (const m of text.matchAll(re)) marks.push({ at: m.index ?? 0, label: make(m[1]) })
  }
  push(/^Contents of (\S+)/gm, n => `file:${path.basename(n)}`)
  push(/<command-message>([^<]+)<\/command-message>/g, n => `skill:${n}`)
  push(/^# (claudeMd|userEmail|currentDate|gitStatus)\b/gm, n => `meta:${n}`)
  marks.sort((a, b) => a.at - b.at)
  if (marks.length === 0) return [{ label: classify(text), text }]
  const out: { label: string; text: string }[] = []
  if (marks[0].at > 0) out.push({ label: 'preamble', text: text.slice(0, marks[0].at) })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length
    out.push({ label: marks[i].label, text: text.slice(marks[i].at, end) })
  }
  return out
}

// Below this size a message is one element; above it, decomposing pays for itself.
const SPLIT_THRESHOLD = 20_000

export function extractElements(req: RequestBody): CtxElement[] {
  const els: CtxElement[] = []
  const add = (section: string, label: string, text: string, detail = '', cut?: CtxCut): void => {
    els.push({ section, label, detail, chars: text.length, raw: countTokens(text), tokens: 0, cut })
  }

  ;(req.system ?? []).forEach((b, i) => {
    const t = typeof b === 'string' ? b : (b.text ?? '')
    add('system', classify(t), t, `system[${i}]`, { kind: 'system', upto: i })
  })

  // Tool schemas are context too — and they are where the Skill / Agent / MCP surface is paid for.
  ;(req.tools ?? []).forEach((t, i) => {
    add('tools', `tool:${t.name ?? '?'}`, JSON.stringify(t), (t.description ?? '').slice(0, 60), { kind: 'tool', upto: i })
  })

  ;(req.messages ?? []).forEach((m, i) => {
    const content: ContentBlock[] = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content ?? '') }]
    const section = `messages/${m.role ?? '?'}`
    content.forEach((b, j) => {
      const where = `msg[${i}].${j}`
      const cut: CtxCut = { kind: 'msg', mi: i, bi: j }
      if (b.type === 'text') {
        const t = b.text ?? ''
        const parts = t.length > SPLIT_THRESHOLD ? splitInjected(t) : [{ label: classify(t), text: t }]
        // Each section ends at a byte offset in this block, so its exact cost is the difference
        // between the prefix ending there and the one ending at the section before it.
        let end = 0
        for (const p of parts) {
          end += p.text.length
          add(section, p.label, p.text, where, parts.length > 1 ? { ...cut, textEnd: end } : cut)
        }
      } else if (b.type === 'tool_use') {
        add(section, `tool_use:${b.name ?? '?'}`, JSON.stringify(b.input ?? {}), where, cut)
      } else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        add(section, 'tool_result', t, where, cut)
      } else if (b.type === 'thinking') {
        add(section, 'thinking', b.thinking ?? '', where, cut)
      } else {
        add(section, b.type ?? 'unknown', JSON.stringify(b), where, cut)
      }
    })
  })
  return els
}

/** Rebuild the request truncated at `cut` — the countable prefix whose difference from the previous
 *  one is this element's exact cost. System/tool prefixes need a message (the API requires one), so
 *  they carry a fixed one-token stand-in that cancels out in the differencing. */
export const PREFIX_STUB = { role: 'user', content: 'x' }

export function buildPrefix(req: RequestBody, cut: CtxCut): CountableRequest {
  const model = req.model ?? ''
  const sys = req.system ?? []
  const tools = req.tools ?? []
  if (cut.kind === 'system') {
    return { model, system: sys.slice(0, cut.upto + 1), messages: [PREFIX_STUB] }
  }
  if (cut.kind === 'tool') {
    return { model, ...(sys.length ? { system: sys } : {}), tools: tools.slice(0, cut.upto + 1), messages: [PREFIX_STUB] }
  }
  const msgs = req.messages ?? []
  const head = msgs.slice(0, cut.mi).map(m => ({ role: m.role, content: m.content }))
  const m = msgs[cut.mi]
  const content: ContentBlock[] = Array.isArray(m?.content)
    ? m.content
    : [{ type: 'text', text: String(m?.content ?? '') }]
  const kept: ContentBlock[] = content.slice(0, cut.bi)
  const at = content[cut.bi]
  if (at) {
    kept.push(cut.textEnd !== undefined && at.type === 'text'
      ? { type: 'text', text: (at.text ?? '').slice(0, cut.textEnd) }
      : at)
  }
  return {
    model,
    ...(sys.length ? { system: sys } : {}),
    ...(tools.length ? { tools } : {}),
    messages: [...head, { role: m?.role ?? 'user', content: kept }],
  }
}

export function analyzeRequest(file: string): CtxReport {
  return loadAndAnalyze(file).report
}

/** Same analysis, but keeps the parsed body so the exact pass can rebuild prefixes from it without
 *  re-reading and re-parsing a multi-megabyte capture. */
export function loadAndAnalyze(file: string): { p: string; req: RequestBody; report: CtxReport } {
  const p = resolveRequestPath(file)
  const req = readBody(p) as RequestBody
  const els = extractElements(req)
  const rawTotal = els.reduce((a, e) => a + e.raw, 0)
  const pair = pairUsage(p, req.model, rawTotal)
  // Guard the scale band: outside it the blocks structurally do not cover the measured total, so
  // scaling would misattribute invisible tokens onto visible rows. calibrateTokens then keeps the
  // raw estimates and says 'estimated'.
  const { tokens, source } = calibrateTokens(els.map(e => e.raw), pair?.exact, { minScale: 0.3, maxScale: 3 })
  els.forEach((e, i) => { e.tokens = tokens[i] })
  const agent = (req.system ?? [])
    .map(b => (typeof b === 'string' ? b : (b.text ?? '')))
    .find(t => t.length > 200 && !/^x-anthropic-billing/.test(t)) ?? ''
  const report: CtxReport = {
    file: path.basename(p),
    model: req.model ?? '?',
    messageCount: (req.messages ?? []).length,
    toolCount: (req.tools ?? []).length,
    agent: agent.slice(0, 120).replace(/\s+/g, ' '),
    exact: pair?.exact ?? null,
    usage: pair?.usage ?? null,
    source,
    pairCandidates: pair?.candidates ?? 0,
    pairAmbiguous: pair?.ambiguous ?? false,
    mode: source === 'calibrated' ? 'calibrated' : 'estimated',
    exactElements: 0,
    coverage: auditCoverage(req as unknown as Record<string, unknown>),
    total: tokens.reduce((a, b) => a + b, 0),
    elements: els,
  }
  return { p, req, report }
}

// ── exact counting ────────────────────────────────────────────────────────────

/** The only two API errors that mean "this block cannot terminate a request" rather than "counting
 *  failed". Both are message-sequence rules, so the block's tokens are simply charged to the next
 *  measurable boundary. Everything else is a genuine failure and must stay visible. */
const MERGEABLE_ERRORS = [
  /final block in an assistant message cannot be/i,
  /tool_use.{0,40}without .{0,20}tool_result/i,
]

/** Replace every estimated number with a MEASURED one.
 *
 *  Each element's cost is the difference between the count of the request truncated just after it
 *  and the count truncated just before it. Prefixes are grouped so the differences chain cleanly:
 *  system blocks and tool schemas are counted against a one-token stub message, message content is
 *  counted against the full system+tools, and the stub cancels when the two chains are joined.
 *
 *  A prefix the API rejects (an intermediate message shape it will not validate) leaves that one
 *  element estimated and is reported; the rest of the report stays exact. Nothing is invented for a
 *  step that could not be measured. */
export async function exactifyReport(
  r: CtxReport, req: RequestBody, auth: AnthropicAuth, concurrency = 4,
): Promise<{ failed: number; merged: number; failures: { label: string; error: string }[] }> {
  const model = req.model ?? ''
  const stubOnly: CountableRequest = { model, messages: [PREFIX_STUB] }
  const stub = await countTokensExact(stubOnly, auth)

  const cuts = r.elements.map(e => e.cut)
  const why = new Map<number, string>()
  const counts = await mapLimit(r.elements, concurrency, async (el, i): Promise<number | null> => {
    if (!el.cut) { why.set(i, 'no prefix descriptor'); return null }
    try { return await countTokensExact(buildPrefix(req, el.cut), auth) } catch (e) {
      why.set(i, (e as Error).message)
      return null
    }
  })

  // Where each chain ends, so the next chain can be rebased onto it.
  const lastOf = (kind: CtxCut['kind']): number | null => {
    for (let i = r.elements.length - 1; i >= 0; i--) if (cuts[i]?.kind === kind && counts[i] != null) return counts[i]
    return null
  }
  const sysEnd = lastOf('system') ?? stub
  const toolEnd = lastOf('tool') ?? sysEnd
  // system_all + tools_all, with the stub removed — the constant every message prefix carries.
  const preamble = toolEnd - stub

  let failed = 0, merged = 0
  const failures: { label: string; error: string }[] = []
  const pending: string[] = []
  let prevSys = stub, prevTool = sysEnd, prevMsg = 0
  for (let i = 0; i < r.elements.length; i++) {
    const el = r.elements[i], cum = counts[i], cut = cuts[i]
    if (cum == null || !cut) {
      const err = why.get(i) ?? 'unknown'
      // ONLY the two message-sequence rules mean "this block cannot legally END a request": the
      // running cumulative is left untouched, so these tokens land in the next element's difference
      // and the report stays exact, just coarser at that boundary.
      //
      // Matching any 400 here was a real defect: a SYSTEMIC 400 (a schema field the endpoint
      // rejects) failed all 671 elements, each silently "merged" to zero, and the report then
      // claimed mode=exact with a total of nothing. A blanket rule turns a total failure into a
      // confident empty answer, so the match must name the two errors it forgives.
      if (MERGEABLE_ERRORS.some(re => re.test(err))) {
        el.tokens = 0
        el.tokenSource = 'merged'
        // Remember what merged, so the row that absorbs these tokens names them. A `tool_result` row
        // that silently also contains a thinking block and a tool_use is a row that misattributes.
        pending.push(el.label)
        merged++
      } else {
        el.tokenSource = r.source
        failed++
        failures.push({ label: `${el.section} ${el.label} ${el.detail}`, error: err })
      }
      continue
    }
    let delta: number
    if (cut.kind === 'system') { delta = cum - prevSys; prevSys = cum }
    else if (cut.kind === 'tool') { delta = cum - prevTool; prevTool = cum }
    else {
      const msgCum = cum - preamble
      delta = msgCum - prevMsg
      prevMsg = msgCum
    }
    // A boundary token can be charged to either side of a cut, so a delta may land marginally
    // negative. Clamp rather than print a negative row; the neighbour keeps the token.
    el.tokens = Math.max(0, delta)
    el.tokenSource = 'exact'
    if (pending.length) {
      el.label = `${pending.join('+')}+${el.label}`
      pending.length = 0
    }
  }

  // A run where almost nothing could be measured is a systemic problem (auth, schema, connectivity),
  // not a set of per-element quirks. Refusing is the only honest outcome: a report assembled from
  // near-total failure would still print a total, and that total would be fiction.
  const measured = r.elements.length - failed - merged
  if (r.elements.length > 0 && measured === 0) {
    throw new Error('exact counting measured 0 of ' + r.elements.length + ' elements — '
      + (failures[0]?.error ?? why.values().next().value ?? 'no diagnostic'))
  }

  r.exactElements = measured
  r.total = r.elements.reduce((a, e) => a + e.tokens, 0)
  if (failed === 0) {
    r.mode = 'exact'
    // Residual = what the whole-request count contains that the per-element chain did not attribute
    // (the JSON envelope around messages, and any boundary rounding from the clamp above). Surfacing
    // it is the completeness guarantee: if any content were being skipped, it would show up here as
    // a large number instead of vanishing from the report.
    // The whole-request count, not the sum of parts: it is the number the API would bill, measured
    // on the untruncated body exactly as captured.
    r.exact = await countTokensExact(countable({ ...req } as Record<string, unknown>), auth)
    r.coverage.residual = r.exact - r.total
  }
  return { failed, merged, failures }
}

// ── rendering ─────────────────────────────────────────────────────────────────

const fmt = (n: number): string => n.toLocaleString('en-US')
function bar(frac: number, w = 22): string {
  const full = Math.round(Math.max(0, Math.min(1, frac)) * w)
  return '█'.repeat(full) + '·'.repeat(w - full)
}
function rollup(els: CtxElement[], key: 'section' | 'label'): [string, number][] {
  const g = new Map<string, number>()
  for (const e of els) g.set(e[key], (g.get(e[key]) ?? 0) + e.tokens)
  return [...g].sort((a, b) => b[1] - a[1])
}

export function renderReport(r: CtxReport, topN: number): string {
  const L: string[] = []
  const pct = (v: number): string => `${(Math.round((v / Math.max(1, r.total)) * 1000) / 10).toFixed(1)}%`
  L.push(`${r.file}`)
  L.push(`  model=${r.model}  messages=${r.messageCount}  tools=${r.toolCount}`)
  if (r.agent) L.push(`  system: ${JSON.stringify(r.agent)}`)
  if (r.mode === 'exact') {
    // No pairing, no estimator, no scale factor: every number below was measured by count_tokens on
    // the captured bytes.
    L.push(`  EXACT input=${fmt(r.exact ?? 0)} tokens — measured via count_tokens, ${r.exactElements} elements each measured`)
  } else if (r.usage) {
    const raw = r.elements.reduce((a, e) => a + e.raw, 0)
    L.push(`  billed input=${fmt(r.exact ?? 0)}  (in=${fmt(r.usage.input_tokens ?? 0)}`
      + ` cache_create=${fmt(r.usage.cache_creation_input_tokens ?? 0)}`
      + ` cache_read=${fmt(r.usage.cache_read_input_tokens ?? 0)})`
      + `  scale=${((r.exact ?? 0) / Math.max(1, raw)).toFixed(2)}x`)
    L.push(r.pairAmbiguous
      // Naming the method beats a confidence adjective: a reader who knows it is "nearest response
      // in time, of this model, of a plausible size" can judge it against their own situation.
      ? `  pairing: nearest response by arrival time — ${r.pairCandidates} could have been this request's, so the total is NOT verified`
      : '  pairing: the only response in the window that could be this request\'s')
    L.push('  run without --estimate for exact per-element counts')
  } else {
    L.push('  no paired response — numbers are ESTIMATED, do not quote them as exact')
  }
  if (r.usage && r.mode === 'exact') {
    // The one thing count_tokens cannot give: how the input was actually BILLED. That axis lives
    // only on the response, and the 5m/1h split is what decides the cache-write rate.
    L.push(`  billed as: uncached=${fmt(r.usage.input_tokens ?? 0)}`
      + ` cache_write=${fmt(r.usage.cache_creation_input_tokens ?? 0)}`
      + ` cache_read=${fmt(r.usage.cache_read_input_tokens ?? 0)} (pairing heuristic)`)
  }
  L.push(`  counts=${r.mode}  total=${fmt(r.total)} tokens across ${r.elements.length} elements`)
  const cov = r.coverage
  L.push(`  coverage: decomposed=[${cov.decomposed.join(' ')}]  non-tokenizing params=${cov.parameters.length}`
    + (r.mode === 'exact' ? `  unattributed=${fmt(cov.residual)}` : ''))
  if (cov.unknown.length) {
    // An unrecognised top-level field may carry content this tool is not decomposing. Say so loudly
    // rather than letting the report imply full coverage.
    L.push(`  WARNING: unrecognised request field(s) not decomposed: ${cov.unknown.join(', ')}`)
  }
  for (const key of ['section', 'label'] as const) {
    L.push('', `  by ${key}`)
    for (const [k, v] of rollup(r.elements, key).slice(0, key === 'section' ? 99 : topN)) {
      L.push(`    ${bar(v / Math.max(1, r.total))} ${pct(v).padStart(6)} ${fmt(v).padStart(10)}  ${k}`)
    }
  }
  L.push('', `  top ${topN} individual elements`)
  for (const e of [...r.elements].sort((a, b) => b.tokens - a.tokens).slice(0, topN)) {
    L.push(`    ${fmt(e.tokens).padStart(10)} ${pct(e.tokens).padStart(6)}  ${e.section.padEnd(16)} ${e.label.padEnd(38)} ${e.detail}`)
  }
  return L.join('\n')
}

/** Diff keyed on (section,label) so "same element, bigger" and "new element" stay distinguishable —
 *  which is the whole question when asking what a turn added to the context. */
export function renderDiff(a: CtxReport, b: CtxReport): string {
  const roll = (r: CtxReport): Map<string, number> => {
    const m = new Map<string, number>()
    for (const e of r.elements) {
      const k = `${e.section}\t${e.label}`
      m.set(k, (m.get(k) ?? 0) + e.tokens)
    }
    return m
  }
  const A = roll(a), B = roll(b)
  const rows: { k: string; x: number; y: number; d: number }[] = []
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k) ?? 0, y = B.get(k) ?? 0
    if (x !== y) rows.push({ k, x, y, d: y - x })
  }
  rows.sort((p, q) => Math.abs(q.d) - Math.abs(p.d))
  const L: string[] = []
  L.push(`DIFF  A=${a.file}  ${fmt(a.total)} tokens (${a.source})`)
  L.push(`      B=${b.file}  ${fmt(b.total)} tokens (${b.source})`)
  L.push(`      net ${b.total - a.total >= 0 ? '+' : ''}${fmt(b.total - a.total)}`)
  if (a.mode === 'exact' && b.mode === 'exact') {
    // Exact counts do not drift, so an unchanged row shows a delta of exactly zero and every row
    // printed below is a real change. This is the difference the exact pass buys in a diff.
    L.push('      both sides measured exactly — every row below is a real change, not calibration drift')
  } else if (a.mode !== b.mode) {
    L.push(`      NOTE: sides are not comparable — A is ${a.mode}, B is ${b.mode}`)
  } else if (a.source !== 'calibrated' || b.source !== 'calibrated') {
    L.push('      NOTE: at least one side is uncalibrated — the delta mixes measured and estimated counts')
  } else {
    // Each side is scaled to ITS OWN exact total, so a section whose bytes did not change still
    // shows a small delta. Say so: without this line a reader concludes CLAUDE.md grew by ~1%
    // between two turns, which it did not. Deltas well under a percent of the row are drift.
    L.push('      NOTE: sides are calibrated independently, so unchanged content shows small (<1%) deltas')
  }
  L.push('')
  if (rows.length === 0) { L.push('  (identical composition)'); return L.join('\n') }
  for (const r of rows.slice(0, 40)) {
    const [sec, lab] = r.k.split('\t')
    L.push(`  ${(r.d > 0 ? '+' : '') + fmt(r.d)}`.padEnd(14) + `${fmt(r.x).padStart(10)} → ${fmt(r.y).padStart(10)}  ${sec.padEnd(16)} ${lab}`)
  }
  return L.join('\n')
}

// ── cli ───────────────────────────────────────────────────────────────────────

function listRequests(limit: number): string[] {
  const rows: { p: string; m: number }[] = []
  for (const d of bodyDirs()) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.request.json')) continue
      const p = path.join(d, f)
      try { rows.push({ p, m: fs.statSync(p).mtimeMs }) } catch { /* raced away */ }
    }
  }
  return rows.sort((a, b) => b.m - a.m).slice(0, limit).map(r => r.p)
}

/** Analyze, then measure — unless the caller opted out. Exact counting costs one count_tokens call
 *  per element (free of inference charges, but rate-limited), so it is announced, never silent. */
async function analyzeMaybeExact(file: string, exact: boolean): Promise<CtxReport> {
  const { req, report } = loadAndAnalyze(file)
  if (!exact) return report
  const auth = resolveAnthropicAuth()
  if (!auth) {
    console.error('ctxmap: no credential for count_tokens (set ANTHROPIC_API_KEY, or log in to Claude Code)'
      + ' — falling back to estimated counts')
    return report
  }
  // One call per element, each carrying a prefix of the body — say so before spending a minute on a
  // large request rather than appearing to hang.
  console.error(`ctxmap: measuring ${report.elements.length} elements via count_tokens (auth: ${auth.source})`
    + `${report.elements.length > 200 ? ' — large request, expect a minute or more' : ''}…`)
  const { failed, merged, failures } = await exactifyReport(report, req, auth)
  for (const f of failures.slice(0, 5)) console.error(`ctxmap: not measured — ${f.label}: ${f.error}`)
  if (failed > 0) console.error(`ctxmap: ${failed} element(s) stay estimated`)
  if (merged > 0) {
    console.error(`ctxmap: ${merged} block(s) cannot legally end a request (thinking / unanswered tool_use)`
      + ' — their tokens are counted in the next element, so the total stays exact')
  }
  return report
}

export async function runCtxmapCli(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(CTXMAP_USAGE)
    return argv.length === 0 ? EXIT.USAGE : 0
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    const v = i >= 0 ? argv[i + 1] : undefined
    // `--out --json` must not resolve to a file literally named "--json".
    return v?.startsWith('--') ? undefined : v
  }
  const topN = Number(flag('--top')) || 20
  const outFile = flag('--out')
  const asJson = argv.includes('--json')

  const emit = (text: string, digest: string): number => {
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
      fs.writeFileSync(outFile, text.endsWith('\n') ? text : `${text}\n`)
      console.log(`${digest} → ${outFile}`)
    } else {
      console.log(text)
    }
    return 0
  }

  try {
    if (argv[0] === '--list') {
      const files = listRequests(Number(flag('--limit')) || 20)
      if (files.length === 0) {
        console.error(`no captured requests found in: ${bodyDirs().join(', ') || '(no readable body dirs)'}`)
        return EXIT.USAGE
      }
      return emit(files.map(f => path.basename(f)).join('\n'), `${files.length} request(s)`)
    }

    if (argv[0] === '--find') {
      const needle = argv[1]
      if (!needle) { console.error('--find needs a substring'); return EXIT.USAGE }
      const hits: string[] = []
      for (const d of bodyDirs()) {
        for (const f of safeReaddir(d)) {
          if (!f.endsWith('.request.json')) continue
          let body: RequestBody
          try { body = readBody(path.join(d, f)) as RequestBody } catch { continue }
          // Search the WHOLE request, not just `system`. Assuming injected context lives in the
          // system prompt is the exact misconception this tool exists to correct: CLAUDE.md and the
          // rules arrive as messages[0], so a system-only --find could not locate the single
          // biggest thing in the context (measured: 52k of 226k tokens at msg[0].0).
          const where = JSON.stringify(body.system ?? '').includes(needle) ? 'system'
            : JSON.stringify(body.messages ?? '').includes(needle) ? 'messages'
              : JSON.stringify(body.tools ?? '').includes(needle) ? 'tools' : ''
          if (!where) continue
          hits.push(`${f}  in=${where} model=${body.model ?? '?'} msgs=${(body.messages ?? []).length} tools=${(body.tools ?? []).length}`)
        }
      }
      return emit(hits.join('\n') || '(no match)', `${hits.length} match(es)`)
    }

    const exact = !argv.includes('--estimate')

    if (argv[0] === '--diff') {
      const [, A, B] = argv
      if (!A || !B) { console.error('--diff needs two requests'); return EXIT.USAGE }
      const a = await analyzeMaybeExact(A, exact), b = await analyzeMaybeExact(B, exact)
      if (asJson) return emit(JSON.stringify({ a, b }, null, 2), 'diff')
      return emit(renderDiff(a, b), `net ${b.total - a.total >= 0 ? '+' : ''}${fmt(b.total - a.total)} tokens`)
    }

    const r = await analyzeMaybeExact(argv[0], exact)
    const digest = `${fmt(r.total)} tokens (${r.mode}) across ${r.elements.length} elements`
    return emit(asJson ? JSON.stringify(r, null, 2) : renderReport(r, topN), digest)
  } catch (e) {
    const err = e as Error & { exitCode?: number }
    console.error(`ctxmap: ${err.message}`)
    return err.exitCode ?? 1
  }
}
