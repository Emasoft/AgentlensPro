// src/cli/reviewSupervisor.ts — `agentlenspro review-supervisor`: the METAHOOK over the review gate.
//
// The review gate (src/cli/reviewGate.ts) enforces the adversarial per-turn review. This watches
// whether that enforcement is ACTUALLY HAPPENING, and warns the user AND the agent when it is not.
//
// WHY IT EXISTS. On 2026-09-03 the gate's own circuit breaker tripped after two ignored demands and
// it stopped asking for the rest of the session. Everything after that point shipped unreviewed and
// NOTHING SAID SO — the failure was silent, and it was only found because the owner asked "what
// happened to the adversarial turn review?". A safety gate that can go quiet needs a supervisor that
// cannot: this runs on UserPromptSubmit, a different event from the gate's Stop, so a gate that
// never fires is exactly the condition this still detects.
//
// It runs on UserPromptSubmit AND Stop. The Stop registration is the load-bearing one: a warning the
// USER reads is worthless while the user is away, and on 2026-09-03 the agent finished turn after
// turn without ever being told. It NEVER BLOCKS — it injects the warning into the agent's context
// and shows it to the user. Blocking was tried and removed the same day: a blocking supervisor can
// deadlock a session on a condition no action of the agent's can clear, which is worse than the
// unreviewed turn it guards against. Enforcement is the gate's job; this one only has to be
// impossible to silence.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readTranscriptTail } from './reviewGate'

/** Tool names whose use means the turn changed something a review would have caught. */
const EDITORS = new Set(['Edit', 'Write', 'NotebookEdit'])
const unquoted = (s: string): string => s.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '')

export interface SupervisorScan {
  /** Consequential actions (edits, commits) seen in the scanned window. */
  work: number
  /** Adversarial review forks spawned in the same window. */
  forks: number
  /** Work items that appear AFTER the last fork — the unreviewed backlog. */
  unreviewed: number
}

/** Count work and forks over a transcript tail. Pure, so the thresholds are testable. */
export function scanSupervision(lines: string[]): SupervisorScan {
  let work = 0
  let forks = 0
  let unreviewed = 0
  for (const line of lines) {
    let e: { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    try { e = JSON.parse(line) as typeof e } catch { continue }
    if (e?.isSidechain === true) continue
    if (e?.type !== 'assistant') continue
    const content = e?.message?.content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; name?: string; input?: { subagent_type?: unknown; command?: unknown } }>) {
      if (b?.type !== 'tool_use') continue
      if (b.name === 'Agent' && b.input?.subagent_type === 'fork') { forks++; unreviewed = 0; continue }
      if (typeof b.name === 'string' && EDITORS.has(b.name)) { work++; unreviewed++; continue }
      if (b.name === 'Bash' && /\bgit\s+commit\b/.test(unquoted(String(b.input?.command ?? '')))) { work++; unreviewed++ }
    }
  }
  return { work, forks, unreviewed }
}

/** Is the gate still wired into the settings cascade? A hook can be removed by an edit, an upgrade,
 *  or a bad merge, and nothing else would notice. */
export function gateIsRegistered(settingsPaths: string[], readFile: (p: string) => string): boolean {
  for (const p of settingsPaths) {
    let raw: string
    try { raw = readFile(p) } catch { continue }
    let parsed: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: unknown }> }>> }
    try { parsed = JSON.parse(raw) as typeof parsed } catch { continue }
    for (const ev of ['Stop', 'SubagentStop']) {
      for (const m of parsed?.hooks?.[ev] ?? []) {
        for (const h of m?.hooks ?? []) {
          if (/\bagentlenspro\s+review-gate\b/.test(String(h?.command ?? ''))) return true
        }
      }
    }
  }
  return false
}

/** How many unreviewed changes before the supervisor shouts. One is normal mid-turn; a pile is not. */
export const UNREVIEWED_ALARM = 3

export interface Verdict {
  level: 'ok' | 'warn' | 'alarm'
  message: string
}

/**
 * The judgement. Deliberately loud in the two cases that were previously silent: the gate missing
 * from the settings, and work accumulating with no review behind it.
 */
export function judge(scan: SupervisorScan, registered: boolean, transcriptReadable: boolean): Verdict {
  if (!registered) {
    return {
      level: 'alarm',
      message: 'THE REVIEW GATE IS NOT REGISTERED. No Stop/SubagentStop hook runs `agentlenspro review-gate`, '
        + 'so no turn is being reviewed. Run `agentlenspro --install-hooks` NOW — spawning a review fork will NOT '
        + 'fix this, because the condition is in the settings file, not the transcript.',
    }
  }
  if (!transcriptReadable) {
    // Say so rather than report a reassuring zero — an unreadable transcript is exactly how a
    // supervisor lies by omission.
    return { level: 'warn', message: 'Review supervisor could not read the transcript, so it cannot confirm any review ran. Treat the review as UNVERIFIED.' }
  }
  if (scan.unreviewed >= UNREVIEWED_ALARM) {
    return {
      level: 'alarm',
      // 'in the scanned window', never 'this session': the scan reads a bounded transcript TAIL, so
      // a long session's earlier turns are simply not in view and a session-wide claim would be false.
      message: `${scan.unreviewed} change(s) have landed with no adversarial review after them `
        + `(in the scanned window: ${scan.forks} review fork(s), ${scan.work} consequential action(s)). `
        + 'Spawn the review fork now — the per-turn review is the check that catches what tests and types cannot.',
    }
  }
  if (scan.work > 0 && scan.forks === 0) {
    return {
      level: 'warn',
      message: `${scan.work} change(s) in the scanned window with NO adversarial review fork after them. `
        + 'The gate should have demanded one — if it has not, it is not working.',
    }
  }
  return { level: 'ok', message: `review supervisor: ${scan.forks} review(s) for ${scan.work} change(s) in the scanned window, ${scan.unreviewed} unreviewed.` }
}

interface SupervisorInput { transcript_path?: unknown; session_id?: unknown; hook_event_name?: unknown; hookEventName?: unknown }

function settingsCascade(cwd: string): string[] {
  return [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(cwd, '.claude', 'settings.local.json'),
  ]
}

/**
 * The events whose schema accepts `additionalContext` — the MODEL-facing channel. Verified against
 * the harness binary's own hook schemas: Stop, SubagentStop and UserPromptSubmit each pin
 * `hookEventName` to their own literal, so echoing an unexpected value makes the whole
 * `hookSpecificOutput` fail its schema and the injection is dropped SILENTLY.
 *
 * Registering the supervisor on a fourth event would therefore make it look installed and deliver
 * nothing — the exact silent failure this component exists to catch. Falling back keeps the warning
 * flowing on a channel that is known to work, instead of guessing with the caller's value.
 */
const CONTEXT_EVENTS = new Set(['Stop', 'SubagentStop', 'UserPromptSubmit'])
export function contextEvent(event: string): string {
  return CONTEXT_EVENTS.has(event) ? event : 'UserPromptSubmit'
}

async function readStdin(stream: NodeJS.ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
  return Buffer.concat(chunks)
}

/**
 * Entry point. Registered on BOTH `UserPromptSubmit` and `Stop`, and it NEVER blocks on either.
 *
 * Both channels are emitted every time the verdict is not `ok`:
 *   - `systemMessage` — the USER sees it.
 *   - `hookSpecificOutput.additionalContext` — the MODEL sees it. Verified against the harness's own
 *     hook schemas: Stop, SubagentStop and UserPromptSubmit each accept `additionalContext` from a
 *     NON-blocking hook, so injecting reaches the agent without holding the turn.
 *
 * Blocking was tried and removed the same day. It could deadlock a session on a condition no action
 * of the agent's could clear, which is worse than the unreviewed turn it guards. Enforcement is the
 * gate's job; this one only has to be impossible to silence. */
export async function runReviewSupervisor(): Promise<number> {
  let input: SupervisorInput = {}
  try { input = JSON.parse((await readStdin(process.stdin)).toString('utf8')) as SupervisorInput } catch { /* keep defaults */ }
  const transcript = typeof input?.transcript_path === 'string' ? input.transcript_path : ''
  const lines = transcript && fs.existsSync(transcript) ? readTranscriptTail(transcript) : null
  const scan = lines ? scanSupervision(lines) : { work: 0, forks: 0, unreviewed: 0 }
  const registered = gateIsRegistered(settingsCascade(process.cwd()), p => fs.readFileSync(p, 'utf8'))
  const verdict = judge(scan, registered, lines !== null)
  if (verdict.level === 'ok') return 0
  const event = String(input?.hook_event_name ?? input?.hookEventName ?? '')
  const tag = verdict.level === 'alarm' ? '🚨 REVIEW SUPERVISOR' : '⚠ Review supervisor'

  // NEVER BLOCKS (owner, 2026-09-03: "the supervisor does not need to be blocking. it just need to
  // inject the warning in the context for the agent to read"). Injecting is enough and it removes an
  // entire failure class: a blocking supervisor could deadlock a session on a condition no action of
  // the agent's could clear, which is a worse outcome than the unreviewed turn it was guarding
  // against. Enforcement stays the gate's job; this one only has to be impossible to silence.
  process.stdout.write(JSON.stringify({
    systemMessage: `${tag}: ${verdict.message}`,
    hookSpecificOutput: { hookEventName: contextEvent(event), additionalContext: `[review-supervisor] ${verdict.message}` },
  }))
  return 0
}
