// src/cli/diskLaunchd.ts — `agentlenspro disk-monitor install|uninstall|status`: the minute job (TRDD-HTARKH87).
//
// Its OWN launchd agent, not a thread of the collector: the monitor must keep recording while the
// collector is stopped, crashed or DISABLED — that is when a disk quietly fills. StartInterval 60 runs
// `disk-sample --quiet` once a minute; there is no KeepAlive, so nothing restarts a failing sampler in a
// tight loop, the next minute simply tries again.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { dataDir } from "../dataDir"
import { EXIT, UsageError } from "./cliErrors"
import { openReadOnly } from "./diskStore"
import { cliJsPath } from "./serverControl"

export const DISK_LABEL = "com.agentlens.disk-sample"

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function diskLogPath(dir: string = dataDir()): string {
  return path.join(dir, "logs", "disk-sample.log")
}

export function diskPlist(p: { node: string; cli: string; dataDir: string }): string {
  const log = xml(diskLogPath(p.dataDir))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DISK_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>${xml(p.cli)}</string>
    <string>disk-sample</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
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

function plistPath(launchAgentsDir?: string): string {
  return path.join(launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents"), `${DISK_LABEL}.plist`)
}

const domain = (): string => `gui/${process.getuid?.() ?? 0}`

function launchctl(args: string[]): string {
  return execFileSync("launchctl", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
}

/** Write the plist and (unless `load: false`) bootstrap it. `launchAgentsDir` + `load: false` make it testable without touching the real system. */
export function diskMonitorInstall(opts: { launchAgentsDir?: string; load?: boolean } = {}): { path: string; loaded: boolean } {
  if (process.platform !== "darwin") throw new Error("disk-monitor install: launchd is macOS-only — nothing was installed")
  const file = plistPath(opts.launchAgentsDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(path.dirname(diskLogPath()), { recursive: true })
  // temp + rename: an interrupted write must not leave a truncated plist for launchd to refuse silently.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, diskPlist({ node: process.execPath, cli: cliJsPath(), dataDir: dataDir() }))
  fs.renameSync(tmp, file)
  let loaded = false
  if (opts.load !== false) {
    try { launchctl(["bootout", `${domain()}/${DISK_LABEL}`]) } catch { /* not loaded yet */ }
    launchctl(["bootstrap", domain(), file])
    loaded = true
  }
  console.log(`disk-monitor install: ${file} (${opts.load === false ? "written, not loaded" : "loaded"}); samples every 60 s into ${path.join(dataDir(), "disk.duckdb")}`)
  return { path: file, loaded }
}

export function diskMonitorUninstall(opts: { launchAgentsDir?: string; load?: boolean } = {}): { path: string; removed: boolean } {
  const file = plistPath(opts.launchAgentsDir)
  if (process.platform === "darwin" && opts.load !== false) {
    try { launchctl(["bootout", `${domain()}/${DISK_LABEL}`]) } catch { /* not loaded */ }
  }
  let removed = false
  try { fs.unlinkSync(file); removed = true } catch { /* already gone */ }
  console.log(`disk-monitor uninstall: ${removed ? `removed ${file}` : "nothing to remove"} (the recorded history in disk.duckdb is kept)`)
  return { path: file, removed }
}

async function status(): Promise<number> {
  const file = plistPath()
  let loaded = false
  let lastExit = "unknown"
  try {
    const out = launchctl(["print", `${domain()}/${DISK_LABEL}`])
    loaded = true
    lastExit = /last exit code = (\S+)/.exec(out)?.[1] ?? "never ran"
  } catch { /* not loaded */ }
  console.log(`plist:     ${fs.existsSync(file) ? file : "not installed"}`)
  console.log(`launchd:   ${loaded ? `loaded (last exit code: ${lastExit})` : "not loaded"}`)
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
  return loaded && fs.existsSync(file) ? EXIT.OK : EXIT.UNKNOWN
}

export const DISK_MONITOR_USAGE = `usage: agentlenspro disk-monitor install | uninstall | status
  install    write ~/Library/LaunchAgents/${DISK_LABEL}.plist and load it: runs "disk-sample" every 60 s, even with no
             Claude session and even while agentlenspro is DISABLED (macOS only)
  uninstall  unload and delete the plist; the recorded history is kept
  status     plist, launchd state, and the time of the newest recorded row (exit 0 = installed and loaded)`

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
