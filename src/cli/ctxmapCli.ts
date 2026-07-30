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
// TOKEN ACCURACY. Per-element counts come from the repo's ONE estimator (src/tokenEstimator.ts,
// ±10-15%), then are CALIBRATED to the exact input total taken from the paired response's `usage`
// via calibrateTokens. So the column sums EXACTLY to what was billed and the split between
// elements is consistent with Claude's real tokenization. With no pairable response the numbers
// are labelled `estimated` and must not be quoted as exact — the label is part of the output, not
// a footnote, because an uncalibrated number that looks exact is worse than no number.

import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { resolveDataDir } from '../dataDir'
import { resolveBodiesReadScope } from '../captureConfig'
import { countTokens, calibrateTokens } from '../tokenEstimator'
import type { TokenSource } from '../shared/summarizerTypes'
import { EXIT } from './cliErrors'

export const CTXMAP_USAGE = `agentlenspro ctxmap — what is actually inside a captured API request

  ctxmap <request.json>            decompose one request; every element, with tokens
  ctxmap --diff <A> <B>            what changed in the context between two requests
  ctxmap --find <text>             list captured requests whose SYSTEM prompt contains <text>
  ctxmap --list [--limit N]        most recent captured requests

  --top N     how many individual elements to show (default 20)
  --json      machine-readable output
  --out FILE  write the full report to FILE; print only a one-line digest

Token counts are calibrated to the exact input total from the paired response when one can be
found, and labelled 'estimated' when it cannot.`

// ── shapes ────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  thinking?: string
}
interface Message { role?: string; content?: ContentBlock[] | string }
interface ToolDef { name?: string; description?: string }
interface RequestBody {
  model?: string
  system?: (ContentBlock | string)[]
  messages?: Message[]
  tools?: ToolDef[]
}
interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

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
  total: number
  elements: CtxElement[]
}

// ── io ────────────────────────────────────────────────────────────────────────

function readBody(p: string): unknown {
  let raw = fs.readFileSync(p)
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw)
  return JSON.parse(raw.toString('utf8'))
}

/** Dirs that may hold captured bodies. NEVER hardcode `<dataDir>/otel-bodies`: a configured spool
 *  moves the live traffic elsewhere and the legacy dir then reads as "no traffic" (ATOM-INVB-BLIND
 *  — the same defect once blinded investigate_burn). */
function bodyDirs(): string[] {
  const { dir } = resolveDataDir()
  return resolveBodiesReadScope(dir, process.env).dirs
}

function resolveRequestPath(arg: string): string {
  if (fs.existsSync(arg)) return arg
  for (const d of bodyDirs()) {
    const direct = path.join(d, arg)
    if (fs.existsSync(direct)) return direct
    // Accept a bare id prefix — the capture filenames are uuids nobody types in full.
    const hit = fs.readdirSync(d).find(f => f.startsWith(arg) && f.endsWith('.request.json'))
    if (hit) return path.join(d, hit)
  }
  throw Object.assign(new Error(`no captured request matches ${JSON.stringify(arg)} (looked in: ${bodyDirs().join(', ') || 'no readable body dirs'})`), { exitCode: EXIT.USAGE })
}

/** The spool names requests by uuid and responses by `req_<id>`, so they cannot be paired by name.
 *  Pair on mtime — a response lands right after its request — then REQUIRE the model to match.
 *  Returns null rather than guessing: calibrating against another request's total would silently
 *  redistribute tokens across every row, which is worse than printing 'estimated'. */
function pairUsage(requestPath: string, model: string | undefined): { usage: Usage; exact: number } | null {
  const dir = path.dirname(requestPath)
  let t0: number
  try { t0 = fs.statSync(requestPath).mtimeMs } catch { return null }
  let best: { p: string; dt: number } | undefined
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.response.json')) continue
    const p = path.join(dir, f)
    let dt: number
    try { dt = fs.statSync(p).mtimeMs - t0 } catch { continue }
    if (dt < 0 || dt > 120_000) continue
    if (!best || dt < best.dt) best = { p, dt }
  }
  if (!best) return null
  try {
    const r = readBody(best.p) as { model?: string; usage?: Usage }
    if (model && r.model && r.model !== model) return null
    const u = r.usage ?? {}
    const exact = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    return exact > 0 ? { usage: u, exact } : null
  } catch { return null }
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
  const add = (section: string, label: string, text: string, detail = ''): void => {
    els.push({ section, label, detail, chars: text.length, raw: countTokens(text), tokens: 0 })
  }

  ;(req.system ?? []).forEach((b, i) => {
    const t = typeof b === 'string' ? b : (b.text ?? '')
    add('system', classify(t), t, `system[${i}]`)
  })

  // Tool schemas are context too — and they are where the Skill / Agent / MCP surface is paid for.
  for (const t of req.tools ?? []) {
    add('tools', `tool:${t.name ?? '?'}`, JSON.stringify(t), (t.description ?? '').slice(0, 60))
  }

  ;(req.messages ?? []).forEach((m, i) => {
    const content: ContentBlock[] = Array.isArray(m.content)
      ? m.content
      : [{ type: 'text', text: String(m.content ?? '') }]
    const section = `messages/${m.role ?? '?'}`
    content.forEach((b, j) => {
      const where = `msg[${i}].${j}`
      if (b.type === 'text') {
        const t = b.text ?? ''
        const parts = t.length > SPLIT_THRESHOLD ? splitInjected(t) : [{ label: classify(t), text: t }]
        for (const p of parts) add(section, p.label, p.text, where)
      } else if (b.type === 'tool_use') {
        add(section, `tool_use:${b.name ?? '?'}`, JSON.stringify(b.input ?? {}), where)
      } else if (b.type === 'tool_result') {
        const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        add(section, 'tool_result', t, where)
      } else if (b.type === 'thinking') {
        add(section, 'thinking', b.thinking ?? '', where)
      } else {
        add(section, b.type ?? 'unknown', JSON.stringify(b), where)
      }
    })
  })
  return els
}

export function analyzeRequest(file: string): CtxReport {
  const p = resolveRequestPath(file)
  const req = readBody(p) as RequestBody
  const els = extractElements(req)
  const pair = pairUsage(p, req.model)
  // Guard the scale band: outside it the blocks structurally do not cover the measured total, so
  // scaling would misattribute invisible tokens onto visible rows. calibrateTokens then keeps the
  // raw estimates and says 'estimated'.
  const { tokens, source } = calibrateTokens(els.map(e => e.raw), pair?.exact, { minScale: 0.3, maxScale: 3 })
  els.forEach((e, i) => { e.tokens = tokens[i] })
  const agent = (req.system ?? [])
    .map(b => (typeof b === 'string' ? b : (b.text ?? '')))
    .find(t => t.length > 200 && !/^x-anthropic-billing/.test(t)) ?? ''
  return {
    file: path.basename(p),
    model: req.model ?? '?',
    messageCount: (req.messages ?? []).length,
    toolCount: (req.tools ?? []).length,
    agent: agent.slice(0, 120).replace(/\s+/g, ' '),
    exact: pair?.exact ?? null,
    usage: pair?.usage ?? null,
    source,
    total: tokens.reduce((a, b) => a + b, 0),
    elements: els,
  }
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
  if (r.usage) {
    L.push(`  EXACT input=${fmt(r.exact ?? 0)}  (in=${fmt(r.usage.input_tokens ?? 0)}`
      + ` cache_create=${fmt(r.usage.cache_creation_input_tokens ?? 0)}`
      + ` cache_read=${fmt(r.usage.cache_read_input_tokens ?? 0)})`)
  } else {
    L.push('  no paired response — numbers are ESTIMATED, do not quote them as exact')
  }
  L.push(`  counts=${r.source}  total=${fmt(r.total)} tokens across ${r.elements.length} elements`)
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
  if (a.source !== 'calibrated' || b.source !== 'calibrated') {
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

export function runCtxmapCli(argv: string[]): number {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(CTXMAP_USAGE)
    return argv.length === 0 ? EXIT.USAGE : 0
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
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
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith('.request.json')) continue
          let body: RequestBody
          try { body = readBody(path.join(d, f)) as RequestBody } catch { continue }
          if (!JSON.stringify(body.system ?? '').includes(needle)) continue
          hits.push(`${f}  model=${body.model ?? '?'} msgs=${(body.messages ?? []).length} tools=${(body.tools ?? []).length}`)
        }
      }
      return emit(hits.join('\n') || '(no match)', `${hits.length} match(es)`)
    }

    if (argv[0] === '--diff') {
      const [, A, B] = argv
      if (!A || !B) { console.error('--diff needs two requests'); return EXIT.USAGE }
      const a = analyzeRequest(A), b = analyzeRequest(B)
      if (asJson) return emit(JSON.stringify({ a, b }, null, 2), 'diff')
      return emit(renderDiff(a, b), `net ${b.total - a.total >= 0 ? '+' : ''}${fmt(b.total - a.total)} tokens`)
    }

    const r = analyzeRequest(argv[0])
    const digest = `${fmt(r.total)} tokens (${r.source}) across ${r.elements.length} elements`
    return emit(asJson ? JSON.stringify(r, null, 2) : renderReport(r, topN), digest)
  } catch (e) {
    const err = e as Error & { exitCode?: number }
    console.error(`ctxmap: ${err.message}`)
    return err.exitCode ?? 1
  }
}
