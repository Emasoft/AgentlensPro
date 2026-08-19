// Regenerates loop-expected.json from the COMPILED TS detector (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-loop-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { detectLoopSignals } = require('../../../../../out/test/loopDetector.js')
const dir = new URL('.', import.meta.url).pathname
const cards = JSON.parse(readFileSync(dir + 'loop-cards.json', 'utf8'))
const expected = cards.map(c => detectLoopSignals(c))
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'loop-expected.json', JSON.stringify(expected, null, 1) + '\n')
console.log('wrote signal lists for', cards.length, 'cards')
