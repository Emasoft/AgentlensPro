// Regenerates ccreport-expected.json — and the `ccreport-bodies/` fixture it reads — from the
// COMPILED src/cacheCreationForensics.ts. The parity oracle for the cache-creation REPORT half
// (TRDD-DMWOBWFH P4x.2d): buildCacheCreationReport / buildExpensiveWritesTrace /
// buildCacheBreakGapReport and their formatters.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ccreport-expected.mjs
//
// The BODIES ARE GENERATED HERE, not hand-written, so the fixture and the mtime table that gives it
// meaning have one source. The scan half keeps its own `forensics-bodies/` dir untouched: adding
// files there would shift every count in the already-pinned ccforensics-expected.json.
//
// MTIME ORACLE: git does not preserve mtimes, and the gap buckets are ENTIRELY a function of the
// spacing between them — so the table is stamped here and PUBLISHED; the Rust test re-stamps from it.
//
// The Date is frozen because boundedRecent's window cutoff and calcTokenCostUsd's
// scheduled-rate-change branch both read the wall clock.
//
// What the fixture pins, and which file carries it:
//  - The six gap buckets are ALL hit at the DEFAULT 100k threshold: A1/B1 first-call, A2 +5m
//    (=5m TTL), A3 +2m (<4.5m), A4 +10m (6-15m), A5 +40m (15-65m), B2 +100m (>65m).
//  - C1 is BELOW the threshold and sorts FIRST in the '(unattributed)' pseudo-group, so C2's gap is
//    measured against a call that was itself never classified — the `i === 0` test is positional,
//    not "the previous BIG event".
//  - A1's model comes from its REQUEST (claude-opus-5) though the response says claude-opus-4-8.
//  - B is attributed but its user_id carries NO account_uuid, so groupBy=account files it under
//    '(unattributed)' alongside the genuinely unjoinable C events — being attributed and having an
//    account are separate facts.
//  - C2 has NO model ⇒ '(unknown model)', costUsd 0, and its `model` key is DROPPED.
//  - C2's response carries no `cache_creation` sub-object, so 5m+1h < total in the tier split: the
//    split is not required to reconstruct the total.
//  - 8 events have outputTokens > 0 and C2 has 0 ⇒ the top-5 output-spike slice truncates AND the
//    zero-output event is filtered out rather than ranked last.
//  - qA2 has NO tools ⇒ no toolCatalog block ⇒ toolCatalogCount 0 (the regex's else branch);
//    qA1 has 3 and qA3 has 12, so the capture is exercised at one and two digits.
//  - C events have no request naming them ⇒ requestRef absent ⇒ composition null.
//  - The chain on A5 excludes qA5 itself (t.ts <= e.ts is measured against the RESPONSE mtime, and
//    each request is stamped one minute AFTER the response it follows).
import { createRequire } from 'module'
import { writeFileSync, mkdirSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodies = dir + 'ccreport-bodies'
mkdirSync(bodies, { recursive: true })

const {
  buildCacheCreationReport, buildExpensiveWritesTrace, buildCacheBreakGapReport,
  formatCostPeaks, formatExpensiveWrites,
  tokenCountsTotal, tokenCountsFullCost, bucketValueOf,
} = require('../../../../../out/test/cacheCreationForensics.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const M = 60_000
const SESSION_A = 'aaaaaaaa-1111-1111-1111-111111111111'
const ACCOUNT_A = 'acct1111-2222-2222-2222-222222222222'
const SESSION_B = 'bbbb2222-3333-3333-3333-333333333333'

const usage = (input, output, cacheRead, cacheCreate, tier) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
  ...(tier ? { cache_creation: { ephemeral_5m_input_tokens: tier[0], ephemeral_1h_input_tokens: tier[1] } } : {}),
})

// name → [body, mtime]. Responses first (the events), then the requests that attribute them.
const FILES = {
  'rA1.response.json': [{ id: 'msg_a1', model: 'claude-opus-4-8', usage: usage(100, 500, 20000, 150000, [150000, 0]) }, NOW - 70 * M],
  'rA2.response.json': [{ id: 'msg_a2', model: 'claude-opus-5', usage: usage(50, 300, 40000, 120000, [0, 120000]) }, NOW - 65 * M],
  'rA3.response.json': [{ id: 'msg_a3', model: 'claude-opus-5', usage: usage(20, 90, 60000, 110000, [110000, 0]) }, NOW - 63 * M],
  'rA4.response.json': [{ id: 'msg_a4', model: 'claude-opus-5', usage: usage(30, 1200, 10000, 200000, [100000, 100000]) }, NOW - 53 * M],
  'rA5.response.json': [{ id: 'msg_a5', model: 'claude-opus-5', usage: usage(15, 7, 5000, 130000, [130000, 0]) }, NOW - 13 * M],
  'rB1.response.json': [{ id: 'msg_b1', model: 'claude-sonnet-5', usage: usage(200, 2000, 1000, 250000, [0, 250000]) }, NOW - 200 * M],
  'rB2.response.json': [{ id: 'msg_b2', model: 'claude-sonnet-5', usage: usage(10, 60, 900, 180000, [180000, 0]) }, NOW - 100 * M],
  // Unattributed: no request names these. C1's model is reachable only via message.model.
  'rC1.response.json': [{ id: 'msg_c1', message: { model: 'claude-haiku-4-5' }, usage: usage(5, 3, 100, 5000, [5000, 0]) }, NOW - 30 * M],
  'rC2.response.json': [{ id: 'msg_c2', usage: usage(4, 0, 50, 140000) }, NOW - 25 * M],
}

const tools = (n) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}`, description: `does thing ${i}` }))
const uid = (sessionId, accountUuid) => JSON.stringify({ session_id: sessionId, ...(accountUuid ? { account_uuid: accountUuid } : {}) })
const req = (model, sessionId, accountUuid, prev, extra) => ({
  model, metadata: { user_id: uid(sessionId, accountUuid) }, diagnostics: { previous_message_id: prev }, ...extra,
})

// The requests carry real content so the composition summary has something to summarize. Each is
// stamped ONE MINUTE AFTER the response it follows — the request for turn N+1 is what names turn N's
// response as its previous_message_id.
FILES['qA1.request.json'] = [req('claude-opus-5', SESSION_A, ACCOUNT_A, 'msg_a1', {
  system: 'You are a helpful assistant working in a repository.',
  tools: tools(3),
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'find the bug in the parser' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'The parser probably mishandles the empty case.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'grep -n parse src/*.ts' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'src/parse.ts:42: export function parse(' },
      { type: 'image', source: { media_type: 'image/png', data: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=' } },
    ] },
  ],
}), NOW - 69 * M]
// No tools at all ⇒ no toolCatalog block ⇒ toolCatalogCount 0.
FILES['qA2.request.json'] = [req('claude-opus-5', SESSION_A, ACCOUNT_A, 'msg_a2', {
  system: 'You are a helpful assistant working in a repository.',
  messages: [{ role: 'user', content: 'why is it slow' }],
}), NOW - 64 * M]
FILES['qA3.request.json'] = [req('claude-opus-5', SESSION_A, ACCOUNT_A, 'msg_a3', {
  system: 'You are a helpful assistant working in a repository.',
  tools: tools(12),
  messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Because the scan is unbounded.' }] }],
}), NOW - 62 * M]
// system as an ARRAY of text blocks — the other system shape.
FILES['qA4.request.json'] = [req('claude-opus-5', SESSION_A, ACCOUNT_A, 'msg_a4', {
  system: [{ type: 'text', text: 'System part one.' }, { type: 'text', text: 'System part two, rather longer than the first.' }],
  tools: tools(2),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'apply the bound' }] }],
}), NOW - 52 * M]
FILES['qA5.request.json'] = [req('claude-opus-5', SESSION_A, ACCOUNT_A, 'msg_a5', {
  messages: [{ role: 'user', content: 'ship it' }],
}), NOW - 12 * M]
FILES['qB1.request.json'] = [req('claude-sonnet-5', SESSION_B, null, 'msg_b1', {
  system: 'Short system.',
  tools: tools(1),
  messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize the log' }] }],
}), NOW - 199 * M]
FILES['qB2.request.json'] = [req('claude-sonnet-5', SESSION_B, null, 'msg_b2', {
  messages: [{ role: 'user', content: 'again please' }],
}), NOW - 99 * M]

const MTIMES = {}
for (const [name, [body, ms]] of Object.entries(FILES)) {
  writeFileSync(bodies + '/' + name, JSON.stringify(body) + '\n')
  MTIMES[name] = ms
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

// REDACT the absolute fixture path: coverage.bodiesDir, responseRef, requestRef and every
// backwardChain bodyRef echo it, and on a real machine that is a home directory — a committed
// fixture carrying one fails `pnpm run check-identities` and pins one machine's layout into a test
// every contributor runs.
const strip = (o) => JSON.parse(JSON.stringify(o).split(bodies).join('<BODIES>'))

const report = async (o = {}) => strip(await buildCacheCreationReport({ bodiesDir: bodies, ...o }))
const trace = async (o = {}) => strip(await buildExpensiveWritesTrace({ bodiesDir: bodies, ...o }))
const gaps = async (o = {}) => strip(await buildCacheBreakGapReport({ bodiesDir: bodies, ...o }))
const fmtPeaks = async (o, format) => strip(formatCostPeaks(await buildCacheCreationReport({ bodiesDir: bodies, ...o }), format))
const fmtWrites = async (o, format) => strip(formatExpensiveWrites(await buildExpensiveWritesTrace({ bodiesDir: bodies, ...o }), format))

// The bucket primitives in isolation — every bucket over one counts object, including the
// unpriced (no model) case where billable_weighted collapses to 0.
const COUNTS = { inputTokens: 120, cacheReadTokens: 50000, cacheCreateTokens: 32000, outputTokens: 800, model: 'claude-opus-5' }
const COUNTS_NO_MODEL = { inputTokens: 120, cacheReadTokens: 50000, cacheCreateTokens: 32000, outputTokens: 800 }
const BUCKETS = ['cache_creation', 'output', 'input', 'total', 'billable_weighted']
const bucketTable = (t) => Object.fromEntries(BUCKETS.map(b => [b, bucketValueOf(t, b)]))

writeFileSync(dir + 'ccreport-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,

  primitives: {
    total: tokenCountsTotal(COUNTS),
    fullCost: tokenCountsFullCost(COUNTS),
    fullCostNoModel: tokenCountsFullCost(COUNTS_NO_MODEL),
    buckets: bucketTable(COUNTS),
    bucketsNoModel: bucketTable(COUNTS_NO_MODEL),
    // An unrecognized bucket string falls through to cache_creation, not to 0.
    bucketUnknown: bucketValueOf(COUNTS, 'not-a-bucket'),
  },

  // ── buildCacheCreationReport ──────────────────────────────────────────────
  reportDefault: await report({}),
  reportByAccount: await report({ groupBy: 'account' }),
  reportByModel: await report({ groupBy: 'model' }),
  reportByTime: await report({ groupBy: 'time' }),
  // Ranking by output / billable_weighted re-orders the SAME groups — the whole point of the bucket.
  reportBucketOutput: await report({ bucket: 'output' }),
  reportBucketWeighted: await report({ bucket: 'billable_weighted' }),
  reportBucketTotal: await report({ bucket: 'total' }),
  reportBucketInput: await report({ bucket: 'input' }),
  // topN truncates the table; the totals stay honest.
  reportTopOne: await report({ topN: 1 }),
  // topN is clamped to 50, and a window narrows the scan itself.
  reportTopHuge: await report({ topN: 999 }),
  reportWindowed: await report({ windowHours: 2 }),

  formatPeaksTable: await fmtPeaks({}, 'table'),
  formatPeaksMarkdown: await fmtPeaks({}, 'markdown'),
  formatPeaksTimeline: await fmtPeaks({}, 'timeline'),
  // json returns the report object itself, not a wrapper.
  formatPeaksJson: await fmtPeaks({}, 'json'),
  // A fractional bucketValue is what makes toLocaleString's 3-fraction-digit default observable.
  formatPeaksWeightedTable: await fmtPeaks({ bucket: 'billable_weighted' }, 'table'),

  // ── buildExpensiveWritesTrace ─────────────────────────────────────────────
  traceDefault: await trace({}),
  traceTopTwo: await trace({ topN: 2 }),
  traceMinCacheCreate: await trace({ minCacheCreate: 150000 }),
  traceMinOutput: await trace({ minOutputTokens: 500 }),
  traceBySession: await trace({ sessionId: SESSION_A }),
  traceByAccount: await trace({ accountUuid: ACCOUNT_A }),
  // model is a SUBSTRING match, not equality.
  traceByModelSubstring: await trace({ model: 'opus' }),
  traceTurnRange: await trace({ turnFrom: 2, turnTo: 4 }),
  traceTimeRange: await trace({ timeFromIso: new RealDate(NOW - 66 * M).toISOString(), timeToIso: new RealDate(NOW - 50 * M).toISOString() }),
  traceChain: await trace({ sessionId: SESSION_A, chainDepth: 3 }),
  // chainDepth is clamped to MAX_CHAIN_DEPTH (20) — a depth of 999 is not an unbounded walk.
  traceChainClamped: await trace({ sessionId: SESSION_A, chainDepth: 999, topN: 1 }),
  // topN is clamped to 25.
  traceTopHuge: await trace({ topN: 999 }),
  // A filter that matches nothing still returns a well-formed trace with its coverage.
  traceNoMatch: await trace({ sessionId: 'no-such-session' }),

  formatWritesTable: await fmtWrites({ topN: 3 }, 'table'),
  formatWritesMarkdown: await fmtWrites({ topN: 3 }, 'markdown'),
  formatWritesMarkdownChain: await fmtWrites({ sessionId: SESSION_A, topN: 2, chainDepth: 2 }, 'markdown'),
  formatWritesTimeline: await fmtWrites({ topN: 3 }, 'timeline'),
  formatWritesJson: await fmtWrites({ topN: 1 }, 'json'),

  // ── buildCacheBreakGapReport ──────────────────────────────────────────────
  gapsDefault: await gaps({}),
  // A lower threshold promotes C1 to "big", which changes which call each gap is measured against.
  gapsLowThreshold: await gaps({ minCacheCreate: 1000 }),
  // A threshold above every event: the tier split still reports, bigEventCount is 0, buckets empty.
  gapsNoBigEvents: await gaps({ minCacheCreate: 10_000_000 }),
  gapsWindowed: await gaps({ windowHours: 2 }),
}, null, 2) + '\n')
console.log('wrote ccreport-expected.json + ccreport-bodies/')
