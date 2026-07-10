import * as fs from 'fs'
import { joinUri, FileType, type UriLike, type DirBlobFs } from './vscodeCompat'
import { SessionStore } from './sessionStore'
import { DatabaseReader, type DailyStatRow, type LifetimeStats, type SearchQuery, type BurnRate, type Projection } from './database/reader'
import { DatabaseWriter } from './database/writer'
import { summarizeSpans } from './spanSummarizer'
import { preferredDataSource } from './feedMergePolicy'
import { lookupRates } from './pricing'
import type { SessionSummaryCard, TimelineEntry, GeneratedFileRef } from './summarizers/summarizerTypes'

export type { DailyStatRow, LifetimeStats, SearchQuery, BurnRate, Projection }

/**
 * For OTEL sessions missing workspace: look for a log session of the same source
 * that started within the same minute and borrow its workspace. Uses 1-minute
 * buckets keyed by source+bucket; if two log sessions in the same bucket have
 * different workspaces the entry is marked ambiguous and skipped.
 */
export function resolveWorkspacesFromLogs(sessions: SessionSummaryCard[]): void {
  // null sentinel = ambiguous (two different workspaces in the same bucket)
  const wsMap = new Map<string, string | null>()
  for (const s of sessions) {
    if (!s.workspace || s.dataSource !== 'log') { continue }
    const t = Date.parse(s.startTime)
    if (!t) { continue }
    const bucket = Math.floor(t / 60000)
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const key = `${s.source}:${b}`
      const existing = wsMap.get(key)
      if (existing === undefined) {
        wsMap.set(key, s.workspace)
      } else if (existing !== s.workspace) {
        wsMap.set(key, null)
      }
    }
  }
  for (const s of sessions) {
    if (s.workspace || s.dataSource !== 'otel') { continue }
    const t = Date.parse(s.startTime)
    if (!t) { continue }
    const bucket = Math.floor(t / 60000)
    const ws = wsMap.get(`${s.source}:${bucket}`)
    if (ws) { s.workspace = ws }
  }
}

/**
 * Session-identity dedup (TRDD-ZK37VG4X spec 2). The id-level merge above/below only collapses
 * cards with the SAME sessionId, but the fleet audit found the same underlying session appearing
 * under TWO ids: a `synth-*` OTEL placeholder next to its real transcript id, and id-drifted
 * twins with byte-identical usage. Those double-count every token in the list views.
 *
 * A card's identity fingerprint is (source, model, all four token buckets). Two cards with the
 * same fingerprint, non-zero traffic, and start times within 10 minutes are the same session —
 * four exact token-bucket collisions across genuinely different sessions are not plausible
 * (all-zero cards are excluded precisely because THEY collide all the time).
 *
 * Winner selection: the source's PREFERRED feed wins (feedMergePolicy.ts — for Claude the log
 * transcript beats OTEL because OTEL is a measured lossy lower bound; every other source keeps
 * OTEL-beats-log), then the richer timeline, then the longer duration. The REAL id always beats
 * a `synth-*` placeholder regardless of which card wins on data (re-keying the synth card onto
 * its correlated real id), and the loser's id is recorded in `mergedFrom` so the merge is
 * auditable rather than silent. Fields the winner is missing (workspace, prompt, model) are
 * borrowed from the loser.
 */
export function dedupeSessionIdentities(sessions: SessionSummaryCard[]): SessionSummaryCard[] {
  const IDENTITY_WINDOW_MS = 10 * 60_000
  const fingerprint = (s: SessionSummaryCard): string | null => {
    const traffic = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreateTokens
    if (!(traffic > 0)) { return null }  // zero/NaN traffic → no reliable identity signal
    return `${s.source}|${s.model}|${s.inputTokens}|${s.outputTokens}|${s.cacheReadTokens}|${s.cacheCreateTokens}`
  }
  const isSynth = (id: string) => id.startsWith('synth-')
  const richness = (s: SessionSummaryCard) => (s.timeline?.length ?? 0)

  const out: SessionSummaryCard[] = []
  const slotByFp = new Map<string, number>()  // fingerprint → index in `out` of the canonical card
  for (const s of sessions) {
    const fp = fingerprint(s)
    if (fp === null) { out.push(s); continue }
    const slot = slotByFp.get(fp)
    if (slot === undefined) { slotByFp.set(fp, out.length); out.push(s); continue }
    const prior = out[slot]
    const dt = Math.abs(Date.parse(prior.startTime) - Date.parse(s.startTime))
    // NaN-safe: an unparseable startTime fails the <= check and the cards stay separate.
    if (!(dt <= IDENTITY_WINDOW_MS)) { out.push(s); continue }

    let winner = prior
    let loser = s
    // The fingerprint includes `source`, so prior.source === s.source — one preference applies.
    const preferredDs = preferredDataSource(s.source)
    const priorScore = (prior.dataSource === preferredDs ? 2 : 0) + (richness(prior) >= richness(loser) ? 1 : 0)
    const sScore = (s.dataSource === preferredDs ? 2 : 0) + (richness(s) > richness(prior) ? 1 : 0)
    if (sScore > priorScore || (sScore === priorScore && s.durationMs > prior.durationMs)) {
      winner = s
      loser = prior
    }
    // Re-key: the real transcript id is the durable identity — a synth-* placeholder id must
    // never survive a merge with its real twin, or drill-down lookups by id would 404.
    if (isSynth(winner.sessionId) && !isSynth(loser.sessionId)) {
      winner.mergedFrom = [...(winner.mergedFrom ?? []), winner.sessionId]
      winner.sessionId = loser.sessionId
    }
    winner.mergedFrom = [...(winner.mergedFrom ?? []), loser.sessionId].filter(id => id !== winner.sessionId)
    if (!winner.workspace) { winner.workspace = loser.workspace }
    if (!winner.userRequest) { winner.userRequest = loser.userRequest }
    if (!winner.model) { winner.model = loser.model }
    out[slot] = winner
  }
  return out
}

/**
 * Marks sessions whose model has no pricing-table entry (TRDD-ZK37VG4X spec 1 fail-loud).
 * cost_usd for these is 0 in the DB, but 0 here means UNKNOWN, not free — the flag lets the UI
 * badge them and aggregates exclude-but-label them. Derived at read time on purpose: once the
 * missing rate is added to pricing.ts, old sessions price correctly with no backfill.
 */
export function flagUnpricedSessions(sessions: SessionSummaryCard[]): void {
  for (const s of sessions) {
    const traffic = s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreateTokens
    if (traffic > 0 && lookupRates(s.model) === null) { s.unpriced = true }
  }
}

/**
 * Merges historical sessions from SQLite with live sessions from the in-memory
 * span window. Live sessions win on conflict (same sessionId) — they are fresher —
 * EXCEPT when the persisted row comes from the source's preferred feed and the live
 * twin does not (feedMergePolicy.ts): a claude_code log transcript row beats the live
 * OTEL card, because the OTEL feed is a measured lossy lower bound whose totals also
 * include sub-agent calls the log parent card intentionally excludes. Live sessions
 * are always OTEL-derived here, so this exception only ever fires for Claude.
 * Result is sorted by startTime DESC.
 */
export function mergeSessions(
  dbSessions: SessionSummaryCard[],
  liveSessions: SessionSummaryCard[],
): SessionSummaryCard[] {
  const dbById = new Map(dbSessions.map(s => [s.sessionId, s] as const))
  const keptLive = liveSessions.filter(live => {
    const db = dbById.get(live.sessionId)
    if (!db) { return true }
    const preferredDs = preferredDataSource(live.source)
    return !(db.dataSource === preferredDs && live.dataSource !== preferredDs)
  })
  const keptLiveIds = new Set(keptLive.map(s => s.sessionId))
  return [
    ...keptLive,
    ...dbSessions.filter(s => !keptLiveIds.has(s.sessionId)),
  ].sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
}

/**
 * Single access point for session data throughout the extension.
 * Combines DatabaseReader (historical), DatabaseWriter (persistence),
 * and SessionStore (live span window).
 */
export class SessionRepository {
  constructor(
    private readonly reader: DatabaseReader,
    private readonly writer: DatabaseWriter,
    private readonly store: SessionStore,
  ) {}

  /** Returns merged session list: live window + historical DB, sorted newest-first. */
  listSessions(filter?: {
    source?: 'copilot' | 'claude_code' | 'codex' | 'opencode'
    limit?: number
  }): SessionSummaryCard[] {
    const dbSessions = this.reader.listSessions(filter)
    const liveSpans = this.store.getSpans()
    const liveSessions = liveSpans.length > 0 ? summarizeSpans(liveSpans).sessions : []
    const merged = dedupeSessionIdentities(mergeSessions(dbSessions, liveSessions))
    resolveWorkspacesFromLogs(merged)
    flagUnpricedSessions(merged)
    if (filter?.limit !== null && filter?.limit !== undefined && merged.length > filter.limit) {
      return merged.slice(0, filter.limit)
    }
    return merged
  }

  /** Returns full timeline entries for one session (no blob content). */
  loadSessionTimeline(sessionId: string): TimelineEntry[] {
    return this.reader.loadSessionTimeline(sessionId)
  }

  /** Session-level "generated files" group (TRDD-ZS1GDXVY) — scratch discoveries + uncorrelated
   *  referenced outputs; the correlated ones ride on the timeline entries. */
  loadSessionGeneratedFiles(sessionId: string): GeneratedFileRef[] {
    return this.reader.loadSessionGeneratedFiles(sessionId)
  }

  /** Reads one blob file. Returns null if not found. */
  async loadBlob(
    spanId: string,
    field: 'response' | 'thinking' | 'tool-input' | 'full-result' | 'edit-old' | 'edit-new',
    editIndex?: number,
  ): Promise<string | null> {
    return this.reader.loadBlob(spanId, field, editIndex)
  }

  /** Returns daily token + cost stats for the last N days, optionally filtered by source. */
  queryDailyStats(options: { since: number; source?: string }): DailyStatRow[] {
    return this.reader.queryDailyStats(options)
  }

  /** Returns hourly token + cost stats. `day` key is 'YYYY-MM-DD HH' (UTC). */
  queryHourlyStats(options: { since: number; source?: string }): DailyStatRow[] {
    return this.reader.queryHourlyStats(options)
  }

  /** Returns lifetime aggregate stats across all non-sidechain sessions. */
  queryLifetimeStats(): LifetimeStats {
    return this.reader.queryLifetimeStats()
  }

  /** Full-text + filter session search with pagination. */
  searchSessions(query: SearchQuery): { sessions: SessionSummaryCard[]; totalCount: number } {
    const result = this.reader.searchSessions(query)
    flagUnpricedSessions(result.sessions)
    return result
  }

  /** Burn rate for an active session. Returns null if < 2 LLM entries with timestamps. */
  queryBurnRate(sessionId: string): { burnRate: BurnRate; projection: Projection | null } | null {
    return this.reader.queryBurnRate(sessionId)
  }

  /** Returns storage size stats for the DB file and blobs directory. */
  getStorageStats(dbPath: string, blobsDir: string): { dbBytes: number; blobBytes: number; blobCount: number } {
    let dbBytes = 0
    let blobBytes = 0
    let blobCount = 0
    try { dbBytes = fs.statSync(dbPath).size } catch { /* ok */ }
    try {
      const files = fs.readdirSync(blobsDir)
      for (const f of files) {
        try {
          blobBytes += fs.statSync(`${blobsDir}/${f}`).size
          blobCount++
        } catch { /* ok */ }
      }
    } catch { /* ok */ }
    return { dbBytes, blobBytes, blobCount }
  }

  /** Enqueues a session write — thin delegation to DatabaseWriter. */
  enqueue(card: SessionSummaryCard, workspace: string): void {
    this.writer.enqueue(card, workspace)
  }

  /** Waits for all pending DB writes to complete. */
  async drain(): Promise<void> {
    return this.writer.drain()
  }

  /** Writes import cards directly in one transaction, bypassing the async drain. */
  importCards(cards: SessionSummaryCard[]): void {
    this.writer.importCards(cards)
  }

  /** Clears all three SQLite tables. */
  clearAll(): void {
    this.writer.clearAll()
  }

  /** Exposes the raw SessionStore for callers that still need it (e.g. status bar). */
  get store_(): SessionStore {
    return this.store
  }

  /** Exposes onUpdate from the underlying store. */
  onUpdate(fn: (traceId?: string) => void): { dispose(): void } {
    return this.store.onUpdate(fn)
  }

  /** Clears the in-memory span window. */
  clearStore(): void {
    this.store.clear()
  }

  /** Saves the DB to disk (called after each drain for cross-window sync). */
  saveDb(save: () => void): void {
    save()
  }

  /**
   * Deletes all blob files under storageUri/blobs/. Returns count deleted.
   * `blobFs` is injected (named to avoid shadowing the node `fs` import above):
   * the VS Code extension host that supplied vscode.workspace.fs was removed
   * (TRDD-6E6416B8).
   */
  async clearBlobs(storageUri: UriLike, blobFs: DirBlobFs): Promise<number> {
    const blobsUri = joinUri(storageUri, 'blobs')
    let count = 0
    try {
      const entries = await blobFs.readDirectory(blobsUri)
      await Promise.all(
        entries
          .filter(([, type]) => type === FileType.File)
          .map(async ([name]) => {
            try {
              await blobFs.delete(joinUri(blobsUri, name))
              count++
            } catch { /* ignore individual delete failures */ }
          })
      )
    } catch { /* blobs dir absent — nothing to clear */ }
    return count
  }
}
