// Regenerates rawbodyctx-expected.json from the COMPILED TS rawBodyContext.js — the parity oracle
// for raw_body_context.rs (buildCallContextFromJson + parseUserId). Pure functions over inline
// bodies, no fixtures on disk.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-rawbodyctx-expected.mjs
//
// The cases are DISCRIMINATORS, not coverage — each one fails loudly for a specific porting
// mistake, and the comment on each says which:
//  - `??` vs `||`      — an EMPTY-STRING tool name survives `??` but not `||`
//  - nullish vs absent — `input: null` must stringify as `{}`, not as "null"
//  - UTF-16 vs bytes   — the 20k cap counts CODE UNITS, so a 2-byte char halves the byte count
//  - count-then-cap    — `tokens` reflects the FULL text, `bytes` only the capped text
//  - key ORDER + key OMISSION — an undefined value is dropped by JSON.stringify, never nulled
//  - regex /m          — `^#\s*CLAUDE\.md` must match at a LINE start, not only at string start
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { buildCallContextFromJson, parseUserId } = require('../../../../../out/test/rawBodyContext.js')
const dir = new URL('.', import.meta.url).pathname

// metadata.user_id is a JSON *string blob*, not a bare id — every malformed shape must fail soft
// to all-undefined rather than throwing or leaking the blob into sessionId.
const userIdCases = [
  JSON.stringify({ session_id: 'sess-1', account_uuid: 'acct-1', device_id: 'dev-1' }),
  JSON.stringify({ session_id: 'only-session' }),
  JSON.stringify({ session_id: 42, account_uuid: null }),   // non-string fields → undefined
  '{"broken": ',                                            // unparseable → {}
  '',                                                       // empty → {} (length-0 guard)
  'plain-not-json',
  JSON.stringify([1, 2, 3]),                                // parses, but has no fields
  null,
  123,
]

const LONG = 'é'.repeat(20050)   // 20050 UTF-16 units, 40100 UTF-8 bytes — over the 20000 cap
const bodyCases = [
  // null / non-object → null return
  { body: null, uncap: false },
  { body: 'a string', uncap: false },
  { body: {}, uncap: false },                               // object with nothing → empty blocks
  // --- system: string / array / empty / classification ---
  { body: { system: 'plain system prompt' }, uncap: false },
  { body: { system: '' }, uncap: false },                   // falsy → NO block at all
  { body: { system: 'Contents of /x/CLAUDE.md follow' }, uncap: false },
  { body: { system: 'intro line\n# CLAUDE.md' }, uncap: false },       // needs the /m flag
  { body: { system: '# CLAUDE.md at the very start' }, uncap: false },
  { body: { system: 'Contents of /Users/x/.claude/rules/foo.md' }, uncap: false },
  { body: { system: 'Contents of C:\\Users\\x\\.claude\\rules\\foo.md' }, uncap: false },
  { body: { system: [{ text: 'a' }, { text: '' }, { text: 'c' }, {}] }, uncap: false }, // empty+missing skipped, index still from forEach
  { body: { system: [{ text: 'Contents of /x/CLAUDE.md' }] }, uncap: false },
  // --- tool catalog ---
  { body: { tools: [] }, uncap: false },                    // empty array → NO block
  { body: { tools: [{ name: 'Bash', description: 'run a command' }] }, uncap: false },
  { body: { tools: [{ description: 'no name' }, { name: '', description: 'empty name' }] }, uncap: false }, // `??` keeps '', missing → '?'
  { body: { tools: [{ name: 'X', description: 'é'.repeat(300) }] }, uncap: false },  // .slice(0,200) on UTF-16 units
  { body: { tools: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }, uncap: false },  // count in the label
  // --- messages: string content per role ---
  { body: { messages: [{ role: 'user', content: 'hi' }] }, uncap: false },
  { body: { messages: [{ role: 'assistant', content: 'yo' }] }, uncap: false },      // role 'output'
  { body: { messages: [{ role: 'system', content: 'reminder text' }] }, uncap: false },
  { body: { messages: [{ content: 'no role' }] }, uncap: false },
  { body: { messages: [{ role: 'user' }, { role: 'user', content: 42 }] }, uncap: false }, // non-array non-string → skipped
  // --- messages: block content ---
  { body: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'hmm' }] }] }, uncap: false },
  { body: { messages: [{ role: 'user', content: [{ type: 'text' }] }] }, uncap: false },   // missing text → ''
  // tool_use kinds: mcp / Bash / ordinary / unnamed, and the input nullish rule
  { body: { messages: [{ role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_use', id: 't2', name: 'mcp__srv__tool', input: { a: 1 } },
    { type: 'tool_use', id: 't3', name: 'Read', input: null },        // nullish → '{}' NOT 'null'
    { type: 'tool_use', name: 'NoId' },                               // input absent → '{}'
    { type: 'tool_use', id: 't5', input: { x: 1 } },                  // no name → label 'tool_use', toolName OMITTED
  ] }] }, uncap: false },
  // tool_result inherits the name from the matching tool_use earlier in the SAME body
  { body: { messages: [{ role: 'assistant', content: [
    { type: 'tool_use', id: 'u1', name: 'Bash', input: {} },
    { type: 'tool_use', id: 'u2', name: 'mcp__s__t', input: {} },
  ] }, { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'u1', content: 'stdout here' },        // → bashOutput
    { type: 'tool_result', tool_use_id: 'u2', content: [{ type: 'text', text: 'x' }, { type: 'image' }, { type: 'other', v: 1 }, 'raw'] },
    { type: 'tool_result', tool_use_id: 'unknown-id', content: 'orphan' },     // unmatched → toolOutput, no toolName
    { type: 'tool_result', content: null },                                    // no id, null content → ''
    { type: 'tool_result', tool_use_id: 'u1', content: { obj: true } },        // non-array non-string → JSON.stringify
  ] }] }, uncap: false },
  // images: token weight from base64 LENGTH, never the bytes themselves; no toolName key
  { body: { messages: [{ role: 'user', content: [
    { type: 'image', source: { media_type: 'image/png', data: 'QUJD'.repeat(10) } },
    { type: 'image', source: { data: 'AAAA' } },        // media_type absent → 'unknown'
    { type: 'image', source: {} },                      // no data → b64len 0 → '[image]'
    { type: 'image' },                                  // no source at all
  ] }] }, uncap: false },
  // unknown block types fall to 'other' with the type as the label
  { body: { messages: [{ role: 'user', content: [{ type: 'weird', a: 1 }, { nope: true }, 'a bare string'] }] }, uncap: false },
  // --- truncation: cap is UTF-16 units, tokens counted BEFORE the cap, bytes AFTER it ---
  { body: { messages: [{ role: 'user', content: LONG }] }, uncap: false },
  { body: { messages: [{ role: 'user', content: LONG }] }, uncap: true },   // uncap → whole text, truncated:false
  // --- top-level fields: order, omission, betas filtering ---
  { body: { model: 'claude-fable-5', messages: [] }, uncap: false },
  { body: { betas: ['a', 1, 'b', null], model: 'm' }, uncap: false },       // strings only
  { body: { betas: 'not-an-array' }, uncap: false },                       // → key OMITTED
  { body: { betas: [] }, uncap: false },                                   // empty array is KEPT
  { body: { metadata: { user_id: JSON.stringify({ session_id: 's9', account_uuid: 'a9', device_id: 'd9' }) } }, uncap: false },
  { body: { metadata: { user_id: 'garbage' } }, uncap: false },            // sessionId '' , accountUuid omitted
  { body: { metadata: {} }, uncap: false },
  // full-shape ordering check: every optional key present at once
  { body: {
    model: 'claude-opus-5',
    betas: ['beta-1'],
    metadata: { user_id: JSON.stringify({ session_id: 'S', account_uuid: 'A', device_id: 'D' }) },
    system: [{ text: 'sys' }],
    tools: [{ name: 'T', description: 'd' }],
    messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }],
  }, uncap: false },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'rawbodyctx-expected.json'), JSON.stringify({
  userIdCases: J(userIdCases),
  userIds: userIdCases.map(c => J(parseUserId(c))),
  bodyCases: J(bodyCases),
  contexts: bodyCases.map(c => J(buildCallContextFromJson(c.body, { uncap: c.uncap }))),
}, null, 1))
console.log(`rawbodyctx-expected.json: ${userIdCases.length} user_id + ${bodyCases.length} body cases`)
