// src/cli/portSelect.ts — owner rule 2026-10-02: "always check if another process is using a port
// and switch to a different port". alcore binds 127.0.0.1 by default (bin/alcore.rs `--bind`), so
// the probe binds the same address: a listener on another interface cannot conflict with ours.

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'

export interface ChosenPorts { otlp: number; ui: number; mcp: number; chosenAt: string }

const SCAN_SPAN = 50

/** True when nothing listens on host:port — a real bind-then-close, not a guess from lsof. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

/** preferred if free; preferred if held by OUR server (isOurs); else the first free port in
 *  preferred+1..+50. Throws when the whole span is taken — fail fast, never bind blindly. */
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

export function portsFilePath(dir: string): string { return path.join(dir, 'ports.json') }

/** Atomic (tmp + rename) so a client never reads a half-written file. */
export function writePortsFile(dir: string, ports: Omit<ChosenPorts, 'chosenAt'>): void {
  const file = portsFilePath(dir)
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ ...ports, chosenAt: new Date().toISOString() }))
  fs.renameSync(tmp, file)
}

/** One persisted port, or undefined when the file is absent/unreadable/invalid (clients then use
 *  the default — a missing file is the normal first-run state, not an error). */
export function readChosenPort(dir: string, key: 'otlp' | 'ui' | 'mcp'): number | undefined {
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

/** Decide the three listener ports for `alcore serve` (owner rule 2026-10-02: check whether another
 *  process holds a port and switch). `ours` says whether a held port belongs to OUR server.
 *  OTLP is NEVER switched: Claude Code's exporters target a fixed endpoint, so moving the listener
 *  would send telemetry to the squatter or nowhere — data loss — hence a loud refusal instead.
 *  UI and MCP switch to the next free port, are persisted to ports.json (clients read it), and
 *  never collide with each other or with OTLP (all three are probed before any of them is bound). */
export async function chooseServerPorts(preferred: { otlp: number; ui: number; mcp: number }, dir: string, ours: () => Promise<boolean>): Promise<{ otlp: number; ui: number; mcp: number }> {
  if (!(await isPortFree(preferred.otlp)) && !(await ours())) {
    throw new Error(
      `OTLP port ${preferred.otlp} is in use by ${portHolder(preferred.otlp)} — refusing to start: telemetry exporters target it, so moving the listener would lose data.\n` +
      `Free the port, or set OTLP_PORT=<other> and re-run \`agentlenspro --install-otel\`, then restart Claude Code.`,
    )
  }
  const exclude = new Set<number>([preferred.otlp])
  const chosen = { otlp: preferred.otlp, ui: 0, mcp: 0 }
  for (const key of ['ui', 'mcp'] as const) {
    const { port, switched } = await pickPort(preferred[key], ours, exclude)
    exclude.add(port)
    if (switched) console.log(`port ${preferred[key]} is in use by another process — using ${port}`)
    chosen[key] = port
  }
  writePortsFile(dir, chosen)
  return chosen
}
