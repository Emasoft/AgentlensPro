// Regenerates subusageb-expected.json from the COMPILED src/subscriptionUsage.ts — the parity
// oracle for SLICE B (TRDD-DMWOBWFH P4x.2n): loadToken + getSubscriptionUsage's decision ladder.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-subusageb-expected.mjs
//
// THREE seams, all set BEFORE the import (a module that resolves paths lazily still reads env at
// call time, but `globalThis.fetch` must be replaced before anything captures it):
//   - globalThis.fetch → a stub, so no request ever leaves the machine;
//   - CLAUDE_CONFIG_DIR → a fixture dir holding .credentials.json, so loadToken takes the FILE path
//     and never the keychain (a real keychain read pops a macOS password prompt);
//   - AGENTLENS_DATA_DIR → a temp dir, so the cache/cooldown/lock/archive files are never the
//     developer's live ~/.agentlens.
//
// PLATFORM is recorded in the oracle: on darwin a missing credentials file falls through to the
// keychain branch and returns `opt_in_required`; anywhere else it is `no_token`. The Rust side is
// handed that same flag rather than reading its own `cfg!(target_os)`, so the two cannot disagree
// about which branch the fixture is pinning.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(os.tmpdir(), 'agentlens-subusageb-oracle')
fs.rmSync(ROOT, { recursive: true, force: true })
const DATA = path.join(ROOT, 'data')
const CFG = path.join(ROOT, 'claude')
fs.mkdirSync(DATA, { recursive: true })
fs.mkdirSync(CFG, { recursive: true })
process.env.AGENTLENS_DATA_DIR = DATA
process.env.CLAUDE_CONFIG_DIR = CFG
// HOME too, and not for tidiness: `getCurrentAccount()` reads `~/.claude.json` for the label the
// reading is cross-checked against, so without this the oracle bakes in whichever account the
// generating machine happens to be logged into — a personal address committed to a fixture, and a
// file that regenerates differently on every machine. Pointing HOME at the empty fixture root
// makes the claimed label null, which is what the Rust caller passes.
process.env.HOME = ROOT

const NOW = Date.parse('2026-08-21T06:00:00.000Z')
const ACCESS = 'sk-access-token-fixture'
const REFRESH = 'sk-refresh-token-fixture'
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// The stub. `calls` records what the ladder actually attempted — a case that must NOT hit the
// network is proved by an EMPTY list, not by the result looking plausible.
let calls = []
let plan = {}
globalThis.fetch = async (url) => {
  calls.push(String(url))
  const r = String(url).includes('/profile') ? plan.profile : plan.usage
  if (!r) throw new Error('network down')
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: new Headers(r.headers ?? {}),
    json: async () => r.body,
  }
}

const { getSubscriptionUsage, loadToken } = await import(path.join(HERE, '../../../../../out/test/subscriptionUsage.js'))

const USAGE_BODY = {
  five_hour: { utilization: 61 },
  seven_day: { used_percentage: 12.5 },
  limits: [{ kind: 'session', group: 'session', percent: 61, severity: 'normal', resets_at: '2099-01-01T00:00:00.000Z', is_active: true }],
  extra_usage: { is_enabled: false },
  spend: { percent: 4.25 },
}
const PROFILE_BODY = { account: { email: 'owner@example.com', uuid: UUID, full_name: 'Owner' }, organization: { rate_limit_tier: 'max_20x' } }
const OK_PLAN = { usage: { status: 200, body: USAGE_BODY }, profile: { status: 200, body: PROFILE_BODY } }

const creds = (over = {}) => JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, ...over } })
const P = {
  cache: path.join(DATA, 'subscription-usage.json'),
  cooldown: path.join(DATA, 'subscription-usage-cooldown.json'),
  lock: path.join(DATA, 'subscription-usage.lock'),
  accounts: path.join(DATA, 'subscription-usage'),
  credentials: path.join(CFG, '.credentials.json'),
}
const rm = (p) => fs.rmSync(p, { recursive: true, force: true })
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// loadToken's own fingerprint is the cache-validity key, so it is pinned directly: a port that
// hashed the ACCESS token instead would still "work" until the hourly rotation, then miss forever.
fs.writeFileSync(P.credentials, creds())
const fp = loadToken(process.env).fp

const cases = {}
const run = (name, { plan: pl = OK_PLAN, force = false, seedCache = null, seedCooldown = null, seedLock = null, credentials = creds(), lockAgeMs = 0 } = {}) => {
  rm(P.cache); rm(P.cooldown); rm(P.lock); rm(P.accounts)
  if (credentials === null) rm(P.credentials); else fs.writeFileSync(P.credentials, credentials)
  if (seedCache) fs.writeFileSync(P.cache, JSON.stringify(seedCache))
  if (seedCooldown) fs.writeFileSync(P.cooldown, JSON.stringify(seedCooldown))
  if (seedLock !== null) {
    fs.writeFileSync(P.lock, String(seedLock))
    const t = (NOW - lockAgeMs) / 1000
    fs.utimesSync(P.lock, t, t)
  }
  plan = pl
  calls = []
  return getSubscriptionUsage({ now: NOW, force }).then((usage) => {
    cases[name] = {
      usage: usage ?? null,
      calls,
      cache: readJson(P.cache),
      cooldown: readJson(P.cooldown),
      archived: readJson(path.join(P.accounts, `${UUID}.json`)),
      lockRemains: fs.existsSync(P.lock),
      seed: { cache: seedCache, cooldown: seedCooldown, lock: seedLock, lockAgeMs, credentials: credentials === null ? null : JSON.parse(credentials), force, plan: pl === OK_PLAN ? 'ok' : pl },
    }
  })
}

// A cache record shaped exactly as `normalize` writes one, so the fresh-hit test exercises the real
// comparison (`cached.accountFp === currentFp && currentFp !== null`), not a stand-in.
const cachedRec = (over = {}) => ({
  fetchedAt: NOW - 60_000, ageSeconds: 0, stale: false, accountFp: fp, accountUuid: UUID,
  accountLabel: 'owner@example.com', accountTier: 'max_20x', localClaimedLabel: null,
  accountLabelSuspect: false, accountVerified: 'yes', reason: 'ok',
  limits: [{ kind: 'session', group: 'session', percent: 44, severity: 'normal', resetsAt: '2099-01-01T00:00:00.000Z', isActive: true, scopeLabel: null, resetsInSeconds: 0 }],
  fiveHourPercent: 44, sevenDayPercent: 9, usageCreditsEnabled: null, spendPercent: null, note: 'cached',
  ...over,
})

await run('ok_fetch')
// Within TTL and the SAME fingerprint: served from cache, and `calls` must be EMPTY.
await run('fresh_hit', { seedCache: cachedRec() })
// force skips the TTL gate even on a valid fresh cache.
await run('force_refetch', { seedCache: cachedRec(), force: true })
// A cache from ANOTHER account is not fresh no matter how recent — this is the account-switch guard.
await run('fp_mismatch', { seedCache: cachedRec({ accountFp: 'someone-elses-fp' }) })
// Too old for the TTL, same account -> refetch.
await run('expired_ttl', { seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// ORDER, pinned: the cache check runs BEFORE the cooldown check, so a fresh reading is served even
// while backing off. Swap the two and this is the only case that changes answer.
await run('fresh_beats_cooldown', { seedCache: cachedRec(), seedCooldown: { until: NOW + 60_000, consecutive: 2 } })
// `currentFp !== null` is a SEPARATE clause from the equality, and this is what it buys: with no
// token loaded, a cache whose accountFp is also null must NOT count as a match. Drop the clause and
// null === null makes an unattributable reading look fresh.
await run('null_fp_fresh_cache', { credentials: null, seedCache: cachedRec({ accountFp: null }) })
await run('cooldown_active', { seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }), seedCooldown: { until: NOW + 60_000, consecutive: 2 } })
// An EXPIRED cooldown does not block.
await run('cooldown_expired', { seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }), seedCooldown: { until: NOW - 1, consecutive: 2 } })
await run('http_429', { plan: { usage: { status: 429, headers: { 'retry-after': '300' } } }, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
await run('http_429_no_header', { plan: { usage: { status: 429 } }, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
await run('http_error', { plan: { usage: { status: 500 } }, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// The transport itself throws -> http_error, and the lock must still be released.
await run('network_throws', { plan: {}, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// A profile lookup that fails is reported as an unresolved identity, never papered over with the
// config file's guess — the substitution that printed one account's numbers under another's name.
await run('profile_fails', { plan: { usage: { status: 200, body: USAGE_BODY }, profile: { status: 403 } } })
await run('no_credentials', { credentials: null, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
await run('expiring_token', { credentials: creds({ expiresAt: NOW + 10_000 }), seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// A token expiring comfortably later is fine.
await run('token_valid_window', { credentials: creds({ expiresAt: NOW + 600_000 }), seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// A FRESH lock held by another process: serve the cache, do not fetch, and do NOT delete the lock.
await run('lock_contended', { seedLock: 424242, lockAgeMs: 1_000, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// A STALE lock (older than 2x the 8s HTTP timeout) is reclaimed.
await run('stale_lock_reclaimed', { seedLock: 424242, lockAgeMs: 60_000, seedCache: cachedRec({ fetchedAt: NOW - 20 * 60_000 }) })
// No cache at all AND no token: there is nothing to serve, so the answer is null, not an empty
// reading — a fabricated 0% is the one answer this module must never give.
await run('no_cache_no_token', { credentials: null })

const out = { now: NOW, platform: process.platform, fp, uuid: UUID, access: ACCESS, refresh: REFRESH, usageBody: USAGE_BODY, profileBody: PROFILE_BODY, cases }
fs.writeFileSync(path.join(HERE, 'subusageb-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote subusageb-expected.json — platform', process.platform, 'fp', fp)
for (const [k, v] of Object.entries(cases)) {
  console.log(` ${k}: reason=${v.usage?.reason ?? 'null'} calls=${v.calls.length} cooldown=${v.cooldown ? v.cooldown.until - NOW : '-'} archived=${v.archived ? 'yes' : 'no'} lock=${v.lockRemains}`)
}
