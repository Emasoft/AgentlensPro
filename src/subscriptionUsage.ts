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
  percent: number
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
  /** A HUMAN LABEL for the fingerprint, read from `~/.claude.json`'s `oauthAccount` so a usage
   *  number can be lined up against the burn numbers `get_window_eta` and the OTEL feed report for
   *  the same account. **Display only, and not trustworthy as identity**: the usage endpoint carries
   *  no identity of its own and answers purely to the presented token, so swapping the token without
   *  editing that file yields another account's numbers under an unchanged email. Never decide
   *  anything on this — decide on `accountFp`. */
  accountUuid: string | null
  accountLabel: string | null
  /** True when the config file's identity does NOT match the credential the reading was fetched
   *  with, i.e. the label above is known to be lying. Reported, never acted on. */
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

interface RawWindow { utilization?: unknown; resets_at?: unknown }
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
 *  invalidate the cache on every rotation. The refresh token is stable for as long as the login is,
 *  which is exactly the lifetime we want the cache scoped to. Either way a CHANGE of account yields
 *  a fingerprint mismatch, so the cache MISSES rather than returning another account's numbers —
 *  a miss costs one request, a wrong number costs a wrong decision. */
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

export function normalize(
  body: RawUsage,
  fetchedAt: number,
  reason: SubscriptionUsage['reason'],
  now = Date.now(),
  accountFp: string | null = null,
  account: { accountUuid: string | null; label: string | null } = { accountUuid: null, label: null },
): SubscriptionUsage {
  const num = (v: unknown): number | null => typeof v === 'number' && isFinite(v) ? v : null
  const limits: UsageLimit[] = (Array.isArray(body.limits) ? body.limits : []).map(l => {
    const resetsAt = typeof l.resets_at === 'string' ? l.resets_at : null
    return {
      kind: typeof l.kind === 'string' ? l.kind : 'unknown',
      group: typeof l.group === 'string' ? l.group : 'unknown',
      percent: num(l.percent) ?? 0,
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
    accountUuid: account.accountUuid,
    accountLabel: account.label,
    // A live fetch records the label and the credential in the same breath — nothing to diverge yet.
    accountLabelSuspect: false,
    // A LIVE fetch is by construction the current account's — the endpoint answered the very token
    // we just presented. Unknown only when that token could not be fingerprinted.
    accountVerified: accountFp === null ? 'unknown' : 'yes',
    reason,
    limits,
    fiveHourPercent: num(body.five_hour?.utilization),
    sevenDayPercent: num(body.seven_day?.utilization),
    usageCreditsEnabled: typeof body.extra_usage?.is_enabled === 'boolean' ? body.extra_usage.is_enabled : null,
    spendPercent: num(body.spend?.percent),
    note: 'Utilization is Anthropic\'s own figure for this account (the numbers /usage shows), not a '
      + 'local projection. Endpoint is undocumented and community-reverse-engineered.',
  }
}

function readCache(): SubscriptionUsage | null {
  let raw: Partial<SubscriptionUsage> | null = null
  try { raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Partial<SubscriptionUsage> } catch { return null }
  if (!raw || typeof raw.fetchedAt !== 'number') return null
  // NORMALIZE ABSENCE AT THE BOUNDARY. A cache file written before the identity fields existed
  // simply has no such key, and JSON has no `undefined` — so the parsed value is `undefined`, and
  // `undefined === null` is FALSE. Every identity comparison downstream is written against `null`,
  // so without this coercion a pre-upgrade file takes the "fingerprints differ" branch and a
  // perfectly valid reading gets reported as ANOTHER ACCOUNT'S. Absent and null must be the same
  // thing exactly once, here, rather than at each of the comparison sites.
  return {
    ...(raw as SubscriptionUsage),
    accountFp: raw.accountFp ?? null,
    accountUuid: raw.accountUuid ?? null,
    accountLabel: raw.accountLabel ?? null,
    accountLabelSuspect: raw.accountLabelSuspect === true,
    limits: Array.isArray(raw.limits) ? raw.limits : [],
  }
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
  // Only when verification actually HAPPENED. `unknown` means we could not read the credential at
  // all, which is no evidence about the label — treating it as a dispute prints a scary and false
  // "LABEL DISPUTED" on every machine that has not opted into the keychain read.
  const currentUuid = getCurrentAccount().accountUuid
  const labelSuspect = verified !== 'unknown' && currentUuid !== null && cached.accountUuid !== null
    && ((cached.accountUuid === currentUuid) !== (verified === 'yes'))
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
    accountLabelSuspect: labelSuspect,
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
      const who = getCurrentAccount()
      const usage = normalize(await res.json() as RawUsage, now, 'ok', now, currentFp,
        { accountUuid: who.accountUuid, label: who.email ?? who.label })
      try { fs.writeFileSync(cachePath(), JSON.stringify(usage)) } catch { /* best effort */ }
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
  const base = u.accountLabel ?? u.accountUuid?.slice(0, 8) ?? 'unidentified account'
  // The label comes from a config file, the numbers come from a token, and the two can move apart.
  // Say so rather than printing an email that quietly implies an attribution nobody verified.
  const who = u.accountLabelSuspect ? `${base} — LABEL DISPUTED, credential says otherwise` : base
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
    lines.push(`  ${(l.kind + scope).padEnd(22)} ${usageBar(l.percent)} ${String(l.percent).padStart(3)}%  ${l.severity}${reset}`)
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
