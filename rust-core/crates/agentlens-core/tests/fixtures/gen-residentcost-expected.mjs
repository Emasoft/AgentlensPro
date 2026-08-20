// Regenerates residentcost-expected.json from the COMPILED TS — the parity oracle for
// resident_cost.rs / buildResidentCostReport (TRDD-W0RRL2FZ).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-residentcost-expected.mjs
//
// What the fixtures are built to discriminate:
//  - Two compaction boundaries (postCompact blocks at turns 3 and 5) so residencyEnd must scan
//    FORWARD through compactionTurns rather than just using the first or the last one.
//  - `system:core` occurs on every turn, straddling both compactions — its residentCost is the sum
//    over FIVE separate occurrences, each with its OWN turns-resident multiplier.
//  - Three blocks tie at residentCost=100 and two tie at 80 — the ranked list must keep first-seen
//    (insertion) order within a tie, matching V8's guaranteed-stable Array.sort.
//  - turn 3 carries no `usage` at all — stepsWithUsage must not count it, and totalContextTokens
//    must skip it silently (not treat missing usage as zero-cost inclusion vs exclusion — those are
//    different: an included zero would still increment stepsWithUsage).
//  - Sum here makes unattributedTokens NEGATIVE — the signed, never-clamped remainder branch.
//  - A second history has NO step with usage at all ⇒ totalContextTokens===0 ⇒ the OTHER note text.
//  - A third, empty history (no steps) ⇒ lastTurn=0, blocks=[], no reconciliation to speak of.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const { buildResidentCostReport, kindRemediation } = require('../../../../../out/test/shared/residentCost.js')

const block = (id, kind, label, tokens) => ({ id, kind, label, tokens })

const MAIN = {
  sessionId: 'sess-main',
  estimated: true,
  truncated: false,
  steps: [
    { turn: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      blocks: [block('system:core', 'system', 'core', 100), block('userMsg:a', 'userMsg', 'a', 50)] },
    { turn: 2, usage: { input: 12, output: 6, cacheRead: 100, cacheCreate: 0 },
      blocks: [block('system:core', 'system', 'core', 100), block('toolOutput:ls', 'toolOutput', 'ls', 80)] },
    { turn: 3,
      blocks: [block('system:core', 'system', 'core', 100), block('postCompact:sum1', 'postCompact', 'sum1', 40)] },
    { turn: 4, usage: { input: 9, output: 4, cacheRead: 100, cacheCreate: 40 },
      blocks: [block('system:core', 'system', 'core', 100), block('reasoning:think', 'reasoning', 'think', 100)] },
    { turn: 5, usage: { input: 11, output: 7, cacheRead: 100, cacheCreate: 0 },
      blocks: [block('system:core', 'system', 'core', 100), block('postCompact:sum2', 'postCompact', 'sum2', 100)] },
  ],
}

const NO_USAGE = {
  sessionId: 'sess-nousage',
  estimated: true,
  truncated: true,
  steps: [
    { turn: 1, blocks: [block('system:core', 'system', 'core', 200)] },
    { turn: 2, blocks: [block('userMsg:hi', 'userMsg', 'hi', 30)] },
  ],
}

const EMPTY = { sessionId: 'sess-empty', estimated: true, truncated: false, steps: [] }

const ALL_KINDS = [
  'postCompact', 'toolOutput', 'bashOutput', 'subagentOutput', 'file', 'hook', 'cron', 'harness',
  'reminder', 'userMsg', 'assistantMsg', 'reasoning', 'toolInput', 'bashInput', 'toolCatalog',
  'skillCatalog', 'agentCatalog', 'mcp', 'skillPrompt', 'agentPrompt', 'system', 'claudemd', 'rule',
  'other',
]

writeFileSync(dir + 'residentcost-expected.json', JSON.stringify({
  main: buildResidentCostReport(MAIN),
  noUsage: buildResidentCostReport(NO_USAGE),
  empty: buildResidentCostReport(EMPTY),
  remediations: Object.fromEntries(ALL_KINDS.map(k => [k, kindRemediation(k)])),
}, null, 2) + '\n')
console.log('wrote residentcost-expected.json')
