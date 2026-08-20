// Regenerates mcptools-expected.json from the COMPILED TS mcpServer.js — the parity oracle for the
// MCP tool SHAPERS in mcp_tools.rs (TRDD-DMWOBWFH P4x.2).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-mcptools-expected.mjs
//
// The shapers are PURE, so they are driven directly rather than through a live MCP server — a much
// tighter test, and the reason handleGetCallContext is exported.
//
// Discriminators:
//  - the no-body path is an HONEST message carrying back the caller's own ids, with undefined ids
//    OMITTED (never null) — it is not an error and not a spinner (TRDD-ICHAVFCS §6).
//  - the block projection DROPS tokenSource and imposes its OWN key order; passing the context's
//    blocks through unchanged would ship a different wire shape.
//  - totalTokens sums the CONTEXT's own per-block estimates, not a recount.
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { handleGetCallContext, handleGetContextComposition, handleGetContextHistory, handleGetConversation } = require('../../../../../out/test/mcpServer.js')
const { buildCallContextFromJson } = require('../../../../../out/test/rawBodyContext.js')
const { buildContextComposition } = require('../../../../../out/test/contextComposition.js')
const { buildContextHistory } = require('../../../../../out/test/contextHistory.js')
const { buildConversation } = require('../../../../../out/test/conversation.js')
process.env.CLAUDE_CONFIG_DIR = new URL('./claude-home', import.meta.url).pathname
const dir = new URL('.', import.meta.url).pathname

const body = {
  model: 'claude-opus-5',
  metadata: { user_id: JSON.stringify({ session_id: 'tool-sess', account_uuid: 'tool-acct' }) },
  system: 'a system prompt',
  tools: [{ name: 'Bash', description: 'run' }],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'do it' },
      { type: 'image', source: { media_type: 'image/png', data: 'QUJD'.repeat(8) } },
    ] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
  ],
}
const ctx = buildCallContextFromJson(body, {})
// A resolved context also carries requestId; mimic that without importing resolveCallContext.
const resolved = { ...ctx, requestId: 'req-1' }
const noModel = buildCallContextFromJson({ ...body, model: undefined }, {})

const cases = [
  { name: 'null-context-with-both-ids', ctx: null, args: { sessionId: 's1', requestId: 'r1', spanId: 'sp1' } },
  { name: 'null-context-with-no-ids', ctx: null, args: { sessionId: 's1' } },
  { name: 'full-context', ctx: resolved, args: { sessionId: 's1', requestId: 'req-1' } },
  { name: 'context-without-requestId-or-model', ctx: noModel, args: { sessionId: 's1' } },
]
// ── P4x.2b: composition / history / conversation, over the committed transcripts ──────────────
// Each shaper is fed the SAME engine output the Rust side will get, so the test isolates the
// SHAPER — the engines are already covered by their own parity suites.
//
// Discriminators:
//  - composition `turnCount` is the UNFILTERED total even when `turn` selects one turn; recomputing
//    it after the filter would report 1 for every drill.
//  - the conversation RANGE is clamped to from+CAP-1 even when turnTo asks for more, so a caller
//    cannot widen the window by asking.
//  - history's block drill spreads the block VERBATIM (keeping tokenSource) while the step-level
//    projection DROPS it — same data, two deliberately different shapes.
//  - the whole-session history diff collapses to COUNTS; the id lists live only in the drill.
const composition = await buildContextComposition('comp-own')
const history = await buildContextHistory('hist-main')
const conversation = await buildConversation('conv-main')
if (!composition || !history || !conversation) throw new Error('fixture transcripts did not reconstruct — is CLAUDE_CONFIG_DIR right?')

const compCases = [
  { name: 'whole', comp: composition, args: { sessionId: 'comp-own' } },
  { name: 'one-turn-keeps-unfiltered-turnCount', comp: composition, args: { sessionId: 'comp-own', turn: 2 } },
  { name: 'missing-turn', comp: composition, args: { sessionId: 'comp-own', turn: 999 } },
  { name: 'null', comp: null, args: { sessionId: 'ghost' } },
]
const histCases = [
  { name: 'whole', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main' } },
  { name: 'whole-no-card-model', hist: history, cardModel: undefined, args: { sessionId: 'hist-main' } },
  { name: 'one-step', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1 } },
  { name: 'one-block-verbatim', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1, blockId: 'userMsg:user' } },
  { name: 'missing-block', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 1, blockId: 'nope:nope' } },
  { name: 'missing-step', hist: history, cardModel: 'claude-opus-5', args: { sessionId: 'hist-main', turn: 999 } },
  { name: 'null', hist: null, cardModel: undefined, args: { sessionId: 'ghost' } },
]
const convCases = [
  { name: 'whole', conv: conversation, args: { sessionId: 'conv-main' } },
  { name: 'one-turn-verbatim', conv: conversation, args: { sessionId: 'conv-main', turn: 2 } },
  { name: 'missing-turn', conv: conversation, args: { sessionId: 'conv-main', turn: 999 } },
  { name: 'range', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 1, turnTo: 3 } },
  { name: 'range-clamped-to-cap', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 1, turnTo: 9999 } },
  { name: 'range-from-only', conv: conversation, args: { sessionId: 'conv-main', turnFrom: 2 } },
  { name: 'null', conv: null, args: { sessionId: 'ghost' } },
]

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'mcptools-expected.json'), JSON.stringify({
  cases: J(cases),
  results: cases.map(c => J(handleGetCallContext(c.ctx, c.args))),
  compCases: J(compCases),
  compResults: compCases.map(c => J(handleGetContextComposition(c.comp, c.args))),
  histCases: J(histCases),
  histResults: histCases.map(c => J(handleGetContextHistory(c.hist, c.cardModel ? { model: c.cardModel } : undefined, c.args))),
  convCases: J(convCases),
  convResults: convCases.map(c => J(handleGetConversation(c.conv, c.args))),
}, null, 1))
console.log(`mcptools-expected.json: ${cases.length} callcontext + ${compCases.length} composition + ${histCases.length} history + ${convCases.length} conversation cases`)
