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
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { dataPath } from './dataDir'

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

interface Credentials { accessToken?: string; expiresAt?: number }

/** The OAuth token, from the credentials FILE first (cheap, no prompt) and only then the macOS
 *  keychain behind an explicit opt-in. Returns the token in a local scope only — callers get the
 *  usage numbers, never the secret. */
export function loadToken(env: NodeJS.ProcessEnv = process.env): { token?: string; expiresAt?: number; reason?: SubscriptionUsage['reason'] } {
  const base = env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude')
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(base, '.credentials.json'), 'utf8')) as Record<string, unknown>
    const inner = (raw['claudeAiOauth'] && typeof raw['claudeAiOauth'] === 'object')
      ? raw['claudeAiOauth'] as Credentials : raw as Credentials
    if (typeof inner.accessToken === 'string' && inner.accessToken) {
      return { token: inner.accessToken, expiresAt: typeof inner.expiresAt === 'number' ? inner.expiresAt : undefined }
    }
  } catch { /* absent on macOS by design — fall through to the keychain */ }
  if (process.platform !== 'darwin') return { reason: 'no_token' }
  // Opt-in ONLY: an un-ACL'd keychain read pops a macOS password prompt, and this module can be
  // called from a status line or a hook, where a prompt storm is unacceptable.
  if (env['AGENTLENS_READ_KEYCHAIN_USAGE'] !== '1') return { reason: 'opt_in_required' }
  try {
    const raw = JSON.parse(execFileSync('security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) as Record<string, unknown>
    const inner = (raw['claudeAiOauth'] && typeof raw['claudeAiOauth'] === 'object')
      ? raw['claudeAiOauth'] as Credentials : {}
    if (typeof inner.accessToken === 'string' && inner.accessToken) {
      return { token: inner.accessToken, expiresAt: typeof inner.expiresAt === 'number' ? inner.expiresAt : undefined }
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

export function normalize(body: RawUsage, fetchedAt: number, reason: SubscriptionUsage['reason'], now = Date.now()): SubscriptionUsage {
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
  try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as SubscriptionUsage } catch { return null }
}

/** Fetch (or serve cache) the subscription window utilization. Never throws. */
export async function getSubscriptionUsage(opts: { force?: boolean; now?: number } = {}): Promise<SubscriptionUsage | null> {
  const now = opts.now ?? Date.now()
  const cached = readCache()
  if (!opts.force && cached && now - cached.fetchedAt < TTL_MS) {
    return { ...cached, ageSeconds: Math.round((now - cached.fetchedAt) / 1000), reason: 'fresh' }
  }
  const cool = readCooldown()
  if (cool.until > now) return cached ? { ...cached, reason: 'cooldown' } : null
  const { token, expiresAt, reason } = loadToken()
  if (!token) return cached ? { ...cached, reason: reason ?? 'no_token' } : null
  // Expired or about to expire: do not spend a request on a token Claude Code is about to rotate.
  if (expiresAt && expiresAt < now + 30_000) return cached ? { ...cached, reason: 'expiring_token' } : null

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
    if (!held) return cached ? { ...cached, reason: 'lock_contended' } : null
  }
  try {
    // Re-check under the lock: whoever won it may have just refreshed or armed a cooldown (TOCTOU).
    const again = readCache()
    if (!opts.force && again && now - again.fetchedAt < TTL_MS) return { ...again, reason: 'fresh' }
    if (readCooldown().until > now) return again ? { ...again, reason: 'cooldown' } : null

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
        return cached ? { ...cached, reason: '429' } : null
      }
      if (!res.ok) return cached ? { ...cached, reason: 'http_error' } : null
      const usage = normalize(await res.json() as RawUsage, now, 'ok', now)
      try { fs.writeFileSync(cachePath(), JSON.stringify(usage)) } catch { /* best effort */ }
      try { fs.unlinkSync(cooldownPath()) } catch { /* no cooldown to clear */ }
      return usage
    } finally { clearTimeout(timer) }
  } catch {
    return cached ? { ...cached, reason: 'http_error' } : null
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

function humanReset(secs: number | null): string {
  if (secs === null) return ''
  if (secs <= 0) return 'now'
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60)
  return h ? `in ${h}h ${m}m` : `in ${m}m`
}

export function formatSubscriptionUsage(u: SubscriptionUsage | null): string {
  if (!u) return 'subscription usage: unavailable (no token, opt-in required, or endpoint unreachable)'
  const lines = ['Subscription window utilization (Anthropic\'s own numbers)']
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
  lines.push(u.stale
    ? `  ⚠ NOT LIVE — last good read ${Math.round(u.ageSeconds / 60)}m ago (${u.reason}). Do not trust these values; run /usage in-app.`
    : `  [cache ${u.ageSeconds}s old · ${u.reason}]`)
  return lines.join('\n')
}
