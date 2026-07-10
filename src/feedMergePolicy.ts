import type { SessionSummaryCard, TokensSource } from './shared/summarizerTypes'

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

// ── Token-provenance stamping (P7) ────────────────────────────────────────────
// tokensSource/coverageNote are stamped HERE, at the decision points where a collision winner is
// chosen, so the provenance always matches the doctrine that picked the numbers. The stamps are
// idempotent (re-stamped on every merge pass) and self-correcting: a log card whose OTEL twin
// later ages out of the span window loses the displacement note on the next pass instead of
// carrying it stale.

/** Note attached to a log card that WON a collision — its OTEL twin's slices were displaced. */
export const OTEL_DISPLACED_NOTE =
  'Token totals come from the log transcript; the colliding OTEL card for this session was displaced (OTEL is a lossy lower bound).'

/** Stamps the log-wins collision outcome: the log transcript's totals serve; OTEL was displaced. */
export function stampLogWins(logCard: SessionSummaryCard): void {
  logCard.tokensSource = 'log'
  logCard.coverageNote = OTEL_DISPLACED_NOTE
}

/**
 * Stamps an identity-dedup winner that absorbed a twin from the OTHER feed — the one genuinely
 * MERGED outcome: the served card's identity/fields combine both feeds (token buckets were
 * byte-identical across them, which is what made them twins). Same-feed absorptions are NOT a
 * cross-feed merge and keep the winner's existing stamp untouched.
 */
export function stampIdentityMerge(winner: SessionSummaryCard, loser: SessionSummaryCard): void {
  if (winner.dataSource === loser.dataSource) { return }
  winner.tokensSource = 'merged'
  winner.coverageNote =
    `Identity-merged across feeds: this ${winner.dataSource} card absorbed its ${loser.dataSource} twin (identical token buckets in both feeds).`
}

/** Plain (non-collision) stamp: the card serves on its own feed's numbers, nothing displaced. */
function stampPlain(card: SessionSummaryCard, source: TokensSource): void {
  card.tokensSource = source
  card.coverageNote = undefined
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
  if (logSessions.length === 0) {
    // No log feed at all — every OTEL card serves on OTEL numbers (the OTEL-only outcome).
    for (const s of otelSessions) { stampPlain(s, 'otel') }
    return otelSessions
  }
  // Log-preferred ids: log cards whose source prefers the log feed (Claude).
  const logWinsIds = new Set(
    logSessions.filter(s => preferredDataSource(s.source) === 'log').map(s => s.sessionId)
  )
  const otelIds = new Set(otelSessions.map(s => s.sessionId))
  const keptOtel = otelSessions.filter(s => !(s.dataSource === 'otel' && logWinsIds.has(s.sessionId)))
  const keptOtelIds = new Set(keptOtel.map(s => s.sessionId))
  const keptLog = logSessions.filter(s => !keptOtelIds.has(s.sessionId))
  // P7 provenance — stamp each kept card with the outcome that selected it: an OTEL card serves
  // on OTEL numbers (OTEL-only, or OTEL-wins for non-Claude sources); a log card that displaced
  // an OTEL twin is the log-wins outcome (note the displacement); a log-only card serves plain.
  for (const s of keptOtel) { stampPlain(s, 'otel') }
  for (const s of keptLog) {
    if (otelIds.has(s.sessionId)) { stampLogWins(s) } else { stampPlain(s, 'log') }
  }
  return [...keptLog, ...keptOtel]
}
