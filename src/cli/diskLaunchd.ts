// src/cli/diskLaunchd.ts — `agentlenspro disk-monitor install|uninstall|status`: the two disk-monitor jobs (TRDD-HTARKH87, TRDD-RU9A8H7A).
//
// Their OWN launchd agents, not threads of the collector: the monitor must keep recording while the
// collector is stopped, crashed or DISABLED — that is when a disk quietly fills. `disk-sample --volumes-only --resident` is a resident 5-minute loop and
// `disk-sample --walks-only` runs every 300 s. The sampler job has KeepAlive because a fresh node process per minute missed its 60 s slot under
// load (runs of 24-47 s at load 194-258) while a resident loop woke 0-5 ms late (TRDD-T16ZQH9F). ThrottleInterval 60 means a crashing sampler restarts at most once a minute.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { dataDir } from "../dataDir"
import { EXIT, UsageError } from "./cliErrors"
import { openReadOnly } from "./diskStore"
import { cliJsPath } from "./serverControl"

export const DISK_LABEL = "com.agentlens.disk-sample"
export const DISK_WALK_LABEL = "com.agentlens.disk-walk"

/** One launchd job. Two exist so the sampler job never waits on a folder walk: an interval job counts from the previous run's exit, so a run
 *  that also walked folders (up to ~41 s) made the volume rows land every ~101 s instead of 60 s (TRDD-RU9A8H7A). The fields below are exactly what differs between them. */
export interface DiskJob {
  label: string
  /** The `disk-sample` arguments the job passes before `--quiet`. */
  args: readonly string[]
  /** How launchd runs it: `interval` = a fresh process every `seconds`; `keepAlive` = one resident process, restarted at most once per `throttleS`. */
  schedule: { kind: "interval"; seconds: number } | { kind: "keepAlive"; throttleS: number }
  logFile: string
  /** launchd's ProcessType for this job. */
  processType: "Standard" | "Background"
  /** Nice 10 + LowPriorityIO. The resident sampler runs at default priority: that is how the measured winner ran (TRDD-T16ZQH9F). */
  lowPriority: boolean
}

export const DISK_JOBS: readonly DiskJob[] = [
  // Resident, KeepAlive, Standard, default priority: measured 2026-11-16 under load 194-258 (TRDD-T16ZQH9F) — a fresh process per minute missed its slot, a resident loop did not.
  { label: DISK_LABEL, args: ["--volumes-only", "--resident"], schedule: { kind: "keepAlive", throttleS: 60 }, logFile: "disk-sample.log", processType: "Standard", lowPriority: false },
  { label: DISK_WALK_LABEL, args: ["--walks-only"], schedule: { kind: "interval", seconds: 300 }, logFile: "disk-walk.log", processType: "Background", lowPriority: true },
]

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function diskLogPath(job: DiskJob, dir: string = dataDir()): string {
  return path.join(dir, "logs", job.logFile)
}

export function diskPlist(p: { node: string; cli: string; dataDir: string; job: DiskJob }): string {
  const log = xml(diskLogPath(p.job, p.dataDir))
  const schedule = p.job.schedule.kind === "interval"
    ? `  <key>StartInterval</key>
  <integer>${p.job.schedule.seconds}</integer>
`
    : `  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${p.job.schedule.throttleS}</integer>
`
  const priority = p.job.lowPriority
    ? `  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
`
    : ""
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${p.job.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>${xml(p.cli)}</string>
    <string>disk-sample</string>
${p.job.args.map(a => `    <string>${xml(a)}</string>\n`).join("")}    <string>--quiet</string>
  </array>
${schedule}  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>${p.job.processType}</string>
${priority}  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTLENS_DATA_DIR</key>
    <string>${xml(p.dataDir)}</string>
  </dict>
</dict>
</plist>
`
}

function plistPath(job: DiskJob, launchAgentsDir?: string): string {
  return path.join(launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents"), `${job.label}.plist`)
}

const domain = (): string => `gui/${process.getuid?.() ?? 0}`

function launchctl(args: string[]): string {
  return execFileSync("launchctl", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
}

/** Synchronous sleep: launchctl is called with execFileSync, so the wait between two probes cannot be a promise. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const BOOTOUT_POLL_MS = 200
const BOOTOUT_WAIT_MS = 15_000
const BOOTSTRAP_TRIES = 3
const BOOTSTRAP_RETRY_MS = 500

/** Replace a job that may be loaded: bootout, WAIT until launchd no longer knows the label, then bootstrap (up to BOOTSTRAP_TRIES).
 *  WHY the wait (TRDD-77TSOX08): bootout returns before launchd has removed the service (measured 2026-11-16 in launchd's log: the bootstrap arrived 4.7 ms after the bootout and was refused with 37: Operation already in progress; the service was removed 6.6 ms later), and a
 *  bootstrap of the same label in that gap fails with "Bootstrap failed: 5: Input/output error" (launchctl's text for that refusal) — which left the always-alive resident sampler unloaded.
 *  `launchctl print` failing is the sign that the service is gone. */
function reloadJob(ctl: (args: string[]) => string, sleep: (ms: number) => void, label: string, file: string): void {
  try { ctl(["bootout", `${domain()}/${label}`]) } catch { /* not loaded yet */ }
  for (let waited = 0; ; waited += BOOTOUT_POLL_MS) {
    try { ctl(["print", `${domain()}/${label}`]) } catch { break }
    if (waited >= BOOTOUT_WAIT_MS) {
      throw new Error(`disk-monitor install: ${label} is still loaded ${BOOTOUT_WAIT_MS / 1000} s after bootout; it was told to stop and was NOT loaded again — run agentlenspro disk-monitor install once more`)
    }
    sleep(BOOTOUT_POLL_MS)
  }
  for (let attempt = 1; ; attempt++) {
    try {
      ctl(["bootstrap", domain(), file])
      return
    } catch (e) {
      if (attempt >= BOOTSTRAP_TRIES) throw e
      sleep(BOOTSTRAP_RETRY_MS)
    }
  }
}

/** Write both plists and (unless `load: false`) bootstrap them; a re-install replaces them (bootout first). `launchAgentsDir` + `load: false` make it testable without touching the real system. `sleep` is injectable for the same reason. */
export function diskMonitorInstall(opts: { launchAgentsDir?: string; load?: boolean; launchctl?: (args: string[]) => string; sleep?: (ms: number) => void } = {}): { jobs: { label: string; path: string; loaded: boolean }[] } {
  if (process.platform !== "darwin") throw new Error("disk-monitor install: launchd is macOS-only — nothing was installed")
  const ctl = opts.launchctl ?? launchctl // injectable so the rollback path is testable without touching the real launchd
  const sleep = opts.sleep ?? sleepSync
  const bootstrapped: string[] = []
  const jobs = DISK_JOBS.map(job => {
    const file = plistPath(job, opts.launchAgentsDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.mkdirSync(path.dirname(diskLogPath(job)), { recursive: true })
    // temp + rename: an interrupted write must not leave a truncated plist for launchd to refuse silently.
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, diskPlist({ node: process.execPath, cli: cliJsPath(), dataDir: dataDir(), job }))
    fs.renameSync(tmp, file)
    let loaded = false
    if (opts.load !== false) {
      try {
        reloadJob(ctl, sleep, job.label, file)
      } catch (e) {
// Half-installed is worse than not installed (one job recording, the other silent): unload what this call already loaded, then fail loudly.
        // On a RE-install the old copy of each job was already booted out (inside reloadJob), so a job whose reload failed may not be loaded, and a job LATER in the list was not reached and keeps its old registration. The plists stay on disk and the error says why.
        for (const done of bootstrapped) { try { ctl(["bootout", `${domain()}/${done}`]) } catch { /* best effort; the original error is the one to report */ } }
        throw e
      }
      bootstrapped.push(job.label)
      loaded = true
    }
    const cadence = job.schedule.kind === "interval" ? `folder walks every ${job.schedule.seconds} s` : "volume rows every 5 minutes (resident sampler)"
    console.log(`disk-monitor install: ${file} (${opts.load === false ? "written, not loaded" : "loaded"}); ${cadence} into ${path.join(dataDir(), "disk.duckdb")}`)
    return { label: job.label, path: file, loaded }
  })
  return { jobs }
}

export function diskMonitorUninstall(opts: { launchAgentsDir?: string; load?: boolean } = {}): { jobs: { label: string; path: string; removed: boolean }[] } {
  const jobs = DISK_JOBS.map(job => {
    const file = plistPath(job, opts.launchAgentsDir)
    if (process.platform === "darwin" && opts.load !== false) {
      try { launchctl(["bootout", `${domain()}/${job.label}`]) } catch { /* not loaded */ }
    }
    let removed = false
    try { fs.unlinkSync(file); removed = true } catch { /* already gone */ }
    console.log(`disk-monitor uninstall: ${removed ? `removed ${file}` : `${job.label}: nothing to remove`} (the recorded history in disk.duckdb is kept)`)
    return { label: job.label, path: file, removed }
  })
  return { jobs }
}

async function status(): Promise<number> {
  let allLoaded = true
  for (const job of DISK_JOBS) {
    const file = plistPath(job)
    let loaded = false
    let lastExit = "unknown"
    try {
      const out = launchctl(["print", `${domain()}/${job.label}`])
      loaded = true
      lastExit = /last exit code = (\S+)/.exec(out)?.[1] ?? "never ran"
    } catch { /* not loaded */ }
    console.log(`${job.label}  plist: ${fs.existsSync(file) ? file : "not installed"}`)
    console.log(`${job.label}  launchd: ${loaded ? `loaded (last exit code: ${lastExit})` : "not loaded"}`)
    if (!loaded || !fs.existsSync(file)) allLoaded = false
  }
  try {
    const db = await openReadOnly()
    try {
      const r = (await db.con.runAndReadAll("SELECT cast(max(ts) AS VARCHAR) AS last, count(*) AS n FROM disk_volume")).getRowObjects()[0]
      console.log(`last row:  ${r.last ?? "none"} (${r.n} volume rows)`)
    } finally {
      db.close()
    }
  } catch (e) {
    console.log(`last row:  ${e instanceof Error ? e.message : String(e)}`)
  }
  return allLoaded ? EXIT.OK : EXIT.UNKNOWN
}

export const DISK_MONITOR_USAGE = `usage: agentlenspro disk-monitor install | uninstall | status
  install    write ~/Library/LaunchAgents/${DISK_LABEL}.plist (resident sampler, volume rows every 5 minutes) and ${DISK_WALK_LABEL}.plist (folder walks
             every 300 s) and load both, even with no Claude session and even while agentlenspro is DISABLED (macOS only)
  uninstall  unload and delete both plists; the recorded history is kept
  status     both plists, their launchd state, and the time of the newest recorded row (exit 0 = both installed and loaded)`

export async function runDiskMonitorCli(argv: string[]): Promise<number> {
  const sub = argv[0]
  if (argv.length === 0) { console.log(DISK_MONITOR_USAGE); return EXIT.USAGE } // --help never gets here: main.ts answers it
  if (argv.length !== 1 || (sub !== "install" && sub !== "uninstall" && sub !== "status")) {
    throw new UsageError("disk-monitor expects install | uninstall | status")
  }
  if (sub === "install") { diskMonitorInstall(); return EXIT.OK }
  if (sub === "uninstall") { diskMonitorUninstall(); return EXIT.OK }
  return status()
}
