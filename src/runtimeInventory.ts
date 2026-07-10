// Runtime inventory (TRDD-O981ZJKV item 13) — "what Claude Code instances are running on this
// machine, and what is EACH one's total memory footprint including everything it spawned?"
//
// Method: one `ps` snapshot (pid/ppid/rss/etime/command), then pure tree math — every process
// whose ancestor chain reaches a claude ROOT belongs to that instance: subshells, worktree
// agents, subagents/forks (they run inside the same process or as child node processes),
// plugin crons, MCP servers, headless browsers, background tasks. RSS sums the whole tree.
// The snapshot-first approach also avoids the classic self-match trap of live pgrep pipelines.
//
// POSIX only (macOS/Linux/WSL): `ps -axo` does not exist on native Windows — the report says
// so honestly instead of guessing (native-Windows support is tracked by the cross-platform
// audit follow-up).

import { execFileSync } from 'child_process'

export interface PsRow {
  pid: number
  ppid: number
  /** Resident set size in KB (as ps reports it). */
  rssKb: number
  etime: string
  command: string
}

export interface InstanceProcess {
  pid: number
  rssMb: number
  etime: string
  /** First ~120 chars of the command line — enough to identify, small enough to list. */
  command: string
}

export interface ClaudeInstance {
  pid: number
  etime: string
  /** RSS of the claude process itself. */
  ownRssMb: number
  /** RSS of the WHOLE dependent tree (claude + every descendant). */
  totalRssMb: number
  processCount: number
  /** Heaviest descendants, ranked by RSS. */
  topProcesses: InstanceProcess[]
  /** Project dir when resolvable (lsof cwd), else null. */
  cwd: string | null
}

/** Parse `ps -axo pid=,ppid=,rss=,etime=,command=` output. Exported for tests. */
export function parsePsSnapshot(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), etime: m[4], command: m[5] })
  }
  return rows
}

/** A claude MAIN process: argv0's basename is exactly `claude`. Matching the whole command
 *  line would false-positive on every process whose ARGS mention ~/.claude/... paths. */
export function isClaudeRoot(command: string): boolean {
  const argv0 = command.trim().split(/\s+/)[0] ?? ''
  const base = argv0.split('/').pop() ?? ''
  return base === 'claude'
}

const mb = (kb: number): number => Math.round(kb / 1024 * 10) / 10

/** Pure tree math over a snapshot: group every process under its claude root (an instance =
 *  a claude process with no claude ancestor; nested claude processes — subagent CLIs — fold
 *  into their parent instance). Exported for tests. */
export function buildClaudeInstances(rows: PsRow[]): ClaudeInstance[] {
  const byPid = new Map<number, PsRow>()
  const children = new Map<number, PsRow[]>()
  for (const r of rows) {
    byPid.set(r.pid, r)
    const list = children.get(r.ppid) ?? []
    list.push(r)
    children.set(r.ppid, list)
  }
  const hasClaudeAncestor = (r: PsRow): boolean => {
    let cur = byPid.get(r.ppid)
    let hops = 0
    while (cur && hops++ < 64) { // hop cap: a ppid cycle in a torn snapshot must not hang us
      if (isClaudeRoot(cur.command)) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  const roots = rows.filter(r => isClaudeRoot(r.command) && !hasClaudeAncestor(r))

  return roots.map(root => {
    // BFS the descendant tree from the root.
    const tree: PsRow[] = []
    const queue = [root.pid]
    const seen = new Set<number>()
    while (queue.length > 0) {
      const pid = queue.shift() as number
      if (seen.has(pid)) continue
      seen.add(pid)
      for (const c of children.get(pid) ?? []) {
        tree.push(c)
        queue.push(c.pid)
      }
    }
    const totalKb = root.rssKb + tree.reduce((n, r) => n + r.rssKb, 0)
    const top = [...tree].sort((a, b) => b.rssKb - a.rssKb).slice(0, 5)
      .map(r => ({ pid: r.pid, rssMb: mb(r.rssKb), etime: r.etime, command: r.command.slice(0, 120) }))
    return {
      pid: root.pid,
      etime: root.etime,
      ownRssMb: mb(root.rssKb),
      totalRssMb: mb(totalKb),
      processCount: 1 + tree.length,
      topProcesses: top,
      cwd: null, // filled by the caller when lsof is available
    }
  }).sort((a, b) => b.totalRssMb - a.totalRssMb)
}

function resolveCwd(pid: number): string | null {
  try {
    // -a AND: this pid's cwd descriptor only; -Fn = machine-parsable name lines.
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }).toString('utf-8')
    const m = /^n(.+)$/m.exec(out)
    return m ? m[1] : null
  } catch {
    return null // lsof absent or denied — the field stays null, never fatal
  }
}

function claudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], { timeout: 5000 }).toString('utf-8').trim().slice(0, 120)
  } catch {
    return null
  }
}

export interface RuntimeInventoryOptions {
  /** Test seam: replaces the live ps snapshot. */
  psText?: string
  /** Skip lsof/claude-version subprocess calls (tests). */
  noSubprocess?: boolean
}

export function buildRuntimeInventory(opts: RuntimeInventoryOptions = {}): unknown {
  if (process.platform === 'win32' && !opts.psText) {
    return {
      error: 'runtime inventory is POSIX-only for now (ps/lsof) — on Windows run it inside WSL. Native support is tracked by the cross-platform follow-up.',
    }
  }
  let psText = opts.psText
  if (psText === undefined) {
    try {
      psText = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command='], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 }).toString('utf-8')
    } catch (e) {
      return { error: `ps snapshot failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const instances = buildClaudeInstances(parsePsSnapshot(psText))
  if (!opts.noSubprocess) {
    for (const inst of instances) inst.cwd = resolveCwd(inst.pid)
  }
  return {
    checkedAtIso: new Date().toISOString(),
    claudeCodeVersion: opts.noSubprocess ? null : claudeVersion(),
    instanceCount: instances.length,
    totalRssMb: Math.round(instances.reduce((n, i) => n + i.totalRssMb, 0)),
    instances,
    note:
      'instances ranked by total tree RSS. Each tree includes EVERYTHING the instance spawned ' +
      '(subshells, worktree/subagent processes, plugin crons, MCP servers, background tasks). ' +
      'cwd identifies the project (null when lsof is unavailable). For each instance\'s live ' +
      'MODEL and token burn, join on workspace via get_burn_status / get_cost_rollup --liveOnly.',
  }
}
