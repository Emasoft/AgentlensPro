// src/cli/diskLaunchd.ts — `agentlenspro disk-monitor install|uninstall|status`: the two disk-monitor jobs (TRDD-HTARKH87, TRDD-RU9A8H7A).
//
// Their OWN launchd agents, not threads of the collector: the monitor must keep recording while the
// collector is stopped, crashed or DISABLED — that is when a disk quietly fills. `disk-sample --volumes-only` runs every 60 s and
// `disk-sample --walks-only` every 300 s; there is no KeepAlive, so nothing restarts a failing sampler in a
// tight loop, the next interval simply tries again.

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

/** One launchd job. Two exist because the minute job must stay short: launchd counts StartInterval from the previous run's exit, so a run
 *  that also walked folders (up to ~41 s) made the volume rows land every ~101 s instead of 60 s (TRDD-RU9A8H7A). */
export interface DiskJob {
  label: string
  /** The `disk-sample` mode flag the job passes. */
  flag: "--volumes-only" | "--walks-only"
  intervalS: number
  logFile: string
  /** launchd's ProcessType for this job. */
  processType: "Standard" | "Background"
}

export const DISK_JOBS: readonly DiskJob[] = [
  // SUSPECTED, not established: Background lets launchd throttle and coalesce the timer under heavy load. On 2026-11-16 at load 128-169 the minute job ran 3 times in 8 minutes, one gap exactly 7 x 60 s with no sleep (TRDD-RU9A8H7A). The minute job is a cheap statfs read, so it runs Standard; the 5-minute folder walk stays Background.
  { label: DISK_LABEL, flag: "--volumes-only", intervalS: 60, logFile: "disk-sample.log", processType: "Standard" },
  { label: DISK_WALK_LABEL, flag: "--walks-only", intervalS: 300, logFile: "disk-walk.log", processType: "Background" },
]

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function diskLogPath(job: DiskJob, dir: string = dataDir()): string {
  return path.join(dir, "logs", job.logFile)
}

export function diskPlist(p: { node: string; cli: string; dataDir: string; job: DiskJob }): string {
  const log = xml(diskLogPath(p.job, p.dataDir))
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
    <string>${p.job.flag}</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>${p.job.intervalS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>${p.job.processType}</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
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

/** Write both plists and (unless `load: false`) bootstrap them; a re-install replaces them (bootout first). `launchAgentsDir` + `load: false` make it testable without touching the real system. */
export function diskMonitorInstall(opts: { launchAgentsDir?: string; load?: boolean; launchctl?: (args: string[]) => string } = {}): { jobs: { label: string; path: string; loaded: boolean }[] } {
  if (process.platform !== "darwin") throw new Error("disk-monitor install: launchd is macOS-only — nothing was installed")
const ctl = opts.launchctl ?? launchctl // injectable so the rollback path is testable without touching the real launchd
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
      try { ctl(["bootout", `${domain()}/${job.label}`]) } catch { /* not loaded yet */ }
      try {
        ctl(["bootstrap", domain(), file])
      } catch (e) {
// Half-installed is worse than not installed (one job recording, the other silent): unload what this call already loaded, then fail loudly.
        // On a RE-install the old copy of each job was already booted out above, so after a failure nothing is loaded; the plists stay on disk and the error says why.
        for (const done of bootstrapped) { try { ctl(["bootout", `${domain()}/${done}`]) } catch { /* best effort; the original error is the one to report */ } }
        throw e
      }
      bootstrapped.push(job.label)
      loaded = true
    }
    console.log(`disk-monitor install: ${file} (${opts.load === false ? "written, not loaded" : "loaded"}); ${job.flag === "--volumes-only" ? "volume rows" : "folder walks"} every ${job.intervalS} s into ${path.join(dataDir(), "disk.duckdb")}`)
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
  install    write ~/Library/LaunchAgents/${DISK_LABEL}.plist (volume rows every 60 s) and ${DISK_WALK_LABEL}.plist (folder walks
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
