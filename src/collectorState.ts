// TRDD-PJC8N1HO — durable collector state for zero-loss restart + downtime visibility.
//
//   • Log tail offsets (spec 3): the LogReader's per-file byte offsets are persisted here so a
//     restart resumes tailing instantly. Unchanged files (offset+mtime+size match) are then SKIPPED
//     entirely on the first post-restart scan instead of being re-parsed from byte 0 — turning a
//     minutes-long cold rescan of ~12k files into an incremental no-op.
//   • Lifecycle / downtime gaps (spec 2): the collector records a start marker on boot and a periodic
//     heartbeat; a graceful stop records a stop marker. The interval between one run's last-known-alive
//     time and the next run's start is a DOWNTIME GAP — every OTEL export in it was dropped by the
//     agents' exporters and is lost forever. computeCollectorGaps() turns the run log into the explicit
//     gap list the dashboard renders as an "offline HH:MM–HH:MM — telemetry lost" band and
//     get_recent_sessions returns as `collectorGaps`.
//
// All writes go through atomicWriteFileSync so a crash mid-write can never corrupt these files.
import * as fs from 'fs'
import { atomicWriteFileSync } from './serverRuntime'
import type { CollectorGap, SessionSummaryCard } from './shared/summarizerTypes'

// ── Ingest-semantics version (single source — SQLite db.ts imports this) ─────
// Bump when log-ingest semantics change in a way that makes previously-persisted cards stale.
// The SQLite path wipes data_source='log' rows (db.ts reIngestLogRowsIfStale); the standalone's
// sidecars (offsets + stripped cards) are version-stamped with this and IGNORED on mismatch, so
// the next boot cold-rescans every transcript and rebuilds all cards with the current semantics.
//   v2 (TRDD-TKN5VALS): per-turn `turn` index + de-inflated input_tokens + sub-agent rollup.
//   v3: sub-agent child cards switched to incl-cache inputTokens (later found to be the WRONG
//       target — the parent card was always raw).
//   v4: async-launch child cards synthesized (spawn_async linkage, zero buckets).
//   v5: inputTokens normalized to RAW disjoint-buckets on every card family (the 2026-07-10
//       OTEL-vs-JSONL discrepancy fix); sub cards store sub.input as-is.
export const LOG_INGEST_VERSION = 5

// ── Log tail offsets ──────────────────────────────────────────────────────────

/** One persisted per-file tail record. Mirror of LogReader's internal FileState (kept structurally
 *  identical so import/export is a plain assignment). `ino`+`size` give file identity so a rotated /
 *  replaced file (same path, new inode) is detected and re-read from 0 rather than resumed wrongly. */
export interface PersistedFileState {
  bytesRead: number
  mtimeMs: number
  ino?: number
  size?: number
}

/** Read the persisted offset map. Returns null (→ full cold scan, the safe fallback) when the file is
 *  missing, malformed, or from a DIFFERENT ingest version — resuming version-stale offsets would skip
 *  unchanged files whose cards were built under old semantics, silently freezing the old numbers. A
 *  legacy unversioned file (plain map) is treated as version-stale for the same reason. */
export function loadLogOffsets(file: string): Record<string, PersistedFileState> | null {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const wrapper = parsed as { v?: unknown; offsets?: unknown }
  if (wrapper.v !== LOG_INGEST_VERSION || !wrapper.offsets || typeof wrapper.offsets !== 'object') return null
  const out: Record<string, PersistedFileState> = {}
  for (const [k, v] of Object.entries(wrapper.offsets as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    // Fail-fast on a record missing the two load-bearing numbers — skip it (→ that file cold-reads),
    // rather than trusting a partial record.
    if (typeof r.bytesRead !== 'number' || typeof r.mtimeMs !== 'number') continue
    out[k] = {
      bytesRead: r.bytesRead,
      mtimeMs: r.mtimeMs,
      ino: typeof r.ino === 'number' ? r.ino : undefined,
      size: typeof r.size === 'number' ? r.size : undefined,
    }
  }
  return out
}

/** Persist the offset map atomically, stamped with the current ingest version. */
export function saveLogOffsets(file: string, offsets: Record<string, PersistedFileState>): void {
  atomicWriteFileSync(file, JSON.stringify({ v: LOG_INGEST_VERSION, offsets }))
}

// ── Persisted log-session cards (fast restart) ─────────────────────────────────
//
// The offset map alone can't give a fast restart: log-session cards live only in memory, and the
// offset-skip means unchanged files are NOT re-read (so their cards would be missing). So we also
// persist a LIGHT (timeline/fileOps-stripped) copy of every log card. On restart the dashboard list +
// MCP get_recent_sessions are populated instantly from this file, and the heavy per-step
// timeline/history is re-parsed on demand (LogReader.reparseSession) only when a session is actually
// drilled. The stripped cards are small (~1-2 KB each), so this file stays a few tens of MB even with
// ~14k sessions — unlike the full cards, which don't even fit in one V8 string.

/** Read the persisted stripped cards. null when missing, malformed, or from a different ingest
 *  version (→ fall back to a cold rescan that rebuilds every card with current semantics). A legacy
 *  unversioned file (bare array) is version-stale by definition. */
export function loadPersistedCards(file: string): SessionSummaryCard[] | null {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  const wrapper = parsed as { v?: unknown; cards?: unknown }
  if (!wrapper || typeof wrapper !== 'object' || wrapper.v !== LOG_INGEST_VERSION || !Array.isArray(wrapper.cards)) return null
  return wrapper.cards.filter((c): c is SessionSummaryCard =>
    !!c && typeof c === 'object' && typeof (c as SessionSummaryCard).sessionId === 'string')
}

/** Persist the stripped cards atomically, stamped with the current ingest version. */
export function savePersistedCards(file: string, cards: SessionSummaryCard[]): void {
  atomicWriteFileSync(file, JSON.stringify({ v: LOG_INGEST_VERSION, cards }))
}

// ── Collector lifecycle / downtime gaps ────────────────────────────────────────

export interface LifecycleRun {
  startedAt: string          // ISO — process boot
  lastHeartbeat: string      // ISO — last periodic tick while alive (approximates a crash time)
  stoppedAt?: string         // ISO — set only on a GRACEFUL shutdown (SIGINT/SIGTERM)
}

export interface LifecycleStore {
  runs: LifecycleRun[]
}

// Keep the run log bounded so this file can't grow without limit on a long-lived, frequently-restarted
// collector (the supervisor restarts it on every crash).
const MAX_RUNS = 200

function loadLifecycle(file: string): LifecycleStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as LifecycleStore).runs)) {
      return { runs: (parsed as LifecycleStore).runs.filter(r => r && typeof r.startedAt === 'string') }
    }
  } catch { /* missing/corrupt — start fresh */ }
  return { runs: [] }
}

/** Append a fresh run marker (this boot) and persist. Returns the updated store so the caller holds the
 *  current run reference for heartbeats/stop. */
export function recordCollectorStart(file: string, now = new Date()): LifecycleStore {
  const store = loadLifecycle(file)
  const iso = now.toISOString()
  store.runs.push({ startedAt: iso, lastHeartbeat: iso })
  if (store.runs.length > MAX_RUNS) store.runs = store.runs.slice(-MAX_RUNS)
  try { atomicWriteFileSync(file, JSON.stringify(store)) } catch { /* non-fatal: lifecycle is advisory */ }
  return store
}

/** Update the current (last) run's heartbeat in place and persist. A crash leaves lastHeartbeat at the
 *  last tick, so the gap after it is attributed to a crash (no stoppedAt). */
export function recordCollectorHeartbeat(file: string, store: LifecycleStore, now = new Date()): void {
  const run = store.runs[store.runs.length - 1]
  if (!run) return
  run.lastHeartbeat = now.toISOString()
  try { atomicWriteFileSync(file, JSON.stringify(store)) } catch { /* non-fatal */ }
}

/** Record a graceful stop on the current run and persist. */
export function recordCollectorStop(file: string, store: LifecycleStore, now = new Date()): void {
  const run = store.runs[store.runs.length - 1]
  if (!run) return
  run.stoppedAt = now.toISOString()
  run.lastHeartbeat = run.stoppedAt
  try { atomicWriteFileSync(file, JSON.stringify(store)) } catch { /* non-fatal */ }
}

/**
 * Turn the run log into explicit downtime gaps. A gap spans from one run's last-known-alive time
 * (stoppedAt if it shut down cleanly, else lastHeartbeat) to the NEXT run's startedAt. Only gaps
 * longer than `minGapMs` are reported (a clean supervised restart is sub-second and carries no lost
 * telemetry worth flagging). A gap with no prior stoppedAt is a crash; otherwise a clean shutdown.
 */
export function computeCollectorGaps(store: LifecycleStore, minGapMs = 15_000): CollectorGap[] {
  const gaps: CollectorGap[] = []
  const runs = store.runs
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]
    const cur = runs[i]
    const downSince = prev.stoppedAt ?? prev.lastHeartbeat
    const downStartMs = Date.parse(downSince)
    const downEndMs = Date.parse(cur.startedAt)
    if (!(downEndMs > downStartMs)) continue
    const durationMs = downEndMs - downStartMs
    if (durationMs < minGapMs) continue
    gaps.push({
      startedAt: new Date(downStartMs).toISOString(),
      endedAt: new Date(downEndMs).toISOString(),
      durationMs,
      reason: prev.stoppedAt ? 'shutdown' : 'crash',
    })
  }
  return gaps
}
