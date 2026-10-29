// src/longOAuthKeys.ts — the owner's long-lived OAuth keys, read by get_account_status --all.
//
// WHY THIS EXISTS. The usage endpoint answers 403 oauth_scope_insufficient to a long-lived key (measured
// 2026-10-29), so the account windows cannot be read the way the live credential reads them. A zero-output-token
// message to claude-fable-5-1 is different: its reply carries the anthropic-ratelimit-unified-* headers on a
// 200 AND on a 429. Those headers are the reading recorded here. A 429 is a valid reading, not a failure: it
// is the server stating that the window is full, which is the measurement itself.
//
// WHAT IT COSTS. One ~33-token Fable message per keyed account, at most once per TTL_MS. The message is billed,
// and on an idle account it probably opens a new 5-hour window. That is why every key is TTL-gated by its own
// stamp, and why --no-refresh skips the network entirely.
//
// NO CREDENTIAL LEAVES THIS MODULE. The token is read from the environment, used for one request and dropped.
// It is never written to a stamp or an archive record, and every string this module returns, stores or throws
// passes through redact(). The one exception to the read-only contract is recorded in src/allAccounts.ts.

import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { listAccountRoster, type AccountRosterEntry } from './accountStateTimeline'
import {
  archiveAccountUsage, listObservedAccountUsage, normalizeResetsAt, TTL_MS, USAGE_BETA,
  type SubscriptionUsage, type UsageLimit,
} from './subscriptionUsage'

/** The env var prefix. Only the two-digit slots _01 to _10 are read, so _1 and _11 are never picked up. */
export const LONG_KEY_PREFIX = 'CLAUDE_CODE_LONG_OAUTH_KEY_'
const SLOT_IDS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']
const PROBE_URL = 'https://api.anthropic.com/v1/messages'
const PROBE_MODEL = 'claude-fable-5-1'
const PROBE_SYSTEM = 'You are Claude Code, Anthropic\'s official CLI for Claude.'
/** The same budget the usage endpoint gets. A probe still unanswered after this is a failed reading. */
export const PROBE_TIMEOUT_MS = 8_000
/** A 7-day reset that matches the archived one within this window is the same window. The slack absorbs the
 *  server's own rounding; it is not allowance for clock skew between accounts. */
const RESET_MATCH_MS = 60_000
const UNIFIED = 'anthropic-ratelimit-unified-'
/** Only three window shapes are windows. The other headers under the same prefix are not: overage-status,
 *  overage-disabled-reason, fallback-percentage, representative-claim, upgrade-paths and 7d-surpassed-threshold
 *  carry a value or a suffix that must never become a limit row. */
const WINDOW_HEADER = /^anthropic-ratelimit-unified-(5h|7d|7d_[^-]+)-(reset|status|utilization)$/
/** The label of a per-model 7-day window, keyed by its header suffix. An unlisted suffix keeps the raw window
 *  name, so an unknown model shows up as itself rather than being named wrongly. */
const SCOPE_LABELS: Readonly<Record<string, string>> = { oi: 'Fable' }

export interface LongKey { slot: string; email: string; token: string }
export interface InvalidKey { slot: string; reason: string }
export interface LoadedKeys { keys: LongKey[]; invalid: InvalidKey[] }

/** refreshed: a new reading was filed under its account. cached: nothing was sent, because an archive record is inside the TTL
 *  and no failed or refused stamp is, or because an unmatched stamp inside the TTL holds the reading. failed: the probe returned
 *  no rate-limit headers (a 401, a 403, a timeout, an error); a stamp inside the TTL that recorded it is replayed with no
 *  reading, even when the archive holds a fresh record. unmatched: a reading for an account that is in neither the archive nor
 *  the roster; it is kept in the stamp only. refused: the identity could not be trusted, so nothing was filed; a stamp inside
 *  the TTL that recorded it is replayed. skipped: --no-refresh. */
export type KeyOutcome = 'refreshed' | 'cached' | 'failed' | 'unmatched' | 'refused' | 'skipped'
/** How the key's account was identified. cross-checked: the 7-day reset agreed with the archived account.
 *  claimed: the archive had no live 7-day window to compare, so the email match stands alone. not-checked: there
 *  was no reading to compare. */
export type IdentityVerdict = 'cross-checked' | 'claimed' | 'refused' | 'unmatched' | 'not-checked'
export type Overage = NonNullable<SubscriptionUsage['overage']>
export interface KeyIdentity {
  accountUuid: string | null; accountLabel: string | null; accountTier: string | null
  localClaimedLabel: string | null; accountLabelSuspect: boolean
}
export interface KeyRow {
  slot: string; email: string; accountId: string | null; outcome: KeyOutcome; identity: IdentityVerdict
  httpStatus: number | null; reason: string | null; overage: Overage | null
  /** The reading this row reports: the archived record for a matched account, the stamped one for an unmatched
   *  account, and null when there is none. */
  reading: SubscriptionUsage | null
  /** Set whenever the row carries the verdict of a stamp: a row replayed from one, or a cached row that dates the last check it still shows. The ISO 8601 instant of that check. */
  checkedAt?: string
  /** Set when a stamp or an archive record inside the TTL stands in for a probe: the ISO 8601 instant after which this key is
   *  probed again. A replayed row waits for its check plus the TTL; a cached row waits for its archive record's fetch plus the
   *  TTL. skippedRows does not set it. */
  nextCheckAt?: string
}
export interface ProbeResult {
  httpStatus: number | null
  /** Only the anthropic-ratelimit-unified-* headers and retry-after, every value already redacted. */
  headers: Partial<Record<string, string>>
  errorType: string | null; errorCode: string | null; message: string | null
}
export type FetchLike = typeof fetch

const UNMATCHED_IDENTITY: KeyIdentity = {
  accountUuid: null, accountLabel: null, accountTier: null, localClaimedLabel: null, accountLabelSuspect: false,
}

/** Read the ten slots from the environment. A value is <email>|<token>, split on the FIRST pipe. A reason names
 *  the rule that failed and never echoes any part of the value, so it is safe to print and to store. */
export function loadLongOAuthKeys(env: NodeJS.ProcessEnv): LoadedKeys {
  const invalid: InvalidKey[] = []
  const candidates: LongKey[] = []
  for (const slot of SLOT_IDS) {
    const raw = env[LONG_KEY_PREFIX + slot]
    if (raw === undefined || raw.trim() === '') continue
    const sep = raw.indexOf('|')
    if (sep < 0) { invalid.push({ slot, reason: 'no | between the email and the token' }); continue }
    const email = raw.slice(0, sep).trim()
    const token = raw.slice(sep + 1).trim()
    const parts = email.split('@')
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      invalid.push({ slot, reason: 'the part before | is not exactly one email address' }); continue
    }
    if (token === '') { invalid.push({ slot, reason: 'the token after | is empty' }); continue }
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      invalid.push({ slot, reason: 'the token has characters outside A-Z a-z 0-9 _ -' }); continue
    }
    candidates.push({ slot, email, token })
  }
  // Two slots for one email would probe one account twice and file two readings under it. Refuse both.
  const slotsByEmail = new Map<string, string[]>()
  for (const k of candidates) {
    const e = k.email.toLowerCase()
    slotsByEmail.set(e, [...(slotsByEmail.get(e) ?? []), k.slot])
  }
  const keys: LongKey[] = []
  for (const k of candidates) {
    const twins = slotsByEmail.get(k.email.toLowerCase()) ?? []
    if (twins.length > 1) invalid.push({ slot: k.slot, reason: 'duplicate email in slots ' + twins.join(' and ') })
    else keys.push(k)
  }
  invalid.sort((a, b) => a.slot.localeCompare(b.slot))
  return { keys, invalid }
}

/** Every string this module returns, stores or throws goes through here. WHY two passes: the token is removed by
 *  value first, because a platform or server error may quote the header it failed on; then any sk-ant- key shape,
 *  so a different credential of the same family is masked as well. */
export function redact(text: string, token: string): string {
  const byValue = token.length > 0 ? text.split(token).join('[redacted]') : text
  return byValue.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
}

/** The text of an error and everything nested under it: its cause chain and an AggregateError's members. The stack
 *  is left out, because it carries file paths and it is not what failed. */
function describeError(e: unknown, depth = 0): string {
  if (!(e instanceof Error)) return String(e)
  if (depth >= 5) return e.name + ': ' + e.message
  const parts = [e.name + ': ' + e.message]
  if (e.cause !== undefined) parts.push('caused by ' + describeError(e.cause, depth + 1))
  if (e instanceof AggregateError) parts.push('members: [' + e.errors.map(x => describeError(x, depth + 1)).join('; ') + ']')
  return parts.join(' — ')
}

interface ErrorEnvelope { errorType: string | null; errorCode: string | null; message: string | null }
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const asText = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null

/** The server's error envelope, read for its three named fields only. Nothing else in the body is copied, so a
 *  server that echoes the request cannot leak it through this path. A body that is not JSON, such as an HTML
 *  error page, simply has no envelope. */
function parseErrorEnvelope(text: string): ErrorEnvelope {
  const none: ErrorEnvelope = { errorType: null, errorCode: null, message: null }
  let body: unknown
  try { body = JSON.parse(text) } catch { return none }
  const err = isRecord(body) ? body.error : undefined
  if (!isRecord(err)) return none
  const details = isRecord(err.details) ? err.details : {}
  return { errorType: asText(err.type), errorCode: asText(details.error_code), message: asText(err.message) }
}

/** Send one zero-output-token message (about 33 input tokens) with the key and return what came back, scrubbed. It never throws: a failure is a
 *  result with its message in it, so one bad key cannot discard the other keys' readings in Promise.all. A corrupt local
 *  stamp is the one exception: readStamp throws on it, and that fails the whole run (see readStamp). WHY the
 *  Headers object is built inside the try: the platform throws on a control character in a header value, and that
 *  error must come back as a scrubbed failed result, not escape unformatted. */
export async function probeRateLimits(
  token: string, fetchImpl: FetchLike, userAgentValue: string, timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const scrub = (s: string): string => redact(s, token)
  const scrubOrNull = (s: string | null): string | null => s === null ? null : scrub(s)
  try {
    const headers = new Headers({
      Authorization: 'Bearer ' + token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': USAGE_BETA,
      'content-type': 'application/json',
      'User-Agent': userAgentValue,
    })
    // WHY max_tokens 0: measured 2026-10-29 (TRDD-HO94JMKD). max_tokens 0 is accepted (200, empty content,
    // stop_reason max_tokens), bills input_tokens 33 and output_tokens 0 with no cache write, and still returns all
    // anthropic-ratelimit-unified-* headers. A request rejected before inference (400/404) returns NO rate-limit
    // headers, and count_tokens returns none, so this is the cheapest probe that still reports the windows.
    const body = JSON.stringify({ model: PROBE_MODEL, max_tokens: 0, system: PROBE_SYSTEM, messages: [{ role: 'user', content: '.' }] })
    const res = await fetchImpl(PROBE_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
    const rate: Partial<Record<string, string>> = {}
    res.headers.forEach((value, name) => {
      if (name.startsWith(UNIFIED) || name === 'retry-after') rate[name] = scrub(value)
    })
    const env = parseErrorEnvelope(await res.text())
    return {
      httpStatus: res.status, headers: rate,
      errorType: scrubOrNull(env.errorType), errorCode: scrubOrNull(env.errorCode), message: scrubOrNull(env.message),
    }
  } catch (e) {
    return { httpStatus: null, headers: {}, errorType: null, errorCode: null, message: scrub(describeError(e)) }
  }
}

/** A utilization header as a percent. Missing, unparseable or negative is null, never 0, because 0 reads as an empty
 *  window. The header is a fraction (0.01 is 1%). A value just under 1 that rounds up to 100 is held at 99.9, so it
 *  cannot read as full. A value of 1 or more is reported as it is, because the server reports over-limit windows
 *  above 100. */
function percentOf(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const u = parseFloat(raw)
  if (!Number.isFinite(u) || u < 0) return null
  const p = Math.round(u * 1000) / 10
  return u < 1 && p >= 100 ? 99.9 : p
}

/** Build a SubscriptionUsage from one probe's rate-limit headers. The record is built here, not through normalize():
 *  normalize is a parity oracle with a different percent contract. Fields a header cannot carry (credits, spend,
 *  the account fingerprint) are null, and accountVerified is unknown, because the live credential did not read it. */
export function usageFromHeaders(
  headers: Partial<Record<string, string>>, opts: { fetchedAt: number; now: number; identity: KeyIdentity },
): SubscriptionUsage {
  const { fetchedAt, now, identity } = opts
  const windows = new Set<string>()
  for (const name of Object.keys(headers)) {
    const m = WINDOW_HEADER.exec(name)
    if (m) windows.add(m[1])
  }
  const order = (w: string): number => (w === '5h' ? 0 : w === '7d' ? 1 : 2)
  const claim = headers[UNIFIED + 'representative-claim']
  const limits: UsageLimit[] = [...windows].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map(w => {
    const base = UNIFIED + w + '-'
    const resetsAt = normalizeResetsAt(headers[base + 'reset'])
    const fiveHour = w === '5h'
    const scoped = w.startsWith('7d_')
    return {
      kind: fiveHour ? 'session' : scoped ? 'weekly_scoped' : 'weekly_all',
      group: fiveHour ? 'session' : 'weekly',
      percent: percentOf(headers[base + 'utilization']),
      severity: headers[base + 'status'] === 'rejected' ? 'critical' : 'normal',
      resetsAt,
      isActive: (fiveHour && claim === 'five_hour') || (w === '7d' && claim === 'seven_day'),
      scopeLabel: scoped ? (SCOPE_LABELS[w.slice(3)] ?? w) : null,
      resetsInSeconds: resetsAt === null ? null : Math.round((Date.parse(resetsAt) - now) / 1000),
    }
  })
  const find = (kind: string): UsageLimit | undefined => limits.find(l => l.kind === kind)
  const overageStatus = headers[UNIFIED + 'overage-status']
  const ageSeconds = Math.max(0, Math.round((now - fetchedAt) / 1000))
  return {
    fetchedAt, ageSeconds,
    stale: ageSeconds * 1000 > TTL_MS * 3,
    accountFp: null,
    accountUuid: identity.accountUuid,
    accountLabel: identity.accountLabel,
    accountTier: identity.accountTier,
    localClaimedLabel: identity.localClaimedLabel,
    accountLabelSuspect: identity.accountLabelSuspect,
    accountVerified: 'unknown',
    reason: 'ok',
    limits,
    fiveHourPercent: find('session')?.percent ?? null,
    sevenDayPercent: find('weekly_all')?.percent ?? null,
    usageCreditsEnabled: null,
    spendPercent: null,
    note: 'Read from the rate-limit headers of one zero-output-token message (about 33 input tokens) sent with an owner-supplied long-lived key. '
      + 'Only the 5-hour window, the 7-day window and the per-model 7-day windows in those headers are known here. '
      + 'Credits, spend and every other window stay unknown until the next usage-endpoint read.',
    source: 'ratelimit-headers',
    overage: overageStatus === undefined
      ? null
      : { status: overageStatus, disabledReason: headers[UNIFIED + 'overage-disabled-reason'] ?? null },
  }
}

export type Match =
  | { kind: 'matched'; accountId: string; identity: KeyIdentity; archived: SubscriptionUsage | null }
  | { kind: 'unmatched' }
  | { kind: 'refused'; reason: string }

/** Find the account a key belongs to, by email, in the archive AND the roster. WHY both: the archive holds the
 *  readings and the roster holds the accounts this machine has been on, and the two must name the same uuid. Any
 *  disagreement is refused rather than resolved, because a wrong guess files one account's numbers under another
 *  account's name. */
export function matchKey(email: string, archives: SubscriptionUsage[], roster: AccountRosterEntry[]): Match {
  const want = email.trim().toLowerCase()
  const archived = archives.filter(a => (a.accountLabel ?? '').trim().toLowerCase() === want)
  const rostered = roster.filter(r => (r.email ?? '').trim().toLowerCase() === want)
  if (archived.length > 1) return { kind: 'refused', reason: 'ambiguous: ' + archived.length + ' archived accounts carry this email' }
  const uuids = new Set<string>()
  for (const a of archived) if (a.accountUuid) uuids.add(a.accountUuid)
  for (const r of rostered) if (r.accountId) uuids.add(r.accountId)
  if (uuids.size > 1) return { kind: 'refused', reason: 'the archive and the roster name different accounts for this email' }
  const accountId = Array.from(uuids)[0] ?? null
  if (accountId === null) return { kind: 'unmatched' }
  const a = archived[0] ?? null
  const identity: KeyIdentity = a
    ? { accountUuid: accountId, accountLabel: a.accountLabel, accountTier: a.accountTier, localClaimedLabel: a.localClaimedLabel, accountLabelSuspect: a.accountLabelSuspect }
    : { accountUuid: accountId, accountLabel: email.trim(), accountTier: null, localClaimedLabel: null, accountLabelSuspect: false }
  return { kind: 'matched', accountId, identity, archived: a }
}

/** Confirm the key's account against the archive by the 7-day reset, when the archive holds a live one. WHY only a
 *  FUTURE archived reset counts: a window that has already reset describes nothing live, so there is nothing to
 *  compare. WHY a reply with no 7-day reset fails closed: a key whose account cannot be checked is not filed. */
function checkReset(
  reading: SubscriptionUsage, archived: SubscriptionUsage | null, now: number,
): { ok: true; identity: 'cross-checked' | 'claimed' } | { ok: false; reason: string } {
  const archivedMs = Date.parse(archived?.limits.find(l => l.kind === 'weekly_all')?.resetsAt ?? '')
  if (!(archivedMs > now)) return { ok: true, identity: 'claimed' }
  const headerMs = Date.parse(reading.limits.find(l => l.kind === 'weekly_all')?.resetsAt ?? '')
  if (Number.isNaN(headerMs)) {
    return { ok: false, reason: 'the reply carried no 7-day reset, so the key cannot be checked against the archived account' }
  }
  if (!(Math.abs(headerMs - archivedMs) <= RESET_MATCH_MS)) {
    return { ok: false, reason: '7-day reset differs from the archived account: the key may belong to another account' }
  }
  return { ok: true, identity: 'cross-checked' }
}

/** What is kept per key between runs. Never the token: the file is named by a hash of it, and every string is scrubbed. */
interface Stamp {
  at: number; slot: string; outcome: KeyOutcome; httpStatus: number | null
  errorType: string | null; errorCode: string | null; reason: string | null
  overage: Overage | null; identity: IdentityVerdict
  /** Only for an unmatched account: its reading has no archive record to live in, so the stamp is its only home. */
  reading?: SubscriptionUsage
}

function stampFile(dir: string, token: string): string {
  return path.join(dir, createHash('sha256').update(token).digest('hex').slice(0, 16) + '.json')
}

// WHY token: the thrown message quotes text read from the stamp file, so redact must scrub the token out of it.
function readStamp(file: string, token: string): Stamp | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Stamp
  } catch (e) {
    // No stamp yet is the normal first run. Any other failure is re-raised with the file named: a corrupt stamp fails the
    // whole --all run on purpose (fail fast), rather than probing the key again without saying so.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(redact('cannot read the long-lived key stamp ' + file + ': ' + (e as Error).message, token), { cause: e })
  }
}

function writeStamp(dir: string, token: string, stamp: Stamp): void {
  fs.mkdirSync(dir, { recursive: true })
  const dest = stampFile(dir, token)
  // Write-then-rename, as the archive does: a reader must never see half a stamp.
  const tmp = dest + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(stamp))
  fs.renameSync(tmp, dest)
}

function stampFrom(row: KeyRow, now: number, errorType: string | null, errorCode: string | null): Stamp {
  return {
    at: now, slot: row.slot, outcome: row.outcome, httpStatus: row.httpStatus, errorType, errorCode,
    reason: row.reason, overage: row.overage, identity: row.identity,
    ...(row.outcome === 'unmatched' && row.reading ? { reading: row.reading } : {}),
  }
}

/** A stamp is inside the TTL only when its instant is in the past and recent. An instant in the future (a clock that
 *  went backwards) is not fresh: the key is probed again, which costs one message, rather than being hidden for hours. */
function withinTtl(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at >= 0 && now - at < TTL_MS
}

function failureReason(p: ProbeResult): string {
  if (p.httpStatus === null) return 'no reply: ' + (p.message ?? 'unknown error')
  if (p.httpStatus === 200) return 'HTTP 200 without rate-limit headers'
  const code = p.errorCode ?? p.errorType
  return code === null ? 'HTTP ' + p.httpStatus : 'HTTP ' + p.httpStatus + ' ' + code
}

export interface RefreshOptions { fetchImpl: FetchLike; now: number; stampDir: string; userAgentValue: string }

async function settle(key: LongKey, match: Match, opts: RefreshOptions): Promise<KeyRow> {
  const file = stampFile(opts.stampDir, key.token)
  const stamp = readStamp(file, key.token)
  const archived = match.kind === 'matched' ? match.archived : null
  const base = { slot: key.slot, email: key.email, accountId: match.kind === 'matched' ? match.accountId : null }
  // Every probed or refused outcome is stamped, so its reason and its instant survive to the next run.
  const record = (row: KeyRow, errorType: string | null, errorCode: string | null): KeyRow => {
    writeStamp(opts.stampDir, key.token, stampFrom(row, opts.now, errorType, errorCode))
    return row
  }
  if (match.kind === 'refused') {
    // Decided before any probe: a key whose account cannot be named would spend a billed message on a reading that
    // nothing can file.
    return record({ ...base, accountId: null, outcome: 'refused', identity: 'refused', httpStatus: null, reason: match.reason, overage: null, reading: null }, null, null)
  }
  // Nothing is sent and nothing is rewritten inside the TTL. The stamp keeps its original instant, so the TTL really runs out.
  // WHY a stamp of a failed or refused check is read before the archive: a fresh archive from another source (model-headroom,
  // the live account) must not make a key whose own check failed read as cached. An outcome this code does not know fails
  // closed, as a failure, never as a cached reading.
  if (stamp && withinTtl(stamp.at, opts.now) && stamp.outcome !== 'refreshed' && stamp.outcome !== 'unmatched') {
    return {
      ...base, outcome: stamp.outcome === 'refused' ? 'refused' : 'failed', identity: stamp.identity,
      httpStatus: stamp.httpStatus, reason: stamp.reason, overage: null, reading: null,
      checkedAt: new Date(stamp.at).toISOString(),
      nextCheckAt: new Date(stamp.at + TTL_MS).toISOString(),
    }
  }
  // WHY the archive and the stamp are read separately: a failed check must never borrow an old archived record as its
  // reading, or a key that cannot be read shows weeks-old numbers as if they were its current reading. The archive is the
  // reading only while it is itself inside the TTL.
  if (archived && withinTtl(archived.fetchedAt, opts.now)) {
    // WHY the last verdict of this key is carried, dated: the fresh archive must not erase the last check, but that check
    // is shown with its own instant, never as the current one. An 'unmatched' stamp names no account this key matched, so
    // it lends nothing here: the account that matches now must not inherit its identity.
    const lastCheck = stamp && stamp.outcome !== 'unmatched' ? stamp : null
    return {
      ...base, outcome: 'cached', identity: lastCheck?.identity ?? 'not-checked', httpStatus: lastCheck?.httpStatus ?? null,
      reason: lastCheck?.reason ?? null, overage: archived.overage ?? null, reading: archived,
      ...(lastCheck ? { checkedAt: new Date(lastCheck.at).toISOString() } : {}),
      nextCheckAt: new Date(archived.fetchedAt + TTL_MS).toISOString(),
    }
  }
  // An unmatched account has no archive record, so its stamp is the only home of its reading.
  if (stamp && withinTtl(stamp.at, opts.now) && stamp.outcome === 'unmatched') {
    return {
      ...base, outcome: 'cached', identity: stamp.identity, httpStatus: stamp.httpStatus, reason: stamp.reason,
      overage: stamp.overage, reading: stamp.reading ?? null, checkedAt: new Date(stamp.at).toISOString(),
      nextCheckAt: new Date(stamp.at + TTL_MS).toISOString(),
    }
  }
  // A 'refreshed' stamp whose archive record is outside the TTL falls through to a new probe: a 'refreshed' stamp stores no
  // reading (the reading went to the archive), so there is nothing to replay.
  const probe = await probeRateLimits(key.token, opts.fetchImpl, opts.userAgentValue)
  // WHY the gate is the presence of the headers and not the status: a 200 and a 429 both carry them, and a 429 is the
  // server saying the window is full, which is the reading itself. A 401, a 403, a timeout or a 200 without headers
  // has no reading.
  if (!Object.keys(probe.headers).some(h => h.startsWith(UNIFIED))) {
    return record({ ...base, outcome: 'failed', identity: 'not-checked', httpStatus: probe.httpStatus, reason: failureReason(probe), overage: null, reading: null }, probe.errorType, probe.errorCode)
  }
  const identity = match.kind === 'matched' ? match.identity : UNMATCHED_IDENTITY
  const reading = usageFromHeaders(probe.headers, { fetchedAt: opts.now, now: opts.now, identity })
  if (match.kind === 'unmatched') {
    return record({ ...base, outcome: 'unmatched', identity: 'unmatched', httpStatus: probe.httpStatus, reason: null, overage: reading.overage ?? null, reading }, probe.errorType, probe.errorCode)
  }
  const check = checkReset(reading, archived, opts.now)
  if (!check.ok) {
    return record({ ...base, outcome: 'refused', identity: 'refused', httpStatus: probe.httpStatus, reason: check.reason, overage: null, reading: null }, probe.errorType, probe.errorCode)
  }
  archiveAccountUsage(reading)
  return record({ ...base, outcome: 'refreshed', identity: check.identity, httpStatus: probe.httpStatus, reason: null, overage: reading.overage ?? null, reading }, probe.errorType, probe.errorCode)
}

/** Refresh every key in parallel. The archive and the roster are read once, first; each key then settles on its own.
 *  No lock: two runs that start together can each probe a key once. The TTL bounds that to one message per key. */
export async function refreshLongKeys(keys: LongKey[], opts: RefreshOptions): Promise<KeyRow[]> {
  const archives = listObservedAccountUsage()
  const roster = listAccountRoster()
  return Promise.all(keys.map(key => settle(key, matchKey(key.email, archives, roster), opts)))
}

/** The rows for --no-refresh: every valid key is listed, and none is probed or matched. */
export function skippedRows(keys: LongKey[]): KeyRow[] {
  return keys.map(k => ({
    slot: k.slot, email: k.email, accountId: null, outcome: 'skipped', identity: 'not-checked',
    httpStatus: null, reason: '--no-refresh: no message was sent', overage: null, reading: null,
  }))
}
