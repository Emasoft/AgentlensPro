import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from './cliCore'

/**
 * The GLOBAL kill-switch — one flag file that disarms every AgentlensPro side-effect running inside
 * every Claude Code session on this machine (hooks, the burn-gate, server revive, spooling, cron).
 *
 * WHY A FILE, AND WHY GLOBAL (this is the lesson of the 2026-07-14 SSD incident, TRDD-K3WDPR7M):
 *
 *  1. An env var CANNOT be retrofitted onto a running agent. A hook process is spawned BY Claude
 *     Code and inherits CLAUDE's environment, so `AGENTLENS_GATE=off` in the operator's shell never
 *     reaches it. When something misbehaves, the operator has no in-band way to stop it.
 *  2. Killing the server is futile — the very next hook resurrects it.
 *  3. Config edits only take effect at the NEXT session launch. During that incident the user had
 *     **13 Claude sessions** that had loaded the old config days earlier and kept writing ~700 KB per
 *     LLM request. Editing settings.json stopped exactly ZERO of them; only restarting each did.
 *
 * A file under the data dir is the only channel that reaches ALL of them: every hook is a fresh
 * short-lived process that re-reads the filesystem, so the flag takes effect on the very next hook
 * fire — no restart, no env, no session surgery.
 *
 * Two scopes, deliberately separate:
 *   DISABLED   — global: every side-effect off. The "stop everything, now" brake.
 *   NO_REVIVE  — narrow: only stop hooks from auto-spawning the server (keep ingestion otherwise).
 *
 * FAIL-SAFE DIRECTION: an unreadable flag file reads as NOT disabled (fail-open). A kill-switch that
 * engages on a transient stat error would silently stop a user's observability with no diagnosis.
 * The switch is armed by an explicit human act, so its absence is never an emergency; the flag is
 * checked on every single hook, so arming it is never slow to take effect.
 */

/** Path of the global flag. Exported so `disable`/`enable`/`status` all agree on ONE location. */
export function killSwitchPath(): string {
  return path.join(dataDir(), 'DISABLED')
}

/** Env var every server spawner stamps on the child, naming the PATH that started it. The server
 *  logs it at boot beside the brake state it observed. WHY (TRDD-8VGQK9L9): a server was found
 *  running 1h53m with the NO_REVIVE brake in place, and the log carried nothing to say WHO started
 *  it or WHETHER the brake was consulted — the answer took a day and three refuted hypotheses.
 *  Four spawn paths exist (ensureServer, `server start`, the supervisor, the hook reviver); the env
 *  is the one channel every one of them already controls. Values are the short path names below,
 *  so a log line stays greppable across versions. Absent ⇒ "unknown" (launched by hand, or by a
 *  spawner older than this stamp). */
export const STARTED_BY_ENV = 'AGENTLENS_STARTED_BY'

/** Path of the narrow server-revive brake (hooks may still spool; they just won't spawn a server). */
export function noRevivePath(): string {
  return path.join(dataDir(), 'NO_REVIVE')
}

/** Is the narrow revive brake armed? Checks NO_REVIVE ONLY — deliberately NOT the global DISABLED
 *  switch. The two must not be equal: NO_REVIVE is a PAUSE, DISABLED is TERMINAL, and the
 *  supervisor depends on the difference (under DISABLED its spawn must PROCEED so the child
 *  refuses with EX_CONFIG 78 and the terminal-exit path ends the loop; swallowing that spawn
 *  would make a DISABLED supervisor immortal). Callers that also want to refuse under DISABLED
 *  check `agentlensDisabled()` separately, ahead of this — that ordering is what keeps the split.
 *
 *  THE TWO CALLERS FAIL DIFFERENTLY ON PURPOSE, and nothing else records it: the supervisor
 *  RESCHEDULES on a set brake (a pause self-heals on the next backoff tick), while `ensureServer()`
 *  THROWS (its caller wanted a server now and cannot have one). Both are "refuse to spawn"; only
 *  the recovery differs. Do not unify them into one reaction.
 *
 *  Lives HERE, not in serverControl, so the supervisor and `ensureServer()` share ONE definition:
 *  they had drifted, and `ensureServer()` consulted no brake at all (TRDD-8VGQK9L9 — a server ran
 *  1h53m with the brake in place, because `--start-server`/`--dashboard` are global flags and any
 *  diagnostics command carrying one revived it).
 *
 *  ENOENT-only-false, NOT existsSync. existsSync never throws — it reads EVERY error (EACCES, EIO)
 *  as "absent", and here that direction is inverted from the hook path this brake grew out of: a
 *  hook failing open loses a spawn (missed capture); a start failing open mid-rewrite SPAWNS into
 *  the swap (corruption). Unreadable therefore means BRAKED. Proven on this machine: statSync
 *  throws EACCES on /var/root/x while existsSync returns false for the same path. */
export function reviveBraked(): boolean {
  try { fs.statSync(noRevivePath()); return true } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * Is AgentlensPro globally disabled? Checked at the top of EVERY entry point, before any work,
 * any network call and any read of stdin — a disabled AgentlensPro must cost the host session
 * nothing at all, not even a blocked pipe.
 *
 * `AGENTLENS_DISABLED=1` is honored too, for the cases where env DOES reach the process (tests,
 * a supervisor that spawns the server directly). The FILE is the one that reaches running agents.
 */
export function agentlensDisabled(): boolean {
  if (process.env.AGENTLENS_DISABLED === '1') { return true }
  try { return fs.existsSync(killSwitchPath()) } catch { return false }
}

/** Arm the global kill-switch. Idempotent. Returns the flag path. */
export function armKillSwitch(reason?: string): string {
  const p = killSwitchPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // The body is a human note, never parsed — an operator who finds this file months later must be
  // able to tell WHY it is there and how to undo it without reading our source.
  fs.writeFileSync(p, [
    `AgentlensPro is DISABLED.`,
    ``,
    `Every hook, the burn-gate, server auto-revive and all background ingestion are OFF while`,
    `this file exists. It takes effect on the NEXT hook fire in EVERY running Claude session —`,
    `no restart needed.`,
    ``,
    `Armed: ${new Date().toISOString()}`,
    reason ? `Reason: ${reason}` : ``,
    ``,
    `Re-enable with:  agentlenspro enable      (or simply delete this file)`,
    ``,
  ].join('\n'))
  return p
}

/** Disarm the global kill-switch. Idempotent — a missing flag is success, not an error. */
export function disarmKillSwitch(): boolean {
  const p = killSwitchPath()
  try { fs.unlinkSync(p); return true } catch { return false }
}
