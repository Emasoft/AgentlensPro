// The post-verb version check (TRDD-YL3EWT6N item 10): after an ordinary CLI verb, make sure the running server is the
// build that is installed on disk, and restart it when it is not.
//
// WHY it exists: the owner order is that a package update takes effect at the FIRST run of the new CLI. The CLI, skills,
// agents and hooks already heal at launch (autoSetup.ts), but a server still running the old alcore after the update kept
// serving the old code until someone restarted it by hand.
//
// WHY after the verb and not before: the restart wait is unmeasured, and the verb the user typed must never wait for it.
// cliMain (main.ts) calls this once the verb has returned, and its lines go through the launch-notice say.
//
// The decision is ONE pure function (versionRestartPlan) over the observations, so every branch is unit-tested without a
// server; runVersionCheck gathers the observations in order, cheapest first, and carries the decision out. Every effect is
// injectable (VersionCheckDeps). It never throws: a failure is one line.
import * as fs from "fs"
import * as path from "path"
import { execFile, execFileSync } from "child_process"
import { alcoreBin, ensureServer, resolveBinNativeDir, statsOwnership, stopServer } from "./serverControl"
import { apiRequest, dataDir, PROBE_TIMEOUT_MS, sleep } from "./cliCore"
import { reviveBraked } from "./killSwitch"
import { liveLockPid, processAlive } from "./portSelect"
import { pushNotice } from "./launchNotices"
import { packageVersion } from "../packageVersion"

/** What identifies the alcore binary on disk: a rebuilt or replaced file changes at least one of the three. */
export interface BinIdentity { path: string; size: number; mtimeMs: number }

/** The /api/server-stats fields this check reads. Every field is unknown: the answer comes from whatever listens on the UI port. */
export interface VersionStats { pid?: unknown; dataDir?: unknown; version?: unknown; startedBy?: unknown }

/** What `alcore version` answered: the version, or why it could not be read. */
export type DiskProbe = { ok: true; version: string } | { ok: false; detail: string }

/** Every way a check can end, one value each (a test asserts on the value):
 *  - none-no-server: no live pidfile owner for this data dir, nothing else ran;
 *  - braked: NO_REVIVE is armed (file or env): a restart would stop the server and the start would be refused;
 *  - none-no-binary: no alcore binary to compare with;
 *  - no-answer: a pidfile owner exists but nothing answered server-stats;
 *  - other-dir / env-dir-mismatch: the answering server is not the one stopServer/ensureServer act on (as enableRestartPlan);
 *  - gave-up: an earlier restart for this binary and this running version did not converge: silent;
 *  - probe-failed: `alcore version` could not be read (an alcore older than the subcommand exits 64, an unsigned one 137);
 *  - same: disk, running and CLI versions agree;
 *  - cli-differs: disk equals running but this CLI is another version: one warning, no restart;
 *  - restart-supervisor / restart-stop-start: disk differs from running, restart by who started the server. */
export type VersionVerdict = "none-no-server" | "braked" | "none-no-binary" | "no-answer" | "other-dir" | "env-dir-mismatch"
  | "gave-up" | "probe-failed" | "same" | "cli-differs" | "restart-supervisor" | "restart-stop-start"

/** What runVersionCheck returns: a verdict, or what became of a restart, or why it stopped before deciding. */
export type VersionOutcome = VersionVerdict | "memo-hit" | "lock-held" | "restarted" | "not-converged" | "error"

/** The memo file: what the last check concluded, so the next launch costs one stat and one small read. */
export interface VersionMemo {
  identity: BinIdentity
  cliVersion: string
  pid: number
  verdict: string
  /** Set only by a restart that did not converge. Keyed on the binary identity and the RUNNING VERSION, never on the pid:
   *  a respawned server with a new pid and the same old version must still not be restarted again. */
  gaveUp: { identity: BinIdentity; running: string } | null
  time: string
}

/** The verdicts a memo may short-circuit. Transient ones (no-answer, lock-held, error) are never written: they must be retried. */
const MEMOIZED_VERDICTS: ReadonlySet<string> = new Set(["same", "cli-differs", "probe-failed", "restarted"])

const sameIdentity = (a: BinIdentity, b: BinIdentity): boolean => a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs

/** The version the answering server reports. A server older than version reporting omits it: it is older than any build that has it. */
export function runningVersion(stats: VersionStats): string {
  return typeof stats.version === "string" ? stats.version : "unknown"
}

/** True when nothing that decides the verdict can have changed since the memo was written: same binary, same CLI, same server
 *  pid. Then no GET and no `alcore version` run at all. */
export function memoHit(memo: VersionMemo | null, identity: BinIdentity, cliVersion: string, pid: number): boolean {
  return memo !== null && MEMOIZED_VERDICTS.has(memo.verdict) && memo.cliVersion === cliVersion && memo.pid === pid && sameIdentity(memo.identity, identity)
}

export interface VersionPlanInput {
  stats: VersionStats | null
  dir: string
  envDir: string
  cliVersion: string
  /** null = not probed (the caller has no need yet): reads as probe-failed, so a caller learns whether it needs the probe. */
  disk: DiskProbe | null
  gaveUp: boolean
}

/** ONE pure function of what was observed, so every branch is unit-tested without a server. `warnCli` is true when the CLI
 *  differs from the disk version: with cli-differs that is the verdict itself, and with a restart it adds one warning
 *  (the three versions all differ: restart, because the disk binary is what runs next, and say that the CLI is another build). */
export function versionRestartPlan(o: VersionPlanInput): { verdict: VersionVerdict; warnCli: boolean } {
  const plain = (verdict: VersionVerdict): { verdict: VersionVerdict; warnCli: boolean } => ({ verdict, warnCli: false })
  if (o.stats === null) return plain("no-answer")
  const reported = typeof o.stats.dataDir === "string" ? o.stats.dataDir : undefined
  if (statsOwnership(reported, o.dir) !== "ours") return plain("other-dir")
  if (statsOwnership(reported, o.envDir) !== "ours") return plain("env-dir-mismatch")
  if (o.gaveUp) return plain("gave-up")
  if (o.disk === null || !o.disk.ok) return plain("probe-failed")
  const running = runningVersion(o.stats)
  const warnCli = o.cliVersion !== o.disk.version
  if (o.disk.version === running) return { verdict: warnCli ? "cli-differs" : "same", warnCli }
  return { verdict: o.stats.startedBy === "supervisor" ? "restart-supervisor" : "restart-stop-start", warnCli }
}

const LOCK_NAME = "version-restart.lock"
/** A lock file that holds no parseable pid is a taker between its open and its write; older than this it is garbage. */
const LOCK_UNPARSEABLE_FRESH_MS = 10_000

function readLockHolder(file: string): number | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

/** Take <dir>/version-restart.lock. Returns the release function, or null when another live process holds it.
 *  Created with open "wx" holding the pid. A DEAD holder is taken over by writing a temp file and RENAMING it over the lock
 *  (atomic: there is never a moment with no lock file), then re-reading: of two takers that both saw the dead holder, the
 *  later rename wins and the earlier one reads the other pid and stands down, so exactly one proceeds. Release removes the
 *  file only while it still holds our pid, so a taker that lost never deletes the winner lock. `beforeReread` is the seam
 *  that lets a test run the other taker between our rename and our re-read. */
export function acquireVersionLock(dir: string, ownPid: number, io: { pidAlive?: (pid: number) => boolean; now?: () => number; beforeReread?: () => void } = {}): (() => void) | null {
  const file = path.join(dir, LOCK_NAME)
  const alive = io.pidAlive ?? processAlive
  const now = io.now ?? Date.now
  const release = (): void => {
    if (readLockHolder(file) !== ownPid) return
    try { fs.unlinkSync(file) } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e }
  }
  fs.mkdirSync(dir, { recursive: true })
  try {
    const fd = fs.openSync(file, "wx")
    try { fs.writeSync(fd, String(ownPid)) } finally { fs.closeSync(fd) }
    return release
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
  }
  const holder = readLockHolder(file)
  if (holder !== null && alive(holder)) return null
  if (holder === null && now() - fs.statSync(file).mtimeMs < LOCK_UNPARSEABLE_FRESH_MS) return null
  const tmp = `${file}.${ownPid}.tmp`
  fs.writeFileSync(tmp, String(ownPid))
  fs.renameSync(tmp, file)
  io.beforeReread?.()
  return readLockHolder(file) === ownPid ? release : null
}

const memoPath = (dir: string): string => path.join(dir, "version-check.json")

const isIdentity = (v: unknown): v is BinIdentity => {
  const o = v as BinIdentity | null
  return typeof o === "object" && o !== null && typeof o.path === "string" && typeof o.size === "number" && typeof o.mtimeMs === "number"
}

/** The memo, or null when absent or not the shape this code writes: an unreadable memo only costs one fresh check. */
export function readVersionMemo(dir: string): VersionMemo | null {
  let parsed: unknown
  try { parsed = JSON.parse(fs.readFileSync(memoPath(dir), "utf8")) } catch { return null }
  const m = parsed as VersionMemo | null
  if (typeof m !== "object" || m === null || !isIdentity(m.identity) || typeof m.cliVersion !== "string" || typeof m.pid !== "number" || typeof m.verdict !== "string" || typeof m.time !== "string") return null
  if (m.gaveUp !== null && !(typeof m.gaveUp === "object" && isIdentity(m.gaveUp.identity) && typeof m.gaveUp.running === "string")) return null
  return m
}

/** tmp + rename, so a concurrent reader never sees half a file. */
export function writeVersionMemo(dir: string, memo: VersionMemo): void {
  const tmp = `${memoPath(dir)}.${process.pid}.tmp`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(memo))
  fs.renameSync(tmp, memoPath(dir))
}

/** Run `<bin> version` and read the version it prints. A non-zero exit, a signal (a SIGKILLed child reports no exit code in
 *  Node), a timeout, a spawn error and an empty or multi-word stdout are all probe failures. */
export function probeAlcoreVersion(bin: string, timeoutMs = 5_000): Promise<DiskProbe> {
  return new Promise(resolve => {
    execFile(bin, ["version"], { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        const detail = e.killed === true && e.signal === "SIGKILL" && typeof e.code !== "number" ? `timed out after ${timeoutMs} ms`
          : typeof e.signal === "string" ? `killed by ${e.signal}`
          : typeof e.code === "number" ? `exit ${e.code}`
          : e.message
        resolve({ ok: false, detail })
        return
      }
      const version = stdout.trim()
      resolve(/^\S+$/.test(version) ? { ok: true, version } : { ok: false, detail: `unexpected output ${JSON.stringify(version.slice(0, 60))}` })
    })
  })
}

/** The parent of pid (`ps -o ppid=`), or null; the supervisor spawns its child without detaching, so it is the parent. It only
 *  names the supervisor in the output. Same helper as disableCli.ts defaultParentPid (which is not exported). */
function defaultParentPid(pid: number): number | null {
  try {
    const n = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim())
    return Number.isInteger(n) && n > 1 ? n : null
  } catch { return null }
}

async function defaultFetchStats(): Promise<VersionStats | null> {
  try { return await apiRequest("GET", "/api/server-stats", undefined, PROBE_TIMEOUT_MS) as VersionStats } catch { return null }
}

/** stopServer and ensureServer print their own progress with console.log. This check runs AFTER a verb whose stdout may be
 *  piped (a JSON result), so those lines must not reach stdout: the check reports through its own say (stderr). */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log
  console.log = (): void => { /* swallowed on purpose: see above */ }
  try { return await fn() } finally { console.log = log }
}

/** The binary exactly as ensureServer resolves it (same arguments), so the file compared is the file that would be started. */
function defaultAlcoreBin(): string | null {
  return alcoreBin(process.env, undefined, undefined, resolveBinNativeDir())
}

function defaultStatFile(file: string): { size: number; mtimeMs: number } | null {
  try { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs } } catch { return null }
}

/** Every effect of the check, injectable so each branch runs in a unit test without a server, a binary or a clock. */
export interface VersionCheckDeps {
  env?: NodeJS.ProcessEnv
  dataDir?: string
  /** The env-resolved data dir stopServer/ensureServer act on (default dataDir()). */
  envDir?: string
  cliVersion?: string
  readPidfile?: (dir: string) => number | null
  pidAlive?: (pid: number) => boolean
  alcoreBin?: () => string | null
  statFile?: (file: string) => { size: number; mtimeMs: number } | null
  readMemo?: (dir: string) => VersionMemo | null
  writeMemo?: (dir: string, memo: VersionMemo) => void
  fetchStats?: () => Promise<VersionStats | null>
  probe?: (bin: string) => Promise<DiskProbe>
  stopServer?: () => Promise<void>
  ensureServer?: () => Promise<void>
  parentPid?: (pid: number) => number | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  say?: (line: string) => void
  lock?: (dir: string) => (() => void) | null
}

/** Budget for the new server to answer with the disk version, polled every 500 ms. */
const CONVERGE_BUDGET_MS = 30_000

/** The check. Gathers the observations cheapest first (a pidfile read, the brake, one stat, the memo), then takes the lock,
 *  then the network (one GET, one `alcore version`), then decides with versionRestartPlan and acts. Never throws. */
export async function runVersionCheck(deps: VersionCheckDeps = {}): Promise<VersionOutcome> {
  const env = deps.env ?? process.env
  const say = deps.say ?? pushNotice
  try {
    const dir = deps.dataDir ?? dataDir()
    const pid = (deps.readPidfile ?? liveLockPid)(dir)
    if (pid === null || !(deps.pidAlive ?? processAlive)(pid)) return "none-no-server"
    if (env.AGENTLENS_NO_REVIVE === "1" || reviveBraked(dir)) return "braked"
    const bin = (deps.alcoreBin ?? defaultAlcoreBin)()
    const st = bin === null ? null : (deps.statFile ?? defaultStatFile)(bin)
    if (bin === null || st === null) return "none-no-binary"
    const identity: BinIdentity = { path: bin, size: st.size, mtimeMs: st.mtimeMs }
    const cliVersion = deps.cliVersion ?? packageVersion()
    const readMemo = deps.readMemo ?? readVersionMemo
    const memo = readMemo(dir)
    if (memoHit(memo, identity, cliVersion, pid)) return "memo-hit"
    // The lock comes BEFORE the fetch and the probe, so the decision is made under it: a second process holding a stale
    // answer could otherwise stop the server the first one has just restarted. A live holder means a check is running: silent.
    const release = (deps.lock ?? ((d: string) => acquireVersionLock(d, process.pid)))(dir)
    if (release === null) return "lock-held"
    try {
      return await checkUnderLock({ deps, say, dir, pid, bin, identity, cliVersion })
    } finally { release() }
  } catch (e) {
    say(`agentlenspro: the server version check failed (${(e as Error).message.slice(0, 160)}) — if the running server is out of date, run \`agentlenspro server restart\``)
    return "error"
  }
}

interface Gathered {
  deps: VersionCheckDeps
  say: (line: string) => void
  dir: string
  pid: number
  bin: string
  identity: BinIdentity
  cliVersion: string
}

async function checkUnderLock(g: Gathered): Promise<VersionOutcome> {
  const { deps, say, dir, pid, bin, identity, cliVersion } = g
  // Read AGAIN under the lock: the memo read before it may predate a restart that just failed to converge, and acting on that
  // stale copy would repeat the restart the other process has already given up on.
  const memo = (deps.readMemo ?? readVersionMemo)(dir)
  const fetchStats = deps.fetchStats ?? defaultFetchStats
  const now = deps.now ?? Date.now
  const remember = (verdict: string, atPid: number, gaveUp: VersionMemo["gaveUp"]): void => {
    (deps.writeMemo ?? writeVersionMemo)(dir, { identity, cliVersion, pid: atPid, verdict, gaveUp, time: new Date(now()).toISOString() })
  }
  const stats = await fetchStats()
  const envDir = deps.envDir ?? dataDir()
  const gaveUp = stats !== null && memo?.gaveUp != null && sameIdentity(memo.gaveUp.identity, identity) && memo.gaveUp.running === runningVersion(stats)
  const base = { stats, dir, envDir, cliVersion, gaveUp }
  // Plan once WITHOUT the probe: every verdict except probe-failed is already decided by the stats alone (no answer, another
  // data dir, gave-up), and then `alcore version` is never run. probe-failed is what an unprobed plan reads as: probe, plan again.
  let plan = versionRestartPlan({ ...base, disk: null })
  let disk: DiskProbe | null = null
  if (plan.verdict === "probe-failed") {
    disk = await (deps.probe ?? probeAlcoreVersion)(bin)
    plan = versionRestartPlan({ ...base, disk })
  }
  const running = stats === null ? "unknown" : runningVersion(stats)
  switch (plan.verdict) {
    case "none-no-server": case "braked": case "none-no-binary": case "no-answer": case "other-dir": case "env-dir-mismatch": case "gave-up":
      return plan.verdict
    case "probe-failed":
      say(`agentlenspro: could not read the version of ${bin} (${disk !== null && !disk.ok ? disk.detail : "not probed"}) — the running server (v${running}) was not compared with it`)
      remember("probe-failed", pid, null)
      return "probe-failed"
    case "same":
      remember("same", pid, null)
      return "same"
    case "cli-differs":
      say(`agentlenspro: this CLI is v${cliVersion} but the installed server binary and the running server are v${running} — they come from different installs`)
      remember("cli-differs", pid, null)
      return "cli-differs"
    default:
      break
  }
  // restart-supervisor or restart-stop-start: versionRestartPlan returns them only for a successful probe that differs from what runs.
  if (disk === null || !disk.ok) throw new Error("a restart was planned without a readable disk version")
  const diskVersion = disk.version
  if (plan.warnCli) say(`agentlenspro: this CLI is v${cliVersion} but the installed server binary is v${diskVersion} — they come from different installs`)
  const sayStuck = (reason: string): void => say(`agentlenspro: the running server is v${running} but the installed binary is v${diskVersion}; ${reason} — run \`agentlenspro server restart\``)
  const stop = deps.stopServer ?? (() => quietly(stopServer))
  // ensureServer WITHOUT overrideBrake: the brake was checked above and a set brake never reaches here, but if one is armed
  // between that check and this start, the start must refuse rather than lift it. This check never clears a brake and never
  // resets the revive backoff: only the deliberate `server start|restart` does.
  const start = deps.ensureServer ?? (() => quietly(() => ensureServer("version-restart")))
  const sleepFor = deps.sleep ?? sleep
  const oldPid = Number(stats?.pid)
  const supervisorPid = plan.verdict === "restart-supervisor" ? (deps.parentPid ?? defaultParentPid)(oldPid) : null
  const giveUp = (reason: string): VersionOutcome => {
    sayStuck(reason)
    // Keyed on the binary and the running version, never on the pid: a respawn with a new pid must not be restarted again.
    remember("gave-up", pid, { identity, running })
    return "not-converged"
  }
  try { await stop() } catch (e) { return giveUp(`the stop failed (${(e as Error).message.slice(0, 160)})`) }
  if (plan.verdict === "restart-stop-start") {
    // Anyone but the supervisor started it: nobody respawns it, so start it here.
    try { await start() } catch (e) { return giveUp(`the start failed (${(e as Error).message.slice(0, 160)})`) }
  }
  // restart-supervisor: only the child was stopped (stopServer signals the pid that owns the data dir, never the supervisor);
  // the supervisor respawns it from the disk binary, so the wait below is for that respawn. A stop followed by ensureServer
  // here would race the respawn for the pid lock.
  const deadline = now() + CONVERGE_BUDGET_MS
  while (now() < deadline) {
    const s = await fetchStats()
    if (s !== null && statsOwnership(typeof s.dataDir === "string" ? s.dataDir : undefined, dir) === "ours" && runningVersion(s) === diskVersion) {
      const newPid = Number(s.pid)
      say(`agentlenspro: restarted the server (pid ${oldPid} to ${newPid}): v${running} to v${diskVersion}${supervisorPid === null ? "" : ` by its supervisor (pid ${supervisorPid})`}`)
      remember("restarted", Number.isFinite(newPid) ? newPid : pid, null)
      return "restarted"
    }
    await sleepFor(500)
  }
  return giveUp(`no server reporting v${diskVersion} answered within ${Math.round(CONVERGE_BUDGET_MS / 1000)} s`)
}
