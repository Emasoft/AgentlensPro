// Regenerates subusage-expected.json from the COMPILED src/subscriptionUsage.ts — the parity oracle
// for SLICE A of the subscriptionUsage port (TRDD-DMWOBWFH P4x.2m): the response normalizer, the
// cache-record boundary, the staleness predicates, the cooldown arithmetic and the renderer.
// SLICE B is getSubscriptionUsage itself (network + keychain), which needs an injected fetch seam.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-subusage-expected.mjs
//
// AGENTLENS_DATA_DIR is set to a fixture dir BEFORE the module is imported, so `armCooldown` writes
// its cooldown file there and never touches the real store. Setting it after the import would be
// too late for a module that resolves paths lazily but caches nothing — and "too late" here means
// writing into the developer's live ~/.agentlens.
//
// NO WALL CLOCK anywhere the result depends on it, with ONE unavoidable exception: `rolledNote` (a
// renderer helper) reads `Date.now()` INLINE rather than the `now` its caller was given. Every
// fixture resetsAt is therefore either year 2000 (rolled, forever) or year 2099 (not rolled, for
// the lifetime of this code), so the answer cannot flip between the day the oracle is generated and
// the day the test runs.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// A TEMP dir, not one under fixtures/: the cooldown file is scratch the oracle already records the
// contents of, so committing it would add a tracked artifact nothing reads.
const DATA = path.join(os.tmpdir(), 'agentlens-subusage-oracle')
fs.rmSync(DATA, { recursive: true, force: true })
fs.mkdirSync(DATA, { recursive: true })
process.env.AGENTLENS_DATA_DIR = DATA

const {
  windowPct, normalizeResetsAt, normalize, deriveStale, staleReason, armCooldown, retryAfterSeconds,
  usageBar, formatSubscriptionUsage,
} = await import(path.join(HERE, '../../../../../out/test/subscriptionUsage.js'))

const NOW = Date.parse('2026-08-21T06:00:00.000Z')
const ROLLED = '2000-01-01T00:00:00.000Z'   // always in the past
const FUTURE = '2099-01-01T00:00:00.000Z'   // always in the future

// ── windowPct ───────────────────────────────────────────────────────────────────
const WINDOWS = {
  utilization: { utilization: 42.5 },
  used_percentage_fallback: { used_percentage: 17 },
  // `utilization` wins when BOTH are present — the loop order is the contract.
  both_present: { utilization: 1, used_percentage: 99 },
  zero_is_a_real_number: { utilization: 0 },
  string_number_is_not_a_number: { utilization: '42' },
  empty: {},
  null_window: null,
}
const windowPctCases = {}
for (const [k, v] of Object.entries(WINDOWS)) windowPctCases[k] = windowPct(v) ?? null

// ── normalizeResetsAt ───────────────────────────────────────────────────────────
const RESETS = {
  epoch_seconds: 1787270400,
  epoch_millis: 1787270400000,
  numeric_string_seconds: '1787270400',
  decimal_string: '1787270400.5',
  iso_string_kept_verbatim: '2026-08-19T04:00:00Z',
  iso_with_offset: '2026-08-19T06:00:00+0200',
  garbage_string: 'not a date',
  empty_string: '',
  whitespace_string: '   ',
  null_value: null,
  boolean_value: true,
  // Below 1e12 is SECONDS by ccbroker's threshold — 1e12 ms is 2001, so a plausible ms value can
  // never be mistaken for seconds.
  boundary_just_below_1e12: 999999999999,
  boundary_at_1e12: 1000000000000,
}
const resetsCases = {}
for (const [k, v] of Object.entries(RESETS)) resetsCases[k] = normalizeResetsAt(v) ?? null

// ── normalize ───────────────────────────────────────────────────────────────────
const BODY = {
  five_hour: { utilization: 61 },
  seven_day: { used_percentage: 12.5 },
  limits: [
    { kind: 'session', group: 'session', percent: 61, severity: 'normal', resets_at: FUTURE, is_active: true },
    // percent absent -> null, NEVER 0; severity/kind/group absent -> their defaults.
    { resets_at: 1787270400, is_active: false },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 3, severity: 'critical', resets_at: ROLLED,
      is_active: true, scope: { model: { display_name: 'claude-opus-5' }, surface: 'api' },
    },
    // A scope with no model, and an is_active that is truthy but not `true`.
    { kind: 'weekly_all', group: 'weekly', percent: 0, resets_at: 'garbage', is_active: 1, scope: { model: null } },
  ],
  extra_usage: { is_enabled: true },
  spend: { percent: 4.25 },
}
const IDENT = { email: 'owner@example.com', accountUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tier: 'max_20x' }
const normalizeCases = {
  full: normalize(BODY, NOW - 30_000, 'ok', NOW, 'fp-1234', IDENT, 'owner@example.com'),
  // The label disagreement this module exists to expose.
  suspect_label: normalize(BODY, NOW - 30_000, 'ok', NOW, 'fp-1234', IDENT, 'second@example.com'),
  // No fingerprint -> accountVerified 'unknown', never 'yes'.
  no_fingerprint: normalize(BODY, NOW - 30_000, 'ok', NOW, null, IDENT, null),
  // No identity at all: the three identity fields are null and suspect stays FALSE — "we could not
  // check" is not a mismatch.
  no_identity: normalize(BODY, NOW - 30_000, 'ok', NOW, 'fp-1234', null, 'owner@example.com'),
  // Old enough that `stale` is computed TRUE at write time.
  stale_at_write: normalize(BODY, NOW - 40 * 60_000, 'ok', NOW, 'fp-1234', IDENT, null),
  empty_body: normalize({}, NOW, 'fresh', NOW, null, null, null),
  // extra_usage present but not a boolean -> null, not false.
  credits_non_boolean: normalize({ ...BODY, extra_usage: { is_enabled: 'yes' } }, NOW, 'ok', NOW, null, null, null),
}

// ── deriveStale / staleReason ───────────────────────────────────────────────────
const rec = (over) => ({ ...normalizeCases.full, ...over })
const STALE = {
  fresh: rec({ fetchedAt: NOW - 1000, limits: [{ resetsAt: FUTURE }] }),
  too_old: rec({ fetchedAt: NOW - 31 * 60_000, limits: [{ resetsAt: FUTURE }] }),
  // Age is fine but a window has already rolled — the SECOND reason, which reporting as "too old"
  // produced the self-refuting "0h old (fresh)" line.
  window_reset: rec({ fetchedAt: NOW - 1000, limits: [{ resetsAt: ROLLED }] }),
  // A null resetsAt disables the rolled check for that bucket rather than counting as rolled.
  null_resets_at: rec({ fetchedAt: NOW - 1000, limits: [{ resetsAt: null }] }),
  unparseable_resets_at: rec({ fetchedAt: NOW - 1000, limits: [{ resetsAt: 'nonsense' }] }),
  no_limits: rec({ fetchedAt: NOW - 1000, limits: [] }),
  // EXACTLY at the boundary: `now - fetchedAt > TTL_MS*3` is strict, so 30m sharp is NOT too old.
  exactly_at_ttl_x3: rec({ fetchedAt: NOW - 30 * 60_000, limits: [{ resetsAt: FUTURE }] }),
}
const staleCases = {}
for (const [k, v] of Object.entries(STALE)) staleCases[k] = { stale: deriveStale(v, NOW), reason: staleReason(v, NOW) ?? null }

// ── armCooldown (writes into the fixture data dir) ──────────────────────────────
const cooldownFile = path.join(DATA, 'subscription-usage-cooldown.json')
const armCases = {}
const arm = (name, retryAfter, seed) => {
  if (seed === null) fs.rmSync(cooldownFile, { force: true })
  else fs.writeFileSync(cooldownFile, JSON.stringify(seed))
  const delay = armCooldown(retryAfter, NOW)
  armCases[name] = { delay, file: JSON.parse(fs.readFileSync(cooldownFile, 'utf8')), seed }
}
arm('first_429_no_header', null, null)
arm('third_429_doubles', null, { until: 0, consecutive: 2 })
// 600000 * 2^5 = 19.2M, over the 2h cap.
arm('capped_at_2h', null, { until: 0, consecutive: 5 })
// A Retry-After under a minute is floored to 60s — the server may say 1s, we do not hammer it.
arm('retry_after_floored', 30, { until: 0, consecutive: 0 })
arm('retry_after_honored', 200, { until: 0, consecutive: 0 })
// Zero/negative Retry-After falls through to the doubling path, not to a zero wait.
arm('retry_after_zero', 0, { until: 0, consecutive: 1 })
// A corrupt cooldown file reads as consecutive 0 rather than throwing.
arm('corrupt_file', null, { until: 'nope', consecutive: 'nope' })

// ── retryAfterSeconds ───────────────────────────────────────────────────────────
const H = (o) => new Headers(o)
const retryCases = {
  numeric: retryAfterSeconds(H({ 'retry-after': '120' }), NOW),
  http_date: retryAfterSeconds(H({ 'retry-after': new Date(NOW + 90_000).toUTCString() }), NOW),
  // An HTTP-date in the PAST clamps to 0, it does not go negative.
  http_date_past: retryAfterSeconds(H({ 'retry-after': new Date(NOW - 90_000).toUTCString() }), NOW),
  unified_epoch: retryAfterSeconds(H({ 'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1000) + 300) }), NOW),
  // A reset header already in the past is SKIPPED, not returned as a negative wait.
  unified_epoch_past: retryAfterSeconds(H({ 'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1000) - 300) }), NOW),
  iso_reset: retryAfterSeconds(H({ 'anthropic-ratelimit-requests-reset': new Date(NOW + 45_000).toISOString() }), NOW),
  // Retry-After wins over the reset headers when both are present.
  precedence: retryAfterSeconds(H({ 'retry-after': '7', 'anthropic-ratelimit-unified-reset': String(Math.floor(NOW / 1000) + 900) }), NOW),
  // Header names are case-insensitive per the Headers contract.
  case_insensitive: retryAfterSeconds(H({ 'Retry-After': '11' }), NOW),
  garbage: retryAfterSeconds(H({ 'retry-after': 'soon' }), NOW),
  none: retryAfterSeconds(H({}), NOW),
  null_headers: retryAfterSeconds(null, NOW),
}
for (const k of Object.keys(retryCases)) retryCases[k] = retryCases[k] ?? null

// ── usageBar ────────────────────────────────────────────────────────────────────
const barCases = {}
for (const p of [0, 4, 5, 50, 94.9, 95, 99.9, 100, 150, -5]) barCases[String(p)] = usageBar(p)
barCases['20_cells'] = usageBar(37, 20)

// ── formatSubscriptionUsage ─────────────────────────────────────────────────────
const lim = (over) => ({ kind: 'session', group: 'session', percent: 61, severity: 'normal', resetsAt: FUTURE, isActive: true, scopeLabel: null, resetsInSeconds: 3600, ...over })
const fmtBase = { ...normalizeCases.full, limits: [lim({}), lim({ kind: 'weekly_scoped', percent: null, scopeLabel: 'claude-opus-5', severity: 'critical', resetsInSeconds: null })] }
const formatCases = {
  null_usage: formatSubscriptionUsage(null),
  live_verified: formatSubscriptionUsage(fmtBase),
  live_unverified: formatSubscriptionUsage({ ...fmtBase, accountVerified: 'unknown' }),
  another_account: formatSubscriptionUsage({ ...fmtBase, accountVerified: 'no' }),
  suspect_label: formatSubscriptionUsage({ ...fmtBase, accountLabelSuspect: true, localClaimedLabel: 'second@example.com' }),
  // Stale suppresses every countdown and names the rolled windows.
  stale_all_rolled: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 8525 * 60, reason: 'cooldown', limits: [lim({ resetsAt: ROLLED }), lim({ kind: 'weekly_all', resetsAt: ROLLED })] }),
  stale_some_rolled: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 300, reason: '429', limits: [lim({ resetsAt: ROLLED }), lim({ kind: 'weekly_all', resetsAt: FUTURE })] }),
  credits_disabled: formatSubscriptionUsage({ ...fmtBase, usageCreditsEnabled: false }),
  credits_unknown: formatSubscriptionUsage({ ...fmtBase, usageCreditsEnabled: null }),
  // No label and no uuid: the header says so rather than printing an empty name.
  unresolved_account: formatSubscriptionUsage({ ...fmtBase, accountLabel: null, accountUuid: null }),
  uuid_only: formatSubscriptionUsage({ ...fmtBase, accountLabel: null }),
  // humanAge's four branches, via the stale line.
  age_seconds: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 45, limits: [] }),
  age_minutes: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 600, limits: [] }),
  age_hours: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 3 * 3600 + 120, limits: [] }),
  age_days: formatSubscriptionUsage({ ...fmtBase, stale: true, ageSeconds: 6 * 86400, limits: [] }),
}

const out = { now: NOW, windowPct: windowPctCases, resetsAt: resetsCases, normalize: normalizeCases, stale: staleCases, arm: armCases, retryAfter: retryCases, bar: barCases, format: formatCases, fmtInputs: { base: fmtBase, lim: lim({}) } }
fs.writeFileSync(path.join(HERE, 'subusage-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote subusage-expected.json')
console.log(' windowPct:', JSON.stringify(windowPctCases))
console.log(' resetsAt:', JSON.stringify(resetsCases))
console.log(' stale:', Object.entries(staleCases).map(([k, v]) => `${k}=${v.reason ?? 'fresh'}`).join(' '))
console.log(' arm:', Object.entries(armCases).map(([k, v]) => `${k}=${v.delay}`).join(' '))
console.log(' retryAfter:', JSON.stringify(retryCases))
console.log(' bar:', JSON.stringify(barCases))
