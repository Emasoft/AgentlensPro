// Regenerates conversation-expected.json (and its transcript) from the COMPILED TS
// conversation.js — the parity oracle for conversation.rs (freeze row 34).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-conversation-expected.mjs
//
// ⚠ This writes a NEW .jsonl under claude-home/, which changes listSessionFileIds — so
// gen-ctxcomposition-expected.mjs MUST be re-run after this one or row 32's oracle goes stale.
//
// Discriminators, and the porting mistake each catches:
//  - usage is credited ONCE per message.id; a streaming chunk repeats the SAME numbers, so
//    crediting per chunk multiplies the whole session's reported cost.
//  - a resume re-appends byte-IDENTICAL blocks → skipped; a same-id chunk with NEW content → kept.
//  - a tool_result pairs back to the ISSUING assistant turn, not the user record it arrived in;
//    an ORPHAN result stays visible on a user turn rather than being dropped.
//  - a user record of PURE tool_results must NOT fabricate an empty user turn (lazy open).
//  - a <synthetic> row with ZERO usage is dropped; one WITH usage is kept.
//  - attachments are QUEUED and flushed into the NEXT turn, ahead of its own content.
//  - `tokens` is truthy-gated: text that tokenizes to 0 stores text and OMITS tokens.
//  - every unrecognised record is COUNTED in otherRecords, never silently dropped.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const dir = new URL('.', import.meta.url).pathname
const home = join(dir, 'claude-home')
const projects = join(home, 'projects', 'proj-a')
mkdirSync(projects, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = home
const { buildConversationFromFile, buildConversation } = require('../../../../../out/test/conversation.js')

const L = (o) => JSON.stringify(o)
const conv = [
  L({ type: 'ai-title', aiTitle: 'first title' }),
  L({ type: 'ai-title', aiTitle: 'final title' }),               // LATEST wins
  L({ type: 'agent-name', agentName: 'the-agent' }),
  L({ type: 'user', uuid: 'u1', cwd: '/repo/here', entrypoint: 'cli', message: { content: 'do the thing' }, timestamp: '2026-08-01T10:00:00Z' }),
  L({ type: 'user', uuid: 'u1', message: { content: 'do the thing' } }),   // resume rewrite → skipped
  L({ type: 'attachment', attachment: { type: 'file', displayPath: '/a/ctx.md', content: 'injected context' } }),
  L({ type: 'attachment', attachment: { type: 'file', displayPath: '/a/empty.md' } }),  // 0 bytes → otherRecords
  // The assistant turn: attachments flush in AHEAD of its own blocks.
  L({ type: 'assistant', timestamp: '2026-08-01T10:00:05Z', isSidechain: true, message: {
    id: 'm1', model: 'claude-opus-5',
    usage: {
      input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 },
    },
    content: [
      { type: 'thinking', thinking: 'considering the options' },
      { type: 'text', text: 'doing it now' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } },
      { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/x.txt' } },
    ],
  } }),
  // A streaming chunk: SAME message.id. Usage must NOT be credited twice; the identical text block
  // is a resume-duplicate and is skipped, while the new one is appended.
  L({ type: 'assistant', message: {
    id: 'm1', model: 'claude-opus-5',
    usage: { input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
    content: [{ type: 'text', text: 'doing it now' }, { type: 'text', text: 'and a continuation' }],
  } }),
  L({ type: 'system', subtype: 'turn_duration', durationMs: 4200 }),
  // Tool results: tu1/tu2 pair BACK to the assistant turn; the orphan opens a user turn.
  L({ type: 'user', uuid: 'u2', message: { content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: 'hi' },
    { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'file body' }] },
    { type: 'tool_result', tool_use_id: 'nope', content: 'orphan output' },
  ] } }),
  // A PURE tool-result record (all paired) must NOT fabricate an empty user turn.
  L({ type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'second result' }] } }),
  L({ type: 'user', uuid: 'u4', message: { content: [{ type: 'text', text: 'follow-up' }, { type: 'image' }] } }),
  L({ type: 'user', uuid: 'u5', isMeta: true, message: { content: 'a harness meta note' } }),
  L({ type: 'user', uuid: 'u6', isCompactSummary: true, summary: 'the compaction summary' }),
  L({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 120000, postTokens: 30000, cumulativeDroppedTokens: 90000 } }),
  L({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: null } }),  // null → 0, IS emitted
  L({ type: 'system', subtype: 'compact_boundary' }),                                        // no metadata → bare
  L({ type: 'system', subtype: 'some_other_thing' }),
  // <synthetic> with ZERO usage → dropped; with usage → kept.
  L({ type: 'assistant', message: { id: 's1', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: 'title noise' }] } }),
  L({ type: 'assistant', message: { id: 's2', model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 1 }, content: [{ type: 'text', text: 'real synthetic work' }] } }),
  // Text that tokenizes to ZERO — stores text, omits the tokens key.
  L({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: '  ' }] } }),
  L({ type: 'mode', mode: 'something' }),          // unknown type → counted
  L({ someField: 1 }),                             // untyped → '(untyped)'
  L({ type: 'queue-operation', op: 'x' }),
]
writeFileSync(join(projects, 'conv-main.jsonl'), conv.join('\n') + '\n')

const fileCases = ['conv-main.jsonl', 'no-such-file.jsonl']
const resolveCases = [
  { sessionId: 'conv-main', parent: undefined },
  { sessionId: 'conv-fork', parent: 'conv-main' },
  { sessionId: 'conv-known-parent', parent: 'no-such' },
  { sessionId: 'conv-orphan', parent: undefined },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'conversation-expected.json'), JSON.stringify({
  fileCases: J(fileCases),
  fromFile: await Promise.all(fileCases.map(f => buildConversationFromFile(join(projects, f), 'conv-main').then(J))),
  resolveCases: J(resolveCases),
  resolved: await Promise.all(resolveCases.map(c => buildConversation(c.sessionId, c.parent).then(J))),
}, null, 1))
console.log(`conversation-expected.json: ${fileCases.length} file + ${resolveCases.length} resolve cases`)
console.log('REMEMBER: re-run gen-ctxcomposition-expected.mjs — a new .jsonl changes listSessionFileIds')
