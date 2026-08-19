// Regenerates copilot-expected.json from the COMPILED TS builder (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-copilot-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { buildCopilotSessions } = require('../../../../../out/test/summarizers/copilot.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'copilot-spans.json', 'utf8'))
// Mirror spanSummarizer.ts grouping: childrenOf by parentSpanId, invoke_agent roots in order.
const childrenOf = {}
const invokeAgentSpans = []
for (const s of spans) {
  if (s.name.startsWith('invoke_agent')) invokeAgentSpans.push(s)
  if (s.parentSpanId) (childrenOf[s.parentSpanId] ??= []).push(s)
}
const cards = buildCopilotSessions(invokeAgentSpans, childrenOf)
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'copilot-expected.json', JSON.stringify(cards, null, 1) + '\n')
console.log('wrote', cards.length, 'cards')
