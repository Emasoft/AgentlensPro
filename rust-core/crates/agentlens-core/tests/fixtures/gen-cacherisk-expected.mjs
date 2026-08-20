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
