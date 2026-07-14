// Raw-body capture (TRDD-BKF5NZD3) — the one telemetry knob whose cost is UNBOUNDED, so it is
// opt-in and OFF by default.
//
// OTEL_LOG_RAW_API_BODIES=file:<dir> makes Claude Code re-serialize the WHOLE conversation to disk on
// EVERY LLM request. Measured (TRDD-K3WDPR7M): 0.7-1.9 MB per request, ~21 MB/min, ~35 GB/day, with
// no documented cleanup — 22 GB had accumulated on the author's machine before anyone noticed.
//
// WHY IT LIVES HERE AND NOT IN telemetryConfig's ownedKeys(): the server force-converges the owned
// telemetry keys on EVERY boot, so while the key was unconditionally owned there was NO WAY to turn
// capture off — a user who deleted it from settings.json got it silently RE-ADDED the next time any
// hook revived the server (observed: removed 04:22, back by 15:07, same day). The other owned keys are
// cheap idempotent WIRING (endpoint, exporters, intervals) and forcing those is right; a capture
// policy that writes gigabytes a day is not wiring, it is a decision the user must be able to make.
//
// Precedence matches retention (src/retentionConfig.ts): env > config.json > built-in default.
import * as fs from 'fs'
import { configPath } from './retentionConfig'

/** Ops override. Set to 1/true/on to capture, 0/false/off to not — anything else is ignored. */
export const RAW_BODIES_ENV = 'AGENTLENS_CAPTURE_RAW_BODIES'

/** The settings.json env key this knob governs. The ONE spelling — never re-type it inline. */
export const RAW_BODIES_KEY = 'OTEL_LOG_RAW_API_BODIES'

/** OFF. A default that silently costs ~35 GB/day is not a default a user consented to. */
export const RAW_BODIES_DEFAULT = false

export interface CaptureConfig {
  rawBodies?: boolean
}

export type CaptureSource = 'env' | 'file' | 'default'

/** Parse a tri-state env flag: true / false / "not set" (undefined ⇒ fall through to the file). */
function parseBool(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined
  const v = raw.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false
  return undefined // a typo must not be read as consent — fall through to the file/default
}

/** Read the `capture` section. Fail-soft: a missing/unreadable/corrupt file yields {} (all defaults) —
 *  reading config must never crash server boot, and the default is the SAFE (cheap) value anyway. */
export function loadCaptureConfig(dataDir: string): CaptureConfig {
  let obj: { capture?: Record<string, unknown> }
  try {
    obj = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf-8')) as { capture?: Record<string, unknown> }
  } catch {
    return {}
  }
  const c = obj.capture ?? {}
  const out: CaptureConfig = {}
  if (typeof c.rawBodies === 'boolean') out.rawBodies = c.rawBodies
  return out
}

/** Resolve capture + where the value came from (env > file > default). */
export function rawBodyCaptureWithSource(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): { enabled: boolean; source: CaptureSource } {
  const fromEnv = parseBool(env[RAW_BODIES_ENV])
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env' }
  const fromFile = loadCaptureConfig(dataDir).rawBodies
  if (typeof fromFile === 'boolean') return { enabled: fromFile, source: 'file' }
  return { enabled: RAW_BODIES_DEFAULT, source: 'default' }
}

/** Is raw-body capture on? The ONE question telemetryConfig / setup / disable all ask. */
export function rawBodyCaptureEnabled(dataDir: string, env: NodeJS.ProcessEnv): boolean {
  return rawBodyCaptureWithSource(dataDir, env).enabled
}

/**
 * Persist the knob into DATA_DIR/config.json, atomically and non-destructively — PRESERVING every
 * other key (retention lives in the same file). If the file exists but is NOT valid JSON this THROWS
 * rather than clobbering it: the "start fresh on a parse failure" pattern once wiped a real config
 * (see src/safeConfigEdit.ts), so it is forbidden here too. temp + rename ⇒ a crash mid-write can
 * never leave a half-written config.
 */
export function setRawBodyCapture(dataDir: string, enabled: boolean): void {
  const p = configPath(dataDir)
  let obj: { capture?: Record<string, unknown>; [k: string]: unknown } = {}
  if (fs.existsSync(p)) {
    obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as typeof obj
  }
  obj.capture = { ...(obj.capture ?? {}), rawBodies: enabled }
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, p) // atomic replace
}
