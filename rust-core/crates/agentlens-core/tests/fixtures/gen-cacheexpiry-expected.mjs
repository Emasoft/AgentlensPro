// Regenerates cacheexpiry-expected.json from the COMPILED TS — the parity oracle for
// check_cache_expiry (assessCacheExpiry + handleCheckCacheExpiry, TRDD-OCNHOHE9 / TRDD-DMWOBWFH).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cacheexpiry-expected.mjs
//
// What the fixtures are built to discriminate:
//  - Key order is `{verdict, idleMs, idleHuman, marginMs, reason, ttlMs, ttlMin, ttlSource,
//    ttlBasis, usedThresholdOverride}` for the verdict, then `{...verdict, sessionId, workspace,
//    kind, lastRequestAt}` for a row — the `base` object is a SEPARATE literal spread AFTER
//    verdict/idleMs/idleHuman/marginMs/reason, not in its declared interface position.
//  - subagent is 5-min ALWAYS, auth-independent; main is 1h on a subscription; fork reads the
//    PARENT's cache entry (classified like main/auth) but its OWN card here has no timeline, so it
//    hits 'unknown'.
//  - PROJECT SCOPE filters BEFORE the bounded probe: the default pick is the newest MAIN session
//    of the named project, never the busiest one machine-wide. An explicit empty string is the
//    documented machine-wide opt-out.
//  - A sibling directory that merely shares a path PREFIX is not in scope (`/my/repo-old` vs
//    `/my/repo`).
//  - An explicit sessionId always wins, even against a contradicting project filter.
//  - `--all` yields per-card results with an honest coverage block; a generous budget never
//    triggers `stoppedEarly` (the same convention as the bycause fixture — the deadline read is a
//    live, unfreezable clock, so `stoppedEarly:true` parity is not asserted from this oracle).
//  - `thresholdMinutes` overrides the regime TTL and flips `ttlSource` to 'config'.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { handleCheckCacheExpiry, EXPIRY_NEWEST_PROBE } = require('../../../../../out/test/mcpServer.js')
const { assessCacheExpiry, formatIdle } = require('../../../../../out/test/cacheExpiry.js')
const { sessionTtlKindOf, classifyTtlRegime } = require('../../../../../out/test/shared/cacheTtl.js')
const dir = new URL('.', import.meta.url).pathname

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const SUBSCRIPTION = { auth: 'subscription', force5m: false, enable1h: false }

const isoMinAgo = (m) => new Date(NOW - m * 60_000).toISOString()

const apiRequestAt = (iso) => ({ type: 'api_request', spanId: 'r', label: 'api', durationMs: 1, isError: false, timestamp: iso })

const card = (o) => ({
  sessionId: o.id, traceId: 't-' + o.id, source: 'claude_code', dataSource: 'log',
  workspace: o.workspace ?? '/ws', projectPath: o.projectPath, userRequest: 'req',
  model: 'claude-opus-4-8', turns: 1,
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
  cacheHitRate: 0, durationMs: 1000, startTime: o.start ?? isoMinAgo(0),
  filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
  toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
  parentSessionId: o.parentSessionId, spawnKind: o.spawnKind,
  outcome: 'text_response', timeline: o.tl ?? [], backgroundSpans: [], loopSignals: [],
})

// ── Project-scope fleet: proj1 has three mains at different ages, proj2 has one FRESHER main
// (the machine-wide default must diverge from the proj1-scoped default) ────────────────────
const SESSIONS = [
  card({ id: 'main-a', workspace: '/w/proj1', projectPath: '/w/proj1', start: isoMinAgo(10), tl: [apiRequestAt(isoMinAgo(10))] }),
  card({ id: 'sub-a', workspace: '/w/proj1', projectPath: '/w/proj1', parentSessionId: 'main-a', start: isoMinAgo(10), tl: [apiRequestAt(isoMinAgo(10))] }),
  card({ id: 'fork-a', workspace: '/w/proj1', projectPath: '/w/proj1', parentSessionId: 'main-a', spawnKind: 'fork', start: isoMinAgo(10), tl: [] }),
  card({ id: 'main-b', workspace: '/w/proj2', projectPath: '/w/proj2', start: isoMinAgo(120), tl: [apiRequestAt(isoMinAgo(120))] }),
  card({ id: 'main-c', workspace: '/w/proj1', projectPath: '/w/proj1', start: isoMinAgo(1), tl: [apiRequestAt(isoMinAgo(1))] }),
  card({ id: 'main-d', workspace: '/w/proj2', projectPath: '/w/proj2', start: isoMinAgo(0.5), tl: [apiRequestAt(isoMinAgo(0.5))] }),
  // A sibling dir that merely shares a prefix — must NOT be in /w/proj1 scope.
  card({ id: 'sibling', workspace: '/w/proj1-old', projectPath: '/w/proj1-old', start: isoMinAgo(1), tl: [apiRequestAt(isoMinAgo(1))] }),
]
const getTimeline = (id) => (SESSIONS.find(s => s.sessionId === id)?.timeline) ?? []

// A tail resolver: answers for main-a/main-c directly (no reparse), misses everything else
// (falls back to lastActivityMs ranking, then a real reparse for the eventual winner).
const TAILS = { 'main-a': NOW - 10 * 60_000, 'main-c': NOW - 1 * 60_000 }
const getLastRequestMs = (id) => (id in TAILS ? TAILS[id] : null)

const out = {
  nowMs: NOW,
  // ── Pure engine: assessCacheExpiry / formatIdle ─────────────────────────────
  formatIdleSeconds: formatIdle(45_000),
  formatIdleMinutes: formatIdle(90_000),
  formatIdleHours: formatIdle(62 * 60_000),
  formatIdleNegative: formatIdle(-5_000),
  verdictMainFresh: assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION }),
  verdictMainExpired: assessCacheExpiry({ lastRequestAtMs: NOW - 90 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION }),
  verdictSubagentExpired: assessCacheExpiry({ lastRequestAtMs: NOW - 6 * 60_000, nowMs: NOW, kind: 'subagent', ctx: SUBSCRIPTION }),
  verdictUnknown: assessCacheExpiry({ lastRequestAtMs: null, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION }),
  verdictClockSkew: assessCacheExpiry({ lastRequestAtMs: NOW + 5_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION }),
  verdictThresholdOverride: assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 15 * 60_000 }),
  verdictThresholdIgnored: assessCacheExpiry({ lastRequestAtMs: NOW - 30 * 60_000, nowMs: NOW, kind: 'main', ctx: SUBSCRIPTION, thresholdMs: 0 }),
  verdictAssumedUnknownAuth: assessCacheExpiry({ lastRequestAtMs: NOW - 3 * 60_000, nowMs: NOW, kind: 'main', ctx: { auth: 'unknown', force5m: false, enable1h: false } }),

  // ── Tool: sessionId lookup (exact, both known and missing) ─────────────────
  toolBySessionId: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { sessionId: 'main-a' }),
  toolBySessionIdMissing: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { sessionId: 'nope' }),
  // sessionId wins even against a contradicting project filter.
  toolBySessionIdOverridesProject: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { sessionId: 'main-b', project: '/w/proj1' }),
  // The fork's own card has no timeline entries — 'unknown'.
  toolForkUnknown: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { sessionId: 'fork-a' }),
  // sessionId + thresholdMinutes override — main-a idles 10m, expired under a 1-min threshold.
  toolThresholdOverride: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { sessionId: 'main-a', thresholdMinutes: 1 }),

  // ── Project scope: default pick within a project, never machine-wide ───────
  toolProjectScopedDefault: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { project: '/w/proj1' }),
  toolProjectScopedTrailingSlash: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { project: '/w/proj1/' }),
  toolMachineWideDefault: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { project: '' }),
  toolSiblingPrefixNotInScope: await handleCheckCacheExpiry([SESSIONS[6]], getTimeline, SUBSCRIPTION, { project: '/w/proj1' }),

  // ── --all: honest coverage, newest-activity first, generous budget never stops early ──
  toolAllProj1: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { all: true, project: '/w/proj1' }),
  toolAllWide: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { all: true, project: '' }),

  // ── Tail-resolver probe: reuses the resolver's answer, no full reparse for main-a/main-c ──
  toolDefaultWithResolver: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { project: '/w/proj1' }, 20_000, getLastRequestMs),

  // ── An ALREADY-ELAPSED budget stops before the first item ─────────────────
  // `scanWithBudget` computes `deadline = Date.now() + timeBudgetMs` UNCONDITIONALLY, so a
  // negative budget is a deadline in the past: zero items scanned, `stoppedEarly: true`. A port
  // that gates the deadline on `budget > 0` inverts this into "no budget, scan everything" — the
  // opposite answer, with a full corpus walk behind it. A ZERO budget is the same shape but is
  // millisecond-nondeterministic (however many items fit in the current ms), so the pin uses -1.
  toolAllElapsedBudget: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { all: true, project: '' }, -1),
  // The same on the default path: the probe scans nothing, so there is no pick at all — and the
  // `note` says the pick came from a probed subset rather than presenting silence as an answer.
  toolDefaultElapsedBudget: await handleCheckCacheExpiry(SESSIONS, getTimeline, SUBSCRIPTION, { project: '/w/proj1' }, -1),
}
writeFileSync(dir + 'cacheexpiry-expected.json', JSON.stringify(out, null, 2) + '\n')
console.log('wrote cacheexpiry-expected.json')
