// Regenerates keepwarm-expected.json from the COMPILED TS modules (the parity oracle):
// shared/cacheTtl.ts (classifyTtlRegime + sessionTtlKindOf) and shared/keepWarm.ts
// (computeKeepWarm). Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-keepwarm-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const { classifyTtlRegime, sessionTtlKindOf } = require('../../../../../out/test/shared/cacheTtl.js')
const { computeKeepWarm } = require('../../../../../out/test/shared/keepWarm.js')
const dir = new URL('.', import.meta.url).pathname
const { cards, cases } = JSON.parse(readFileSync(dir + 'keepwarm-cases.json', 'utf8'))
const expected = {
  kinds: cards.map(c => sessionTtlKindOf(c)),
  cases: cases.map(c => {
    const regime = classifyTtlRegime(c.kind, c.ctx)
    const report = computeKeepWarm(c.timeline, regime)
    // JSON round-trip drops undefined-valued fields exactly as the wire does.
    return JSON.parse(JSON.stringify({ name: c.name, regime, report: report ?? null }))
  }),
}
writeFileSync(dir + 'keepwarm-expected.json', JSON.stringify(expected, null, 1) + '\n')
console.log('wrote', expected.cases.length, 'case(s) +', expected.kinds.length, 'kind(s)')
