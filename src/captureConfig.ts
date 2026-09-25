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
import * as path from 'path'
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

/**
 * THE one resolution of "where should Claude Code write raw bodies": the SSD dir under the data dir.
 * TRDD-Z53IJFE9 (owner order, 2026-09-24): the RAM-disk spool is removed — bodies always land here,
 * and every writer of the OTEL_LOG_RAW_API_BODIES settings value must resolve through this so the
 * CLI and the server converge the SAME value (the two-writer defect of 2026-07-16).
 */
export function effectiveBodiesDir(dataDir: string, _captureOn?: boolean): string {
  return path.join(dataDir, 'otel-bodies')
}

/** Where the raw bodies a READER can actually see live, and what is missing. */
export interface BodiesReadScope {
  /** Existing, scannable dirs — deduped. */
  dirs: string[]
  /** Candidates that do NOT exist: a legacy dir that was fully drained. */
  missing: string[]
  captureOn: boolean
  /** True when a spool was configured (legacy installs) — i.e. the default dir alone is NOT the
   *  whole picture. Always false now that the spool is gone; kept because burnInvestigator reads
   *  it. TRDD-Z53IJFE9. */
  spoolConfigured: boolean
}

/**
 * WHERE TO READ raw bodies from. A reader must also see bodies left by a PREVIOUS sink: capture may
 * be off while yesterday's corpus is still on disk.
 *
 * Resolving a reader through the writer's single-answer function is what made investigate_burn
 * report "nothing burned here" during a 2.3M tok/min burn (2026-07-23, TRDD-8N3KQW2R): it read
 * the hardcoded dir — 0 files, because the corpus had finished draining. Hence: every existing
 * candidate, and an explicit list of the missing ones so the caller can say WHY it is blind instead
 * of saying "nothing".
 */
export function resolveBodiesReadScope(dataDir: string, env: NodeJS.ProcessEnv): BodiesReadScope {
  const captureOn = rawBodyCaptureEnabled(dataDir, env)
  const candidates = [...new Set([path.join(dataDir, 'otel-bodies')])]
  const dirs: string[] = []
  const missing: string[] = []
  for (const d of candidates) {
    // A dir that exists but is unreadable is as blind as an absent one — treat both as missing.
    let ok = false
    try { ok = fs.statSync(d).isDirectory() } catch { ok = false }
    ;(ok ? dirs : missing).push(d)
  }
  return { dirs, missing, captureOn, spoolConfigured: false }
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
  // The capture section is written EXACTLY as { rawBodies } — the removed RAM-disk spool's legacy
  // key (TRDD-Z53IJFE9) is dropped, and so is any future key nobody parses: a spread-preserve here
  // silently accumulates dead config. If you add a capture-section key, add it to the object ABOVE
  // and to loadCaptureConfig's parse, or this write will delete it. Same atomic + non-destructive
  // (rest-of-file) contract as before.
  obj.capture = { rawBodies: enabled }
  fs.mkdirSync(dataDir, { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8')
  fs.renameSync(tmp, p) // atomic replace
}
