// Regenerates claude-expected.json from the COMPILED TS builder (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-claude-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { buildClaudeSessions } = require('../../../../../out/test/summarizers/claude.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'claude-spans.json', 'utf8'))
// Mirror spanSummarizer.ts grouping: interaction roots in order, spansByTraceId over ALL spans.
const claudeInteractionSpans = spans.filter(s => s.name === 'claude_code.interaction')
const spansByTraceId = {}
for (const s of spans) { if (s.traceId) (spansByTraceId[s.traceId] ??= []).push(s) }
const cards = buildClaudeSessions(claudeInteractionSpans, spansByTraceId)
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'claude-expected.json', JSON.stringify(cards, null, 1) + '\n')
console.log('wrote', cards.length, 'cards')
