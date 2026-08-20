// Regenerates callbodyregistry-expected.json from the COMPILED TS CallBodyRegistry (the parity
// oracle for call_body_registry.rs). The class is pure in-memory logic, so ONE scripted op/query
// sequence drives both engines — no fixtures on disk. Small caps (3 sessions × 4 pointers) so
// BOTH eviction paths are exercised, and the resolveRequest fallback chain is walked end to end.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-callbodyregistry-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { CallBodyRegistry } = require('../../../../../out/test/rawBodyContext.js')
const dir = new URL('.', import.meta.url).pathname

const S1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const S3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const S4 = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

// op: [session, kind, bodyRef, ts, spanId, requestId] — bodyRef doubles as the identity we compare.
const ops = [
  [S1, 'request', 'r1a', 1000, 'span-a', null],
  [S1, 'response', 'p1a', 1050, 'span-a', 'req-A'],
  [S1, 'request', 'r1b', 2000, 'span-b', null],
  [S1, 'response', 'p1b', 2050, null, 'req-B'],       // no spanId → the requestId fallback
  [S1, 'request', 'r1c', 3000, null, 'req-C'],        // a request that DOES carry its own id
  [S2, 'request', 'r2a', 1500, 'span-c', null],
  [S3, 'request', 'r3a', 1600, 'span-d', null],
  // Dropped by the guard: no bodyRef and no inlineBody; and an empty session id.
  [S2, 'request', null, 1700, 'span-x', null],
  ['', 'request', 'ghost', 1800, 'span-y', null],
  // S1 again → per-session overflow (cap 4) drops its OLDEST pointer, and S1 moves to MRU.
  [S1, 'request', 'r1d', 4000, 'span-e', null],
  [S1, 'request', 'r1e', 5000, 'span-f', null],
  // A 4th session → map overflow (cap 3) evicts the least-recently-used session.
  [S4, 'request', 'r4a', 6000, 'span-g', null],
]

const reg = new CallBodyRegistry(3, 4)
for (const [session, kind, bodyRef, ts, spanId, requestId] of ops) {
  reg.record(session, {
    kind, ts,
    ...(bodyRef ? { bodyRef } : {}),
    ...(spanId ? { spanId } : {}),
    ...(requestId ? { requestId } : {}),
  })
}

const id = (p) => (p ? (p.bodyRef ?? null) : null)
const queries = [
  // resolveRequest: [session, requestId, spanId]
  ['resolveRequest', S1, 'req-A', null],   // response→request hop via shared spanId
  ['resolveRequest', S1, 'req-B', null],   // response has no spanId → nearest-preceding by ts
  ['resolveRequest', S1, 'req-C', null],   // direct requestId match on a request
  ['resolveRequest', S1, 'req-ZZ', null],  // unknown id → falls through to the latest request
  ['resolveRequest', S1, null, 'span-e'],  // spanId match
  ['resolveRequest', S1, null, 'span-zz'], // unknown span → latest request
  ['resolveRequest', S2, null, null],      // survives? (LRU)
  ['resolveRequest', 'no-such-session', null, null],
  // responseFor: [session, spanId, requestId]
  ['responseFor', S1, 'span-a', null],
  ['responseFor', S1, null, 'req-B'],
  ['responseFor', S1, 'span-zz', null],
  ['responseFor', S1, null, null],
]
const results = queries.map(([q, session, a, b]) =>
  q === 'resolveRequest' ? id(reg.resolveRequest(session, { requestId: a ?? undefined, spanId: b ?? undefined }))
    : id(reg.responseFor(session, { spanId: a ?? undefined, requestId: b ?? undefined })))

const J = (v) => JSON.parse(JSON.stringify(v))
writeFileSync(join(dir, 'callbodyregistry-expected.json'), JSON.stringify({
  ops: J(ops), queries: J(queries), results: J(results),
  sessionIds: reg.sessionIds(),
  requestPointers: Object.fromEntries([S1, S2, S3, S4].map(s => [s, reg.requestPointers(s).map(id)])),
}, null, 1))
console.log(`callbodyregistry-expected.json: sessions=${JSON.stringify(reg.sessionIds().map(s => s.slice(0, 8)))} results=${JSON.stringify(results)}`)
