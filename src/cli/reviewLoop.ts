// src/cli/reviewLoop.ts — pure logic for the PreToolUse "propose -> two forks -> wait -> act"
// gate (plan `drifting-stirring-dream.md`, D1/D2/D3/D8, STAGE 1).
//
// NO IMPORT FROM ./reviewGate: stage 2 wires THIS module INTO reviewGate.ts, so an import in the
// other direction would cycle. Role/heading primitives (MEASURE_HEADING etc.) are therefore OWNED
// here rather than shared with reviewGate.ts's own (distinct, not-yet-unified) Stop-gate
// primitives of the same name — see the STAGE 1 report for the follow-up to unify them in stage 2.
//
// FS ACCESS IS INJECTABLE (`FsHelpers`) so tests exercise real temp directories instead of mocking
// the logic under test.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  PROPOSAL_LINE, commandWriteReason, scriptRunnerReason, isNeverGatedTarget,
  isNoReviewSentinel,
} from './reviewGateTriggers'
import { killSwitchPath } from './killSwitch'

export type Role = 'measure' | 'review'
export const MEASURE_HEADING = 'MEASURE-AND-VERIFY-REPORT'
export const REVIEW_HEADING = 'ADVERSARIAL-REVIEW'

// ── FS injection ─────────────────────────────────────────────────────────────────────────────
export interface FsHelpers {
  readFile: (p: string) => string | null
  exists: (p: string) => boolean
  readdir: (p: string) => string[]
  realpath: (p: string) => string | null
}
export const nodeFsHelpers: FsHelpers = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
  readdir: (p) => { try { return fs.readdirSync(p) } catch { return [] } },
  realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
}

function readLines(fh: FsHelpers, p: string): string[] | null {
  const text = fh.readFile(p)
  if (text === null) return null
  return text.split('\n')
}

// ── D1: gatedCall — what a PreToolUse call needs a window for ──────────────────────────────────

export type GatedKind = 'write' | 'runner' | 'read' | 'deny'
export interface GatedResult { kind: GatedKind; reason: string | null }

const READ_ONLY_ARTIFACT_ACTIONS = new Set([
  'list', 'read', 'list_types', 'comments', 'status', 'read_db', 'list_assets', 'read_asset',
  'list_files', 'read_file',
])
const READ_ONLY_DESIGNSYNC_METHODS = new Set(['list_projects', 'get_project', 'list_files', 'get_file'])
const READ_ONLY_REMOTETRIGGER_ACTIONS = new Set(['list', 'get', 'list_runs', 'get_run_log'])

/** A shape that only ever belongs to a HARNESS-WRITTEN completion, never to a caller-composed
 *  message body — used both to fail CLOSED on a forged completion (C2a: a CronCreate/
 *  ScheduleWakeup/RemoteTrigger body that quotes one of these markers is denied outright, because
 *  a real notification is never something a tool CALL carries) and to recognise a real one during
 *  confirmation (below). */
const NOTIFICATION_MARKER_RE = /<task-notification|<task-id>|<tool-use-id>|<status>/

const SETTINGS_GATE_TOKEN_RE = /review-gate|review-supervisor|AGENTLENS_DISABLED/
function settingsCandidates(cwd: string): string[] {
  return [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]
}

export interface GatedCallInput {
  file_path?: unknown
  notebook_path?: unknown
  command?: unknown
  action?: unknown
  method?: unknown
  to?: unknown
  body?: unknown
  prompt?: unknown
  old_string?: unknown
  new_string?: unknown
  content?: unknown
  [k: string]: unknown
}

/** Curl/wget invocations that MUTATE a remote resource (C6) — folded into the Bash write check
 *  alongside `commandWriteReason` rather than widening that shared classifier, since this rule is
 *  specific to the review loop (the delegate gate has no equivalent). */
const CURL_MUTATING_RE = /(^|\s)(-X|--request)\s+\S|(^|\s)(-d|--data\S*|-F|--form|-T|--upload-file|--json)(\s|=)/
const WGET_MUTATING_RE = /(^|\s)(--post-data|--post-file|--method)(\s|=)/
function networkWriteReason(cmd: string): string | null {
  if (/(^|[;&|]\s*)curl\b/.test(cmd) && CURL_MUTATING_RE.test(cmd)) return 'curl (mutating)'
  if (/(^|[;&|]\s*)wget\b/.test(cmd) && WGET_MUTATING_RE.test(cmd)) return 'wget (mutating)'
  return null
}

/** D1 classification of one PreToolUse call. `ctx.openRoleForkAgentIds` (B6/C4) lets a caller
 *  that already scanned the cycle deny a SendMessage aimed at a role fork still in flight; an
 *  unresolved/omitted set means every SendMessage passes (fail open on an unresolvable `to`,
 *  per C4). `ctx.isRoledFork` narrows Bash to the roled-fork runner allow-list (D3, B1/C1)
 *  instead of the ordinary write/runner split. */
export function gatedCall(
  toolName: string, toolInput: GatedCallInput, cwd: string,
  ctx: { openRoleForkAgentIds?: Set<string>; isRoledFork?: boolean; repoRoot?: string } = {},
): GatedResult {
  // B5/C3: the escape hatch itself is never gate-able, whatever else is true.
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command ?? '')
    if (/agentlenspro\s+(disable|enable)\b/.test(cmd) || /agentlenspro\s+--uninstall-hooks\b/.test(cmd)) {
      return { kind: 'deny', reason: 'the review-loop gate cannot be disabled from inside it — type `! agentlenspro disable` yourself if you truly need to' }
    }
    if (SETTINGS_GATE_TOKEN_RE.test(cmd) && /settings/.test(cmd) && commandWriteReason(cmd, cwd) !== null) {
      return { kind: 'deny', reason: 'a write touching review-gate/review-supervisor/AGENTLENS_DISABLED settings text is never gate-able — type `! agentlenspro disable` yourself if you truly need to' }
    }
  }
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') && !ctx.isRoledFork) {
    const file = String(toolInput?.file_path ?? '')
    const abs = path.resolve(cwd, file)
    if (abs === killSwitchPath()) {
      return { kind: 'deny', reason: 'a write to the kill-switch flag is never gate-able — type `! agentlenspro disable` yourself if you truly need to' }
    }
    if (settingsCandidates(cwd).includes(abs)) {
      const haystack = [toolInput?.content, toolInput?.old_string, toolInput?.new_string].map((x) => String(x ?? '')).join('\n')
      if (SETTINGS_GATE_TOKEN_RE.test(haystack)) {
        return { kind: 'deny', reason: 'a settings-file write mentioning review-gate/review-supervisor/AGENTLENS_DISABLED is never gate-able — type `! agentlenspro disable` yourself if you truly need to' }
      }
    }
  }

  switch (toolName) {
    case 'Edit': case 'Write': case 'NotebookEdit': case 'MultiEdit': {
      const file = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
      if (isNeverGatedTarget(file, cwd)) return { kind: 'read', reason: null }
      return { kind: 'write', reason: `${toolName} ${path.basename(file) || '(no target)'}` }
    }
    case 'Bash': {
      const cmd = String(toolInput?.command ?? '')
      const net = networkWriteReason(cmd)
      if (net !== null) return { kind: 'write', reason: net }
      const why = commandWriteReason(cmd, cwd)
      if (why !== null) return { kind: 'write', reason: why }
      const runnerWhy = scriptRunnerReason(cmd, cwd)
      if (runnerWhy !== null) return { kind: 'runner', reason: runnerWhy }
      return { kind: 'read', reason: null }
    }
    case 'Monitor': {
      // A2: classify the monitored command the same way a Bash call would be.
      const cmd = String(toolInput?.command ?? '')
      const why = commandWriteReason(cmd, cwd)
      if (why !== null) return { kind: 'write', reason: `Monitor: ${why}` }
      const runnerWhy = scriptRunnerReason(cmd, cwd)
      if (runnerWhy !== null) return { kind: 'runner', reason: `Monitor: ${runnerWhy}` }
      return { kind: 'read', reason: null }
    }
    case 'Artifact': {
      const action = String(toolInput?.action ?? '')
      // Unchecked/unknown action, or none at all, PUBLISHES (checklist f) — fail closed.
      if (action !== '' && READ_ONLY_ARTIFACT_ACTIONS.has(action)) return { kind: 'read', reason: null }
      return { kind: 'write', reason: `Artifact ${action || '(publish)'}` }
    }
    case 'DesignSync': {
      const method = String(toolInput?.method ?? '')
      if (READ_ONLY_DESIGNSYNC_METHODS.has(method)) return { kind: 'read', reason: null }
      return { kind: 'write', reason: `DesignSync ${method || '(unknown)'}` }
    }
    case 'RemoteTrigger': {
      const action = String(toolInput?.action ?? '')
      const body = [toolInput?.body, toolInput?.prompt].map((x) => String(x ?? '')).join('\n')
      if ((action === 'create' || action === 'update' || action === 'run') && NOTIFICATION_MARKER_RE.test(body)) {
        return { kind: 'deny', reason: 'a RemoteTrigger body that quotes notification markup is never a legitimate call target' }
      }
      if (READ_ONLY_REMOTETRIGGER_ACTIONS.has(action)) return { kind: 'read', reason: null }
      return { kind: 'write', reason: `RemoteTrigger ${action || '(unknown)'}` }
    }
    case 'Workflow': case 'EnterWorktree':
      return { kind: 'write', reason: toolName }
    case 'ExitWorktree': {
      const action = String(toolInput?.action ?? '')
      return action === 'keep' ? { kind: 'read', reason: null } : { kind: 'write', reason: 'ExitWorktree remove' }
    }
    case 'CronCreate': case 'ScheduleWakeup': {
      const body = [toolInput?.body, toolInput?.prompt].map((x) => String(x ?? '')).join('\n')
      if (NOTIFICATION_MARKER_RE.test(body)) {
        return { kind: 'deny', reason: `${toolName} body quotes notification markup — never a legitimate call target` }
      }
      return { kind: 'read', reason: null } // scheduling itself is a read; its FIRE is its own gated turn
    }
    case 'SendMessage': {
      // B6/C4: deny only when `to` resolves to a still-open role fork of the current cycle.
      const to = String(toolInput?.to ?? '')
      const openSet = ctx.openRoleForkAgentIds
      if (openSet !== undefined && openSet.size > 0) {
        const m = /\[([A-Za-z0-9]+)\]\s*$/.exec(to)
        const candidate = m ? m[1] : to.trim()
        if (openSet.has(candidate)) {
          return { kind: 'deny', reason: 'SendMessage to a role fork still in flight for this cycle is not permitted' }
        }
      }
      return { kind: 'read', reason: null }
    }
    default:
      return { kind: 'read', reason: null }
  }
}

/** Roled-fork Bash allow-list (D3, tightened C1): an EXACT, single-segment argv match for one of
 *  a small set of verification commands this repo actually runs. Anything else — including a
 *  shape merely CLOSE to one of these — is denied like an explicit write, because a roled fork
 *  is spawned to MEASURE, not to build or deploy. */
export function roledForkRunnerAllowed(cmd: string, cwd: string, repoRoot: string, fh: FsHelpers = nodeFsHelpers): boolean {
  const trimmed = cmd.trim()
  if (/[;&|\n]/.test(trimmed)) return false
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false
  const words = trimmed.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return false
  const realCwd = fh.realpath(cwd) ?? cwd
  const realRoot = fh.realpath(repoRoot) ?? repoRoot
  if (realCwd !== realRoot) return false

  if (words[0] === 'pnpm') {
    let i = 1
    if (words[i] === '--dir') {
      const dir = words[i + 1]
      if (dir === undefined) return false
      const realDir = fh.realpath(path.resolve(cwd, dir))
      if (realDir !== realRoot) return false
      i += 2
    }
    if (words[i] !== 'run') return false
    const script = words[i + 1]
    if (words.length !== i + 2) return false
    return script === 'check-types' || script === 'lint' || script === 'compile-tests'
  }
  if (words[0] === 'npx') {
    const bin = words[1]
    if (bin === undefined) return false
    if (!fh.exists(path.join(realRoot, 'node_modules', '.bin', bin))) return false
    const rest = words.slice(2)
    if (bin === 'tsc') {
      if (rest.length === 1) return rest[0] === '--noEmit'
      if (rest.length === 3) return rest[0] === '--noEmit' && rest[1] === '-p' && (rest[2] === 'tsconfig.json' || rest[2] === 'media/tsconfig.json')
      return false
    }
    if (bin === 'eslint') {
      if (rest.length === 0 || rest.some((w) => w.startsWith('-'))) return false
      return rest.every((w) => {
        const real = fh.realpath(path.resolve(cwd, w))
        if (real === null) return false
        return real.startsWith(path.join(realRoot, 'src') + path.sep) || real.startsWith(path.join(realRoot, 'media', 'src') + path.sep)
      })
    }
    if (bin === 'mocha') {
      const files: string[] = []
      let j = 0
      while (j < rest.length) {
        if (rest[j] === '--grep' || rest[j] === '--timeout') {
          if (rest[j + 1] === undefined) return false
          j += 2; continue
        }
        if (rest[j].startsWith('-')) return false
        files.push(rest[j]); j++
      }
      if (files.length === 0) return false
      const outTest = path.join(realRoot, 'out', 'test') + path.sep
      return files.every((f) => {
        const real = fh.realpath(path.resolve(cwd, f))
        return real !== null && real.startsWith(outTest)
      })
    }
    return false
  }
  return false
}

/** B3, resolved via realpath (A3): the ONLY script files a roled fork's runner check exempts —
 *  everything else under a plugin tree still needs a window, and inline code is never exempt
 *  (checked by the caller before this is reached). */
export function roledForkExemptScript(scriptPath: string, cwd: string, fh: FsHelpers = nodeFsHelpers, homeDir: string = os.homedir()): boolean {
  const abs = path.resolve(cwd, scriptPath)
  const real = fh.realpath(abs)
  if (real === null) return false
  if (real === path.join(homeDir, '.claude', 'plugins', 'data', 'ai-maestro-janitor-ai-maestro-plugins', 'dispatcher-stub.py')) return true
  const cacheRoot = path.join(homeDir, '.claude', 'plugins', 'cache', 'ai-maestro-plugins', 'ai-maestro-janitor')
  const realCacheRoot = fh.realpath(cacheRoot)
  if (realCacheRoot === null) return false
  if (!real.startsWith(realCacheRoot + path.sep)) return false
  const rest = real.slice(realCacheRoot.length + 1).split(path.sep)
  // <any version dir>/scripts/arm_prepare.py or arm_record.py
  return rest.length === 3 && rest[1] === 'scripts' && (rest[2] === 'arm_prepare.py' || rest[2] === 'arm_record.py')
}

// ── D2: cycle scan ───────────────────────────────────────────────────────────────────────────

interface ContentBlock {
  type?: unknown
  text?: unknown
  name?: unknown
  input?: { subagent_type?: unknown; prompt?: unknown; [k: string]: unknown }
  id?: unknown
  tool_use_id?: unknown
  content?: unknown
}
interface TEntry {
  type?: unknown
  message?: { content?: ContentBlock[] | string; model?: unknown; stop_reason?: unknown }
  timestamp?: unknown
  isSidechain?: unknown
}

function entryTs(e: TEntry): number {
  if (typeof e?.timestamp !== 'string') return 0
  const ms = Date.parse(e.timestamp)
  return Number.isNaN(ms) ? 0 : ms
}
function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map((x) => String((x as { text?: unknown })?.text ?? '')).join('\n')
}
function normalize(s: string): string {
  return s.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim()
}
function proposalKey(block: string): string {
  // A1' (2026-09-22, round 2 correction): PROPOSAL_LINE now matches ONE constant marker string,
  // so a key derived from the marker line itself is identical for every proposal and can no longer
  // bind a spawn to its own proposal (round-2 spec amendment,
  // reports/review-loop-gate/…stage1a-loop-spec.md). The key is the first 160 normalised chars of
  // the proposal's CONTENT — the remainder of the marker line after the PROPOSAL_LINE match, plus
  // every following line — with NO "short first line" shortcut: a templated opener shared by every
  // proposal (e.g. "Rationale in one sentence: ...") would otherwise make every key identical
  // again, exactly the bug this amendment fixes. A marker with no content normalises to '' —
  // scanCycles gates spawn-binding on key !== '' and missingReasonOf reports 'key-missing'.
  const lines = block.split('\n')
  const markerIndex = lines.findIndex((l) => PROPOSAL_LINE.test(l))
  if (markerIndex === -1) return normalize(block).slice(0, 160)
  const match = PROPOSAL_LINE.exec(lines[markerIndex])
  const remainder = match ? lines[markerIndex].slice(match.index + match[0].length) : ''
  const content = [remainder, ...lines.slice(markerIndex + 1)].join('\n')
  const normContent = normalize(content)
  return normContent === '' ? '' : normContent.slice(0, 160)
}
function roleFromPromptFirstLine(prompt: string): Role | null {
  // Spec A2: role marker must be the FIRST NON-BLANK line after trimEnd() — a leading blank
  // line (e.g. a prompt opening with '\n') must be skipped, but a leading space on the marker
  // line itself must NOT match (trimEnd only strips trailing whitespace/CRLF).
  let firstLine: string | undefined
  for (const line of prompt.split('\n')) {
    const trimmed = line.trimEnd()
    if (trimmed !== '') { firstLine = trimmed; break }
  }
  if (firstLine === 'ROLE: MEASURE') return 'measure'
  if (firstLine === 'ROLE: REVIEW') return 'review'
  return null
}
/** Heading of a RESULT block: must START a line (markdown punctuation allowed before it). Both
 *  or neither => null — one agent claiming both jobs is the shape this loop replaces. */
function resultRole(text: string): Role | null {
  const m = /^[#*\t ]*MEASURE-AND-VERIFY-REPORT/m.test(text)
  const r = /^[#*\t ]*ADVERSARIAL-REVIEW/m.test(text)
  return m === r ? null : (m ? 'measure' : 'review')
}

export interface Proposal { index: number; ts: number; key: string }
export interface RoleSpawn { role: Role; index: number; ts: number; toolUseId: string | null }
export interface Cycle {
  proposal: Proposal
  spawns: { measure: RoleSpawn | null; review: RoleSpawn | null }
  confirmed: { measure: boolean; review: boolean }
  sentinel: boolean
  /** ts at which the window opened (both roles confirmed, or a sentinel appeared), or null while
   *  still waiting. */
  windowOpenTs: number | null
  windowOpenIndex: number | null
  /** exclusive — the next proposal's index, or Infinity when this is the latest cycle. */
  windowCloseIndex: number
  /** Line indices, WITHIN this cycle's window, of every entry classified as a completed
   *  notification for either role — used only for tests/diagnostics. */
}

/** Scans one transcript's lines into proposal cycles (D2). Forward pass building the full
 *  cycle list; callers that want "only the latest, scanned backwards" (the plan's own framing)
 *  take `cycles[cycles.length - 1]` — equivalent for a well-formed transcript, and every
 *  cycle's own window math is independent of scan direction. */
export function scanCycles(lines: string[], _opts: { sessionDir?: string; cwd?: string } = {}): Cycle[] {
  const entries: TEntry[] = []
  for (const line of lines) {
    if (!line) continue
    try { entries.push(JSON.parse(line) as TEntry) } catch { continue }
  }
  const cycles: Cycle[] = []

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const ts = entryTs(e)
    const content = e?.message?.content
    const cur: Cycle | null = cycles.length > 0 ? cycles[cycles.length - 1] : null
    if (e?.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') {
          const text = String(b.text ?? '')
          if (isNoReviewSentinel(text) && cur !== null) {
            cur.sentinel = true
            cur.confirmed.measure = true; cur.confirmed.review = true
            if (cur.windowOpenIndex === null) { cur.windowOpenIndex = i; cur.windowOpenTs = ts }
            continue
          }
          if (PROPOSAL_LINE.test(text)) {
            if (cur !== null) cur.windowCloseIndex = i
            cycles.push({
              proposal: { index: i, ts, key: proposalKey(text) },
              spawns: { measure: null, review: null },
              confirmed: { measure: false, review: false },
              sentinel: false,
              windowOpenTs: null, windowOpenIndex: null,
              windowCloseIndex: Infinity,
            })
          }
          continue
        }
        if (b?.type !== 'tool_use' || cur === null) continue
        if (b.name === 'Agent') {
          const isFork = String(b.input?.subagent_type ?? '').trim().toLowerCase() === 'fork'
          const prompt = String(b.input?.prompt ?? '')
          const role = roleFromPromptFirstLine(prompt)
          // A1' (2026-09-22): an empty key (proposalKey returned '' — marker with no content) must
          // never bind ANY spawn, because `String.includes('')` is trivially true for every prompt
          // — without this guard a body-less proposal would credit every fork ever spawned.
          if (isFork && role !== null && cur.proposal.key !== '' && normalize(prompt).includes(cur.proposal.key)) {
            const spawn: RoleSpawn = { role, index: i, ts, toolUseId: typeof b.id === 'string' ? b.id : null }
            if (role === 'measure') cur.spawns.measure = spawn
            else cur.spawns.review = spawn
          }
        }
      }
      continue
    }
    // A background/foreground result — look for a role heading and, separately, a completed
    // notification. Both main-transcript shapes (array tool_result content, string-content
    // notification) are handled; see the binding note in `mayWrite` for the trust order.
    if (e?.type === 'user' && cur !== null) {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result') continue
          // GATED ON `tool_use_id` MATCHING THE SPAWN: a Read/Bash tool_result that merely QUOTES a
          // heading (re-reading an old report) must never confer credit — the spawn's OWN result
          // is the only foreground source of truth (plan test 7).
          const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : null
          const text = resultText(b.content)
          const role = resultRole(text)
          if (role === null || toolUseId === null) continue
          const spawn = role === 'measure' ? cur.spawns.measure : cur.spawns.review
          if (spawn === null || spawn.toolUseId !== toolUseId) continue
          if (role === 'measure') cur.confirmed.measure = true
          else cur.confirmed.review = true
        }
      } else if (typeof content === 'string') {
        // C2b/E3: a completion is parsed ONLY from the preamble, before any <summary>/<result>,
        // and ONLY when it carries a real <task-id> — a goal check-in / plain-prose mention of
        // <status> has none and never confirms.
        const preamble = content.split(/<summary>|<result>/)[0] ?? ''
        const isNotification = content.trimStart().startsWith('<task-notification') && /<task-id>/.test(preamble)
        if (isNotification) {
          const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(preamble)?.[1] ?? null
          const status = /<status>([^<]+)<\/status>/.exec(preamble)?.[1] ?? null
          if (status === 'completed') {
            const role = resultRole(content)
            if (role !== null) {
              const spawn = role === 'measure' ? cur.spawns.measure : cur.spawns.review
              const matches = spawn !== null && (toolUseId === null || spawn.toolUseId === null || spawn.toolUseId === toolUseId)
              if (matches) {
                if (role === 'measure') cur.confirmed.measure = true
                else cur.confirmed.review = true
              }
            }
          }
        }
      }
    }
    if (cur !== null && cur.confirmed.measure && cur.confirmed.review && cur.windowOpenIndex === null) {
      cur.windowOpenIndex = i; cur.windowOpenTs = ts
    }
  }
  return cycles
}

/** Is `index` inside cycle `c`'s open window? False while the window has not opened yet, or once
 *  it has closed at the next proposal — or (B2/C5) once 300 gated calls have already landed
 *  inside it, whichever comes first. `gatedCountInWindow` is supplied by the caller, which alone
 *  knows how many ALLOWED gated calls preceded `index` (see `mayWrite`). */
export function indexInWindow(c: Cycle, index: number, gatedCountInWindow: number): boolean {
  if (c.windowOpenIndex === null) return false
  if (index <= c.windowOpenIndex) return false
  if (index >= c.windowCloseIndex) return false
  if (gatedCountInWindow >= 300) return false
  return true
}

export const WINDOW_CALL_CAP = 300

/** B2/C5: count of GATED (write|runner) tool_use entries strictly between a window's open index
 *  and `uptoIndex` (exclusive) — used both by `mayWrite` to enforce the 300-call cap and exposed
 *  for the supervisor. Only entries the loop itself would have gated are counted — read-only
 *  calls never consumed the window's budget in the first place. */
export function gatedCallCountInWindow(lines: string[], c: Cycle, uptoIndex: number, cwd: string): number {
  if (c.windowOpenIndex === null) return 0
  const entries: TEntry[] = []
  for (const line of lines) {
    if (!line) continue
    try { entries.push(JSON.parse(line) as TEntry) } catch { continue }
  }
  let n = 0
  for (let i = c.windowOpenIndex + 1; i < Math.min(uptoIndex, entries.length); i++) {
    const content = entries[i]?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue
      const kind = gatedCall(b.name, (b.input ?? {}) as GatedCallInput, cwd).kind
      if (kind === 'write' || kind === 'runner') n++
    }
  }
  return n
}

// ── D3: mayWrite ─────────────────────────────────────────────────────────────────────────────

export type MissingReason =
  | 'no-proposal' | 'role-not-spawned' | 'role-running' | 'role-failed'
  | 'heading-missing' | 'role-not-first-line' | 'key-missing' | 'not-a-fork'
  | 'window-expired' | 'not-writable-here'

export interface MayWriteInput {
  transcriptPath: string
  agentId?: string
  cwd: string
  toolName: string
  toolInput: unknown
  repoRoot?: string
  fsHelpers?: FsHelpers
  /** Injectable for tests only — defaults to the real HOME. */
  homeDir?: string
  /** Recursion depth guard for spawner-chain resolution (D3). Callers never set this. */
  _depth?: number
}
export interface MayWriteResult { allow: boolean; reason?: string; missing?: MissingReason }

const MAX_SPAWNER_DEPTH = 8

function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl') ? transcriptPath.slice(0, -'.jsonl'.length) : transcriptPath
}
function subagentFile(sessionDir: string, agentId: string): string {
  return path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`)
}
function metaFile(sessionDir: string, agentId: string): string {
  return path.join(sessionDir, 'subagents', `agent-${agentId}.meta.json`)
}
interface AgentMeta { agentType?: string; isFork?: boolean; toolUseId?: string; parentAgentId?: string; spawnDepth?: number }
function readMeta(fh: FsHelpers, sessionDir: string, agentId: string): AgentMeta | null {
  const text = fh.readFile(metaFile(sessionDir, agentId))
  if (text === null) return null
  try { return JSON.parse(text) as AgentMeta } catch { return null }
}

/** Is this agent's OWN transcript a role fork (its first message carries "ROLE: MEASURE"/
 *  "ROLE: REVIEW" — the harness-wrapped shape, F5, so this is a substring check, not the anchored
 *  first-line one `roleFromPromptFirstLine` uses on a parent's own composed prompt). */
function ownFileRole(lines: string[]): Role | null {
  for (const line of lines.slice(0, 5)) {
    if (!line) continue
    let e: TEntry
    try { e = JSON.parse(line) as TEntry } catch { continue }
    if (e?.type !== 'user') continue
    const content = e?.message?.content
    const text = typeof content === 'string' ? content : ''
    if (text.includes('ROLE: MEASURE')) return 'measure'
    if (text.includes('ROLE: REVIEW')) return 'review'
  }
  return null
}

/** D3. Pure decision: given a PreToolUse call, is it allowed right now? Reads only through
 *  `fsHelpers` (defaults to real `fs`), so a test can point it at a temp directory tree. */
export function mayWrite(input: MayWriteInput): MayWriteResult {
  const fh = input.fsHelpers ?? nodeFsHelpers
  const cwd = input.cwd
  const repoRoot = input.repoRoot ?? cwd
  const homeDir = input.homeDir ?? os.homedir()
  const agentId = input.agentId?.trim() ?? ''
  const isSubagent = agentId !== ''
  const sessionDir = sessionDirOf(input.transcriptPath)
  const ownFile = isSubagent ? subagentFile(sessionDir, agentId) : input.transcriptPath
  const lines = readLines(fh, ownFile)
  if (lines === null) return { allow: false, reason: 'transcript unreadable', missing: 'no-proposal' }

  const role = isSubagent ? ownFileRole(lines) : null
  const cls = gatedCall(input.toolName, (input.toolInput ?? {}) as GatedCallInput, cwd, { isRoledFork: role !== null })
  if (cls.kind === 'read') return { allow: true }
  if (cls.kind === 'deny') return { allow: false, reason: cls.reason ?? 'denied' }

  // A role fork: explicit writes are denied outright; a runner call needs the D3/B1 allow-list.
  if (role !== null) {
    if (cls.kind === 'write') {
      return { allow: false, reason: 'a role fork (MEASURE/REVIEW) may not write — it is read-only by construction', missing: 'not-writable-here' }
    }
    const cmd = String((input.toolInput as GatedCallInput)?.command ?? '')
    if (roledForkRunnerAllowed(cmd, cwd, repoRoot, fh)) return { allow: true }
    // The one narrow runner exemption left to a role fork: a known plugin script, never inline code.
    const words = cmd.trim().split(/\s+/).filter((w) => w !== '')
    const scriptArg = words.find((w) => !w.startsWith('-') && w !== words[0])
    if (scriptArg !== undefined && roledForkExemptScript(scriptArg, cwd, fh, homeDir)) return { allow: true }
    return {
      allow: false,
      reason: `role forks may run only the verification allow-list, not: ${cmd}. Run \`pnpm run compile-tests\` `
        + 'and `npx mocha …` as TWO separate calls; inline `node -e` / `python -c` probes are not available '
        + 'before approval — measure through existing tests. Runners require the session cwd to be the repo root.',
      missing: 'not-writable-here',
    }
  }

  // D3 fix (TRDD-X8MW8K92): a SUBAGENT whose OWN transcript naturally carries no PROPOSAL (the
  // normal shape for a worker that was never asked to propose anything) must fall through to
  // inheritance resolution below rather than being denied here. The earlier code returned
  // unconditionally on `ownCycle === null`, so 13a/13d denied regardless of the spawner window.
  const own = scanCycles(lines, { sessionDir, cwd })
  const uptoIndex = lines.filter((l) => l !== '').length // "now" = end of what we can see
  const ownCycle = own.length > 0 ? own[own.length - 1] : null
  if (ownCycle !== null) {
    const ownGatedCount = gatedCallCountInWindow(lines, ownCycle, uptoIndex, cwd)
    if (indexInWindow(ownCycle, uptoIndex, ownGatedCount)) return { allow: true }
  }

  if (!isSubagent) {
    if (ownCycle === null) {
      return { allow: false, reason: 'no PROPOSAL found in this transcript — see `agentlenspro review-gate --directive`', missing: 'no-proposal' }
    }
    return { allow: false, reason: mayWriteMissingMessage(ownCycle), missing: missingReasonOf(ownCycle) }
  }

  // (b) Subagent inheritance: resolve the spawn in the PARENT's (or grandparent's, up to depth 8)
  // transcript, and require the spawner itself be allowed there too (recursive), with the spawn
  // being a non-role spawn inside an open spawner window, and the subagent not yet having
  // returned since that spawn (or the window is still open).
  const depth = input._depth ?? 0
  if (depth >= MAX_SPAWNER_DEPTH) {
    return { allow: false, reason: 'spawner chain exceeds the depth cap (8) — cannot resolve inheritance', missing: 'window-expired' }
  }
  const meta = readMeta(fh, sessionDir, agentId)
  const parentAgentId = meta?.parentAgentId
  const parentFile = parentAgentId !== undefined && parentAgentId !== '' ? subagentFile(sessionDir, parentAgentId) : sessionDirOf(input.transcriptPath) + '.jsonl'
  const parentLines = readLines(fh, parentFile)
  if (parentLines === null) {
    return { allow: false, reason: 'spawner transcript unreadable — cannot resolve inheritance', missing: 'window-expired' }
  }
  const parentCycles = scanCycles(parentLines, { sessionDir, cwd })
  const parentCycle = parentCycles.length > 0 ? parentCycles[parentCycles.length - 1] : null
  if (parentCycle === null) {
    if (ownCycle === null) {
      return { allow: false, reason: 'no PROPOSAL found in the spawner\'s transcript either — see `agentlenspro review-gate --directive`', missing: 'no-proposal' }
    }
    return { allow: false, reason: mayWriteMissingMessage(ownCycle), missing: missingReasonOf(ownCycle) }
  }
  // Find the Agent tool_use that spawned THIS agent in the parent's transcript (by toolUseId via
  // meta, when present) and confirm it is a non-role spawn sitting inside the parent's window.
  const parentEntries: TEntry[] = []
  for (const line of parentLines) { if (!line) continue; try { parentEntries.push(JSON.parse(line) as TEntry) } catch { continue } }
  let spawnIndex = -1
  for (let i = 0; i < parentEntries.length; i++) {
    const content = parentEntries[i]?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use' || b.name !== 'Agent') continue
      if (meta?.toolUseId !== undefined && meta.toolUseId !== '' && b.id === meta.toolUseId) { spawnIndex = i; break }
    }
    if (spawnIndex !== -1) break
  }
  if (spawnIndex === -1) {
    return { allow: false, reason: 'cannot bind this subagent to a spawning tool_use in its spawner\'s transcript', missing: 'window-expired' }
  }
  // D3 fix (TRDD-X8MW8K92): when the SPAWNER itself has no own proposal in its transcript (it is
  // itself an inheriting subagent, not the proposer — e.g. a depth-2 worker's grandparent), there
  // is no cycle to bound `spawnIndex` against here; the spawner's own standing is established by
  // the recursive `mayWrite` probe below instead. Only when the spawner DOES have its own cycle
  // (the direct, depth-1 case) do we require the spawn to sit inside that cycle's window.
  if (parentCycle !== null) {
    const parentGatedCount = gatedCallCountInWindow(parentLines, parentCycle, spawnIndex, cwd)
    if (!indexInWindow(parentCycle, spawnIndex, parentGatedCount)) {
      return { allow: false, reason: mayWriteMissingMessage(parentCycle), missing: missingReasonOf(parentCycle) }
    }
  }
  // Recurse: the spawner must itself be currently allowed. The probe is WRITE-shaped (a synthetic
  // Edit of a placeholder path), not a Bash read — a read-shaped probe (`Bash: true`) trivially
  // classifies as `kind: 'read'` and `mayWrite` would return `allow: true` at its very first check
  // without ever walking the spawner's own cycle/inheritance chain, making this recursion a no-op
  // that verified nothing. A write-shaped probe forces the real chain to run.
  if (parentAgentId !== undefined && parentAgentId !== '') {
    const parentAllowed = mayWrite({
      transcriptPath: sessionDirOf(input.transcriptPath) + '.jsonl',
      agentId: parentAgentId, cwd, repoRoot, homeDir,
      toolName: 'Edit', toolInput: { file_path: path.join(cwd, '.review-loop-synthetic-probe') },
      fsHelpers: fh, _depth: depth + 1,
    })
    if (!parentAllowed.allow) return parentAllowed
  } else if (parentCycle === null) {
    // No parentAgentId (spawner IS the main transcript) and the main transcript itself carries no
    // cycle at all — nothing to inherit from.
    return { allow: false, reason: 'no PROPOSAL found in this transcript — see `agentlenspro review-gate --directive`', missing: 'no-proposal' }
  }
  // Still open, OR not yet returned since the spawn (no completed notification after it) —
  // approximate "not yet returned" as: the subagent's own file has no notification-shaped
  // completion recorded in the parent past the spawn. `own`'s scan already tells us the AGENT'S
  // status is not itself a role fork; treat "own transcript still growing with no return event"
  // as satisfied whenever we could read it at all (a returned-and-denied agent would have failed
  // the direct own-window check above already).
  return { allow: true }
}

function missingReasonOf(c: Cycle): MissingReason {
  // A1' (2026-09-22): a marker with no body normalises to key === '' (proposalKey); scanCycles
  // gates spawn-binding on key !== '' so such a cycle can never be satisfied by any spawn — report
  // it distinctly rather than the generic "role not spawned" (the fix is to add prose, not to spawn).
  if (c.proposal.key === '') return 'key-missing'
  if (c.spawns.measure === null && c.spawns.review === null) return 'role-not-spawned'
  if (c.spawns.measure === null || c.spawns.review === null) return 'role-not-spawned'
  if (!c.confirmed.measure || !c.confirmed.review) return 'role-running'
  return 'window-expired'
}
function mayWriteMissingMessage(c: Cycle): string {
  const reason = missingReasonOf(c)
  const base = `review-loop gate: key "${c.proposal.key}" — `
  switch (reason) {
    case 'key-missing': return base + 'the proposal marker has no body — a key can only be derived from prose after the PROPOSAL FOR ACTION line, so add it before a fork can bind to this proposal'
    case 'role-not-spawned': return base + 'both roles (MEASURE and REVIEW) must be spawned as fork subagents over this exact proposal before any write'
    case 'role-running': return base + 'at least one role has not yet returned with its heading'
    case 'window-expired': return base + 'the window for this proposal has expired (300 gated calls used, or a newer proposal opened) — re-propose'
    default: return base + 'no proposal found'
  }
}
