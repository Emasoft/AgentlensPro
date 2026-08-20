// Regenerates ctxcomp-expected.json from the COMPILED TS contextCompositionIndex.js — the parity
// oracle for context_composition_index.rs (windowSizeFor / readResponseUsage /
// buildCallComposition / readBlockContent).
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxcomp-expected.mjs
//
// TIME IS PINNED. The TS resolves rates via lookupRates(model) with atIso undefined = "today's
// rate", so a future scheduled rate change would silently make this oracle time-dependent and the
// Rust test would start failing on a day nobody touched the code. `generatedAtMs` is recorded here
// and fed to the Rust side as now_ms, so the comparison is exact and stays stable.
//
// Discriminators, and what each one catches:
//  - windowSizeFor: the beta is PROOF of 1M but its absence proves NOTHING — a port that turned
//    the asymmetry into an if/else reports a 645k fable context as 323% of a 200k window.
//  - readResponseUsage: `typeof [] === 'object'`, so an ARRAY usage passes the TS guard and
//    yields an all-ZERO usage — rejecting it would produce a different call total, not the same one.
//  - buildCallComposition: with exact usage the call's tokenSource is 'exact' even when
//    calibration REFUSED and left the per-block sources 'estimated'.
//  - readBlockContent: an image carries NO `text` key at all; a text block carries it LAST.
import { createRequire } from 'module'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const {
  windowSizeFor, readResponseUsage, buildCallComposition, readBlockContent,
} = require('../../../../../out/test/contextCompositionIndex.js')
const dir = new URL('.', import.meta.url).pathname
const bodiesDir = join(dir, 'bodies')
mkdirSync(bodiesDir, { recursive: true })

const generatedAtMs = Date.now()

const windowCases = [
  { model: undefined, betas: undefined },
  { model: 'claude-opus-5', betas: undefined },
  { model: 'claude-opus-5', betas: ['context-1m-2025-08-07'] },
  { model: 'claude-fable-5', betas: [] },              // absence proves NOTHING — table decides
  { model: 'claude-sonnet-5', betas: undefined },
  { model: 'claude-haiku-4-5-20251001', betas: undefined },
  { model: 'totally-unknown-model', betas: undefined },        // → default 200k
  { model: 'totally-unknown-model[1m]', betas: undefined },    // → tag rescues it to 1M
  { model: 'some-fable-thing', betas: undefined },             // → /fable/i
  { model: 'weird-1m', betas: undefined },                     // → -1m\b
  { model: 'weird-1mx', betas: undefined },                    // → \b fails, so 200k
  { model: '', betas: ['context-1m-2099-01-01'] },             // beta wins over an empty model
  { model: 'claude-opus-5', betas: ['other-beta', 'context-1m-later'] },
  { model: 'claude-opus-5', betas: ['not-the-one'] },
]

// Response-usage fixtures — the real failure modes, on disk, read by BOTH engines.
writeFileSync(join(bodiesDir, 'usage.response.json'), JSON.stringify({
  id: 'msg_bbbb2222',
  usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300, service_tier: 'standard' },
}))
writeFileSync(join(bodiesDir, 'usage-partial.response.json'), JSON.stringify({ usage: { input_tokens: 7 } }))
writeFileSync(join(bodiesDir, 'usage-strings.response.json'), JSON.stringify({ usage: { input_tokens: '500', output_tokens: null } }))
writeFileSync(join(bodiesDir, 'usage-array.response.json'), JSON.stringify({ usage: [] }))
writeFileSync(join(bodiesDir, 'usage-scalar.response.json'), JSON.stringify({ usage: 5 }))
writeFileSync(join(bodiesDir, 'usage-none.response.json'), JSON.stringify({ id: 'x' }))
const usageCases = [
  'usage.response.json',
  'usage-partial.response.json',
  'usage-strings.response.json',
  'usage-array.response.json',
  'usage-scalar.response.json',
  'usage-none.response.json',
  'no-such.response.json',
  '.',
]

// A request body rich enough to exercise every classified category at once.
writeFileSync(join(bodiesDir, 'comp.request.json'), JSON.stringify({
  model: 'claude-opus-5',
  betas: ['context-1m-2025-08-07'],
  metadata: { user_id: JSON.stringify({ session_id: 'comp-sess', account_uuid: 'comp-acct' }) },
  system: [{ text: 'Contents of /x/CLAUDE.md' }, { text: 'plain system' }],
  tools: [{ name: 'Bash', description: 'run' }, { name: 'Read', description: 'read' }],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: 'do the thing' },
      { type: 'image', source: { media_type: 'image/png', data: 'QUJD'.repeat(64) } },
    ] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'thinking hard about it' },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', id: 'm1', name: 'mcp__srv__probe', input: { q: 1 } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'b1', content: 'total 0\ndrwxr-xr-x' },
      { type: 'tool_result', tool_use_id: 'm1', content: 'mcp says hi' },
    ] },
    { role: 'assistant', content: 'and the answer is 42' },
  ],
}))
// A body with NO images / no tools, to prove the zero paths are zeros and not absent keys.
writeFileSync(join(bodiesDir, 'comp-plain.request.json'), JSON.stringify({
  model: 'totally-unknown-model',
  messages: [{ role: 'user', content: 'just text' }],
}))

const EXACT = { inputTokens: 120, outputTokens: 45, cacheReadTokens: 9000, cacheCreateTokens: 300 }
const compCases = [
  { file: 'comp.request.json', turn: 1, ts: 1000, opts: {} },
  { file: 'comp.request.json', turn: 7, ts: 2000, opts: { projectHint: '/repo/x', exact: EXACT } },
  // Exact total far outside the 0.2–5 calibration band: the CALL is still 'exact' while every
  // BLOCK stays 'estimated'. Collapsing the two sources is the mistake this pins.
  { file: 'comp.request.json', turn: 2, ts: 3000, opts: { exact: { inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 } } },
  { file: 'comp-plain.request.json', turn: 1, ts: 4000, opts: {} },
  { file: 'comp-plain.request.json', turn: 1, ts: 4000, opts: { modelHint: 'claude-opus-5' } },
  { file: 'no-such.request.json', turn: 1, ts: 5000, opts: {} },   // unreadable → null
]

const blockCases = [
  { file: 'comp.request.json', index: 0, full: false },
  { file: 'comp.request.json', index: 3, full: false },
  { file: 'comp.request.json', index: 99, full: false },   // out of range → null
  { file: 'comp.request.json', index: -1, full: false },   // negative → null
  { file: 'comp-plain.request.json', index: 0, full: true },
  { file: 'no-such.request.json', index: 0, full: false },
]
// The image block's index is discovered rather than hardcoded, so a taxonomy change can't quietly
// turn this into a second text-block case that proves nothing about images.
const probe = await buildCallComposition(join(bodiesDir, 'comp.request.json'), 1, 0, {})
const imageIdx = probe.blocks.findIndex(b => b.isImage)
blockCases.push({ file: 'comp.request.json', index: imageIdx, full: false })

const J = (v) => JSON.parse(JSON.stringify(v ?? null))
// bodyRef is an ABSOLUTE path, so writing it verbatim would bake this machine's home directory
// (and its username) into a committed fixture — check-identities fails the build on exactly that,
// and rightly so. Every absolute fixture path is rewritten to a bare filename; the Rust test
// applies the identical rewrite before comparing.
const strip = (text) => text.split(JSON.stringify(bodiesDir + '/').slice(1, -1)).join('')
writeFileSync(join(dir, 'ctxcomp-expected.json'), strip(JSON.stringify({
  generatedAtMs,
  windowCases: J(windowCases),
  windows: windowCases.map(c => windowSizeFor(c.model, c.betas)),
  usageCases: J(usageCases),
  usages: await Promise.all(usageCases.map(f => readResponseUsage(join(bodiesDir, f)).then(J))),
  compCases: J(compCases),
  comps: await Promise.all(compCases.map(c =>
    buildCallComposition(join(bodiesDir, c.file), c.turn, c.ts, c.opts).then(J))),
  blockCases: J(blockCases),
  blocks: await Promise.all(blockCases.map(c =>
    readBlockContent(join(bodiesDir, c.file), c.index, { full: c.full }).then(J))),
}, null, 1)))
console.log(`ctxcomp-expected.json: ${windowCases.length} window + ${usageCases.length} usage + ${compCases.length} comp + ${blockCases.length} block cases (imageIdx=${imageIdx})`)
