// Regenerates acctburners-expected.json from the COMPILED src/accountBurners.ts — the parity oracle
// for get_account_burners (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-acctburners-expected.mjs
//
// HOME is pinned to a fake root so the rendered `text` table is reproducible on any machine — the
// report abbreviates a workspace under HOME to `~/…`, and a real home path would both vary per
// machine AND trip `pnpm run check-identities`.
//
// What this pins:
//  - A NULL accountId CLOSES the open segment. Consumption during an unresolved stretch must not be
//    attributed to the last known account — without this the gap silently inflates that account.
//  - The same account re-recorded (a plan/mode change) does NOT open a second segment.
//  - `readAccountSegments` DROPS a record whose ts is missing or non-numeric rather than defaulting
//    it to 0, which would open a segment at the epoch and swallow every event before the timeline.
//  - `resolveTargetAccount`'s email/plan pick is `.filter(Boolean).pop()` — the last TRUTHY value,
//    so a later blank email does not erase the known one.
//  - `previous` skips EVERY segment of the current account, so a timeline that re-records the
//    current account still resolves to the one the user actually rotated away from.
//  - `resolveWindowUntil` parses the RAW interval (not the trimmed/lowercased copy) and NAMES an
//    unparseable one instead of silently falling back to `now`.
//  - `weighted` charges the UNKNOWN remainder (`tokens` beyond the four typed buckets) at 1×, and
//    clamps it at 0 so a bucket sum exceeding `tokens` cannot subtract.
//  - `fmtTok` divides by 1e3 unconditionally below a million, so 500 renders "1k" — the tables are
//    aligned to that, so "fixing" it would misalign every column.
//  - `resolveWindowCapacity` prefers the account's OWN calibration, else a SAME-PLAN proxy chosen
//    DETERMINISTICALLY (newest observedAt, then larger cap) so the answer never depends on key
//    insertion order; else null — fill undetermined, never invented.
//  - fill% is COST-based FIRST (Anthropic meters the windows by cost; raw-token fill is inflated by
//    the ~96% cache-read volume) with token fill only as the fallback.
//  - The `text` block's exact column widths — a padStart drift is invisible to a value comparison.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
process.env.HOME = '/h/user'

const {
  segmentsFromRecords, readAccountSegments, resolveWindowUntil, resolveTargetAccount,
  eventsForAccountInWindow, weighted, fmtTok, resolveWindowCapacity, buildAccountBurnersReport,
} = require('../../../../../out/test/accountBurners.js')

const NOW = 1754056800000 // 2026-08-01T12:40:00Z
const T = (h, m = 0) => 1754035200000 + h * 3600_000 + m * 60_000

// ── segmentsFromRecords ───────────────────────────────────────────────────────
const RECORD_CASES = {
  // A null accountId CLOSES the open segment and opens nothing.
  nullClosesTheOpenSegment: [
    { ts: T(0), accountId: 'a', email: 'a@example.test', plan: 'P' },
    { ts: T(1), accountId: null },
    { ts: T(2), accountId: 'b', email: 'b@example.test', plan: 'P' },
  ],
  // The same account re-recorded does not open a second segment.
  sameAccountReRecorded: [
    { ts: T(0), accountId: 'a', plan: 'P' },
    { ts: T(1), accountId: 'a', plan: 'Q' },
    { ts: T(2), accountId: 'b' },
  ],
  // Input order is not time order; the sort is what makes the segments contiguous.
  outOfOrder: [{ ts: T(2), accountId: 'b' }, { ts: T(0), accountId: 'a' }, { ts: T(1), accountId: null }],
  empty: [],
  // A single record leaves ONE open segment (endMs null = still active).
  onlyOne: [{ ts: T(0), accountId: 'a', email: 'a@example.test', plan: 'P' }],
}

// ── the file reader, incl. the torn / non-numeric-ts lines ────────────────────
const TIMELINE = dir + 'acct-burners-timeline.ndjson'
const SEGMENTS = readAccountSegments(TIMELINE)

// ── resolveTargetAccount / resolveWindowUntil ────────────────────────────────
const TARGET_SPECS = ['current', 'previous', 'aaaaaaaa', 'two@example.test', 'TWO@EXAMPLE.TEST', 'nope', '  CURRENT  ']
const targets = Object.fromEntries(TARGET_SPECS.map(s => [s, resolveTargetAccount(SEGMENTS, s, NOW)]))
const current = resolveTargetAccount(SEGMENTS, 'current', NOW)
const INTERVALS = ['last', 'current', 'now', '  LAST  ', '2026-08-01T11:00:00.000Z', 'not-a-date', '']

// ── the event pool ────────────────────────────────────────────────────────────
const ev = (ts, sessionId, o = {}) => ({
  ts, sessionId, tokens: o.tokens ?? 0, costUsd: o.costUsd ?? 0,
  inputTokens: o.input ?? 0, outputTokens: o.output ?? 0,
  cacheReadTokens: o.cacheRead ?? 0, cacheCreateTokens: o.cacheCreate ?? 0,
  ...(o.workspace !== undefined ? { workspace: o.workspace } : {}),
  ...(o.attribution !== undefined ? { attribution: o.attribution } : {}),
})
const EVENTS = [
  // Account aaaa's FIRST stint (T0..T2).
  ev(T(0, 10), 's1', { tokens: 120_000, costUsd: 3.5, input: 1000, output: 500, cacheRead: 100_000, cacheCreate: 18_500, workspace: '/h/user/Code/alpha', attribution: 'main' }),
  ev(T(1, 30), 's1', { tokens: 60_000, costUsd: 1.25, input: 500, output: 200, cacheRead: 50_000, cacheCreate: 9_300, workspace: '/h/user/Code/alpha', attribution: 'agent:worker' }),
  ev(T(1, 45), 's2', { tokens: 40_000, costUsd: 0.9, input: 200, output: 100, cacheRead: 35_000, cacheCreate: 4_700, workspace: '/w/beta' }),
  // Account bbbb's stint (T2..T3) — must NOT attribute to aaaa.
  ev(T(2, 15), 's3', { tokens: 90_000, costUsd: 2.1, input: 400, cacheRead: 80_000, cacheCreate: 9_600, workspace: '/h/user/Code/alpha' }),
  // The UNRESOLVED stretch (T3..T4) — attributable to NOBODY.
  ev(T(3, 20), 's4', { tokens: 55_000, costUsd: 1.1, cacheRead: 50_000, cacheCreate: 5_000, workspace: '/w/gamma' }),
  // Account aaaa's SECOND stint (T4..now) — the same session s1 spans the rotation, which is the
  // whole reason attribution is TIME-based rather than card-based.
  ev(T(4, 30), 's1', { tokens: 30_000, costUsd: 0.75, input: 300, output: 150, cacheRead: 25_000, cacheCreate: 4_550, workspace: '/h/user/Code/alpha', attribution: 'skill:ponytail' }),
  // An event with NO workspace on the event: it falls back to the card's, and s5 has no card at all
  // so it stays null and lands in the "(unattributed)" project row.
  ev(T(5, 0), 's5', { tokens: 12_000, costUsd: 0.3, cacheRead: 10_000, cacheCreate: 2_000 }),
  // `tokens` exceeding the four typed buckets: the remainder is charged at the UNKNOWN weight.
  ev(T(5, 30), 's6', { tokens: 100_000, costUsd: 0.4, input: 1000, workspace: '/w/beta' }),
]
const CARDS = [
  { sessionId: 's1', workspace: '/h/user/Code/alpha', source: 'claude_code', model: 'claude-opus-5' },
  { sessionId: 's2', workspace: '/w/beta', source: 'claude_code', model: 'claude-sonnet-5' },
  { sessionId: 's3', workspace: '/h/user/Code/alpha', source: 'claude_code', model: 'claude-opus-5' },
  { sessionId: 's4', workspace: '/w/gamma', source: 'claude_code' },
  { sessionId: 's6', workspace: '/w/beta', source: 'claude_code', model: 'claude-opus-5' },
]

// ── observed capacities ───────────────────────────────────────────────────────
const OBSERVED_OWN = {
  'aaaaaaaa-1111-1111-1111-111111111111': { window5hTokens: 5_000_000, window7dTokens: 40_000_000, window5hCostUsd: 40, window7dCostUsd: 300, observedAt: '2026-07-30T00:00:00.000Z' },
}
// No calibration for aaaa, but TWO same-plan accounts have one — the pick must be the newest
// observedAt, deterministically, not whichever key was inserted first.
const OBSERVED_PROXY = {
  'bbbbbbbb-2222-2222-2222-222222222222': { window5hTokens: 1_000_000, window7dTokens: 9_000_000, window5hCostUsd: 10, window7dCostUsd: 90, observedAt: '2026-07-01T00:00:00.000Z' },
  'cccccccc-3333-3333-3333-333333333333': { window5hTokens: 2_000_000, window7dTokens: 8_000_000, window5hCostUsd: 20, window7dCostUsd: 80, observedAt: '2026-07-29T00:00:00.000Z' },
}
// Calibrated on TOKENS only, so the fill% must fall back from cost to tokens.
const OBSERVED_TOKENS_ONLY = {
  'aaaaaaaa-1111-1111-1111-111111111111': { window5hTokens: 500_000, window7dTokens: 4_000_000, window5hCostUsd: null, window7dCostUsd: null, observedAt: '2026-07-30T00:00:00.000Z' },
}

// cccccccc has no segment of its own in the fixture timeline, so give it one for the proxy case:
// a same-plan candidate is matched by the segment timeline's plan map, not by the observed table.
const PROXY_SEGMENTS = [
  ...SEGMENTS,
  { accountId: 'cccccccc-3333-3333-3333-333333333333', email: 'three@example.test', plan: 'Max 20x', startMs: T(-10), endMs: T(-9) },
]

const report = (observed, opts = {}) => buildAccountBurnersReport({
  events: EVENTS, target: opts.target ?? targets.previous ?? current,
  allSegments: opts.allSegments ?? SEGMENTS, cards: CARDS,
  untilMs: opts.untilMs ?? NOW, nowMs: NOW, limit: opts.limit ?? 15, observed,
})

writeFileSync(dir + 'acctburners-expected.json', JSON.stringify({
  nowMs: NOW,
  segmentCases: Object.fromEntries(Object.entries(RECORD_CASES).map(([k, v]) => [k, { records: v, out: segmentsFromRecords(v) }])),
  readSegments: SEGMENTS,
  // An absent file yields [] — an explicit "no timeline" for the caller, never a crash.
  readMissingFile: readAccountSegments(dir + 'does-not-exist.ndjson'),
  targets,
  intervals: Object.fromEntries(INTERVALS.map(i => [i, resolveWindowUntil(i, current, NOW)])),
  // TRANSCRIBED, not imported: the "Known: …" list is an inline expression in mcpServer.ts's
  // dispatch, not an exported function, so this is a copy of that exact line rather than a true
  // oracle. Kept because the `?? '?'` is NULLISH — an EMPTY email renders as empty parens, not "?"
  // — and the fixture's newest segment has exactly that.
  knownAccounts: [...new Set(SEGMENTS.map(s => `${s.accountId.slice(0, 8)} (${s.email ?? '?'})`))].join(', '),
  events: EVENTS,
  cards: CARDS,
  weights: EVENTS.map(weighted),
  fmtTok: [0, 1, 500, 999, 1000, 1500, 999_999, 1_000_000, 12_345_678, 1_200_000_000].map(n => [n, fmtTok(n)]),
  // The attribution rule in isolation: only aaaa's own stints, and the unresolved stretch is
  // attributable to nobody.
  windowEvents: eventsForAccountInWindow(EVENTS, targets.current, T(0), NOW, NOW).map(e => e.ts),
  capacityOwn: resolveWindowCapacity(OBSERVED_OWN, targets.current, SEGMENTS, '5h'),
  capacityProxy: resolveWindowCapacity(OBSERVED_PROXY, targets.current, PROXY_SEGMENTS, '5h'),
  capacityNone: resolveWindowCapacity({}, targets.current, SEGMENTS, '7d'),
  observedOwn: OBSERVED_OWN,
  observedProxy: OBSERVED_PROXY,
  observedTokensOnly: OBSERVED_TOKENS_ONLY,
  proxySegments: PROXY_SEGMENTS,
  reportOwn: report(OBSERVED_OWN, { target: targets.current }),
  reportProxy: report(OBSERVED_PROXY, { target: targets.current, allSegments: PROXY_SEGMENTS }),
  reportNoCapacity: report({}, { target: targets.current }),
  reportTokensOnlyCapacity: report(OBSERVED_TOKENS_ONLY, { target: targets.current }),
  // The rotated-out account: a different segment set, so different events attribute to it.
  reportPrevious: report(OBSERVED_OWN, { target: targets.previous }),
  // limit 1 truncates both tables while totalProjects/totalBurners keep the honest counts.
  reportLimitOne: report(OBSERVED_OWN, { target: targets.current, limit: 1 }),
  // A window ending before any event: zero burners, and the verdict SAYS so.
  reportEmptyWindow: report(OBSERVED_OWN, { target: targets.current, untilMs: T(-100) }),
}, null, 2) + '\n')
console.log('wrote acctburners-expected.json')
