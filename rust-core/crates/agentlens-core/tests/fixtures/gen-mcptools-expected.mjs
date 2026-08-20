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
const { handleGetCallContext } = require('../../../../../out/test/mcpServer.js')
const { buildCallContextFromJson } = require('../../../../../out/test/rawBodyContext.js')
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
const J = (v) => JSON.parse(JSON.stringify(v ?? null))
writeFileSync(join(dir, 'mcptools-expected.json'), JSON.stringify({
  cases: J(cases),
  results: cases.map(c => J(handleGetCallContext(c.ctx, c.args))),
}, null, 1))
console.log(`mcptools-expected.json: ${cases.length} get_call_context cases`)
