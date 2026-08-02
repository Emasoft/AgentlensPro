// src/subscriptionUsage.ts — the AUTHORITATIVE 5h / 7d subscription window utilization.
//
// Everything else in this codebase infers how full the rate-limit windows are: capacityCalibration
// derives a lower bound on the cap from observed rate-limit hits, and computeWindowBudget projects
// against it (`capacitySource: observed | same-plan-proxy | none`, and no ETA at all when
// uncalibrated). Anthropic publishes the real number — the same one `/usage` renders — through an
// undocumented OAuth endpoint, so this module replaces an estimate with a measurement.
//
//   GET https://api.anthropic.com/api/oauth/usage
//   Authorization: Bearer <accessToken>
//   anthropic-beta: oauth-2025-04-20
//   User-Agent:    claude-code/<version>     <- LOAD-BEARING, see UA note below
//
// Technique credit: pizzimenti/ccgauge (usage.py). Endpoint is community-reverse-engineered and
// UNDOCUMENTED — it can change or vanish without notice, so every failure path degrades to "no
// reading" and never throws.
//
// THREE THINGS THAT ARE EASY TO GET WRONG, all learned from ccgauge or measured here:
//  1. The token is NOT always in a file. ccgauge reads ~/.claude/.credentials.json; on macOS that
//     file does not exist and the blob lives in the login keychain. A file-only reader silently
//     reports "no token" on every Mac.
//  2. A keychain read by a binary the item is not ACL'd for POPS A PASSWORD PROMPT. So it is
//     opt-in (AGENTLENS_READ_KEYCHAIN_USAGE=1) and latched once per process — the same discipline
//     accountInfo.ts already uses for the plan type, and for the same reason.
//  3. The endpoint 429s hard, and knocking again RE-ARMS the server-side lockout instead of
//     queueing. Hence: a TTL cache, Retry-After honored, exponential backoff on CONSECUTIVE 429s,
//     and a cross-process lock so two callers cannot double-hit and then fail to escalate.

import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dataPath } from './dataDir'
import { getCurrentAccount } from './accountInfo'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** Resolves a TOKEN to the identity it authenticates as — the only trustworthy answer to "whose
 *  numbers are these?", because the usage endpoint itself carries no identity and answers purely to
 *  the presented credential. Same OAuth beta header, same bearer.
 *
 *  MEASURED 2026-08-01, and it is why this exists: the token in this machine's keychain resolved to
 *  `second@example.com` (rate_limit_tier default_claude_max_5x) while `~/.claude.json`
 *  simultaneously claimed `owner@example.com` (default_claude_max_20x). Labelling a usage reading
 *  from the config file therefore attributed one account's utilization to a different account, under
 *  a name the reader had no reason to doubt. Shape: { account: { email, uuid, full_name },
 *  organization: { name, rate_limit_tier, … } }. Technique credit: claude-multi-usage (OAuthService).  */
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const USAGE_BETA = 'oauth-2025-04-20'
const DEFAULT_UA = 'claude-code/2.1.220'

export const TTL_MS = 600_000          // never refetch inside this window
const BACKOFF_BASE_MS = 600_000        // first 429 (when the server names no Retry-After)...
const BACKOFF_CAP_MS = 7_200_000       // ...doubling per CONSECUTIVE 429, capped at 2h
const HTTP_TIMEOUT_MS = 8_000

/** One limit bucket as the endpoint reports it. Read `limits[]` rather than the named `five_hour` /
 *  `seven_day` fields: the payload already carries several unreleased buckets, and per-model
 *  `weekly_scoped` entries, that named-field parsing silently drops. */
export interface UsageLimit {
  kind: string                 // session | weekly_all | weekly_scoped | …
  group: string                // session | weekly
  /** null when the payload had no parseable percentage. NEVER 0 for that case — 0 means "this window
   *  is empty", which is the most dangerous thing a consumer can be told about a window nobody read. */
  percent: number | null
  severity: string             // normal | critical
  resetsAt: string | null
  isActive: boolean
  scopeLabel: string | null    // e.g. the model a weekly_scoped bucket applies to
  resetsInSeconds: number | null
}

export interface SubscriptionUsage {
  fetchedAt: number
  ageSeconds: number
  stale: boolean
  /** WHICH ACCOUNT these numbers describe — a fingerprint of the OAuth credential they were fetched
   *  with, never the credential. This machine rotates between several accounts, and the endpoint
   *  answers for whichever token you present, so a cache without an account identity will happily
   *  hand you the previous account's utilization after a switch. Null for a reading written before
   *  this field existed — `readCache` coerces the absent key to null so it reads as UNVERIFIABLE
   *  rather than as a mismatch. */
  accountFp: string | null
  /** WHO THE TOKEN IS, resolved from `/api/oauth/profile` with the very credential the usage numbers
   *  were fetched with. This is the authoritative label — it cannot disagree with the numbers,
   *  because the same bearer produced both. Null when the profile lookup failed, which is reported
   *  rather than papered over with the config file's guess. */
  accountUuid: string | null
  accountLabel: string | null
  accountTier: string | null
  /** What `~/.claude.json` CLAIMED the logged-in account was at fetch time, kept only so a
   *  disagreement can be shown. Measured on this machine: the file said owner@example.com /
   *  max_20x while the token resolved to second@example.com / max_5x. */
  localClaimedLabel: string | null
  /** True when the config file's identity does NOT match the token's own. The numbers are still
   *  correct — they belong to `accountLabel` — but any OTHER tool that labels by the config file
   *  (including this repo's OTEL account attribution) is naming the wrong account. */
  accountLabelSuspect: boolean
  /** Was this reading PROVEN to belong to the account that is logged in right now?
   *  `yes` the fingerprints match · `no` they differ, so these are another account's numbers ·
   *  `unknown` the current credential could not be read, so the claim cannot be checked at all.
   *  ALWAYS recomputed when a reading is served — never trusted from the cache file, which is the
   *  mistake that froze `stale` at `false` and let a dead window be reported as current. */
  accountVerified: 'yes' | 'no' | 'unknown'
  /** WHY this reading is what it is — never re-derived after the fact, because doing so mislabels
   *  lock contention as "endpoint unreachable" and races the token/cooldown state. */
  reason: 'fresh' | 'ok' | 'cooldown' | 'no_token' | 'expiring_token' | '429' | 'lock_contended'
        | 'http_error' | 'opt_in_required'
  limits: UsageLimit[]
  fiveHourPercent: number | null
  sevenDayPercent: number | null
  /** True when the account is drawing usage credits — which DROPS the prompt-cache TTL from 1 hour
   *  to 5 minutes, and therefore changes which cache-write rate every main-conversation turn pays. */
  usageCreditsEnabled: boolean | null
  spendPercent: number | null
  note: string
}

// Both spellings, because the endpoint has used both. `ccbroker` measured this against the live API
// and tolerates the pair; we accepted only `utilization`, so a response using the other spelling read
// as "no window" — a null where a real number existed.
interface RawWindow { utilization?: unknown; used_percentage?: unknown; resets_at?: unknown }
interface RawLimit {
  kind?: unknown; group?: unknown; percent?: unknown; severity?: unknown
  resets_at?: unknown; is_active?: unknown
  scope?: { model?: { display_name?: unknown } | null; surface?: unknown } | null
}
interface RawUsage {
  five_hour?: RawWindow; seven_day?: RawWindow
  limits?: RawLimit[]
  extra_usage?: { is_enabled?: unknown } | null
  spend?: { percent?: unknown } | null
}

const cachePath = (): string => dataPath('subscription-usage.json')
const cooldownPath = (): string => dataPath('subscription-usage-cooldown.json')
const lockPath = (): string => dataPath('subscription-usage.lock')

let uaCache: string | null = null
/** `claude-code/<installed version>`. LOAD-BEARING: the endpoint requires a claude-code UA and drops
 *  anything else into an aggressive rate-limit bucket — which presents as the endpoint being down
 *  rather than as a header problem. Derived at runtime so it tracks Claude Code upgrades. */
export function userAgent(): string {
  if (uaCache) return uaCache
  let ua = DEFAULT_UA
  try {
    const out = execFileSync('claude', ['--version'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    if (m) ua = `claude-code/${m[1]}`
  } catch { /* not installed / not on PATH — the pinned fallback is still a valid claude-code UA */ }
  uaCache = ua
  return ua
}

interface Credentials { accessToken?: string; refreshToken?: string; expiresAt?: number }

/** Identify the ACCOUNT a credential belongs to, without ever storing or logging the credential.
 *
 *  Prefer the refresh token: the access token rotates roughly hourly, so fingerprinting it would
 *  invalidate the cache on every rotation. The refresh token is LONGER-lived, not permanent —
 *  Anthropic rotates it server-side on refresh (documented by claude-multi-usage, which dropped the
 *  idea of reading Claude Code's tokens precisely because self-refreshing them would rotate the
 *  chain out from under Claude Code and log the user out). So this fingerprint can change without
 *  an account switch. That is the SAFE direction and the whole reason to key on it: a change yields
 *  a cache MISS and one extra request, never another account's numbers under this account's name.
 *
 *  COROLLARY, and it is a landmine: this module must NEVER call the token-refresh endpoint with
 *  Claude Code's credential. Reading the access token is inert; refreshing it would invalidate the
 *  session the user is working in. */
function fingerprint(c: Credentials): string | null {
  const basis = c.refreshToken || c.accessToken
  return basis ? createHash('sha256').update(basis).digest('hex').slice(0, 16) : null
}

/** The OAuth token, from the credentials FILE first (cheap, no prompt) and only then the macOS
 *  keychain behind an explicit opt-in. Returns the token in a local scope only — callers get the
 *  usage numbers, never the secret. */
export function loadToken(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allowKeychain?: boolean } = {},
): { token?: string; expiresAt?: number; fp?: string | null; reason?: SubscriptionUsage['reason'] } {
  const base = env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude')
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(base, '.credentials.json'), 'utf8')) as Record<string, unknown>
    const inner = (raw['claudeAiOauth'] && typeof raw['claudeAiOauth'] === 'object')
      ? raw['claudeAiOauth'] as Credentials : raw as Credentials
    if (typeof inner.accessToken === 'string' && inner.accessToken) {
      return {
        token: inner.accessToken,
        expiresAt: typeof inner.expiresAt === 'number' ? inner.expiresAt : undefined,
        fp: fingerprint(inner),
      }
    }
  } catch { /* absent on macOS by design — fall through to the keychain */ }
  if (process.platform !== 'darwin') return { reason: 'no_token' }
  // Opt-in ONLY: an un-ACL'd keychain read pops a macOS password prompt, and this module can be
  // called from a status line or a hook, where a prompt storm is unacceptable.
  //
  // `opts.allowKeychain` is that same judgement made per CALL SITE rather than per machine: a
  // command the user typed and is watching (`budget`) can afford one prompt, a hook cannot. It
  // matters because on macOS the env var is unset by default, so the endpoint is never refreshed
  // and the cache silently ages into uselessness — which is exactly how a six-day-old 96% came to
  // be served as the current figure while the account was at 37%.
  if (env['AGENTLENS_READ_KEYCHAIN_USAGE'] !== '1' && !opts.allowKeychain) return { reason: 'opt_in_required' }
  try {
    const raw = JSON.parse(execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) as Record<string, unknown>
    const inner = (raw['claudeAiOauth'] && typeof raw['claudeAiOauth'] === 'object')
      ? raw['claudeAiOauth'] as Credentials : {}
    if (typeof inner.accessToken === 'string' && inner.accessToken) {
      return {
        token: inner.accessToken,
        expiresAt: typeof inner.expiresAt === 'number' ? inner.expiresAt : undefined,
        fp: fingerprint(inner),
      }
    }
  } catch { /* denied / timeout / absent */ }
  return { reason: 'no_token' }
}

export interface TokenIdentity { email: string | null; accountUuid: string | null; tier: string | null }

/** Ask the API who this credential is. Fail-soft: a null identity is reported as "unresolved" and is
 *  never quietly replaced by the config file's claim, because that substitution is the entire bug —
 *  it is what let one account's utilization be printed under another account's name. */
export async function fetchTokenIdentity(token: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<TokenIdentity | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': USAGE_BETA,
        'User-Agent': userAgent(),
        Accept: 'application/json',
      },
      signal: ctl.signal,
    })
    if (!res.ok) return null
    const j = await res.json() as { account?: { email?: unknown; uuid?: unknown; full_name?: unknown }
      organization?: { rate_limit_tier?: unknown } }
    const s = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null
    return {
      email: s(j.account?.email) ?? s(j.account?.full_name),
      accountUuid: s(j.account?.uuid),
      tier: s(j.organization?.rate_limit_tier),
    }
  } catch {
    return null
  } finally { clearTimeout(timer) }
}

function readCooldown(): { until: number; consecutive: number } {
  try {
    const o = JSON.parse(fs.readFileSync(cooldownPath(), 'utf8')) as { until?: unknown; consecutive?: unknown }
    return { until: typeof o.until === 'number' ? o.until : 0, consecutive: typeof o.consecutive === 'number' ? o.consecutive : 0 }
  } catch { return { until: 0, consecutive: 0 } }
}

/** Arm the back-off. Honors the server's Retry-After when given; otherwise doubles per CONSECUTIVE
 *  429 so a run of header-less 429s stretches the wait instead of re-arming the lockout every
 *  fixed interval. */
export function armCooldown(retryAfterSeconds: number | null, now = Date.now()): number {
  const prev = readCooldown().consecutive
  const consecutive = prev + 1
  const delay = retryAfterSeconds && retryAfterSeconds > 0
    ? Math.max(retryAfterSeconds * 1000, 60_000)
    : Math.min(BACKOFF_BASE_MS * 2 ** (consecutive - 1), BACKOFF_CAP_MS)
  try { fs.writeFileSync(cooldownPath(), JSON.stringify({ until: now + delay, consecutive })) } catch { /* best effort */ }
  return delay
}

/** Retry-After (delta-seconds or HTTP-date), then Anthropic's own reset headers (epoch or ISO). */
export function retryAfterSeconds(headers: Headers | null, now = Date.now()): number | null {
  if (!headers) return null
  const ra = headers.get('retry-after')?.trim()
  if (ra) {
    if (/^\d+$/.test(ra)) return Number(ra)
    const t = Date.parse(ra)
    if (!isNaN(t)) return Math.max(0, Math.round((t - now) / 1000))
  }
  for (const key of ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-unified-5h-reset',
                     'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']) {
    const v = headers.get(key)?.trim()
    if (!v) continue
    if (/^\d+$/.test(v)) { const s = Number(v) - Math.floor(now / 1000); if (s > 0) return s }
    const t = Date.parse(v)
    if (!isNaN(t)) { const s = Math.round((t - now) / 1000); if (s > 0) return s }
  }
  return null
}

function secsUntil(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return isNaN(t) ? null : Math.round((t - now) / 1000)
}

/** A window's fill, whichever way the endpoint spelled it this time. Both are percentages (0-100). */
export function windowPct(w: RawWindow | null | undefined): number | null {
  for (const v of [w?.utilization, w?.used_percentage]) {
    if (typeof v === 'number' && isFinite(v)) return v
  }
  return null
}

/** `resets_at` in every shape the endpoint has produced, normalized to an ISO string.
 *
 *  MEASURED BY `ccbroker` AGAINST THE LIVE API: it may be a unix timestamp in SECONDS or in
 *  MILLISECONDS, as a JSON number or as a numeric string, or an RFC3339 string. We accepted only the
 *  string form, so a numeric epoch became `null` — and a null `resetsAt` silently disables the
 *  already-reset check in `deriveStale()` and the `rolled` verdict in allAccounts.ts. A window that
 *  had rolled would then be served as if it were current, which is exactly the four-days-stale 96%
 *  incident `deriveStale`'s own comment was written after.
 *
 *  The 1e12 threshold is ccbroker's: below it the value cannot plausibly be milliseconds (1e12 ms is
 *  2001), so it is seconds. */
export function normalizeResetsAt(raw: unknown): string | null {
  let n: number | null = null
  if (typeof raw === 'number' && isFinite(raw)) {
    n = raw
  } else if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return null
    if (/^\d+(\.\d+)?$/.test(s)) {
      n = Number(s)
    } else {
      const t = Date.parse(s)
      return isNaN(t) ? null : s          // already a date string — keep it verbatim
    }
  }
  if (n === null) return null
  const ms = n < 1e12 ? n * 1000 : n
  const d = new Date(ms)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export function normalize(
  body: RawUsage,
  fetchedAt: number,
  reason: SubscriptionUsage['reason'],
  now = Date.now(),
  accountFp: string | null = null,
  identity: TokenIdentity | null = null,
  localClaimedLabel: string | null = null,
): SubscriptionUsage {
  const num = (v: unknown): number | null => typeof v === 'number' && isFinite(v) ? v : null
  const limits: UsageLimit[] = (Array.isArray(body.limits) ? body.limits : []).map(l => {
    const resetsAt = normalizeResetsAt(l.resets_at)
    return {
      kind: typeof l.kind === 'string' ? l.kind : 'unknown',
      group: typeof l.group === 'string' ? l.group : 'unknown',
      // NOT `?? 0`. A percentage that could not be parsed is UNKNOWN, and rendering it as an empty
      // window is the single worst substitution this module can make — every consumer downstream reads
      // 0 as "all the headroom in the world". The one place that formats it prints `?`, and the two
      // that compute on it already skip a null.
      percent: num(l.percent),
      severity: typeof l.severity === 'string' ? l.severity : 'normal',
      resetsAt,
      isActive: l.is_active === true,
      scopeLabel: typeof l.scope?.model?.display_name === 'string' ? l.scope.model.display_name : null,
      resetsInSeconds: secsUntil(resetsAt, now),
    }
  })
  const ageSeconds = Math.max(0, Math.round((now - fetchedAt) / 1000))
  return {
    fetchedAt, ageSeconds,
    stale: ageSeconds * 1000 > TTL_MS * 3,
    accountFp,
    accountUuid: identity?.accountUuid ?? null,
    accountLabel: identity?.email ?? null,
    accountTier: identity?.tier ?? null,
    localClaimedLabel,
    // The token's own identity vs what the config file claims. Only a real, observed disagreement —
    // never asserted when either side is unknown, because "we could not check" is not a mismatch.
    accountLabelSuspect: identity?.email !== null && identity?.email !== undefined
      && localClaimedLabel !== null && identity.email !== localClaimedLabel,
    // A LIVE fetch is by construction the current account's — the endpoint answered the very token
    // we just presented. Unknown only when that token could not be fingerprinted.
    accountVerified: accountFp === null ? 'unknown' : 'yes',
    reason,
    limits,
    fiveHourPercent: windowPct(body.five_hour),
    sevenDayPercent: windowPct(body.seven_day),
    usageCreditsEnabled: typeof body.extra_usage?.is_enabled === 'boolean' ? body.extra_usage.is_enabled : null,
    spendPercent: num(body.spend?.percent),
    note: 'Utilization is Anthropic\'s own figure for this account (the numbers /usage shows), not a '
      + 'local projection. Endpoint is undocumented and community-reverse-engineered.',
  }
}

/** NORMALIZE ABSENCE AT THE BOUNDARY. A cache file written before the identity fields existed simply
 *  has no such key, and JSON has no `undefined` — so the parsed value is `undefined`, and
 *  `undefined === null` is FALSE. Every identity comparison downstream is written against `null`, so
 *  without this coercion a pre-upgrade file takes the "fingerprints differ" branch and a perfectly
 *  valid reading gets reported as ANOTHER ACCOUNT'S. Absent and null must be the same thing exactly
 *  once — here — rather than at each of the comparison sites. Shared by the live cache and the
 *  per-account archive so a record cannot mean two different things depending on which file it is in. */
function normalizeCacheRecord(raw: Partial<SubscriptionUsage> | null): SubscriptionUsage | null {
  if (!raw || typeof raw.fetchedAt !== 'number') return null
  return {
    ...(raw as SubscriptionUsage),
    accountFp: raw.accountFp ?? null,
    accountUuid: raw.accountUuid ?? null,
    accountLabel: raw.accountLabel ?? null,
    accountTier: raw.accountTier ?? null,
    localClaimedLabel: raw.localClaimedLabel ?? null,
    accountLabelSuspect: raw.accountLabelSuspect === true,
    limits: Array.isArray(raw.limits) ? raw.limits : [],
  }
}

function readCache(): SubscriptionUsage | null {
  try {
    return normalizeCacheRecord(JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<SubscriptionUsage>)
  } catch { return null }
}

// ─── Per-account archive ────────────────────────────────────────────────────────────────────────
//
// WHY IT EXISTS. The live cache above is ONE file, overwritten on every fetch, so a rotation destroys
// the previous account's numbers — and "where does every account stand" is then unanswerable for any
// account that is not live right now. That is the bootstrap paradox in issue #8: deciding whether to
// rotate needs the headroom of the accounts you are NOT on, and the only way to learn it was to
// already be on them. Measured cost: a host stalled at the limit for hours while one of its accounts
// had a nearly empty window that nothing could see.
//
// It is deliberately ADDITIVE — the live cache keeps its exact behaviour (TTL, cooldown, lock, every
// existing consumer). This side-write only stops us from THROWING AWAY what we already fetched.
//
// KEYED BY accountUuid, NOT accountFp. The fingerprint is derived from the REFRESH token, which
// Anthropic rotates server-side (see fingerprint() above), so it changes without an account switch —
// keying files on it would scatter one account across a growing pile of orphaned files and never
// group by account at all. The uuid is the stable identity; the fp stays INSIDE the record as the
// cache-validity key it already is. (The issue comment proposed <accountFp>.json; reading
// fingerprint()'s own doc comment is what corrected it.)
//
// It cannot be backfilled: a reading not archived at fetch time is gone. That is why this ships
// before the plural verb that consumes it, not with it.

const accountUsageDir = (): string => dataPath('subscription-usage')

/** A uuid comes from the NETWORK (`fetchTokenIdentity`), and this one becomes a path segment. Anything
 *  outside hex-and-dashes is refused rather than sanitized: a value that is not a uuid is not an
 *  identity we can file under, and "clean it up and use it anyway" is how `../` becomes a filename. */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
function accountUsagePath(uuid: string): string | null {
  return UUID_SHAPE.test(uuid) ? path.join(accountUsageDir(), `${uuid}.json`) : null
}

/** File a reading under its own account. No-op when the account could not be identified: an
 *  unattributed row cannot answer "whose numbers are these", and inventing a key for it would put one
 *  account's figures under a name that means nothing — the exact misattribution the accountFp/
 *  accountVerified machinery exists to prevent. Best-effort: the live cache is still authoritative for
 *  the live account, so a failure here degrades the plural view, never the singular one. */
export function archiveAccountUsage(u: SubscriptionUsage | null): void {
  if (!u || !u.accountUuid) return
  const dest = accountUsagePath(u.accountUuid)
  if (!dest) return
  try {
    fs.mkdirSync(accountUsageDir(), { recursive: true })
    // Write-then-rename: a reader can hit this file at any moment, and a half-written JSON parses as
    // nothing at all — which would read as "this account was never observed", the one answer that
    // must never be fabricated.
    const tmp = `${dest}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(u))
    fs.renameSync(tmp, dest)
  } catch { /* best effort */ }
}

/** Every account this machine has ever fetched a reading for, newest-first.
 *
 *  Adopts the legacy single-file cache on the way past, so the one reading already on disk when this
 *  shipped is not lost — but only when it is NEWER than what is already filed for that account, or a
 *  stale legacy file would clobber a fresher archived record on every call. */
export function listObservedAccountUsage(): SubscriptionUsage[] {
  const legacy = readCache()
  if (legacy?.accountUuid) {
    const dest = accountUsagePath(legacy.accountUuid)
    let existing: SubscriptionUsage | null = null
    if (dest) { try { existing = normalizeCacheRecord(JSON.parse(fs.readFileSync(dest, 'utf8')) as Partial<SubscriptionUsage>) } catch { /* none yet */ } }
    if (!existing || legacy.fetchedAt > existing.fetchedAt) archiveAccountUsage(legacy)
  }
  let names: string[]
  try { names = fs.readdirSync(accountUsageDir()) } catch { return [] }
  const out: SubscriptionUsage[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue                       // skips any .tmp-<pid> mid-write
    if (!UUID_SHAPE.test(n.slice(0, -5))) continue           // and anything that is not one of ours
    try {
      const rec = normalizeCacheRecord(JSON.parse(fs.readFileSync(path.join(accountUsageDir(), n), 'utf8')) as Partial<SubscriptionUsage>)
      if (rec) out.push(rec)
    } catch { /* an unreadable record is one account we cannot report, not a reason to report none */ }
  }
  return out.sort((a, b) => b.fetchedAt - a.fetchedAt)
}

/** Is this reading obsolete? TWO independent ways, and the second is the one that matters most.
 *
 *  Age is the obvious one. The other is that a reading whose window has already RESET describes a
 *  window that no longer exists — no matter how recently it was fetched. `resetsAt` is an absolute
 *  instant, so that check needs no trust in our own clock bookkeeping, which is precisely what
 *  failed here: a snapshot of the weekly window that rolled on 2026-07-28 was still being served,
 *  and reported as the CURRENT 96%, four days after that window ceased to exist. */
export function deriveStale(u: SubscriptionUsage, now: number): boolean {
  if (now - u.fetchedAt > TTL_MS * 3) return true
  return u.limits.some(l => {
    if (l.resetsAt === null) return false
    const t = Date.parse(l.resetsAt)
    return !isNaN(t) && t <= now
  })
}

/** The ONLY way this module may serve a cached reading.
 *
 *  `ageSeconds` and `stale` are computed in `normalize` at WRITE time, so the values PERSISTED in
 *  the cache file are permanently `0` and `false`. Spreading the cache verbatim therefore hands the
 *  caller a six-day-old snapshot that self-reports as "0s old, not stale" — and every staleness
 *  guard downstream, including this module's own `⚠ NOT LIVE` banner and its suppression of the
 *  reset countdown, is keyed on exactly that frozen `false` and so can never fire. That is how
 *  `budget`/`get_subscription_usage` reported a 7d window at 96% while the account was really at
 *  36%. Both fields, plus every `resetsInSeconds` countdown, are re-derived against `now` here.
 *
 *  On macOS the token lives in the keychain and is read only behind an explicit opt-in, so
 *  `opt_in_required` is the DEFAULT path, not an edge case — these returns are the common ones. */
function fromCache(
  cached: SubscriptionUsage,
  reason: SubscriptionUsage['reason'],
  now: number,
  currentFp: string | null,
): SubscriptionUsage {
  // This machine switches between several accounts and the endpoint answers for whichever token is
  // presented, so "is this reading even about the account I am logged into?" is a question the
  // cache cannot answer by itself. Unprovable is treated as unusable, not as a pass: `unknown`
  // (no readable credential) is stale for the same reason `no` is — we would be asserting a number
  // we cannot attribute.
  // VERIFICATION IS ON THE CREDENTIAL, NEVER ON `~/.claude.json`. Measured 2026-08-01: the usage
  // endpoint's response carries NO identity field of any kind (top-level keys are all usage
  // buckets; the only match for /account|email|user/ is `extra_usage.user_disabled`). The answer is
  // therefore determined by exactly one thing — the token presented. Swapping the token WITHOUT
  // touching the logged-in email is enough to get another account's numbers back, so
  // `oauthAccount.accountUuid` from the config file is a LABEL that can disagree with the
  // credential, and keying verification on it would reject a perfectly valid reading whenever the
  // file lagged. Same credential ⇒ same account, by construction; that is the only sound test.
  const verified: SubscriptionUsage['accountVerified'] =
    currentFp === null || cached.accountFp === null ? 'unknown'
      : cached.accountFp === currentFp ? 'yes' : 'no'
  // Do the label and the credential move TOGETHER? They were recorded side by side at fetch time,
  // so if one changed and the other did not, they have diverged and the email shown is not evidence
  // of anything. XOR, because the failure is symmetric: a token swapped under an unchanged email
  // (the observed case) and an email changed under an unchanged token are both a lying label.
  // The mismatch was already decided at FETCH time by comparing the token's own identity against the
  // config file's claim, so it carries forward unchanged. Re-deriving it here from the file would
  // reintroduce the very substitution this field exists to expose.
  return {
    ...cached,
    ageSeconds: Math.max(0, Math.round((now - cached.fetchedAt) / 1000)),
    // FRESHNESS ONLY. Attribution is a separate axis reported by `accountVerified`, and conflating
    // them called a 13-second-old reading "NOT LIVE" merely because this process could not read the
    // credential to check whose it was. A consumer that must not act on an unattributed reading
    // (`budget`) tests both fields; one that only wants to know whether the numbers are current
    // tests this one. Neither is served by collapsing two different doubts into one flag.
    stale: deriveStale(cached, now),
    accountVerified: verified,
    limits: cached.limits.map(l => ({ ...l, resetsInSeconds: secsUntil(l.resetsAt, now) })),
    reason,
  }
}

/** Fetch (or serve cache) the subscription window utilization. Never throws. */
export async function getSubscriptionUsage(
  opts: { force?: boolean; now?: number; allowKeychain?: boolean } = {},
): Promise<SubscriptionUsage | null> {
  const now = opts.now ?? Date.now()
  const cached = readCache()
  // Identify the CURRENT account BEFORE trusting any cached reading. This has to happen first —
  // serving the within-TTL cache without knowing whose token is loaded is precisely how an account
  // switch would be invisible: the numbers would stay put and simply describe the wrong account.
  const { token, expiresAt, fp, reason } = loadToken(process.env, { allowKeychain: opts.allowKeychain })
  const currentFp = fp ?? null
  const serve = (c: SubscriptionUsage | null, r: SubscriptionUsage['reason']): SubscriptionUsage | null =>
    c ? fromCache(c, r, now, currentFp) : null

  if (!opts.force && cached && now - cached.fetchedAt < TTL_MS && cached.accountFp === currentFp && currentFp !== null) {
    return serve(cached, 'fresh')
  }
  const cool = readCooldown()
  if (cool.until > now) return serve(cached, 'cooldown')
  if (!token) return serve(cached, reason ?? 'no_token')
  // Expired or about to expire: do not spend a request on a token Claude Code is about to rotate.
  if (expiresAt && expiresAt < now + 30_000) return serve(cached, 'expiring_token')

  // Cross-process guard. Two callers can both clear the cooldown check above before either fires;
  // without this they double-hit the endpoint and, reading the same consecutive-429 count, fail to
  // escalate the back-off. `wx` is the atomic create-or-fail primitive; a stale lock older than the
  // HTTP timeout is reclaimed so a crashed holder cannot wedge this forever.
  let held = false
  try {
    fs.writeFileSync(lockPath(), String(process.pid), { flag: 'wx' })
    held = true
  } catch {
    try {
      const age = now - fs.statSync(lockPath()).mtimeMs
      if (age > HTTP_TIMEOUT_MS * 2) { fs.writeFileSync(lockPath(), String(process.pid)); held = true }
    } catch { /* fall through */ }
    if (!held) return serve(cached, 'lock_contended')
  }
  try {
    // Re-check under the lock: whoever won it may have just refreshed or armed a cooldown (TOCTOU).
    const again = readCache()
    if (!opts.force && again && now - again.fetchedAt < TTL_MS && again.accountFp === currentFp && currentFp !== null) {
      return serve(again, 'fresh')
    }
    if (readCooldown().until > now) return serve(again, 'cooldown')

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS)
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': USAGE_BETA,
          'User-Agent': userAgent(),
          Accept: 'application/json',
        },
        signal: ctl.signal,
      })
      if (res.status === 429) {
        armCooldown(retryAfterSeconds(res.headers, now), now)
        return serve(cached, '429')
      }
      if (!res.ok) return serve(cached, 'http_error')
      // Resolve WHOSE numbers these are from the same credential that just produced them. One extra
      // request, cached with the reading, and it is the difference between a labelled figure and a
      // misattributed one.
      const identity = await fetchTokenIdentity(token)
      const claimed = getCurrentAccount().email
      const usage = normalize(await res.json() as RawUsage, now, 'ok', now, currentFp, identity, claimed)
      try { fs.writeFileSync(cachePath(), JSON.stringify(usage)) } catch { /* best effort */ }
      // The SAME reading, also filed under its own account. This is the only moment it can be kept:
      // the next fetch overwrites the line above, and a reading not archived here is gone forever.
      archiveAccountUsage(usage)
      try { fs.unlinkSync(cooldownPath()) } catch { /* no cooldown to clear */ }
      return usage
    } finally { clearTimeout(timer) }
  } catch {
    return serve(cached, 'http_error')
  } finally {
    if (held) { try { fs.unlinkSync(lockPath()) } catch { /* already gone */ } }
  }
}

const BAR_CELLS = 10
/** A `cells`-segment bar. The percentage is deliberately NOT drawn inside it (it would occlude
 *  segments) — render the number alongside. */
export function usageBar(percent: number, cells = BAR_CELLS): string {
  const p = Math.max(0, Math.min(100, isFinite(percent) ? percent : 0))
  const filled = Math.max(0, Math.min(cells, Math.round((p / 100) * cells)))
  return `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`
}

/** Age as a human reads it. `Math.round(ageSeconds / 60)}m` rendered a six-day-old cache as
 *  "8525m ago", which buries the one fact the warning exists to convey. */
function humanAge(secs: number): string {
  if (secs < 90) return `${Math.max(0, Math.round(secs))}s`
  const m = Math.round(secs / 60)
  if (m < 90) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Name the stronger reason when it applies: an EXPIRED window is not merely an old reading, it is a
 *  reading of something that no longer exists, and a reader who sees only "old" may still anchor on
 *  the percentage. */
function rolledNote(u: SubscriptionUsage): string {
  const rolled = u.limits.filter(l => {
    if (l.resetsAt === null) return false
    const t = Date.parse(l.resetsAt)
    return !isNaN(t) && t <= Date.now()
  })
  if (rolled.length === 0) return ''
  const which = rolled.length === u.limits.length
    ? `every window shown has`
    : `${rolled.length} of the ${u.limits.length} windows shown have`
  return `; ${which} ALREADY RESET since this was read`
}

function humanReset(secs: number | null): string {
  if (secs === null) return ''
  if (secs <= 0) return 'now'
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
  return h ? `in ${h}h ${m}m` : `in ${m}m`
}

export function formatSubscriptionUsage(u: SubscriptionUsage | null): string {
  if (!u) return 'subscription usage: unavailable (no token, opt-in required, or endpoint unreachable)'
  // The header is the claim a reader acts on. "Anthropic's own numbers" is true of a LIVE read and
  // a lie about a rolled-over snapshot, so the stale branch must not inherit it — an unqualified
  // header is what let a four-day-dead 96% be relayed to a user as their current utilization.
  // Name the account in the header. An unattributed percentage is what let one account's 96% be
  // read as another's current utilization; a reader who sees the email can spot that instantly.
  // The label is the TOKEN's own identity, so it cannot disagree with the numbers. When the config
  // file claims a different account, say both — the reader almost certainly believes the file, and
  // every other tool on the machine labels by it.
  const base = u.accountLabel ?? u.accountUuid?.slice(0, 8) ?? 'unresolved account'
  const who = u.accountLabelSuspect
    ? `${base} ⚠ (the token's OWN account — ~/.claude.json claims ${u.localClaimedLabel}, which is a DIFFERENT account)`
    : base
  // "for <email>" is an attribution claim. Make it only when the credential proved it; otherwise
  // name the account as an unverified label, because that is all it is.
  const lines = [u.stale
    ? `Subscription window utilization — ⚠ STALE SNAPSHOT, NOT CURRENT [${who}]`
    : u.accountVerified === 'yes'
      ? `Subscription window utilization for ${who} (Anthropic's own numbers)`
      : `Subscription window utilization (Anthropic's own numbers) — account NOT verified [label: ${who}]`]
  for (const l of u.limits) {
    const scope = l.scopeLabel ? ` ${l.scopeLabel}` : ''
    // A countdown computed from a CACHED resets_at renders as live for a window that may already
    // have rolled — so it is suppressed entirely while stale, not merely annotated.
    const reset = u.stale ? '' : `  resets ${humanReset(l.resetsInSeconds)}`
    // An unparseable percentage renders as `?`, not as an empty bar. A drawn-empty bar is read as
    // "nothing used" at a glance, which is the opposite of "we do not know".
    const bar = l.percent === null ? '[unreadable]' : usageBar(l.percent)
    const pct = l.percent === null ? '  ?' : String(l.percent).padStart(3)
    lines.push(`  ${(l.kind + scope).padEnd(22)} ${bar} ${pct}%  ${l.severity}${reset}`)
  }
  if (u.usageCreditsEnabled !== null) {
    lines.push(`  usage credits: ${u.usageCreditsEnabled ? 'ENABLED — prompt-cache TTL drops to 5 min' : 'disabled — 1-hour prompt-cache TTL active'}`)
  }
  // Name the account problem separately from the age problem: they call for different actions —
  // one is "refresh me", the other is "these belong to someone else".
  const acct = u.accountVerified === 'no'
    ? ' ⚠ ANOTHER ACCOUNT — the logged-in credential is not the one these were fetched with; do not read them as yours.'
    : u.accountVerified === 'unknown'
      ? ' ⚠ UNATTRIBUTED — could not read the current credential, so these cannot be confirmed to be THIS account\'s'
        + ' (set AGENTLENS_READ_KEYCHAIN_USAGE=1 to let this process check).'
      : ''
  if (u.stale) {
    lines.push(`  ⚠ NOT LIVE — last good read ${humanAge(u.ageSeconds)} ago (${u.reason})${rolledNote(u)}. Do not trust these values; run /usage in-app.${acct}`)
  } else {
    lines.push(`  [${u.accountVerified === 'yes' ? 'live · account verified' : 'live'} · cache ${u.ageSeconds}s old · ${u.reason}]${acct}`)
  }
  return lines.join('\n')
}
