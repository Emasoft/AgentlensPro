import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from './cliCore'
import { NO_REVIVE_FILE } from '../dataDir'

/**
 * The GLOBAL kill-switch — one flag file that disarms AgentlensPro's side-effects inside every Claude Code
 * session on this machine. Every AgentlensPro hook is OFF except the review gate and the review supervisor,
 * which only read transcripts. Off: lifecycle capture (`agentlenspro hook`), the burn-gate and the image
 * cache-guard (`agentlenspro gate`), server auto-revive, background ingestion, and status-line capture
 * (kept only by `agentlenspro disable --keep-statusline`).
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

/** Path of the global flag. Exported so `disable`/`enable`/`status` all agree on ONE location.
 *  Every helper below takes an optional `dir`, defaulting to the env-resolved data dir. `setup` passes its own
 *  ctx.dataDir, which can come from options rather than the env, so it checks the flags of the dir it is about to
 *  start a server in (TRDD-TYOQA14F). */
export function killSwitchPath(dir: string = dataDir()): string {
  return path.join(dir, 'DISABLED')
}

/** Marker beside the kill-switch flag: while BOTH exist, status-line capture still appends to disk
 *  (statuslineCapture.ts) — every other surface stays off.
 *  WHY: owner request 2026-10-27, verbatim: "stop everything except the statusline data collection, so the
 *  agentlenspro cli can still answer the basic questions about the session". */
export function keepStatuslinePath(dir: string = dataDir()): string {
  return path.join(dir, 'DISABLED-KEEP-STATUSLINE')
}

/** Is the disabled-but-keep-status-line marker present? Any stat error reads as absent: the failure
 *  direction is then "no capture", i.e. the plain disabled state the operator already had. */
export function keepStatuslineArmed(dir: string = dataDir()): boolean {
  try { fs.statSync(keepStatuslinePath(dir)); return true } catch { return false }
}

/** Arm the keep-status-line marker. Idempotent. Returns its path. */
export function armKeepStatusline(): string {
  const p = keepStatuslinePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'Status-line capture stays ON while AgentlensPro is disabled. Removed by `agentlenspro enable`.\n')
  return p
}

/** Env var every server spawner stamps on the child, naming the PATH that started it. The server
 *  logs it at boot beside the brake state it observed. WHY (TRDD-8VGQK9L9): a server was found
 *  running 1h53m with the NO_REVIVE brake in place, and the log carried nothing to say WHO started
 *  it or WHETHER the brake was consulted — the answer took a day and three refuted hypotheses.
 *  Five spawn sites exist (ensureServer — reached by `server start|restart`, `dashboard` and the
 *  diagnostics `--start-server`/`--dashboard` globals — the supervisor, the hook reviver, `setup`,
 *  and the loop-watchdog respawn); the env
 *  is the one channel every one of them already controls. Values are the short path names below,
 *  so a log line stays greppable across versions. Absent ⇒ "unknown" (launched by hand, or by a
 *  spawner older than this stamp). */
export const STARTED_BY_ENV = 'AGENTLENS_STARTED_BY'

/** Path of the narrow server-revive brake (hooks may still spool; they just won't spawn a server). */
export function noRevivePath(dir: string = dataDir()): string {
  return path.join(dir, NO_REVIVE_FILE)
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
export function reviveBraked(dir: string = dataDir()): boolean {
  try { fs.statSync(noRevivePath(dir)); return true } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * WHICH half of the global kill-switch is armed, or `null` if neither is. ONE definition shared by
 * `agentlensDisabled()` and `disabledNotice()` (`foreignTelemetry.ts`): the two cannot disagree about
 * which half is armed, and the notice names the half that fired.
 *
 * `AGENTLENS_DISABLED=1` is honored too, for the cases where env DOES reach the process (tests,
 * a supervisor that spawns the server directly). The FILE is the one that reaches running agents.
 */
// `--force-install-telemetry` overrides AGENTLENS_DISABLED for THIS process only (owner order 2026-10-02: "overrides
// all env vars and enable agentlenspro. but the next time agentlenspro is executed ... it will regularly disabled
// again"). An in-process flag: process.env is never mutated, nothing is persisted, so the very next run sees the
// variable again. Children spawned by the flagged verb still inherit the env as it was (a spawn site that must not
// pass AGENTLENS_DISABLED to its child has to strip it explicitly, in that child's env only).
let envHalfOverridden = false
export function overrideKillSwitchEnv(on = true): void { envHalfOverridden = on }

export function killSwitchHalf(dir: string = dataDir()): 'env' | 'file' | null {
  if (process.env.AGENTLENS_DISABLED === '1' && !envHalfOverridden) return 'env'
  try { return fs.existsSync(killSwitchPath(dir)) ? 'file' : null } catch { return null }
}

/**
 * Is AgentlensPro globally disabled? Checked at the top of EVERY entry point, before any work,
 * any network call and any read of stdin — a disabled AgentlensPro must cost the host session
 * nothing at all, not even a blocked pipe.
 */
export function agentlensDisabled(dir: string = dataDir()): boolean {
  return killSwitchHalf(dir) !== null
}

/** The `Reason:` an automatic disable records when ANOTHER telemetry pipeline is configured. Lives here, beside the
 *  flag, so the raw-body decision below can read it without importing foreignTelemetry.ts (which imports
 *  telemetryConfig.ts, which needs this decision: a cycle). foreignTelemetry.ts re-exports it. */
export const FOREIGN_REASON = 'foreign telemetry configuration present — run with --force-install-telemetry'

/**
 * Must OTEL_LOG_RAW_API_BODIES be ABSENT from settings.json right now? True while the off switch is armed BY THE
 * OPERATOR: the env half, or the flag file with any reason except FOREIGN_REASON.
 * WHY (owner rule 2026-11-03, TRDD-RBBEX59R): "the disabled mode should ONLY stop the collection of the telemetry
 * logs and raw bodies" — so the raw-body key is the one owned key whose convergence target flips to ABSENT, and
 * setup / auto-repair / --install-otel must never write it back while the switch stands (setup must not undo the
 * disable verb, which strips it). A FOREIGN-armed switch is exempt: agentlenspro armed it itself, the disable verb
 * never stripped the key, and the very run that converges telemetry also lifts that switch (stepOtel ->
 * enableIfForeign, ensureInstalled launch) — keeping the key absent there would leave a lifted install without it.
 * `dir` is explicit at every setup call site: the flag of the data dir being converged, never the env default.
 * An unreadable flag reads as operator-armed (absent key): the failure direction is "no raw-body collection".
 */
export function rawBodiesCaptureOff(dir: string = dataDir()): boolean {
  const half = killSwitchHalf(dir)
  if (half === 'env') return true
  if (half !== 'file') return false
  try { return !fs.readFileSync(killSwitchPath(dir), 'utf8').includes(`Reason: ${FOREIGN_REASON}`) } catch { return true }
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
    `Every AgentlensPro hook is OFF while this file exists, except the review gate and the review`,
    `supervisor, which only read transcripts. Off: lifecycle capture (agentlenspro hook), the burn-gate`,
    `and the image cache-guard (agentlenspro gate), server auto-revive, background ingestion, and`,
    `status-line capture (kept only by agentlenspro disable --keep-statusline).`,
    `It takes effect on the NEXT hook fire in EVERY running Claude session —`,
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

/** Disarm the global kill-switch. Idempotent — a missing flag is success, not an error. Any OTHER
 *  unlink failure (EACCES, EPERM, EBUSY) is thrown: swallowing it let `agentlenspro enable` print
 *  "now ENABLED" while the flag stayed on disk and the hooks kept no-op'ing. */
export function disarmKillSwitch(): boolean {
  const p = killSwitchPath()
  // The FLAG goes first. A marker that cannot be deleted still throws, but only after the flag is already
  // gone: AgentlensPro is left enabled (the marker is inert without the flag), not disabled with the flag
  // still on disk. The throw still reaches `enable`, which stops before restoring the parked skills.
  let existed = true
  try { fs.unlinkSync(p) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    existed = false
  }
  // The keep-status-line marker only means something beside the flag (owner request 2026-10-27), so
  // it goes with it: a stale marker would resurrect status-line-only capture at the next `disable`.
  try { fs.unlinkSync(keepStatuslinePath()) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return existed
}
