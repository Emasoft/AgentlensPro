// src/cli/reviewGate.ts — `agentlenspro review-gate`: the adversarial-review Stop/SubagentStop
// gate, as ONE verb that dispatches on `hook_event_name` (TRDD ai-review-gate-cli-verb).
//
// WHY A VERB, NOT SHIPPED .js FILES. The two source-of-truth implementations
// (~/.claude/hooks/stop-spawn-review-fork.js and subagent-stop-spawn-review-fork.js) are loose
// user-scope files this package never shipped and `--install-hooks` never registered. Absolute
// script paths in settings.json break on reinstall (a different prefix per npm/Homebrew version);
// a subcommand of the one published bin does not, because HOOK_EVENTS/GATE_EVENTS registration
// already resolves `agentlenspro` on PATH. Ported here FAITHFULLY — same decision logic, same
// breakers, same fail-open direction — just merged behind one dispatch instead of two files.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { agentlensDisabled } from './killSwitch'
import { readStdin } from './hookHandlers'

// ── Step 2: the directive, embedded (not a shipped file) ──────────────────────────────────────
// Both gates' block reason used to point at ~/.claude/hooks/review-fork-directive.md, which the
// package would not ship either. `agentlenspro review-gate --directive` prints this instead, and
// the block reason below points at that command.
export const REVIEW_GATE_DIRECTIVE = `# Review-fork gate directive (read on every Stop-hook fire)

Spawn ONE adversarial reviewer with the Agent tool, \`subagent_type: "fork"\`, with a prompt that:

- states what you did this turn and every claim you are asserting;
- orders it to make NO tool calls except a single SendMessage to "main", then stop (a second
  turn rewrites the shared prefix at the cache-WRITE rate and destroys the economics);
- tells it to hunt the recurring failure shape — a PROXY read in place of the thing (a pipe's
  exit status for the tool's, a preview for the file, a profile for the workload rate, one run
  for the variance, an assumed format for the real one);
- asks it to name the single WEAKEST link and give ONE settling command for it.

Then read its findings and act on them. Do NOT restate this directive to the user — spawn the
fork and continue. \`AGENTLENS_REVIEW_FORK=off\` disables the gate.
`

interface ReviewGateInput {
  hook_event_name?: unknown
  hookEventName?: unknown
  transcript_path?: unknown
  session_id?: unknown
  agent_id?: unknown
  agent_type?: unknown
  agent_transcript_path?: unknown
}

interface AssistantContentBlock {
  type?: unknown
  name?: unknown
  input?: { subagent_type?: unknown; command?: unknown }
}
interface TranscriptEntry {
  type?: unknown
  isSidechain?: unknown
  message?: { content?: AssistantContentBlock[] }
}

const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])
// Shell quoting is stripped before matching so prose ABOUT committing is not mistaken for a
// commit — `echo "run git commit"` must not trigger a review.
const unquoted = (s: string): string => s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')

// ── MAIN AGENT GATE (Stop) ──────────────────────────────────────────────────────────────────────

const MAIN_MAX_PER_SESSION_DEFAULT = 20
const MAIN_MAX_CONSECUTIVE = 2

interface MainBreakerState { total: number; consecutive: number }

/** Read per-call so a live AGENTLENS_REVIEW_FORK_MAX change is honored. */
export function mainGateMaxPerSession(): number {
  const v = Number(process.env.AGENTLENS_REVIEW_FORK_MAX)
  return v > 0 ? v : MAIN_MAX_PER_SESSION_DEFAULT
}

/** Read only the tail of a (possibly huge) transcript — the answer is always near the end. */
export function readTranscriptTail(transcriptPath: string, maxBytes = 4 * 1024 * 1024): string[] | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    const size = fs.fstatSync(fd).size
    const span = Math.min(size, maxBytes)
    const buf = Buffer.alloc(span)
    fs.readSync(fd, buf, 0, span, size - span)
    fs.closeSync(fd)
    // Drop the first line when the window started mid-record; a torn record is not JSON.
    let lines = buf.toString('utf8').split('\n')
    if (span < size) lines = lines.slice(1)
    return lines.filter(Boolean)
  } catch {
    return null
  }
}

/** Scan the main transcript's tail for the last fork spawn and the last consequential edit. Pure —
 *  the whole "relative position, not turn boundaries" rule lives here, so it is testable without a
 *  real transcript file. */
export function scanMainTranscriptLines(lines: string[]): { lastFork: number; lastWork: number } {
  let lastFork = -1
  let lastWork = -1
  for (let i = 0; i < lines.length; i++) {
    let e: TranscriptEntry
    try { e = JSON.parse(lines[i]) as TranscriptEntry } catch { continue }
    // Subagent turns are marked `isSidechain: true` — skipping them means a sidechain transcript
    // yields no work and no fork, so the gate allows the stop and stays silent.
    if (e?.isSidechain === true) continue
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') { lastFork = i; continue }
      if (typeof b.name === 'string' && EDITORS.has(b.name)) { lastWork = i; continue }
      if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) lastWork = i
    }
  }
  return { lastFork, lastWork }
}

/** The rule: allow the stop iff the last fork spawn is NEWER than the last consequential action.
 *  Pure decision over an already-scanned transcript + breaker state. Returns `nextState` by
 *  REFERENCE-equal to `state` when nothing changed, so the caller can skip an unnecessary write. */
export function decideMainGate(
  scan: { lastFork: number; lastWork: number },
  state: MainBreakerState,
  opts: { maxPerSession: number; maxConsecutive: number },
): { block: boolean; nextState: MainBreakerState } {
  if (scan.lastWork === -1) return { block: false, nextState: state } // nothing claimed this window
  // `>=`, not `>`: an edit and a fork spawn in the SAME assistant message share an index, and a
  // tie must go to the fork or that turn can never end.
  if (scan.lastFork >= scan.lastWork) {
    // The review landed, so the streak is broken. Resetting is what makes CONSECUTIVE mean
    // "blocks that produced no fork" rather than "blocks ever".
    return { block: false, nextState: state.consecutive !== 0 ? { total: state.total, consecutive: 0 } : state }
  }
  // Both breakers fail OPEN — the cost of an unwanted review is one review; the cost of a wedged
  // session is the session. Do NOT reset `consecutive` on breaker-fire (see decideMainGate's
  // caller): only a LANDED fork clears the streak.
  if (state.consecutive >= opts.maxConsecutive || state.total >= opts.maxPerSession) {
    return { block: false, nextState: state }
  }
  return { block: true, nextState: { total: (state.total || 0) + 1, consecutive: (state.consecutive || 0) + 1 } }
}

function mainStatePath(key: string): string {
  const safe = String(key).replace(/[^A-Za-z0-9]/g, '_').slice(-64)
  return path.join(os.tmpdir(), `agentlens-review-fork-${safe}.json`)
}
function readMainState(p: string): MainBreakerState {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as MainBreakerState } catch { return { total: 0, consecutive: 0 } }
}
function writeMainState(p: string, s: MainBreakerState): void {
  try { fs.writeFileSync(p, JSON.stringify(s)) } catch { /* not worth wedging over */ }
}

const MAIN_BLOCK_REASON = 'Review-fork gate: this turn edited or committed. Run `agentlenspro '
  + 'review-gate --directive` and follow it (spawn the adversarial fork, act on its findings), then continue.'

async function runMainGate(input: ReviewGateInput): Promise<string | null> {
  const transcript = input?.transcript_path
  if (typeof transcript !== 'string' || !fs.existsSync(transcript)) return null
  const lines = readTranscriptTail(transcript)
  if (lines === null) return null
  const scan = scanMainTranscriptLines(lines)
  const key = typeof input?.session_id === 'string' && input.session_id ? input.session_id : transcript
  const statePath = mainStatePath(key)
  const state = readMainState(statePath)
  const verdict = decideMainGate(scan, state, { maxPerSession: mainGateMaxPerSession(), maxConsecutive: MAIN_MAX_CONSECUTIVE })
  if (verdict.nextState !== state) writeMainState(statePath, verdict.nextState)
  if (!verdict.block) return null
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: MAIN_BLOCK_REASON })
}

// ── SUBAGENT GATE (SubagentStop) ───────────────────────────────────────────────────────────────

const SUBAGENT_MAX_DEMANDS_PER_AGENT = 1

interface SubagentState { demands: number }

/** Scan a subagent's OWN transcript for whether it did consequential work and whether it already
 *  spawned its own reviewer. Pure — mirrors scanMainTranscriptLines but without the fork-position
 *  logic (a subagent gets at most ONE demand, never a relative-position check). */
export function scanSubagentTranscriptLines(lines: string[]): { didWork: boolean; reviewed: boolean } {
  let didWork = false
  let reviewed = false
  for (const line of lines) {
    if (!line) continue
    let e: TranscriptEntry
    try { e = JSON.parse(line) as TranscriptEntry } catch { continue }
    const content = e?.message?.content
    if (e?.type !== 'assistant' || !Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') reviewed = true
      else if (typeof b.name === 'string' && EDITORS.has(b.name)) didWork = true
      else if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) didWork = true
    }
  }
  return { didWork, reviewed }
}

/** Pure decision: demand a review from a subagent at most once, and only when it (a) is not the
 *  reviewer itself (recursion guard on `agent_type`), (b) enforcement is armed
 *  (AGENTLENS_SUBAGENT_REVIEW=on — default observe-only), (c) its own transcript proves it did
 *  work and has not already reviewed itself, (d) it has not already been asked. */
export function decideSubagentGate(
  agentType: string,
  enforceOn: boolean,
  scan: { didWork: boolean; reviewed: boolean } | null,
  demands: number,
  maxDemands: number,
): { block: boolean; nextDemands: number } {
  // THE RECURSION GUARD — a review fork is itself a subagent; reviewing it spawns a reviewer for
  // the reviewer. Empty type is the internal micro-lookup class — skipped for cost, and because an
  // agent that will not name itself cannot be told apart from a reviewer.
  if (agentType === '' || /fork/i.test(agentType)) return { block: false, nextDemands: demands }
  if (!enforceOn) return { block: false, nextDemands: demands } // observe-only default
  if (!scan || !scan.didWork || scan.reviewed) return { block: false, nextDemands: demands }
  if (demands >= maxDemands) return { block: false, nextDemands: demands }
  return { block: true, nextDemands: demands + 1 }
}

function subagentStatePath(key: string): string {
  const safe = String(key).replace(/[^A-Za-z0-9]/g, '_').slice(-64)
  return path.join(os.tmpdir(), `agentlens-subagent-review-${safe}.json`)
}
function readSubagentState(p: string): SubagentState {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as SubagentState } catch { return { demands: 0 } }
}
function writeSubagentState(p: string, s: SubagentState): void {
  try { fs.writeFileSync(p, JSON.stringify(s)) } catch { /* not worth wedging over */ }
}

function readSubagentScan(transcriptPath: string): { didWork: boolean; reviewed: boolean } | null {
  try { return scanSubagentTranscriptLines(fs.readFileSync(transcriptPath, 'utf8').split('\n')) } catch { return null }
}

const SUBAGENT_BLOCK_REASON = 'Subagent review gate: before returning, run `agentlenspro review-gate '
  + '--directive` and follow it (spawn ONE adversarial fork over your work) and act on its findings. '
  + 'If you have no Agent tool, state that in one line and return — this is asked once.'

async function runSubagentGate(input: ReviewGateInput): Promise<string | null> {
  const type = String(input?.agent_type ?? '')
  const enforceOn = (process.env.AGENTLENS_SUBAGENT_REVIEW || '').trim() === 'on'
  const own = input?.agent_transcript_path
  // `agent_transcript_path` is the subagent's OWN file — `transcript_path` names the PARENT's and
  // would measure the wrong agent entirely.
  const scan = typeof own === 'string' && fs.existsSync(own) ? readSubagentScan(own) : null
  const agentKey = typeof input?.agent_id === 'string' && input.agent_id
    ? input.agent_id
    : (typeof input?.session_id === 'string' && input.session_id ? input.session_id : 'unknown')
  const statePath = subagentStatePath(agentKey)
  const state = readSubagentState(statePath)
  const verdict = decideSubagentGate(type, enforceOn, scan, state.demands, SUBAGENT_MAX_DEMANDS_PER_AGENT)
  if (!verdict.block) return null
  writeSubagentState(statePath, { demands: verdict.nextDemands })
  return JSON.stringify({ decision: 'block', suppressOutput: true, reason: SUBAGENT_BLOCK_REASON })
}

// ── Process entry for `agentlenspro review-gate` ───────────────────────────────────────────────

/** `agentlenspro review-gate [--directive]`. Always resolves 0 — a Stop/SubagentStop hook that
 *  can throw or hang can wedge the session, which is worse than a missed review. Dispatches on
 *  `hook_event_name`: `SubagentStop` -> the subagent gate, `Stop` (or an absent field, honored the
 *  same way the ported scripts did) -> the main gate. Any other event is a silent allow. */
export async function runReviewGate(argv: string[]): Promise<number> {
  if (argv[0] === '--directive') {
    process.stdout.write(REVIEW_GATE_DIRECTIVE)
    return 0
  }
  // GLOBAL kill-switch, before stdin — mirrors runHookCommand('gate'): a disabled AgentlensPro
  // must never block the user's work.
  if (agentlensDisabled()) return 0
  const payload = await readStdin(process.stdin)
  // One switch silences both gates.
  if ((process.env.AGENTLENS_REVIEW_FORK || '').trim() === 'off') return 0
  let input: ReviewGateInput
  try { input = JSON.parse(payload.toString('utf8')) as ReviewGateInput } catch { return 0 }
  const evt = input?.hook_event_name ?? input?.hookEventName
  let out: string | null = null
  if (evt === 'SubagentStop') {
    out = await runSubagentGate(input)
  } else if (typeof evt !== 'string' || evt === 'Stop') {
    out = await runMainGate(input)
  }
  if (out) process.stdout.write(out + '\n')
  return 0
}
