// Raw-body capture (TRDD-BKF5NZD3, REVERSED 2026-10-02 under TRDD-AGZ0XZKW) — MANDATORY, not opt-in.
//
// OTEL_LOG_RAW_API_BODIES=file:<dir> makes Claude Code re-serialize the WHOLE conversation to disk on
// EVERY LLM request. Measured (TRDD-K3WDPR7M): 0.7-1.9 MB per request, ~21 MB/min, ~35 GB/day.
// BKF5NZD3 made that an opt-in knob (env > config.json > OFF). OWNER REVERSAL 2026-10-02: "raw body
// dumps is not an optin, its mandatory. if you install agentlenspro you know you are installing a
// tool that reads the raw dumps and all telemetry and hooks and the status line, etc. all of it."
// So there is no knob any more: the key is a plain owned telemetry key (telemetryConfig.ts), converged
// on install and on every CLI launch. The ~35 GB/day cost is accepted; it is bounded by the store:
// live bodies are archived oldest-first past `bodiesMaxGb` (AGENTLENS_BODIES_MAX_GB, default 8) and
// archives are deleted after `bodiesRetentionDays` (AGENTLENS_BODIES_RETENTION_DAYS, default 31) —
// src/retentionConfig.ts.
import * as fs from 'fs'
import * as path from 'path'

/** The settings.json env key every install owns. The ONE spelling — never re-type it inline. */
export const RAW_BODIES_KEY = 'OTEL_LOG_RAW_API_BODIES'

/**
 * THE one resolution of "where should Claude Code write raw bodies": the SSD dir under the data dir.
 * TRDD-Z53IJFE9 (owner order, 2026-09-24): the RAM-disk spool is removed — bodies always land here,
 * and every writer of the OTEL_LOG_RAW_API_BODIES settings value must resolve through this so the
 * CLI and the server converge the SAME value (the two-writer defect of 2026-07-16).
 */
export function effectiveBodiesDir(dataDir: string): string {
  return path.join(dataDir, 'otel-bodies')
}

/** Where the raw bodies a READER can actually see live, and what is missing. */
export interface BodiesReadScope {
  /** Existing, scannable dirs — deduped. */
  dirs: string[]
  /** Candidates that do NOT exist: a legacy dir that was fully drained. */
  missing: string[]
  /** True when a spool was configured (legacy installs) — i.e. the default dir alone is NOT the
   *  whole picture. Always false now that the spool is gone; kept because burnInvestigator reads
   *  it. TRDD-Z53IJFE9. */
  spoolConfigured: boolean
}

/**
 * WHERE TO READ raw bodies from. A reader must also see bodies left by a PREVIOUS sink.
 *
 * Resolving a reader through the writer's single-answer function is what made investigate_burn
 * report "nothing burned here" during a 2.3M tok/min burn (2026-07-23, TRDD-8N3KQW2R): it read
 * the hardcoded dir — 0 files, because the corpus had finished draining. Hence: every existing
 * candidate, and an explicit list of the missing ones so the caller can say WHY it is blind instead
 * of saying "nothing".
 */
export function resolveBodiesReadScope(dataDir: string): BodiesReadScope {
  const candidates = [...new Set([effectiveBodiesDir(dataDir)])]
  const dirs: string[] = []
  const missing: string[] = []
  for (const d of candidates) {
    // A dir that exists but is unreadable is as blind as an absent one — treat both as missing.
    let ok = false
    try { ok = fs.statSync(d).isDirectory() } catch { ok = false }
    ;(ok ? dirs : missing).push(d)
  }
  return { dirs, missing, spoolConfigured: false }
}
