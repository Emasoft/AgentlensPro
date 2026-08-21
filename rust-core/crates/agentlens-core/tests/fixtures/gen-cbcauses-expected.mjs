// Regenerates cbcauses-expected.json from the COMPILED src/cacheBreakTimeline.ts — the parity
// oracle for SLICE 4 (TRDD-DMWOBWFH P4x.2l): buildCauseCostPeakReport, buildCacheBreakCauses and
// formatTimeline. Run from the repo root AFTER `pnpm run compile-tests` AND after
// gen-cbreport-expected.mjs (this reuses ITS fixture tree — one spool, three builders):
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cbreport-expected.mjs
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cbcauses-expected.mjs
//
// Sharing the tree is the point: these two builders and the timeline read the SAME scan, so a
// second fixture would let them drift apart while both stayed green. The mtime table lives in
// cbreport-expected.json and the Rust test re-stamps from there.
//
// What the cases pin beyond agreement:
//  - the VERDICT's avoidable-vs-expected split. Ranking actors by raw tokens alone crowns
//    COLD_START (expected, unactionable) and buries the misconfiguration, so the verdict names the
//    top AVOIDABLE actor and appends a parenthetical when the largest overall is a different,
//    expected one. The fixture has exactly that shape, so the parenthetical is exercised.
//  - `bucket` changes the RANKING, not just a number: cache_creation and output rank the causes
//    differently here, so a port that ignored the bucket would still match on the default.
//  - formatTimeline's four formats, including the eventsNote tail that only appears when topN
//    truncated the log, and the ⚠️/emoji mapping (a per-cause lookup, not a formatting detail —
//    it is what a human scans).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { buildCauseCostPeakReport, buildCacheBreakCauses, buildCacheBreakTimeline, formatTimeline } =
  await import(path.join(HERE, '../../../../../out/test/cacheBreakTimeline.js'))

const ROOT = path.join(HERE, 'cbreport')
const SPOOL = path.join(ROOT, 'spool')
const HOOKS = path.join(ROOT, 'hooks')
const NOSTORE = path.join(ROOT, 'no-such-store')
if (!fs.existsSync(SPOOL)) throw new Error('run gen-cbreport-expected.mjs first — this reuses its fixture tree')

const base = { bodiesDir: SPOOL, storeDir: NOSTORE, hookEventsDir: HOOKS, minTokens: 100 }
const NOSPOOL = { ...base, bodiesDir: path.join(ROOT, 'no-such-spool') }

const s1 = await buildCacheBreakTimeline({ ...base, sessionId: 'sess-alpha' })
const s1capped = await buildCacheBreakTimeline({ ...base, sessionId: 'sess-alpha', topN: 2 })

// See gen-cbreport-expected.mjs: the absolute root is redacted to a token, both because it differs
// per clone and because on this machine it contains a home path that check-identities rejects.
const ROOT_TOKEN = '<FIXTURES>'
const out = {
  root: ROOT_TOKEN,
  costPeak: {
    default_bucket: await buildCauseCostPeakReport({ ...base }),
    bucket_output: await buildCauseCostPeakReport({ ...base, bucket: 'output' }),
    bucket_weighted: await buildCauseCostPeakReport({ ...base, bucket: 'billable_weighted' }),
    topn1: await buildCauseCostPeakReport({ ...base, topN: 1 }),
    // topN clamps at 50; the group set is far smaller, so this proves the clamp does not truncate.
    topn_over_cap: await buildCauseCostPeakReport({ ...base, topN: 999 }),
    high_floor: await buildCauseCostPeakReport({ ...base, minTokens: 26000 }),
    no_evidence: await buildCauseCostPeakReport({ ...NOSPOOL }),
  },
  causes: {
    all: await buildCacheBreakCauses({ ...base }),
    scoped: await buildCacheBreakCauses({ ...base, scope: 'sess-' }),
    scoped_empty: await buildCacheBreakCauses({ ...base, scope: 'nothing-matches-' }),
    // ⚠ THE VERDICT IS COMPUTED FROM THE TRUNCATED LEADERBOARD, and this case pins it: with topN=1
    // the only surviving actor is the (expected) COLD_START one, so the verdict reads "all
    // classified break cost is EXPECTED cache behavior" even though avoidable actors exist and were
    // just dropped by the cap. That is the shipped behaviour — a port that computed the verdict
    // before truncating would read BETTER and be wrong.
    topn1: await buildCacheBreakCauses({ ...base, topN: 1 }),
    // topN clamps to [1, 100] — 0 must become 1, not an empty leaderboard.
    topn_clamped_low: await buildCacheBreakCauses({ ...base, topN: 0 }),
    high_floor: await buildCacheBreakCauses({ ...base, minTokens: 26000 }),
    no_evidence: await buildCacheBreakCauses({ ...NOSPOOL }),
  },
  formats: {
    json: formatTimeline(s1, 'json'),
    table: formatTimeline(s1, 'table'),
    markdown: formatTimeline(s1, 'markdown'),
    timeline: formatTimeline(s1, 'timeline'),
    // The eventsNote tail appends only when topN truncated the log.
    table_capped: formatTimeline(s1capped, 'table'),
    timeline_capped: formatTimeline(s1capped, 'timeline'),
  },
}
fs.writeFileSync(
  path.join(HERE, 'cbcauses-expected.json'),
  JSON.stringify(out, null, 2).split(ROOT).join(ROOT_TOKEN) + '\n',
)
console.log('wrote cbcauses-expected.json')
for (const [k, v] of Object.entries(out.costPeak)) {
  console.log(` costPeak.${k}: groups=${v.groups.map((g) => g.key + ':' + g.bucketValue).join(',') || '-'}`)
}
for (const [k, v] of Object.entries(out.causes)) {
  console.log(` causes.${k}: events=${v.totalClassifiedEvents} actors=${v.actorLeaderboard.length} verdict=${v.verdict.slice(0, 70)}`)
}
