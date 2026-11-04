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
import { agentlensDisabled, envHalfSet } from './cli/killSwitch'

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
  /** OTEL_LOG_RAW_API_BODIES must stay ABSENT: never written, removed when present (rawBodiesHeldAbsent). */
  rawBodiesOff: boolean
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
    // The flag of the GIVEN data dir (options.dataDir), else killSwitch's own env resolution — never the
    // homedir literal above, which is wrong whenever AGENTLENS_DATA_DIR/DATA_DIR is set.
    rawBodiesOff: rawBodiesHeldAbsent(options.dataDir),
  }
}

/**
 * THE one raw-body decision (TRDD-RBBEX59R): must OTEL_LOG_RAW_API_BODIES be ABSENT from settings.json right now?
 * True exactly while the off switch of `dataDir` is armed, either half, whatever its recorded reason.
 * WHY (owner rule 2026-11-03): "the disabled mode should ONLY stop the collection of the telemetry logs and raw
 * bodies" — so no writer (setup, auto-repair, --install-otel, the spool migration, the forced install) may write the
 * key while any switch half stands, a foreign-armed flag included. Every lift (enable, both foreign lifts, the forced
 * install) is followed by one telemetry converge in the same run, which writes it back. `--force-install-telemetry`
 * overrides the env half for its own process (overrideKillSwitchEnv) for everything EXCEPT this decision: the env half counts here
 * whatever the override says (envHalfSet, B13), so a force install under AGENTLENS_DISABLED=1 never writes the key.
 * Fail direction: agentlensDisabled's (a flag that cannot be stat'ed reads as not armed — killSwitch.ts header).
 * setup (otelDrift, the spool migration) calls this with ctx.dataDir, the dir being converged, never the env default.
 */
export function rawBodiesHeldAbsent(dataDir?: string): boolean {
  // envHalfSet, not just agentlensDisabled: the in-process --force-install-telemetry override makes agentlensDisabled ignore the env half
  // (B13), and a force install under AGENTLENS_DISABLED=1 with no flag file then wrote the raw-body key — a collection write under the switch.
  return envHalfSet() || agentlensDisabled(dataDir)
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
 * src/retentionConfig.ts. There is no opt-out knob — with ONE exception, the off switch: while it is armed
 * (rawBodiesHeldAbsent) the raw-body key stays OWNED (drift, verify, uninstall and the marker still treat a leftover
 * value as ours) but its convergence target is ABSENT: ensureTelemetryConfig never writes it and removes it when
 * present. WHY (owner rule 2026-11-03, TRDD-RBBEX59R): "the disabled mode should ONLY stop the collection of the
 * telemetry logs and raw bodies", and setup / auto-repair must not undo the disable verb, which strips the key.
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
export function shown(key: string, value: string): string {
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

export type VerdictState = 'OURS' | 'ABSENT' | 'CONVERGE' | 'FOREIGN' | 'STALE-ENV'

export interface TelemetryVerdictRow {
  key: string
  source: string
  scope: TelemetryConflict['scope']
  state: VerdictState
  detail: string
}

/** ONLY these owned keys decide WHERE telemetry goes, so only they can be FOREIGN. Every other owned key
 *  (export intervals, OTEL_LOG_* flags, OTEL_METRICS_INCLUDE_*, temporality, the CLAUDE_CODE_* toggles) is
 *  tuning: agentlenspro is a full-telemetry tool (owner order), so a differing value in the USER settings
 *  simply converges. In managed settings and the shell such tuning keys are ignored (not ours to change). */
const ROUTING_OWNED: ReadonlySet<string> = new Set([
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_TRACES_EXPORTER', 'OTEL_LOGS_EXPORTER', 'OTEL_METRICS_EXPORTER', RAW_BODIES_KEY,
])

/** localhost / 127.0.0.1 / ::1 are one spelling of "this machine"; a trailing slash is not a difference. */
function normalizeValue(key: string, v: string): string {
  if (!key.endsWith('_ENDPOINT')) return v
  try {
    const u = new URL(v)
    const loop = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname)
    return `${u.protocol}//${loop ? 'loopback' : u.host}${loop && u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/$/, '')}`
  } catch { return v }
}
export const sameTelemetryValue = (key: string, a: string, b: string): boolean => normalizeValue(key, a) === normalizeValue(key, b)
const sameValue = sameTelemetryValue

/** Judge every telemetry key, read-only, across ~/.claude/settings.json, the managed-settings files and the
 *  process env. Per key: ABSENT (will be written) / OURS (equal, loopback spellings equivalent) / CONVERGE
 *  (differs but is tuning, or a value agentlenspro wrote earlier: marker `written`, a local OTLP endpoint, a
 *  known raw-body dir) / FOREIGN (a routing key pointing elsewhere, or another pipeline's headers/per-signal
 *  endpoints) / STALE-ENV. STALE-ENV: under Claude Code (CLAUDECODE=1) the shell env is a SNAPSHOT of
 *  settings.json taken at session start, not user intent — a routing value that differs from the CURRENT file
 *  is a stale snapshot (restart Claude Code), never a reason to disable. Keys agentlenspro neither manages
 *  nor routes with (OTEL_RESOURCE_ATTRIBUTES, OTEL_SERVICE_NAME, ...) are never looked at. */
export function telemetryVerdict(options: TelemetryConfigOptions = {}): TelemetryVerdictRow[] {
  const { settingsPath, markerPath, bodiesDir, otlpPort, ownedBodyValues, rawBodiesOff } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)
  const marker = readMarkerSync(markerPath)
  const procEnv = options.processEnv ?? process.env
  const underClaudeCode = procEnv.CLAUDECODE === '1'
  const byValue = (key: string, v: string): boolean =>
    (key === 'OTEL_EXPORTER_OTLP_ENDPOINT' && LOCAL_ENDPOINT.test(v)) || (key === RAW_BODIES_KEY && ownedBodyValues.includes(v))
  const byMarker = (key: string, v: string): boolean =>
    byValue(key, v) || (marker !== null && (marker.written ? (marker.written[key] ?? []).includes(v) : key in marker.keys))
  // A differing user value agentlenspro may converge: tuning keys always, routing keys only on ownership evidence.
  const oursToConverge = (key: string, v: string): boolean => !ROUTING_OWNED.has(key) || byMarker(key, v)
  const rows: TelemetryVerdictRow[] = []
  const push = (key: string, source: string, scope: TelemetryConflict['scope'], state: VerdictState, detail: string): void => { rows.push({ key, source, scope, state, detail }) }
  const otherPipeline = (v: string, kind: TelemetryConflict['kind']): boolean => !(kind === 'endpoint' && LOCAL_ENDPOINT.test(v))
  const otherDetail = (key: string, v: string): string => `not managed by agentlenspro, so another telemetry pipeline is configured (found ${shown(key, v)})`

  const userEnv = readEnvSync(settingsPath)
  for (const [key, want] of Object.entries(owned)) {
    const raw = userEnv[key]
    // WHY (TRDD-RBBEX59R): while the off switch is armed (rawBodiesHeldAbsent) the raw-body key's target is ABSENT, so an
    // absent key is converged (never "will be written": the dry run must not promise to re-enable raw-body collection)
    // and a value of ours is converged by REMOVING it. "Ours" is the SAME predicate the normal path below uses (equal,
    // or oursToConverge: marker evidence and ownedBodyValues, the legacy spool dir included), so an owned value always
    // reads "will be removed", never a write text and never FOREIGN. A value agentlenspro never wrote falls through and
    // stays FOREIGN, exactly as without the switch — the foreign-pipeline guard is not weakened.
    if (key === RAW_BODIES_KEY && rawBodiesOff) {
      if (raw === undefined) { push(key, settingsPath, 'user', 'OURS', 'absent, as the off switch requires — raw-body capture stays off; not written'); continue }
      const cur = String(raw)
      if (sameValue(key, cur, want) || oursToConverge(key, cur)) { push(key, settingsPath, 'user', 'CONVERGE', `found ${shown(key, cur)} — the off switch is armed: will be removed`); continue }
    }
    if (raw === undefined) { push(key, settingsPath, 'user', 'ABSENT', `will be written: ${shown(key, want)}`); continue }
    const v = String(raw)
    if (sameValue(key, v, want)) { push(key, settingsPath, 'user', 'OURS', 'equal'); continue }
    const detail = `found ${shown(key, v)}, agentlenspro wants ${shown(key, want)}`
    push(key, settingsPath, 'user', oursToConverge(key, v) ? 'CONVERGE' : 'FOREIGN', detail)
  }
  for (const { key, kind } of OTHER_PIPELINE_KEYS) {
    const raw = userEnv[key]
    if (raw !== undefined && otherPipeline(String(raw), kind)) push(key, settingsPath, 'user', 'FOREIGN', otherDetail(key, String(raw)))
  }
  for (const base of options.managedSettingsPaths ?? managedSettingsPaths()) {
    const files = [base]
    const dropIns = path.join(path.dirname(base), 'managed-settings.d')
    try { files.push(...fsSync.readdirSync(dropIns).filter(f => f.endsWith('.json')).sort().map(f => path.join(dropIns, f))) } catch { /* no drop-in dir */ }
    for (const f of files) {
      const env = readEnvSync(f)
      for (const [key, want] of Object.entries(owned)) {
        if (!ROUTING_OWNED.has(key) || env[key] === undefined) continue
        const v = String(env[key])
        if (sameValue(key, v, want) || byValue(key, v)) push(key, f, 'managed', 'OURS', 'equal')
        else push(key, f, 'managed', 'FOREIGN', `found ${shown(key, v)}, agentlenspro wants ${shown(key, want)}`)
      }
      for (const { key, kind } of OTHER_PIPELINE_KEYS) {
        const raw = env[key]
        if (raw !== undefined && otherPipeline(String(raw), kind)) push(key, f, 'managed', 'FOREIGN', otherDetail(key, String(raw)))
      }
    }
  }
  const shellKeys = [...Object.keys(owned).filter(k => ROUTING_OWNED.has(k)), ...OTHER_PIPELINE_KEYS.map(o => o.key)]
  for (const key of shellKeys) {
    const raw = procEnv[key]
    if (raw === undefined) continue
    const v = String(raw)
    const other = OTHER_PIPELINE_KEYS.find(o => o.key === key)
    if (underClaudeCode) {
      // STALE only when settings.json HOLDS the key, that value is OURS, and the env differs (the state right
      // after --force-install-telemetry: the session still carries the old snapshot). A key the file LACKS but
      // the shell exports is a shell-set pipeline: writing ours would override it on the next restart, so it
      // falls through to the ordinary shell rules (FOREIGN). A file value that is itself foreign is already
      // judged by the user rows.
      const cur = userEnv[key]
      const fileOurs = cur !== undefined && !other && sameValue(key, String(cur), owned[key])
      if (fileOurs && sameValue(key, v, String(cur))) { push(key, 'process environment', 'shell', 'OURS', 'equals the current settings.json value'); continue }
      if (fileOurs) { push(key, 'process environment', 'shell', 'STALE-ENV', 'inherited from the Claude Code session snapshot and different from the current settings.json'); continue }
      if (cur !== undefined) continue
    }
    if (other) {
      if (otherPipeline(v, other.kind)) push(key, 'process environment', 'shell', 'FOREIGN', otherDetail(key, v))
      continue
    }
    const want = owned[key]
    if (sameValue(key, v, want) || byValue(key, v)) push(key, 'process environment', 'shell', 'OURS', 'equal')
    else push(key, 'process environment', 'shell', 'FOREIGN', `found ${shown(key, v)}, agentlenspro wants ${shown(key, want)}`)
  }
  return rows
}

/** The FOREIGN rows as conflicts (what blocks agentlenspro). */
export function verdictConflicts(rows: TelemetryVerdictRow[]): TelemetryConflict[] {
  return rows.filter(r => r.state === 'FOREIGN').map(r => ({
    key: r.key, source: r.source, scope: r.scope, kind: OTHER_PIPELINE_KEYS.find(o => o.key === r.key)?.kind ?? kindOfKey(r.key), detail: r.detail,
  }))
}

export function detectTelemetryConflicts(options: TelemetryConfigOptions = {}): TelemetryConflict[] {
  return verdictConflicts(telemetryVerdict(options))
}

/** One line per key for `setup --dry-run` / AGENTLENS_NO_AUTOSETUP=1: the verdict, nothing written. */
export function formatTelemetryVerdict(rows: TelemetryVerdictRow[]): string {
  return rows.map(r => `  ${r.state.padEnd(9)} ${r.key} (${r.source}) — ${r.detail}`).join('\n')
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
  const { settingsPath, markerPath, bodiesDir, otlpPort, rawBodiesOff } = resolveOptions(options)
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
    // WHY (TRDD-RBBEX59R): while the off switch is armed (rawBodiesHeldAbsent) the raw-body key stays OWNED (its first-seen
    // prior state is recorded like any other, so uninstall restores it exactly) but is never written: it is removed when
    // present — the same edit the disable verb makes (removeRawBodiesKey) — so setup and auto-repair cannot undo it.
    const off = key === RAW_BODIES_KEY && rawBodiesOff
    if (!(key in markerKeys)) {
      const hadKey = Object.prototype.hasOwnProperty.call(env, key)
      markerKeys[key] = { hadKey, priorValue: hadKey ? String(env[key]) : null }
      if (!off && !hadKey) added.push(key)
      else if (!off && String(env[key]) !== value) overrode.push(key)
    }
    if (off) {
      if (Object.prototype.hasOwnProperty.call(env, key)) { ops.push({ op: 'delete', path: ['env', key] }); changed = true }
      continue
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
    // The ownership evidence lists only values WE wrote: under the off switch nothing is written for the raw-body key.
    if (key === RAW_BODIES_KEY && rawBodiesOff) continue
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
  const { bodiesDir, otlpPort, rawBodiesOff } = resolveOptions(options)
  const owned = ownedKeys(bodiesDir, otlpPort)
  const byFile = new Map<string, TelemetryConflict[]>()
  for (const c of conflicts.filter(c => c.scope === 'managed')) byFile.set(c.source, [...(byFile.get(c.source) ?? []), c])
  const done: Array<{ file: string; backupPath: string | null }> = []
  for (const [file, list] of byFile) {
    for (const target of [file, path.dirname(file)]) {
      try { fsSync.accessSync(target, fsSync.constants.W_OK) } catch (e) { throw new ManagedSettingsNotWritableError(file, `${path.basename(target) === path.basename(file) ? 'file' : 'directory'} not writable: ${(e as NodeJS.ErrnoException).code}`) }
    }
    // While the off switch is armed the raw-body key is REMOVED, never set (TRDD-RBBEX59R: no writer re-enables it).
    const ops: SafeEditOp[] = list.map(c => c.key in owned && !(c.key === RAW_BODIES_KEY && rawBodiesOff)
      ? { op: 'set' as const, path: ['env', c.key], value: owned[c.key] }
      : { op: 'delete' as const, path: ['env', c.key] })
    const r = await safeConfigEdit(file, 'json', ops)
    done.push({ file, backupPath: r.backupPath ?? null })
  }
  return done
}

/**
 * Delete OTEL_LOG_RAW_API_BODIES from settings.json — the disable verb's strip (the global emergency brake). Raw
 * capture is mandatory for an enabled install; while the off switch stands (rawBodiesHeldAbsent), ensureTelemetryConfig makes
 * this SAME delete itself, so setup and auto-repair keep the key absent (TRDD-RBBEX59R). Undone by the enable
 * verb (it converges telemetry once more right after lifting the switch, which writes the key back). Goes through safeConfigEdit
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
