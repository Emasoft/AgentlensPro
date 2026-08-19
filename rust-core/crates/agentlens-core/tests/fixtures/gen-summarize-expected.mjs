// Regenerates summarize-expected.json from the COMPILED TS summarizeSpans (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-summarize-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { summarizeSpans } = require('../../../../../out/test/spanSummarizer.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'summarize-spans.json', 'utf8'))
// Both shapes pinned: the empty-input literal and the full cross-source pass.
const expected = { empty: summarizeSpans([]), full: summarizeSpans(spans) }
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'summarize-expected.json', JSON.stringify(expected, null, 1) + '\n')
console.log('wrote empty + full expectations,', expected.full.sessions.length, 'sessions')
