// src/rustLogScan.ts — exec the Rust `allogscan` sidecar for the Claude transcript boot scan
// (TRDD-DMWOBWFH Phase 2). Same engine contract as rustScan.ts (P1): explicit opt-in, loud
// failure, no silent TS fallback once opted in.
//
// The division of labor is one-source-of-truth driven (see rust-core/crates/agentlens-logscan):
// Rust does the per-line CPU work and emits the card plus three raw materials; THIS module owns
// the post-processing that must not be duplicated into a second implementation:
//   - accountId       → the live CallBodyRegistry (process-local state Rust cannot see)
//   - speedBlendedCostUsd → priced from blendTurns against src/shared/pricing.ts (the ONE table)
//   - generated files → attachGeneratedFiles (fs heuristics live in src/generatedFiles.ts)
//   - hot-age strip   → stripTimeline (Date.now-dependent, same clock as the TS parser)

import { execFile, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { LogSessionResult } from './logReader'
import type { SessionSummaryCard } from './shared/summarizerTypes'
import { calcTokenCostUsd } from './shared/pricing'
import { attachGeneratedFiles, type HarvestedGeneratedFile } from './generatedFiles'
import { stripTimeline, timelineHotAgeMs } from './timelineRetention'
import { callBodyRegistry } from './rawBodyContext'
import { dataPath } from './dataDir'

interface RustBlendTurn {
  model: string
  fast: boolean
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

interface RustParsedTranscript {
  file: string
  workspace: string
  card: SessionSummaryCard
  childCards?: SessionSummaryCard[]
  genFiles?: Array<{ path: string; spanId?: string }>
  blendTurns?: RustBlendTurn[]
  lastTimestampMs: number
  fileSizeBytes: number
}

/** The opted-in binary path, or null when the Rust log engine is off. Same two explicit channels
 *  as alscanBin (env wins; the installed file at <dataDir>/bin/allogscan IS the durable opt-in). */
export function allogscanBin(env: NodeJS.ProcessEnv = process.env, installed = dataPath('bin', 'allogscan')): string | null {
  const v = env.AGENTLENS_ALLOGSCAN?.trim()
  if (v) return v
  try {
    return fs.statSync(installed).isFile() ? installed : null
  } catch {
    return null
  }
}

/** Post-process ONE Rust result into the exact shape _parseClaudeFile returns. Exported so the
 *  parity test can drive it on captured output without spawning the binary. */
export function finishRustTranscript(r: RustParsedTranscript, nowMs = Date.now()): LogSessionResult {
  const card = r.card
  // accountId — same unconditional lookup as _buildCard; undefined drops at serialization.
  const accountId = callBodyRegistry.accountFor(card.sessionId)
  if (accountId) card.accountId = accountId
  // speedBlendedCostUsd — only ever attached for a MIXED-speed session (Rust emits blendTurns
  // exactly then), priced per turn at that turn's own (model, speed) against the one table.
  if (r.blendTurns) {
    card.speedBlendedCostUsd = r.blendTurns.reduce(
      (sum, t) => sum + calcTokenCostUsd(t.input, t.cacheRead, t.cacheCreate, t.output, t.model), 0)
  }
  // Generated files — reconstruct the harvest map (insertion order preserved by the NDJSON array).
  const harvested = new Map<string, HarvestedGeneratedFile>()
  for (const g of r.genFiles ?? []) harvested.set(g.path, { spanId: g.spanId })
  attachGeneratedFiles(card, harvested)
  // Hot-age strip — cold sessions must leave the parser without a timeline (TRDD-66IXMIGN).
  const lastMs = r.lastTimestampMs
  if (Number.isFinite(lastMs) && lastMs > 0 && nowMs - lastMs > timelineHotAgeMs()) {
    stripTimeline(card)
  }
  return {
    workspace: r.workspace,
    card,
    childCards: r.childCards && r.childCards.length > 0 ? r.childCards : undefined,
  }
}

/** One cold-scanned file's outcome, with the byte length the Rust engine actually parsed so the
 *  caller can seed its fileState gate (LogReader owns that map; this module never touches it). */
export interface RustColdScanItem {
  file: string
  fileSizeBytes: number
  result: LogSessionResult
}

/** Synchronous batch parse for the boot sweep — LogReader's scan path is synchronous, and the
 *  file list rides a temp file because a 13k-file boot batch exceeds ARG_MAX as argv.
 *  Throws on exec failure — opted-in means loud, never a silent fall-through to the TS loop. */
export function rustScanColdFilesSync(bin: string, files: string[], opts: { codex?: boolean } = {}): RustColdScanItem[] {
  const listFile = path.join(os.tmpdir(), `allogscan-list-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(listFile, files.join('\n') + '\n')
  // Cold cards older than the hot age lose their timeline INSIDE the binary — same parse-time
  // strip the TS parser applies (TRDD-66IXMIGN), and what keeps the NDJSON pipeable: the
  // unstripped 12,928-card corpus measured 1.2GB (ENOBUFS on any sane maxBuffer); stripped it
  // is tens of MB. finishRustTranscript's own strip stays as the idempotent boundary catch.
  const cutoff = Date.now() - timelineHotAgeMs()
  const argv = ['--files-from', listFile, '--strip-older-than-ms', String(cutoff)]
  if (opts.codex) argv.push('--codex')
  let stdout: string
  try {
    stdout = execFileSync(bin, argv, { maxBuffer: 1 << 30 }).toString()
  } catch (err) {
    throw new Error(`allogscan failed (${bin}): ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try { fs.unlinkSync(listFile) } catch { /* tmp file; best-effort */ }
  }
  const now = Date.now()
  const out: RustColdScanItem[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parsed = JSON.parse(line) as RustParsedTranscript
    out.push({
      file: parsed.file,
      fileSizeBytes: parsed.fileSizeBytes,
      result: finishRustTranscript(parsed, now),
    })
  }
  return out
}

/** Parse transcripts through the Rust engine. Throws on any exec failure — opted-in means loud. */
export async function rustParseTranscripts(bin: string, args: { files?: string[]; dir?: string }): Promise<LogSessionResult[]> {
  const argv: string[] = []
  if (args.dir) argv.push('--dir', args.dir)
  for (const f of args.files ?? []) argv.push(f)
  const stdout = await new Promise<string>((resolve, reject) => {
    // maxBuffer sized for a whole-machine boot scan (12,928 cards ≈ 200MB NDJSON measured).
    execFile(bin, argv, { maxBuffer: 1 << 30 }, (err, out, stderr) => {
      if (err) reject(new Error(`allogscan failed (${bin}): ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`))
      else resolve(out)
    })
  })
  const now = Date.now()
  const results: LogSessionResult[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    results.push(finishRustTranscript(JSON.parse(line) as RustParsedTranscript, now))
  }
  return results
}
