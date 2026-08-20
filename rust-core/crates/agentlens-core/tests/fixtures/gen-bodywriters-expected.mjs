// Regenerates bodywriters-expected.json from the COMPILED src/bodyWriters.ts — the parity oracle
// for get_body_writers (TRDD-DMWOBWFH P4x.2d).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-bodywriters-expected.mjs
//
// MTIME ORACLE: every recent/active decision reads a file's mtime, and git does not preserve
// mtimes — so the table below is stamped here and PUBLISHED; the Rust test re-stamps from it.
//
// HOME is pinned to a fake root so the rendered table is reproducible and cannot trip
// `pnpm run check-identities`.
//
// The fixture has NO rate ties on purpose: `readdirSync` order is filesystem-dependent (so the
// TS's own tie order is not reproducible across machines) while the Rust port walks the directory
// SORTED. With distinct rates the two agree regardless, and the ranking is still fully exercised.
//
// What this pins:
//  - `active` (wrote within activeMin) and `recent` (within windowMin) are DIFFERENT windows:
//    r3 is recent but NOT active, which is the row that tells a user "this one already stopped".
//  - A request with no session marker lands in the `unattributed` bucket (sessionId null) and, by
//    the TRUTHY `sessionId ? cardBy.get(...)` guard, never inherits a card's workspace.
//  - Responses are aggregated, never attributed — they carry no session metadata at all.
//  - A file that is neither `.request.json` nor `.response.json` is not even counted in
//    `scannedFiles`.
//  - The store merge is an EXACT union: a live file whose name the store already ingested does NOT
//    add to totalBytes. Double-counting it is the failure the subtraction exists to prevent, and
//    `storeOverlap` vs `storeNoOverlap` differ only in that set.
//  - With NO store the note says STORE UNAVAILABLE and the live bytes ARE the total — the branch
//    the Rust route currently takes, since the durable store is not held by the Rust server.
//  - `w.lastWriteMs ?` is TRUTHY, so a lastWriteMs of exactly 0 renders "never".
import { createRequire } from 'module'
import { writeFileSync, utimesSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const bodies = dir + 'bodies-dir'
process.env.HOME = '/h/user'

const { scanLiveBodyWriters, buildBodyWritersReport } = require('../../../../../out/test/bodyWriters.js')

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const MIN = 60_000
const MTIMES = {
  'r1.request.json': NOW - 2 * MIN,    // recent AND active
  'r2.request.json': NOW - 120 * MIN,  // neither
  'r3.request.json': NOW - 20 * MIN,   // recent but NOT active
  'r4.request.json': NOW - 5 * MIN,    // recent AND active, unattributed
  'x1.response.json': NOW - 3 * MIN,
  'x2.response.json': NOW - 200 * MIN,
  'ignore.txt': NOW - MIN,
}
for (const [name, ms] of Object.entries(MTIMES)) utimesSync(bodies + '/' + name, ms / 1000, ms / 1000)

const WINDOW_MS = 30 * MIN
const ACTIVE_MS = 10 * MIN
const live = scanLiveBodyWriters(bodies, NOW, WINDOW_MS)
const missing = scanLiveBodyWriters(dir + 'no-such-bodies-dir', NOW, WINDOW_MS)

const CARDS = [
  { sessionId: 'aaaaaaaa-1111-1111-1111-111111111111', workspace: '/h/user/Code/alpha', source: 'claude_code' },
  { sessionId: 'bbbb2222-3333-3333-3333-333333333333', workspace: '/w/beta', source: 'claude_code' },
]

// Two store shapes that differ ONLY in recentSrcNames, so the union arithmetic is the only thing
// that can explain a totalBytes difference between them.
const STORE_SESSIONS = [
  { sessionId: 'aaaaaaaa-1111-1111-1111-111111111111', files: 40, bytes: 4_000_000, firstMs: NOW - 900 * MIN, lastMs: NOW - 100 * MIN, model: 'claude-opus-4-8' },
  { sessionId: 'cccc3333-4444-4444-4444-444444444444', files: 5, bytes: 250_000, firstMs: NOW - 800 * MIN, lastMs: NOW - 700 * MIN, model: 'claude-sonnet-5' },
]
const storeNoOverlap = { sessions: STORE_SESSIONS, responses: { files: 12, bytes: 900_000 }, recentSrcNames: new Set() }
const storeOverlap = { sessions: STORE_SESSIONS, responses: { files: 12, bytes: 900_000 }, recentSrcNames: new Set(['r1.request.json', 'x1.response.json']) }

// REDACT the absolute fixture path. `LiveBodiesScan.dir` echoes whatever the caller passed, which
// on a real machine is a home path — a committed fixture carrying one fails
// `pnpm run check-identities` (it did, and the first version of this file shipped that way) and
// pins one machine's layout into a test every contributor runs.
const strip = (o) => JSON.parse(JSON.stringify(o).split(dir).join('<FIXTURES>/'))

const run = (o) => strip(buildBodyWritersReport({
  live: o.live ?? live, store: o.store ?? null, cards: o.cards ?? CARDS,
  nowMs: NOW, windowMs: WINDOW_MS, activeMs: ACTIVE_MS, limit: o.limit ?? 20,
}))

const setToArray = (s) => ({ ...s, recentSrcNames: [...s.recentSrcNames] })

writeFileSync(dir + 'bodywriters-expected.json', JSON.stringify({
  nowMs: NOW,
  mtimes: MTIMES,
  windowMs: WINDOW_MS,
  activeMs: ACTIVE_MS,
  cards: CARDS,
  live: strip(live),
  liveMissingDir: strip(missing),
  storeNoOverlap: setToArray(storeNoOverlap),
  storeOverlap: setToArray(storeOverlap),
  // The branch the Rust route takes today: no durable store, so live bytes ARE the total.
  reportNoStore: run({}),
  reportStoreNoOverlap: run({ store: storeNoOverlap }),
  reportStoreOverlap: run({ store: storeOverlap }),
  // limit 1 truncates the table while totalWriters keeps the honest count.
  reportLimitOne: run({ limit: 1 }),
  // A missing bodies dir with no store: available:false, and the table is just the headers.
  reportNoDir: run({ live: missing }),
  // …but a missing dir WITH a store is still available — the history is real even if the dir is gone.
  reportNoDirWithStore: run({ live: missing, store: storeNoOverlap }),
  // No cards at all: every workspace/source is null and the table renders "?".
  reportNoCards: run({ cards: [] }),
}, null, 2) + '\n')
console.log('wrote bodywriters-expected.json')
