/**
 * Account-state TIMELINE (TRDD-YQZ9P8IL) — attribute every request to the subscription state active
 * AT THAT TIME, without hammering the SSD.
 *
 * The subscription state is a SLOWLY-CHANGING dimension: mode/plan almost never change; the account
 * changes on rotation (~minutes); only the 5h/7d % move continuously. So the write-frugal model is an
 * append-only STATE TIMELINE keyed on the DISCRETE dims, written ONLY when they change — a few
 * records/hour, not per-request. The continuously-moving 5h/7d % are DELIBERATELY excluded from the
 * change-detection key (they'd make the timeline write constantly); query them live instead.
 *
 * "Mode at request time T" = binary-search the timeline for the last record with ts <= T. Exact, and
 * needs ZERO per-request write.
 *
 * SSD discipline (the same doctrine as the span store): an in-memory buffer coalesces the rare bursts;
 * a flush appends + fsyncs the WHOLE batch once (NEVER per record — per-record fsync is the SSD
 * killer). Flush triggers, whichever first: a 60-second timer (tunable via AGENTLENS_ACCOUNT_STATE_FLUSH_MS),
 * the buffer reaching 32 records / ~16 KB, or graceful shutdown (the server pipes SIGTERM here). A
 * kill-9 mid-window loses at most the last window's changes and never a flushed record; NDJSON is
 * recovery-robust (a torn final line is simply discarded on read).
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { classifyTtlRegime, type TtlContext } from './shared/cacheTtl'
import type { AccountInfo } from './accountInfo'

/** One state-timeline record — the subscription state that became active at `ts`. The discrete dims
 *  (everything except ts) are what change-detection keys on; the 5h/7d % are intentionally absent. */
export interface AccountStateRecord {
  ts: number                 // ms epoch when this state was first observed (the change moment)
  accountId: string | null
  email: string | null
  mode: string               // human billing mode (subscription within plan / usage credits / API)
  plan: string               // "Max 5x" | "Max 20x" | "Pro" | …
  authRegime: string         // raw regime: subscription | usage-credits | api-key | unknown
  ttlMinutes: number         // the cache-TTL tier of the main session under this state
  ttlSource: string          // doc-matrix | config | measured | assumed
}

/** TRDD-YQZ9P8IL — the human plan name from planType + the rate-limit tier's multiplier. Shared with
 *  get_account_status (mcpServer imports it) so the plan string has ONE source of truth. */
export function describePlan(planType: string | null | undefined, rateLimitTier: string | null | undefined): string {
  const mult = (rateLimitTier ?? '').toLowerCase().match(/(\d+)x\b/)  // default_claude_max_5x → "5"
  const suffix = mult ? ` ${mult[1]}x` : ''
  switch ((planType ?? '').toLowerCase()) {
    case 'max': return `Max${suffix}`
    case 'pro': return 'Pro'
    case 'team': return 'Team'
    case 'enterprise': return 'Enterprise'
    case 'free': return 'Free'
    default: return planType ? `${planType}${suffix}` : (mult ? `Max ${mult[1]}x` : 'unknown')
  }
}

/** TRDD-YQZ9P8IL — the billing MODE in human words from the resolved auth regime. Shared with
 *  get_account_status. The substring-'subscription' fallback is the stripe_subscription fix. */
export function describeAccountMode(authRegime: string | null): string {
  switch (authRegime) {
    case 'subscription': return 'subscription (within plan)'
    case 'usage-credits': return 'subscription drawing usage credits (over plan limit)'
    case 'api-key': return 'API key (pay-per-token)'
    default: return 'unresolved'
  }
}

/** Resolve the raw auth regime from ttlCtx (preferred) or a coarse billingType read (substring match
 *  so stripe_subscription is not misread as api-key). null billingType → null (never a guess). */
export function resolveAuthRegimeLabel(account: AccountInfo | null, ttlCtx: TtlContext | null): string | null {
  return ttlCtx?.auth
    ?? (account?.billingType
      ? (account.billingType.toLowerCase().includes('subscription') ? 'subscription' : 'api-key')
      : null)
}

/** Build the current state record from the live account + TTL context. `now` is injected (never
 *  Date.now() inside) so the sampler and tests control the timestamp. */
export function buildAccountStateRecord(account: AccountInfo | null, ttlCtx: TtlContext | null, now: number): AccountStateRecord {
  const authRegime = resolveAuthRegimeLabel(account, ttlCtx)
  const ttlRegime = classifyTtlRegime('main', ttlCtx)  // get_account_status is a main-conversation tool
  return {
    ts: now,
    accountId: account?.accountUuid ?? null,
    email: account?.email ?? account?.label ?? null,
    mode: describeAccountMode(authRegime),
    plan: account && account.source !== 'none' ? describePlan(account.planType, account.rateLimitTier) : 'unknown',
    authRegime: authRegime ?? 'unknown',
    ttlMinutes: ttlRegime.ttlAssumedMin,
    ttlSource: ttlRegime.ttlSource,
  }
}

/** The discrete change-detection key — everything EXCEPT the continuously-moving parts (ts, and the
 *  5h/7d % which are never in the record). A  join can't collide with any field's own content. */
function discreteKey(r: AccountStateRecord): string {
  return [r.accountId ?? '∅', r.mode, r.plan, r.authRegime, r.ttlMinutes].join('')
}

/** Resolves the timeline file path. AGENTLENS_ACCOUNT_STATE_LOG overrides; else ~/.agentlens/account-state.ndjson. */
export function accountStateTimelinePath(): string {
  return process.env['AGENTLENS_ACCOUNT_STATE_LOG'] || path.join(os.homedir(), '.agentlens', 'account-state.ndjson')
}

/**
 * The change-detected, buffered, fsync-on-flush timeline writer. One instance per server process.
 * record() is called often (the burn tick, ~every 4s) but only ENQUEUES on a discrete-state change,
 * so the common case is a cheap key comparison with no allocation and no write.
 */
export class AccountStateTimeline {
  private readonly filePath: string
  private readonly flushMs: number
  private buffer: AccountStateRecord[] = []
  private bufferedBytes = 0
  private lastKey: string | null    // last ENQUEUED discrete key (seeded from the file tail on start)
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private static readonly FLUSH_MAX_RECORDS = 32
  private static readonly FLUSH_MAX_BYTES = 16 * 1024

  constructor(opts?: { filePath?: string; flushMs?: number; autoTimer?: boolean }) {
    this.filePath = opts?.filePath ?? accountStateTimelinePath()
    this.flushMs = opts?.flushMs ?? Math.max(1000, Number(process.env['AGENTLENS_ACCOUNT_STATE_FLUSH_MS']) || 60_000)
    // Seed lastKey from the file tail so a server RESTART into an unchanged state does not re-log it.
    this.lastKey = this.readLastKey()
    if (opts?.autoTimer !== false) {
      this.flushTimer = setInterval(() => this.flush(), this.flushMs)
      this.flushTimer.unref?.()  // never keep the process alive just for this timer
    }
  }

  /** Enqueue the record IFF its discrete state differs from the last enqueued one. Returns true when a
   *  change was recorded, false for the (common) no-change case — the change-detection that makes this
   *  a few-writes/hour timeline instead of a per-request firehose. */
  record(state: AccountStateRecord): boolean {
    const key = discreteKey(state)
    if (key === this.lastKey) return false
    this.lastKey = key
    this.buffer.push(state)
    this.bufferedBytes += JSON.stringify(state).length + 1
    if (this.buffer.length >= AccountStateTimeline.FLUSH_MAX_RECORDS || this.bufferedBytes >= AccountStateTimeline.FLUSH_MAX_BYTES) {
      this.flush()
    }
    return true
  }

  /** Append the buffered batch as NDJSON + fsync ONCE. Best-effort: a write failure re-buffers the
   *  batch (bounded — state changes are rare) rather than losing it, and never throws. No-op when empty. */
  flush(): void {
    if (this.buffer.length === 0) return
    const batch = this.buffer
    this.buffer = []
    this.bufferedBytes = 0
    const lines = batch.map(r => JSON.stringify(r)).join('\n') + '\n'
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const fd = fs.openSync(this.filePath, 'a')          // O_APPEND: atomic append at EOF
      try {
        fs.writeSync(fd, lines)
        fs.fsyncSync(fd)                                   // durability once per BATCH, never per record
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // Transient write failure — put the batch back in front of anything enqueued meanwhile so the
      // next flush retries it in order. Bounded in practice because discrete changes are rare.
      this.buffer = batch.concat(this.buffer)
      this.bufferedBytes += lines.length
    }
  }

  /** Stop the timer and do a final flush — the graceful-shutdown path (piggybacks the server's SIGTERM). */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flush()
  }

  private readLastKey(): string | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const lines = raw.split('\n').filter(l => l.trim())
      if (lines.length === 0) return null
      return discreteKey(JSON.parse(lines[lines.length - 1]) as AccountStateRecord)
    } catch {
      return null   // no file yet, or an unreadable/torn tail — start fresh, never throw
    }
  }
}

/**
 * Resolve the account state active at time T: the last record with ts <= T (binary search over the
 * append-ordered timeline). Reads the whole NDJSON — it is tiny (a few records/hour). A torn final
 * line is skipped. null when no record precedes T (the timeline doesn't reach that far back).
 */
export function resolveStateAt(ts: number, filePath = accountStateTimelinePath()): AccountStateRecord | null {
  let records: AccountStateRecord[]
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    records = raw.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) as AccountStateRecord } catch { return null } })
      .filter((r): r is AccountStateRecord => r !== null && typeof r.ts === 'number')
  } catch {
    return null
  }
  let lo = 0, hi = records.length - 1, ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (records[mid].ts <= ts) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return ans >= 0 ? records[ans] : null
}
