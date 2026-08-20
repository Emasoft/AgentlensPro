// Regenerates ccevent-expected.json — and the three fixture trees it reads — from the COMPILED
// src/cacheEventLog.ts. The parity oracle for get_cache_event_log (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ccevent-expected.mjs
//
// TZ IS PINNED TO UTC, and that is not cosmetic: the ledger renders `localTime` with
// toLocaleTimeString and reports Intl's resolved zone, so a fixture generated in one zone and
// asserted in another is not a fixture — it is a different expected file on every machine. The
// Rust side takes the zone as a PARAMETER (DisplayZone::Fixed) rather than reading the process
// environment, so its test pins the same zone without mutating the process.
//
// process.cwd() and CLAUDE_PROJECT_DIR are STUBBED to fake paths. Using the real ones would derive
// a project slug from this machine's home directory — an identity leak that `check-identities`
// catches only because the slug survives redaction (it is a DERIVED string, not a path literal).
//
// MTIME ORACLE: the raw-body scan windows and orders by mtime, and git does not preserve those —
// the table below is stamped here and PUBLISHED; the Rust test re-stamps from it.
//
// What the fixture pins:
//  - OTEL WINS when the span store has events; the raw-body scan is the fallback, and the two
//    produce a DIFFERENT `source`, a different `excluded.note`, and different attribution (OTEL
//    carries session.id per call, so a compaction's own summarization call — query_source
//    `compact` — is attributed, which the previous_message_id chain cannot do).
//  - `cacheWriteTtl` is 1-hour only when the enriched body reports a 1h portion; an OTEL row with
//    no body is UNKNOWN (null), NOT 5-minute — only the body path can assert that tier.
//  - cache_missed_input_tokens of exactly 0 renders NO parenthetical (the TS test is truthy), and
//    a reason with no token count renders the reason alone.
//  - costSource: `harness` when OTEL reported cost_usd, `computed` when priced locally, `unpriced`
//    when the model has no rate entry (weighted is then null, never a guessed number).
//  - The peak is by COST, ties toward the MOST RECENT (`>=`) — req-a4 is not the biggest write.
//  - A session owned by another project is counted in `excluded.otherProject`, never printed.
//  - An event with an empty session.id is `unattributable`, a different count with a different
//    meaning: the boundary working vs a coverage gap.
//  - A midnight-local call pins toLocaleTimeString's h23-vs-h24 rendering (00:00:00, not 24:00:00).
process.env.TZ = 'UTC'
import { createRequire } from 'module'
import { writeFileSync, mkdirSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const home = dir + 'ccevent-home'
const projects = home + '/projects'
const bodies = dir + 'ccevent-bodies'
const spans = dir + 'ccevent-spans'
const noSpans = dir + 'no-such-spans'
for (const d of [projects + '/-w-alpha', projects + '/-w-beta', bodies, spans]) mkdirSync(d, { recursive: true })

// claudeProjectsDirs() appends 'projects' unless the value already ends with it.
process.env['CLAUDE_CONFIG_DIR'] = home
process.env['CLAUDE_PROJECT_DIR'] = '/w/beta'
process.cwd = () => '/w/alpha'

const { buildCacheEventLog, formatCacheEventLog, writeScaleOf, WRITE_SCALE_THRESHOLDS } =
  require('../../../../../out/test/cacheEventLog.js')

const NOW = Date.parse('2026-08-18T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const M = 60_000
const SESS_A1 = 'aaaaaaaa-1111-1111-1111-111111111111'
const SESS_A2 = 'aaaaaaaa-2222-2222-2222-222222222222'
const SESS_B1 = 'bbbb2222-3333-3333-3333-333333333333'
// The ownership fact is the DIRECTORY NAME plus the transcript filename — no file is opened.
for (const [slug, sess] of [['-w-alpha', SESS_A1], ['-w-alpha', SESS_A2], ['-w-beta', SESS_B1]]) {
  writeFileSync(`${projects}/${slug}/${sess}.jsonl`, '')
}

// ── the OTEL span segment ──────────────────────────────────────────────────────
const attr = (key, value) => ({ key, value })
const S = (v) => ({ stringValue: v })
const I = (v) => ({ intValue: String(v) })
const D = (v) => ({ doubleValue: v })
const span = (session, a) => JSON.stringify({
  name: 'claude_code.api_request',
  startTime: String(NOW * 1_000_000),
  attributes: [attr('session.id', S(session)), ...Object.entries(a).map(([k, v]) => attr(k, v))],
})
const call = (session, id, tsMs, o) => span(session, {
  'event.timestamp': S(new RealDate(tsMs).toISOString()),
  request_id: S(id),
  ...(o.model ? { model: S(o.model) } : {}),
  input_tokens: I(o.input), output_tokens: I(o.output),
  cache_read_tokens: I(o.cacheRead), cache_creation_tokens: I(o.cacheCreate),
  ...(o.cost === undefined ? {} : { cost_usd: D(o.cost) }),
  ...(o.querySource ? { query_source: S(o.querySource) } : {}),
})

const SEGMENT = [
  // Midnight local — pins the h23/h24 rendering of toLocaleTimeString.
  call(SESS_A1, 'req-mid', Date.parse('2026-08-18T00:00:00.000Z'), { model: 'claude-opus-5', input: 5, output: 5, cacheRead: 100, cacheCreate: 0, cost: 0.001, querySource: 'repl_main_thread' }),
  // Another project's session — counted in excluded.otherProject, never printed.
  call(SESS_B1, 'req-b1', NOW - 40 * M, { model: 'claude-opus-5', input: 10, output: 10, cacheRead: 1000, cacheCreate: 90000, cost: 0.6, querySource: 'repl_main_thread' }),
  // Enriched from its body: a 1h write split AND a cache_miss_reason WITH a token count.
  call(SESS_A1, 'req-a1', NOW - 30 * M, { model: 'claude-opus-5', input: 100, output: 500, cacheRead: 20000, cacheCreate: 150000, cost: 1.25, querySource: 'repl_main_thread' }),
  call(SESS_A1, 'req-a2', NOW - 25 * M, { model: 'claude-opus-5', input: 50, output: 300, cacheRead: 200000, cacheCreate: 0, cost: 0.12, querySource: 'repl_main_thread' }),
  // A compaction's OWN summarization call — attributable only because OTEL carries session.id.
  // Its body gives a reason with NO token count.
  call(SESS_A1, 'req-a3', NOW - 20 * M, { model: 'claude-opus-5', input: 20, output: 90, cacheRead: 210000, cacheCreate: 12000, cost: 0.3, querySource: 'compact' }),
  // THE PEAK by cost — and NOT the biggest cache write in the window is a lie here, so it also
  // pins that the biggest write and the costliest call CAN coincide; req-a1 is the runner-up.
  // Its body's cache_missed_input_tokens is exactly 0 ⇒ no parenthetical.
  call(SESS_A2, 'req-a4', NOW - 15 * M, { model: 'claude-sonnet-5', input: 30, output: 1200, cacheRead: 5000, cacheCreate: 400000, cost: 2.5, querySource: 'agent:lean-worker' }),
  // No cost_usd ⇒ priced locally ⇒ costSource 'computed'.
  call(SESS_A1, 'req-a5', NOW - 10 * M, { model: 'claude-opus-5', input: 10, output: 20, cacheRead: 300000, cacheCreate: 0, querySource: 'repl_main_thread' }),
  // An UNKNOWN model is still 'computed', not 'unpriced': calcTokenCostUsd returns a NUMBER (0)
  // for a model with no rate entry, so the cost is non-null and the row claims to be priced —
  // while `weighted` is null, because that one goes through lookupRates and gets nothing.
  call(SESS_A1, 'req-a6', NOW - 5 * M, { model: 'not-a-real-model-9', input: 7, output: 3, cacheRead: 40, cacheCreate: 800, querySource: 'repl_main_thread' }),
  // NO model at all ⇒ the only path to 'unpriced': cost null, weighted null, and the cell renders
  // the word rather than $0.0000.
  call(SESS_A1, 'req-a7', NOW - 4 * M, { input: 9, output: 4, cacheRead: 60, cacheCreate: 20000, querySource: 'repl_main_thread' }),
  // Empty session.id ⇒ unattributable, which is a DIFFERENT count from otherProject.
  call('', 'req-x1', NOW - 2 * M, { model: 'claude-opus-5', input: 1, output: 1, cacheRead: 10, cacheCreate: 5, cost: 0.01, querySource: 'repl_main_thread' }),
].join('\n') + '\n'
writeFileSync(spans + '/2026-08-18.ndjson', SEGMENT)

// ── raw bodies: the enrichment source AND the fallback feed ────────────────────
const usage = (input, output, cacheRead, cacheCreate, h1) => ({
  input_tokens: input, output_tokens: output,
  cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
  ...(h1 === undefined ? {} : { cache_creation: { ephemeral_5m_input_tokens: cacheCreate - h1, ephemeral_1h_input_tokens: h1 } }),
})
const BODY_FILES = {
  // Enrichment for req-a1: the 1h split OTEL cannot report, plus the API's own miss reason.
  'req-a1.response.json': [{ id: 'msg_a1', model: 'claude-opus-5', usage: usage(100, 500, 20000, 150000, 150000), diagnostics: { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 20000 } } }, NOW - 30 * M],
  // A reason with NO token count ⇒ the reason renders alone.
  'req-a3.response.json': [{ id: 'msg_a3', model: 'claude-opus-5', usage: usage(20, 90, 210000, 12000), diagnostics: { cache_miss_reason: { type: 'messages_changed' } } }, NOW - 20 * M],
  // cache_missed_input_tokens EXACTLY 0 ⇒ still no parenthetical (the TS test is truthy).
  'req-a4.response.json': [{ id: 'msg_a4', model: 'claude-sonnet-5', usage: usage(30, 1200, 5000, 400000), diagnostics: { cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 0 } } }, NOW - 15 * M],
  // The raw-body FALLBACK feed: s1 is attributed through q1's previous_message_id.
  's1.response.json': [{ id: 'msg_s1', model: 'claude-opus-5', usage: usage(60, 40, 9000, 70000, 70000) }, NOW - 35 * M],
  'q1.request.json': [{ model: 'claude-opus-5', metadata: { user_id: JSON.stringify({ session_id: SESS_A1, account_uuid: 'acct1111-2222-2222-2222-222222222222' }) }, diagnostics: { previous_message_id: 'msg_s1' } }, NOW - 34 * M],
  // s2 belongs to the OTHER project, so the fallback path excludes it too.
  's2.response.json': [{ id: 'msg_s2', model: 'claude-opus-5', usage: usage(5, 5, 500, 3000) }, NOW - 45 * M],
  'q2.request.json': [{ model: 'claude-opus-5', metadata: { user_id: JSON.stringify({ session_id: SESS_B1 }) }, diagnostics: { previous_message_id: 'msg_s2' } }, NOW - 44 * M],
}
const MTIMES = {}
for (const [name, [body, ms]] of Object.entries(BODY_FILES)) {
  writeFileSync(bodies + '/' + name, JSON.stringify(body) + '\n')
  MTIMES[name] = ms
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

const strip = (o) => JSON.parse(JSON.stringify(o)
  .split(bodies).join('<BODIES>')
  .split(spans).join('<SPANS>')
  .split(noSpans).join('<NOSPANS>'))

const log = async (o = {}) => strip(await buildCacheEventLog({ bodiesDir: bodies, spansDir: spans, ...o }))
const fmt = async (o, format) => strip(formatCacheEventLog(await buildCacheEventLog({ bodiesDir: bodies, spansDir: spans, ...o }), format))

writeFileSync(dir + 'ccevent-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  sessions: { a1: SESS_A1, a2: SESS_A2, b1: SESS_B1 },

  writeScale: {
    thresholds: WRITE_SCALE_THRESHOLDS,
    // 0 tokens is scale 0 — a warm turn gets NO marker, which is what makes a marker mean
    // something. The steps are order-of-magnitude, so 9,999 and 10,000 differ by one flame.
    samples: Object.fromEntries([0, 1, 9999, 10000, 49999, 50000, 150000, 399999, 400000, 5_000_000]
      .map(n => [n, writeScaleOf(n)])),
  },

  // ── project resolution ────────────────────────────────────────────────────
  // Explicit argument wins; then CLAUDE_PROJECT_DIR; then cwd. All three resolve to a real
  // on-disk directory name, never a naive derivation that could match nothing.
  logDefault: await log({ project: '-w-alpha' }),
  logFromEnv: await log({}),                      // CLAUDE_PROJECT_DIR = /w/beta
  logBlankProject: await log({ project: '   ' }), // whitespace is FALSY ⇒ falls through to env
  logFromCwd: await (async () => {                // env unset ⇒ the last resort, process.cwd()
    const saved = process.env['CLAUDE_PROJECT_DIR']
    delete process.env['CLAUDE_PROJECT_DIR']
    const out = await log({})
    process.env['CLAUDE_PROJECT_DIR'] = saved
    return out
  })(),
  logUnknownProject: await log({ project: '-w-nope' }),

  // ── modes ─────────────────────────────────────────────────────────────────
  logRecent: await log({ project: '-w-alpha', mode: 'recent' }),
  logRecentLimitOne: await log({ project: '-w-alpha', mode: 'recent', limit: 1 }),
  // limit is clamped to [1, 200]; 0 is NOT "no rows".
  logRecentLimitZero: await log({ project: '-w-alpha', mode: 'recent', limit: 0 }),
  logRecentAll: await log({ project: '-w-alpha', mode: 'recent', limit: 999 }),
  // contextEvents 0 ⇒ the peak row alone; 999 clamps to 25 ⇒ every row.
  logContextZero: await log({ project: '-w-alpha', contextEvents: 0 }),
  logContextHuge: await log({ project: '-w-alpha', contextEvents: 999 }),
  logSessionFilter: await log({ project: '-w-alpha', sessionId: SESS_A1 }),
  logWindowed: await log({ project: '-w-alpha', windowHours: 1 }),

  // ── the raw-body fallback ─────────────────────────────────────────────────
  // No readable span store ⇒ source 'raw-bodies', a different excluded note, and attribution
  // through the FOLLOWING request's previous_message_id.
  logRawBodies: await log({ project: '-w-alpha', spansDir: noSpans }),
  logRawBodiesRecent: await log({ project: '-w-alpha', spansDir: noSpans, mode: 'recent' }),

  // ── formats ───────────────────────────────────────────────────────────────
  formatTable: await fmt({ project: '-w-alpha' }, 'table'),
  formatMarkdown: await fmt({ project: '-w-alpha' }, 'markdown'),
  formatJson: await fmt({ project: '-w-alpha' }, 'json'),
  // The widest cell drives the column width, and the flame marker is TWO columns per code point.
  formatTableAll: await fmt({ project: '-w-alpha', mode: 'recent', limit: 999 }, 'table'),
  // Zero rows: the title, the TOTAL row and the legend still render.
  formatTableEmpty: await fmt({ project: '-w-nope' }, 'table'),
  formatTableRawBodies: await fmt({ project: '-w-alpha', spansDir: noSpans }, 'table'),
}, null, 2) + '\n')
console.log('wrote ccevent-expected.json + ccevent-{home,bodies,spans}/')
