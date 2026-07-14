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

/** Path of the narrow server-revive brake (hooks may still spool; they just won't spawn a server). */
export function noRevivePath(): string {
  return path.join(dataDir(), 'NO_REVIVE')
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
