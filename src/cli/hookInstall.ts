// src/cli/hookInstall.ts — hook / OTEL / skill (un)installers of the single `agentlenspro`
// executable (TRDD-7284WCW7; matcher logic from TRDD-GOD0108C).
//
// v2.0.0 registration contract: hooks are registered as the COMMAND STRINGS
// `agentlenspro hook` / `agentlenspro gate` (hook commands are shell strings — args are
// valid). The v1 PATH-bin names (agentlenspro-hook / agentlenspro-gate) and the v0
// absolute-path spy-agentlens*.{sh,mjs} registrations are LEGACY: install and `setup`
// rewrite them; uninstall strips every generation. The bin resolved on PATH is therefore
// `agentlenspro` itself — one shim that npm/Homebrew keep pointing at the current install,
// so registrations survive version bumps (the P10 property, now without wrapper scripts).

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { safeConfigEdit, SafeEditOp } from '../safeConfigEdit'
import { ensureTelemetryConfig, removeTelemetryConfig } from '../telemetryConfig'
import { claudeSettingsPath } from './cliCore'

// Lifecycle events worth hooking — they carry signals the JSONL transcripts and OTEL bodies
// LACK (exact rate-limit turn deaths, compaction boundaries + trigger, session lifecycle).
// Deliberately NO unmatched PreToolUse/PostToolUse/UserPromptSubmit: those are fully redundant
// with the existing ingestion and are the only high-frequency hooks — all of the per-turn
// overhead that made claude-spyglass expensive lived there (2+ process spawns per tool call).
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'PreCompact', 'PostCompact',
  'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop',
]

// The burn gate (TRDD-GOD0108C) is the ONE narrow exception to the no-PreToolUse rule: it is
// MATCHED to agent-launch tools only (rare calls, the exact moments token disasters start),
// and it must be SYNC (async hooks cannot deny) with a hard 3s timeout so a dead server never
// stalls a turn. SendMessage joined the matcher in P6: resuming a DEAD agent re-runs the
// request that killed it, so the server gates it — but ONLY on cache-thrash / cold-resume.
export const GATE_MATCHER = '^(Task|Agent|Workflow|SendMessage)$'
export const GATE_EVENTS = ['PreToolUse', 'PostToolUse']

/** The ONE published bin (package.json "bin") — what must resolve on PATH. */
export const CLI_BIN = 'agentlenspro'
/** v2 registration command strings (shell command strings; args are valid in hook commands). */
export const HOOK_CMD = 'agentlenspro hook'
export const GATE_CMD = 'agentlenspro gate'
// v1 PATH-bin names — recognised as ours for migration/uninstall, never registered anymore.
export const LEGACY_HOOK_BIN = 'agentlenspro-hook'
export const LEGACY_GATE_BIN = 'agentlenspro-gate'

export interface HookCommandEntry { type: string; command: string; timeout?: number; async?: boolean }
export interface HookMatcher { matcher?: string; hooks: HookCommandEntry[] }
export interface RebuildResult { rebuilt: HookMatcher[]; removedOurs: number; removedSpyglass: number; installed: boolean }

/** Every generation of AgentlensPro hook registration this project ever wrote:
 *  v0 absolute-path spy scripts, v1 PATH-bin wrappers, v2 `agentlenspro hook|gate`
 *  subcommand strings. Matching ALL of them means uninstall/reinstall can never
 *  orphan an entry from any past version. */
export function isOurHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  return command.includes('spy-agentlens')
    || command.includes(LEGACY_HOOK_BIN)
    || command.includes(LEGACY_GATE_BIN)
    // \b keeps a hypothetical foreign "agentlensprod hookx" from matching; the space
    // between bin and verb is what distinguishes the v2 command-string generation.
    || /\bagentlenspro\s+(hook|gate)\b/.test(command)
}

const isSpyglass = (h: HookCommandEntry): boolean =>
  typeof h?.command === 'string' && h.command.includes('spyglass-collect.sh')

// Rebuild one event's matcher list: strip our entries of every generation (and, when
// installing, dead claude-spyglass entries too), drop matchers left empty, append our entry
// on lifecycle events and the gate entry on agent-launch tool events. Pure — returns the new
// list + what was stripped; the caller decides whether anything changed.
export function rebuildEventMatchers(
  matchers: HookMatcher[], ev: string, uninstall: boolean, cmd: string, gateCmd: string
): RebuildResult {
  const out: RebuildResult = { rebuilt: [], removedOurs: 0, removedSpyglass: 0, installed: false }
  for (const m of matchers) {
    const kept = (Array.isArray(m.hooks) ? m.hooks : []).filter(h => {
      if (isOurHookCommand(h?.command)) { out.removedOurs++; return false }
      if (!uninstall && isSpyglass(h)) { out.removedSpyglass++; return false }
      return true
    })
    if (kept.length > 0) out.rebuilt.push({ ...m, hooks: kept }) // a matcher left empty is dropped
  }
  if (!uninstall && HOOK_EVENTS.includes(ev)) {
    out.rebuilt.push({ hooks: [{ type: 'command', command: cmd, timeout: 2, async: true }] })
    out.installed = true
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    // SYNC (no async:true — an async hook cannot deny) + matched to agent-launch tools only.
    out.rebuilt.push({ matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCmd, timeout: 3 }] })
    out.installed = true
  }
  return out
}

/** PATH resolution mirror of what the hook runner's shell will do — used to REFUSE an
 *  install that would register a name the shell cannot find (a bare-name hook that is
 *  not on PATH would silently never fire, which is worse than a loud failure here). */
export function resolveOnPath(name: string, pathEnv?: string): string | null {
  const dirs = (pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).concat([''])
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try {
        fs.accessSync(p, fs.constants.X_OK)
        if (fs.statSync(p).isFile()) return p
      } catch { /* not here — keep scanning */ }
    }
  }
  return null
}

export interface InstallHooksOptions {
  settingsPath?: string
  /** PATH used for the pre-install bin probe (tests point it at a fixture shim dir). */
  pathEnv?: string
  /** Collects human-readable progress lines instead of printing (setup reuses this). */
  log?: (line: string) => void
}

export interface InstallHooksResult {
  changed: boolean
  addedEvents: number
  removedOurs: number
  removedSpyglass: number
  backupPath: string | null
}

/** Install (or remove) the AgentlensPro hook registrations via the verified transaction
 *  engine. Install ALSO removes every claude-spyglass hook entry and its env.SPYGLASS_DIR
 *  (spyglass's server is gone — its registrations were dead process spawns on every event).
 *  Merge-preserving: hooks from other tools on the same events are never touched. */
export async function installHooks(uninstall: boolean, opts: InstallHooksOptions = {}): Promise<InstallHooksResult> {
  const settingsFile = opts.settingsPath ?? claudeSettingsPath()
  const log = opts.log ?? ((line: string) => console.log(line))

  if (!uninstall && !resolveOnPath(CLI_BIN, opts.pathEnv)) {
    throw new Error(
      `refusing: '${CLI_BIN}' is not on PATH — a hook registered as '${HOOK_CMD}' would silently never fire. `
      + 'Install the package first (npm i -g agentlenspro, or npm link from the repo checkout), then re-run.'
    )
  }

  let settings: Record<string, unknown> = {}
  if (fs.existsSync(settingsFile)) {
    // Refuse-unparseable, same stance as safe_config_edit: never "start fresh" over user config.
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown> }
    catch { throw new Error(`refusing: ${settingsFile} is not parseable JSON — fix it before editing hooks`) }
  }
  const hooks = (settings && typeof settings === 'object' && settings.hooks && typeof settings.hooks === 'object'
    ? settings.hooks : {}) as Record<string, HookMatcher[]>

  const ops: SafeEditOp[] = []
  let removedSpyglass = 0
  let removedOurs = 0
  let added = 0
  const events = new Set([...Object.keys(hooks), ...(uninstall ? [] : [...HOOK_EVENTS, ...GATE_EVENTS])])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, uninstall, HOOK_CMD, GATE_CMD)
    // Counters reflect only events that actually change — an already-current event (ours
    // present, nothing stripped) must not inflate "installed on N events" to a lie.
    if (JSON.stringify(r.rebuilt) === JSON.stringify(matchers)) continue
    removedOurs += r.removedOurs
    removedSpyglass += r.removedSpyglass
    if (r.installed) added++
    if (r.rebuilt.length === 0) {
      ops.push({ op: 'delete', path: ['hooks', ev] })
    } else if (uninstall || r.removedOurs > 0 || r.removedSpyglass > 0) {
      // A strip (migrating a previous generation / removing dead spyglass entries) can only be
      // expressed as a whole-array replace — the rare, deliberate path.
      ops.push({ op: 'set', path: ['hooks', ev], value: r.rebuilt })
    } else {
      // PURE ADD (nothing to strip): append our matcher(s) with append_unique instead of a whole-array
      // `set`. The `set` value is computed from THIS function's earlier read of settings.json, so a
      // hook another tool appends to the same event between that read and the transaction would be
      // clobbered by the stale snapshot (S3-F5 TOCTOU). append_unique is idempotent and is evaluated
      // against the FRESH array inside safe_config_edit's lock, so a concurrent foreign entry survives.
      // The appended matchers are byte-identical to what rebuildEventMatchers produces.
      if (HOOK_EVENTS.includes(ev)) {
        ops.push({ op: 'append_unique', path: ['hooks', ev], value: { hooks: [{ type: 'command', command: HOOK_CMD, timeout: 2, async: true }] }, unique_by_substring: HOOK_CMD })
      }
      if (GATE_EVENTS.includes(ev)) {
        ops.push({ op: 'append_unique', path: ['hooks', ev], value: { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: GATE_CMD, timeout: 3 }] }, unique_by_substring: GATE_CMD })
      }
    }
  }
  // env.SPYGLASS_DIR only feeds the spyglass hook commands — dead once those are removed.
  const env = settings.env as Record<string, unknown> | undefined
  if (!uninstall && env && env.SPYGLASS_DIR !== undefined) {
    ops.push({ op: 'delete', path: ['env', 'SPYGLASS_DIR'] })
  }

  if (ops.length === 0) {
    log(uninstall ? 'no agentlens hooks present — nothing to remove' : 'hooks already installed — nothing to change')
    return { changed: false, addedEvents: 0, removedOurs: 0, removedSpyglass: 0, backupPath: null }
  }
  const result = await safeConfigEdit(settingsFile, 'json', ops, { createIfMissing: !uninstall })
  if (uninstall) {
    log(`removed ${removedOurs} agentlens hook entr${removedOurs === 1 ? 'y' : 'ies'} from ${settingsFile}`)
  } else {
    log(`installed agentlens hooks on ${added} event(s) in ${settingsFile} (lifecycle forwarder '${HOOK_CMD}' + burn-gate '${GATE_CMD}' on ${GATE_MATCHER})`)
    if (removedSpyglass > 0) log(`removed ${removedSpyglass} dead claude-spyglass hook entr${removedSpyglass === 1 ? 'y' : 'ies'} (+ env.SPYGLASS_DIR)`)
    if (removedOurs > 0) log(`migrated ${removedOurs} previous-generation agentlens entr${removedOurs === 1 ? 'y' : 'ies'}`)
  }
  log(`changed=${result.changed}${result.backupPath ? ` backup=${result.backupPath}` : ''} attempts=${result.attempts}`)
  log('restart Claude Code sessions to pick up the hook change')
  return { changed: result.changed, addedEvents: added, removedOurs, removedSpyglass, backupPath: result.backupPath }
}

export interface InstallOtelOptions {
  settingsPath?: string
  markerPath?: string
  bodiesDir?: string
  otlpPort?: number
  log?: (line: string) => void
}

/** Wire (or unwire) the Claude Code full-telemetry env vars. Delegates to the ONE
 *  telemetry-config module (src/telemetryConfig.ts) instead of keeping a second key table
 *  here — the old CLI carried a duplicate OTEL_ENV map that had already drifted (it lacked
 *  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA), which is exactly the mirror-rot the shared-module
 *  rule exists to prevent. The module also records prior key state, so uninstall restores
 *  the user's settings byte-identically instead of blind-deleting keys. */
export async function installOtel(uninstall: boolean, opts: InstallOtelOptions = {}): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const common = {
    settingsPath: opts.settingsPath ?? claudeSettingsPath(),
    markerPath: opts.markerPath,
    bodiesDir: opts.bodiesDir,
    otlpPort: opts.otlpPort,
  }
  if (uninstall) {
    const r = await removeTelemetryConfig(common)
    log(`telemetry env: deleted ${r.deleted.length} key(s), restored ${r.restored.length} pre-existing value(s) in ${common.settingsPath}`)
  } else {
    const r = await ensureTelemetryConfig(common)
    log(`telemetry env: ${r.changed ? `added ${r.added.length}, overrode ${r.overrode.length} key(s)` : 'already current'} in ${common.settingsPath}`)
    log('restart Claude Code sessions to pick up the env change')
  }
}

export interface InstallSkillOptions {
  /** Repo/package root holding skills/agentlenspro-diagnostics/SKILL.md. */
  repoRoot?: string
  /** Target skills dir. Default ~/.claude/skills */
  skillsDir?: string
  log?: (line: string) => void
}

export const SKILL_NAME = 'agentlenspro-diagnostics'

/** Walk up from a start dir to the first directory containing the shipped skill. The CLI
 *  bundle lives at <pkg>/standalone/cli.js and the test build at <repo>/out/test/cli/, so a
 *  fixed ../.. would be wrong in one of the two — the walk is layout-proof. */
export function findPackageRoot(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'skills', SKILL_NAME, 'SKILL.md'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** (Re)install the agentlenspro-diagnostics skill into the user scope. The repo copy is the
 *  single source of truth; ~/.claude/skills/ is a managed installation target. Idempotent by
 *  content comparison — safe to run on every install / update, and the way to recover the
 *  skill if it was deleted. Returns what happened so `setup` can RECORD it. */
export function installSkill(opts: InstallSkillOptions = {}): 'installed' | 'updated' | 'current' {
  const log = opts.log ?? ((line: string) => console.log(line))
  const root = opts.repoRoot ?? findPackageRoot(__dirname)
  if (!root) throw new Error(`skill source missing — no skills/${SKILL_NAME}/SKILL.md above ${__dirname}`)
  const src = path.join(root, 'skills', SKILL_NAME, 'SKILL.md')
  if (!fs.existsSync(src)) throw new Error(`skill source missing at ${src} — is the package intact?`)
  const dst = path.join(opts.skillsDir ?? path.join(os.homedir(), '.claude', 'skills'), SKILL_NAME, 'SKILL.md')
  const content = fs.readFileSync(src, 'utf8')
  const existed = fs.existsSync(dst)
  if (existed && fs.readFileSync(dst, 'utf8') === content) {
    log(`skill ${SKILL_NAME}: already current (${dst})`)
    return 'current'
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, content)
  log(`skill ${SKILL_NAME}: ${existed ? 'updated' : 'installed'} -> ${dst}`)
  return existed ? 'updated' : 'installed'
}
