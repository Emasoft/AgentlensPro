// src/cli/portSelect.ts — owner rule 2026-10-02: "always check if another process is using a port
// and switch to a different port". alcore binds 127.0.0.1 by default (bin/alcore.rs `--bind`).

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { lockTakeoverVerdict, parsePidLock, processStartRef } from '../serverRuntime'

const SCAN_SPAN = 50

/** One bind probe. A family the host does not have (no IPv6) cannot hold the port, so it is free. */
function probe(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

/** True when nothing listens on the port. Probes 127.0.0.1 (where alcore binds) AND ::1: client
 *  URLs say `localhost`, which Node may resolve to ::1 first, so a squatter on ::1 would receive
 *  the CLI's requests even though our own bind succeeds. */
export async function isPortFree(port: number): Promise<boolean> {
  return (await probe(port, '127.0.0.1')) && (await probe(port, '::1'))
}

/** preferred if free; preferred if held by OUR server (isOurs); else the first free port in
 *  preferred+1..+50, never one in `exclude`. Throws when the span is taken — fail fast. */
export async function pickPort(preferred: number, isOurs: () => Promise<boolean>, exclude: ReadonlySet<number> = new Set()): Promise<{ port: number; switched: boolean }> {
  if (!exclude.has(preferred)) {
    if (await isPortFree(preferred)) return { port: preferred, switched: false }
    if (await isOurs()) return { port: preferred, switched: false }
  }
  for (let p = preferred + 1; p <= preferred + SCAN_SPAN && p < 65536; p++) {
    if (!exclude.has(p) && await isPortFree(p)) return { port: p, switched: true }
  }
  throw new Error(`no free port in ${preferred + 1}..${preferred + SCAN_SPAN} (${preferred} is in use by another process)`)
}

/** Signal-0 liveness probe. EPERM would also mean alive, but every process here is same-user. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** The pid named by `<dir>/server.pid` when it is a LIVE owner, else null (TRDD-BSDR4TRM identity
 *  check, moved here from findServerPid so the CLI's URL helpers and findServerPid share ONE rule).
 *  parsePidLock reads both lock shapes; lockTakeoverVerdict is the server's own takeover rule, so
 *  a recycled pid (alive, different start reference) is NOT the server. */
export function liveLockPid(dir: string): number | null {
  try {
    const lock = parsePidLock(fs.readFileSync(path.join(dir, 'server.pid'), 'utf-8'))
    if (lock === null) return null
    const verdict = lockTakeoverVerdict({
      lockPid: lock.pid,
      lockStartRef: lock.start,
      pidAlive: processAlive(lock.pid),
      currentStartRef: lock.start === null ? null : processStartRef(lock.pid),
    })
    return verdict === 'live-owner' || verdict === 'legacy-kill0-only' ? lock.pid : null
  } catch { return null }
}

export function portsFilePath(dir: string): string { return path.join(dir, 'ports.json') }

/** Atomic (tmp + rename) so a client never reads a half-written file. */
export function writePortsFile(dir: string, ports: { otlp: number; ui: number; mcp: number }): void {
  const file = portsFilePath(dir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ ...ports, chosenAt: new Date().toISOString() }))
  fs.renameSync(tmp, file)
}

export function removePortsFile(dir: string): void { fs.rmSync(portsFilePath(dir), { force: true }) }

/** One persisted port — honoured ONLY while `<dir>/server.pid` names a live owner. Without that
 *  gate a ports.json left by a dead server would point every client at whatever process took the
 *  port since: the squatter problem this module exists to prevent. Undefined otherwise. */
export function readChosenPort(dir: string, key: 'otlp' | 'ui' | 'mcp'): number | undefined {
  if (liveLockPid(dir) === null) return undefined
  try {
    const n = (JSON.parse(fs.readFileSync(portsFilePath(dir), 'utf-8')) as Record<string, unknown>)[key]
    return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined
  } catch { return undefined }
}

/** Who listens on a TCP port, for an error message: `pid N (command)`, or 'an unknown process'. */
export function portHolder(port: number): string {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const pid = /^p(\d+)/m.exec(out)?.[1]
    const cmd = /^c(.+)/m.exec(out)?.[1]
    return pid ? `pid ${pid}${cmd ? ` (${cmd})` : ''}` : 'an unknown process'
  } catch { return 'an unknown process' }
}

/** Decide the three listener ports for `alcore serve` (owner rule 2026-10-02). `ours` says whether
 *  a held port belongs to OUR server.
 *  A PINNED port — OTLP always (Claude Code's exporters target a fixed endpoint), UI/MCP when
 *  UI_PORT/MCP_PORT is explicitly set — NEVER moves: held by a stranger means a loud refusal
 *  naming the holder, because moving it would send clients/telemetry to the squatter or nowhere.
 *  Unpinned UI/MCP switch to the next free port, never colliding with each other or OTLP. Nothing
 *  is persisted here: ports.json is written only after the start succeeded. */
export async function chooseServerPorts(
  preferred: { otlp: number; ui: number; mcp: number },
  pinned: { ui: boolean; mcp: boolean },
  ours: () => Promise<boolean>,
): Promise<{ otlp: number; ui: number; mcp: number }> {
  const refuse = async (what: string, port: number, remedy: string): Promise<void> => {
    if (!(await isPortFree(port)) && !(await ours())) {
      throw new Error(`${what} port ${port} is in use by ${portHolder(port)} — refusing to start: ${remedy}`)
    }
  }
  await refuse('OTLP', preferred.otlp,
    'telemetry exporters target it, so moving the listener would lose data.\n' +
    'Free the port, or set OTLP_PORT=<other> and re-run `agentlenspro --install-otel`, then restart Claude Code.')
  const exclude = new Set<number>([preferred.otlp])
  const chosen = { otlp: preferred.otlp, ui: 0, mcp: 0 }
  for (const key of ['ui', 'mcp'] as const) {
    const env = key === 'ui' ? 'UI_PORT' : 'MCP_PORT'
    if (pinned[key]) {
      await refuse(key === 'ui' ? 'UI' : 'MCP', preferred[key], `it is pinned by ${env}. Free the port, or change/unset ${env}.`)
      chosen[key] = preferred[key]
    } else {
      const { port, switched } = await pickPort(preferred[key], ours, exclude)
      if (switched) console.log(`port ${preferred[key]} is in use by another process — using ${port}`)
      chosen[key] = port
    }
    exclude.add(chosen[key])
  }
  return chosen
}
