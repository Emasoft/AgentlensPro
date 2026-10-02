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
import * as fsSync from 'fs'
import { safeConfigEdit, SafeEditOp } from './safeConfigEdit'
import { effectiveBodiesDir, RAW_BODIES_KEY } from './captureConfig'
import { envPort } from './cli/cliCore'

export interface TelemetryConfigOptions {
  /** settings.json to manage. Default: ~/.claude/settings.json */
  settingsPath?: string
  /** managed-keys marker. Default: ~/.agentlens/telemetry-managed.json */
  markerPath?: string
  /** raw-API-body export dir (created on install). Default: ~/.agentlens/otel-bodies */
  bodiesDir?: string
  /** OTLP collector port the endpoint should point at. Default: 4318 */
  otlpPort?: number
  /** AgentLens data dir — the default bodies dir lives under it. Default: ~/.agentlens */
  dataDir?: string
  /** Enterprise managed-settings files the foreign-pipeline guard reads. Default: the OS locations
   *  (managedSettingsPaths()). Tests pin it so a developer's real company config cannot leak in. */
  managedSettingsPaths?: string[]
  /** Process env the foreign-pipeline guard reads. Default: process.env. */
  processEnv?: NodeJS.ProcessEnv
  /** `--force-install-telemetry`: replace foreign keys in the USER settings.json (one transaction, backup
   *  kept) instead of refusing. Managed settings are replaced separately (forceInstallManagedTelemetry). */
  forceInstall?: boolean
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
  /** Every value agentlenspro itself wrote per key (newest last, capped) — the OWNERSHIP EVIDENCE the
   *  foreign-pipeline guard needs: a value in this list is ours to converge, any other differing value
   *  is someone else's pipeline. Absent in markers written before 2026-10-02 (legacy: see
   *  detectTelemetryConflicts). */
  written?: Record<string, string[]>
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
  /** Every `file:` value agentlenspro itself could have written to OTEL_LOG_RAW_API_BODIES — the
   *  ownership evidence the foreign-pipeline guard compares against (detectTelemetryConflicts). */
  ownedBodyValues: string[]
} {
  const home = os.homedir()
  const dataDir = options.dataDir ?? path.join(home, '.agentlens')
  const bodiesDir = options.bodiesDir ?? effectiveBodiesDir(dataDir)
  return {
    settingsPath: options.settingsPath ?? path.join(home, '.claude', 'settings.json'),
    markerPath:   options.markerPath   ?? path.join(home, '.agentlens', 'telemetry-managed.json'),
    // Default through the ONE bodies-dir resolution (the SSD dir under the data dir, TRDD-Z53IJFE9 —
    // the RAM-disk spool is removed) so every caller converges the same value.
    bodiesDir,
    otlpPort:     options.otlpPort     ?? 4318,
    // The removed RAM-disk spool's bodies path is carried as a LITERAL: a legacy install upgraded past
    // TRDD-Z53IJFE9 still has `file:/Volumes/AgentLensSpool/otel-bodies` in settings.json — a value
    // agentlenspro wrote itself, so it is OURS to converge, not a foreign pipeline.
    ownedBodyValues: [...new Set([bodiesDir, effectiveBodiesDir(dataDir), '/Volumes/AgentLensSpool/otel-bodies'])].map(d => `file:${d}`),
  }
}

/**
 * The exact set of env keys AgentLens manages to enable Claude Code's FULL telemetry.
 * Cross-checked against the reference full-telemetry config the user configured by hand
 * this session (TRDD-M36W16L0 STATE). Every value is a string — settings.json env values
 * are strings, and Claude Code reads these as env vars.
 *
 * Everything here is idempotent WIRING that every install owns and force-converges on install and on
 * every CLI launch (autoSetup.ts) — including `OTEL_LOG_RAW_API_BODIES`. OWNER REVERSAL 2026-10-02
 * (TRDD-AGZ0XZKW, reversing the opt-in of TRDD-BKF5NZD3): raw body dumps are MANDATORY — "if you
 * install agentlenspro you know you are installing a tool that reads the raw dumps and all telemetry
 * and hooks and the status line, etc. all of it." Claude Code re-serializes the whole conversation
 * to disk on every request (~35 GB/day); that cost is ACCEPTED and bounded by the store's retention:
 * live bodies are archived oldest-first past `bodiesMaxGb` (AGENTLENS_BODIES_MAX_GB, default 8) and
 * archives are deleted after `bodiesRetentionDays` (AGENTLENS_BODIES_RETENTION_DAYS, default 31) —
 * src/retentionConfig.ts. There is no opt-out and no delete path.
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
    [RAW_BODIES_KEY]:                                  `file:${bodiesDir}`,
    OTEL_METRICS_INCLUDE_SESSION_ID:                   'true',
    OTEL_METRICS_INCLUDE_VERSION:                      'true',
    OTEL_METRICS_INCLUDE_ENTRYPOINT:                   'true',
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID:                 'true',
  }
}

/** The expected key→value telemetry env table for a given bodies dir / OTLP port. Exported
 *  for `agentlenspro setup`, whose VERIFY step must compare the settings file against the
 *  expected values through a path independent of the writer (falsify-the-layer discipline) —
 *  re-exporting the ONE table keeps setup from growing a drift-prone copy. */
export function ownedTelemetryKeys(bodiesDir: string, otlpPort: number): Record<string, string> {
  return ownedKeys(bodiesDir, otlpPort)
}
// ── Foreign-pipeline guard (owner order 2026-10-02, TRDD-AGZ0XZKW) ──────────────────────────────
// "if the tool finds an already configured telemetry that uses different parameters and outputs from
// those of agentlenspro, then it must stop and report an error message". A company intranet collector
// or central gateway is typically set in the ENTERPRISE MANAGED settings (which override user
// settings) or already exported in the shell, so all three places are read. The verdict is computed
// BEFORE any write: a mixed state (one foreign key + one absent key) writes NOTHING.
// There is NO skip path (owner order 2026-10-02: "without telemetry raw dumps agentlenspro is non
// functional, so it cannot be skipped"): a foreign verdict stops the run with an error and disables
// agentlenspro (foreignTelemetry.ts). `--force-install-telemetry` (per invocation, never persisted)
// is "exactly to overwrite the company settings of telemetry, and write the agentlenspro settings
// instead": it replaces the foreign keys in the user settings.json AND in the managed-settings file
// (when writable — never by privilege escalation). A conflicting SHELL export cannot be fixed by any
// settings edit, so that one is reported and the run stops.

export interface TelemetryConflict {
  key: string
  /** the file the value came from, or "process environment" */
  source: string
  /** where it lives: ~/.claude/settings.json (replaceable by --force-install), the enterprise managed
   *  settings (an administrator's), or the shell env (the user unsets it) */
  scope: 'user' | 'managed' | 'shell'
  kind: 'endpoint' | 'path' | 'protocol' | 'exporter' | 'headers' | 'value'
  /** human text; a credential-bearing value is withheld, a URL is shown without userinfo/query */
  detail: string
}

export class TelemetryConflictError extends Error {
  constructor(readonly conflicts: TelemetryConflict[]) {
    super(formatTelemetryConflicts(conflicts))
    this.name = 'TelemetryConflictError'
  }
}

export function formatTelemetryConflicts(conflicts: TelemetryConflict[], verb?: string): string {
  // With a verb (the dispatcher's refusal) the message is written for an AI agent as much as a human:
  // what happened, why, the exact reactivation command — in that order, one sentence each.
  const lines = verb !== undefined
    ? [`agentlenspro is DISABLED — ${verb || 'start'} did not run.`, 'Reason: another telemetry setup is already in place, and agentlenspro cannot work without its own telemetry and raw body dumps; it will not touch that setup unless told to.']
    : ['agentlenspro cannot run: another telemetry setup is already in place, and agentlenspro cannot work without its own telemetry and raw body dumps. It will not touch that setup unless told to.']
  for (const c of conflicts) lines.push(`  ${c.key} in ${c.source}: ${c.kind} — ${c.detail}`)
  const files = [...new Set(conflicts.filter(c => c.scope !== 'shell').map(c => c.source))]
  if (files.length > 0) {
    lines.push(`To reactivate: remove the existing telemetry setup from ${files.join(', ')}, or run: agentlenspro --force-install-telemetry <any command> (it REPLACES the existing telemetry with agentlenspro's; a managed-settings file needs administrator rights).`)
  }
  for (const c of conflicts.filter(c => c.scope === 'shell')) {
    lines.push(`To reactivate: unset ${c.key} in your shell — it is exported there, and no settings edit (and no flag) can change the shell.`)
  }
  return lines.join('\n')
}

/** Enterprise managed-settings files (they override ~/.claude/settings.json, so a company gateway
 *  lives here). macOS / Linux+WSL / Windows locations from the Claude Code settings docs — from
 *  documentation knowledge, NOT verified against a live managed install (none exists on the dev
 *  machine). Each is also scanned as `<dir>/managed-settings.d/*.json` (drop-in directory). */
export function managedSettingsPaths(): string[] {
  return [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/etc/claude-code/managed-settings.json',
    'C:\\Program Files\\ClaudeCode\\managed-settings.json',
  ]
}

/** Not written by agentlenspro: any of these present means ANOTHER pipeline is configured. */
const OTHER_PIPELINE_KEYS: ReadonlyArray<{ key: string; kind: TelemetryConflict['kind'] }> = [
  { key: 'OTEL_EXPORTER_OTLP_HEADERS', kind: 'headers' },
  { key: 'OTEL_EXPORTER_OTLP_TRACES_HEADERS', kind: 'headers' },
  { key: 'OTEL_EXPORTER_OTLP_LOGS_HEADERS', kind: 'headers' },
  { key: 'OTEL_EXPORTER_OTLP_METRICS_HEADERS', kind: 'headers' },
  { key: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', kind: 'endpoint' },
  { key: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', kind: 'endpoint' },
  { key: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', kind: 'endpoint' },
]

const LOCAL_ENDPOINT = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/
const SECRET_KEY = /HEADERS|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i

function kindOfKey(key: string): TelemetryConflict['kind'] {
  if (key === RAW_BODIES_KEY) return 'path'
  if (key.endsWith('_ENDPOINT')) return 'endpoint'
  if (key.endsWith('_PROTOCOL')) return 'protocol'
  if (key.endsWith('_EXPORTER')) return 'exporter'
  return 'value'
}

/** Printable form of a value: withheld for credential-bearing keys, URLs without userinfo/query. */
function shown(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return 'value withheld'
  try {
    const u = new URL(value)
    return u.protocol === 'file:' ? value : `${u.protocol}//${u.host}${u.pathname}`
  } catch { return value }
}

function readEnvSync(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, 'utf-8')) as { env?: unknown }
    return parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env) ? parsed.env as Record<string, unknown> : {}
  } catch { return {} } // absent or unparseable: ensureTelemetryConfig refuses an unparseable user file itself
}

function readMarkerSync(markerPath: string): TelemetryMarker | null {
  try {
    const m = JSON.parse(fsSync.readFileSync(markerPath, 'utf-8')) as TelemetryMarker
    return m && typeof m.keys === 'object' && m.keys !== null ? m : null
  } catch { return null }
}

/** Compute EVERY conflict, across ~/.claude/settings.json, the managed-settings files and the process
 *  env, without writing anything. Per owned key: absent ok; equal to ours ok; a value agentlenspro
 *  wrote earlier (marker `written`; for a marker that predates it, any key the marker manages; a
 *  local OTLP endpoint; a known raw-body dir) ok; anything else = foreign. Managed settings and the
 *  process env can only be judged by value (no marker covers them). */
export function detectTelemetryConflicts(
  options: TelemetryConfigOptions = {},
): TelemetryConflict[] {
  const { settingsPath, markerPath, bodiesDir, otlpPort, ownedBodyValues } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)
  const marker = readMarkerSync(markerPath)
  const byValue = (key: string, v: string): boolean =>
    (key === 'OTEL_EXPORTER_OTLP_ENDPOINT' && LOCAL_ENDPOINT.test(v)) || (key === RAW_BODIES_KEY && ownedBodyValues.includes(v))
  const byMarker = (key: string, v: string): boolean =>
    byValue(key, v) || (marker !== null && (marker.written ? (marker.written[key] ?? []).includes(v) : key in marker.keys))
  const conflicts: TelemetryConflict[] = []
  const scan = (env: Record<string, unknown>, source: string, scope: TelemetryConflict['scope'], isOurs: (key: string, v: string) => boolean): void => {
    for (const [key, want] of Object.entries(owned)) {
      const raw = env[key]
      if (raw === undefined) continue
      const v = String(raw)
      if (v === want || isOurs(key, v)) continue
      conflicts.push({ key, source, scope, kind: kindOfKey(key), detail: `found ${shown(key, v)}, agentlenspro wants ${shown(key, want)}` })
    }
    for (const { key, kind } of OTHER_PIPELINE_KEYS) {
      const raw = env[key]
      if (raw === undefined) continue
      const v = String(raw)
      if (kind === 'endpoint' && LOCAL_ENDPOINT.test(v)) continue // a local collector is not a company gateway
      conflicts.push({ key, source, scope, kind, detail: `not managed by agentlenspro, so another telemetry pipeline is configured (found ${shown(key, v)})` })
    }
  }
  scan(readEnvSync(settingsPath), settingsPath, 'user', byMarker)
  for (const base of options.managedSettingsPaths ?? managedSettingsPaths()) {
    const files = [base]
    const dropIns = path.join(path.dirname(base), 'managed-settings.d')
    try { files.push(...fsSync.readdirSync(dropIns).filter(f => f.endsWith('.json')).sort().map(f => path.join(dropIns, f))) } catch { /* no drop-in dir */ }
    for (const f of files) scan(readEnvSync(f), f, 'managed', byValue)
  }
  scan(options.processEnv ?? process.env, 'process environment', 'shell', byValue)
  return conflicts
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
  const { settingsPath, markerPath, bodiesDir, otlpPort } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)

  const { settings } = await readSettingsOrThrow(settingsPath)
  const { env, envPreexisting } = extractEnv(settings, settingsPath)
  const existingMarker = await readMarker(markerPath)

  // Stop BEFORE any op if another telemetry pipeline is configured (see the guard above): the whole
  // verdict is computed first, so a mixed state (one foreign key + one absent key) writes nothing.
  const conflicts = detectTelemetryConflicts(options)
  if (conflicts.length > 0 && !options.forceInstall) throw new TelemetryConflictError(conflicts)

  // Keep any prior-state records from an earlier install untouched — the FIRST record of a
  // key is the only truthful one. Overwriting it with the now-installed value would make
  // uninstall restore AgentLens's own value instead of the user's original.
  const markerKeys: Record<string, ManagedKeyRecord> = { ...(existingMarker?.keys ?? {}) }
  const added: string[] = []
  const overrode: string[] = []
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

  // --force-install-telemetry only (otherwise conflicts is empty or we threw): the foreign-only keys
  // (headers, per-signal endpoints) of the USER file go in the SAME transaction, and their prior values
  // are recorded in the marker so an uninstall restores the company setup exactly.
  for (const c of conflicts.filter(c => c.scope === 'user')) {
    if (!OTHER_PIPELINE_KEYS.some(o => o.key === c.key) || !(c.key in env)) continue
    if (!(c.key in markerKeys)) markerKeys[c.key] = { hadKey: true, priorValue: String(env[c.key]) }
    ops.push({ op: 'delete', path: ['env', c.key] })
    changed = true
  }

  // Remember what WE wrote (the ownership evidence for the guard). Seeded from a legacy marker's
  // managed keys' current values is deliberately NOT done: only values written by this code count.
  const written: Record<string, string[]> = { ...(existingMarker?.written ?? {}) }
  for (const [key, value] of Object.entries(owned)) {
    const list = written[key] ?? []
    if (!list.includes(value)) written[key] = [...list, value].slice(-8)
  }
  const marker: TelemetryMarker = {
    version: 1,
    managedAt: existingMarker?.managedAt ?? new Date().toISOString(),
    envPreexisting: existingMarker?.envPreexisting ?? envPreexisting,
    keys: markerKeys,
    written,
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

  return { changed, added, overrode, settingsPath, markerPath, bodiesDir, backupPath }
}

/** Thrown when the managed-settings file cannot be rewritten by this user (root-owned is normal). */
export class ManagedSettingsNotWritableError extends Error {
  constructor(readonly file: string, why: string) {
    super(`${file} cannot be rewritten by this user (${why}) — replacing it needs administrator rights (e.g. re-run with sudo). agentlenspro never escalates privileges itself.`)
    this.name = 'ManagedSettingsNotWritableError'
  }
}

/** `--force-install-telemetry` for the enterprise managed-settings file(s): overwrite each conflicting
 *  owned key with agentlenspro's value and delete the foreign-only keys, in ONE safeConfigEdit
 *  transaction per file (its backup path is returned). Never escalates: an unwritable file throws
 *  ManagedSettingsNotWritableError before anything is attempted. */
export async function forceInstallManagedTelemetry(
  conflicts: TelemetryConflict[], options: TelemetryConfigOptions = {},
): Promise<Array<{ file: string; backupPath: string | null }>> {
  const { bodiesDir, otlpPort } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)
  const byFile = new Map<string, TelemetryConflict[]>()
  for (const c of conflicts.filter(c => c.scope === 'managed')) byFile.set(c.source, [...(byFile.get(c.source) ?? []), c])
  const done: Array<{ file: string; backupPath: string | null }> = []
  for (const [file, list] of byFile) {
    for (const target of [file, path.dirname(file)]) {
      try { fsSync.accessSync(target, fsSync.constants.W_OK) } catch (e) { throw new ManagedSettingsNotWritableError(file, `${path.basename(target) === path.basename(file) ? 'file' : 'directory'} not writable: ${(e as NodeJS.ErrnoException).code}`) }
    }
    const ops: SafeEditOp[] = list.map(c => c.key in owned
      ? { op: 'set' as const, path: ['env', c.key], value: owned[c.key] }
      : { op: 'delete' as const, path: ['env', c.key] })
    const r = await safeConfigEdit(file, 'json', ops)
    done.push({ file, backupPath: r.backupPath ?? null })
  }
  return done
}

/**
 * Delete OTEL_LOG_RAW_API_BODIES from settings.json — ONLY for `agentlenspro disable` (the global
 * emergency brake). Raw capture is mandatory for an enabled install, so this is the one deliberate
 * strip, undone by `enable` (ensureTelemetryConfig re-converges it). Goes through safeConfigEdit
 * like every settings.json write; returns false when the key was not there.
 */
export async function removeRawBodiesKey(options: TelemetryConfigOptions = {}): Promise<boolean> {
  const { settingsPath } = resolveOptions(options)
  const { settings } = await readSettingsOrThrow(settingsPath)
  const { env } = extractEnv(settings, settingsPath)
  if (!(RAW_BODIES_KEY in env)) return false
  await safeConfigEdit(settingsPath, 'json', [{ op: 'delete', path: ['env', RAW_BODIES_KEY] }])
  return true
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
  const finalEnv: Record<string, string> = { ...env }
  const ops: SafeEditOp[] = []
  for (const [key, rec] of Object.entries(marker.keys)) {
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
  // TRDD-99HUNXJS: was `parseInt(process.env.OTLP_PORT, 10)`, which stops at the first non-digit —
  // `'8080/evil'` became 8080 and `'0'` became 0. This site is the one that PERSISTS the value
  // (runTelemetryCli -> ensureTelemetryConfig writes it to settings.json), so a bad parse survived
  // the process. Use the one shared parser; the full divergence table is in the card.
  const otlpPort = Number(envPort(process.env.OTLP_PORT, 4318))
  // ...and because this site persists it, say so when the operator's value was discarded. The
  // fallback is silent by design (envPort's ratified semantics, TRDD-EGGERLEO); silence is fine
  // for a URL built per-request and wrong for a number written into the user's settings.json.
  // Two DIFFERENT valid fallbacks: if the input was accepted both calls return that port and
  // agree; if it was rejected they return 1 and 2. Asks the parser instead of re-deriving its
  // predicate. Guard on PRESENCE, not truthiness — `OTLP_PORT=''` and `'   '` are set-but-garbage.
  const rawOtlp = process.env.OTLP_PORT
  if (rawOtlp !== undefined && envPort(rawOtlp, 1) !== envPort(rawOtlp, 2)) {
    const why = rawOtlp.trim() === '' ? 'is empty' : 'is not a usable port'
    console.error(`⚠ OTLP_PORT=${JSON.stringify(rawOtlp)} ${why} — using ${otlpPort}`)
  }
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
