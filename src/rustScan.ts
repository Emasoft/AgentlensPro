// src/rustScan.ts — exec the Rust `alscan` sidecar for span-store call-event scans
// (TRDD-DMWOBWFH Phase 1: the proven hottest path runs multi-core in Rust; the TS server keeps
// the wire protocol and merely execs the binary).
//
// OPT-IN AND FAIL-FAST: the engine turns on only when AGENTLENS_ALSCAN names the binary
// (published npm installs have no Rust toolchain, so auto-detection would be a lie there).
// Once opted in, a failed exec THROWS — a silent fallback to the TS scan would hide a broken
// deployment behind identical-looking answers at 15× the cost, which is how single-core
// incidents went unnoticed the first time.

import { execFile } from 'child_process'
import * as fs from 'fs'
import type { OtelCallEvent, OtelCompactionEvent, OtelScanCoverage } from './otelCallEvents'
import { dataPath } from './dataDir'
import { npmPlatformBin } from './rustBinResolve'

/** The Rust ScanResult wire shape (serde field names — see rust-core/crates/agentlens-spanstore). */
interface RustScanResult {
  events: Array<{
    ts: number
    session_id: string
    request_id?: string
    model?: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_create_tokens: number
    cost_usd?: number
    query_source?: string
    speed?: string
    effort?: string
    agent_name?: string
  }>
  compactions: Array<{ ts: number; session_id: string; trigger?: string; pre_tokens?: number; post_tokens?: number }>
  spans_scanned: number
  segments_visited: number
}

/** The opted-in binary path, or null when the Rust engine is off. Read per call, not at module
 *  load, so tests (and a daemon restarted with new env) see the current value.
 *
 *  Three opt-in channels:
 *  - AGENTLENS_ALSCAN=/path — per-process override, wins;
 *  - `<dataDir>/bin/alscan` existing — the durable install location, so hook-REVIVED daemons
 *    (which inherit no operator env) keep the engine across restarts. The file only exists
 *    because the operator copied it there, so presence IS the opt-in;
 *  - the `agentlenspro-<platform>` optionalDependency (TRDD-EAK9R8IY) — what a plain
 *    `npm i -g agentlenspro` resolves with no operator action at all. */
export function alscanBin(env: NodeJS.ProcessEnv = process.env, installed = dataPath('bin', 'alscan')): string | null {
  const v = env.AGENTLENS_ALSCAN?.trim()
  if (v) return v
  try {
    if (fs.statSync(installed).isFile()) return installed
  } catch {
    // fall through to the npm platform package
  }
  return npmPlatformBin('alscan')
}

/** Same answer shape as scanOtelCallEvents, computed by the Rust binary. Throws on any exec or
 *  parse failure — the caller opted into this engine, so a broken binary must be LOUD. */
export async function rustScanCallEvents(bin: string, opts: {
  spansDir: string
  sinceMs: number
  untilMs: number
  windowHours?: number
}): Promise<{ events: OtelCallEvent[]; compactions: OtelCompactionEvent[]; coverage: OtelScanCoverage }> {
  const args = [opts.spansDir, '--since', String(opts.sinceMs), '--until', String(opts.untilMs), '--json']
  const stdout = await new Promise<string>((resolve, reject) => {
    // maxBuffer sized for a full-history scan of a multi-year store (240k events ≈ 50MB JSON).
    execFile(bin, args, { maxBuffer: 1 << 29 }, (err, out, stderr) => {
      if (err) reject(new Error(`alscan failed (${bin}): ${err.message}${stderr ? ` — ${stderr.trim()}` : ''}`))
      else resolve(out)
    })
  })
  const r = JSON.parse(stdout) as RustScanResult
  const events: OtelCallEvent[] = r.events.map(e => ({
    ts: e.ts,
    sessionId: e.session_id,
    requestId: e.request_id,
    model: e.model,
    inputTokens: e.input_tokens,
    outputTokens: e.output_tokens,
    cacheReadTokens: e.cache_read_tokens,
    cacheCreateTokens: e.cache_create_tokens,
    costUsd: e.cost_usd ?? null,
    querySource: e.query_source,
    speed: e.speed,
    effort: e.effort,
    agentName: e.agent_name,
  }))
  const compactions: OtelCompactionEvent[] = r.compactions.map(c => ({
    ts: c.ts,
    sessionId: c.session_id,
    trigger: c.trigger,
    preTokens: c.pre_tokens,
    postTokens: c.post_tokens,
  }))
  return {
    events,
    compactions,
    coverage: {
      spansDir: opts.spansDir,
      windowHours: opts.windowHours,
      spansScanned: r.spans_scanned,
      apiRequests: events.length,
      compactions: compactions.length,
      note: `Rust engine (alscan): ${r.segments_visited} segment(s) scanned multi-core`,
    },
  }
}
