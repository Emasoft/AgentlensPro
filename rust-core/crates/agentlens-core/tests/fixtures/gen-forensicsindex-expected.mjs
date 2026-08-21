// Regenerates forensicsindex-expected.json from the COMPILED src/forensicsIndex.ts — the parity
// oracle for the PURE half (TRDD-DMWOBWFH P4x.2p): classifyEffort, computeFrontmatterFp,
// extractInjections, deriveContentTags. The scan/index half writes a fact DB and is a separate
// slice; nothing here touches disk.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicsindex-expected.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { classifyEffort, computeFrontmatterFp, extractInjections, deriveContentTags } =
  await import(path.join(HERE, '../../../../../out/test/forensicsIndex.js'))

// ── classifyEffort — the three thresholds, each pinned ON and one either side. A port that used
// `<` where the TS uses `<=` is invisible everywhere except exactly 8192 and 24576.
const effortInputs = [undefined, null, 0, -1, -8192, 1, 4096, 8191, 8192, 8193, 24575, 24576, 24577, 32000, 1e9, NaN]
const effort = effortInputs.map((v) => ({ input: Number.isNaN(v) ? 'NaN' : v ?? null, out: classifyEffort(v) }))

// The fixture paths are rooted at `/fixture` and `Z:\fixture`, NOT at a home directory, and that is
// the identity gate doing its job rather than pedantry: `check-identities` matches the SHAPE
// `/home/<user>` or `C:\Users\<user>`, so even an obviously-invented username fails it. A guard
// keyed on the real account instead would go blind the day a different one is used.
//
// ── computeFrontmatterFp — the fingerprint is a sha1 over `tools:…||system:…`, where each system
// block collapses to an IDENTITY (rule:<file> / claudemd / system). Cases are chosen so that a port
// which got the identity rule wrong produces a DIFFERENT hash rather than a coincidentally equal one.
const RULE_TEXT = 'Contents of /fixture/.claude/rules/never-git-add-all.md (user rules):\n\nsome text'
const RULE_WIN = 'Contents of Z:\\fixture\\.claude\\rules\\gh-actions.md (user rules)'
const CLAUDEMD_TEXT = 'Contents of /repo/CLAUDE.md (project instructions)'
const CLAUDEMD_HEAD = '# CLAUDE.md\n\nthis is the file'
const fpCases = {
  empty: {},
  no_tools_no_system: { model: 'x', messages: [] },
  tools_only: { tools: [{ name: 'Bash' }, { name: 'Read' }, { name: '' }, {}, { name: 'Edit' }] },
  system_string: { system: 'You are Claude.' },
  system_string_rule: { system: RULE_TEXT },
  system_blocks: { system: [{ text: 'You are Claude.' }, { text: RULE_TEXT }, { text: CLAUDEMD_TEXT }] },
  // A block with no text is SKIPPED entirely — not folded in as an empty identity, which would
  // change the hash of every request that carries one.
  system_blocks_with_empty: { system: [{ text: 'You are Claude.' }, { text: '' }, { type: 'text' }, { text: RULE_TEXT }, { text: CLAUDEMD_TEXT }] },
  system_windows_rule: { system: [{ text: RULE_WIN }] },
  system_claudemd_heading: { system: [{ text: CLAUDEMD_HEAD }] },
  both: { tools: [{ name: 'Bash' }], system: [{ text: RULE_TEXT }] },
  // Order matters — the canonical string joins in ARRAY order, so a port that sorted would collide
  // two genuinely different prefixes onto one fingerprint.
  both_reordered: { tools: [{ name: 'Read' }, { name: 'Bash' }], system: [{ text: RULE_TEXT }] },
  system_not_array_not_string: { system: 42, tools: [{ name: 'Bash' }] },
}
const fp = Object.fromEntries(Object.entries(fpCases).map(([k, v]) => [k, computeFrontmatterFp(v) ?? null]))

// ── extractInjections
const injectionCases = {
  empty: {},
  // Several rule markers inside ONE giant system block: the regex is GLOBAL for exactly this shape,
  // and a port that stopped at the first match records one rule per request instead of twenty.
  many_rules: {
    system: `preamble\nContents of /fixture/.claude/rules/a.md (x)\nmiddle\nContents of /fixture/.claude/rules/b.md (y)\nContents of Z:\\fixture\\.claude\\rules\\c.md\n`,
  },
  // The same rule twice must appear ONCE: the junction table is per (kind, name).
  duplicate_rules: {
    system: `Contents of /fixture/.claude/rules/a.md (x)\nContents of /fixture/.claude/rules/a.md (x)\n`,
  },
  claudemd: { system: 'Contents of /repo/CLAUDE.md (project)\nContents of /other/CLAUDE.md (user)\n' },
  system_array: { system: [{ text: 'Contents of /fixture/.claude/rules/a.md' }, { text: 'Contents of /repo/CLAUDE.md' }] },
  // mcp__<server>__<tool> collapses to the SERVER; a server name containing underscores is the case
  // the lazy quantifier exists for.
  mcp_tools: {
    tools: [
      { name: 'Bash' }, { name: 'mcp__chrome-devtools__click' }, { name: 'mcp__chrome-devtools__navigate' },
      { name: 'mcp__plugin_llm-externalizer_llm-externalizer__chat' }, { name: 'mcp__x__y' }, { name: 'not__mcp__x' },
      // A tool name carrying a SECOND `__`: the server is everything up to the FIRST one, so this
      // is `mcp__srv`, not `mcp__srv__tool`. This is the boundary the quantifier actually decides —
      // and note the lazy `*?` in the TS pattern is a no-op (a repetition is `_` + non-`_`, so it
      // can never cross a `__` however greedy it is); measured by flipping it and getting identical
      // output on every case here.
      { name: 'mcp__srv__tool__extra' }, { name: 'mcp__a_b__c__d' },
    ],
  },
  skills: {
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'distill' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { command: 'tldr-code' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { name: 'janitor-arm' } }] },
      // Not a Skill call, and a Skill call with no usable input: neither is an invocation.
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { skill: 'nope' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: {} }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill' }] },
      { role: 'user', content: 'a plain string, not blocks' },
    ],
  },
  // Precedence inside one input: skill, then command, then name.
  skill_precedence: {
    messages: [{ content: [{ type: 'tool_use', name: 'Skill', input: { skill: 's', command: 'c', name: 'n' } }] }],
  },
  everything: {
    system: [{ text: 'Contents of /fixture/.claude/rules/a.md' }, { text: 'Contents of /repo/CLAUDE.md' }],
    tools: [{ name: 'mcp__srv__t' }],
    messages: [{ content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'distill' } }] }],
  },
}
const injections = Object.fromEntries(Object.entries(injectionCases).map(([k, v]) => [k, extractInjections(v)]))

// ── deriveContentTags — a CallComposition is plain data here, so the fixture states it directly
// rather than reproducing the whole composition builder.
const comp = (over = {}) => ({
  images: { count: 0, tokens: 0 },
  blocks: [],
  toolCatalogTokens: 0,
  thinkingTokens: 0,
  ...over,
})
const blk = (o) => ({ kind: 'text', tokens: 0, bytes: 0, ...o })
const tagCases = {
  empty: comp(),
  images: comp({ images: { count: 3, tokens: 9756 } }),
  // A binary block is NON-image media; image media has its own tag, so the two must not double-count.
  binary: comp({ blocks: [blk({ mediaType: 'application/pdf', bytes: 4001 }), blk({ mediaType: 'image/png', bytes: 999 }), blk({ mediaType: '', bytes: 5 })] }),
  big_reads: comp({ blocks: [blk({ kind: 'toolOutput', tokens: 25_000, toolName: 'Read' }), blk({ kind: 'toolOutput', tokens: 24_999, toolName: 'Read' }), blk({ kind: 'bashOutput', tokens: 30_000, toolName: 'Bash' })] }),
  tool_result_kinds: comp({
    blocks: [
      blk({ kind: 'toolOutput', tokens: 10, toolName: 'Read' }),
      blk({ kind: 'toolOutput', tokens: 20, toolName: 'Read' }),
      blk({ kind: 'bashOutput', tokens: 30, toolName: 'Bash' }),
      // No toolName: the key falls back to the KIND, which is why the fallback exists.
      blk({ kind: 'toolOutput', tokens: 40 }),
      blk({ kind: 'text', tokens: 999, toolName: 'Read' }),
    ],
  }),
  catalog_boundary_below: comp({ toolCatalogTokens: 9_999 }),
  catalog_boundary_on: comp({ toolCatalogTokens: 10_000 }),
  thinking_boundary_below: comp({ thinkingTokens: 19_999 }),
  thinking_boundary_on: comp({ thinkingTokens: 20_000 }),
  everything: comp({
    images: { count: 1, tokens: 3252 },
    blocks: [blk({ mediaType: 'audio/wav', bytes: 8000 }), blk({ kind: 'toolOutput', tokens: 26_000, toolName: 'Read' })],
    toolCatalogTokens: 65_177,
    thinkingTokens: 21_000,
  }),
}
const tags = Object.fromEntries(Object.entries(tagCases).map(([k, v]) => [k, deriveContentTags(v)]))

const out = { effort, fp, fpCases, injections, injectionCases, tags, tagCases }
fs.writeFileSync(path.join(HERE, 'forensicsindex-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote forensicsindex-expected.json')
console.log(' effort:', effort.map((e) => `${e.input}=${e.out}`).join(' '))
console.log(' fp:', Object.entries(fp).map(([k, v]) => `${k}=${v ? v.slice(0, 8) : 'null'}`).join(' '))
console.log(' injections:', Object.entries(injections).map(([k, v]) => `${k}=${v.length}`).join(' '))
console.log(' tags:', Object.entries(tags).map(([k, v]) => `${k}=${v.length}`).join(' '))
