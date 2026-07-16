/**
 * Reversible install/uninstall of Claude Code's full-telemetry env into
 * ~/.claude/settings.json (TRDD-M36W16L0).
 *
 * AgentLens needs Claude Code to emit the FULL telemetry firehose (traces + logs +
 * metrics + raw API bodies) to the local OTLP collector. Those switches live in the
 * `env` block of ~/.claude/settings.json. This module owns writing them SAFELY:
 *
 *   - It merges ONLY the AgentLens-owned keys — every unrelated key/formatting is preserved.
 *   - Before it writes, it records — in a marker at ~/.agentlens/telemetry-managed.json —
 *     the TRUE prior state of each key (absent, or present-with-what-value). `removeTelemetryConfig`
 *     uses that record to restore the user's settings EXACTLY (delete what we added, re-set
 *     what we overrode), so uninstall is byte-identical (structurally) to before install.
 *   - Writes are ATOMIC (temp file + rename) with a timestamped backup, and it FAILS FAST
 *     on an unparseable settings.json rather than clobbering a file it cannot read.
 *
 * All paths + the OTLP port are overridable via the options object so the unit tests can
 * drive it entirely against fixture files in a temp dir (the real ~/.claude/settings.json
 * is never touched by the test suite).
 */

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { safeConfigEdit, SafeEditOp } from './safeConfigEdit'
import { rawBodyCaptureEnabled, effectiveBodiesDir, RAW_BODIES_KEY } from './captureConfig'

export interface TelemetryConfigOptions {
  /** settings.json to manage. Default: ~/.claude/settings.json */
  settingsPath?: string
  /** managed-keys marker. Default: ~/.agentlens/telemetry-managed.json */
  markerPath?: string
  /** raw-API-body export dir (created on install). Default: ~/.agentlens/otel-bodies */
  bodiesDir?: string
  /** OTLP collector port the endpoint should point at. Default: 4318 */
  otlpPort?: number
  /** AgentLens data dir — where the durable capture knob lives. Default: ~/.agentlens */
  dataDir?: string
  /**
   * Capture raw API bodies? Default: resolved from the durable knob (env > config.json > OFF).
   * Pin it only in tests, or where the caller has already resolved it. When FALSE, ensure() actively
   * DELETES our key from settings.json — see the note there (TRDD-BKF5NZD3).
   */
  captureRawBodies?: boolean
}

/**
 * What one AgentLens-owned key looked like BEFORE AgentLens first managed it.
 * This is the load-bearing record for a byte-identical uninstall.
 */
interface ManagedKeyRecord {
  /** true = the key already existed in env before AgentLens touched it */
  hadKey: boolean
  /** its value then (null iff hadKey === false) */
  priorValue: string | null
}

interface TelemetryMarker {
  version: 1
  managedAt: string
  /** did settings.env exist at all before AgentLens first managed it? */
  envPreexisting: boolean
  keys: Record<string, ManagedKeyRecord>
}

export interface EnsureResult {
  changed: boolean
  added: string[]
  overrode: string[]
  /** Owned keys DELETED because the user opted out of them (today: raw-body capture). */
  removed: string[]
  settingsPath: string
  markerPath: string
  bodiesDir: string
  backupPath?: string
}

export interface RemoveResult {
  changed: boolean
  restored: string[]
  deleted: string[]
  settingsPath: string
  backupPath?: string
}

export type KeyStatus = 'managed' | 'user' | 'absent'
export interface StatusResult {
  settingsPath: string
  installed: boolean
  keys: Array<{ key: string; status: KeyStatus; value: string | null }>
}

function resolveOptions(options: TelemetryConfigOptions): {
  settingsPath: string; markerPath: string; bodiesDir: string; otlpPort: number; captureRawBodies: boolean
} {
  const home = os.homedir()
  const dataDir = options.dataDir ?? path.join(home, '.agentlens')
  // Resolved from the durable knob (env > config.json > OFF) unless the caller pins it. This is
  // the whole point of TRDD-BKF5NZD3: capture is a DECISION, not wiring we force-converge.
  const captureRawBodies = options.captureRawBodies ?? rawBodyCaptureEnabled(dataDir, process.env)
  return {
    settingsPath: options.settingsPath ?? path.join(home, '.claude', 'settings.json'),
    markerPath:   options.markerPath   ?? path.join(home, '.agentlens', 'telemetry-managed.json'),
    // Default through the ONE bodies-dir resolution (spool when capture is on) — a legacy-only
    // default here made every spool-blind caller (server boot, --install-otel) overwrite the CLI's
    // spool value on the next converge, re-pointing Claude Code's write firehose at the SSD.
    bodiesDir:    options.bodiesDir    ?? effectiveBodiesDir(dataDir, captureRawBodies),
    otlpPort:     options.otlpPort     ?? 4318,
    captureRawBodies,
  }
}

/**
 * The exact set of env keys AgentLens manages to enable Claude Code's FULL telemetry.
 * Cross-checked against the reference full-telemetry config the user configured by hand
 * this session (TRDD-M36W16L0 STATE). Every value is a string — settings.json env values
 * are strings, and Claude Code reads these as env vars.
 *
 * Everything here is cheap, idempotent WIRING (where to send, in what format, how often) — which is
 * why force-converging it on every server boot is correct. `OTEL_LOG_RAW_API_BODIES` is the ONE
 * exception: it is a capture policy costing ~35 GB/day (Claude Code re-serializes the whole
 * conversation to disk on every request), so it is owned ONLY when the user opted in. While it was
 * owned unconditionally, deleting it from settings.json was futile — the next server boot put it
 * back (TRDD-BKF5NZD3).
 */
function ownedKeys(bodiesDir: string, otlpPort: number, captureRawBodies: boolean): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY:                      '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA:               '1',
    OTEL_EXPORTER_OTLP_ENDPOINT:                       `http://localhost:${otlpPort}`,
    OTEL_EXPORTER_OTLP_PROTOCOL:                       'http/json',
    OTEL_TRACES_EXPORTER:                              'otlp',
    OTEL_LOGS_EXPORTER:                                'otlp',
    OTEL_METRICS_EXPORTER:                             'otlp',
    OTEL_LOGS_EXPORT_INTERVAL:                         '5000',
    OTEL_METRIC_EXPORT_INTERVAL:                       '10000',
    OTEL_TRACES_EXPORT_INTERVAL:                       '1000',
    OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta',
    OTEL_LOG_USER_PROMPTS:                             '1',
    OTEL_LOG_TOOL_DETAILS:                             '1',
    OTEL_LOG_TOOL_CONTENT:                             '1',
    OTEL_LOG_ASSISTANT_RESPONSES:                      '1',
    ...(captureRawBodies ? { [RAW_BODIES_KEY]: `file:${bodiesDir}` } : {}),
    OTEL_METRICS_INCLUDE_SESSION_ID:                   'true',
    OTEL_METRICS_INCLUDE_VERSION:                      'true',
    OTEL_METRICS_INCLUDE_ENTRYPOINT:                   'true',
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID:                 'true',
  }
}

/** The expected key→value telemetry env table for a given bodies dir / OTLP port. Exported
 *  for `agentlenspro setup`, whose VERIFY step must compare the settings file against the
 *  expected values through a path independent of the writer (falsify-the-layer discipline) —
 *  re-exporting the ONE table keeps setup from growing a drift-prone copy. `captureRawBodies` is
 *  REQUIRED (not defaulted) so a caller cannot accidentally verify against a table that demands a
 *  key the user opted out of — verify must expect exactly what ensure writes. */
export function ownedTelemetryKeys(bodiesDir: string, otlpPort: number, captureRawBodies: boolean): Record<string, string> {
  return ownedKeys(bodiesDir, otlpPort, captureRawBodies)
}

/**
 * Atomic JSON write: write a temp sibling then rename over the target. rename(2) is atomic on
 * the same filesystem, so a crash mid-write can never leave a half-written file.
 * ONLY used for the AgentLens-owned marker file — every USER config file (settings.json,
 * config.toml, VS Code settings) must go through safeConfigEdit (the transactional editor).
 */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  await fs.rename(tmp, filePath)
}

/**
 * Read settings.json. Returns an empty object when the file is ABSENT (a fresh install),
 * but THROWS when the file exists yet is unparseable — we must never overwrite a settings
 * file we cannot read (fail-fast; a silent "start fresh" would destroy every user setting).
 */
async function readSettingsOrThrow(settingsPath: string): Promise<{ settings: Record<string, unknown>; raw: string | null }> {
  let raw: string
  try {
    raw = await fs.readFile(settingsPath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: {}, raw: null }
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Refusing to modify ${settingsPath}: it exists but is not valid JSON (${(e as Error).message}). Fix or remove the file, then retry.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Refusing to modify ${settingsPath}: top-level JSON is not an object.`)
  }
  return { settings: parsed as Record<string, unknown>, raw }
}

function extractEnv(settings: Record<string, unknown>, settingsPath: string): { env: Record<string, string>; envPreexisting: boolean } {
  const rawEnv = settings.env
  if (rawEnv === undefined) return { env: {}, envPreexisting: false }
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error(`Refusing to modify ${settingsPath}: "env" is present but not a JSON object.`)
  }
  return { env: rawEnv as Record<string, string>, envPreexisting: true }
}

/**
 * Read the marker. THROWS on a corrupt marker: if we cannot read what the prior values were,
 * we must not guess on uninstall and risk deleting keys the user actually owns.
 */
async function readMarker(markerPath: string): Promise<TelemetryMarker | null> {
  let raw: string
  try {
    raw = await fs.readFile(markerPath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`AgentLens telemetry marker at ${markerPath} is corrupt (${(e as Error).message}).`)
  }
  const m = parsed as Partial<TelemetryMarker>
  if (typeof m !== 'object' || m === null || typeof m.keys !== 'object' || m.keys === null) {
    throw new Error(`AgentLens telemetry marker at ${markerPath} is malformed (missing "keys").`)
  }
  return parsed as TelemetryMarker
}

/**
 * Install/refresh the full-telemetry env. Idempotent: re-running when everything is already
 * in place changes nothing. Records the true prior state ONCE (first time a key is managed)
 * so a later uninstall can restore it exactly.
 */
export async function ensureTelemetryConfig(options: TelemetryConfigOptions = {}): Promise<EnsureResult> {
  const { settingsPath, markerPath, bodiesDir, otlpPort, captureRawBodies } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort, captureRawBodies)

  const { settings } = await readSettingsOrThrow(settingsPath)
  const { env, envPreexisting } = extractEnv(settings, settingsPath)
  const existingMarker = await readMarker(markerPath)

  // Keep any prior-state records from an earlier install untouched — the FIRST record of a
  // key is the only truthful one. Overwriting it with the now-installed value would make
  // uninstall restore AgentLens's own value instead of the user's original.
  const markerKeys: Record<string, ManagedKeyRecord> = { ...(existingMarker?.keys ?? {}) }
  const added: string[] = []
  const overrode: string[] = []
  const removed: string[] = []
  let changed = false

  const ops: SafeEditOp[] = []
  for (const [key, value] of Object.entries(owned)) {
    if (!(key in markerKeys)) {
      const hadKey = Object.prototype.hasOwnProperty.call(env, key)
      markerKeys[key] = { hadKey, priorValue: hadKey ? String(env[key]) : null }
      if (!hadKey) added.push(key)
      else if (String(env[key]) !== value) overrode.push(key)
    }
    if (env[key] !== value) { ops.push({ op: 'set', path: ['env', key], value }); changed = true }
  }

  // Capture OFF must ACTIVELY DELETE the key, not merely stop owning it. Dropping it from `owned`
  // is NOT enough: the loop above only touches owned keys, so a key already in settings.json would
  // sit there forever and Claude Code would keep dumping every conversation to disk. This delete is
  // what makes "off" mean off (TRDD-BKF5NZD3).
  //
  // Guard: delete ONLY the value WE would have written (`file:${bodiesDir}`). A user who points the
  // sink at their own directory made that choice deliberately and owns its cost — silently deleting
  // a config we never wrote would be the same overreach that force-converging was.
  if (!captureRawBodies && env[RAW_BODIES_KEY] === `file:${bodiesDir}`) {
    ops.push({ op: 'delete', path: ['env', RAW_BODIES_KEY] })
    removed.push(RAW_BODIES_KEY)
    changed = true
  }

  const marker: TelemetryMarker = {
    version: 1,
    managedAt: existingMarker?.managedAt ?? new Date().toISOString(),
    envPreexisting: existingMarker?.envPreexisting ?? envPreexisting,
    keys: markerKeys,
  }
  const markerChanged = JSON.stringify(existingMarker) !== JSON.stringify(marker)

  // The raw-body export dir must exist before Claude Code writes into it — cheap + idempotent.
  await fs.mkdir(bodiesDir, { recursive: true })

  let backupPath: string | undefined
  if (changed) {
    // ALL settings.json mutations go through the transactional editor
    // (scripts/safe_config_edit.py): its verify-diff proves only the declared
    // ["env", <key>] paths change, its backup is atomic + timestamped, a cross-process
    // lock serializes concurrent instances, and an existing-but-unparseable file is
    // REFUSED (never rebuilt) — the 2026-07-07 settings.json wipe class is
    // structurally impossible on this path.
    const result = await safeConfigEdit(settingsPath, 'json', ops, { createIfMissing: true })
    backupPath = result.backupPath ?? undefined
  }
  // Write the marker whenever it changed — even if env values didn't (e.g. the user already
  // had every key at our value): uninstall still needs the prior-state record to leave them.
  if (changed || markerChanged) {
    await atomicWriteJson(markerPath, marker)
  }

  return { changed, added, overrode, removed, settingsPath, markerPath, bodiesDir, backupPath }
}

/**
 * Uninstall: restore settings.json to its pre-install state using the marker, then remove the
 * marker. Idempotent: with no marker there is nothing to undo. Never touches non-owned keys.
 */
export async function removeTelemetryConfig(options: TelemetryConfigOptions = {}): Promise<RemoveResult> {
  const { settingsPath, markerPath, captureRawBodies } = resolveOptions(options)
  const marker = await readMarker(markerPath)
  if (!marker) return { changed: false, restored: [], deleted: [], settingsPath }

  let settingsRaw: string
  try {
    settingsRaw = await fs.readFile(settingsPath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // settings.json is gone — nothing to restore into. Drop the now-orphaned marker.
      await fs.rm(markerPath, { force: true })
      return { changed: false, restored: [], deleted: [], settingsPath }
    }
    throw e
  }
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(settingsRaw)
  } catch (e) {
    throw new Error(`Refusing to modify ${settingsPath}: it exists but is not valid JSON (${(e as Error).message}). Fix or remove the file, then retry.`)
  }
  const { env } = extractEnv(settings as Record<string, unknown>, settingsPath)

  const restored: string[] = []
  const deleted: string[] = []
  const finalEnv: Record<string, string> = { ...env }
  const ops: SafeEditOp[] = []
  for (const [key, rec] of Object.entries(marker.keys)) {
    // "Uninstall = restore prior state" is the right contract for WIRING — but not for raw-body
    // capture the user has switched OFF. On this machine the marker truthfully records
    // hadKey:true (the key predated AgentLens), so a faithful restore would put the ~35 GB/day sink
    // BACK and Claude Code would resume dumping every conversation to disk — an uninstall that makes
    // the burn worse. Capture-off is an explicit intent that must outlive the removal of our wiring,
    // so we delete rather than restore. Turning capture back on re-installs it (TRDD-BKF5NZD3).
    if (key === RAW_BODIES_KEY && !captureRawBodies) {
      if (key in finalEnv) { ops.push({ op: 'delete', path: ['env', key] }); delete finalEnv[key] }
      deleted.push(key)
      continue
    }
    if (rec.hadKey && rec.priorValue !== null) {
      if (finalEnv[key] !== rec.priorValue) ops.push({ op: 'set', path: ['env', key], value: rec.priorValue })
      finalEnv[key] = rec.priorValue // re-set exactly what the user had
      restored.push(key)
    } else {
      if (key in finalEnv) { ops.push({ op: 'delete', path: ['env', key] }); delete finalEnv[key] }
      deleted.push(key)
    }
  }

  // If AgentLens created the env object and restoring emptied it, drop the whole env key so
  // the file returns to its prior shape (no stray empty "env": {}). Safe as ONE delete op:
  // finalEnv being empty proves every remaining env key was marker-managed and outbound anyway.
  const dropEnv = !marker.envPreexisting && Object.keys(finalEnv).length === 0
  const effectiveOps: SafeEditOp[] = dropEnv ? [{ op: 'delete', path: ['env'] }] : ops

  // The uninstall write goes through the same transactional editor as the install —
  // verify-diff proves only the marker-recorded keys are touched, so a corrupt marker or a
  // restore bug can never take user keys with it.
  let backupPath: string | undefined
  if (effectiveOps.length > 0) {
    const result = await safeConfigEdit(settingsPath, 'json', effectiveOps)
    backupPath = result.backupPath ?? undefined
  }
  await fs.rm(markerPath, { force: true })

  return { changed: effectiveOps.length > 0, restored, deleted, settingsPath, backupPath }
}

/** Per-key install status for `agentlens telemetry status`. Tolerates a corrupt marker. */
export async function telemetryConfigStatus(options: TelemetryConfigOptions = {}): Promise<StatusResult> {
  const { settingsPath, markerPath, bodiesDir, otlpPort, captureRawBodies } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort, captureRawBodies)
  const { settings } = await readSettingsOrThrow(settingsPath)
  const env = (typeof settings.env === 'object' && settings.env !== null && !Array.isArray(settings.env))
    ? settings.env as Record<string, string>
    : {}
  const marker = await readMarker(markerPath).catch(() => null)
  const managed = new Set(Object.keys(marker?.keys ?? {}))

  const keys = Object.keys(owned).map(key => {
    const present = Object.prototype.hasOwnProperty.call(env, key)
    const status: KeyStatus = !present ? 'absent' : managed.has(key) ? 'managed' : 'user'
    return { key, status, value: present ? String(env[key]) : null }
  })
  return { settingsPath, installed: marker !== null, keys }
}

/**
 * CLI dispatcher for `agentlens telemetry <install|uninstall|status>`. Returns a process
 * exit code (0 ok, 1 error, 2 usage). Errors (including a refused unparseable settings.json)
 * surface non-zero so the user sees the failure instead of a silent no-op.
 */
export async function runTelemetryCli(args: string[]): Promise<number> {
  const sub = args[0]
  const otlpPort = process.env.OTLP_PORT ? parseInt(process.env.OTLP_PORT, 10) : 4318
  try {
    if (sub === 'install') {
      const r = await ensureTelemetryConfig({ otlpPort })
      if (r.changed) {
        console.log(`AgentLens telemetry installed → ${r.settingsPath}`)
        console.log(`  added:    ${r.added.length ? r.added.join(', ') : '(none)'}`)
        console.log(`  overrode: ${r.overrode.length ? r.overrode.join(', ') : '(none)'}`)
        if (r.backupPath) console.log(`  backup:   ${r.backupPath}`)
        console.log('⚠ Restart your Claude Code sessions for telemetry to take effect.')
      } else {
        console.log('AgentLens telemetry already in place — nothing to change.')
      }
      return 0
    }
    if (sub === 'uninstall') {
      const r = await removeTelemetryConfig({ otlpPort })
      if (r.changed) {
        console.log(`AgentLens telemetry uninstalled → ${r.settingsPath}`)
        console.log(`  restored: ${r.restored.length ? r.restored.join(', ') : '(none)'}`)
        console.log(`  deleted:  ${r.deleted.length ? r.deleted.join(', ') : '(none)'}`)
        if (r.backupPath) console.log(`  backup:   ${r.backupPath}`)
        console.log('⚠ Restart your Claude Code sessions for the change to take effect.')
      } else {
        console.log('AgentLens telemetry was not installed — nothing to remove.')
      }
      return 0
    }
    if (sub === 'status') {
      const r = await telemetryConfigStatus({ otlpPort })
      console.log(`AgentLens telemetry status: ${r.installed ? 'INSTALLED' : 'not installed'} — ${r.settingsPath}`)
      for (const k of r.keys) {
        console.log(`  ${k.status.padEnd(8)} ${k.key}${k.value !== null ? ` = ${k.value}` : ''}`)
      }
      return 0
    }
    console.error(`Unknown telemetry subcommand: ${sub ?? '(none)'}`)
    console.error('Usage: agentlens telemetry <install|uninstall|status>')
    return 2
  } catch (e) {
    console.error(`[AgentLens] telemetry ${sub ?? ''} failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

const AGENTLENS_HOOK_MARKER = '.agentlens/pending-prompt.txt'
// The trailing `exit 0` is load-bearing: without it, `[ -f "$f" ] && …` makes the hook exit 1
// on every turn where no prompt is pending (i.e. almost always), and Claude Code shows a
// "Stop hook error" banner each time. A missing pending-prompt file is the normal case, not
// an error. (Found in the field 2026-07-10 as one of the user's recurring hook errors.)
const AGENTLENS_HOOK_COMMAND =
  'f=$HOME/.agentlens/pending-prompt.txt; [ -f "$f" ] && cat "$f" && rm "$f"; exit 0'

/**
 * Idempotently install the AgentLens automation Stop hook (standalone prompt injection).
 * Lives here — next to the telemetry env manager — so ~/.claude/settings.json has exactly
 * ONE owning module, and writes through the transactional editor: append_unique keys on the
 * hook's marker substring (re-runs never duplicate the entry), verify-diff proves no other
 * hook or setting is touched, and a corrupt settings.json is refused, never rebuilt.
 * (Replaces the deleted autoConfigureClaudeCode, whose parse-failure "start fresh" path
 * wiped a user's whole settings.json on 2026-07-07.)
 */
export async function ensureAgentLensStopHook(options: TelemetryConfigOptions = {}): Promise<{ changed: boolean }> {
  const { settingsPath } = resolveOptions(options)
  const result = await safeConfigEdit(settingsPath, 'json', [{
    op: 'append_unique',
    path: ['hooks', 'Stop'],
    value: { matcher: '', hooks: [{ type: 'command', command: AGENTLENS_HOOK_COMMAND }] },
    unique_by_substring: AGENTLENS_HOOK_MARKER,
  }], { createIfMissing: true })
  return { changed: result.changed }
}
