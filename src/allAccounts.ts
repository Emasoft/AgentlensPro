// src/allAccounts.ts — "where does EVERY account stand", not just the one this machine is on.
//
// WHY THIS EXISTS (issue #8). A rotator deciding whether to switch needs the headroom of the accounts
// it is NOT on, and until now the only way to learn an account's status was to already be on it. You
// had to rotate to find out whether you should rotate. Measured cost on the host that reported it:
// three accounts, two holding refresh tokens that had died days earlier, the rotator correctly
// refusing to move onto a credential it could not validate — and the whole machine stalled at the
// limit for hours while one of those accounts had a nearly empty window the entire time.
//
// WHAT THIS IS NOT. An 80-project survey of Claude account switchers found the direct answer to be
// unanimous: hold a credential per account, mint a token per account, call the usage endpoint N times.
// That is exactly what this module will not do. AgentlensPro's contract is that the OAuth token is
// never read or returned, so every row here is what was ALREADY observed while that account was live —
// stamped, with its own freshness stated, and never refreshed by acquiring a credential.
//
// THE IDEA THAT MAKES OBSERVED DATA USEFUL. A stale reading is not automatically unknown. A window has
// an absolute `resetsAt`; once that instant passes, the window it described no longer exists. For an
// account this machine LEFT before the reading was taken, no local activity can have refilled it — so
// a 91% five-hour window observed yesterday is not "unknown", it is EMPTY. That is the row that would
// have ended the outage above, and it costs nothing to compute. Two projects in the survey expire such
// a reading to null; none complete the inference.
//
// It is an inference, and its precondition (`no activity observed BY THIS MACHINE`) travels with it in
// the payload. The same account used from another host breaks it, and a consumer that cannot tell an
// inference from a measurement is the failure this whole module exists to prevent.

import { getCurrentAccount } from './accountInfo'
import { listAccountRoster, type AccountRosterEntry } from './accountStateTimeline'
import { listObservedAccountUsage, TTL_MS, type SubscriptionUsage, type UsageLimit } from './subscriptionUsage'

/** How a single window's number should be read. */
export type WindowFreshness =
  /** Read within the cache TTL — a current measurement. */
  | 'fresh'
  /** Read longer ago than the TTL, but the window has NOT reset since, so the number still describes
   *  the live window. Utilization only grows, so this is a LOWER bound. */
  | 'aged'
  /** The window reset after the reading AND this machine has been off the account since before the
   *  reading — so nothing local can have refilled it. INFERRED ~0%, precondition stated. */
  | 'rolled'
  /** The window reset after the reading, but activity since cannot be excluded (the account has been
   *  live on this machine since). The old number is void and the new one is unknown. */
  | 'stale'
  /** No usable reading for this account at all. */
  | 'unreadable'

export interface AccountWindow {
  /** null whenever the number would be a guess. NEVER 0 as a stand-in for unknown: "no limit applies"
   *  and "limit unknown" are opposite signals to anything automated. */
  percent: number | null
  resetsAt: string | null
  freshness: WindowFreshness
  /** Present whenever `percent` is null or inferred — why, in words a human can act on. */
  reason: string | null
}

export interface AccountStatusRow {
  accountId: string | null
  email: string | null
  isLive: boolean
  plan: string
  mode: string
  authRegime: string
  /** When the numbers below were fetched. null when this account has never had a reading. */
  observedAt: number | null
  staleSeconds: number | null
  /** When this machine stopped being on this account (null = still on it). The precondition behind a
   *  `rolled` verdict, exposed so a consumer can audit the inference instead of trusting it. */
  leftAt: number | null
  fiveHour: AccountWindow
  sevenDay: AccountWindow
  /** Per-model weekly buckets, verbatim. DELIBERATELY NOT folded into the account verdict: a spent
   *  per-model bucket does not block other models, so counting it toward "spent" reports an account
   *  with headroom as exhausted. */
  scopedWeekly: UsageLimit[]
  usageCreditsEnabled: boolean | null
  /** The worst of the two account-wide windows — what a rotator should key on. */
  freshness: WindowFreshness
  accountLabelSuspect: boolean
}

export interface AllAccountsAnswer {
  accounts: AccountStatusRow[]
  liveAccountId: string | null
  /** True when the roster itself is empty — we have never observed ANY account. A consumer must read
   *  this as "cannot see", never as "no accounts". */
  blind: boolean
  note: string
}

const UNREADABLE = (reason: string): AccountWindow =>
  ({ percent: null, resetsAt: null, freshness: 'unreadable', reason })

/** Rank used to fold two window verdicts into one account verdict — worst wins. `rolled` outranks
 *  `aged` because it is an inference rather than a measurement, and a consumer should see the weaker
 *  claim, not the stronger one. */
const SEVERITY: Record<WindowFreshness, number> = {
  fresh: 0, aged: 1, rolled: 2, stale: 3, unreadable: 4,
}

/** Classify ONE window from a stamped reading.
 *
 *  `leftAt` is the whole game. Rolled-and-idle is knowable (~0%); rolled-and-maybe-used is not. The
 *  two are one comparison apart and reporting the second as the first is how an inference becomes a
 *  lie a rotator acts on. */
export function classifyWindow(
  percent: number | null,
  resetsAt: string | null,
  fetchedAt: number,
  leftAt: number | null,
  now: number,
  /** True when the reading's own account does not match the one `~/.claude.json` claims. It DISABLES
   *  the `rolled` inference, and that is not caution for its own sake — `leftAt` is derived from the
   *  timeline's accountId, which comes from that same claim. When the claim is wrong, "this machine
   *  left the account" is unfounded, and the account may be burning under a credential the config does
   *  not name. MEASURED on the host that motivated this: `~/.claude.json` said the owner account while the
   *  keychain credential belonged to the second account, so every usage reading on record is the second account's and the
   *  idle-since premise for it was false. Inferring an empty window there would hand a rotator a
   *  green light for an account that might be the one actually burning. */
  labelSuspect = false,
): AccountWindow {
  if (percent === null) return UNREADABLE('this window was absent from the reading')
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN
  const hasReset = Number.isFinite(resetMs) && resetMs <= now

  if (!hasReset) {
    if (now - fetchedAt < TTL_MS) return { percent, resetsAt, freshness: 'fresh', reason: null }
    return {
      percent, resetsAt, freshness: 'aged',
      reason: 'read outside the cache TTL, but this window has not reset since — utilization only '
        + 'grows, so treat it as a LOWER bound',
    }
  }
  // The window reset, so the number describes a window that no longer exists. The only question left
  // is whether anything could have filled the NEW one.
  //
  // THE COMPARISON IS AGAINST THE RESET INSTANT, NOT THE READING. Comparing to `fetchedAt` reads
  // plausibly and is useless: a reading for an account is normally taken WHILE that account is live,
  // so `leftAt <= fetchedAt` is almost never true and the inference would never fire for a legitimately
  // observed account. What actually matters is whether this machine was still on the account after the
  // new window BEGAN — an account left at or before the reset has had no local traffic in it at all.
  // (Caught by a test that expected `rolled` and got `stale`; the test's fixture was right and the
  // condition was wrong.)
  if (leftAt !== null && leftAt <= resetMs && !labelSuspect) {
    return {
      percent: 0, resetsAt: null, freshness: 'rolled',
      reason: 'INFERRED, not measured: the window has reset since this reading, and this machine was '
        + 'already off the account when the new window began — so no local activity can have filled '
        + 'it. Breaks if the account is used from another host.',
    }
  }
  return {
    percent: null, resetsAt: null, freshness: 'stale',
    reason: labelSuspect
      ? 'the window reset after this reading, and the reading\'s own account does not match the one '
        + '~/.claude.json claims — so "this machine left the account" cannot be established and the '
        + 'window may be filling under a credential the config does not name'
      : leftAt === null
        ? 'the window has reset since this reading and the account is still the one this machine is on '
          + '— the old number is void and the new window has not been read'
        : 'the window has reset since this reading, but this machine was still on the account after the '
          + 'new window began — activity in it cannot be excluded',
  }
}

function pickLimit(u: SubscriptionUsage, kind: string): UsageLimit | undefined {
  return u.limits.find(l => l.kind === kind)
}

/** Join the roster (who exists) with the per-account usage archive (their last true numbers).
 *
 *  `liveAccountId` may be supplied by a caller that already knows it — `getCurrentAccount()` memoizes
 *  process-wide, so a test cannot otherwise vary it. */
export function listAllAccounts(opts: { now?: number; liveAccountId?: string | null } = {}): AllAccountsAnswer {
  const now = opts.now ?? Date.now()
  const roster = listAccountRoster()
  const usageByUuid = new Map<string, SubscriptionUsage>()
  for (const u of listObservedAccountUsage()) {
    // listObservedAccountUsage is newest-first, so the first record for a uuid is its freshest.
    if (u.accountUuid && !usageByUuid.has(u.accountUuid)) usageByUuid.set(u.accountUuid, u)
  }
  const liveAccountId = opts.liveAccountId !== undefined ? opts.liveAccountId : getCurrentAccount().accountUuid

  const accounts = roster.map((r: AccountRosterEntry): AccountStatusRow => {
    const isLive = r.accountId !== null && r.accountId === liveAccountId
    // An account that is live RIGHT NOW has not been left, whatever the timeline's last record says —
    // the timeline only writes on a discrete state CHANGE, so the live account can trail a `leftAt`
    // from an earlier run. Without this, the live account can be reported as idle and its rolled
    // window inferred empty while it is actively burning.
    const leftAt = isLive ? null : r.leftAt
    const u = r.accountId ? usageByUuid.get(r.accountId) : undefined
    if (!u) {
      const reason = 'no usage reading has ever been captured for this account — NOT the same as an '
        + 'empty or a full window'
      return {
        accountId: r.accountId, email: r.email, isLive, plan: r.plan, mode: r.mode,
        authRegime: r.authRegime, observedAt: null, staleSeconds: null, leftAt,
        fiveHour: UNREADABLE(reason), sevenDay: UNREADABLE(reason), scopedWeekly: [],
        usageCreditsEnabled: null, freshness: 'unreadable', accountLabelSuspect: false,
      }
    }
    const session = pickLimit(u, 'session')
    const weekly = pickLimit(u, 'weekly_all')
    const fiveHour = classifyWindow(
      session ? session.percent : u.fiveHourPercent, session?.resetsAt ?? null, u.fetchedAt, leftAt, now,
      u.accountLabelSuspect)
    const sevenDay = classifyWindow(
      weekly ? weekly.percent : u.sevenDayPercent, weekly?.resetsAt ?? null, u.fetchedAt, leftAt, now,
      u.accountLabelSuspect)
    return {
      accountId: r.accountId, email: r.email ?? u.accountLabel, isLive, plan: r.plan, mode: r.mode,
      authRegime: r.authRegime,
      observedAt: u.fetchedAt, staleSeconds: Math.max(0, Math.round((now - u.fetchedAt) / 1000)), leftAt,
      fiveHour, sevenDay,
      scopedWeekly: u.limits.filter(l => l.kind === 'weekly_scoped'),
      usageCreditsEnabled: u.usageCreditsEnabled,
      freshness: SEVERITY[fiveHour.freshness] >= SEVERITY[sevenDay.freshness] ? fiveHour.freshness : sevenDay.freshness,
      accountLabelSuspect: u.accountLabelSuspect,
    }
  })

  return {
    accounts,
    liveAccountId,
    blind: accounts.length === 0,
    note: 'Every row is what was OBSERVED while that account was live — no credential is read to '
      + 'produce it. A `rolled` window is INFERRED from its resetsAt plus this machine having been off '
      + 'the account; check `leftAt` before acting on it.',
  }
}
