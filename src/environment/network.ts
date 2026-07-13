// src/environment/network.ts — local network posture: interfaces, VPN, proxy, DNS, listening ports,
// default gateway (TRDD-HUWJVQJA). NO outbound network calls — every read is local (os.networkInterfaces,
// /etc/resolv.conf, env vars) or a local-only subprocess (lsof, netstat, `tailscale status`). All
// subprocess reads are fail-soft and time-boxed via exec.run so a stalled tool can never wedge the report.

import * as os from 'os'
import * as fs from 'fs'
import { run, which } from './exec'
import type { EnvFacet } from './types'

interface VpnIface {
  iface: string
  kind: string
}

const VPN_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /^tailscale/, kind: 'tailscale' },
  { re: /^utun\d/, kind: 'utun (possible VPN/WireGuard)' },
  { re: /^wg\d/, kind: 'wireguard' },
  { re: /^tun\d/, kind: 'tun' },
  { re: /^tap\d/, kind: 'tap' },
  { re: /^ppp\d/, kind: 'ppp' },
]

/** Classify VPN-ish interface names by prefix. Pure — order matters only in that the first matching
 *  pattern wins, but the patterns are mutually exclusive by construction. */
export function vpnFromInterfaces(names: string[]): VpnIface[] {
  const out: VpnIface[] = []
  for (const name of names) {
    const hit = VPN_PATTERNS.find((p) => p.re.test(name))
    if (hit) out.push({ iface: name, kind: hit.kind })
  }
  return out
}

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']

/** Collect whichever proxy env vars are set, upper or lowercase. Keyed by the UPPERCASE name; when
 *  both cases are set the uppercase value wins (env var precedence is otherwise tool-specific). Pure. */
export function proxyFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PROXY_VARS) {
    const val = env[name] ?? env[name.toLowerCase()]
    if (val) out[name] = val
  }
  return out
}

/** Extract nameserver IPs from an /etc/resolv.conf body. Pure. */
export function parseResolvConf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const m = t.match(/^nameserver\s+(\S+)/)
    if (m) out.push(m[1])
  }
  return out
}

interface ListeningPort {
  port: string
  proc: string
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into {proc, port} pairs, deduped by port+proc. The NAME
 *  column (e.g. `*:3000` or `127.0.0.1:4318`) is the token containing ':' that is not the trailing
 *  `(LISTEN)` state marker; the port is whatever follows the LAST ':' in that token. Pure. */
export function parseListeningPortsLsof(text: string): ListeningPort[] {
  const out: ListeningPort[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('COMMAND')) continue // header row
    const cols = t.split(/\s+/)
    if (cols.length < 2) continue
    const proc = cols[0]
    const nameCol = cols.find((c) => c.includes(':') && !c.startsWith('('))
    if (!nameCol) continue
    const port = nameCol.slice(nameCol.lastIndexOf(':') + 1)
    if (!/^\d+$/.test(port)) continue
    const key = `${port}:${proc}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port, proc })
  }
  return out
}

/** Find the default route's gateway from `netstat -rn`. Handles both the macOS/BSD style
 *  (`default <gw> <flags> <netif>`) and the Linux numeric style (`0.0.0.0 <gw> 0.0.0.0 UG ...`),
 *  since `-n` suppresses the `default` alias on Linux. Returns null when no default route is present. Pure. */
export function parseDefaultGateway(text: string): string | null {
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] === 'default' && cols[1]) return cols[1]
    // Linux: the default route is the 0.0.0.0 destination; its gateway is a real router IP, not 0.0.0.0.
    if (cols[0] === '0.0.0.0' && cols[1] && cols[1] !== '0.0.0.0') return cols[1]
  }
  return null
}

interface NetworkFacetValue {
  hostname: string
  interfaces: { name: string; family: string; address: string }[]
  vpn: VpnIface[]
  tailscaleRunning: boolean
  proxy: Record<string, string>
  dns: string[]
  listening: ListeningPort[]
  gateway: string | null
}

async function gather(): Promise<NetworkFacetValue> {
  const ifaces = os.networkInterfaces()
  const interfaces = Object.entries(ifaces).flatMap(([name, addrs]) =>
    (addrs ?? [])
      .filter((a) => !a.internal)
      .map((a) => ({ name, family: String(a.family), address: a.address })),
  )

  let tailscaleRunning = false
  try {
    if (which('tailscale')) {
      const r = await run('tailscale', ['status'], { timeoutMs: 3000 })
      tailscaleRunning = r.ok
    }
  } catch {
    tailscaleRunning = false
  }

  let dns: string[] = []
  try {
    if (process.platform !== 'win32') {
      dns = parseResolvConf(fs.readFileSync('/etc/resolv.conf', 'utf-8'))
    }
  } catch {
    dns = []
  }

  let listening: ListeningPort[] = []
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeoutMs: 3000 })
      listening = parseListeningPortsLsof(r.stdout)
    }
  } catch {
    listening = []
  }

  let gateway: string | null = null
  try {
    const r = await run('netstat', ['-rn'], { timeoutMs: 3000 })
    gateway = r.ok ? parseDefaultGateway(r.stdout) : null
  } catch {
    gateway = null
  }

  return {
    hostname: os.hostname(),
    interfaces,
    vpn: vpnFromInterfaces(Object.keys(ifaces)),
    tailscaleRunning,
    proxy: proxyFromEnv(process.env),
    dns,
    listening,
    gateway,
  }
}

function render(value: unknown): string {
  const v = value as NetworkFacetValue
  const vpnLine = v.vpn.length ? v.vpn.map((x) => `${x.iface} (${x.kind})`).join(', ') : 'none detected'
  const proxyKeys = Object.keys(v.proxy)
  const proxyLine = proxyKeys.length ? proxyKeys.map((k) => `${k}=${v.proxy[k]}`).join(' ') : 'none'
  const dnsLine = v.dns.length ? v.dns.join(', ') : 'none'
  const preview = v.listening
    .slice(0, 5)
    .map((l) => `${l.proc}:${l.port}`)
    .join(', ')
  const more = v.listening.length > 5 ? ', …' : ''
  return [
    `hostname:      ${v.hostname}`,
    `interfaces:    ${v.interfaces.length} active`,
    `vpn:           ${vpnLine}`,
    `tailscale:     ${v.tailscaleRunning ? 'running' : 'not running/absent'}`,
    `proxy:         ${proxyLine}`,
    `dns:           ${dnsLine}`,
    `gateway:       ${v.gateway ?? 'unknown'}`,
    `listening:     ${v.listening.length} ports${preview ? ` (${preview}${more})` : ''}`,
  ].join('\n')
}

export const networkFacet: EnvFacet = {
  name: 'network',
  aliases: ['net'],
  summary: 'Interfaces, VPN detection, proxy env vars, DNS, listening ports, default gateway',
  gather,
  render,
}
