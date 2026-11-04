// `agentlenspro disable` / `agentlenspro enable` — the global brake (TRDD-K3WDPR7M).
//
// The 2026-07-14 SSD incident is the whole reason this exists: raw-body capture was burning ~35 GB/day,
// and there was NO way to stop it across the machine. Editing settings.json stopped ZERO of the 13
// Claude sessions that had loaded the config days earlier; killing the server was futile because the
// next hook resurrected it; and AGENTLENS_GATE=off could not be retrofitted onto a running agent
// (a hook inherits CLAUDE's env, not the operator's). A flag FILE is the only channel that reaches
// every already-running session, because every hook is a fresh process that re-reads the disk.
import * as path from 'path'
import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { killSwitchPath, agentlensDisabled, armKeepStatusline, armKillSwitch, keepStatuslinePath, killSwitchHalf, noRevivePath, reviveBraked } from './killSwitch'
import { enableAgentlensSurfaces, type SurfaceDirs } from './surfaces'
import { AutoSetupDeps, ensureInstalled } from './autoSetup'
import { ensureServer, findServerPid, statsOwnership, stopServer, SUPERVISE_MAX_BACKOFF_DEFAULT_MS } from './serverControl'
import { apiRequest, dataDir, PROBE_TIMEOUT_MS, sleep } from './cliCore'
import { resolveCtx } from './setup'
import { EXIT } from './cliErrors'
import { RAW_BODIES_KEY } from '../captureConfig'
import { removeRawBodiesKey } from '../telemetryConfig'

export async function runDisableCli(args: string[]): Promise<number> {
  const reason = args.filter(a => !a.startsWith('-')).join(' ') || undefined
  // The switch stops ONLY collection (owner rule 2026-11-03, TRDD-RBBEX59R d2): `disable` arms the flag and moves nothing. Before d2
  // the kill-switch AND the skills/rules moved together (owner order 2026-10-02), so `disable` suppressed more than collection. Skills an
  // older `disable` parked come back at the next launch (restoreParkedSurfaces, autoSetup.ts) while the switch stays armed. The flag goes
  // in the env-default data dir, where the hooks look for it (killSwitch.ts).
  const p = armKillSwitch(reason)
  // `--keep-statusline`: owner request 2026-10-27, verbatim: "stop everything except the statusline data
  // collection, so the agentlenspro cli can still answer the basic questions about the session". The marker
  // only lets statuslineCapture.ts keep appending to disk; nothing else changes: the server still runs in no-collection
  // mode (stores nothing) and the hooks keep running (TRDD-RBBEX59R c2). A plain
  // `disable` clears any marker left by an earlier `--keep-statusline`, so it turns status-line capture off too.
  const keepStatusline = args.includes('--keep-statusline')
  if (keepStatusline) armKeepStatusline()
  else fs.rmSync(keepStatuslinePath(), { force: true })

  // The server reads its mode (collecting or no-collection) ONLY at boot (TRDD-RBBEX59R c2), so a server already
  // running in collecting mode would keep storing after the flag is armed — "disabled" would be a lie. Stop it: the next
  // hook revives it in no-collection mode (the hooks keep running, so the spawn guards stay fed). Best-effort: a server
  // we cannot stop is reported, never silently ignored.
  let stopped = 'no server was running'
  if (await findServerPid() !== null) {   // async — awaiting it is what makes the check real
    try {
      await stopServer()
      stopped = (await findServerPid()) === null
        ? 'running server stopped'
        : 'WARNING: server did not stop — kill it manually'
    } catch (e) {
      stopped = `WARNING: could not stop the server (${(e as Error).message}) — kill it manually`
    }
  }

  // The single biggest write AgentlensPro causes is not one WE make — it is the one we ASK Claude
  // Code to make: OTEL_LOG_RAW_API_BODIES makes it dump the whole conversation to disk on every
  // request (~35 GB/day, TRDD-K3WDPR7M). A kill-switch that stops our server but leaves that key in
  // settings.json would still be burning the disk, so "disabled" would be a lie. Raw capture is mandatory
  // for an ENABLED install (owner reversal 2026-10-02), so this is a deliberate emergency strip that
  // `agentlenspro enable` + the next launch undo.
  let capture = 'raw-body key was not set'
  try {
    capture = (await removeRawBodiesKey())
      ? 'raw-body key removed from settings.json (restart Claude sessions to stop them writing); re-added after `agentlenspro enable`'
      : 'raw-body key was not set'
  } catch (e) {
    // Never fail the kill-switch on this: the flag is already armed and the server already stopped.
    // Report loudly instead of silently leaving the user believing the burn is off.
    capture = `WARNING: could not remove ${RAW_BODIES_KEY} (${(e as Error).message}) — remove it from settings.json by hand`
  }

  console.log('AgentlensPro is now DISABLED.')
  console.log(`  flag:    ${p}`)
  if (keepStatusline) console.log(`  keep:    ${keepStatuslinePath()} (status-line capture stays ON, written straight to disk)`)
  console.log(`  server:  ${stopped}`)
  console.log(`  capture: ${capture}`)
  console.log('  skills:  not touched (agents stay installed); skills parked by a `disable` run before this version reappear at the next launch while the switch stays armed.')
  console.log('')
  // TRDD-RBBEX59R c2: the switch now means "store nothing", not "run nothing" — the text says so.
  console.log('  Off: storing telemetry, raw API bodies and hook events (the next server runs in no-collection mode),')
  console.log('  the CLI hook spool, and status-line capture (kept only by --keep-statusline).')
  console.log('  On: the burn-gate and the image cache-guard (fed in memory), the in-band advisor, the other dashboard-panel')
  console.log('  hook switches as you left them, the review gate and the review supervisor. Turn the guards on or off from')
  console.log('  the dashboard right panel.')
  console.log('  The next failed hook POST revives the server in that mode; `agentlenspro server stop --stay-down` keeps it down.')
  console.log('  Takes effect in every Claude session already running, from its next hook fire. No restart needed.')
  console.log('')
  console.log('  Re-enable with:  agentlenspro enable')
  // The flag is armed either way (the brake IS on for AgentlensPro's own hooks), but if we could not
  // stop a running server OR strip the capture key, the ~35 GB/day burn may still be flowing. A script
  // that keys on the exit code to confirm "the burn is stopped" must NOT read that as success.
  const partialFailure = stopped.startsWith('WARNING') || capture.startsWith('WARNING')
  return partialFailure ? EXIT.ABORT : EXIT.OK
}

export async function runEnableCli(forceInstall = false, deps: AutoSetupDeps = {}, restartDeps: EnableRestartDeps = {}): Promise<number> {
  // ONE data dir for the whole verb (TRDD-RBBEX59R c2 item 4): the flag check, the flag removal, the skills restore, the
  // reconverge and the restart all key on ctx.dataDir. Before this the check, the removal and the restore read the
  // ENV-default dir while the reconverge worked on resolveCtx().dataDir, so when the two differed `enable` lifted one
  // flag, the reconverge kept the raw-body key absent for the other, and the verb still printed ENABLED.
  const ctx = deps.ctx ?? resolveCtx({ log: () => { /* quiet */ } })
  const dir = ctx.dataDir
  const envDir = dataDir()
  const dirs: SurfaceDirs = { dataDir: dir, skillsDir: ctx.skillsDir, rulesDir: path.join(ctx.home, '.claude', 'rules') }
  // operatorEnable: THIS is the operator's own `enable` (autoSetup.ts AutoSetupDeps), the only caller whose refused lift is recorded
  // as FOREIGN_REASON (D10); forceInstallTelemetry reaches ensureInstalled with the same trigger and must not.
  const withCtx: AutoSetupDeps = { ...deps, ctx, forceInstall, operatorEnable: true }
  // Steps 1-2 of the shared order (autoSetup.ts ensureInstalled): the telemetry verdict FIRST — a company
  // setup still in place re-disables agentlenspro and refuses; only an absent/ours verdict goes on to
  // restore anything. Only then is the switch lifted below.
  const blocked = await ensureInstalled('enable', 'enable', withCtx)
  if (blocked !== null) return blocked
  // The env half through the ONE killSwitch predicate (round 2, D): killSwitchHalf honours the in-process
  // --force-install-telemetry override (overrideKillSwitchEnv); a raw process.env read reported the env half armed
  // under the override, so `enable --force-install-telemetry` refused to restart the server it had just re-enabled.
  const envHalfArmed = killSwitchHalf(dir) === 'env'
  const armed = agentlensDisabled(dir)
  let restored: string[] = []
  if (armed) {
    // Disarm AND put the parked skills back (enableAgentlensSurfaces): the operator's explicit lift. Since d2 a plain `disable` parks nothing, so this restores only what a foreign setup or a pre-d2 `disable` parked.
    restored = enableAgentlensSurfaces(dirs).restored
    // WHY (TRDD-RBBEX59R): the converge above ran while the switch stood, so it held the raw-body key ABSENT
    // (rawBodiesHeldAbsent); every lift is followed by ONE telemetry converge, which writes the key back once no switch
    // half is armed (under the env half it stays absent, as the owner rule requires).
    const again = await ensureInstalled('enable', 'enable', withCtx)
    if (again !== null) return again
  }
  // NO early return when nothing is armed (round 2, A): the flag is lifted by the FIRST run, but a no-collection server
  // can outlive it (a failed stop, the env half, the brake, a data-dir mismatch). Every remedy that says "re-run
  // `agentlenspro enable`" depends on a re-run still reading the server and restarting one that reports "off".
  // The server: under the switch it ran in no-collection mode (alcoreServeArgs adds --no-collection), and the mode is
  // chosen at spawn, so lifting the flag changes nothing until that server restarts (TRDD-RBBEX59R c2 item 4).
  const fetchStats = restartDeps.fetchStats ?? defaultFetchStats
  const stats = await fetchStats()
  const plan = enableRestartPlan(stats, { dir, envDir, noRevive: reviveBraked(dir), envHalfArmed })
  // An env-set AGENTLENS_DISABLED cannot be cleared by deleting a file — say so, and return non-zero
  // (cannot-answer) rather than claim a success the user will not observe: the flag is gone but every
  // process inheriting the env stays disabled, so "enable" did not achieve what was asked.
  if (envHalfArmed) {
    console.log('Removed the kill-switch flag, but AGENTLENS_DISABLED=1 is set in this environment —')
    console.log('AgentlensPro stays disabled for any process that inherits it. Unset it to re-enable.')
    if (plan === 'env-armed') console.log(`  server:  pid ${String(stats?.pid)} stays in no-collection mode — not restarted, since the enable verb cannot lift the env half. Unset it and re-run \`agentlenspro enable\`.`)
    return EXIT.UNKNOWN
  }
  if (armed) {
    console.log('AgentlensPro is now ENABLED.')
    console.log(`  removed: ${killSwitchPath(dir)}`)
    if (restored.length > 0) console.log(`  skills:  ${restored.length} restored to their place`)
    console.log('  hooks:   resume on their next fire.')
  } else {
    console.log('AgentlensPro is already enabled (no kill-switch flag present).')
  }
  return restartIntoCollection(plan, stats, dir, { envDir, ...restartDeps })
}

/** The /api/server-stats fields the enable restart reads (alcore server_stats.rs: `collection`, `startedBy` since
 *  TRDD-RBBEX59R c1 item 8). Every field is `unknown`: the answer comes from whatever listens on the UI port. */
export interface EnableStats { pid?: unknown; dataDir?: unknown; collection?: unknown; startedBy?: unknown }

/** What `agentlenspro enable` does to the running server after lifting the flag (TRDD-RBBEX59R c2 item 4). Each
 *  no-restart case has its own value and its own message (round 2, B):
 *  - no-answer / no-answer-braked: no server answered; with NO_REVIVE armed no hook will revive one either;
 *  - other-dir: the server that answered is another data dir's (or reports none) — not ours to restart;
 *  - already-on: the server for this dir already collects;
 *  - env-dir-mismatch: this dir's server is "off", but stopServer/ensureServer act on the ENV-resolved dir, which
 *    differs — the stop could hit another dir's server, so it stays off and the message names the remedy;
 *  - braked: NO_REVIVE is armed — honoured, no restart (no overrideBrake, no clearReviveBrake, no backoff reset,
 *    unlike `server restart`, which is the deliberate override);
 *  - env-armed: AGENTLENS_DISABLED=1 stays in the env, which the enable verb cannot lift — no restart;
 *  - supervisor: the supervisor owns the child — stop the child only and let the respawn (which recomputes
 *    alcoreServeArgs, so it comes back collecting) take the pid lock;
 *  - stop-and-start: anyone else started it — stopServer, then ensureServer('enable').
 *  ONE pure function of the stats answer, the brake and the env half, so every branch is unit-tested without a server. */
export type EnableRestartPlan = 'no-answer' | 'no-answer-braked' | 'other-dir' | 'already-on' | 'env-dir-mismatch'
  | 'braked' | 'env-armed' | 'supervisor' | 'stop-and-start'
export function enableRestartPlan(stats: EnableStats | null, o: { dir: string; envDir: string; noRevive: boolean; envHalfArmed: boolean }): EnableRestartPlan {
  if (stats === null) return o.noRevive ? 'no-answer-braked' : 'no-answer'
  const reported = typeof stats.dataDir === 'string' ? stats.dataDir : undefined
  if (statsOwnership(reported, o.dir) !== 'ours') return 'other-dir'
  if (stats.collection !== 'off') return 'already-on'
  if (statsOwnership(reported, o.envDir) !== 'ours') return 'env-dir-mismatch'
  if (o.noRevive) return 'braked'
  if (o.envHalfArmed) return 'env-armed'
  return stats.startedBy === 'supervisor' ? 'supervisor' : 'stop-and-start'
}

/** The verdict on the first server-stats answer for the dir after the supervisor branch stopped the child. Passes
 *  only on collection "on" AND startedBy "supervisor"; each failure has its own message (restartIntoCollection). */
export type SupervisorRespawn = 'ok' | 'no-answer' | 'still-off' | 'other-starter'
export function supervisorRespawnVerdict(answer: EnableStats | null): SupervisorRespawn {
  if (answer === null) return 'no-answer'
  if (answer.collection !== 'on') return 'still-off'
  return answer.startedBy === 'supervisor' ? 'ok' : 'other-starter'
}

/** Injectable effects of the restart, so the branches run in a unit test without a server or a supervisor.
 *  `envDir` is the env-resolved data dir stopServer/ensureServer act on (default dataDir()), named by the mismatch message. */
export interface EnableRestartDeps {
  fetchStats?: () => Promise<EnableStats | null>
  stopServer?: () => Promise<void>
  ensureServer?: () => Promise<void>
  parentPid?: (pid: number) => number | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  say?: (line: string) => void
  envDir?: string
}

async function defaultFetchStats(): Promise<EnableStats | null> {
  try { return await apiRequest('GET', '/api/server-stats', undefined, PROBE_TIMEOUT_MS) as EnableStats } catch { return null }
}

/** The parent of `pid` (`ps -o ppid=`), or null. The supervisor spawns its child without detaching, so the
 *  serving child's parent IS the supervisor; read BEFORE the stop, while the child is still the supervisor's.
 *  Bounded at 2 s: a wedged `ps` must not hang the verb before it has stopped anything. */
function defaultParentPid(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000 }).trim()
    const n = Number(out)
    return Number.isInteger(n) && n > 1 ? n : null
  } catch { return null }
}

/** Carry out an enableRestartPlan and return the verb's exit code. Exported for the unit tests of each branch. */
export async function restartIntoCollection(plan: EnableRestartPlan, stats: EnableStats | null, dir: string, deps: EnableRestartDeps = {}): Promise<number> {
  const say = deps.say ?? ((line: string) => console.log(line))
  const fetchStats = deps.fetchStats ?? defaultFetchStats
  const stop = deps.stopServer ?? stopServer
  const start = deps.ensureServer ?? (() => ensureServer('enable'))
  const sleepFor = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  const pid = Number(stats?.pid)
  if (plan === 'no-answer') {
    say('  server:  none answered for this data dir — the next failed hook POST revives one, collecting.')
    return EXIT.OK
  }
  if (plan === 'no-answer-braked') {
    say(`  server:  none answered for this data dir, and the NO_REVIVE brake is armed (${noRevivePath(dir)}) — no hook revives one while it stands.`)
    say('           `agentlenspro server start` lifts the brake and starts one, collecting.')
    return EXIT.OK
  }
  if (plan === 'other-dir') {
    const theirs = typeof stats?.dataDir === 'string' ? stats.dataDir : 'a data dir it does not report'
    say(`  server:  the server that answered (pid ${pid}) is for ${theirs}, not ${dir} — not restarted.`)
    return EXIT.OK
  }
  if (plan === 'already-on') {
    say(stats?.collection === 'on'
      ? `  server:  pid ${pid} already collects — nothing to restart.`
      : `  server:  pid ${pid} reports no collection mode (a build before no-collection mode, which always collects) — nothing to restart.`)
    return EXIT.OK
  }
  if (plan === 'env-dir-mismatch') {
    const envDir = deps.envDir ?? dataDir()
    say(`  server:  pid ${pid} for ${dir} keeps running in no-collection mode: this process resolves its data dir to ${envDir},`)
    say('           and the stop/start it would use act on that one, so enable does not touch the server.')
    say(`           Remedy: AGENTLENS_DATA_DIR=${dir} agentlenspro enable`)
    return EXIT.UNKNOWN
  }
  if (plan === 'braked') {
    // Non-zero, the same code as env-armed (round 2, C): the server the user asked to collect still does not.
    say(`  server:  pid ${pid} stays in no-collection mode: the NO_REVIVE brake is armed (${noRevivePath(dir)}), and enable honours it.`)
    say('           `agentlenspro server restart` is the deliberate override: it lifts the brake and restarts the server collecting.')
    return EXIT.UNKNOWN
  }
  if (plan === 'env-armed') return EXIT.UNKNOWN // runEnableCli reports the env half itself
  // A failed stop: report the error verbatim, spawn nothing. The flag is already lifted, so the old server keeps
  // running in the mode until it restarts. The remedy depends on the branch: a `server restart` in the supervisor
  // branch would race the supervisor for the pid lock, so there the remedy is to re-run enable.
  const stopOrReport = async (remedy: string): Promise<boolean> => {
    try { await stop(); return true } catch (e) {
      say(`  server:  ${(e as Error).message}`)
      say(`           The flag is lifted; the server keeps running in no-collection mode until it restarts. Remedy: ${remedy}.`)
      return false
    }
  }
  if (plan === 'stop-and-start') {
    // A supervisor whose own child lost the pid lock earlier is not visible in server-stats, so this path can still
    // meet one (inferred); ensureServer may then find the supervisor's respawn and do nothing.
    if (!(await stopOrReport('`agentlenspro server restart`'))) return EXIT.ABORT
    try { await start() } catch (e) {
      say(`  server:  stopped the no-collection server (pid ${pid}), but the start failed: ${(e as Error).message}`)
      return EXIT.ABORT
    }
    say('  server:  restarted — it collects again.')
    return EXIT.OK
  }
  // plan === 'supervisor'. Stop the CHILD only (stopServer signals the pid that owns the data dir, never the
  // supervisor); the supervisor respawns it after its backoff, and the respawn recomputes alcoreServeArgs without
  // --no-collection. stopServer followed by ensureServer here would race that respawn for the pid lock.
  const supervisorPid = (deps.parentPid ?? defaultParentPid)(pid)
  const supervisorName = supervisorPid === null ? 'pid unknown' : `pid ${supervisorPid}`
  if (!(await stopOrReport('re-run `agentlenspro enable`'))) return EXIT.ABORT
  // Budget: the supervisor's maximum backoff plus 5 s — the default is the supervisor's own constant (one source).
  // Read from THIS env; the supervisor reads its own (serverControl.ts runSupervise), so the two can differ — the
  // no-answer message says so.
  const budgetMs = (Number(process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS) || SUPERVISE_MAX_BACKOFF_DEFAULT_MS) + 5_000
  const deadline = now() + budgetMs
  let answer: EnableStats | null = null
  while (now() < deadline) {
    const s = await fetchStats()
    // The poll ends at the FIRST answer that reports this data dir.
    if (s !== null && statsOwnership(typeof s.dataDir === 'string' ? s.dataDir : undefined, dir) === 'ours') { answer = s; break }
    await sleepFor(500)
  }
  const verdict = supervisorRespawnVerdict(answer)
  if (verdict === 'ok') {
    say(`  server:  the supervisor (${supervisorName}) respawned it as pid ${String(answer?.pid)} — it collects again.`)
    return EXIT.OK
  }
  if (verdict === 'no-answer') {
    say(`  server:  stopped the no-collection child (pid ${pid}); the supervisor (${supervisorName}) did not respawn a server for ${dir} within ${Math.round(budgetMs / 1000)}s.`)
    say('           The respawn may still come (the supervisor reads its own AGENTLENS_SUPERVISE_MAX_BACKOFF_MS). The flag is lifted:')
    say('           once no server runs, the next failed hook POST revives one, collecting.')
    return EXIT.ABORT
  }
  if (verdict === 'still-off') {
    say(`  server:  the supervisor (${supervisorName}) respawned pid ${String(answer?.pid)}, but it reports collection "${String(answer?.collection)}" —`)
    say('           most likely the supervisor environment still sets AGENTLENS_DISABLED=1, which the enable verb cannot lift. Restart the supervisor without it.')
    return EXIT.ABORT
  }
  // verdict === 'other-starter' (S2). Inferred race: a hook revive won the pid lock in the respawn gap. The supervisor
  // is then respawn-looping: alcore exits 1 on a held pid lock (rust-core alcore.rs, pid_lock Refused) and the
  // supervisor respawns every exit except 78 with backoff (runSupervise), so it never serves again while that server
  // runs. `server stop` signals the data-dir owner only, never a supervisor (serverControl.ts 'stop' case).
  const servingPid = String(answer?.pid)
  const supKill = supervisorPid === null ? '<the supervisor pid>' : String(supervisorPid)
  say(`  server:  collection is on now: the server for ${dir} is pid ${servingPid}, started by "${String(answer?.startedBy ?? 'unknown')}", not by the supervisor (${supervisorName}).`)
  say('           The flag is lifted, so enable did its job; the supervisor is respawn-looping — its child keeps losing the pid lock to that server.')
  say('           Pick one:')
  say(`           (a) keep the supervisor: \`agentlenspro server stop\` stops pid ${servingPid} (not the supervisor); its next respawn, or else the next failed hook POST, takes over, collecting.`)
  say(`           (b) drop the supervisor: kill -TERM ${supKill}; pid ${servingPid} keeps collecting.`)
  return EXIT.ABORT
}
