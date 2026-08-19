// The three pure derivations of the dashboard update payload (SSE `update` frames and the inlined
// first paint) — moved verbatim out of standalone/server.ts (TRDD-DMWOBWFH P4f) so the Rust port's
// TS-oracle harness can drive them without booting a server. Each is a PURE function of
// (summary, spans[, now]); server.ts memoizes computeSidebarData/computeAnalyticsData on
// dataVersion and deliberately NOT computeSidebarPayload (it reads the clock — isActive /
// lastActivityMs / burnRate).
import type { Span } from './shared/telemetryTypes'
import type { summarizeSpans } from './spanSummarizer'
import { calcTokenCostUsd } from './shared/pricing'
import { contextTokens } from './shared/tokenBuckets'

type Summary = ReturnType<typeof summarizeSpans>

export function computeSidebarPayload(summary: Summary, allSpans: Span[], nowMs: number = Date.now()) {
  const sessions = summary.sessions
  // newest-first (summarizeSpans returns in arbitrary order — sort by startTime)
  const sorted = [...sessions].sort((a, b) =>
    Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')
  )
  const latest = sorted[0] ?? null

  const AGENT_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sorted.map(s => s.source).filter(Boolean))]
    .sort((a, b) => {
      const ai = AGENT_ORDER.indexOf(a), bi = AGENT_ORDER.indexOf(b)
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })

  // Activity: most recent span received
  let lastMs = 0
  for (const span of allSpans) {
    const ms = span.receivedAt ?? 0
    if (ms > lastMs) lastMs = ms
  }
  const isActive = lastMs > 0 && (nowMs - lastMs) < 20_000

  // Per-turn CONTEXT size for the sidebar sparkline. Entries carry the four disjoint buckets
  // (inputTokens is only the raw uncached share since the 2026-07-10 entry normalization), so the
  // turn's prompt size is derived as input + cacheRead + cacheCreation via the shared helper.
  const turnInputTokens = latest
    ? (latest.timeline ?? [])
        .filter(e => e.type === 'llm' && contextTokens(e) > 0)
        .map(e => contextTokens(e))
    : []

  // Simple burn rate estimate for active sessions
  let burnRate: { tokensPerMinute: number; costPerHour: number } | null = null
  if (latest && isActive && latest.durationMs > 10_000) {
    const totalTokens = latest.inputTokens + latest.outputTokens
    const tpm = (totalTokens / latest.durationMs) * 60_000
    burnRate = { tokensPerMinute: Math.round(tpm), costPerHour: 0 }
  }

  const avgInputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.inputTokens, 0) / sorted.length : 1
  const avgOutputTokens = sorted.length > 0
    ? sorted.reduce((s, x) => s + x.outputTokens, 0) / sorted.length : 1

  const currentSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    userRequest: latest.userRequest || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
    durationMs: latest.durationMs,
    startTime: latest.startTime,
    turnInputTokens,
    inputTokens: latest.inputTokens,
    outputTokens: latest.outputTokens,
    cacheReadTokens: latest.cacheReadTokens,
    cacheCreateTokens: latest.cacheCreateTokens,
    // inputTokens IS the raw uncached input since the 2026-07-10 one-convention fix (four
    // disjoint buckets) — the old subtraction here would zero the input component out.
    costUsd: calcTokenCostUsd(
      latest.inputTokens,
      latest.cacheReadTokens,
      latest.cacheCreateTokens,
      latest.outputTokens,
      latest.model,
    ),
  } : null

  return { isActive, lastActivityMs: lastMs, sessionCount: sessions.length, agentSources, currentSession, burnRate, avgInputTokens, avgOutputTokens }
}

// Legacy shape kept for data the Preact dashboard still reads
export function computeSidebarData(summary: Summary, _allSpans: Span[]) {
  const sessions = summary.sessions

  const filesSet = new Set<string>()
  let errorCount = 0
  for (const sess of sessions) {
    for (const f of sess.filesChanged) filesSet.add(f)
    errorCount += sess.errors
  }
  const cacheHitPct = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.cacheHitRate, 0) / sessions.length * 100) : 0
  const avgTurns = sessions.length > 0
    ? Math.round(sessions.reduce((a, s) => a + s.totalLlmCalls, 0) / sessions.length * 10) / 10 : 0

  const AGENT_KEY_ORDER = ['copilot', 'claude_code', 'codex']
  const agentSources = [...new Set(sessions.map(s => s.source).filter(Boolean))].sort((a, b) => {
    const ai = AGENT_KEY_ORDER.indexOf(a), bi = AGENT_KEY_ORDER.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const totalToolCalls = sessions.reduce((s, sess) => s + sess.totalToolCalls, 0)
  const latest = sessions.length > 0 ? sessions[sessions.length - 1] : null
  const latestSession = latest ? {
    source: latest.source,
    model: latest.model || '',
    totalLlmCalls: latest.totalLlmCalls,
    totalToolCalls: latest.totalToolCalls,
    durationMs: latest.durationMs,
    errors: latest.errors,
    cacheHitRate: latest.cacheHitRate,
  } : null

  return {
    sessionCount: sessions.length,
    turnCount: sessions.reduce((s, sess) => s + sess.totalLlmCalls, 0),
    totalInputTokens: sessions.reduce((s, sess) => s + sess.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, sess) => s + sess.outputTokens, 0),
    filesChangedCount: filesSet.size,
    errors: errorCount,
    totalToolCalls,
    cacheHitPct,
    avgTurns,
    agentSources,
    latestSession,
  }
}

export function computeAnalyticsData(sessions: Summary['sessions']) {
  const dayMap: Record<string, { totalTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; costUsd: number; sessionCount: number }> = {}
  for (const sess of sessions) {
    if (!sess.startTime) continue
    const d = new Date(sess.startTime)
    if (isNaN(d.getTime())) continue
    const day = d.toISOString().slice(0, 10)
    if (!dayMap[day]) dayMap[day] = { totalTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0, sessionCount: 0 }
    const r = dayMap[day]
    r.totalTokens += sess.inputTokens
    r.outputTokens += sess.outputTokens
    r.cacheReadTokens += sess.cacheReadTokens
    r.cacheCreateTokens += sess.cacheCreateTokens
    r.sessionCount++
  }
  const dailyStats = Object.entries(dayMap).map(([day, r]) => ({ day, ...r })).sort((a, b) => a.day.localeCompare(b.day))
  const totalTokens = sessions.reduce((s, sess) => s + sess.inputTokens + sess.outputTokens, 0)
  // Loop, never Math.min/max(...times): `times` is one entry per session in the live window (up to
  // ~100k), and spreading a large array into a CALL blows V8's max-arguments limit — the exact
  // RangeError class fixed across the summarizers in 9da7609 (TRDD-2YP3DB9Y). This site sits in the
  // same tickBurn→pushUpdate cycle but OUTSIDE the summarizeSpans try/catch, so a throw here would
  // be an uncaught exception, not a logged degradation (found by the TRDD-SUMSPANRE call-graph walk).
  let oldestSessionMs = 0
  let newestSessionMs = 0
  for (const s of sessions) {
    const t = s.startTime ? new Date(s.startTime).getTime() : 0
    if (t <= 0) continue
    if (oldestSessionMs === 0 || t < oldestSessionMs) oldestSessionMs = t
    if (t > newestSessionMs) newestSessionMs = t
  }
  const lifetimeStats = {
    totalSessions: sessions.length,
    totalTokens,
    totalCostUsd: 0,
    oldestSessionMs,
    newestSessionMs,
  }
  return { dailyStats, lifetimeStats }
}
