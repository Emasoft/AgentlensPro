// src/cli/serverControl.ts — `agentlenspro server start|stop|restart|status [--supervise]`
// and `agentlenspro dashboard` (TRDD-7284WCW7). Absorbs scripts/agentlens-up.sh,
// scripts/agentlens-supervise.js and the --start-server/--stop-server/--status/--dashboard
// flag paths of the old agentlens-cli.js into the single executable.

import { spawn, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { apiRequest, dataDir, dashboardUrl, fmtGb, fmtMb, init, mcpEndpoint, sleep } from './cliCore'
import { agentlensDisabled, killSwitchPath } from './killSwitch'

/** Count of hook events durably spooled to disk but not yet reingested (server was down / shedding).
 *  Zero in the healthy case; a non-zero, non-shrinking value means the daemon isn't draining. */
export function hookSpoolDepth(): number {
  try { return fs.readdirSync(path.join(dataDir(), 'hook-spool')).filter((n) => n.endsWith('.json')).length } catch { return 0 }
}

/** Locate the standalone/server.js bundle. The CLI bundle lives NEXT TO it
 *  (<pkg>/standalone/cli.js), the test build three levels under out/test/, so a single
 *  fixed relative path would be wrong in one layout — walk the candidates. */
export function findServerJs(): string {
  const candidates = [
    path.join(__dirname, 'server.js'),                                  // bundled: standalone/
    path.resolve(__dirname, '..', 'standalone', 'server.js'),           // src/cli/ compiled in-place
    path.resolve(__dirname, '..', '..', 'standalone', 'server.js'),     // out/cli/
    path.resolve(__dirname, '..', '..', '..', 'standalone', 'server.js'), // out/test/cli/
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`server bundle missing (looked near ${__dirname}) — run \`node esbuild.js\` in the AgentlensPro repo first`)
}

function serverLogPath(): string { return path.join(dataDir(), 'server.log') }

/** Start the standalone server if the MCP endpoint is unreachable; wait until it answers.
 *
 *  Honors the GLOBAL kill-switch. This is the LAST hole through which a disabled AgentlensPro could
 *  resurrect itself, and it was a wide one: every diagnostics tool call goes through here, and the
 *  project CLAUDE.md tells every Claude session to run diagnostics BEFORE any task — so a disabled
 *  install came straight back the next time any of the ~16 running sessions started work (observed
 *  2026-07-14: the server was stopped at 15:07 and was found alive again at 17:43). The hook path was
 *  already gated; the CLI path was not. A kill-switch with a bypass is not a kill-switch. */
export async function ensureServer(): Promise<void> {
  // FIRST — before we even probe the network. A disabled AgentlensPro must cost nothing: no socket,
  // no retry timeout, and above all no spawn.
  if (agentlensDisabled()) {
    throw new Error(
      `AgentlensPro is DISABLED (${killSwitchPath()}) — refusing to start the server.\n` +
      'Re-enable with:  agentlenspro enable',
    )
  }
  try { await init(); return } catch { /* not up — start it */ }
  const serverJs = findServerJs()
  // stdout/stderr go to a log file, NOT /dev/null — when the server dies at boot (port
  // conflict, corrupt store) the reason must be readable, or every failure looks like
  // "did not become ready".
  let outFd: number | 'ignore'
  try { fs.mkdirSync(dataDir(), { recursive: true }); outFd = fs.openSync(serverLogPath(), 'a') } catch { outFd = 'ignore' }
  const child = spawn(process.execPath, ['--max-old-space-size=6144', serverJs], {
    cwd: path.dirname(path.dirname(serverJs)),
    detached: true,
    stdio: ['ignore', outFd, outFd],
  })
  child.unref()
  if (typeof outFd === 'number') fs.closeSync(outFd)
  for (let i = 0; i < 80; i++) { // up to 20s — DB open + first scan can be slow
    await sleep(250)
    try { await init(); console.log(`server started (pid ${child.pid}) — logs: ${serverLogPath()}`); return } catch { /* keep polling */ }
  }
  throw new Error(`server did not become ready within 20s — check ${serverLogPath()}`)
}

/** The server's PID, through a fallback chain that also covers builds predating
 *  /api/server-stats: stats endpoint → pidfile → lsof on the MCP port. Null when nothing runs. */
export async function findServerPid(): Promise<number | null> {
  try { return Number((await apiRequest('GET', '/api/server-stats')).pid) } catch { /* older build or down */ }
  // Is anything answering MCP at all? If not, the server is genuinely down.
  try { await init() } catch { return null }
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir(), 'server.pid'), 'utf-8').trim())
    if (pid > 0) { process.kill(pid, 0); return pid }
  } catch { /* no/stale pidfile (pre-pidfile build) — fall through to lsof */ }
  const port = new URL(mcpEndpoint()).port
  for (const lsof of ['lsof', '/usr/sbin/lsof']) { // /usr/sbin is often absent from a child PATH
    try {
      const out = execFileSync(lsof, ['-ti', `:${port}`], { encoding: 'utf8' })
      const pid = Number(out.split('\n').find(Boolean))
      if (pid > 0) return pid
    } catch { /* try the next candidate */ }
  }
  return null
}

export async function stopServer(): Promise<void> {
  const pid = await findServerPid()
  if (pid === null) {
    console.log('server already stopped')
    return
  }
  process.kill(pid, 'SIGTERM') // graceful — the server flushes every store on SIGTERM
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try { await init() } catch { console.log(`server stopped (pid ${pid})`); return }
  }
  throw new Error(`server (pid ${pid}) did not stop within 10s — inspect it before escalating to SIGKILL`)
}

interface ServerStats {
  pid: number
  uptimeSec: number
  canonical: boolean
  ports: { ui: number; mcp: number; otlp: number }
  memory: { rssMb: number; heapUsedMb: number; heapLimitMb: number }
  spans: {
    inMemory: number; pendingAppends: number; retentionDays?: number; windowMs?: number
    cap?: number; fileLines?: number; fileBytes?: number
    store?: { totalBytes: number; totalSpans: number; segments: number }
  }
  logSessions: number
  persistence: {
    totalBytesWritten: number; spanAppendBytes: number; spanAppendWrites: number
    spanCompactions?: number; spanCompactBytes?: number
    offsetsBytes: number; offsetsWrites: number; cardsBytes: number; cardsWrites: number
    files: { spans: number; cards: number; offsets: number }
  }
  bodies: {
    archive: { volumes: number; entries: number; bytes: number }
    lastPass: { removedFiles: number; keptBytes: number }
  }
  hookEvents?: { receivedSinceBoot: number; files: number; bytes: number }
  gate?: { mode: string; checks: number; denies: number; warns: number; advisories: number }
  dataDir: string
}

export async function showStatus(): Promise<void> {
  let s: ServerStats
  try { s = await apiRequest('GET', '/api/server-stats') as unknown as ServerStats } catch (e) {
    // A response (however wrong) means SOMETHING is serving the port — an older build without
    // the stats endpoint, or a foreign process. Only a connection failure means "not running".
    if (!String((e as Error).message).includes('unreachable')) {
      const pid = await findServerPid()
      console.log(`server: RUNNING but does not serve /api/server-stats (older build?)${pid ? ` pid=${pid}` : ''} — restart it: agentlenspro server restart`)
      return
    }
    console.log(`server: NOT RUNNING (${(e as Error).message})`)
    // The pidfile may still name a live process bound to different ports, or be stale.
    try {
      const pid = Number(fs.readFileSync(path.join(dataDir(), 'server.pid'), 'utf-8').trim())
      try { process.kill(pid, 0); console.log(`pidfile: ${pid} (process alive — a server may be up on non-default ports)`) }
      catch { console.log(`pidfile: ${pid} (stale — process gone)`) }
    } catch { /* no pidfile */ }
    return
  }
  const up = s.uptimeSec
  const uptime = up >= 3600 ? `${Math.floor(up / 3600)}h${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m${up % 60}s`
  const per = s.persistence
  console.log([
    `server: RUNNING pid=${s.pid} uptime=${uptime} canonical=${s.canonical} (ui:${s.ports.ui} mcp:${s.ports.mcp} otlp:${s.ports.otlp})`,
    `memory: rss=${s.memory.rssMb}MB heap=${s.memory.heapUsedMb}/${s.memory.heapLimitMb}MB`,
    // Segmented store (P4) exposes spans.store/windowMs; a pre-P4 server exposes cap/fileLines/
    // fileBytes instead — render whichever shape arrived, don't crash on the other.
    s.spans.store
      ? `spans:  ${s.spans.inMemory} in memory (${Math.round((s.spans.windowMs ?? 0) / 60000)}m window), ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.store.totalBytes)} (${s.spans.store.totalSpans} spans / ${s.spans.store.segments} segment(s), retention ${s.spans.retentionDays}d) | log sessions: ${s.logSessions}`
      : `spans:  ${s.spans.inMemory}/${s.spans.cap} in memory, ${s.spans.pendingAppends} pending, store ${fmtMb(s.spans.fileBytes ?? 0)} (${s.spans.fileLines} lines) | log sessions: ${s.logSessions}`,
    `disk writes since boot: ${fmtMb(per.totalBytesWritten)} total — spans ${fmtMb(per.spanAppendBytes)} in ${per.spanAppendWrites} appends${per.spanCompactions !== undefined ? ` + ${per.spanCompactions} compaction(s) ${fmtMb(per.spanCompactBytes ?? 0)}` : ''}; offsets ${fmtMb(per.offsetsBytes)}×${per.offsetsWrites}; cards ${fmtMb(per.cardsBytes)}×${per.cardsWrites}`,
    `bodies: archive ${s.bodies.archive.volumes} volume(s), ${s.bodies.archive.entries} lumps, ${fmtGb(s.bodies.archive.bytes)}; last pass archived ${s.bodies.lastPass.removedFiles} (live kept ${fmtGb(s.bodies.lastPass.keptBytes)})`,
    // hookEvents/gate are absent when --status hits a server built before TRDD-Q6ZOUVK5/GOD0108C — skip, don't crash.
    ...(s.hookEvents ? [`hooks:  ${s.hookEvents.receivedSinceBoot} event(s) since boot, ${s.hookEvents.files} bucket(s) ${fmtMb(s.hookEvents.bytes)} on disk`] : []),
    ...(s.gate ? [`gate:   mode=${s.gate.mode} — ${s.gate.checks} check(s), ${s.gate.denies} deny, ${s.gate.warns} warn, ${s.gate.advisories} advisories since boot`] : []),
    `data:   ${s.dataDir} (spans ${fmtMb(per.files.spans)}, cards ${fmtMb(per.files.cards)}, offsets ${fmtMb(per.files.offsets)})`,
  ].join('\n'))
}

export function openDashboard(): void {
  if (process.platform === 'darwin') {
    spawn('open', [dashboardUrl()], { detached: true, stdio: 'ignore' }).unref()
    console.log(`dashboard -> ${dashboardUrl()}`)
  } else {
    console.log(`open ${dashboardUrl()} in your browser`)
  }
}

// ── Supervisor (absorbed from scripts/agentlens-supervise.js, TRDD-PJC8N1HO spec 1) ─────────
// Keeps the collector alive: on any non-clean exit (a V8 OOM abort exits 134, a signal kill,
// etc.) it restarts the collector with EXPONENTIAL BACKOFF and appends the crash reason to
// DATA_DIR/crash.log. Before this existed the collector died silently and every OTEL export
// in the dead window was lost. Runs in the FOREGROUND so a process manager (launchd via
// scripts/agentlens.plist.template, or a terminal) supervises the supervisor.

const HEALTHY_MS = 60_000       // a child that ran this long is "healthy" → reset backoff on its exit
const STDERR_TAIL_BYTES = 8 * 1024

export function runSupervise(): void {
  // The supervisor is the one path that would out-stubborn the kill-switch: it exists to restart the
  // server forever, so if it ignored the flag, `agentlenspro disable` would stop a server that
  // launchd immediately brought back. Refuse to supervise a disabled install (exit non-zero so a
  // supervising launchd surfaces it rather than silently respawning us in a loop).
  if (agentlensDisabled()) {
    throw new Error(
      `AgentlensPro is DISABLED (${killSwitchPath()}) — refusing to supervise.\n` +
      'Re-enable with:  agentlenspro enable',
    )
  }
  const serverJs = findServerJs()
  const crashLog = path.join(dataDir(), 'crash.log')
  const maxOldSpace = String(Number(process.env.AGENTLENS_MAX_OLD_SPACE_MB) || 6144)
  const maxBackoffMs = Number(process.env.AGENTLENS_SUPERVISE_MAX_BACKOFF_MS) || 30_000

  try { fs.mkdirSync(dataDir(), { recursive: true }) } catch { /* best effort */ }

  let backoffMs = 1000
  let shuttingDown = false
  let child: ReturnType<typeof spawn> | null = null

  const logCrash = (reason: string): void => {
    const line = `[${new Date().toISOString()}] ${reason}\n`
    try { fs.appendFileSync(crashLog, line) } catch { /* best effort */ }
    process.stderr.write(`[supervisor] ${line}`)
  }

  const start = (): void => {
    const started = Date.now()
    // Inherit env so isolated-port / no-telemetry overrides pass through. stdout inherits
    // (logs flow to the launchd/terminal sink); stderr is teed so we keep its tail for the
    // crash record.
    child = spawn(process.execPath, [`--max-old-space-size=${maxOldSpace}`, serverJs],
      { cwd: path.dirname(path.dirname(serverJs)), env: process.env, stdio: ['ignore', 'inherit', 'pipe'] })

    let stderrTail = Buffer.alloc(0)
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)                                   // keep live stderr visible
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES)  // retain only the tail
    })

    child.on('exit', (code, signal) => {
      const uptimeS = ((Date.now() - started) / 1000).toFixed(1)
      if (shuttingDown) return  // deliberate stop — don't restart
      const tail = stderrTail.toString('utf8').trim().split('\n').slice(-12).join(' | ')
      logCrash(`collector exited code=${code} signal=${signal} uptime=${uptimeS}s — restarting in ${backoffMs}ms. stderr-tail: ${tail || '(none)'}`)
      // A child that ran healthily before dying gets a fresh backoff; a crash-loop backs off geometrically.
      if (Date.now() - started > HEALTHY_MS) backoffMs = 1000
      setTimeout(start, backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    })

    child.on('error', (err) => {
      logCrash(`failed to spawn collector: ${err.message} — retrying in ${backoffMs}ms`)
      setTimeout(start, backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    })
  }

  const shutdown = (sig: string): void => {
    shuttingDown = true
    process.stderr.write(`[supervisor] received ${sig} — stopping collector\n`)
    if (child) { try { child.kill('SIGTERM') } catch { /* ignore */ } }
    // Give the collector a moment to flush (atomic spans/offset save on SIGTERM), then exit.
    setTimeout(() => process.exit(0), 2000)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  process.stderr.write(`[supervisor] starting AgentlensPro collector (max-old-space=${maxOldSpace}MB, crash log ${crashLog})\n`)
  start()
}

/** Is anything answering the MCP endpoint right now? (the supervise refusal probe) */
async function mcpServed(): Promise<boolean> {
  try { await init(); return true } catch { return false }
}

/** Dispatcher for `agentlenspro server <start|stop|restart|status> [--supervise]`. */
export async function serverCommand(argv: string[]): Promise<void> {
  const verb = argv[0]
  const supervise = argv.includes('--supervise')
  switch (verb) {
    case 'start':
      if (supervise) {
        // Refuse a second collector: both would bind the same ports and the second EADDRINUSEs.
        if (await mcpServed()) {
          console.log(`server: MCP endpoint ${mcpEndpoint()} already served — refusing to start a second collector.`)
          return
        }
        runSupervise() // foreground; never returns until signalled
        return
      }
      await ensureServer()
      return
    case 'stop':
      await stopServer()
      return
    case 'restart':
      await stopServer()
      await ensureServer()
      return
    case 'status':
      await showStatus()
      return
    default:
      throw new Error(`server expects start|stop|restart|status (got "${verb ?? ''}") — e.g. agentlenspro server start [--supervise]`)
  }
}

// ── Daemon (D3K7QM2P/1b) — the always-on ingestion role ─────────────────────────────────────────
// In the hook-revive architecture the ingestion daemon IS the standalone server (it owns OTLP :4318
// + the JSONL scan + the hook-spool drain); `daemon` is the CLI surface that names that role for the
// user and reports the ingestion-specific health (the hook-spool depth). start/stop/restart share the
// server lifecycle verbatim (one process, one pidfile guard); `daemon start --supervise` is what
// launchd runs for true always-on (1d). This is a thin alias by design — a second lifecycle would be
// a second source of truth for "is ingestion up".
export async function daemonCommand(argv: string[]): Promise<void> {
  const verb = argv[0] ?? 'status'
  if (verb === 'status') {
    await showStatus()
    const spooled = hookSpoolDepth()
    console.log(`ingestion: always-on daemon = the standalone server (OTLP :4318 + JSONL scan + hook-spool drain).`)
    console.log(`hook-spool: ${spooled} event(s) awaiting drain${spooled > 0 ? ' — undelivered hooks are safe on disk and reingested on the next drain tick' : ''}`)
    return
  }
  if (verb === 'install') { daemonInstall({ load: !argv.includes('--no-load') }); return }
  if (verb === 'uninstall') { daemonUninstall(); return }
  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    // The daemon and the server are one process — reuse the exact lifecycle (incl. --supervise).
    await serverCommand(argv)
    return
  }
  throw new Error(`daemon expects start|stop|restart|status|install|uninstall (got "${verb}") — e.g. agentlenspro daemon start --supervise`)
}

// ── Always-on supervision via launchd (D3K7QM2P/1d) ─────────────────────────────────────────────
// The hook-revive (1a) already keeps the daemon up whenever a Claude instance is active. `daemon
// install` goes further: a per-user launchd agent runs `daemon start --supervise` at login and
// KeepAlive-restarts the supervisor, so ingestion is up 24/7 even with zero Claude instances and
// across reboots. Opt-in (never forced by `setup`) because a standing background daemon is the
// user's choice. macOS only for now; linux gets a printed systemd-user recipe.
const LAUNCHD_LABEL = 'com.agentlens.collector'
// Embedded (not read from scripts/) so an npm-installed package can self-install without shipping the
// template file. @NODE@/@CLI@/@REPO@/@USER@ are filled at install time.
const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>@NODE@</string>
    <string>@CLI@</string>
    <string>daemon</string>
    <string>start</string>
    <string>--supervise</string>
  </array>
  <key>WorkingDirectory</key>
  <string>@REPO@</string>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>@HOME@/.agentlens/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>@HOME@/.agentlens/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTLENS_MAX_OLD_SPACE_MB</key>
    <string>6144</string>
  </dict>
</dict>
</plist>
`

function launchAgentsPath(overrideDir?: string): string {
  return path.join(overrideDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents'), `${LAUNCHD_LABEL}.plist`)
}

/** Install (or refresh) the launchd agent. Returns the plist path. `load:false` and a
 *  `launchAgentsDir` override make it testable without touching the real system. */
export function daemonInstall(opts: { launchAgentsDir?: string; load?: boolean } = {}): { path: string; installed: boolean } {
  if (process.platform !== 'darwin') {
    console.log('daemon install: launchd is macOS-only. On linux, run a systemd USER service:')
    console.log(`  ~/.config/systemd/user/agentlens.service → ExecStart=${process.execPath} ${cliJsPath()} daemon start --supervise`)
    console.log('  then: systemctl --user enable --now agentlens.service')
    return { path: '', installed: false }
  }
  const cli = cliJsPath()
  const plistPath = launchAgentsPath(opts.launchAgentsDir)
  const filled = LAUNCHD_PLIST
    .replace(/@NODE@/g, process.execPath)
    .replace(/@CLI@/g, cli)
    .replace(/@REPO@/g, path.dirname(path.dirname(cli)))
    .replace(/@HOME@/g, os.homedir())
  fs.mkdirSync(path.dirname(plistPath), { recursive: true })
  fs.writeFileSync(plistPath, filled)
  if (opts.load !== false) {
    // `load -w` (re)loads and marks it enabled; a re-install first unloads so the new plist takes.
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch { /* not loaded yet */ }
    try { execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'ignore' }) } catch (e) { console.warn(`launchctl load failed: ${String(e)} — the plist is written; load it manually.`) }
  }
  console.log(`daemon install: launchd agent → ${plistPath} (${opts.load !== false ? 'loaded' : 'written, not loaded'})`)
  return { path: plistPath, installed: true }
}

/** Remove the launchd agent (unload + delete the plist). Idempotent. */
export function daemonUninstall(opts: { launchAgentsDir?: string } = {}): { path: string; removed: boolean } {
  const plistPath = launchAgentsPath(opts.launchAgentsDir)
  if (process.platform === 'darwin') { try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch { /* not loaded */ } }
  let removed = false
  try { fs.unlinkSync(plistPath); removed = true } catch { /* already gone */ }
  console.log(`daemon uninstall: ${removed ? `removed ${plistPath}` : 'nothing to remove'}`)
  return { path: plistPath, removed }
}

/** The bundled CLI entry (standalone/cli.js) — sibling of the server bundle. */
function cliJsPath(): string {
  return path.join(path.dirname(findServerJs()), 'cli.js')
}
