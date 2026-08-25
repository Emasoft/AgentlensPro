// check_burn_risk — realtime early-warning against token explosions (TRDD-W6UH8LPA).
//
// investigate_burn explains a drained window AFTER the fact; this module warns AS the
// explosion starts, by fusing the three feeds the server already receives in realtime:
//   1. lifecycle hook events (`agentlenspro hook`): SubagentStart bursts = a fan-out is
//      launching NOW; StopFailure = a rate-limit stall just killed a turn (the cache TTL
//      will outlive the stall — resuming a fan-out into it is the measured worst case);
//      PreCompact = a full-prefix rewrite is happening.
//   2. the raw OTEL bodies dir: request files appear at call time, so ≥3 requests >1MB
//      inside 90s means a fat-context fan-out is IN FLIGHT (each is a full-prefix write
//      candidate) — no parsing needed, stat() only.
//   3. the live burn monitor (4s tick): tokens/min spike across accounts.
// Each source can be absent (hooks not installed, bodies sink off) — the report says so
// honestly instead of silently returning "no risk".

import * as fs from 'fs'
import * as path from 'path'
import { readHookEvents, type HookEventRecord } from './hookEventStore'
import { fmtFatSenders, type BodiesActivityReport } from './bodiesActivity'
import { defaultBodiesDir } from './cacheCreationForensics'
import { dataPath } from './dataDir'
import { causingToolCalls, composition, type SpawnCall } from './causingToolCall'

/** WHO spawned, from SubagentStart events (payloads carry session_id/cwd/agent_type):
 *  top-2 spawning sessions with dir + agent types — culprit naming for FANOUT_BURST. */
function fmtStartOrigins(starts: HookEventRecord[], cap = 2): string {
  const by = new Map<string, { cwd: string | null; types: Map<string, number>; count: number }>()
  for (const s of starts) {
    const sid = s.session ?? '?'
    const e = by.get(sid) ?? { cwd: null, types: new Map<string, number>(), count: 0 }
    e.count++
    const cwd = s.payload?.cwd
    if (!e.cwd && typeof cwd === 'string') e.cwd = cwd
    const t = s.payload?.agent_type
    if (typeof t === 'string') e.types.set(t, (e.types.get(t) ?? 0) + 1)
    by.set(sid, e)
  }
  const ranked = [...by.entries()].sort((a, b) => b[1].count - a[1].count)
  const parts = ranked.slice(0, cap).map(([sid, e]) => {
    const where = e.cwd ? ` in …/${e.cwd.split('/').filter(Boolean).pop()}` : ''
    const types = e.types.size > 0
      ? `: ${[...e.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(', ')}`
      : ''
    return `session ${sid.slice(0, 8)}…${where} (${e.count}${types})`
  })
  const more = ranked.length > cap ? `; +${ranked.length - cap} more` : ''
  return parts.length > 0 ? parts.join('; ') + more : ''
}

export interface BurnRisk {
  code: 'FANOUT_BURST' | 'COLD_RESUME_RISK' | 'COMPACTION_REWRITE' | 'HUGE_REQUEST_BURST' | 'BURN_SPIKE' | 'CACHE_THRASH' | 'CAPTURE_DOWN'
  active: boolean
  detail: string
  evidence?: Record<string, unknown>
  /** EVERY spawn call in this risk's window, numbered + verbatim (attached by attachRiskCausingCalls). */
  causingCalls?: SpawnCall[]
  /** Compact composition tally of causingCalls, e.g. "Agent/general-purpose×3, Workflow×2". */
  causingCallsComposition?: string
  /** Why no causing calls could be resolved — honest, never a fabricated call. */
  causingCallsUnavailable?: string
}

export interface BurnRiskReport {
  checkedAtIso: string
  activeCount: number
  risks: BurnRisk[]
  sources: { hookEvents: boolean; bodies: boolean; burnStatus: boolean }
  advice: string | null
}

export interface BurnGuardOptions {
  bodiesDir?: string
  hookEventsDir?: string
  /** The live monitor's status (mcpServer injects getBurnStatus()); null when unavailable.
   *  The per-account budget (when capacity is configured) feeds the remaining-window clause —
   *  the ONE future-looking fact a warning carries. */
  burnStatus?: {
    accountWindows?: {
      fiveMinTokensPerMin?: number
      accountLabel?: string
      budget?: {
        fiveHour?: { minutesToExhaustion?: number | null }
        sevenDay?: { minutesToExhaustion?: number | null }
      }
    }[]
  } | null
  now?: number
  /** SubagentStart count within fanoutWindowMs that trips FANOUT_BURST (default 5). */
  fanoutThreshold?: number
  /** tokens/min on the 5-min window that trips BURN_SPIKE (default 250k). */
  spikeTokensPerMin?: number
  /**
   * Server-injected in-memory hook-event ring (newest state, zero disk reads). When present
   * it REPLACES the NDJSON bucket scan — the standalone server feeds it from the POST handler
   * so a gate-frequency caller never touches disk. Absent (extension host, tests) → disk scan.
   */
  recentEvents?: HookEventRecord[]
  /**
   * Server-injected BodiesActivityTracker report. When present it replaces the per-call
   * readdir+stat-every-file pass for HUGE_REQUEST_BURST and adds the CACHE_THRASH risk
   * (exact response usage — repeated big prefix writes with ~no cache reads).
   */
  bodiesActivity?: BodiesActivityReport | null
  /**
   * TRDD-4FMHW124: server-injected capture-liveness — the bodies pass's own activity-vs-bodies
   * comparison (the server holds both clocks; the guard cannot derive this from disk without
   * re-deriving the activity window). ms of the down transition; null/0 = capture is delivering;
   * undefined = the caller has no server signal, and NO risk row is emitted (absent ≠ healthy).
   */
  captureDownSince?: number | null
}

export function checkBurnRisk(opts: BurnGuardOptions = {}): BurnRiskReport {
  const now = opts.now ?? Date.now()
  // Resolved, not hardcoded: the legacy dir is empty on any install that redirects bodies to a
  // spool, and a guard reading an empty dir silently reports "no risk" (TRDD-8N3KQW2R).
  const bodiesDir = opts.bodiesDir ?? defaultBodiesDir()
  const hookDir = opts.hookEventsDir ?? dataPath('hook-events')
  const fanoutThreshold = Math.max(2, opts.fanoutThreshold ?? 5)
  const spikeTpm = Math.max(10_000, opts.spikeTokensPerMin ?? 250_000)

  const hooksAvailable = opts.recentEvents !== undefined || fs.existsSync(hookDir)
  const bodiesAvailable = opts.bodiesActivity ? opts.bodiesActivity.available : fs.existsSync(bodiesDir)
  const risks: BurnRisk[] = []

  // In-memory ring when the server injects it; NDJSON scan otherwise. Same shape either way.
  // The ring arrives in APPEND (oldest-first) order but readHookEvents returns newest-first,
  // and COLD_RESUME reads [0] as "most recent" — sort so both paths agree.
  const events = (ev: string, sinceMs: number, limit: number): HookEventRecord[] =>
    opts.recentEvents !== undefined
      ? opts.recentEvents
          .filter(r => r.ev === ev && r.ts >= sinceMs && r.ts <= now)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, limit)
      : hooksAvailable
        ? readHookEvents(hookDir, { ev, sinceMs, untilMs: now, limit })
        : []

  // TRDD-4FMHW124: capture down means every body-derived check BELOW is going progressively
  // blind — the one risk that undermines the others, so it leads. Emitted only when the server
  // actually reported a state (undefined = no signal = no row; a fabricated "healthy" would be
  // the same lie the capture hole told for 37 hours).
  if (opts.captureDownSince !== undefined) {
    risks.push({
      code: 'CAPTURE_DOWN',
      active: !!opts.captureDownSince,
      detail: opts.captureDownSince
        ? `Raw-body capture is DOWN (${Math.max(1, Math.round((now - opts.captureDownSince) / 60_000))}m): sessions are active but no bodies are arriving, so body-scanning tools (investigate_burn, this guard's huge-request/thrash checks) see a growing hole. Check the spool mount / sink path.`
        : 'Raw-body capture is delivering.',
      ...(opts.captureDownSince ? { evidence: { downSinceIso: new Date(opts.captureDownSince).toISOString() } } : {}),
    })
  }

  // ── hook-event signals (the earliest warnings we have) ──────────────────────
  const starts = events('SubagentStart', now - 120_000, 200)
  const startOrigins = starts.length >= fanoutThreshold ? fmtStartOrigins(starts) : ''
  risks.push({
    code: 'FANOUT_BURST',
    active: starts.length >= fanoutThreshold,
    detail: starts.length >= fanoutThreshold
      ? `${starts.length} subagents launched in the last 2min (threshold ${fanoutThreshold}) — a fan-out is starting NOW` +
        `${startOrigins ? `. Spawners: ${startOrigins}` : ''}. If the parent session is large, every fork re-pays its prefix; if the cache is cold (>5min idle or a stall just ended), each pays it at the WRITE rate.`
      : `${starts.length} subagent start(s) in the last 2min`,
    evidence: {
      subagentStarts2min: starts.length, threshold: fanoutThreshold,
      // Anchor for the async causing-call lookup: WHERE the fan-out is spawning and WHEN. The
      // spawning tool_use precedes the SubagentStart, so causingToolCall windows back from here.
      ...(starts.length >= fanoutThreshold && starts[0]
        ? {
          spawnAtMs: starts[0].ts,
          ...(typeof starts[0].payload?.cwd === 'string' ? { spawnWorkspace: starts[0].payload.cwd } : {}),
        }
        : {}),
    },
  })

  const stops = events('StopFailure', now - 600_000, 20)
  risks.push({
    code: 'COLD_RESUME_RISK',
    active: stops.length > 0,
    detail: stops.length > 0
      ? `a StopFailure (rate-limit/API turn death) fired ${Math.round((now - stops[0].ts) / 60_000)}min ago — the stall likely outlived the 5-min cache TTL. Do NOT resume a fan-out yet: check get_account_status headroom, then warm the cache with ONE agent before launching the rest.`
      : 'no rate-limit turn deaths in the last 10min',
    evidence: { stopFailures10min: stops.length, lastAtIso: stops[0] ? new Date(stops[0].ts).toISOString() : null },
  })

  const compacts = events('PreCompact', now - 300_000, 10)
  risks.push({
    code: 'COMPACTION_REWRITE',
    active: compacts.length > 0,
    detail: compacts.length > 0
      ? `PreCompact fired ${Math.round((now - compacts[0].ts) / 60_000)}min ago (trigger: ${String(compacts[0].payload?.trigger ?? '?')}) — the next turn rewrites the full prefix at the write rate. Avoid launching fan-outs or model switches until the new prefix is warm.`
      : 'no compaction in the last 5min',
    evidence: { preCompacts5min: compacts.length },
  })

  // ── bodies-dir signal: fat-context fan-out already in flight ────────────────
  // Injected tracker ring when available (O(new files) per poll); full readdir+stat
  // fallback otherwise (extension host / tests) — that pass stats every file and is
  // exactly what the tracker exists to avoid on the gate-frequency path.
  let huge = 0
  let hugeBytes = 0
  if (opts.bodiesActivity) {
    huge = opts.bodiesActivity.hugeRequests90s.count
    hugeBytes = opts.bodiesActivity.hugeRequests90s.bytes
  } else if (bodiesAvailable) {
    try {
      for (const f of fs.readdirSync(bodiesDir)) {
        if (!f.endsWith('.request.json')) continue
        try {
          const st = fs.statSync(path.join(bodiesDir, f))
          if (now - st.mtimeMs <= 90_000 && st.size > 1_000_000) { huge++; hugeBytes += st.size }
        } catch { /* raced with the writer */ }
      }
    } catch { /* dir vanished mid-scan */ }
  }
  const hugeSenders = opts.bodiesActivity?.hugeRequests90s.senders ?? []
  risks.push({
    code: 'HUGE_REQUEST_BURST',
    active: huge >= 3,
    detail: huge >= 3
      ? `${huge} requests >1MB (${(hugeBytes / 1e6).toFixed(0)}MB ≈ ${Math.round(hugeBytes / 4 / 1000)}k tokens) sent in the last 90s — a fat-context fan-out is IN FLIGHT` +
        `${hugeSenders.length > 0 ? `. Senders: ${fmtFatSenders(hugeSenders)}` : ''}. Stop spawning further agents; let this wave settle before adding load.`
      : `${huge} request(s) >1MB in the last 90s`,
    evidence: { hugeRequests90s: huge, bytes: hugeBytes, senders: hugeSenders },
  })

  // ── cache-thrash signal: the prefix is being re-WRITTEN every turn ──────────
  // Exact response usage (server-injected tracker): repeated big cache_creation with
  // ~zero cache_read = something mutates the prefix on call after call (the lean-ctx
  // strip-in-place class, 2026-07-10 incident). Only available with the tracker — the
  // fallback path cannot afford to parse response bodies per check.
  const thrash = opts.bodiesActivity?.thrash
  risks.push({
    code: 'CACHE_THRASH',
    active: thrash?.active ?? false,
    detail: thrash?.active
      ? `${thrash.count} calls in the last ${Math.round(thrash.windowMs / 60_000)}min re-WROTE ` +
        `~${Math.round(thrash.rebilledTokens / 1000)}k tokens of prefix instead of reading cache` +
        `${thrash.model ? ` (model ${thrash.model})` : ''} — the context cache is being invalidated every turn. ` +
        `${thrash.suspects.length > 0
          ? `Likely source: ${fmtFatSenders(thrash.suspects)}.`
          : 'Source not attributable from the fat requests — investigate_burn --windowHours 1 names it.'} ` +
        `STOP launching agents and fix the prefix mutator (get_cache_break_causes shows the mechanism).`
      : thrash
        ? `${thrash.count} cache-missing call(s) in the window (needs ≥3)`
        : 'no realtime response-usage feed (tracker not injected)',
    evidence: thrash
      ? { misses: thrash.count, rebilledTokens: thrash.rebilledTokens, model: thrash.model, windowMs: thrash.windowMs, suspects: thrash.suspects }
      : undefined,
  })

  // ── live burn-rate signal ────────────────────────────────────────────────────
  const windows = opts.burnStatus?.accountWindows ?? []
  const worst = windows.reduce((a, w) => Math.max(a, w.fiveMinTokensPerMin ?? 0), 0)

  // Remaining-window clause — warnings are about NOW (user directive: never about past
  // sessions/windows); the one future-looking fact they may add is how long until the
  // CURRENT window fills at the current rate. Needs capacity config; silently absent otherwise.
  const fmtLeft = (min: number): string => (min >= 90 ? `~${(min / 60).toFixed(1)}h` : `~${Math.round(min)}min`)
  let windowClause = ''
  {
    const hot = windows.reduce<(typeof windows)[number] | null>(
      (a, w) => ((w.fiveMinTokensPerMin ?? 0) > (a?.fiveMinTokensPerMin ?? -1) ? w : a), null)
    const parts: string[] = []
    const m5 = hot?.budget?.fiveHour?.minutesToExhaustion
    const m7 = hot?.budget?.sevenDay?.minutesToExhaustion
    if (typeof m5 === 'number') parts.push(`the 5h window fills in ${fmtLeft(m5)}`)
    if (typeof m7 === 'number') parts.push(`the 7d in ${fmtLeft(m7)}`)
    if (parts.length > 0) {
      windowClause = ` At the current rate ${parts.join(', ')}${hot?.accountLabel ? ` (account ${hot.accountLabel})` : ''}.`
    }
  }

  risks.push({
    code: 'BURN_SPIKE',
    active: worst > spikeTpm,
    detail: worst > spikeTpm
      ? `live burn is ${Math.round(worst / 1000)}k tokens/min on the 5-min window (threshold ${Math.round(spikeTpm / 1000)}k).${windowClause || ' Window time-left unavailable (capacity not configured).'} Identify the source NOW: agentlenspro-cli --risk names the senders; investigate_burn --windowHours 1 for depth.`
      : `live burn ${Math.round(worst / 1000)}k tokens/min`,
    evidence: { fiveMinTokensPerMin: worst, threshold: spikeTpm },
  })

  const active = risks.filter(r => r.active)
  return {
    checkedAtIso: new Date(now).toISOString(),
    activeCount: active.length,
    risks,
    sources: { hookEvents: hooksAvailable, bodies: bodiesAvailable, burnStatus: opts.burnStatus != null },
    advice: active.length === 0 ? null
      : `PAUSE before spawning more agents: let in-flight waves settle, warm a cold cache with ONE agent first, and prefer cheap models for fan-out work.${windowClause}`,
  }
}

/**
 * Enrich each ACTIVE risk that anchors a fan-out (a workspace + a time) with the VERBATIM spawning
 * tool-call. ASYNC and SEPARATE from checkBurnRisk (which stays sync) so the DuckDB transcript read
 * runs ONLY when a peak actually fired — the quiet no-risk path never opens a transcript, keeping
 * --risk's ~50 ms budget intact. Reads the JSONL (always present), so it works even when raw-body
 * capture is OFF. Honest on failure; never fabricates a call. Mutates `report` in place.
 */
export async function attachRiskCausingCalls(
  report: BurnRiskReport,
  opts: { projectsDirs?: string[] } = {},
): Promise<void> {
  for (const r of report.risks) {
    if (!r.active) continue
    const ev = r.evidence
    const atMs = ev && typeof ev.spawnAtMs === 'number' ? (ev.spawnAtMs as number) : undefined
    const workspace = ev && typeof ev.spawnWorkspace === 'string' ? (ev.spawnWorkspace as string) : undefined
    if (atMs === undefined || !workspace) continue // only risks that anchor a spawn call
    const res = await causingToolCalls({ workspace, atMs, projectsDirs: opts.projectsDirs })
    if (res.calls.length > 0) {
      r.causingCalls = res.calls
      r.causingCallsComposition = composition(res.calls)
      // Numbered/timed/measured composition on the risk line; full verbatim inputs live in causingCalls[].
      r.detail += ` Causing calls (${res.calls.length}: ${r.causingCallsComposition}): ` +
        res.calls.map(c => `${c.n}. ${c.tool}${c.subagentType ? `/${c.subagentType}` : ''}` +
          `${c.model ? `/${c.model}` : ''} @${c.iso}`).join('; ')
    } else {
      r.causingCallsUnavailable = res.reason
    }
  }
}
