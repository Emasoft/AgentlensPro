// Regenerates cacherisk-expected.json + the cacherisk-tree transcript fixture from the
// COMPILED TS cacheRiskCommands.js (the parity oracle for cache_risk_commands.rs). The fixture
// exercises the whole extraction gauntlet: the caveat-prefixed block, bare-vs-arg menu
// commands, the /plugin verb strip, quoted <command-name> inside an assistant entry (skipped),
// array content (skipped), a bad timestamp (skipped), an unknown command (skipped), plus the
// kinds filter and the limit slice.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cacherisk-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { scanCacheRiskCommands, classifySlashCommand, parseCommandBlock } = require('../../../../../out/test/cacheRiskCommands.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'cacherisk-tree')

rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'slug-a'), { recursive: true })
mkdirSync(join(root, 'slug-b'), { recursive: true })

const NOW = 1787000000000
const iso = (off) => new Date(NOW - off).toISOString()
const user = (off, text, sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') =>
  JSON.stringify({ type: 'user', sessionId: sid, timestamp: iso(off), message: { role: 'user', content: text } })
const cmd = (name, args) => `<command-name>${name}</command-name>${args !== undefined ? `<command-args>${args}</command-args>` : ''}`

writeFileSync(join(root, 'slug-a/one.jsonl'), [
  user(10_000, cmd('/reload-plugins', '')),
  user(20_000, `  <local-command-caveat>Caveat: the messages below were generated
during a local command.</local-command-caveat>  ${cmd('/model', 'opus')}`),
  user(30_000, cmd('/model')),
  user(40_000, cmd('/plugin', 'plugin update foo')),
  user(50_000, cmd('/plugin', 'browse around')), // non-mutating verb → dropped entirely
  user(60_000, cmd('/plugin')),                  // bare menu → ambiguous
  user(70_000, cmd('/help', 'x')),               // not cache-risk → dropped
  // Quoted inside an ASSISTANT entry — never a command.
  JSON.stringify({ type: 'assistant', timestamp: iso(75_000), message: { role: 'assistant', content: `explaining ${cmd('/reload-plugins')}` } }),
  // Array content (a tool_result shape) — never a command.
  JSON.stringify({ type: 'user', timestamp: iso(76_000), message: { role: 'user', content: [{ type: 'text', text: cmd('/compact') }] } }),
  // Bad timestamp — dropped.
  JSON.stringify({ type: 'user', sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', timestamp: 'not-a-date', message: { role: 'user', content: cmd('/clear') } }),
  '{corrupt json line with <command-name> inside',
  '',
].join('\n'))
writeFileSync(join(root, 'slug-a/quiet.jsonl'), `${user(5_000, 'no commands here at all')}\n`)
writeFileSync(join(root, 'slug-b/two.jsonl'), [
  user(15_000, cmd('/compact'), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  user(25_000, cmd('/login')),
  user(35_000, cmd('/effort', 'high')),
  user(45_000, cmd('/mcp')),
  // No sessionId — the `session` key must be absent, not null.
  JSON.stringify({ type: 'user', timestamp: iso(55_000), message: { role: 'user', content: cmd('/clear') } }),
  '',
].join('\n'))
// CC-version grading (TRDD-ZQQYRYBO I6): each command carries the `version` that wrote it, and the
// /effort verdict depends on the model of the ASSISTANT record before it. Offsets stay past the
// tsWindow/limit cut so only `all` sees these rows.
mkdirSync(join(root, 'slug-c'), { recursive: true })
const vUser = (off, version, text) =>
  JSON.stringify({ type: 'user', sessionId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', version, timestamp: iso(off), message: { role: 'user', content: text } })
const vAsst = (off, model) =>
  JSON.stringify({ type: 'assistant', version: '2.1.281', timestamp: iso(off), message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] } })
writeFileSync(join(root, 'slug-c/versioned.jsonl'), [
  vAsst(99_000, 'claude-fable-5-1'),
  vUser(98_000, '2.1.281', cmd('/effort', 'high')),        // fixed on Fable 5.1 → ambiguous
  vUser(97_000, '2.1.259', cmd('/effort', 'high')),        // before the fix → certain
  vUser(96_000, '2.1.281', cmd('/login')),                 // thinking kept, account may differ → ambiguous
  vUser(95_000, '2.1.270', cmd('/upgrade')),               // before the fix → certain
  vUser(94_000, '2.1.281', cmd('/upgrade')),               // fixed → dropped
  vUser(93_000, '2.1.273', cmd('/extra-usage')),           // fixed at exactly the boundary → dropped
  vUser(92_000, '2.1.281', cmd('/reload-plugins')),        // deferred tools → ambiguous
  vUser(91_000, '2.1.266', cmd('/plugin', 'install foo')), // before the fix → certain
  vAsst(90_500, 'claude-opus-5'),
  vUser(90_000, '2.1.281', cmd('/effort', 'low')),         // not Fable 5.1 → still certain
  '',
].join('\n'))

const J = (v) => JSON.parse(JSON.stringify(v))
const dirs = [root]
const expected = {
  all: J(scanCacheRiskCommands({ dirs, sinceMs: 0 })),
  kinds: J(scanCacheRiskCommands({ dirs, sinceMs: 0, kinds: ['MODEL_SWITCHED', 'CLEAR'] })),
  limited: J(scanCacheRiskCommands({ dirs, sinceMs: 0, limit: 3 })),
  tsWindow: J(scanCacheRiskCommands({ dirs, sinceMs: NOW - 26_000 })),
  classify: J([
    classifySlashCommand('/Reload-Plugins'), classifySlashCommand('/plugin', 'PLUGINS  Marketplace add x'),
    classifySlashCommand('/model', ''), classifySlashCommand('/effort', 'max'), classifySlashCommand('/quit'),
  ]),
  parse: J([
    parseCommandBlock('<command-name>/x</command-name>'), parseCommandBlock('nope'),
    parseCommandBlock('<command-name></command-name>'), parseCommandBlock('<command-name>/y</command-name><command-args>  </command-args>'),
  ]),
  now: NOW,
}
writeFileSync(join(dir, 'cacherisk-expected.json'), JSON.stringify(expected, null, 1))
console.log(`cacherisk-expected.json: all=${expected.all.length} kinds=${expected.kinds.length} window=${expected.tsWindow.length}`)
