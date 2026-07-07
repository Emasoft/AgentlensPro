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

export interface TelemetryConfigOptions {
  /** settings.json to manage. Default: ~/.claude/settings.json */
  settingsPath?: string
  /** managed-keys marker. Default: ~/.agentlens/telemetry-managed.json */
  markerPath?: string
  /** raw-API-body export dir (created on install). Default: ~/.agentlens/otel-bodies */
  bodiesDir?: string
  /** OTLP collector port the endpoint should point at. Default: 4318 */
  otlpPort?: number
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
  settingsPath: string; markerPath: string; bodiesDir: string; otlpPort: number
} {
  const home = os.homedir()
  return {
    settingsPath: options.settingsPath ?? path.join(home, '.claude', 'settings.json'),
    markerPath:   options.markerPath   ?? path.join(home, '.agentlens', 'telemetry-managed.json'),
    bodiesDir:    options.bodiesDir    ?? path.join(home, '.agentlens', 'otel-bodies'),
    otlpPort:     options.otlpPort     ?? 4318,
  }
}

/**
 * The exact set of env keys AgentLens manages to enable Claude Code's FULL telemetry.
 * Cross-checked against the reference full-telemetry config the user configured by hand
 * this session (TRDD-M36W16L0 STATE). Every value is a string — settings.json env values
 * are strings, and Claude Code reads these as env vars.
 */
function ownedKeys(bodiesDir: string, otlpPort: number): Record<string, string> {
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
    OTEL_LOG_RAW_API_BODIES:                           `file:${bodiesDir}`,
    OTEL_METRICS_INCLUDE_SESSION_ID:                   'true',
    OTEL_METRICS_INCLUDE_VERSION:                      'true',
    OTEL_METRICS_INCLUDE_ENTRYPOINT:                   'true',
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID:                 'true',
  }
}

function compactTimestamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
}

/**
 * Atomic JSON write: write a temp sibling then rename over the target. rename(2) is atomic on
 * the same filesystem, so a crash mid-write can never leave a half-written settings.json.
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
  const { settingsPath, markerPath, bodiesDir, otlpPort } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)

  const { settings, raw } = await readSettingsOrThrow(settingsPath)
  const { env, envPreexisting } = extractEnv(settings, settingsPath)
  const existingMarker = await readMarker(markerPath)

  // Keep any prior-state records from an earlier install untouched — the FIRST record of a
  // key is the only truthful one. Overwriting it with the now-installed value would make
  // uninstall restore AgentLens's own value instead of the user's original.
  const markerKeys: Record<string, ManagedKeyRecord> = { ...(existingMarker?.keys ?? {}) }
  const added: string[] = []
  const overrode: string[] = []
  let changed = false

  for (const [key, value] of Object.entries(owned)) {
    if (!(key in markerKeys)) {
      const hadKey = Object.prototype.hasOwnProperty.call(env, key)
      markerKeys[key] = { hadKey, priorValue: hadKey ? String(env[key]) : null }
      if (!hadKey) added.push(key)
      else if (String(env[key]) !== value) overrode.push(key)
    }
    if (env[key] !== value) { env[key] = value; changed = true }
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
    if (raw !== null) {
      backupPath = `${settingsPath}.agentlens-bak-${compactTimestamp()}`
      await fs.writeFile(backupPath, raw, 'utf-8')   // back up CURRENT content before overwriting
    }
    settings.env = env
    await atomicWriteJson(settingsPath, settings)
  }
  // Write the marker whenever it changed — even if env values didn't (e.g. the user already
  // had every key at our value): uninstall still needs the prior-state record to leave them.
  if (changed || markerChanged) {
    await atomicWriteJson(markerPath, marker)
  }

  return { changed, added, overrode, settingsPath, markerPath, bodiesDir, backupPath }
}

/**
 * Uninstall: restore settings.json to its pre-install state using the marker, then remove the
 * marker. Idempotent: with no marker there is nothing to undo. Never touches non-owned keys.
 */
export async function removeTelemetryConfig(options: TelemetryConfigOptions = {}): Promise<RemoveResult> {
  const { settingsPath, markerPath } = resolveOptions(options)
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
  for (const [key, rec] of Object.entries(marker.keys)) {
    if (rec.hadKey && rec.priorValue !== null) {
      env[key] = rec.priorValue      // re-set exactly what the user had
      restored.push(key)
    } else {
      if (key in env) delete env[key] // we added this key — remove it
      deleted.push(key)
    }
  }

  // If AgentLens created the env object and restoring emptied it, drop it so the file returns
  // to its prior shape (no stray empty "env": {}).
  if (!marker.envPreexisting && Object.keys(env).length === 0) delete settings.env
  else settings.env = env

  const backupPath = `${settingsPath}.agentlens-bak-${compactTimestamp()}`
  await fs.writeFile(backupPath, settingsRaw, 'utf-8')
  await atomicWriteJson(settingsPath, settings)
  await fs.rm(markerPath, { force: true })

  return { changed: restored.length > 0 || deleted.length > 0, restored, deleted, settingsPath, backupPath }
}

/** Per-key install status for `agentlens telemetry status`. Tolerates a corrupt marker. */
export async function telemetryConfigStatus(options: TelemetryConfigOptions = {}): Promise<StatusResult> {
  const { settingsPath, markerPath, bodiesDir, otlpPort } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)
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
