// src/cli/delegateGate.ts — `agentlenspro delegate-gate` (PreToolUse): Fable plans, Sonnet
// executes (owner order 2026-09-10, ~/.claude/rules/fable-plans-sonnet-executes.md). Denies the
// CALLING agent's own Edit/Write/NotebookEdit/MultiEdit and write-shaped Bash calls when that
// agent is running on Fable/Mythos — planning artefacts (/tmp, reports/, *_dev/, ~/.claude/plans/)
// are exempt, and so are `git`/`gh` commands (git tracking and GitHub issues stay in the main context per the
// owner's own delegation rule).
//
// SUBAGENT MODEL RESOLUTION (measured on this machine, 2026-09-10 — see the rule file's
// "Measured facts"): a subagent's own PreToolUse hook stdin carries the PARENT session's
// `transcript_path` plus a non-empty `agent_id` — NOT the subagent's own transcript path. Gating
// on `transcript_path` alone therefore reads the PARENT's model and would refuse a Sonnet
// lean-worker's own edits (the exact failure the delegation rule exists to prevent) while ALSO
// letting a Fable-inheriting subagent (e.g. an unpinned `cpv-*-fixer`) slip through on a bare
// path-shape allowlist. The fix gates on the MODEL of the transcript that actually reflects the
// calling agent, never on path shape alone: when `agent_id` is present, resolve
// `<session-dir>/subagents/agent-<agent_id>.jsonl` (`session-dir` = `transcript_path` with its
// trailing `.jsonl` stripped) and read the model from THAT file; otherwise read `transcript_path`
// itself (the main-session case, or a caller that already hands the subagent's own path).

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readTranscriptTail } from './reviewGate'
import { commandWriteReason, isEphemeralTarget, shellWords } from './reviewGateTriggers'
import { readStdin } from './hookHandlers'

export interface DelegateGateInput {
  tool_name?: unknown
  tool_input?: { file_path?: unknown; command?: unknown }
  transcript_path?: unknown
  /** Present on a subagent's own tool call — see the SUBAGENT MODEL RESOLUTION note above. */
  agent_id?: unknown
  cwd?: unknown
}

export interface DelegateGateVerdict {
  deny: boolean
  reason?: string
  /** Non-fatal stderr line — logged whether or not the call denies. */
  note?: string
}

// Deliberately does NOT mention the env kill-switch: advertising a bypass in the block message
// undermines the delegation rule the same way naming it in a public deny reason would (an agent
// under review reads its own deny reasons). The switch stays implemented and is logged to stderr
// on every use (decideDelegateGate's `note`), which is enough for an operator to discover it.
export const DELEGATE_DENY_REASON =
  'Delegate gate: Fable plans, Sonnet executes (owner order 2026-09-10). This session runs on '
  + 'Fable, so it may not edit files or run write-shaped commands itself. Dispatch the change to a '
  + 'Sonnet worker: `Agent` with `subagent_type: "lean-worker"`, `run_in_background: true`, and a '
  + 'prompt carrying ABSOLUTE paths, the exact old/new text (or the fastedit command), and the ONE '
  + 'check to run. Locate with `tldr definition|references|search`, edit with `fastedit edit` or the '
  + 'Edit tool. Planning artefacts under /tmp, reports/, *_dev/, ~/.claude/plans/ and `git`/`gh` '
  + 'commands are exempt.'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const FABLE_RE = /fable|mythos/i
// Words that precede the real command without being it: `env`/`sudo` re-exec a program under a
// modified environment/privilege, and a leading `VAR=value` is a same-command assignment (shell
// grammar, not the command itself) — `commandWriteReason` already treats plain assignments the
// same way when classifying WHAT was written; this mirrors it for WHO gets the git/gh exemption.
const SKIP_PREFIX_WORDS = new Set(['env', 'sudo'])
const ASSIGNMENT_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

function hookCwd(input: DelegateGateInput): string {
  return typeof input?.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
}

/** The `message.model` of the last `n` `type: "assistant"` transcript entries that carry a
 *  string model, scanned from the end — an entry with no model field is skipped, not counted, so
 *  it never occupies one of the n slots. Checked against ANY of these (not just the last one)
 *  because a harness utility call stamped `"model":"sonnet"` can be the LAST assistant entry of a
 *  Fable transcript and must not unlock it. */
export function recentAssistantModels(lines: string[], n = 5): string[] {
  const models: string[] = []
  for (let i = lines.length - 1; i >= 0 && models.length < n; i--) {
    const line = lines[i]
    if (!line) continue
    let e: { type?: unknown; message?: { model?: unknown } }
    try { e = JSON.parse(line) as { type?: unknown; message?: { model?: unknown } } } catch { continue }
    if (e?.type === 'assistant' && typeof e.message?.model === 'string') models.push(e.message.model)
  }
  return models
}

/** `<session-dir>/subagents/agent-<agentId>.jsonl` from the PARENT's `transcript_path`
 *  (`<session-dir>.jsonl`) — see the SUBAGENT MODEL RESOLUTION note at the top of this file. */
export function subagentTranscriptPath(mainTranscript: string, agentId: string): string {
  const base = mainTranscript.endsWith('.jsonl') ? mainTranscript.slice(0, -'.jsonl'.length) : mainTranscript
  return path.join(base, 'subagents', `agent-${agentId}.jsonl`)
}

/** `<session-dir>/subagents/agent-<anything>.jsonl` — matches an ALREADY-RESOLVED subagent
 *  transcript path, whatever id it carries. */
const SUBAGENT_TRANSCRIPT_RE = /\/subagents\/agent-[^/]+\.jsonl$/

/** The transcript that reflects the CALLING agent's own model — `null` when `transcript_path`
 *  isn't a non-empty string. Gates on `agent_id`, NEVER on the path's shape (see the SUBAGENT
 *  MODEL RESOLUTION note above): a `fork` subagent's transcript also lives under `/subagents/`
 *  and still runs the parent's model, so a bare `/subagents/` allow would let a Fable fork edit
 *  at Fable prices — the one thing this gate exists to stop.
 *
 *  EXCEPTION: when `transcript_path` ITSELF already matches the subagent-file shape, return it
 *  as-is even though `agent_id` is also set — appending `subagents/agent-<id>.jsonl` a second
 *  time would compute a nested path that never exists on disk, and a future harness that starts
 *  handing the subagent's own transcript_path (instead of the parent's) would then fail OPEN
 *  (`resolveTranscript` -> nonexistent file -> "no model readable" -> a Fable fork edits freely,
 *  never denied) rather than reading the real, already-correct path. */
export function resolveTranscript(input: DelegateGateInput): string | null {
  const transcript = input?.transcript_path
  if (typeof transcript !== 'string' || transcript === '') return null
  if (SUBAGENT_TRANSCRIPT_RE.test(transcript)) return transcript
  const agentId = typeof input?.agent_id === 'string' ? input.agent_id.trim() : ''
  return agentId === '' ? transcript : subagentTranscriptPath(transcript, agentId)
}

/** The first real command word — after skipping any leading `VAR=value` assignments and
 *  `env`/`sudo` wrappers — is `git` or `gh`. A quoted first word can never BE the bare command
 *  name (it is a string literal to the shell), so it fails closed. */
export function isGitOrGhCommand(cmd: string): boolean {
  for (const w of shellWords(cmd)) {
    if (w.quoted) return false
    if (ASSIGNMENT_WORD_RE.test(w.word) || SKIP_PREFIX_WORDS.has(w.word)) continue
    return w.word === 'git' || w.word === 'gh'
  }
  return false
}
// ponytail: this is a first-word check, not a per-segment one — `git status && sed -i … x.ts`
// passes it because `git` is the first word, so the sed half slips the git/gh exemption. The
// review gate still arms on that same command (it classifies every segment independently), so
// the ceiling is caught downstream. Upgrade path if this is ever abused: split on `;`/`&&`/`|`
// and require EVERY segment to be git/gh, not just the first.

/** A write target the delegation rule doesn't gate: `isEphemeralTarget` already covers /tmp,
 *  /private/tmp (incl. the shell-metachar-under-/tmp case) and <cwd>/reports/, <cwd>/<name>_dev/.
 *  This adds the one thing it doesn't know about: ~/.claude/plans/. */
function isPlanningArtefact(file: string, cwd: string): boolean {
  if (isEphemeralTarget(file, cwd)) return true
  if (file === '' || /[$`~*?{}[\]]/.test(file)) return false
  const abs = path.resolve(cwd, file)
  const plansDir = path.join(os.homedir(), '.claude', 'plans')
  return abs === plansDir || abs.startsWith(plansDir + path.sep)
}

/** Pure decision — reads only what it is given (env is a param, never `process.env` directly),
 *  so this is testable without touching the real process. */
export function decideDelegateGate(
  input: DelegateGateInput, env: NodeJS.ProcessEnv = process.env,
): DelegateGateVerdict {
  if ((env.AGENTLENS_DELEGATE_GATE ?? '').trim() === 'off') {
    return { deny: false, note: '[delegate-gate] disabled by env' }
  }
  const agentId = typeof input?.agent_id === 'string' ? input.agent_id.trim() : ''
  const modelTranscript = resolveTranscript(input)
  if (modelTranscript === null) {
    return { deny: false, note: '[delegate-gate] allowing: no model readable' }
  }
  if (!fs.existsSync(modelTranscript)) {
    const suffix = agentId !== '' ? ' (subagent transcript absent)' : ''
    return { deny: false, note: `[delegate-gate] allowing: no model readable${suffix}` }
  }
  const lines = readTranscriptTail(modelTranscript)
  const models = lines === null ? [] : recentAssistantModels(lines)
  if (models.length === 0) {
    return { deny: false, note: '[delegate-gate] allowing: no model readable' }
  }
  if (!models.some((m) => FABLE_RE.test(m))) return { deny: false } // Sonnet/Opus/Haiku aren't gated

  const tool = String(input?.tool_name ?? '')
  const cwd = hookCwd(input)
  if (EDIT_TOOLS.has(tool)) {
    const file = String(input?.tool_input?.file_path ?? '')
    if (isPlanningArtefact(file, cwd)) return { deny: false }
    return { deny: true, reason: DELEGATE_DENY_REASON }
  }
  if (tool === 'Bash') {
    const cmd = String(input?.tool_input?.command ?? '')
    // No separate /private/tmp carve-out needed here: commandWriteReason itself only returns a
    // reason when a write TARGET is not ephemeral (isEphemeralTarget, checked internally), and
    // that already covers /private/tmp — a command that writes ONLY there is null already.
    const why = commandWriteReason(cmd, cwd)
    if (why !== null && !isGitOrGhCommand(cmd)) return { deny: true, reason: DELEGATE_DENY_REASON }
    return { deny: false }
  }
  return { deny: false }
}

/** `stdinJson` -> the hook's stdout payload (DENY JSON) or `''` for allow. Logs `note` to stderr
 *  as a side effect, mirroring `runMainGate`'s stderr-line convention. */
export function runDelegateGate(stdinJson: string): string {
  let input: DelegateGateInput
  try { input = JSON.parse(stdinJson) as DelegateGateInput } catch {
    process.stderr.write('[delegate-gate] allowing: the hook payload is not valid JSON\n')
    return ''
  }
  const verdict = decideDelegateGate(input, process.env)
  if (verdict.note) process.stderr.write(verdict.note + '\n')
  if (!verdict.deny) return ''
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: verdict.reason,
    },
  })
}

/** Process entry for `agentlenspro delegate-gate`. Always resolves 0 — a PreToolUse hook that
 *  throws or hangs would wedge the turn, which is worse than a missed gate. */
export async function runDelegateGateCli(): Promise<number> {
  const payload = await readStdin(process.stdin)
  const out = runDelegateGate(payload.toString('utf8'))
  if (out) process.stdout.write(out + '\n')
  return 0
}
