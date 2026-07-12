// src/environment/mcp.ts — configured MCP servers, user + project scope (TRDD-HUWJVQJA). Reads the two
// config files Claude Code itself reads (~/.claude.json for user-scoped servers, ./.mcp.json for
// project-scoped ones) and classifies each entry's transport. All reads are fail-soft — a missing or
// unparsable config file is silently skipped, never thrown.

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { EnvFacet } from './types'

export interface McpServerInfo {
  name: string
  type: string
  scope: string
}

/** Classify one raw server-config entry. Pure — never throws on malformed input. */
function classifyEntry(entry: Record<string, unknown>): string {
  if (typeof entry.type === 'string') return entry.type
  if ('command' in entry) return 'stdio'
  if ('url' in entry) {
    return typeof entry.url === 'string' && entry.url.startsWith('http') ? 'http' : 'sse'
  }
  return 'unknown'
}

/** Extract the `mcpServers` map out of a parsed config object. Pure — never throws; returns [] for
 *  anything that isn't a `{ mcpServers: { name: {...} } }` shape. */
export function parseMcpServers(json: unknown, scope: string): McpServerInfo[] {
  if (typeof json !== 'object' || json === null) return []
  const servers = (json as Record<string, unknown>).mcpServers
  if (typeof servers !== 'object' || servers === null) return []
  const out: McpServerInfo[] = []
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    out.push({ name, type: classifyEntry(entry as Record<string, unknown>), scope })
  }
  return out
}

interface McpFacetValue {
  servers: McpServerInfo[]
  sources: string[]
}

async function gather(): Promise<McpFacetValue> {
  const targets = [
    { file: path.join(os.homedir(), '.claude.json'), scope: 'user' },
    { file: path.join(process.cwd(), '.mcp.json'), scope: 'project' },
  ]
  const servers: McpServerInfo[] = []
  const sources: string[] = []
  for (const t of targets) {
    try {
      const json: unknown = JSON.parse(fs.readFileSync(t.file, 'utf-8'))
      sources.push(t.file)
      servers.push(...parseMcpServers(json, t.scope))
    } catch {
      // missing file / unreadable / unparsable JSON — fail-soft, skip this source
    }
  }
  const seen = new Set<string>()
  const deduped: McpServerInfo[] = []
  for (const s of servers) {
    const key = `${s.name}::${s.scope}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(s)
  }
  return { servers: deduped, sources }
}

function render(value: unknown): string {
  const v = value as McpFacetValue
  if (v.servers.length === 0) return 'mcp servers:   none configured'
  const lines = [`mcp servers:   ${v.servers.length}`]
  for (const s of v.servers) lines.push(`  ${s.name} (${s.type}, ${s.scope})`)
  return lines.join('\n')
}

export const mcpFacet: EnvFacet = {
  name: 'mcp',
  aliases: ['mcp-servers'],
  summary: 'Configured MCP servers from user (~/.claude.json) and project (.mcp.json) config',
  gather,
  render,
}
