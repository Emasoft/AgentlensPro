// Regenerates evidence-expected.json — and the REAL Parquet store + spool it reads — from the
// COMPILED src/store/bodiesEvidence.ts. The parity oracle for bodies_evidence (TRDD-DMWOBWFH
// P4x.2h), the unported prerequisite cacheBreakTimeline was blocked on.
//
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-store/tests/fixtures/gen-evidence-expected.mjs
//
// THIS ONE IS DIFFERENT FROM EVERY OTHER ORACLE HERE: the fixture is a real on-disk Parquet store
// written by the TYPESCRIPT store, and the Rust test reads THAT. So it does not merely check that
// two implementations agree on logic — it checks the on-disk compatibility boundary the store's
// module doc claims ("a store written by either engine is readable by the other"). A Rust-written
// store would make the test pass while proving nothing about that claim.
//
// The scenario is the measured incident (owner directive 2026-08-13): the break timeline's evidence
// was the raw spool ONLY, so the ingest drain — working correctly — silently shrank the tool's
// history between two runs (a break classified at 01:08Z ceased to exist by the next invocation).
//
// What the fixture pins:
//  - aaa: ingested AND FLUSHED, then its spool file DELETED by the drain. It must still be evidence,
//    from the store, and must still reconstruct — the vanished-turn regression.
//  - bbb/ccc: in BOTH spool and store. Each must yield exactly ONE row (the store one), or a caller
//    double-counts a turn mid-drain.
//  - ddd: spool ONLY (captured after the last flush) — bodyId/sessionId/tsMs all null, because the
//    spool name is an opaque uuid and reading it to learn its session is the cost this module exists
//    to remove.
//  - A session filter pushes down to Parquet and therefore CANNOT match ddd. The null rows must
//    survive the filter anyway; dropping them would silently lose the newest evidence.
//  - loadBodyTexts must return byte-identical text for all four, proving reconstruction against the
//    stored sha256 (the body_id IS that sha, so the proof is end-to-end).
//  - chunk=1 must give the same answer as the default — the chunking is a memory bound, not a
//    semantic one.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '../../../../..')
// `out/test/**` (tsconfig.test.json), not `out/**`: the main build does not emit the store modules.
const { flush, openStore } = await import(path.join(OUT, 'out/test/store/db.js'))
const { ingestBody } = await import(path.join(OUT, 'out/test/store/bodyStore.js'))
const { listBodyEvidence, loadBodyTexts } = await import(path.join(OUT, 'out/test/store/bodiesEvidence.js'))

const STORE = path.join(HERE, 'evidence-store')
const SPOOL = path.join(HERE, 'evidence-spool')
for (const d of [STORE, SPOOL]) {
  fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(d, { recursive: true })
}

// The REAL Claude Code shape: the session id is buried in metadata.user_id as an EMBEDDED JSON
// string (bodyStore.extractMeta documents that reading any other field mis-attributes every body).
const rawFor = (session, marker) =>
  JSON.stringify({
    model: 'claude-opus-5',
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', session_id: session }) },
    messages: [{ role: 'user', content: [{ type: 'text', text: `body ${marker} `.repeat(50) }] }],
  })

const T0 = Date.UTC(2026, 7, 13, 1, 0, 0) // fixed clock — deterministic
const NAMES = ['aaa.request.json', 'bbb.request.json', 'ccc.response.json']
const RAWS = [rawFor('sess-A', 'one'), rawFor('sess-A', 'two'), rawFor('sess-B', 'three')]

const store = await openStore({ dir: STORE, memoryLimit: '2GB', threads: 2 })
for (let i = 0; i < NAMES.length; i++) {
  fs.writeFileSync(path.join(SPOOL, NAMES[i]), RAWS[i])
  await ingestBody(store, NAMES[i], RAWS[i], T0 + i * 3_600_000)
}
await flush(store)
// THE DRAIN: the first body's raw file is deleted — exactly what ingestPass does once the store
// provably holds it. Any evidence reader still depending on this file has the measured bug.
fs.rmSync(path.join(SPOOL, NAMES[0]))
// And one body that ONLY the spool knows (captured after the last flush).
const DDD = rawFor('sess-C', 'four')
fs.writeFileSync(path.join(SPOOL, 'ddd.request.json'), DDD)
try { store.con.closeSync() } catch { /* already closed */ }

// Row ORDER is not part of the contract (store rows follow the parquet scan, spool rows the
// readdir), so both engines sort before comparing. Sorting here too keeps the fixture stable.
const norm = (rows) => [...rows].sort((a, b) => (a.srcName < b.srcName ? -1 : a.srcName > b.srcName ? 1 : 0))

const T1 = T0 + 3_600_000
const cases = {
  all: norm(await listBodyEvidence(STORE, SPOOL)),
  storeOnly: norm(await listBodyEvidence(STORE, null)),
  bySessionA: norm(await listBodyEvidence(STORE, SPOOL, { sessionId: 'sess-A' })),
  byKindResponse: norm(await listBodyEvidence(STORE, SPOOL, { kind: 'response' })),
  byTsFrom: norm(await listBodyEvidence(STORE, SPOOL, { tsFromMs: T1 })),
  byTsRange: norm(await listBodyEvidence(STORE, SPOOL, { tsFromMs: T0, tsToMs: T1 })),
}

const asObj = (m) => Object.fromEntries([...m.entries()].sort())
const loaded = asObj(await loadBodyTexts(STORE, SPOOL, norm(await listBodyEvidence(STORE, SPOOL))))
const loadedChunk1 = asObj(await loadBodyTexts(STORE, SPOOL, norm(await listBodyEvidence(STORE, SPOOL)), 1))

const out = { t0: T0, t1: T1, cases, loaded, loadedChunk1, raws: { ...Object.fromEntries(NAMES.map((n, i) => [n, RAWS[i]])), 'ddd.request.json': DDD } }
fs.writeFileSync(path.join(HERE, 'evidence-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote evidence-expected.json')
for (const [k, v] of Object.entries(cases)) console.log(` ${k}: ${v.map((r) => `${r.srcName}@${r.location}`).join(' ')}`)
console.log(' loaded:', Object.keys(loaded).join(' '))
console.log(' chunk1 identical:', JSON.stringify(loaded) === JSON.stringify(loadedChunk1))
