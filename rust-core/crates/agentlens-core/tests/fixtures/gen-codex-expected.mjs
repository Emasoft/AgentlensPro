// Regenerates codex-expected.json from the COMPILED TS builder (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-codex-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { buildCodexSessions } = require('../../../../../out/test/summarizers/codex.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'codex-spans.json', 'utf8'))
// buildCodexSessions takes the whole span list — grouping is its own job.
const cards = buildCodexSessions(spans)
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'codex-expected.json', JSON.stringify(cards, null, 1) + '\n')
console.log('wrote', cards.length, 'cards')
