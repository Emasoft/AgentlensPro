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
  // ConfigChange (TRDD-EYA3X5MQ) — fires when a config file changes mid-session (source:
  // user_settings|project_settings|local_settings|policy_settings|skills). Kept because a
  // mid-session config change IS a real cache-break cause worth timestamping; rare (not
  // per-turn) → negligible overhead.
  // REFUTED 2026-07-21: it is NOT a `/reload-plugins` signal. Measured after an explicit
  // `/reload-plugins` with the hook installed: the reload emitted ZERO hook events, and the
  // whole store (40,858 records / 13 days) holds ev==ConfigChange exactly 0 times. Do NOT
  // re-test this. No hook observes a plugin reload — but the TRANSCRIPT does: Claude Code
  // persists the command itself, which src/cacheRiskCommands.ts reads exactly and retroactively.
  'ConfigChange',
]

// The burn gate (TRDD-GOD0108C) is the ONE narrow exception to the no-PreToolUse rule: it is
// MATCHED to agent-launch tools only (rare calls, the exact moments token disasters start),
// and it must be SYNC (async hooks cannot deny) with a hard 3s timeout so a dead server never
// stalls a turn. SendMessage joined the matcher in P6: resuming a DEAD agent re-runs the
// request that killed it, so the server gates it — but ONLY on cache-thrash / cold-resume.
//
// `Read` (2026-07-28) is the ONE non-rare tool in the matcher, and it is here only for the image
// cache-guard, which warns when an image would become RESIDENT in an already-fat session. Its cost
// is bounded on the CLI side, not by the matcher: runGateCheck answers a Read locally (one JSON
// parse, no network) unless the path is actually an image — so the overwhelmingly common
// read-a-source-file case never reaches the server. Silence it alone with
// AGENTLENS_CACHE_GUARD=off, which leaves the agent-launch gate armed.
export const GATE_MATCHER = '^(Task|Agent|Workflow|SendMessage|Read)$'
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
export interface RebuildResult {
  rebuilt: HookMatcher[]; removedOurs: number; removedSpyglass: number; installed: boolean
  /** The command string of every entry this rebuild dropped. The strip is committed as a FILTER
   *  evaluated inside the transaction lock (TRDD-T0CT9U4X), and the filter's needles are derived
   *  from these — the rebuilt array itself must never be sent as a whole-array replace. */
  removedCommands: string[]
}

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
// The two registration shapes, each defined ONCE. They are built on two code paths — the
// whole-array rebuild and the append_unique op — and a comment used to assert the two were
// "byte-identical", a claim maintained by hand. Bumping a timeout on one path and missing the
// other registers a DIFFERENT hook depending on whether the install had anything to strip, which
// is invisible until someone diffs two machines' settings.json.

/** The lifecycle forwarder: async, so it cannot block a turn. */
export function lifecycleMatcher(cmd: string): HookMatcher {
  return { hooks: [{ type: 'command', command: cmd, timeout: 2, async: true }] }
}

/** The burn gate: SYNC (an async hook cannot deny) and scoped to agent-launch tools only. */
export function gateMatcher(gateCmd: string): HookMatcher {
  return { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCmd, timeout: 3 }] }
}

export function rebuildEventMatchers(
  matchers: HookMatcher[], ev: string, uninstall: boolean, cmd: string, gateCmd: string
): RebuildResult {
  const out: RebuildResult = { rebuilt: [], removedOurs: 0, removedSpyglass: 0, installed: false, removedCommands: [] }
  for (const m of matchers) {
    const kept = (Array.isArray(m.hooks) ? m.hooks : []).filter(h => {
      if (isOurHookCommand(h?.command)) { out.removedOurs++; out.removedCommands.push(String(h.command)); return false }
      if (!uninstall && isSpyglass(h)) { out.removedSpyglass++; out.removedCommands.push(String(h.command)); return false }
      return true
    })
    if (kept.length > 0) out.rebuilt.push({ ...m, hooks: kept }) // a matcher left empty is dropped
  }
  if (!uninstall && HOOK_EVENTS.includes(ev)) {
    out.rebuilt.push(lifecycleMatcher(cmd))
    out.installed = true
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    out.rebuilt.push(gateMatcher(gateCmd))
    out.installed = true
  }
  return out
}

// ── The strip, expressed as a FILTER instead of a result (TRDD-T0CT9U4X) ────────────────────────
// Every generation this project ever registered, as a plain literal. A needle is matched against
// json.dumps(element) inside the lock, so it must be a literal JSON cannot escape — all of these are.
const GENERATION_NEEDLES = ['spy-agentlens', LEGACY_HOOK_BIN, LEGACY_GATE_BIN, HOOK_CMD, GATE_CMD, 'spyglass-collect.sh']

/** A needle that identifies this command inside the transaction, or null when none can. The known
 *  generation literals come first (one op removes every entry of that generation); an unrecognised
 *  shape — `isOurHookCommand`'s matcher is a REGEX, so `agentlenspro<TAB>hook` is ours while
 *  containing no literal — falls back to its own text, but ONLY when JSON would not escape it. */
function removalNeedle(command: string): string | null {
  const known = GENERATION_NEEDLES.find(n => command.includes(n))
  if (known) return known
  // eslint-disable-next-line no-control-regex
  return /["\\ -]/.test(command) ? null : command
}

/** The ops for ONE event. Exported because the TOCTOU property is a property of the OP LIST, not of
 *  a file: the ops are computed from a pre-lock read and applied to whatever the file holds at
 *  commit time, so the test applies them to a tree carrying an entry they never saw. */
export function buildEventOps(
  ev: string, matchers: HookMatcher[], uninstall: boolean, cmd = HOOK_CMD, gateCmd = GATE_CMD
): SafeEditOp[] {
  const r = rebuildEventMatchers(matchers, ev, uninstall, cmd, gateCmd)
  if (JSON.stringify(r.rebuilt) === JSON.stringify(matchers)) return []

  const ops: SafeEditOp[] = []
  if (r.removedCommands.length > 0) {
    const needles = new Set<string>()
    for (const c of r.removedCommands) {
      const needle = removalNeedle(c)
      if (needle === null) {
        // Inexpressible as a filter. Emitting one anyway would strip NOTHING while reporting a
        // removal, so this event alone keeps the pre-existing whole-array replace — narrower than
        // before (one exotic event instead of every strip), and loud in the code rather than silent.
        return r.rebuilt.length === 0
          ? [{ op: 'delete', path: ['hooks', ev] }]
          : [{ op: 'set', path: ['hooks', ev], value: r.rebuilt }]
      }
      needles.add(needle)
    }
    // Sorted for a deterministic op list (two runs on the same input must produce the same spec).
    for (const substring of [...needles].sort()) {
      ops.push({ op: 'remove_by_substring', path: ['hooks', ev], substring, nested_key: 'hooks', prune_empty: true })
    }
  }
  // Re-add ours AFTER the removals (ops apply in order, so the append is evaluated against the
  // filtered array — which is also what makes append_unique's idempotency check correct here).
  if (!uninstall && HOOK_EVENTS.includes(ev)) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: lifecycleMatcher(cmd), unique_by_substring: cmd })
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: gateMatcher(gateCmd), unique_by_substring: gateCmd })
  }
  return ops
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
    // EVERY path is now a predicate the transaction evaluates on the FRESH array inside its lock —
    // append_unique to add, remove_by_substring (+prune_empty) to strip. The value this function
    // computed from its own pre-lock read is never committed as a whole-array `set`, because a hook
    // another tool appends between that read and the commit would be silently deleted from the
    // user's own settings.json (S3-F5 TOCTOU, TRDD-T0CT9U4X). The one exception is an entry no
    // literal needle can express; buildEventOps says so explicitly rather than stripping nothing.
    ops.push(...buildEventOps(ev, matchers, uninstall, HOOK_CMD, GATE_CMD))
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

/** The status-line capture registration. Unlike `hooks`, `statusLine` is a SINGLE object with one
 *  `command` string and settings scopes OVERRIDE rather than merge — so capture cannot be added
 *  BESIDE an existing status line, only WRAPPED around it. The wrapper re-runs the original
 *  command through a shell (exactly as Claude Code does) and passes its stdout through untouched. */
export const STATUSLINE_CMD = 'agentlenspro statusline'
/** The `subagentStatusLine` variant — same wrapper, different event name, different settings key.
 *  Note the prefix is shared with STATUSLINE_CMD, which is harmless because the two are never read
 *  from the same settings key. */
export const SUBAGENT_STATUSLINE_CMD = 'agentlenspro statusline --subagent'

/** The two status-line settings keys and the command each registers. Kept as data so install,
 *  uninstall and the tests all walk the SAME list — a third surface (should Claude Code add one)
 *  is one row here, not a second copy of the transaction. */
export const STATUSLINE_SURFACES: ReadonlyArray<{ key: string; cmd: string; blanksWhenEmpty: boolean }> = [
  // The main status line BLANKS if its command prints nothing, so a capture-only install there is
  // only acceptable when there was no status line to begin with.
  { key: 'statusLine', cmd: STATUSLINE_CMD, blanksWhenEmpty: true },
  // subagentStatusLine does NOT: omitting a task id keeps that row's default rendering, so a
  // capture-only wrapper is invisible. This is why it can be installed unconditionally.
  { key: 'subagentStatusLine', cmd: SUBAGENT_STATUSLINE_CMD, blanksWhenEmpty: false },
]

/** POSIX single-quoting: wrap in quotes and rewrite each embedded quote as `'\''` (close, escaped
 *  quote, reopen). The original command may contain spaces, quotes, pipes or globs, and it has to
 *  survive being carried inside another command string byte-for-byte — a naive join would silently
 *  corrupt any status line fancier than `script.sh`. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Inverse of shSingleQuote over the whole remainder of a command string. Returns null unless the
 *  input is one complete, well-formed single-quoted word — a partial parse would hand uninstall a
 *  truncated command and permanently damage the user's status line. */
export function parseSingleQuoted(s: string): string | null {
  if (s[0] !== "'") return null
  let out = ''
  for (let i = 1; i < s.length;) {
    if (s[i] === "'") {
      if (s.slice(i, i + 4) === "'\\''") { out += "'"; i += 4; continue }
      return i === s.length - 1 ? out : null // the closing quote must end the string
    }
    out += s[i++]
  }
  return null // unterminated
}

/** Is this command string our capture wrapper? */
export function isOurStatuslineCommand(command: unknown): boolean {
  return typeof command === 'string' && command.trimStart().startsWith(STATUSLINE_CMD)
}

/** Recover the command our wrapper was wrapped AROUND. Returns '' for a capture-only wrapper (no
 *  inner command), or null when `command` is not ours / not parseable. */
export function unwrapStatuslineCommand(command: string): string | null {
  if (!isOurStatuslineCommand(command)) return null
  const marker = '--inner '
  const at = command.indexOf(marker)
  if (at < 0) return '' // capture-only wrapper — there was no status line to restore
  return parseSingleQuoted(command.slice(at + marker.length).trim())
}

export interface InstallStatuslineOptions {
  settingsPath?: string
  pathEnv?: string
  log?: (line: string) => void
}

export type StatuslineAction = 'wrapped' | 'capture-only' | 'unchanged' | 'restored' | 'removed' | 'absent'

export interface StatuslineSurfaceResult {
  key: string
  action: StatuslineAction
  /** The user's own command we wrapped (install) or restored (uninstall); null when there is none. */
  inner: string | null
}

export interface InstallStatuslineResult {
  changed: boolean
  surfaces: StatuslineSurfaceResult[]
  backupPath: string | null
}

/** Plan the ops for ONE status-line surface. Split out from the transaction so the decision table
 *  (wrap / capture-only / leave alone / restore / remove) is testable without touching a settings
 *  file, and so both surfaces provably go through the same rules. */
export function planStatuslineSurface(
  surface: { key: string; cmd: string; blanksWhenEmpty: boolean },
  current: string | null,
  uninstall: boolean,
  settingsFile: string,
): { ops: SafeEditOp[]; result: StatuslineSurfaceResult } {
  const { key, cmd } = surface
  const mine = current !== null && isOurStatuslineCommand(current)

  if (uninstall) {
    if (!mine) return { ops: [], result: { key, action: 'absent', inner: null } }
    const inner = unwrapStatuslineCommand(current)
    if (inner === null) {
      // Ours by prefix, but the inner command will not parse. Restoring a truncated command would
      // leave a broken status line and deleting the key would destroy the user's configuration —
      // refuse and let a human look, which is recoverable either way.
      throw new Error(
        `refusing: ${key}.command looks like ours but its --inner argument is not parseable, so the `
        + `original cannot be restored safely. Edit ${settingsFile} by hand. Current value: ${current}`
      )
    }
    // A capture-only wrapper wrapped nothing, so there is nothing to restore: remove the key and
    // leave the user exactly as they were before install.
    return inner === ''
      ? { ops: [{ op: 'delete', path: [key] }], result: { key, action: 'removed', inner: null } }
      : { ops: [{ op: 'set', path: [key, 'command'], value: inner }], result: { key, action: 'restored', inner } }
  }

  if (mine) return { ops: [], result: { key, action: 'unchanged', inner: unwrapStatuslineCommand(current) || null } }

  const hasInner = current !== null && current.trim() !== ''
  const wrapped = hasInner ? `${cmd} --inner ${shSingleQuote(current)}` : cmd
  const ops: SafeEditOp[] = [
    // `type` must be present and "command" — set it explicitly so installing onto a settings file
    // that has no such key yet produces a complete, valid object rather than half of one.
    { op: 'set', path: [key, 'type'], value: 'command' },
    { op: 'set', path: [key, 'command'], value: wrapped },
  ]
  return { ops, result: { key, action: hasInner ? 'wrapped' : 'capture-only', inner: hasInner ? current : null } }
}

/** Install (or remove) the status-line capture wrappers via the verified transaction engine.
 *
 *  BOTH surfaces are handled: `statusLine` (the session's own line — rate-limit windows, context
 *  window, harness cost, prompt_id) and `subagentStatusLine` (the ONLY published source of
 *  per-subagent tokenCount / contextWindowSize / effort / cwd). One transaction, so the settings
 *  file is never left with one surface wired and the other not.
 *
 *  Only each key's `command` (and `type`) is touched, so `refreshInterval`, `padding` and
 *  `hideVimModeIndicator` survive untouched. Idempotent: an already-wrapped command is left alone
 *  rather than double-wrapped. */
export async function installStatusline(uninstall: boolean, opts: InstallStatuslineOptions = {}): Promise<InstallStatuslineResult> {
  const settingsFile = opts.settingsPath ?? claudeSettingsPath()
  const log = opts.log ?? ((line: string) => console.log(line))

  if (!uninstall && !resolveOnPath(CLI_BIN, opts.pathEnv)) {
    throw new Error(
      `refusing: '${CLI_BIN}' is not on PATH — a status line registered as '${STATUSLINE_CMD}' would produce `
      + 'NO output, and Claude Code blanks the status line when its command fails. '
      + 'Install the package first (npm i -g agentlenspro, or npm link from the repo checkout), then re-run.'
    )
  }

  let settings: Record<string, unknown> = {}
  if (fs.existsSync(settingsFile)) {
    // Refuse-unparseable, same stance as safe_config_edit: never "start fresh" over user config.
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown> }
    catch { throw new Error(`refusing: ${settingsFile} is not parseable JSON — fix it before editing the status line`) }
  }

  const ops: SafeEditOp[] = []
  const surfaces: StatuslineSurfaceResult[] = []
  for (const surface of STATUSLINE_SURFACES) {
    const obj = (settings[surface.key] && typeof settings[surface.key] === 'object' && !Array.isArray(settings[surface.key])
      ? settings[surface.key] : null) as Record<string, unknown> | null
    const current = typeof obj?.command === 'string' ? obj.command : null
    const planned = planStatuslineSurface(surface, current, uninstall, settingsFile)
    ops.push(...planned.ops)
    surfaces.push(planned.result)
  }

  if (ops.length === 0) {
    log(uninstall ? 'no agentlens status-line wrapper present — nothing to remove' : 'status-line capture already installed — nothing to change')
    return { changed: false, surfaces, backupPath: null }
  }

  const result = await safeConfigEdit(settingsFile, 'json', ops, { createIfMissing: !uninstall })
  for (const s of surfaces) {
    if (s.action === 'wrapped') log(`${s.key}: wrapped for capture\n  inner: ${s.inner}`)
    else if (s.action === 'capture-only') log(`${s.key}: capture installed (nothing existing to wrap — prints nothing)`)
    else if (s.action === 'restored') log(`${s.key}: restored the original command\n  ${s.inner}`)
    else if (s.action === 'removed') log(`${s.key}: removed (it was capture-only — there was no original to restore)`)
    else if (s.action === 'unchanged') log(`${s.key}: already installed`)
    else log(`${s.key}: no agentlens wrapper present`)
  }
  log(`${settingsFile}: changed=${result.changed}${result.backupPath ? ` backup=${result.backupPath}` : ''} attempts=${result.attempts}`)
  // Unlike hooks, a status-line change needs no session restart: Claude Code re-reads the setting
  // on the next update trigger, so the very next assistant message runs the wrapper.
  log('takes effect on the next status-line refresh — no session restart needed')
  return { changed: result.changed, surfaces, backupPath: result.backupPath }
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
  /** Which shipped skill to install. Default SKILL_NAME. */
  name?: string
}

export const SKILL_NAME = 'agentlenspro-diagnostics'

/** Every skill this package ships and installs into the user scope. SKILL_NAME stays the anchor
 *  findPackageRoot probes for (it has always been present, so the probe keeps working on any
 *  older layout); this list is what `--install-skill` and setup's drift check iterate. Adding a
 *  skill directory without adding it here would ship it in the tarball and never install it. */
export const SKILL_NAMES: readonly string[] = [
  SKILL_NAME, 'agentlenspro-cache-guard', 'agentlenspro-visualize-context',
]

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
  const name = opts.name ?? SKILL_NAME
  const root = opts.repoRoot ?? findPackageRoot(__dirname)
  // Names the ANCHOR, not `name`: findPackageRoot probes for SKILL_NAME specifically, so a failure
  // here means that anchor was not found — saying "no skills/<the-skill-being-installed>" would send
  // the reader looking for the wrong missing file.
  if (!root) throw new Error(`skill source missing — no skills/${SKILL_NAME}/SKILL.md (the package-root anchor) above ${__dirname}; wanted to install "${name}"`)
  const src = path.join(root, 'skills', name, 'SKILL.md')
  if (!fs.existsSync(src)) throw new Error(`skill source missing at ${src} — is the package intact?`)
  const dst = path.join(opts.skillsDir ?? path.join(os.homedir(), '.claude', 'skills'), name, 'SKILL.md')
  const content = fs.readFileSync(src, 'utf8')
  const existed = fs.existsSync(dst)
  if (existed && fs.readFileSync(dst, 'utf8') === content) {
    log(`skill ${name}: already current (${dst})`)
    return 'current'
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, content)
  log(`skill ${name}: ${existed ? 'updated' : 'installed'} -> ${dst}`)
  return existed ? 'updated' : 'installed'
}

/** Install EVERY shipped skill. One failure must not silently skip the rest — a partially
 *  installed skill set is the state that produces "I ran --install-skill and the guard still
 *  isn't there" — so each is attempted and the errors are collected and rethrown together. */
export function installSkills(opts: InstallSkillOptions = {}): Array<{ name: string; outcome: string }> {
  const results: Array<{ name: string; outcome: string }> = []
  const failures: string[] = []
  for (const name of SKILL_NAMES) {
    try {
      results.push({ name, outcome: installSkill({ ...opts, name }) })
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`)
    }
  }
  if (failures.length > 0) throw new Error(`skill install failed — ${failures.join('; ')}`)
  return results
}
