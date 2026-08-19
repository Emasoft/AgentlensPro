// Regenerates burnmonitor-expected.json from the COMPILED TS burn monitor (the parity oracle).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-burnmonitor-expected.mjs
import { createRequire } from 'module'
import { readFileSync, writeFileSync } from 'fs'
const require = createRequire(import.meta.url)
const {
  loadBurnConfig, gatherConsumptionEvents, computeBurnStatus, computeSessionStatus,
  observeCapacityFromPrematureEnd,
} = require('../../../../../out/test/burnMonitor.js')
const dir = new URL('.', import.meta.url).pathname
const cases = JSON.parse(readFileSync(dir + 'burnmonitor-cases.json', 'utf8'))

// '@fixture:<name>' → the absolute path of a file in this fixtures dir (the Rust test resolves
// the same magic against CARGO_MANIFEST_DIR/tests/fixtures).
const resolveEnv = env =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.startsWith('@fixture:') ? dir + v.slice('@fixture:'.length) : v]))

const { now, ttlCtx, sessions, statusline } = cases
const events = gatherConsumptionEvents(sessions, statusline, now)
const statusConfig = loadBurnConfig(resolveEnv(cases.statusEnv), '/nonexistent-home')
const observedConfig = loadBurnConfig(resolveEnv(cases.observedEnv), '/nonexistent-home')
const expected = {
  configs: cases.envCases.map(c => ({ name: c.name, config: loadBurnConfig(resolveEnv(c.env), '/nonexistent-home') })),
  events,
  status: computeBurnStatus(events, sessions, statusConfig, now, ttlCtx),
  observedStatus: computeBurnStatus(events, sessions, observedConfig, now, ttlCtx),
  sessionStatuses: cases.selectors.map(sel => computeSessionStatus(sessions, events, statusConfig, sel, now, ttlCtx)),
  prematureEnd: observeCapacityFromPrematureEnd(
    events, cases.prematureEnd.accountUuid, cases.prematureEnd.windowStartMs, cases.prematureEnd.windowEndMs),
}
// JSON round-trip drops undefined-valued fields exactly as the wire does.
writeFileSync(dir + 'burnmonitor-expected.json', JSON.stringify(JSON.parse(JSON.stringify(expected)), null, 1) + '\n')
console.log('wrote', expected.configs.length, 'config case(s),', events.length, 'event(s),', expected.sessionStatuses.length, 'session status(es)')
