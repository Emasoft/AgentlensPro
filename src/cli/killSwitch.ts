import * as fs from 'fs'
import * as path from 'path'
import { dataDir } from './cliCore'
import { NO_REVIVE_FILE } from '../dataDir'

/**
 * The GLOBAL kill-switch — one flag file that turns AgentlensPro's COLLECTION off inside every Claude Code
 * session on this machine (TRDD-RBBEX59R): the server runs in no-collection mode — no telemetry, no raw API
 * bodies, no hook-event log — while `agentlenspro hook` keeps feeding its in-memory ring (never the CLI hook
 * spool) and `agentlenspro gate` keeps running, so the burn-gate and the image cache-guard stay ON, as do the
 * review gate and the review supervisor. Status-line capture stays ON: it always POSTs to the server, which stores it
 * even in no-collection mode. The process itself is kept down only by the NO_REVIVE brake (below).
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
 *   DISABLED   — global: COLLECTION off. Since TRDD-RBBEX59R (c) it no longer means every side effect off: the
 *                server still runs, in no-collection mode, and the guards keep running.
 *   NO_REVIVE  — narrow: stop every spawn path from starting the server; the brake that keeps the process
 *                DOWN, armed by `agentlenspro server stop --stay-down`.
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
 *  switch. The two must not be equal: NO_REVIVE keeps the server process DOWN, DISABLED only turns
 *  collection off (TRDD-RBBEX59R c2: under DISABLED every spawn PROCEEDS, in no-collection mode, so
 *  the burn-gate and the image cache-guard stay fed). Since c2 no spawn path refuses under DISABLED, so
 *  this is the only brake on a spawn; it is also the precondition `ts-repair` requires (storeAdmin.ts).
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
 * WHICH half of the global kill-switch is armed, or `null` if neither is. ONE definition behind `agentlensDisabled()` and
 * every reader of the switch except `envHalfSet()`: they cannot disagree about which half is armed. `envHalfSet()` counts the env half
 * even while `--force-install-telemetry` overrides it in-process, so that `rawBodiesHeldAbsent`
 * never writes the raw-body key under AGENTLENS_DISABLED=1 (bug B13, TRDD-RBBEX59R).
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

/** Is AGENTLENS_DISABLED=1 set in this process's environment, whether or not `--force-install-telemetry` overrode it for the
 *  rest of the run? Callers: killSwitchHalf (which adds the override on top, unless told not to), hookCaptureStop (via killSwitchHalf with
 *  the override ignored) and rawBodiesHeldAbsent (telemetryConfig.ts), which must NOT honour the override.
 *  WHY it ignores the override (TRDD-RBBEX59R B13, d2): the override lets a force install repair, restore and lift around the env
 *  half, but the switch stops COLLECTION (owner rule 2026-11-03) and OTEL_LOG_RAW_API_BODIES makes Claude Code dump every API body
 *  to disk. With the override honoured, a force install under AGENTLENS_DISABLED=1 and no flag file WROTE that key. */
export function envHalfSet(): boolean { return process.env.AGENTLENS_DISABLED === '1' }

/** `honourEnvOverride` (default true) lets the `--force-install-telemetry` override hide the env half; `hookCaptureStop` passes false
 *  because a READER of the hook-event store must see the switch as the hooks of the running sessions see it. */
export function killSwitchHalf(dir: string = dataDir(), honourEnvOverride = true): 'env' | 'file' | null {
  if (envHalfSet() && !(honourEnvOverride && envHalfOverridden)) return 'env'
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

/** What the kill-switch means for READING the hook-event store: `null` when capture is on; otherwise `armedAtMs`, the flag file's mtime
 *  (arm time), or `null` there when only the env half is set (no arm time is knowable). TRDD-RBBEX59R (e), bug B6: while the switch is
 *  armed no hook event is written, so the newest record on disk is merely the last one from BEFORE the switch, and a reader that
 *  reports it as the latest gives a confident wrong answer. The file is checked first so a file+env pair still yields a usable time.
 *  Armed regardless of the `--force-install-telemetry` env override (killSwitchHalf with honourEnvOverride=false): that override is an
 *  in-process flag that stays set for the verb `agentlenspro --force-install-telemetry last-compact` runs right after the force install
 *  (main.ts), and it changes what the force install may repair — not whether the hooks of the running sessions store events. */
export interface HookCaptureStop { armedAtMs: number | null }
export function hookCaptureStop(dir: string = dataDir()): HookCaptureStop | null {
  // Armed-or-not comes from killSwitchHalf alone (one definition of "armed", so the two cannot diverge); the file is stat-ed ONLY to
  // read the arm time. File + env both set: the file still supplies the time. Env only (or the file vanished between the two reads): unknowable.
  if (killSwitchHalf(dir, false) === null) return null
  try { return { armedAtMs: fs.statSync(killSwitchPath(dir)).mtimeMs } } catch { return { armedAtMs: null } }
}

/** Arm the global kill-switch. Idempotent. Returns the flag path. */
export function armKillSwitch(reason?: string, dir: string = dataDir()): string {
  // `dir` (TRDD-RBBEX59R): the arm and the check must hit the SAME file. setup's foreign check reads ctx.dataDir's flag,
  // so the writer takes that dir too — on the env default it armed a different dir's flag than the one later checked.
  const p = killSwitchPath(dir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  // The body is a human note, never parsed — an operator who finds this file months later must be
  // able to tell WHY it is there and how to undo it without reading our source.
  fs.writeFileSync(p, [
    `AgentlensPro is DISABLED.`,
    ``,
    `While this file exists AgentlensPro stores no telemetry, no raw API bodies and no hook-event`,
    `log: the server runs in no-collection mode. The burn-gate and the image cache-guard stay ON`,
    `(agentlenspro hook keeps feeding them, in memory only), and so do the review gate and the`,
    `review supervisor. The status line is still captured: it keeps POSTing to the server.`,
    `To keep the server process DOWN as well:  agentlenspro server stop --stay-down`,
    `The hooks change on their NEXT fire in EVERY running Claude session — no restart needed;`,
    `a server that was already running enters the mode at its next restart.`,
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
export function disarmKillSwitch(dir: string = dataDir()): boolean {
  // `dir` (TRDD-RBBEX59R): removal must hit the file the foreign check read (ctx.dataDir), never the env default's flag.
  const p = killSwitchPath(dir)
  // A flag that cannot be deleted (anything but ENOENT) throws, so `enable` stops before it restores the parked skills.
  let existed = true
  try { fs.unlinkSync(p) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    existed = false
  }
  return existed
}
