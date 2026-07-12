// src/environment/filesystem.ts — cwd/home/project dir, filesystem type, git worktree, free disk
// space (TRDD-HUWJVQJA). `mount` (macOS) and `stat -f` (Linux) give the fstype; git plumbing gives
// worktree identity; fs.statfsSync gives free space. All subprocess/fs reads are fail-soft — a probe
// that fails resolves to a benign empty value, it never throws out of gather().

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { run } from './exec'
import type { EnvFacet } from './types'

/** True iff `prefix` is a path-segment prefix of `target` (not just a string prefix — '/Us' must
 *  not match '/Users'). The root '/' always matches. */
function isPathPrefix(prefix: string, target: string): boolean {
  if (prefix === '/') return true
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return target === p || target.startsWith(`${p}/`)
}

/** Parse macOS `mount` output and pick the fstype of the mountpoint that is the longest
 *  path-prefix of `targetPath`. Each line looks like `/dev/disk3s1s1 on / (apfs, sealed, ...)`.
 *  Pure — ported from ai-maestro-janitor detect_filesystem. Returns 'unknown' if no line matches. */
export function pickMountFsType(mountOutput: string, targetPath: string): string {
  let best: { mountpoint: string; fstype: string } | null = null
  for (const line of mountOutput.split('\n')) {
    const onIdx = line.indexOf(' on ')
    if (onIdx === -1) continue
    const parenIdx = line.indexOf(' (', onIdx)
    if (parenIdx === -1) continue
    const mountpoint = line.slice(onIdx + 4, parenIdx)
    if (!mountpoint) continue
    const closeIdx = line.indexOf(')', parenIdx)
    const inner = closeIdx === -1 ? line.slice(parenIdx + 2) : line.slice(parenIdx + 2, closeIdx)
    const fstype = inner.split(',')[0]?.trim() ?? ''
    if (!fstype) continue
    if (!isPathPrefix(mountpoint, targetPath)) continue
    if (!best || mountpoint.length > best.mountpoint.length) best = { mountpoint, fstype }
  }
  return best?.fstype ?? 'unknown'
}

/** 'linked' iff the repo's own .git dir differs from the common (main-checkout) .git dir — i.e.
 *  this working tree is a `git worktree add` linked tree, not the main checkout. Pure. */
export function classifyWorktree(gitDir: string, commonDir: string): 'main' | 'linked' {
  return path.resolve(gitDir) === path.resolve(commonDir) ? 'main' : 'linked'
}

interface GitInfo {
  isRepo: boolean
  kind: 'main' | 'linked' | null
  branch: string
  root: string
  gitDir: string
  commonDir: string
}

interface FilesystemFacet {
  cwd: string
  home: string
  projectDir: string
  fsType: string
  git: GitInfo | null
  diskFreeGb: number | null
}

async function detectFsType(projectDir: string): Promise<string> {
  try {
    if (process.platform === 'darwin') {
      const mount = await run('mount')
      if (!mount.ok) return 'unknown'
      let target = projectDir
      try {
        target = fs.realpathSync(projectDir)
      } catch {
        // keep the unresolved path — still usable for prefix matching
      }
      return pickMountFsType(mount.stdout, target)
    }
    if (process.platform === 'linux') {
      const stat = await run('stat', ['-f', '-c', '%T', projectDir])
      return stat.stdout.trim() || 'unknown'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function detectGit(): Promise<GitInfo | null> {
  try {
    const isRepoR = await run('git', ['rev-parse', '--is-inside-work-tree'])
    if (!isRepoR.ok || isRepoR.stdout.trim() !== 'true') return null
    const [rootR, branchR, gitDirR, commonDirR] = await Promise.all([
      run('git', ['rev-parse', '--show-toplevel']),
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
      run('git', ['rev-parse', '--git-dir']),
      run('git', ['rev-parse', '--git-common-dir']),
    ])
    const gitDir = gitDirR.stdout.trim()
    const commonDir = commonDirR.stdout.trim()
    return {
      isRepo: true,
      kind: gitDir && commonDir ? classifyWorktree(gitDir, commonDir) : null,
      branch: branchR.stdout.trim(),
      root: rootR.stdout.trim(),
      gitDir,
      commonDir,
    }
  } catch {
    return null
  }
}

function detectDiskFreeGb(projectDir: string): number | null {
  try {
    const stats = fs.statfsSync(projectDir)
    const gb = (stats.bavail * stats.bsize) / 1024 ** 3
    return Math.round(gb * 10) / 10
  } catch {
    return null
  }
}

async function gather(): Promise<FilesystemFacet> {
  const cwd = process.cwd()
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd
  const [fsType, git] = await Promise.all([detectFsType(projectDir), detectGit()])
  return {
    cwd,
    home: os.homedir(),
    projectDir,
    fsType,
    git,
    diskFreeGb: detectDiskFreeGb(projectDir),
  }
}

function render(value: unknown): string {
  const v = value as FilesystemFacet
  const gitLine = v.git
    ? `git:           ${v.git.kind ?? 'unknown'} worktree · branch ${v.git.branch} · root ${v.git.root}`
    : 'git:           not a repo'
  return [
    `cwd:           ${v.cwd}`,
    `project dir:   ${v.projectDir}`,
    `filesystem:    ${v.fsType}`,
    gitLine,
    `disk free:     ${v.diskFreeGb !== null ? `${v.diskFreeGb} GB` : 'unknown'}`,
  ].join('\n')
}

export const filesystemFacet: EnvFacet = {
  name: 'filesystem',
  aliases: ['fs', 'disk'],
  summary: 'cwd/home/project dir, filesystem type, git worktree identity, free disk space',
  gather,
  render,
}
