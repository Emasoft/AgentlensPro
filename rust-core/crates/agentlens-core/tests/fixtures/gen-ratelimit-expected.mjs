// Regenerates ratelimit-expected.json — and the burnscan-rl-hooks/ bucket it reads — from the
// COMPILED src/rateLimitReport.ts. The parity oracle for get_rate_limit_report (TRDD-DMWOBWFH
// P4x.2g). Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ratelimit-expected.mjs
//
// No mtime oracle here: hook events carry their own `ts` INSIDE the ndjsonl line, and the bucket
// file is selected by its FILENAME date, so nothing depends on the file's mtime.
//
// The `investigate` option is the TS's own test seam, and it is used rather than a real body scan
// so the report is a pure function of the fixture — an actual investigateBurn would make the
// oracle depend on whatever bodies happen to sit in the corpus.
//
// What the fixture pins:
//  - THE TRAP: topFindings reads r.code / r.summary / r.detail, and a real BurnFinding has NONE of
//    them — so the label is empty and every entry is a 160-char JSON DUMP of the finding. `f3`
//    proves the dump path with a realistic finding; `f1`/`f2` prove the label path DOES work when
//    those keys exist, so the two branches are distinguished rather than assumed.
//  - `summary ?? detail` is NULLISH: f2 has summary:null so detail wins; f4 has summary as a
//    NUMBER, which suppresses detail AND fails the string filter, contributing nothing.
//  - Episode grouping at the ≤600s boundary: e3 is EXACTLY 600s after e2 (same episode) and e4 is
//    601s after e3 (new episode). An off-by-one in the comparison flips both.
//  - FIRST record per session wins inside an episode: s1 dies twice in episode 1 with different
//    errors, and only the earlier one may be listed.
//  - `.slice(-maxEpisodes).reverse()` = newest FIRST, and episodesTotal counts ALL of them.
//  - A 250-char error is truncated to 200 UTF-16 units; it is built from emoji so a byte-indexed
//    slice would cut a different amount (and could split a surrogate pair).
//  - The empty-window branch returns a DIFFERENT key set (no episodesTotal/attributed).
//  - The catch branch: a throwing investigate must produce attributed.error, not a crash.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { buildRateLimitReport } = await import(path.join(HERE, '../../../../../out/rateLimitReport.js'))

const HOOKS = path.join(HERE, 'ratelimit-hooks')
const EMPTY = path.join(HERE, 'ratelimit-hooks-empty')
for (const d of [HOOKS, EMPTY]) {
  fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
}

const T = (iso) => Date.parse(iso)
const NOW = T('2026-08-20T18:00:00.000Z')

// A 250-unit error made of emoji: `.slice(0, 200)` must cut at UTF-16 unit 200, and every emoji is
// 2 units, so the cut lands BETWEEN characters — a byte cut would not.
const LONG_ERR = '🔥'.repeat(125) + 'TAIL-THAT-MUST-NOT-APPEAR'

const ev = (iso, session, cwd, error) => ({
  ts: T(iso), ev: 'StopFailure', session,
  payload: { cwd, ...(error === undefined ? {} : { error }) },
})

// Episode 1: e1, e2, e3 (e3 is EXACTLY 600s after e2 — still one episode).
// Episode 2: e4 (601s after e3 — a new one). Episode 3: e5, much later.
const events = [
  ev('2026-08-20T10:00:00Z', 's1', '/w/alpha', 'rate limit reached, retry after 300s'),
  ev('2026-08-20T10:05:00Z', 's2', '/w/beta', LONG_ERR),
  ev('2026-08-20T10:15:00Z', 's1', '/w/alpha', 'SECOND death of s1 — must NOT be listed'),
  ev('2026-08-20T10:25:01Z', 's3', null, undefined),
  ev('2026-08-20T14:00:00Z', null, '/w/gamma', 'no session id at all'),
]
fs.writeFileSync(path.join(HOOKS, '2026-08-20.ndjsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
// A NON-StopFailure event in the same bucket, to prove the ev filter actually filters.
fs.appendFileSync(path.join(HOOKS, '2026-08-20.ndjsonl'),
  JSON.stringify({ ts: T('2026-08-20T10:02:00Z'), ev: 'Stop', session: 's9', payload: {} }) + '\n')

// The stub investigation. f1/f2/f4 exercise the label branches; f3 is a realistic BurnFinding and
// must come out as a JSON dump.
const INVESTIGATION = {
  totals: { calls: 12, estCostUsd: 4.56 },
  verdict: 'Top culprit: 1. FORK_STORM (1.2M equiv, 100%) — a fan-out forked a fat parent.',
  findings: [
    { code: 'C1', summary: 'a summary wins' },
    { code: 'C2', summary: null, detail: 'detail is used when summary is nullish' },
    { cause: 'FORK_STORM', equivTokens: 1162500, confidence: 'high', verdict: 'x → y ≤ z', evidence: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 } },
    { code: 'C4', summary: 42, detail: 'suppressed by a non-null non-string summary' },
    { code: 'C5', summary: 'a fifth finding that must be dropped by take(4)' },
  ],
}

const calls = []
const investigate = (o) => { calls.push(o); return INVESTIGATION }
const thrower = () => { throw new Error('duckdb exploded') }

const cases = {
  main: buildRateLimitReport({ hookEventsDir: HOOKS, now: NOW, investigate }),
  maxEpisodes1: buildRateLimitReport({ hookEventsDir: HOOKS, now: NOW, maxEpisodes: 1, investigate }),
  // maxEpisodes clamps to [1, 20]; windowHours clamps to [1, 336].
  clamped: buildRateLimitReport({ hookEventsDir: HOOKS, now: NOW, maxEpisodes: 999, windowHours: 9999, investigate }),
  // A 2h window ends at 18:00, so every event (10:00–14:00) falls outside it.
  narrow: buildRateLimitReport({ hookEventsDir: HOOKS, now: NOW, windowHours: 2, investigate }),
  empty: buildRateLimitReport({ hookEventsDir: EMPTY, now: NOW, investigate }),
  threw: buildRateLimitReport({ hookEventsDir: HOOKS, now: NOW, investigate: thrower }),
}

const out = { nowMs: NOW, investigation: INVESTIGATION, investigateCalls: calls, cases }
fs.writeFileSync(path.join(HERE, 'ratelimit-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote ratelimit-expected.json —', Object.keys(cases).length, 'cases')
for (const [k, v] of Object.entries(cases)) {
  console.log(` ${k}: stallEvents=${v.stallEvents} episodes=${v.episodes.length} total=${v.episodesTotal ?? '-'} attributed=${v.attributed ? (v.attributed.error ? 'ERROR' : 'ok') : '-'}`)
}
console.log('topFindings:', JSON.stringify(cases.main.attributed.topFindings, null, 1))
