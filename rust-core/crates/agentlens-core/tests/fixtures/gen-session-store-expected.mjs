// Regenerates session-store-expected.json from the COMPILED TS SessionStore (the parity
// oracle), with the clock PINNED so the 5-minute window and timestamps are deterministic.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-session-store-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const FIXED_NOW = 1755610000000
Date.now = () => FIXED_NOW
const { SessionStore } = require('../../../../../out/test/sessionStore.js')
const dir = new URL('.', import.meta.url).pathname
const spans = JSON.parse(readFileSync(dir + 'session-store-spans.json', 'utf8'))
const store = new SessionStore()
for (const s of spans) store.addSpan(structuredClone(s))
const inject = [
  store.injectSpanAttribute('t2', 's2', 'gen_ai.output.messages', '[]'),
  store.injectSpanAttribute('t2', 's2', 'gen_ai.output.messages', '[1]'),
  store.injectSpanAttribute('zz', 'zz', 'k', 'v'),
]
const out = store.export()
// new Date() reads the real clock even with Date.now stubbed — normalize to the pinned value.
out.summary.lastUpdated = new Date(FIXED_NOW)
writeFileSync(dir + 'session-store-expected.json', JSON.stringify({ inject, export: out }, null, 1) + '\n')
console.log('wrote store expectation,', out.spans.length, 'spans retained')
