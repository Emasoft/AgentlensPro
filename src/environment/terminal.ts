// src/environment/terminal.ts — which terminal/host is this CLI running under (TRDD-HUWJVQJA).
//
// The PRIMARY method is PROCESS ANCESTRY, ported from the ai-maestro-janitor's identify_environment
// (lib/state.py): walk parent PIDs from us up to the launching terminal and match each ancestor's
// command against a pattern table — NEAREST match wins. This beats reading $TERM_PROGRAM, which is
// inherited into subshells, goes stale across `ssh`/`sudo`/multiplexers, and is simply absent under
// many hosts, so it lies about the real host. A tmux pane resolves to `tmux` (its shell's parent is
// the tmux server) even when a GUI terminal sits further up the tree — exactly what you want.
//
// Ancestry can't see a Windows Terminal (it hosts conhost, not a matchable argv) or a VS Code
// integrated terminal in every case, so an ENV fallback fills the gap ONLY when ancestry returns
// unknown. Override the whole thing with AGENTLENS_FORCE_TERMINAL_KIND for tests / misfires.

import { run } from './exec'
import type { EnvFacet } from './types'

export type PsTable = Map<number, { ppid: number; command: string }>

const TERMINAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/tmux:? ?server|(?:^|\/)tmux(?:\s|$)/, 'tmux'],
  [/(?:^|\/)screen(?:\s|$)/, 'screen'],
  [/(?:^|\/)zellij(?:\s|$)/, 'zellij'],
  [/iTerm\.app|(?:^|\/)iTerm2?(?:\s|$)/, 'iterm'],
  [/WezTerm\.app|(?:^|\/)wezterm(?:-gui)?(?:\s|$)/, 'wezterm'],
  [/(?:^|\/)kitty(?:\.app|\s|\/|$)/, 'kitty'],
  [/Ghostty\.app|(?:^|\/)ghostty(?:\s|$)/, 'ghostty'],
  [/Alacritty\.app|(?:^|\/)alacritty(?:\s|$)/, 'alacritty'],
  [/Hyper\.app/, 'hyper'],
  [/Warp\.app|WarpTerminal/, 'warp'],
  [/Code Helper|Visual Studio Code\.app|(?:^|\/)code(?:\s|$)/, 'vscode'],
  [/Terminal\.app\/Contents\/MacOS\/Terminal/, 'apple-terminal'],
]

/** Parse `ps -axo pid=,ppid=,command=` into a {pid → (ppid, command)} table. Tolerates a header row
 *  and malformed lines; keeps the command's embedded spaces (split with maxsplit=2). Pure. */
export function parsePsTable(text: string): PsTable {
  const table: PsTable = new Map()
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed) continue
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] })
  }
  return table
}

/** Commands of startPid's ancestors, NEAREST first (excludes itself). Stops at pid ≤ 1, a cycle, a
 *  missing parent, or a 64-deep cap so a corrupt snapshot can never loop forever. Pure. */
export function processAncestry(startPid: number, table: PsTable): string[] {
  const out: string[] = []
  const seen = new Set<number>([startPid])
  let cur = startPid
  for (let i = 0; i < 64; i++) {
    const entry = table.get(cur)
    if (!entry) break
    const ppid = entry.ppid
    if (ppid <= 1 || seen.has(ppid)) break
    const parent = table.get(ppid)
    if (!parent) break
    out.push(parent.command)
    seen.add(ppid)
    cur = ppid
  }
  return out
}

/** The terminal kind a single process command belongs to, or null. Pure. */
export function terminalFromCommand(cmd: string): string | null {
  for (const [pat, kind] of TERMINAL_PATTERNS) {
    if (pat.test(cmd)) return kind
  }
  return null
}

/** Env-only fallback used ONLY when ancestry returns unknown (Windows Terminal, some VS Code cases). */
export function terminalFromEnv(env: NodeJS.ProcessEnv): string | null {
  if ((env.WT_SESSION ?? '').trim()) return 'windows-terminal'
  if ((env.KITTY_WINDOW_ID ?? '').trim()) return 'kitty'
  if ((env.WEZTERM_PANE ?? '').trim() || (env.WEZTERM_EXECUTABLE ?? '').trim()) return 'wezterm'
  if ((env.GHOSTTY_RESOURCES_DIR ?? '').trim()) return 'ghostty'
  if ((env.ALACRITTY_WINDOW_ID ?? '').trim() || (env.ALACRITTY_SOCKET ?? '').trim()) return 'alacritty'
  const tp = (env.TERM_PROGRAM ?? '').trim()
  const map: Record<string, string> = {
    'iTerm.app': 'iterm',
    Apple_Terminal: 'apple-terminal',
    vscode: 'vscode',
    WezTerm: 'wezterm',
    ghostty: 'ghostty',
    Hyper: 'hyper',
    WarpTerminal: 'warp',
    tmux: 'tmux',
  }
  return map[tp] ?? null
}

/** Resolve the terminal kind: force-override → ancestry (primary) → env fallback → 'unknown'. Pure. */
export function terminalKind(psText: string, startPid: number, env: NodeJS.ProcessEnv): string {
  const forced = (env.AGENTLENS_FORCE_TERMINAL_KIND ?? '').trim().toLowerCase()
  if (forced) return forced
  const table = parsePsTable(psText)
  for (const cmd of processAncestry(startPid, table)) {
    const kind = terminalFromCommand(cmd)
    if (kind) return kind
  }
  return terminalFromEnv(env) ?? 'unknown'
}

const AI_MAESTRO_FLAGS = ['AIMAESTRO_AGENT', 'THIS_IS_AIMAESTRO'] as const
const AI_MAESTRO_INTERNALS = ['AMP_AGENT_ID', 'AID_AUTH'] as const

/** Are we running INSIDE an ai-maestro agent? Explicit flag truthy OR an ai-maestro internal id set.
 *  Ported from the janitor's in_ai_maestro_agent_env (the stable contract it sets on the launch). Pure. */
export function aiMaestroFromEnv(env: NodeJS.ProcessEnv): boolean {
  for (const name of AI_MAESTRO_FLAGS) {
    if (['1', 'true', 'yes', 'on'].includes((env[name] ?? '').trim().toLowerCase())) return true
  }
  return AI_MAESTRO_INTERNALS.some((name) => (env[name] ?? '').trim() !== '')
}

/** Which terminal multiplexer wraps us, if any (tmux / screen / zellij), from its env markers. Pure. */
export function multiplexerFromEnv(env: NodeJS.ProcessEnv): string | null {
  if ((env.TMUX ?? '').trim() || (env.TMUX_PANE ?? '').trim()) return 'tmux'
  if ((env.ZELLIJ ?? '').trim()) return 'zellij'
  if ((env.STY ?? '').trim()) return 'screen'
  return null
}

const TERMINAL_ENV_KEYS = [
  'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'ITERM_SESSION_ID', 'WT_SESSION',
  'WT_PROFILE_ID', 'KITTY_WINDOW_ID', 'WEZTERM_PANE', 'GHOSTTY_RESOURCES_DIR', 'ALACRITTY_WINDOW_ID',
  'VSCODE_INJECTION', 'VSCODE_GIT_ASKPASS_MAIN', 'SSH_TTY', 'SSH_CONNECTION',
]

interface TerminalFacet {
  kind: string
  multiplexer: string | null
  inAiMaestroAgent: boolean
  overSsh: boolean
  tmux: { session: string; pane: string; window: string } | null
  ancestry: string[]
  envSignals: Record<string, string>
}

async function gatherTmux(env: NodeJS.ProcessEnv): Promise<TerminalFacet['tmux']> {
  if (!(env.TMUX ?? '').trim() && !(env.TMUX_PANE ?? '').trim()) return null
  const q = async (fmt: string): Promise<string> => {
    const r = await run('tmux', ['display-message', '-p', fmt], { timeoutMs: 3000 })
    return r.ok ? r.stdout.trim() : ''
  }
  return {
    session: await q('#{session_name}'),
    pane: (env.TMUX_PANE ?? '').trim(),
    window: await q('#{window_index}:#{window_name}'),
  }
}

async function gather(): Promise<TerminalFacet> {
  const env = process.env
  const ps = await run('ps', ['-axo', 'pid=,ppid=,command='], { timeoutMs: 5000 })
  const psText = ps.ok ? ps.stdout : ''
  const table = parsePsTable(psText)
  const ancestry = processAncestry(process.pid, table).slice(0, 8).map((c) => c.slice(0, 120))
  const envSignals: Record<string, string> = {}
  for (const k of TERMINAL_ENV_KEYS) {
    const v = (env[k] ?? '').trim()
    if (v) envSignals[k] = v
  }
  return {
    kind: terminalKind(psText, process.pid, env),
    multiplexer: multiplexerFromEnv(env),
    inAiMaestroAgent: aiMaestroFromEnv(env),
    overSsh: !!((env.SSH_TTY ?? '').trim() || (env.SSH_CONNECTION ?? '').trim()),
    tmux: await gatherTmux(env),
    ancestry,
    envSignals,
  }
}

function render(value: unknown): string {
  const v = value as TerminalFacet
  const lines: string[] = []
  lines.push(`terminal:      ${v.kind}${v.inAiMaestroAgent ? '   · inside ai-maestro agent' : ''}`)
  if (v.multiplexer) lines.push(`multiplexer:   ${v.multiplexer}`)
  if (v.tmux) lines.push(`tmux:          session ${v.tmux.session || '?'} · pane ${v.tmux.pane || '?'}${v.tmux.window ? ` · window ${v.tmux.window}` : ''}`)
  if (v.overSsh) lines.push(`ssh:           yes (${v.envSignals.SSH_CONNECTION ?? v.envSignals.SSH_TTY ?? ''})`)
  if (v.ancestry.length) lines.push(`launch chain:  ${v.ancestry.slice(0, 4).join('  ←  ')}`)
  return lines.join('\n')
}

export const terminalFacet: EnvFacet = {
  name: 'terminal',
  aliases: ['term'],
  summary: 'hosting terminal/program (by process ancestry), multiplexer, ai-maestro, ssh, tmux',
  gather,
  render,
}
