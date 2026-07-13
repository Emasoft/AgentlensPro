// src/environment/claude.ts — Claude Code config/permissions detector (TRDD-HUWJVQJA pattern).
// Reads ~/.claude/settings.json, the plugin cache, and CLAUDE.md presence to summarize how this
// machine's Claude Code is configured. Never reads or prints secrets — only counts/modes/names.
// All reads are fail-soft: a missing/unreadable/malformed settings.json degrades to zeros, never throws.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { toolVersion } from './exec'
import type { EnvFacet } from './types'

export interface PermissionSummary {
  defaultMode: string | null
  allow: number
  deny: number
  ask: number
}

/** Pure classifier: extract permission-mode + rule counts from a parsed settings.json shape.
 *  Never throws — any missing/malformed field degrades to its zero/null default. */
export function permissionSummary(settings: unknown): PermissionSummary {
  const zero: PermissionSummary = { defaultMode: null, allow: 0, deny: 0, ask: 0 }
  if (!settings || typeof settings !== 'object') return zero
  const perms = (settings as { permissions?: unknown }).permissions
  if (!perms || typeof perms !== 'object') return zero
  const p = perms as { defaultMode?: unknown; allow?: unknown; deny?: unknown; ask?: unknown }
  return {
    defaultMode: typeof p.defaultMode === 'string' ? p.defaultMode : null,
    allow: Array.isArray(p.allow) ? p.allow.length : 0,
    deny: Array.isArray(p.deny) ? p.deny.length : 0,
    ask: Array.isArray(p.ask) ? p.ask.length : 0,
  }
}

interface ClaudeFacetData {
  configDir: string
  settingsPresent: boolean
  permissions: PermissionSummary
  pluginsInstalled: number
  userClaudeMd: boolean
  projectClaudeMd: boolean
  sessionId: string | null
  cliVersion: string | null
}

async function gather(): Promise<ClaudeFacetData> {
  const configDir = path.join(os.homedir(), '.claude')
  const settingsPath = path.join(configDir, 'settings.json')
  const settingsPresent = fs.existsSync(settingsPath)

  let permissions = permissionSummary(null)
  if (settingsPresent) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      permissions = permissionSummary(parsed)
    } catch {
      // unreadable or malformed JSON — degrade to zeros rather than crash the report
      permissions = permissionSummary(null)
    }
  }

  let pluginsInstalled = 0
  try {
    pluginsInstalled = fs.readdirSync(path.join(configDir, 'plugins', 'cache')).length
  } catch {
    pluginsInstalled = 0 // no plugin cache dir on this machine — that's a valid, common state
  }

  const userClaudeMd = fs.existsSync(path.join(configDir, 'CLAUDE.md'))
  const projectClaudeMd = fs.existsSync(path.join(process.cwd(), 'CLAUDE.md'))
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null
  // toolVersion already returns null when the binary is not on PATH, so no separate which() guard.
  const cliVersion = await toolVersion('claude', ['--version'])

  return {
    configDir,
    settingsPresent,
    permissions,
    pluginsInstalled,
    userClaudeMd,
    projectClaudeMd,
    sessionId,
    cliVersion,
  }
}

function render(value: unknown): string {
  const v = value as ClaudeFacetData
  const p = v.permissions
  return [
    `config dir:    ${v.configDir}`,
    `settings.json: ${v.settingsPresent ? 'present' : 'absent'}`,
    `permissions:   mode ${p.defaultMode ?? 'unset'}   · allow ${p.allow} / deny ${p.deny} / ask ${p.ask}`,
    `plugin cache:  ${v.pluginsInstalled} entries`,
    `CLAUDE.md:     user ${v.userClaudeMd ? 'yes' : 'no'}   · project ${v.projectClaudeMd ? 'yes' : 'no'}`,
    `cli:           ${v.cliVersion ?? 'not found'}`,
  ].join('\n')
}

export const claudeFacet: EnvFacet = {
  name: 'claude',
  aliases: ['claude-code', 'permissions'],
  summary: 'Claude Code config dir, settings.json permissions, plugins, CLAUDE.md presence, CLI version',
  gather,
  render,
}
