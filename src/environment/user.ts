// src/environment/user.ts — user/account identity: username, uid/gid, shell, home, group
// membership, sudo-capability (TRDD-HUWJVQJA). os.userInfo() gives the portable primitives;
// `id -Gn` (POSIX only) supplies the group list used to infer sudo-capability. We never invoke
// `sudo` itself — it can prompt interactively or write to the system log. All reads are fail-soft.

import * as os from 'os'
import { run } from './exec'
import type { EnvFacet } from './types'

const SUDO_GROUPS = new Set(['sudo', 'wheel', 'admin', 'root'])

/** True iff any of the given group names is a known sudo-capable group (case-insensitive). Pure. */
export function sudoCapableFromGroups(groups: string[]): boolean {
  return groups.some((g) => SUDO_GROUPS.has(g.toLowerCase()))
}

interface UserFacet {
  username: string
  uid: number
  gid: number
  shell: string | null
  homedir: string
  isRoot: boolean
  groups: string[]
  sudoCapable: boolean
  envUser: string | null
  sudoUser: string | null
}

/** os.userInfo() can throw (SystemError) when the platform has no matching passwd/registry entry
 *  — rare, but seen in minimal containers. Fall back to env vars so the facet never rejects. */
function safeUserInfo(): { username: string; uid: number; gid: number; shell: string | null; homedir: string } {
  try {
    const info = os.userInfo()
    return { username: info.username, uid: info.uid, gid: info.gid, shell: info.shell, homedir: info.homedir }
  } catch {
    return {
      username: process.env.USER || process.env.LOGNAME || process.env.USERNAME || 'unknown',
      uid: -1,
      gid: -1,
      shell: process.env.SHELL || null,
      homedir: process.env.HOME || process.env.USERPROFILE || '',
    }
  }
}

async function gather(): Promise<UserFacet> {
  const info = safeUserInfo()
  let groups: string[] = []
  const r = await run('id', ['-Gn'])
  if (r.ok) groups = r.stdout.trim().split(/\s+/).filter(Boolean)
  return {
    username: info.username,
    uid: info.uid,
    gid: info.gid,
    shell: info.shell,
    homedir: info.homedir,
    isRoot: info.uid === 0,
    groups,
    sudoCapable: sudoCapableFromGroups(groups),
    envUser: process.env.USER || process.env.LOGNAME || process.env.USERNAME || null,
    sudoUser: process.env.SUDO_USER || null,
  }
}

function render(value: unknown): string {
  const v = value as UserFacet
  return [
    `user:          ${v.username}   (uid ${v.uid}, gid ${v.gid})${v.isRoot ? '  [root]' : ''}`,
    `shell:         ${v.shell ?? 'unknown'}`,
    `home:          ${v.homedir}`,
    `groups:        ${v.groups.length ? v.groups.join(', ') : 'unknown'}`,
    `sudo-capable:  ${v.sudoCapable}${v.sudoUser ? `   (via SUDO_USER=${v.sudoUser})` : ''}`,
  ].join('\n')
}

export const userFacet: EnvFacet = {
  name: 'user',
  aliases: ['account', 'whoami'],
  summary: 'Username, uid/gid, shell, home, group membership, sudo-capability',
  gather,
  render,
}
