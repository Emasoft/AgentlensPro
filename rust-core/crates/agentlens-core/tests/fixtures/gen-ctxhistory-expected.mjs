// Regenerates ctxhistory-expected.json (and its transcripts) from the COMPILED TS
// contextHistory.js — the parity oracle for context_history.rs (freeze row 33).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxhistory-expected.mjs
//
// Discriminators, and the porting mistake each catches:
//  - isCompactSummary with an EMPTY summary FALLS THROUGH to the isMeta branch (no `continue`),
//    while a non-empty one stops there. Getting this wrong loses or duplicates the block.
//  - isMeta is NOT a compact summary: a "[name]\n…" fire → kind 'cron' labeled per task, a
//    <local-command-caveat> → 'cron', anything else → 'harness: meta'. The old
//    `isCompactSummary || isMeta` branch mislabeled 300+ cron pings as one 268k postCompact
//    aggregate and made every turn look like a compaction boundary (TRDD-W0RRL2FZ).
//  - tool_result routing: a Task/Agent/Workflow id → subagentOutput, Bash → bashOutput, an
//    UNMATCHED id → toolOutput labeled 'tool'.
//  - calibration is ASYMMETRIC: output calibrates at ANY scale, input only inside [0.5, 2] and
//    against input+cacheCreate (never cacheRead — that is the reused prefix).
//  - a `<synthetic>` model is ignored; a duplicate message.id does NOT open a new step.
//  - the diff's first step reports every block ADDED (no baseline to be unchanged from), and
//    `removed` follows the PREVIOUS step's block order.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const home = join(dir, 'claude-home')
const projects = join(home, 'projects', 'proj-a')
mkdirSync(projects, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = home
const { buildContextHistory } = require('../../../../../out/test/contextHistory.js')

const L = (o) => JSON.stringify(o)
const hist = [
  // ── turn 1: a user message, an attachment, then the assistant with usage ──
  L({ type: 'user', message: { content: 'please do the thing' }, timestamp: '2026-08-01T10:00:00Z' }),
  L({ type: 'user', message: { content: 'context <system-reminder>injected</system-reminder>' } }),
  L({ type: 'attachment', attachment: { type: 'file', displayPath: '/a/read.md', content: 'file body here' } }),
  L({ type: 'assistant', timestamp: '2026-08-01T10:00:05Z', message: {
    id: 'a1', model: 'claude-opus-5',
    usage: { input_tokens: 40, output_tokens: 25, cache_read_input_tokens: 9000, cache_creation_input_tokens: 10 },
    content: [
      { type: 'thinking', thinking: 'let me think about this carefully' },
      { type: 'text', text: 'here is the answer' },
      { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls -la /tmp' } },
      { type: 'tool_use', id: 'tu-task', name: 'Task', input: { prompt: 'go do a thing' } },
      { type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/a/b.txt' } },
    ],
  } }),
  // A DUPLICATE id — must NOT open a new step, and its content merges into turn 1.
  L({ type: 'assistant', message: { id: 'a1', model: '<synthetic>', content: [{ type: 'text', text: 'appended text' }] } }),

  // ── turn 2: the tool results, metas, then the assistant ──
  L({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu-bash', content: 'total 0\ndrwxr-xr-x' },
    { type: 'tool_result', tool_use_id: 'tu-task', content: [{ type: 'text', text: 'subagent said hi' }] },
    { type: 'tool_result', tool_use_id: 'tu-unknown', content: 'orphan result' },
    { type: 'text', text: 'and a follow-up' },
    { type: 'image' },
  ] } }),
  L({ type: 'user', isMeta: true, message: { content: '[nightly-report]\nthe scheduled task fired' } }),
  L({ type: 'user', isMeta: true, message: { content: 'wrapper <local-command-caveat>caveat text</local-command-caveat>' } }),
  L({ type: 'user', isMeta: true, message: { content: 'some other harness meta' } }),
  // isCompactSummary with an EMPTY summary AND isMeta → must fall through to the meta branch.
  L({ type: 'user', isCompactSummary: true, isMeta: true, summary: '', message: { content: 'fallthrough meta text' } }),
  L({ type: 'assistant', timestamp: '2026-08-01T10:01:00Z', message: {
    id: 'a2', model: 'claude-opus-5',
    usage: { input_tokens: 500, output_tokens: 12, cache_read_input_tokens: 20000, cache_creation_input_tokens: 100 },
    content: [{ type: 'text', text: 'here is the answer' }],   // SAME text as turn 1 → NOT "changed"
  } }),

  // ── turn 3: a real compact summary and a bare summary record ──
  L({ type: 'user', isCompactSummary: true, summary: 'this session was compacted here' }),
  L({ type: 'summary', summary: 'a bare summary record' }),
  L({ type: 'assistant', message: { id: 'a3', content: [{ type: 'text', text: 'post-compact reply' }] } }),
]
writeFileSync(join(projects, 'hist-main.jsonl'), hist.join('\n') + '\n')

// A transcript with NO usage anywhere — every block must stay 'estimated'.
writeFileSync(join(projects, 'hist-nousage.jsonl'), [
  L({ type: 'user', message: { content: 'hello' } }),
  L({ type: 'assistant', message: { id: 'n1', content: [{ type: 'text', text: 'hi back' }] } }),
].join('\n') + '\n')

const cases = [
  { sessionId: 'hist-main', parent: undefined },
  { sessionId: 'hist-nousage', parent: undefined },
  { sessionId: 'hist-fork', parent: 'hist-main' },      // reconstruct from parent
  { sessionId: 'hist-known-parent', parent: 'no-such' },// honest EMPTY, still tagged
  { sessionId: 'hist-orphan', parent: undefined },      // → null
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'ctxhistory-expected.json'), JSON.stringify({
  cases: J(cases),
  histories: await Promise.all(cases.map(c => buildContextHistory(c.sessionId, c.parent).then(J))),
}, null, 1))
console.log(`ctxhistory-expected.json: ${cases.length} cases`)
