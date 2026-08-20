// Regenerates ccforensics-expected.json from the COMPILED src/cacheCreationForensics.ts — the
// parity oracle for the cache-creation SCAN half (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ccforensics-expected.mjs
//
// MTIME ORACLE: the window filter and the recency ordering both read mtimes, and git does not
// preserve them — so the table below is stamped here and PUBLISHED; the Rust test re-stamps from it.
//
// The Date is frozen because BOTH `boundedRecent` (its window cutoff) and `calcTokenCostUsd` (via
// lookupRates' scheduled-rate-change branch) read the wall clock.
//
// What this pins, and which fixture file carries it:
//  - s1: ATTRIBUTED via q1's previous_message_id. Its model comes from the REQUEST
//    (claude-opus-5) even though the response says claude-opus-4-8 — the request is what was
//    billed, and this is the only case that can tell the two precedence orders apart.
//  - s2: attributed, but the response carries NO `cache_creation` sub-object ⇒ both tier fields are
//    0, not absent. The 5m/1h split is what tells a TTL expiry apart from a real prefix break, so a
//    missing split must read as "no split", never as "unknown".
//  - s3: UNATTRIBUTED, and its model is reachable only through `message.model` — the third fallback.
//  - s4: unattributed AND modelless ⇒ the `model` key is DROPPED and costUsd is 0. An unknown model
//    is priced at zero, never at a guessed rate.
//  - s5: cache_creation 0 ⇒ EXCLUDED by default, INCLUDED under includeZeroCacheCreate. It is also
//    attributed through q3, whose user_id is not valid JSON — so `attributed` is true and
//    `requestRef` is set while sessionId/accountUuid are DROPPED. Attribution and identity are
//    separate facts.
//  - s6: no `usage` object at all ⇒ excluded under BOTH settings.
//  - s7 / q5: malformed JSON ⇒ skipped without failing the scan.
//  - s8: no `id` ⇒ `responseId` dropped and the join is not even attempted.
//  - q4: no previous_message_id ⇒ never enters the index.
//  - notes.txt: wrong suffix ⇒ not even counted in the file totals.
import { createRequire } from 'module'
import { writeFileSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodies = dir + 'forensics-bodies'

const {
  scanCacheCreationEvents, listBySuffix, boundedRecent, readJsonBounded,
  RESPONSE_SCAN_CAP, REQUEST_INDEX_CAP,
} = require('../../../../../out/test/cacheCreationForensics.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const RealDate = Date
class FrozenDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])) }
  static now() { return NOW }
}
globalThis.Date = FrozenDate

const H = 3_600_000
// Newest first: s1 … s8, then the requests. The 6h window keeps everything at or after NOW-6h.
const MTIMES = {
  's1.response.json': NOW - 1 * H,
  's2.response.json': NOW - 2 * H,
  's3.response.json': NOW - 3 * H,
  's4.response.json': NOW - 4 * H,
  's5.response.json': NOW - 5 * H,
  's6.response.json': NOW - 6 * H,
  // OUTSIDE a 6h window — the only response the window can exclude.
  's7.response.json': NOW - 30 * H,
  's8.response.json': NOW - 40 * H,
  'q1.request.json': NOW - 1 * H,
  'q2.request.json': NOW - 2 * H,
  'q3.request.json': NOW - 5 * H,
  'q4.request.json': NOW - 6 * H,
  // Outside the window too, so the request index shrinks with it.
  'q5.request.json': NOW - 50 * H,
  'notes.txt': NOW - 1 * H,
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

const MISSING = dir + 'no-such-forensics-dir'
// Every absolute path is REDACTED before it reaches the fixture. `coverage.bodiesDir` and the
// missing-dir note both embed the caller's path, which on a real machine is a home directory — a
// committed fixture carrying one both fails `pnpm run check-identities` and pins this machine's
// layout into a test every contributor has to run.
const strip = (o) =>
  JSON.parse(JSON.stringify(o).split(bodies).join('<BODIES>').split(MISSING).join('<MISSING>'))
const run = async (opts) => strip(await scanCacheCreationEvents({ bodiesDir: bodies, ...opts }))

const responses = listBySuffix(bodies, '.response.json')
const requests = listBySuffix(bodies, '.request.json')
const rel = (es) => es.map(e => ({ name: e.name, mtimeMs: e.mtimeMs }))

writeFileSync(dir + 'ccforensics-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  caps: { RESPONSE_SCAN_CAP, REQUEST_INDEX_CAP },

  // The metadata-only first pass, and the decoy it must ignore.
  listResponses: rel(responses),
  listRequests: rel(requests),
  listMissingDir: listBySuffix(MISSING, '.response.json'),

  // boundedRecent in isolation: newest-first, window-filtered, capped — and `matched` counted
  // BEFORE the cap so a sample can be reported honestly.
  boundedAll: { ...boundedRecent(responses, { cap: 100 }), slice: rel(boundedRecent(responses, { cap: 100 }).slice) },
  boundedCapped: { ...boundedRecent(responses, { cap: 3 }), slice: rel(boundedRecent(responses, { cap: 3 }).slice) },
  boundedWindowed: { ...boundedRecent(responses, { windowHours: 6, cap: 100 }), slice: rel(boundedRecent(responses, { windowHours: 6, cap: 100 }).slice) },
  // A ZERO window is NO window, not an empty one.
  boundedZeroWindow: { ...boundedRecent(responses, { windowHours: 0, cap: 100 }), slice: rel(boundedRecent(responses, { windowHours: 0, cap: 100 }).slice) },

  // readJsonBounded: the size guard and the parse guard are the same `null`.
  readOk: readJsonBounded(bodies + '/s2.response.json', 1_000_000),
  readTooBig: readJsonBounded(bodies + '/s2.response.json', 10),
  readMalformed: readJsonBounded(bodies + '/s7.response.json', 1_000_000),
  readMissing: readJsonBounded(bodies + '/does-not-exist.json', 1_000_000),

  scanDefault: await run({}),
  scanWithZeros: await run({ includeZeroCacheCreate: true }),
  scanWindowed: await run({ windowHours: 6 }),
  // A cap below the matched count ⇒ complete:false and the SAMPLE note.
  scanCapped: await run({ scanCap: 2 }),
  scanCappedWithZeros: await run({ scanCap: 2, includeZeroCacheCreate: true }),
  // A missing dir is its own branch: complete:true (there was nothing to sample) and a note that
  // names the env var to set.
  scanMissingDir: strip(await scanCacheCreationEvents({ bodiesDir: MISSING })),
}, null, 2) + '\n')
console.log('wrote ccforensics-expected.json')
