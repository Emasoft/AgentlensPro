// get_window_eta (TRDD-8ZMZ4I6B) — how long until the CURRENT account exhausts its rate-limit
// windows, at the current COST rate. Anthropic meters the 5h/7d windows by COST (cache-read is
// weighted far below fresh input), so a token-based projection over-counts the ~96%-cache-read
// stream and under-estimates the time left. This command projects on dollars: remaining cost
// capacity ÷ the account's current $/min.
//
// Reuses accountBurners' machine-wide account-state attribution (one OAuth token active at a time)
// and its capacity resolver (own observed calibration → same-plan proxy → none) so the ETA and the
// burners autopsy can never disagree about which events belong to the account or what its cap is.

import { BILLABLE_WEIGHTS, type ConsumptionEvent, type ObservedAccountCapacity } from './burnMonitor'
import {
  eventsForAccountInWindow, resolveWindowCapacity, type AccountSegment, type ResolvedAccount, type WindowCapacity,
} from './accountBurners'

export interface WindowEtaSection {
  label: '5h' | '7d'
  windowHours: number
  window: { fromIso: string; untilIso: string }
  consumedCostUsd: number
  consumedTokens: number
  consumedBillableWeighted: number
  capacity: WindowCapacity
  /** consumedCostUsd / capacity.costUsd (0..1+), null when no cost capacity is known. */
  fillPct: number | null
  remainingCostUsd: number | null
  /** The account's current cost burn rate over `rateWindowMin`, $/min. */
  costPerMin: number
  /** Steady-state fill of a ROLLING window at the current rate: costPerMin × windowMinutes. The
   *  window sheds consumption older than its length, so if this is below the cap the window can
   *  NEVER exhaust at the current rate — it plateaus here. This is what makes a naive
   *  remaining/rate projection wrong for a rolling window. */
  steadyStateFillUsd: number
  /** True iff steadyStateFillUsd ≥ capacity — only then does an ETA exist. */
  willExhaustAtCurrentRate: boolean
  /** Minutes to exhaustion. null = no capacity, rate 0 (idle), or plateaus below cap; 0 = already over. */
  etaMinutes: number | null
  etaReason: 'projected' | 'over-limit' | 'no-capacity' | 'idle' | 'plateau'
  etaHuman: string
  exhaustionEtaIso: string | null
}

export interface WindowEtaReport {
  account: { accountId: string; email: string | null; plan: string | null; isCurrent: boolean }
  nowIso: string
  rateWindowMin: number
  fiveHour: WindowEtaSection
  sevenDay: WindowEtaSection
  /** The window that runs out FIRST at the current rate — what the user will actually hit. */
  bindingWindow: '5h' | '7d' | 'none'
  verdict: string
  note: string
  text: string
}

function weighted(e: ConsumptionEvent): number {
  const known = (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheCreateTokens ?? 0)
  return (e.inputTokens ?? 0) * BILLABLE_WEIGHTS.input
    + (e.outputTokens ?? 0) * BILLABLE_WEIGHTS.output
    + (e.cacheReadTokens ?? 0) * BILLABLE_WEIGHTS.cacheRead
    + (e.cacheCreateTokens ?? 0) * BILLABLE_WEIGHTS.cacheCreate
    + Math.max(0, e.tokens - known) * BILLABLE_WEIGHTS.unknown
}

/** The readable ETA, chosen by the reason so a rolling-window plateau is never dressed up as a
 *  finite countdown. */
export function humanEta(etaMinutes: number | null, reason: WindowEtaSection['etaReason']): string {
  switch (reason) {
    case 'no-capacity': return 'unknown (no cost capacity calibrated for this account or a same-plan one)'
    case 'idle': return 'not draining (no consumption in the rate window)'
    case 'plateau': return 'won\'t exhaust at the current rate (rolling window plateaus below the cap)'
    case 'over-limit': return 'already at/over the limit'
    case 'projected': {
      const m = etaMinutes ?? 0
      const hh = Math.floor(m / 60), mm = Math.round(m % 60)
      return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`
    }
  }
}

function fmtTok(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  return `${(n / 1e3).toFixed(0)}k`
}

function buildSection(opts: {
  events: ConsumptionEvent[]
  target: ResolvedAccount
  label: '5h' | '7d'
  windowHours: number
  nowMs: number
  costPerMin: number
  capacity: WindowCapacity
}): WindowEtaSection {
  const { events, target, label, windowHours, nowMs, costPerMin, capacity } = opts
  const fromMs = nowMs - windowHours * 3600_000
  const inWindow = eventsForAccountInWindow(events, target, fromMs, nowMs, nowMs)
  let cost = 0, tokens = 0, bw = 0
  for (const e of inWindow) { cost += e.costUsd; tokens += e.tokens; bw += weighted(e) }

  const cap = capacity.costUsd
  const fillPct = cap !== null && cap > 0 ? (cost / cap) * 100 : null
  const remaining = cap !== null ? cap - cost : null
  // A rolling window at steady rate r plateaus at r × windowLength. If that plateau is below the
  // cap, the window CANNOT exhaust at this rate no matter how long it runs — reporting remaining/rate
  // there would be a fiction (it assumes monotonic accumulation the rolling window never does).
  const steadyStateFillUsd = costPerMin * windowHours * 60
  const willExhaustAtCurrentRate = cap !== null && steadyStateFillUsd >= cap

  let etaReason: WindowEtaSection['etaReason']
  let etaMinutes: number | null
  if (cap === null) { etaReason = 'no-capacity'; etaMinutes = null }
  else if (remaining! <= 0) { etaReason = 'over-limit'; etaMinutes = 0 }
  else if (costPerMin <= 0) { etaReason = 'idle'; etaMinutes = null }
  else if (!willExhaustAtCurrentRate) { etaReason = 'plateau'; etaMinutes = null }
  else { etaReason = 'projected'; etaMinutes = remaining! / costPerMin }

  return {
    label, windowHours,
    window: { fromIso: new Date(fromMs).toISOString(), untilIso: new Date(nowMs).toISOString() },
    consumedCostUsd: +cost.toFixed(4),
    consumedTokens: tokens,
    consumedBillableWeighted: Math.round(bw),
    capacity,
    fillPct,
    remainingCostUsd: remaining === null ? null : +remaining.toFixed(4),
    costPerMin: +costPerMin.toFixed(6),
    steadyStateFillUsd: +steadyStateFillUsd.toFixed(2),
    willExhaustAtCurrentRate,
    etaMinutes: etaMinutes === null ? null : +etaMinutes.toFixed(1),
    etaReason,
    etaHuman: humanEta(etaMinutes, etaReason),
    exhaustionEtaIso: etaMinutes !== null && etaMinutes > 0 ? new Date(nowMs + etaMinutes * 60_000).toISOString() : null,
  }
}

export function buildWindowEtaReport(opts: {
  events: ConsumptionEvent[]
  target: ResolvedAccount
  allSegments: AccountSegment[]
  nowMs: number
  rateWindowMs: number
  observed: Record<string, ObservedAccountCapacity>
}): WindowEtaReport {
  const { events, target, allSegments, nowMs, rateWindowMs, observed } = opts

  // The account's CURRENT cost rate: its own events over the rate window (per-account, because the
  // rate limit is per account — a concurrent session on a different token does not fill this window).
  const rateFrom = nowMs - rateWindowMs
  const rateEvents = eventsForAccountInWindow(events, target, rateFrom, nowMs, nowMs)
  const rateCost = rateEvents.reduce((a, e) => a + e.costUsd, 0)
  const costPerMin = rateCost / (rateWindowMs / 60_000)

  const fiveHour = buildSection({
    events, target, label: '5h', windowHours: 5, nowMs, costPerMin,
    capacity: resolveWindowCapacity(observed, target, allSegments, '5h'),
  })
  const sevenDay = buildSection({
    events, target, label: '7d', windowHours: 168, nowMs, costPerMin,
    capacity: resolveWindowCapacity(observed, target, allSegments, '7d'),
  })

  // Which runs out first? The smaller positive ETA. Ties/None handled explicitly.
  const cand = [fiveHour, sevenDay].filter(s => s.etaMinutes !== null && s.etaMinutes > 0)
  const binding = cand.sort((a, b) => a.etaMinutes! - b.etaMinutes!)[0]
  const anyOver = [fiveHour, sevenDay].find(s => s.etaMinutes === 0)
  const bindingWindow: '5h' | '7d' | 'none' = anyOver ? anyOver.label : (binding?.label ?? 'none')

  const capSrc = (s: WindowEtaSection): string =>
    s.capacity.source === 'same-plan-proxy' ? `same-plan proxy ${s.capacity.proxyAccountId?.slice(0, 8)}` : (s.capacity.source ?? 'none')

  let verdict: string
  if (anyOver) {
    verdict = `The ${anyOver.label} window is ALREADY at/over its cost limit (${anyOver.consumedCostUsd.toFixed(0)} of ${anyOver.capacity.costUsd?.toFixed(0)} $ cap) — a rotation is imminent or overdue.`
  } else if (binding) {
    verdict = `At $${costPerMin.toFixed(2)}/min the ${binding.label} window exhausts first in ~${binding.etaHuman} ` +
      `(${binding.consumedCostUsd.toFixed(0)} of ${binding.capacity.costUsd?.toFixed(0)} $ cap, ${binding.fillPct?.toFixed(0)}% used, capacity ${capSrc(binding)}).`
  } else if (fiveHour.capacity.costUsd === null && sevenDay.capacity.costUsd === null) {
    verdict = 'No cost capacity is calibrated for this account or a same-plan account, so no ETA can be projected. A future rate-limit hit auto-calibrates it; or set AGENTLENS_WINDOW_5H_COST_USD / _7D_COST_USD.'
  } else if (costPerMin <= 0) {
    verdict = `Capacity is known but nothing is burning in the last ${Math.round(rateWindowMs / 60_000)}m (rate $0/min) — the windows are not draining right now.`
  } else {
    // Rolling-window plateau: the current rate is not enough for either window to reach its cap.
    const worst = [fiveHour, sevenDay].filter(s => s.capacity.costUsd !== null)
      .sort((a, b) => (b.steadyStateFillUsd / b.capacity.costUsd!) - (a.steadyStateFillUsd / a.capacity.costUsd!))[0]
    verdict = `At $${costPerMin.toFixed(2)}/min NEITHER window exhausts — a rolling window plateaus at rate×length. ` +
      (worst ? `The ${worst.label} plateaus at ~$${worst.steadyStateFillUsd.toFixed(0)} of its $${worst.capacity.costUsd!.toFixed(0)} cap (${Math.round(worst.steadyStateFillUsd / worst.capacity.costUsd! * 100)}%). ` : '') +
      'It would take a sustained higher burst (like the one that forced the last rotation) to exhaust a window.'
  }

  const note = 'ETA is COST-based (Anthropic meters the windows by cost, not raw tokens — cache-read is weighted ~0.1×). ' +
    'The rate is THIS account\'s own $/min (rate limits are per OAuth account); capacity is the account\'s observed ' +
    'calibration, else a same-plan account\'s as a labeled proxy, else undetermined. Consumption uses time-based ' +
    'attribution against the account-state timeline, so cross-rotation sessions split correctly.'

  const lines: string[] = []
  const acct = `${target.email ?? target.accountId}${target.isCurrent ? '' : ' (NOT the current account)'}`
  lines.push(`window ETA for ${acct} at $${costPerMin.toFixed(2)}/min (rate over last ${Math.round(rateWindowMs / 60_000)}m) — as of ${new Date(nowMs).toISOString()}`)
  for (const s of [fiveHour, sevenDay]) {
    const mark = bindingWindow === s.label ? '  ◀ EXHAUSTS FIRST' : ''
    const capStr = s.capacity.costUsd !== null
      ? `$${s.consumedCostUsd.toFixed(0)} / $${s.capacity.costUsd.toFixed(0)} cap (${s.fillPct?.toFixed(0)}%, ${capSrc(s)})`
      : `$${s.consumedCostUsd.toFixed(0)} consumed · no capacity`
    lines.push(`  ${s.label}: ${capStr} · ${fmtTok(s.consumedTokens)} raw tok · ETA ${s.etaHuman}${s.exhaustionEtaIso ? ` (≈ ${s.exhaustionEtaIso})` : ''}${mark}`)
  }
  lines.push(verdict)

  return {
    account: { accountId: target.accountId, email: target.email, plan: target.plan, isCurrent: target.isCurrent },
    nowIso: new Date(nowMs).toISOString(),
    rateWindowMin: Math.round(rateWindowMs / 60_000),
    fiveHour, sevenDay,
    bindingWindow,
    verdict,
    note,
    text: lines.join('\n'),
  }
}
