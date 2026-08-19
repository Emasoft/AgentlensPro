// Regenerates the delta-log cross-engine fixture from the COMPILED TS DeltaLog (the oracle for
// the on-disk format): writes records through the TS class — an append, an update, a tombstone,
// a torn trailing line — and commits the resulting `<name>.snapshot.ndjson` + `<name>.delta.ndjson`
// next to the expected replayed map, so the Rust DeltaLog proves it reads what TS writes.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-delta-log-expected.mjs
import { createRequire } from 'module'
import { appendFileSync, mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
const require = createRequire(import.meta.url)
const { DeltaLog, COMPACT_MIN_BYTES } = require('../../../../../out/test/store/deltaLog.js')
const dir = new URL('.', import.meta.url).pathname
const out = join(dir, 'delta-log')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const work = join(tmpdir(), `al-delta-gen-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// 1. `small`: snapshot + delta with an update and a tombstone, then a TORN trailing line.
const log = new DeltaLog(work, 'small')
const recs = new Map([
  ['a', { sessionId: 'a', inputTokens: 10, title: 'só 𝄞 unicode', nested: { x: [1, 2.5, null], y: false } }],
  ['b', { sessionId: 'b', inputTokens: 0.1, startTime: '2026-08-01T10:00:00.000Z' }],
  ['c', { sessionId: 'c', inputTokens: 1e21, big: 9007199254740993 }],
])
log.save(recs)                                   // first save → delta (no snapshot yet)
recs.set('a', { ...recs.get('a'), inputTokens: 11 })
recs.delete('b')
log.save(recs)                                   // update + tombstone appended
appendFileSync(join(work, 'small.delta.ndjson'), '{"k":"torn","v":{"half')   // a crash mid-append
const expectedSmall = Object.fromEntries(new DeltaLog(work, 'small').load())

// 2. `compacted`: enough bytes to cross COMPACT_MIN_BYTES → snapshot written, delta dropped.
const big = new DeltaLog(work, 'compacted')
const bigRecs = new Map()
for (let i = 0; i < 400; i++) bigRecs.set(`s-${i}`, { sessionId: `s-${i}`, pad: 'x'.repeat(1024), n: i })
const r1 = big.save(bigRecs)
if (!r1.compacted) throw new Error(`expected compaction (${r1.bytes} bytes vs ${COMPACT_MIN_BYTES})`)
bigRecs.delete('s-7')
big.save(bigRecs)                                // one tombstone in a fresh delta
const expectedBig = Object.fromEntries(new DeltaLog(work, 'compacted').load())

for (const f of readdirSync(work)) copyFileSync(join(work, f), join(out, f))
writeFileSync(join(dir, 'delta-log-expected.json'), JSON.stringify({ small: expectedSmall, compacted: expectedBig }, null, 1) + '\n')
console.log(`delta-log fixture: ${readdirSync(out).join(', ')}; small=${Object.keys(expectedSmall).length} compacted=${Object.keys(expectedBig).length}`)
