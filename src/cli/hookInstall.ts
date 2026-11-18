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
import { SurfaceVerdict, compareStampVersions, isStampVersion, readSurfaceStamp, surfaceVerdict } from './surfaceStamp'
import { packageVersion } from '../packageVersion'

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
  // DirectoryAdded + CwdChanged (Claude Code 2.1.219) — the ONLY two signals that a session's
  // working directory is not what it started as. That matters here more than anywhere: project
  // attribution is keyed on cwd end to end (the agent gate's own-project check, the hard scoping
  // boundary in get_cache_event_log, `--project`), and every one of those silently assumes ONE
  // directory per session. `/add-dir` and `/cd` break that assumption, and nothing else records
  // the moment they do — the transcript keeps the session id, and the OTEL bodies carry no cwd.
  // Both are deliberate user actions, so they are rare, not per-turn: the overhead rule above holds.
  // The three siblings in the same family are deliberately NOT here — FileChanged and MessageDisplay
  // fire constantly (exactly the per-turn cost this list exists to avoid), and InstructionsLoaded
  // duplicates what ctxmap already reads out of the captured request body.
  'DirectoryAdded', 'CwdChanged',
  // PreModelSwitch + PostModelSwitch (Claude Code 2.1.251) — the AUTHORITATIVE model-switch
  // record. A `/model` switch is an unconditional whole-prefix invalidator, and the transcript
  // only shows the USER-typed ones: the automatic switches (safety-classifier fallback, opusplan
  // plan-mode toggles, gateway-forced fallbacks) invalidate the cache with NO transcript trace,
  // and until these events existed they were exactly the "full cold write with no named cause"
  // hole in cache-break attribution. Rare, deliberate-or-exceptional moments → the per-turn
  // overhead rule above holds. Post is the record that a switch HAPPENED; Pre also carries the
  // blocked/confirmed cases, which distinguish "a switch was attempted" from "the model changed".
  'PreModelSwitch', 'PostModelSwitch',
]

// The burn gate (TRDD-GOD0108C) is the ONE narrow exception to the no-PreToolUse rule: it is
// MATCHED to agent-launch tools only (rare calls, the exact moments token disasters start),
// and it must be SYNC (async hooks cannot deny) with a hard HOOK_TIMEOUT_SEC timeout so a dead
// server never stalls a turn. SendMessage joined the matcher in P6: resuming a DEAD agent re-runs
// the request that killed it, so the server gates it — but ONLY on cache-thrash / cold-resume.
//
// `Read` (2026-07-28) is the ONE non-rare tool in the matcher, and it is here only for the image
// cache-guard, which warns when an image would become RESIDENT in an already-fat session. Its cost
// is bounded on the CLI side, not by the matcher: runGateCheck answers a Read locally (one JSON
// parse, no network) unless the path is actually an image — so the overwhelmingly common
// read-a-source-file case never reaches the server. Silence it alone with
// AGENTLENS_CACHE_GUARD=off, which leaves the agent-launch gate armed.
export const GATE_MATCHER = '^(Task|Agent|Workflow|SendMessage|Read)$'
export const GATE_EVENTS = ['PreToolUse', 'PostToolUse']

// The adversarial-review gate (ai-review-gate-cli-verb): SYNC, like the burn gate, because an
// async hook cannot deny. Registered on Stop/SubagentStop ALONGSIDE the async lifecycle
// forwarder those two already carry (HOOK_EVENTS above) — two independent matcher entries on the
// same event, exactly like PreToolUse carries the gate matcher beside any foreign tool's hooks.
export const REVIEW_EVENTS = ['Stop', 'SubagentStop']

// The delegate gate (Fable plans, Sonnet executes — owner order 2026-09-10): SYNC, like the
// burn gate, because an async hook cannot deny. Matched to the edit/write tools only — no
// network round trip, so unlike the burn gate a dead server can never stall it.
export const DELEGATE_MATCHER = '^(Edit|Write|NotebookEdit|MultiEdit|Bash)$'
export const DELEGATE_EVENTS = ['PreToolUse']

/** The ONE published bin (package.json "bin") — what must resolve on PATH. */
export const CLI_BIN = 'agentlenspro'
/** v2 registration command strings (shell command strings; args are valid in hook commands). */
export const HOOK_CMD = 'agentlenspro hook'
export const GATE_CMD = 'agentlenspro gate'
export const REVIEW_CMD = 'agentlenspro review-gate'
export const DELEGATE_CMD = 'agentlenspro delegate-gate'
// The METAHOOK over the review gate. UserPromptSubmit deliberately — a DIFFERENT event from the
// gate's Stop, so a gate that has stopped firing is exactly what this still detects. It only
// reports (never blocks), so it is registered unconditionally alongside the gate.
export const SUPERVISOR_CMD = 'agentlenspro review-supervisor'
// Stop is deliberate and load-bearing: on 2026-09-03 a whole session ran unreviewed and the AGENT
// never noticed, because nothing told it at the moment it was finishing. A UserPromptSubmit-only
// supervisor warns the USER, which is worthless while the user is away.
//
// IT NEVER BLOCKS, ON EITHER EVENT (owner, 2026-09-03: "the supervisor must not block anything.
// only reporting to the claude agent that the per-turn review are not happening"). It reports on
// two channels and exits 0 — `systemMessage` for the user, `hookSpecificOutput.additionalContext`
// for the model, which a NON-blocking Stop hook may emit and the agent still reads. Enforcement is
// the review GATE's job; the supervisor only has to be impossible to silence. This comment said
// "blocks with a reason" until the block was measured gone (exit 0, no `decision` key, even with
// `stop_hook_active: true`) — the third time in this component a comment outlived the behaviour it
// described, so verify against the binary before trusting any claim here.
export const SUPERVISOR_EVENTS = ['UserPromptSubmit', 'Stop']

// EVERY event the installer registers on, as ONE list that the installer and setup's two drift checks
// (hooksConverged, hookDriftList) all read. They were three hand-spelled unions, and the two drift checks
// never learned SUPERVISOR_EVENTS/DELEGATE_EVENTS: with no `UserPromptSubmit` key at all they reported
// "converged", so the supervisor's registration was never repaired — not by a launch, not even by
// `setup`, whose verify then failed on it with nothing able to fix it. A new event family goes HERE.
export const INSTALLED_EVENTS: readonly string[] = [
  ...new Set([...HOOK_EVENTS, ...GATE_EVENTS, ...REVIEW_EVENTS, ...SUPERVISOR_EVENTS, ...DELEGATE_EVENTS]),
]

// EVERY command this generation registers. `isStaleGeneration` is what setup uses to decide an
// entry is a leftover to strip, and it MUST be derived from this set rather than re-spelled as a
// chain of `!==` at each call site. It was three such chains, and when SUPERVISOR_CMD was added
// none of them learned about it — so setup classified the supervisor it had just installed as a
// stale previous-generation entry, failed its own convergence check, and cascaded 9 test failures
// whose messages (missing skill, undefined telemetry env) named everything except the cause.
//
// Adding a command here also feeds GENERATION_NEEDLES below, which was a SECOND hand-maintained
// copy of the same list until it was made to spread this one. That is two consumers, not "every"
// consumer — the sites that name commands individually (setup's per-command verify steps, the
// install log line) still need their own edit, because they say something different about each
// command rather than treating them as a set. Checked by enumerating every reference to the *_CMD
// constants across src/, standalone/ and skills/; do that again rather than trusting this sentence.
/** True when the agentlenspro-review-mod plugin is installed (TRDD-KZCSO0R2). That mod runs the adversarial
 *  review and the measurement ITSELF at every Stop; the review-gate and review-supervisor hooks tell the MODEL
 *  to spawn review forks, so registering both would give the model contradictory orders and double the cost.
 *  Read from Claude Code's own installed-plugins registry; an unreadable registry means not installed. */
export function reviewModInstalled(home: string = os.homedir()): boolean {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> }
    return Object.keys(reg?.plugins ?? {}).some((k) => k.startsWith('agentlenspro-review-mod@'))
  } catch {
    return false
  }
}
export const CURRENT_CMDS: readonly string[] = [HOOK_CMD, GATE_CMD, REVIEW_CMD, SUPERVISOR_CMD, DELEGATE_CMD]
// WHY a version stamp on every hook registration (owner order: a version number in every installed extension, and an out-of-date one is
// overwritten at the first run after an update; TRDD-YL3EWT6N item 5B): without one, an older CLI cannot recognise a newer CLI's registration
// and overwrites it whenever the two versions register different shapes. ONE writer (stampedCommand) and ONE parser (parseOurCommand).
const STAMP_FLAG = ' --stamp '

/** The command string registered for a base command by the CLI of `version`: the base, the stamp flag, the version. */
export function stampedCommand(base: string, version: string): string {
  return base + STAMP_FLAG + version
}

/** A current-generation command split into its base and stamp: a CURRENT_CMDS base exactly (stamp null), or a base followed by the stamp
 *  flag and a version of the stamp shape (isStampVersion). Anything else (legacy bins, a malformed stamp, an extra word, a foreign command)
 *  is null. Never throws: settings.json is user-editable. */
export function parseOurCommand(command: unknown): { base: string; stamp: string | null } | null {
  if (typeof command !== 'string') return null
  if (CURRENT_CMDS.includes(command)) return { base: command, stamp: null }
  for (const base of CURRENT_CMDS) {
    const prefix = base + STAMP_FLAG
    if (!command.startsWith(prefix)) continue
    const version = command.slice(prefix.length)
    return isStampVersion(version) ? { base, stamp: version } : null
  }
  return null
}

export function isStaleGeneration(command: string): boolean {
  return isOurHookCommand(command) && parseOurCommand(command) === null
}
// v1 PATH-bin names — recognised as ours for migration/uninstall, never registered anymore.
export const LEGACY_HOOK_BIN = 'agentlenspro-hook'
export const LEGACY_GATE_BIN = 'agentlenspro-gate'
// The loose user-scope review-gate scripts `agentlenspro review-gate` was written to REPLACE
// (reviewGate.ts header). They were never registered by this installer, so it never removed
// them either — and with both wired to the same event and sharing the same tmp state files, one
// Stop/SubagentStop fire ran the gate TWICE and burned the breakers at double rate
// (MAX_CONSECUTIVE=2 spent after ONE unmet turn; TRDD-6QV50JNN). Recognised as ours for
// migration/uninstall, never registered. ONE needle: `subagent-stop-spawn-review-fork.js` is a
// superstring of `stop-spawn-review-fork.js`, so it matches both scripts (review F3).
export const LEGACY_REVIEW_SCRIPTS = ['stop-spawn-review-fork.js']

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
    || LEGACY_REVIEW_SCRIPTS.some(s => command.includes(s))
    // \b keeps a hypothetical foreign "agentlensprod hookx" from matching; the space
    // between bin and verb is what distinguishes the v2 command-string generation.
    || /\bagentlenspro\s+(hook|gate|review-gate|review-supervisor|delegate-gate)\b/.test(command)
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

// Hook timeout history: 2s/3s at launch → doubled 2026-08-14 (load-avg 130+ starved even an
// 800ms TCP connect) → doubled again 2026-09-05 (TRDD-GXKRBK1Q, USER order "relax the timeouts of
// all hooks.. they must be doubled": at load-avg 16-26 on 14 cores the previous ceilings were still
// being hit) — 10s for the lifecycle/gate/supervisor hooks, 20s for the review gate → ALL raised to
// 30s on 2026-09-08 (USER order): the owner's live settings.json already carried 30 on every entry
// while these builders still emitted 10/20 — the installer and the file disagreed, and which value
// a rebuild would have kept was never measured. ONE constant, ONE number, no per-builder drift. The
// inner network budgets in hookHandlers.ts (AGENTLENS_HOOK_TIMEOUT 2s / AGENTLENS_GATE_TIMEOUT 4s)
// are the child's own deadlines inside this ceiling and did not move. → ALL raised to 120s on
// 2026-10-02 (USER order 'extend the timeouts of all hooks'; owner picked 120): the SYNC hooks
// (gate, review-gate, review-supervisor) can now stall a turn up to 2 min when the server is
// wedged — the inner network budgets in hookHandlers.ts still bound the common path.
export const HOOK_TIMEOUT_SEC = 120

/** The lifecycle forwarder: async, so it cannot block a turn. Every timeout is a silently dropped
 *  capture event plus a warning in the user's terminal; async means the ceiling never delays a
 *  turn, so it can be generous. See HOOK_TIMEOUT_SEC for the history. */
export function lifecycleMatcher(cmd: string): HookMatcher {
  return { hooks: [{ type: 'command', command: cmd, timeout: HOOK_TIMEOUT_SEC, async: true }] }
}

/** The burn gate: SYNC (an async hook cannot deny) and scoped to agent-launch tools only. The
 *  worst-case turn stall only occurs when the server is WEDGED and the call is an agent-launch or
 *  an image Read (runGateCheck answers ordinary Reads locally, no network), so the common path
 *  never pays it; a gate that times out FIRST under load fails open and misses the one disaster it
 *  exists to deny. See HOOK_TIMEOUT_SEC for the history. */
export function gateMatcher(gateCmd: string): HookMatcher {
  return { matcher: GATE_MATCHER, hooks: [{ type: 'command', command: gateCmd, timeout: HOOK_TIMEOUT_SEC }] }
}

/** The adversarial-review gate: SYNC (an async hook cannot deny), no `matcher` field (Stop/
 *  SubagentStop fire unconditionally, unlike PreToolUse/PostToolUse which are tool-scoped). Unlike
 *  the burn gate it makes no network round trip — it reads a local transcript tail (capped at
 *  4MB) — so the ceiling only needs to cover local disk I/O under load, not a possibly-down
 *  server. See HOOK_TIMEOUT_SEC for the history. */
export function reviewGateMatcher(reviewCmd: string): HookMatcher {
  return { hooks: [{ type: 'command', command: reviewCmd, timeout: HOOK_TIMEOUT_SEC }] }
}

export function reviewSupervisorMatcher(cmd: string): HookMatcher {
  return { hooks: [{ type: 'command', command: cmd, timeout: HOOK_TIMEOUT_SEC }] }
}

/** The delegate gate: SYNC (an async hook cannot deny), scoped to the edit/write tools plus Bash.
 *  No network round trip — a local transcript-tail read — so the ceiling only needs to cover
 *  local disk I/O, like the review gate. See HOOK_TIMEOUT_SEC for the history.
 *
 *  UNREFERENCED as of TRDD-SA99VCPZ: registration is deleted (rebuildEventMatchers /
 *  buildEventOps no longer call this), so this builder currently has no callers. Kept, not
 *  deleted, so re-registering the gate when TRDD-SA99VCPZ closes is a one-line change here
 *  rather than a re-write from scratch. Do not assume "unreferenced" means "dead" -- verify
 *  TRDD-SA99VCPZ's status before deleting this function. */
export function delegateGateMatcher(delegateCmd: string): HookMatcher {
  return { matcher: DELEGATE_MATCHER, hooks: [{ type: 'command', command: delegateCmd, timeout: HOOK_TIMEOUT_SEC }] }
}

export function rebuildEventMatchers(
  matchers: HookMatcher[], ev: string, uninstall: boolean, version: string
): RebuildResult {
  // Every command is built from its base and the running version (stampedCommand): the supervisor included, so no entry of ours is unstamped.
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
    out.rebuilt.push(lifecycleMatcher(stampedCommand(HOOK_CMD, version)))
    out.installed = true
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    out.rebuilt.push(gateMatcher(stampedCommand(GATE_CMD, version)))
    out.installed = true
  }
  if (!uninstall && REVIEW_EVENTS.includes(ev) && !reviewModInstalled()) {
    out.rebuilt.push(reviewGateMatcher(stampedCommand(REVIEW_CMD, version)))
    out.installed = true
  }
  if (!uninstall && SUPERVISOR_EVENTS.includes(ev) && !reviewModInstalled()) {
    out.rebuilt.push(reviewSupervisorMatcher(stampedCommand(SUPERVISOR_CMD, version)))
    out.installed = true
  }
  // delegate-gate registration removed until TRDD-SA99VCPZ closes (six accepted review
  // fixes unapplied; an interim delegation-gate hook enforces this rule today).
  return out
}

/** The one verdict on a settings file's hook registrations (item 5B). keep-newer: some entry of ours is stamped newer than the running CLI,
 *  so this CLI writes nothing at all, not even over a stale duplicate beside it: an older CLI never edits a newer CLI's registrations (it
 *  would flip-flop with that CLI on every launch). Otherwise converged when the rebuild with the running version equals the file, else rewrite. */
export type HooksVerdict = { kind: 'converged' } | { kind: 'rewrite' } | { kind: 'keep-newer'; newest: string }

export function hooksVerdict(settings: Record<string, unknown>, running: string): HooksVerdict {
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, HookMatcher[]>
  let newest: string | null = null
  for (const matchers of Object.values(hooks)) {
    for (const m of Array.isArray(matchers) ? matchers : []) {
      for (const h of Array.isArray(m?.hooks) ? m.hooks : []) {
        const stamp = parseOurCommand(h?.command)?.stamp
        if (stamp && compareStampVersions(stamp, running) > 0 && (newest === null || compareStampVersions(stamp, newest) > 0)) newest = stamp
      }
    }
  }
  if (newest !== null) return { kind: 'keep-newer', newest }
  for (const ev of new Set([...Object.keys(hooks), ...INSTALLED_EVENTS])) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    if (JSON.stringify(rebuildEventMatchers(matchers, ev, false, running).rebuilt) !== JSON.stringify(matchers)) return { kind: 'rewrite' }
  }
  return { kind: 'converged' }
}

// ── The strip, expressed as a FILTER instead of a result (TRDD-T0CT9U4X) ────────────────────────
// Every generation this project ever registered, as a plain literal. A needle is matched against
// json.dumps(element) inside the lock, so it must be a literal JSON cannot escape — all of these are.
const GENERATION_NEEDLES = ['spy-agentlens', LEGACY_HOOK_BIN, LEGACY_GATE_BIN, ...LEGACY_REVIEW_SCRIPTS, ...CURRENT_CMDS, 'spyglass-collect.sh']

/** A needle that identifies this command inside the transaction, or null when none can. The known
 *  generation literals come first (one op removes every entry of that generation); an unrecognised
 *  shape — `isOurHookCommand`'s matcher is a REGEX, so `agentlenspro<TAB>hook` is ours while
 *  containing no literal — falls back to its own text, but ONLY when JSON would not escape it. */
function removalNeedle(command: string): string | null {
  const known = GENERATION_NEEDLES.find(n => command.includes(n))
  if (known) return known
  // The class MUST be spelled with escapes, never the literal bytes. Written raw, the 0x00 made
  // file(1) report this whole file as "data", and ugrep then classified it binary and printed
  // NOTHING for every search — exit 1, empty stdout, EMPTY stderr, indistinguishable from "no
  // matches". Every code sweep over these 594 lines silently measured nothing (TRDD-M8SV6LK5).
  // Escaped it is identical to the regex engine (verified over all 256 byte values) and, as a
  // bonus, no longer trips no-control-regex — which is why there is no eslint-disable here.
  return /["\\\x00-\x1f]/.test(command) ? null : command
}

/** The ops for ONE event. Exported because the TOCTOU property is a property of the OP LIST, not of
 *  a file: the ops are computed from a pre-lock read and applied to whatever the file holds at
 *  commit time, so the test applies them to a tree carrying an entry they never saw. */
export function buildEventOps(
  ev: string, matchers: HookMatcher[], uninstall: boolean, version: string
): SafeEditOp[] {
  const r = rebuildEventMatchers(matchers, ev, uninstall, version)
  if (JSON.stringify(r.rebuilt) === JSON.stringify(matchers)) return []

  const ops: SafeEditOp[] = []
  if (r.removedCommands.length > 0) {
    const needles = new Set<string>()
    for (const c of r.removedCommands) {
      // The needles stay the BASE strings (GENERATION_NEEDLES): a stamped command contains its base, so one needle strips the entry of
      // every version (safe_config_edit.py remove_by_substring matches the needle inside the element's JSON).
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
  // append_unique keys on the STAMPED string: the same base at another version is not "already there".
  const cmd = stampedCommand(HOOK_CMD, version)
  const gateCmd = stampedCommand(GATE_CMD, version)
  const reviewCmd = stampedCommand(REVIEW_CMD, version)
  const supervisorCmd = stampedCommand(SUPERVISOR_CMD, version)
  if (!uninstall && HOOK_EVENTS.includes(ev)) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: lifecycleMatcher(cmd), unique_by_substring: cmd })
  }
  if (!uninstall && GATE_EVENTS.includes(ev)) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: gateMatcher(gateCmd), unique_by_substring: gateCmd })
  }
  if (!uninstall && REVIEW_EVENTS.includes(ev) && !reviewModInstalled()) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: reviewGateMatcher(reviewCmd), unique_by_substring: reviewCmd })
  }
  if (!uninstall && SUPERVISOR_EVENTS.includes(ev) && !reviewModInstalled()) {
    ops.push({ op: 'append_unique', path: ['hooks', ev], value: reviewSupervisorMatcher(supervisorCmd), unique_by_substring: supervisorCmd })
  }
  // delegate-gate registration removed until TRDD-SA99VCPZ closes (six accepted review
  // fixes unapplied; an interim delegation-gate hook enforces this rule today).
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
  /** setup and the launch repair pass true: a newer stamp is kept and nothing is written. The explicit `--install-hooks` verb leaves it unset
   *  and rewrites to the running version even over a newer stamp, logging one line that names the stamp it replaced. */
  keepNewer?: boolean
  /** Where the kept-hooks notice is remembered (announceKeptSurfaces); required with keepNewer. */
  dataDir?: string
}

export interface InstallHooksResult {
  changed: boolean
  addedEvents: number
  removedOurs: number
  removedSpyglass: number
  backupPath: string | null
  /** The newest stamp found when keepNewer left a newer registration in place (nothing written), else null. */
  keptNewer: string | null
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

  // The registrations are stamped with the running version; a newer stamp in the file is the verdict first (hooksVerdict): an older CLI never
  // edits a newer CLI's registrations, so setup and the launch repair (keepNewer) write nothing. Only the explicit install verb overrides it.
  const running = packageVersion()
  const verdict = uninstall ? null : hooksVerdict(settings, running)
  if (verdict?.kind === 'keep-newer') {
    if (opts.keepNewer) {
      const kept = keptHooksSurface(settingsFile, verdict.newest, running)
      if (!opts.dataDir) throw new Error('installHooks: keepNewer needs dataDir, the notice store of the kept-hooks announcement')
      announceKeptSurfaces(opts.dataDir, [kept], log)
      return { changed: false, addedEvents: 0, removedOurs: 0, removedSpyglass: 0, backupPath: null, keptNewer: verdict.newest }
    }
    log(`replacing hook registrations stamped ${verdict.newest} with this CLI's ${running} (explicit install)`)
  }

  const ops: SafeEditOp[] = []
  let removedSpyglass = 0
  let removedOurs = 0
  let added = 0
  const events = new Set([...Object.keys(hooks), ...(uninstall ? [] : INSTALLED_EVENTS)])
  for (const ev of events) {
    const matchers = Array.isArray(hooks[ev]) ? hooks[ev] : []
    const r = rebuildEventMatchers(matchers, ev, uninstall, running)
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
    ops.push(...buildEventOps(ev, matchers, uninstall, running))
  }
  // env.SPYGLASS_DIR only feeds the spyglass hook commands — dead once those are removed.
  const env = settings.env as Record<string, unknown> | undefined
  if (!uninstall && env && env.SPYGLASS_DIR !== undefined) {
    ops.push({ op: 'delete', path: ['env', 'SPYGLASS_DIR'] })
  }

  if (ops.length === 0) {
    log(uninstall ? 'no agentlens hooks present — nothing to remove' : 'hooks already installed — nothing to change')
    return { changed: false, addedEvents: 0, removedOurs: 0, removedSpyglass: 0, backupPath: null, keptNewer: null }
  }
  const result = await safeConfigEdit(settingsFile, 'json', ops, { createIfMissing: !uninstall })
  if (uninstall) {
    log(`removed ${removedOurs} agentlens hook entr${removedOurs === 1 ? 'y' : 'ies'} from ${settingsFile}`)
  } else {
    // The supervisor was missing from this line, so the installer's own success message under-reported
    // what it had registered — the kind of gap that makes a later "why is this hook here?" unanswerable.
    log(`installed agentlens hooks on ${added} event(s) in ${settingsFile} (lifecycle forwarder '${HOOK_CMD}' + burn-gate '${GATE_CMD}' on ${GATE_MATCHER} + review gate '${REVIEW_CMD}' on ${REVIEW_EVENTS.join('/')} + review supervisor '${SUPERVISOR_CMD}' on ${SUPERVISOR_EVENTS.join('/')}, warn-only; each stamped ${running})`)
    if (removedSpyglass > 0) log(`removed ${removedSpyglass} dead claude-spyglass hook entr${removedSpyglass === 1 ? 'y' : 'ies'} (+ env.SPYGLASS_DIR)`)
    if (removedOurs > 0) log(`migrated ${removedOurs} previous-generation agentlens entr${removedOurs === 1 ? 'y' : 'ies'}`)
  }
  log(`changed=${result.changed}${result.backupPath ? ` backup=${result.backupPath}` : ''} attempts=${result.attempts}`)
  log('hook registrations load at Claude Code session start (restart sessions once); hook behavior is hot via hook-config.json (agentlenspro --hooks gate=warn|enforce|off) and AGENTLENS_GATE, no restart')
  return { changed: result.changed, addedEvents: added, removedOurs, removedSpyglass, backupPath: result.backupPath, keptNewer: null }
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

/** Is this command string our capture wrapper? A token-boundary test: the base `agentlenspro statusline` followed by the end of the string or a space.
 *  WHY not startsWith (item 8a): a prefix test also accepted `agentlenspro statusline-history x`, which is another verb of this CLI and not a wrapper,
 *  so an install would have refused to wrap it and an uninstall would have rewritten it. */
export function isOurStatuslineCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const c = command.trimStart()
  // A whitespace boundary, not only a space: the old startsWith accepted a capture-only wrapper followed by a newline or a tab, so it must stay ours.
  return c === STATUSLINE_CMD || (c.startsWith(STATUSLINE_CMD) && /\s/.test(c[STATUSLINE_CMD.length]))
}

/** A status line command of ours split into its parts. `inner` is '' for a capture-only wrapper. */
export interface ParsedStatusline {
  subagent: boolean
  stamp: string | null
  inner: string
}

/** ONE parser for every generation of our status line command: the base, an optional `--subagent`, an optional `--stamp V`, then nothing or
 *  `--inner` and ONE single-quoted word that ends the string. A malformed V counts as unstamped (the entry is still read, so it is repaired to a stamp
 *  and not refused). Anything else after the base, a stamp after the inner word, trailing text, an unterminated quote, is null: a partial read
 *  would hand the uninstall or the refresh a truncated command and permanently damage the user's status line. Never throws: settings.json is user-editable. */
export function parseOurStatusline(command: unknown): ParsedStatusline | null {
  if (!isOurStatuslineCommand(command)) return null
  // trim, not trimStart: the old reader trimmed the remainder, so a legacy wrapper with trailing whitespace must still parse and uninstall cleanly.
  let rest = (command as string).trim().slice(STATUSLINE_CMD.length)
  const subagentFlag = ' --subagent'
  const subagent = rest === subagentFlag || rest.startsWith(subagentFlag + ' ')
  if (subagent) rest = rest.slice(subagentFlag.length)
  let stamp: string | null = null
  if (rest.startsWith(STAMP_FLAG)) {
    const m = /^ --stamp (\S+)/.exec(rest)
    if (!m) return null
    stamp = isStampVersion(m[1]) ? m[1] : null
    rest = rest.slice(m[0].length)
  }
  if (rest === '') return { subagent, stamp, inner: '' }
  const innerFlag = ' --inner '
  if (!rest.startsWith(innerFlag)) return null
  const inner = parseSingleQuoted(rest.slice(innerFlag.length))
  return inner === null ? null : { subagent, stamp, inner }
}

/** Recover the command our wrapper was wrapped AROUND. Returns '' for a capture-only wrapper (no
 *  inner command), or null when `command` is not ours / not parseable. */
export function unwrapStatuslineCommand(command: string): string | null {
  return parseOurStatusline(command)?.inner ?? null
}

/** The ONE writer of a status line command: the surface command, the stamp flag and version, then `--inner` and the single-quoted inner command when
 *  there is one. WHY the stamp sits BEFORE `--inner`: parseStatuslineArgs takes the word after `--inner` as the inner command, so a stamp after
 *  it would be read as that command, and a stamp between `--inner` and its word would turn the inner command into capture-only (blank status line). */
export function statuslineCommand(cmd: string, version: string, inner: string): string {
  return cmd + STAMP_FLAG + version + (inner === '' ? '' : ' --inner ' + shSingleQuote(inner))
}

export type StatuslineVerdict =
  | { kind: 'absent' | 'unparseable' }
  | { kind: 'foreign'; command: string }
  | { kind: 'current' | 'older' | 'newer'; parsed: ParsedStatusline }

/** The verdict of the value of one status line settings key against the running version. absent: no command (null or blank). foreign: a command that
 *  is not ours (it gets wrapped). unparseable: ours by its base but the remainder does not parse. Otherwise the stamp against the running version
 *  (compareStampVersions): current (same), older (older, or none or malformed), newer. */
export function statuslineVerdict(current: string | null, running: string): StatuslineVerdict {
  if (current === null || current.trim() === '') return { kind: 'absent' }
  if (!isOurStatuslineCommand(current)) return { kind: 'foreign', command: current }
  const parsed = parseOurStatusline(current)
  if (parsed === null) return { kind: 'unparseable' }
  if (parsed.stamp === null) return { kind: 'older', parsed }
  const c = compareStampVersions(parsed.stamp, running)
  return { kind: c < 0 ? 'older' : c === 0 ? 'current' : 'newer', parsed }
}

export interface InstallStatuslineOptions {
  settingsPath?: string
  pathEnv?: string
  log?: (line: string) => void
  /** The launch repair of 8b: refresh a stale stamp of ours only. A missing key is not created, a foreign command is not wrapped, a newer stamp is
   *  kept (one notice) and an unparseable entry is skipped (one warning). The explicit verb leaves it unset. */
  repairOnly?: boolean
}

export type StatuslineAction = 'wrapped' | 'capture-only' | 'unchanged' | 'refreshed' | 'kept-newer' | 'skipped' | 'restored' | 'removed' | 'absent'

export interface StatuslineSurfaceResult {
  key: string
  action: StatuslineAction
  /** The user's own command we wrapped (install) or restored (uninstall); null when there is none. */
  inner: string | null
  /** The stamp the entry carried before this run (refreshed, kept-newer, unchanged); null when it had none or the action does not read one. */
  stamp: string | null
}

export interface InstallStatuslineResult {
  changed: boolean
  surfaces: StatuslineSurfaceResult[]
  backupPath: string | null
}

/** Plan the ops for ONE status-line surface. Split out from the transaction so the decision table
 *  (create / wrap / refresh the stamp / leave alone / refuse / restore / remove) is testable without touching a settings
 *  file, and so both surfaces provably go through the same rules.
 *
 *  WHY the verdict comes from statuslineVerdict and every written command from statuslineCommand (item 8a): the status line command is a single
 *  string with no room for a second registration, so the stamp is the only way an older CLI can tell a newer CLI's wrapper from a stale one,
 *  and a writer and a reader that disagree on the shape would rewrite a good entry on every run. `running` defaults to the running package version;
 *  `repairOnly` is the launch repair of 8b: it never creates a missing key (that would re-create a status line the user removed on every launch),
 *  never wraps a foreign command, keeps a newer stamp and skips an entry it cannot parse. */
export function planStatuslineSurface(
  surface: { key: string; cmd: string; blanksWhenEmpty: boolean },
  current: string | null,
  uninstall: boolean,
  settingsFile: string,
  running: string = packageVersion(),
  repairOnly = false,
): { ops: SafeEditOp[]; result: StatuslineSurfaceResult } {
  const { key, cmd } = surface

  if (uninstall) {
    const mine = current !== null && isOurStatuslineCommand(current)
    if (!mine) return { ops: [], result: { key, action: 'absent', inner: null, stamp: null } }
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
      ? { ops: [{ op: 'delete', path: [key] }], result: { key, action: 'removed', inner: null, stamp: null } }
      : { ops: [{ op: 'set', path: [key, 'command'], value: inner }], result: { key, action: 'restored', inner, stamp: null } }
  }

  const verdict = statuslineVerdict(current, running)
  // `type` must be present and "command" — set it explicitly so installing onto a settings file
  // that has no such key yet produces a complete, valid object rather than half of one.
  const createOps = (command: string): SafeEditOp[] => [
    { op: 'set', path: [key, 'type'], value: 'command' },
    { op: 'set', path: [key, 'command'], value: command },
  ]
  switch (verdict.kind) {
    case 'absent':
      if (repairOnly) return { ops: [], result: { key, action: 'absent', inner: null, stamp: null } }
      return { ops: createOps(statuslineCommand(cmd, running, '')), result: { key, action: 'capture-only', inner: null, stamp: null } }
    case 'foreign':
      if (repairOnly) return { ops: [], result: { key, action: 'absent', inner: null, stamp: null } }
      return { ops: createOps(statuslineCommand(cmd, running, verdict.command)), result: { key, action: 'wrapped', inner: verdict.command, stamp: null } }
    case 'unparseable':
      // Ours by shape but the remainder does not parse: rewriting it would guess at the user's inner command and could destroy it. The explicit verb
      // refuses BEFORE any op is written (the two keys are one transaction); the launch repair skips this key and still refreshes the other.
      if (repairOnly) return { ops: [], result: { key, action: 'skipped', inner: null, stamp: null } }
      throw new Error(
        `refusing: ${key}.command looks like ours but is not parseable, so it cannot be refreshed safely. `
        + `Edit ${settingsFile} by hand. Current value: ${current}`
      )
    case 'current':
      return { ops: [], result: { key, action: 'unchanged', inner: verdict.parsed.inner || null, stamp: verdict.parsed.stamp } }
    case 'newer':
    case 'older':
      // The explicit verb overwrites a newer stamp too (as --install-hooks does in 5B); only the launch repair keeps it.
      if (verdict.kind === 'newer' && repairOnly) return { ops: [], result: { key, action: 'kept-newer', inner: verdict.parsed.inner || null, stamp: verdict.parsed.stamp } }
      return {
        ops: [{ op: 'set', path: [key, 'command'], value: statuslineCommand(cmd, running, verdict.parsed.inner) }],
        result: { key, action: 'refreshed', inner: verdict.parsed.inner || null, stamp: verdict.parsed.stamp },
      }
  }
}

/** Install (or remove) the status-line capture wrappers via the verified transaction engine.
 *
 *  BOTH surfaces are handled: `statusLine` (the session's own line — rate-limit windows, context
 *  window, harness cost, prompt_id) and `subagentStatusLine` (the ONLY published source of
 *  per-subagent tokenCount / contextWindowSize / effort / cwd). One transaction, so the settings
 *  file is never left with one surface wired and the other not.
 *
 *  Only each key's `command` (and `type`) is touched, so `refreshInterval`, `padding` and
 *  `hideVimModeIndicator` survive untouched. Idempotent: a wrapper stamped with the running version is left alone
 *  rather than double-wrapped. Every written command carries the running version stamp (item 8a): an entry of ours that is unstamped or older is
 *  rewritten to the stamp with its inner text kept byte-identical, and the explicit verb overwrites a NEWER stamp too (as --install-hooks does in
 *  5B). An entry of ours whose remainder does not parse is refused with an error naming its key before anything is written. With `repairOnly`
 *  (the launch repair, 8b) a missing key is never created, a foreign command is never wrapped, a newer stamp is kept with one notice and an
 *  unparseable entry is skipped with one warning. */
export async function installStatusline(uninstall: boolean, opts: InstallStatuslineOptions = {}): Promise<InstallStatuslineResult> {
  const settingsFile = opts.settingsPath ?? claudeSettingsPath()
  const log = opts.log ?? ((line: string) => console.log(line))
  const running = packageVersion()

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
    const planned = planStatuslineSurface(surface, current, uninstall, settingsFile, running, opts.repairOnly === true)
    ops.push(...planned.ops)
    surfaces.push(planned.result)
  }
  // The notices of the two repair outcomes that write nothing for their key come BEFORE the nothing-to-change return: a kept newer stamp or a skipped
  // unparseable entry is exactly the case where ops is empty, and without this line the repair would be silent about it.
  for (const s of surfaces) {
    if (s.action === 'kept-newer') log(`${s.key}: stamped ${s.stamp}, newer than this CLI's ${running} — kept as it is`)
    else if (s.action === 'skipped') log(`${s.key}: warning: the command looks like ours but is not parseable — skipped, edit ${settingsFile} by hand`)
  }

  if (ops.length === 0) {
    log(uninstall ? 'no agentlens status-line wrapper present — nothing to remove'
      : opts.repairOnly ? 'status-line capture: nothing to refresh' : 'status-line capture already installed — nothing to change')
    return { changed: false, surfaces, backupPath: null }
  }

  const result = await safeConfigEdit(settingsFile, 'json', ops, { createIfMissing: !uninstall })
  for (const s of surfaces) {
    if (s.action === 'wrapped') log(`${s.key}: wrapped for capture\n  inner: ${s.inner}`)
    else if (s.action === 'capture-only') log(`${s.key}: capture installed (nothing existing to wrap — prints nothing)`)
    else if (s.action === 'refreshed') log(`${s.key}: refreshed the stamp (was ${s.stamp ?? 'none'}, now ${running}); the inner command is unchanged`)
    else if (s.action === 'restored') log(`${s.key}: restored the original command\n  ${s.inner}`)
    else if (s.action === 'removed') log(`${s.key}: removed (it was capture-only — there was no original to restore)`)
    else if (s.action === 'unchanged') log(`${s.key}: already installed`)
    else if (s.action === 'absent') log(`${s.key}: no agentlens wrapper present`)
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
  /** Target agents dir (installAgents only). Default ~/.claude/agents */
  agentsDir?: string
  log?: (line: string) => void
  /** Which shipped skill to install. Default SKILL_NAME. */
  name?: string
  /** Where a file about to be replaced is copied first (<backupRoot>/<UTC time>-<pid>/agents|skills/...). NO default
   *  on purpose (TRDD-YL3EWT6N item 4): a default taken from the data dir would let a test write into the real one.
   *  Replacing an existing file without it throws. */
  backupRoot?: string
}

export const SKILL_NAME = 'agentlenspro-diagnostics'

/** Every skill this package ships and installs into the user scope. SKILL_NAME stays the anchor
 *  findPackageRoot probes for (it has always been present, so the probe keeps working on any
 *  older layout); this list is what `--install-skill` and setup's drift check iterate. Adding a
 *  skill directory without adding it here would ship it in the tarball and never install it. */
export const SKILL_NAMES: readonly string[] = [
  SKILL_NAME, 'agentlenspro-cache-guard', 'agentlenspro-visualize-context',
  'agentlenspro-scan-and-fix', 'verification-before-completion',
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

/** Every file a skill directory ships, as paths relative to that directory, sorted so two walks
 *  of the same tree compare positionally. `.DS_Store` is excluded because macOS writes one into
 *  any browsed directory and it is not part of the skill. */
export function skillFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue
      const child = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) out.push(child)
    }
  }
  walk('')
  return out.sort()
}

/** One hash over a skill's tree — every listed file's relative path AND bytes. Returns null when
 *  the directory has no SKILL.md (not installed / not shipped).
 *
 *  Hashing only SKILL.md would make setup's drift check blind to exactly the payload that makes
 *  a multi-file skill worth shipping: a changed template or script would read as "current"
 *  forever, and the user would keep running last release's template while setup reported green.
 *
 *  `files` restricts the hash to a given relative-path list: pass `skillFiles(<shipped dir>)` when
 *  hashing an INSTALLED copy. Without it every file found in `dir` is hashed, which is right for the
 *  shipped side and wrong for the installed side: installSkill deliberately leaves unshipped extras
 *  in place (a user's note, a file an older release shipped), so hashing them made installed ≠
 *  shipped FOREVER — every launch re-ran the skill repair, rewrote nothing, failed verify and printed
 *  "could not restore skills". A listed file that is absent (or not a regular file) still differs:
 *  its absence is hashed under a separator (`\x01`) that a present file never uses, so the result
 *  stays a hex digest and still differs from the shipped hash. */
export function skillTreeHash(dir: string, files?: readonly string[]): string | null {
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return null
  const h = crypto.createHash('sha256')
  for (const rel of files ?? skillFiles(dir)) {
    const file = path.join(dir, rel)
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      h.update(rel)
      h.update('\x01')      // a separator no present file uses: an absent file never hashes like a present one
      continue
    }
    h.update(rel)         // a rename with identical bytes is still drift
    h.update('\0')
    h.update(fs.readFileSync(file))
  }
  return h.digest('hex')
}

export interface SurfaceState {
  verdict: SurfaceVerdict
  /** The stamps the verdict was based on; null when the file is absent, unstamped or unreadable. */
  installedStamp: string | null
  shippedStamp: string | null
}

/** A git checkout has a src folder beside the package root; a release tarball never ships one (the `files`
 *  allowlist and check-dist-contents). A checkout is the developer's own tree, so a same-stamp difference there is
 *  a rebuild in progress and the shipped file wins; in a release it is an edit and the installed copy wins. */
export function isCheckoutRoot(root: string): boolean {
  return fs.existsSync(path.join(root, 'src'))
}

function surfaceState(installed: string | null, shipped: string, sameContent: boolean, checkout: boolean): SurfaceState {
  return {
    verdict: surfaceVerdict({ installed, shipped, sameContent, checkout }),
    installedStamp: installed === null ? null : readSurfaceStamp(installed),
    shippedStamp: readSurfaceStamp(shipped),
  }
}

/** The verdict for one shipped agent file against its installed copy. The shipped file must exist. */
export function agentSurfaceState(root: string, agentsDir: string, name: string): SurfaceState {
  const shipped = fs.readFileSync(path.join(root, 'agents', `${name}.md`))
  const dst = path.join(agentsDir, `${name}.md`)
  const installed = fs.existsSync(dst) ? fs.readFileSync(dst) : null
  return surfaceState(installed === null ? null : installed.toString('utf8'), shipped.toString('utf8'), installed !== null && installed.equals(shipped), isCheckoutRoot(root))
}

/** The verdict for one shipped skill tree against its installed tree, read from the two SKILL.md files; the
 *  same-content test is the tree hash over the SHIPPED file list (extras the user added do not count). The shipped
 *  SKILL.md must exist. An installed tree with no SKILL.md reads as absent: it is installed over, file by file. */
export function skillSurfaceState(root: string, skillsDir: string, name: string): SurfaceState {
  const srcDir = path.join(root, 'skills', name)
  const dstDir = path.join(skillsDir, name)
  const dstSkillMd = path.join(dstDir, 'SKILL.md')
  const installed = fs.existsSync(dstSkillMd) ? fs.readFileSync(dstSkillMd, 'utf8') : null
  const same = skillTreeHash(dstDir, skillFiles(srcDir)) === skillTreeHash(srcDir)
  return surfaceState(installed, fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8'), same, isCheckoutRoot(root))
}

// One backup folder per process run and backupRoot, created at the first backup (TRDD-YL3EWT6N item 4).
const backupSessions = new Map<string, string>()

/** Copy `file`, about to be replaced, to <backupRoot>/<UTC time>-<pid>/<rel>. Throws when backupRoot is missing or
 *  the copy fails: the caller writes only after this returns, so a replaced file always has its old bytes kept.
 *  No default backupRoot on purpose: one taken from the data dir would let a test write into the real data dir. */
function backupFile(backupRoot: string | undefined, rel: string, file: string): void {
  if (backupRoot === undefined) throw new Error(`refusing to replace ${file}: no backupRoot given, so its old bytes would be lost`)
  let session = backupSessions.get(backupRoot)
  if (session === undefined) {
    session = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`)
    backupSessions.set(backupRoot, session)
  }
  const target = path.join(session, rel)
  // A second replace of the same file in this run keeps the FIRST copy: the second copy would be the bytes this run wrote.
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(file, target)
}

/** Write `bytes` to `dst` through a temporary file in the same folder and a rename. A write that is torn in place
 *  keeps the stamp line at the top of the file while the rest is half old, half new, and that reads as an edit
 *  (TRDD-YL3EWT6N item 4); a rename leaves either the old file or the whole new one.
 *  When `dst` is a symlink the write goes to the link's TARGET, with the temp file in the target's folder: renaming
 *  over the link itself would replace the link with a file, where the old in-place write kept it. The temp file takes
 *  the existing file's mode before the rename, as the old in-place write kept it too. A temp file left by a killed
 *  process is not cleaned up. */
function writeFileAtomic(dst: string, bytes: Buffer): void {
  let real = dst
  if (fs.lstatSync(dst, { throwIfNoEntry: false }) !== undefined) {
    try {
      real = fs.realpathSync(dst)
    } catch (e) {
// A dangling link: the old in-place write created the link's target, so the target is where the bytes go.
      // One hop only: a chain of links that ends in a dangling one is not followed and its last link would be replaced.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      real = path.resolve(path.dirname(dst), fs.readlinkSync(dst))
    }
  }
  const tmp = `${real}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, bytes)
    if (fs.existsSync(real)) fs.chmodSync(tmp, fs.statSync(real).mode & 0o777)
    fs.renameSync(tmp, real)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* the original error is the one that matters */ }
    throw e
  }
}

/** (Re)install one shipped skill into the user scope. The repo copy is the single source of
 *  truth; ~/.claude/skills/ is a managed installation target. Idempotent by content comparison —
 *  safe to run on every install / update, and the way to recover the skill if it was deleted.
 *  Returns what happened so `setup` can RECORD it.
 *
 *  Copies the skill's WHOLE DIRECTORY, not just SKILL.md: a skill's payload is what makes it
 *  useful — templates, scripts, reference docs, binaries — and a SKILL.md that references a
 *  `templates/` file the installer never copied is a skill that documents a file the user does
 *  not have. The file mode is carried across too, or a shipped executable would install
 *  un-runnable.
 *
 *  Files present at the destination but NOT shipped by this version are LEFT IN PLACE and
 *  reported, never deleted: this function cannot tell a stale file from one the user wrote, and
 *  silently deleting the latter is not a trade an installer gets to make.
 *
 *  One surfaceVerdict (surfaceStamp.ts) covers the whole tree, read from the two SKILL.md files (TRDD-YL3EWT6N
 *  item 4): a skill stamped NEWER than the shipped one, or an edited one with the same stamp in a release, is
 *  not written and returns `kept-newer` / `kept-edited`. Every existing file about to be replaced is copied under
 *  `opts.backupRoot` first, whatever the verdict (so a partial tree keeps its old bytes too); replacing without a
 *  backupRoot throws. The backup is a COPY of the replaced files, never a move of the tree: a move would remove
 *  the files the user added, which this function promises to leave. */
export function installSkill(opts: InstallSkillOptions = {}): 'installed' | 'updated' | 'current' | 'kept-newer' | 'kept-edited' {
  const log = opts.log ?? ((line: string) => console.log(line))
  const name = opts.name ?? SKILL_NAME
  const root = opts.repoRoot ?? findPackageRoot(__dirname)
  // Names the ANCHOR, not `name`: findPackageRoot probes for SKILL_NAME specifically, so a failure
  // here means that anchor was not found — saying "no skills/<the-skill-being-installed>" would send
  // the reader looking for the wrong missing file.
  if (!root) throw new Error(`skill source missing — no skills/${SKILL_NAME}/SKILL.md (the package-root anchor) above ${__dirname}; wanted to install "${name}"`)
  const srcDir = path.join(root, 'skills', name)
  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) throw new Error(`skill source missing at ${path.join(srcDir, 'SKILL.md')} — is the package intact?`)
  const skillsDir = opts.skillsDir ?? path.join(os.homedir(), '.claude', 'skills')
  const dstDir = path.join(skillsDir, name)
  const existed = fs.existsSync(path.join(dstDir, 'SKILL.md'))

  // Asked before any write: a kept skill must not be touched at all, not even its modes.
  const verdict = skillSurfaceState(root, skillsDir, name).verdict
  if (verdict === 'keep-newer' || verdict === 'keep-edited') {
    log(`skill ${name}: ${verdict === 'keep-newer' ? 'installed copy is newer than the shipped one' : 'installed copy was edited'} — left in place at ${dstDir}`)
    return verdict === 'keep-newer' ? 'kept-newer' : 'kept-edited'
  }

  const shipped = skillFiles(srcDir)
  const plan = shipped.map(rel => {
    const src = path.join(srcDir, rel)
    const dst = path.join(dstDir, rel)
    const bytes = fs.readFileSync(src)
    return { rel, src, dst, bytes, mode: fs.statSync(src).mode & 0o777, present: fs.existsSync(dst), same: fs.existsSync(dst) && fs.readFileSync(dst).equals(bytes) }
  })
  // Every backup is taken BEFORE the first write: a failed copy (or a missing backupRoot) throws with the tree untouched.
  for (const p of plan) if (p.present && !p.same) backupFile(opts.backupRoot, path.join('skills', name, p.rel), p.dst)
  let changed = 0
  // SKILL.md goes LAST: it carries the version stamp, and a stamp that reaches disk before the payload would let
  // an install that fails part way read as "same stamp, different content" = an edit, kept forever (TRDD-YL3EWT6N item 4).
  for (const p of [...plan.filter(q => q.rel !== 'SKILL.md'), ...plan.filter(q => q.rel === 'SKILL.md')]) {
    if (!p.same) {
      fs.mkdirSync(path.dirname(p.dst), { recursive: true })
      writeFileAtomic(p.dst, p.bytes)
      changed++
    }
    if ((fs.statSync(p.dst).mode & 0o777) !== p.mode) { fs.chmodSync(p.dst, p.mode); changed++ }
  }

  const extras = fs.existsSync(dstDir) ? skillFiles(dstDir).filter(rel => !shipped.includes(rel)) : []
  if (extras.length > 0) {
    log(`skill ${name}: ${extras.length} file(s) at ${dstDir} are not shipped by this version — left in place: ${extras.slice(0, 5).join(', ')}${extras.length > 5 ? ', …' : ''}`)
  }
  if (changed === 0) {
    log(`skill ${name}: already current (${shipped.length} file(s) at ${dstDir})`)
    return 'current'
  }
  log(`skill ${name}: ${existed ? 'updated' : 'installed'} (${shipped.length} file(s)) -> ${dstDir}`)
  return existed ? 'updated' : 'installed'
}

/** Every agent definition this package ships into `~/.claude/agents/`. A skill can only ask for
 *  a worker by NAME; if the definition is not on the machine the spawn fails, so the agents ride
 *  along with the skills that dispatch them. */
export const AGENT_NAMES: readonly string[] = [
  'agentlens-tldr-worker',
  'lean-worker',
  'micro-worker',
  'cheap-worker',
  'fast-worker',
  'sonnet-worker',
  'smart-worker',
  'js-test-writer',
  'python-test-writer',
]

/** (Re)install the shipped agent definitions at user scope, same discipline as the skills:
 *  content-compared, idempotent, and it NEVER deletes.
 *
 *  Deliberately no "extras" report here, unlike installSkill: `~/.claude/agents/` is a SHARED
 *  directory holding every agent the user has from every source, so listing the files we did not
 *  ship would report the user's own library back to them as debris. We own our names, nothing
 *  else.
 *
 *  An existing file with one of our names is replaced or kept by surfaceVerdict (surfaceStamp.ts), never
 *  by content alone (TRDD-YL3EWT6N item 4): an older or unstamped copy is replaced, a copy stamped NEWER
 *  than the shipped file is kept (outcome `kept-newer`), and an edited copy with the same stamp is kept
 *  in a release (`kept-edited`) and replaced in a git checkout. Every replaced file is copied under
 *  `opts.backupRoot` first; replacing without a backupRoot throws. */
export function installAgents(opts: InstallSkillOptions = {}): Array<{ name: string; outcome: string }> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const root = opts.repoRoot ?? findPackageRoot(__dirname)
  if (!root) throw new Error(`agent source missing — no skills/${SKILL_NAME}/SKILL.md (the package-root anchor) above ${__dirname}`)
  const dstDir = opts.agentsDir ?? path.join(os.homedir(), '.claude', 'agents')
  const results: Array<{ name: string; outcome: string }> = []
  const failures: string[] = []
  for (const name of AGENT_NAMES) {
    try {
      const src = path.join(root, 'agents', `${name}.md`)
      if (!fs.existsSync(src)) throw new Error(`missing at ${src} — is the package intact?`)
      const dst = path.join(dstDir, `${name}.md`)
      const bytes = fs.readFileSync(src)
      const existed = fs.existsSync(dst)
      if (existed && fs.readFileSync(dst).equals(bytes)) {
        results.push({ name, outcome: 'current' })
        continue
      }
      // The verdict is asked only for a file that differs: before item 4 any difference was overwritten, which
      // replaced a NEWER or hand-edited copy with no way back.
      const verdict = agentSurfaceState(root, dstDir, name).verdict
      if (verdict === 'keep-newer' || verdict === 'keep-edited') {
        log(`agent ${name}: ${verdict === 'keep-newer' ? 'installed copy is newer than the shipped file' : 'installed copy was edited'} — left in place at ${dst}`)
        results.push({ name, outcome: verdict === 'keep-newer' ? 'kept-newer' : 'kept-edited' })
        continue
      }
      // Backup BEFORE the write: a failed copy (or a missing backupRoot) throws and the file is not touched.
      if (existed) backupFile(opts.backupRoot, path.join('agents', `${name}.md`), dst)
      fs.mkdirSync(dstDir, { recursive: true })
      writeFileAtomic(dst, bytes)
      log(`agent ${name}: ${existed ? 'updated' : 'installed'} -> ${dst}`)
      results.push({ name, outcome: existed ? 'updated' : 'installed' })
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`)
    }
  }
  if (failures.length > 0) throw new Error(`agent install failed — ${failures.join('; ')}`)
  return results
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

/** One installed skill or agent that the shipped copy did NOT overwrite (TRDD-YL3EWT6N item 4). Its notice store lives in this file and not in
 *  autoSetup.ts because the source guard of autoSetup.test.ts forbids a file write (or JSON.stringify) in autoSetup.ts. */
export interface KeptSurface {
  kind: 'agent' | 'skill' | 'hooks'
  name: string
  verdict: 'keep-newer' | 'keep-edited'
  installedStamp: string | null
  shippedStamp: string | null
  /** The installed file (agent), directory (skill) or settings.json (hooks) the notice names. */
  path: string
}

/** The kept entry for hook registrations stamped newer than the running CLI (item 5B): same notice store, same once-per-pair rule as the
 *  skills and agents of item 4. */
export function keptHooksSurface(settingsFile: string, installed: string, running: string): KeptSurface {
  return { kind: 'hooks', name: 'registrations', verdict: 'keep-newer', installedStamp: installed, shippedStamp: running, path: settingsFile }
}

const KEPT_FILE = 'surface-kept.json'

/** Announce each kept surface ONCE (item 4, P5): the keys already announced are in <dataDir>/surface-kept.json, written atomically
 *  (temporary file in the same folder, then rename). A key is kind, name, installed stamp and shipped stamp, so the notice returns
 *  when either side changes. A failed read or write only makes a notice repeat: it never throws, because a notice must not block a verb. */
export function announceKeptSurfaces(dataDir: string, kept: readonly KeptSurface[], say: (line: string) => void): void {
  if (kept.length === 0) return
  const file = path.join(dataDir, KEPT_FILE)
  let seen: string[] = []
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) seen = parsed.filter((k): k is string => typeof k === 'string')
  } catch { /* absent or unreadable: every notice is new */ }
  const fresh = kept.filter(k => !seen.includes(keptKey(k)))
  if (fresh.length === 0) return
  for (const k of fresh) {
    say(k.kind === 'hooks'
      ? `agentlenspro: hook registrations in ${k.path} are stamped ${k.installedStamp}, newer than this CLI (${k.shippedStamp}), left in place`
      : k.verdict === 'keep-newer'
      ? `agentlenspro: ${k.kind} ${k.name}: the installed copy is version ${k.installedStamp}, newer than the shipped ${k.shippedStamp}, left in place`
      : `agentlenspro: ${k.kind} ${k.name}: the installed copy differs from the shipped file of the same version (${k.installedStamp}), left in place; to restore it delete ${k.path} and run agentlenspro setup`)
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = path.join(dataDir, `${KEPT_FILE}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify([...seen, ...fresh.map(keptKey)]))
    fs.renameSync(tmp, file)
  } catch { /* the notice repeats next launch; never block the verb */ }
}

function keptKey(k: KeptSurface): string {
  return [k.kind, k.name, k.installedStamp ?? '', k.shippedStamp ?? ''].join('|')
}
