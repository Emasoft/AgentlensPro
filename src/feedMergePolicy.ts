import type { SessionSummaryCard } from './shared/summarizerTypes'

/**
 * Feed-collision doctrine — which data source wins when a LOG card and an OTEL card
 * exist for the SAME sessionId (Phase B of the token-feed fix; measurement in
 * reports/token-discrepancy/20260710_141134+0200-otel-vs-jsonl.md §4bis/§5.6).
 *
 * For CLAUDE sessions the LOG transcript card wins: transcripts are durable and
 * call-complete for the conversation, while the OTEL feed is a lossy LOWER BOUND
 * (collector downtime drops calls entirely; the standalone summarizes a rolling
 * time window, so a long session's early calls age out of its live card; and before
 * the P4 segmented store the MAX_SPANS eviction destroyed history outright — all
 * mechanisms measured), and its totals include sub-agent calls
 * the log parent card intentionally excludes (those are served as their own child
 * cards). OTEL-only sessions (no transcript, e.g. background utility traffic) still
 * serve. Every other source keeps the original "OTEL wins" rule — their OTEL feed is
 * richer than their logs and has no measured loss mechanism.
 *
 * This module is the single source of truth for the doctrine; the standalone server,
 * the extension's SessionRepository merge/dedup, and the DatabaseWriter write guard
 * all derive their behavior from it. Do not re-encode the preference inline anywhere.
 */
export function preferredDataSource(source: SessionSummaryCard['source']): 'otel' | 'log' {
  return source === 'claude_code' ? 'log' : 'otel'
}

/**
 * Merges the OTEL-derived session list with the log-derived one under the doctrine
 * above. On a sessionId collision the source's preferred feed wins and the other
 * card is dropped; non-colliding cards from both feeds are all kept. Order is not
 * guaranteed — callers sort.
 *
 * Note this only fires for Claude since the summarizer started keying OTEL Claude
 * cards by the transcript UUID (session.id attr): before that the two key spaces
 * were disjoint (interaction spanId / synth-<traceId> vs UUID) and one session was
 * served as 1 log card + N per-trace OTEL cards with different totals.
 */
export function mergeOtelAndLogSessions(
  otelSessions: SessionSummaryCard[],
  logSessions: SessionSummaryCard[],
): SessionSummaryCard[] {
  if (logSessions.length === 0) { return otelSessions }
  // Log-preferred ids: log cards whose source prefers the log feed (Claude).
  const logWinsIds = new Set(
    logSessions.filter(s => preferredDataSource(s.source) === 'log').map(s => s.sessionId)
  )
  const keptOtel = otelSessions.filter(s => !(s.dataSource === 'otel' && logWinsIds.has(s.sessionId)))
  const keptOtelIds = new Set(keptOtel.map(s => s.sessionId))
  const keptLog = logSessions.filter(s => !keptOtelIds.has(s.sessionId))
  return [...keptLog, ...keptOtel]
}
