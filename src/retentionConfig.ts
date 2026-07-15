// Persistent retention config (TRDD-ZAV74M8Q). Lives in DATA_DIR/config.json so it survives a
// repo delete / npm uninstall / version upgrade / CLI-path change — the same durability as the data
// it governs — and the launchd daemon re-reads it on every boot without re-running setup. Retention
// was already env-configurable; this adds the PERSISTENT + DISCOVERABLE layer under it.
//
// Precedence per knob (highest first): env var > config.json > built-in default, with the min floor
// applied last (matching the server's existing Math.max floors). Env stays the ephemeral ops
// override; the file is the durable setting a user sets once.
import * as fs from 'fs'
import * as path from 'path'

export interface RetentionConfig {
  spansRetentionDays?: number
  summaryWindowHours?: number
  bodiesMaxAgeHours?: number
  bodiesMaxGb?: number
  bodiesRetentionDays?: number
  logEventsRetentionDays?: number
}

export interface RetentionKeyMeta {
  key: keyof RetentionConfig
  env: string
  def: number
  min: number
  unit: string
  desc: string
}

// The ONE table both the server (to resolve values) and the CLI (to list/validate) read from — so a
// new knob or a changed default can never drift between the two sides.
export const RETENTION_META: readonly RetentionKeyMeta[] = [
  { key: 'spansRetentionDays',  env: 'AGENTLENS_SPANS_RETENTION_DAYS',  def: 30, min: 1,   unit: 'days',  desc: 'span segments (the trace DB) kept on disk' },
  { key: 'summaryWindowHours',  env: 'AGENTLENS_SUMMARY_WINDOW_HOURS',  def: 24, min: 1,   unit: 'hours', desc: 'in-memory rolling summary window' },
  { key: 'bodiesMaxAgeHours',   env: 'AGENTLENS_BODIES_MAX_AGE_HOURS',  def: 72, min: 1,   unit: 'hours', desc: 'raw OTEL bodies kept as plain files before archiving' },
  { key: 'bodiesMaxGb',         env: 'AGENTLENS_BODIES_MAX_GB',         def: 8,  min: 0.5, unit: 'GB',    desc: 'live-bodies size cap (archives oldest-first; never deletes)' },
  { key: 'bodiesRetentionDays', env: 'AGENTLENS_BODIES_RETENTION_DAYS', def: 31, min: 1,   unit: 'days',  desc: 'archived OTEL bodies kept before whole-volume deletion' },
  // TRDD-AMEA4O4Z: gated-out OTEL log events (user_prompt, tool_decision, hook_execution_*, ...)
  // persisted as daily NDJSON buckets instead of being dropped — this bounds how long they live.
  { key: 'logEventsRetentionDays', env: 'AGENTLENS_LOG_EVENTS_RETENTION_DAYS', def: 31, min: 1, unit: 'days', desc: 'gated-out OTEL log events kept as daily NDJSON buckets' },
]

export function configPath(dataDir: string): string {
  return path.join(dataDir, 'config.json')
}

// Read the retention section, fail-soft: a missing file, unreadable file, or invalid JSON yields {}
// (all defaults) — reading config must never crash server boot. Non-numeric / non-finite values for a
// knob are ignored (the default/env takes over) rather than trusted.
export function loadRetentionConfig(dataDir: string): RetentionConfig {
  let obj: { retention?: Record<string, unknown> }
  try {
    obj = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf-8')) as { retention?: Record<string, unknown> }
  } catch {
    return {}
  }
  const r = obj.retention ?? {}
  const out: RetentionConfig = {}
  for (const m of RETENTION_META) {
    const v = r[m.key]
    if (typeof v === 'number' && Number.isFinite(v)) out[m.key] = v
  }
  return out
}

export type KnobSource = 'env' | 'file' | 'default'

/** Resolve one knob's effective value + where it came from. env > file > default; min floor last. */
export function resolveKnobWithSource(
  m: RetentionKeyMeta,
  fileCfg: RetentionConfig,
  env: NodeJS.ProcessEnv,
): { value: number; source: KnobSource } {
  const envStr = env[m.env]
  const envNum = Number(envStr)
  if (envStr != null && envStr !== '' && Number.isFinite(envNum)) {
    return { value: Math.max(m.min, envNum), source: 'env' }
  }
  const fileVal = fileCfg[m.key]
  if (typeof fileVal === 'number' && Number.isFinite(fileVal)) {
    return { value: Math.max(m.min, fileVal), source: 'file' }
  }
  return { value: Math.max(m.min, m.def), source: 'default' }
}

export function resolveKnob(m: RetentionKeyMeta, fileCfg: RetentionConfig, env: NodeJS.ProcessEnv): number {
  return resolveKnobWithSource(m, fileCfg, env).value
}

export function findMeta(key: string): RetentionKeyMeta | undefined {
  return RETENTION_META.find((m) => m.key === key)
}

/** Resolve every knob once (env > file > default). The server calls this at boot. */
export function resolveRetention(dataDir: string, env: NodeJS.ProcessEnv): Record<keyof RetentionConfig, number> {
  const file = loadRetentionConfig(dataDir)
  const out = {} as Record<keyof RetentionConfig, number>
  for (const m of RETENTION_META) out[m.key] = resolveKnob(m, file, env)
  return out
}

/**
 * Persist one retention knob into DATA_DIR/config.json, atomically and non-destructively.
 * PRESERVES every other key already in the file. If the file exists but is NOT valid JSON, THROWS
 * (refuses to write) rather than clobbering it — the "start fresh on a parse failure" pattern once
 * wiped a real config, so it is forbidden here too. Writes via temp + rename so a crash mid-write
 * never leaves a half-written config.
 */
export function setRetentionKey(dataDir: string, key: keyof RetentionConfig, value: number): void {
  const m = findMeta(key)
  if (!m) throw new Error(`unknown retention key: ${key}`)
  if (!Number.isFinite(value)) throw new Error(`value must be a finite number, got: ${value}`)
  if (value < m.min) throw new Error(`${key} must be ≥ ${m.min} ${m.unit}`)

  const p = configPath(dataDir)
  let obj: { retention?: Record<string, unknown>; [k: string]: unknown } = {}
  if (fs.existsSync(p)) {
    // JSON.parse THROWS on a corrupt file — surface it, do NOT reset (never clobber a config on a
    // parse failure). The caller reports the error and the file is left untouched.
    obj = JSON.parse(fs.readFileSync(p, 'utf-8'))
  }
  obj.retention = { ...(obj.retention ?? {}), [key]: value }
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, p) // atomic replace
}
