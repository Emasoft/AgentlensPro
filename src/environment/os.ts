// src/environment/os.ts — OS, kernel, arch, CPU, memory (TRDD-HUWJVQJA). Node's `os` module gives the
// portable primitives; the human-friendly product name comes from `sw_vers` (macOS) or /etc/os-release
// (Linux, parsed with a pure helper) or `ver` (Windows). All subprocess reads are fail-soft.

import * as os from 'os'
import * as fs from 'fs'
import { run } from './exec'
import type { EnvFacet } from './types'

/** Parse an /etc/os-release file body into its key→value map (strips surrounding quotes). Pure. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

interface OsFacet {
  system: string
  platform: NodeJS.Platform
  release: string
  arch: string
  version: string
  hostname: string
  kernel: string
  uptimeHours: number
  cpuModel: string
  cpuCount: number
  totalMemGb: number
  freeMemGb: number
  loadAvg: number[]
  nodeVersion: string
}

async function productVersion(): Promise<string> {
  const platform = process.platform
  if (platform === 'darwin') {
    const prod = await run('sw_vers', ['-productVersion'], { timeoutMs: 3000 })
    const build = await run('sw_vers', ['-buildVersion'], { timeoutMs: 3000 })
    const p = prod.ok ? prod.stdout.trim() : ''
    const b = build.ok ? build.stdout.trim() : ''
    return p ? `macOS ${p}${b ? ` (build ${b})` : ''}` : `macOS (Darwin ${os.release()})`
  }
  if (platform === 'linux') {
    for (const p of ['/etc/os-release', '/usr/lib/os-release']) {
      try {
        const rel = parseOsRelease(fs.readFileSync(p, 'utf-8'))
        if (rel.PRETTY_NAME) return rel.PRETTY_NAME
        if (rel.NAME) return `${rel.NAME}${rel.VERSION ? ` ${rel.VERSION}` : ''}`
      } catch {
        // try the next path
      }
    }
    return `Linux ${os.release()}`
  }
  if (platform === 'win32') {
    const ver = await run('cmd', ['/c', 'ver'], { timeoutMs: 3000 })
    if (ver.ok && ver.stdout.trim()) return ver.stdout.trim()
    return `Windows ${os.release()}`
  }
  return `${os.type()} ${os.release()}`
}

async function gather(): Promise<OsFacet> {
  const cpus = os.cpus()
  const GB = 1024 ** 3
  return {
    system: os.type(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    version: await productVersion(),
    hostname: os.hostname(),
    kernel: os.version(),
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / GB) * 10) / 10,
    freeMemGb: Math.round((os.freemem() / GB) * 10) / 10,
    loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    nodeVersion: process.version,
  }
}

function render(value: unknown): string {
  const v = value as OsFacet
  return [
    `os:            ${v.version}`,
    `arch:          ${v.arch}   (${v.system} ${v.release})`,
    `host:          ${v.hostname}`,
    `cpu:           ${v.cpuCount}× ${v.cpuModel}`,
    `memory:        ${v.freeMemGb} GB free / ${v.totalMemGb} GB   · load ${v.loadAvg.join(' ')}`,
    `uptime:        ${v.uptimeHours} h   · node ${v.nodeVersion}`,
  ].join('\n')
}

export const osFacet: EnvFacet = {
  name: 'os',
  aliases: ['system'],
  summary: 'OS product/version, kernel, arch, CPU, memory, uptime',
  gather,
  render,
}
