// check_burn_risk — realtime early-warning against token explosions (TRDD-W6UH8LPA).
//
// investigate_burn explains a drained window AFTER the fact; this module warns AS the
// explosion starts, by fusing the three feeds the server already receives in realtime:
//   1. lifecycle hook events (spy-agentlens.sh): SubagentStart bursts = a fan-out is
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
import * as os from 'os'
import * as path from 'path'
import { readHookEvents, type HookEventRecord } from './hookEventStore'
import type { BodiesActivityReport } from './bodiesActivity'

export interface BurnRisk {
  code: 'FANOUT_BURST' | 'COLD_RESUME_RISK' | 'COMPACTION_REWRITE' | 'HUGE_REQUEST_BURST' | 'BURN_SPIKE' | 'CACHE_THRASH'
  active: boolean
  detail: string
  evidence?: Record<string, unknown>
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
  /** The live monitor's status (mcpServer injects getBurnStatus()); null when unavailable. */
  burnStatus?: { accountWindows?: { fiveMinTokensPerMin?: number; accountLabel?: string }[] } | null
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
}

export function checkBurnRisk(opts: BurnGuardOptions = {}): BurnRiskReport {
  const now = opts.now ?? Date.now()
  const bodiesDir = opts.bodiesDir ?? path.join(os.homedir(), '.agentlens', 'otel-bodies')
  const hookDir = opts.hookEventsDir ?? path.join(os.homedir(), '.agentlens', 'hook-events')
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

  // ── hook-event signals (the earliest warnings we have) ──────────────────────
  const starts = events('SubagentStart', now - 120_000, 200)
  risks.push({
    code: 'FANOUT_BURST',
    active: starts.length >= fanoutThreshold,
    detail: starts.length >= fanoutThreshold
      ? `${starts.length} subagents launched in the last 2min (threshold ${fanoutThreshold}) — a fan-out is starting NOW. If the parent session is large, every fork re-pays its prefix; if the cache is cold (>5min idle or a stall just ended), each pays it at the WRITE rate.`
      : `${starts.length} subagent start(s) in the last 2min`,
    evidence: { subagentStarts2min: starts.length, threshold: fanoutThreshold },
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
  risks.push({
    code: 'HUGE_REQUEST_BURST',
    active: huge >= 3,
    detail: huge >= 3
      ? `${huge} requests >1MB (${(hugeBytes / 1e6).toFixed(0)}MB ≈ ${Math.round(hugeBytes / 4 / 1000)}k tokens) sent in the last 90s — a fat-context fan-out is IN FLIGHT. Stop spawning further agents; let this wave settle before adding load.`
      : `${huge} request(s) >1MB in the last 90s`,
    evidence: { hugeRequests90s: huge, bytes: hugeBytes },
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
        `${thrash.model ? ` (model ${thrash.model})` : ''} — the context cache is being invalidated ` +
        `every turn. STOP launching agents and find the prefix mutator: investigate_burn --windowHours 1, ` +
        `then get_cache_break_causes.`
      : thrash
        ? `${thrash.count} cache-missing call(s) in the window (needs ≥3)`
        : 'no realtime response-usage feed (tracker not injected)',
    evidence: thrash
      ? { misses: thrash.count, rebilledTokens: thrash.rebilledTokens, model: thrash.model, windowMs: thrash.windowMs }
      : undefined,
  })

  // ── live burn-rate signal ────────────────────────────────────────────────────
  const windows = opts.burnStatus?.accountWindows ?? []
  const worst = windows.reduce((a, w) => Math.max(a, w.fiveMinTokensPerMin ?? 0), 0)
  risks.push({
    code: 'BURN_SPIKE',
    active: worst > spikeTpm,
    detail: worst > spikeTpm
      ? `live burn is ${Math.round(worst / 1000)}k tokens/min on the 5-min window (threshold ${Math.round(spikeTpm / 1000)}k) — at this rate a 5h window drains fast. Identify the source NOW (investigate_burn --windowHours 1) before it finishes the job.`
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
      : 'PAUSE before spawning more agents: verify window headroom (get_account_status), let in-flight waves settle, warm a cold cache with ONE agent first, and prefer cheap models for fan-out work. Then investigate_burn to attribute what already burned.',
  }
}
