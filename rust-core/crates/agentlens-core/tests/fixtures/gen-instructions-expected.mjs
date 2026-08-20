// Regenerates instructions-expected.json + the instructions-tree workspace fixtures from the
// COMPILED TS instructionAdvisor.js + instructionFiles.js (the parity oracle for
// instruction_advisor.rs / instruction_files.rs). ONE committed session-card list drives both
// engines; every suggestion — evidence strings included — must Value-equal. filePath values in
// the detect expectations are stored RELATIVE to the fixture root (an absolute path would be a
// machine identity in a committed file); the Rust test reconstructs them.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-instructions-expected.mjs
import { createRequire } from 'module'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { generateSuggestions } = require('../../../../../out/test/instructionAdvisor.js')
const { detectInstructionFiles, readAllInstructionContent } = require('../../../../../out/test/instructionFiles.js')
const dir = new URL('.', import.meta.url).pathname
const root = join(dir, 'instructions-tree')

// ── Workspace fixtures for detectInstructionFiles ──────────────────────────────────────────
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'ws1/.github'), { recursive: true })
writeFileSync(join(root, 'ws1/CLAUDE.md'), '# ws1 claude notes\nHistoric notes: main.rs is deprecated.\n')
writeFileSync(join(root, 'ws1/.github/copilot-instructions.md'), 'copilot ws1 rules\n')
mkdirSync(join(root, 'ws2/.claude'), { recursive: true })
writeFileSync(join(root, 'ws2/.claude/CLAUDE.md'), 'alternate-location claude file\n')

const J = (v) => JSON.parse(JSON.stringify(v))
const relativize = (ws) => (f) => ({ ...f, filePath: f.filePath.slice(join(root, ws).length + 1) })
const detect = {
  ws1: J(detectInstructionFiles(join(root, 'ws1'))).map(relativize('ws1')),
  ws2: J(detectInstructionFiles(join(root, 'ws2'))).map(relativize('ws2')),
  ws1AllContent: readAllInstructionContent(join(root, 'ws1')),
}

// ── The session-card sets driving generateSuggestions ──────────────────────────────────────
// Ten cards built to trip EVERY generator: hot files (60% high + 50% medium + the
// existing-mention skip + the short-name skip + the index.ts skip), loop signals (50% high,
// 30% medium, an unknown type, an under-threshold type), front-loaded discovery (3
// candidates), scope (3 expensive open-ended sessions vs 7 cheap ones), tool discipline
// (8 of 10 bash-heavy).
const card = (i, over = {}) => ({
  sessionId: `s${String(i).padStart(2, '0')}`,
  model: 'claude-opus-5',
  inputTokens: 1000, cacheReadTokens: 0, cacheCreateTokens: 0, outputTokens: 1000,
  filesRead: [], filesChanged: [], loopSignals: [], userRequest: 'add feature X',
  toolCounts: { Bash: 10, Read: 2 },
  ...over,
})
const SCHEMA = 'src/db/schema.ts'
const DB = 'src/db/db.ts'
const rich = [
  card(1, { filesRead: [SCHEMA, DB, 'src/util/index.ts', 'src/legacy/main.rs', 'src/y/a.b'], loopSignals: [{ type: 'error_recurrence' }, { type: 'exact_tool_repeat' }, { type: 'mystery_signal' }, { type: 'edit_revert_cycle' }], userRequest: 'please refactor the db layer', outputTokens: 200000 }),
  card(2, { filesRead: [SCHEMA, DB, 'src/util/index.ts', 'src/legacy/main.rs', 'src/y/a.b'], loopSignals: [{ type: 'error_recurrence' }, { type: 'exact_tool_repeat' }, { type: 'mystery_signal' }], userRequest: 'refactor everything please', outputTokens: 200000 }),
  card(3, { filesRead: [SCHEMA, DB, 'src/util/index.ts', 'src/legacy/main.rs', 'src/y/a.b'], loopSignals: [{ type: 'error_recurrence' }, { type: 'exact_tool_repeat' }, { type: 'mystery_signal' }], userRequest: 'clean up the helpers', outputTokens: 200000 }),
  card(4, { filesRead: [SCHEMA, DB, 'src/legacy/main.rs', 'src/y/a.b'], loopSignals: [{ type: 'error_recurrence' }] }),
  card(5, { filesRead: [SCHEMA, DB, 'src/legacy/main.rs', 'src/y/a.b'], loopSignals: [{ type: 'error_recurrence' }] }),
  card(6, { filesRead: [SCHEMA], filesChanged: [SCHEMA] }), // dedup per session: counted once
  card(7, {}),
  card(8, {}),
  card(9, { toolCounts: { Bash: 1, Read: 5 } }),
  card(10, { toolCounts: { Bash: 1, Read: 5 } }),
]
const EXISTING = 'Historic notes: main.rs is deprecated.'
const cases = [
  { name: 'rich set trips every generator', sessions: rich, existing: EXISTING },
  { name: 'under five sessions yields nothing', sessions: rich.slice(0, 4), existing: '' },
  { name: 'five sessions boundary', sessions: rich.slice(0, 5), existing: EXISTING },
  { name: 'existing text absorbs the hot files', sessions: rich, existing: 'schema.ts db.ts main.rs a.b' },
]
const expected = cases.map((c) => J(generateSuggestions(c.sessions, c.existing)))

writeFileSync(join(dir, 'instructions-expected.json'), JSON.stringify({ cases: J(cases), expected, detect }, null, 1))
console.log(`instructions-expected.json: ${cases.length} advisor cases (${expected[0].length} suggestions in the rich set)`)
