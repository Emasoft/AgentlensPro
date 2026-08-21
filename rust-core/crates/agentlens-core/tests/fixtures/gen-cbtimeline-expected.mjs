// Regenerates cbtimeline-expected.json from the COMPILED src/cacheBreakTimeline.ts — the parity
// oracle for SLICE 1 of the cacheBreakTimeline port (TRDD-DMWOBWFH P4x.2i): the classification
// primitives (TS lines 48-635). Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cbtimeline-expected.mjs
//
// IMPORTS out/test/ — NOT out/. `compile-tests` (tsc -p tsconfig.test.json) writes outDir
// `out/test`; the `out/` tree at the repo root is a leftover from an older config and on this
// machine is 8 days staler. Every other generator here already imports out/test/; only
// gen-ratelimit-expected.mjs still reads out/ (its two builds are cmp-identical today, so no
// oracle is wrong — the PATH is the hazard, not the current bytes).
//
// No mtime oracle and no I/O under test: slice 1 is pure functions over in-memory values, so the
// fixture IS the input. Slices 3-4 (buildCacheBreakTimeline) are the ones that read the spool.
//
// What the fixture pins, beyond "the two implementations agree":
//  - minCacheableTokensFor ROW ORDER and the two negative-lookahead rows. `opus-4-7` must yield
//    2048, not the 1024 the bare-`opus-4` alternative would give if the lookahead were dropped;
//    `claude-sonnet-4-20250514` must NOT match bare `sonnet-4` (a digit follows the hyphen). A
//    port that translates `(?![-.\d])` as nothing passes every OTHER model in this list.
//  - classifyContentKind BRANCH ORDER, which is the whole classifier: a compaction summary that
//    quotes "Contents of …/CLAUDE.md" must stay `postcompact`; a memory page that quotes
//    "[janitor-memory]" must stay `memory` (the TS checks memory BEFORE hook precisely because a
//    page body can mention a hook marker); a block carrying both `cc_version=` and
//    `<system-reminder>` must be `agentmeta` (first rule wins).
//  - the messageBlockText / messageBlockTextBytes ASYMMETRY: bytes counts ONLY string `.text`,
//    while the text join stringifies ANY truthy `.text`. A tool_result carrying `{text: 5}`
//    therefore contributes "5" to the fingerprinted text but ZERO to promptBytes. Both halves are
//    observable in the same case, so a port that "fixes" either one reddens.
//  - UTF-16 vs bytes on the SAME block: `len` is UTF-16 units (an emoji is 2) while `tokensApprox`
//    comes from UTF-8 byte length (an emoji is 4). One emoji-bearing block pins both at once.
//  - the LAST message cache_control wins (not the first), and content AFTER that breakpoint still
//    counts toward promptTokensApprox — the TS comment's own trap: sizing the prompt from the
//    prefix alone would fire BELOW_MIN_CACHEABLE on a huge conversation whose only breakpoint sits
//    in system[].
//  - both env spellings: the SDK's <env>…</env> and the CLI's "# Environment" region, which has NO
//    closing delimiter and must stop at the NEXT "\n# " heading (a lookahead the Rust regex crate
//    cannot express, so the port has to reproduce the boundary by hand).
//  - paramSignature's ABSENT-vs-EXPLICIT distinction ('' for both undefined and null), the
//    type+budget_tokens / type+name shapes, and the JSON.stringify fallback for an object with no
//    string `type` — including an ARRAY, which `typeof x === 'object'` also catches.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const {
  EXPECTED_CAUSES, CACHE_BREAK_REMEDIATION,
  minCacheableTokensFor, classifyContentKind, segmentInjected, extractTurnPrefix,
} = await import(path.join(HERE, '../../../../../out/test/cacheBreakTimeline.js'))

// ── minCacheableTokensFor ────────────────────────────────────────────────────────
const MODELS = [
  'claude-opus-5', 'claude-opus-5[1m]', 'OPUS-5', 'fable-5', 'mythos-5',
  'claude-opus-4-8', 'claude-opus-4.8', 'claude-sonnet-5', 'claude-sonnet-4-6',
  'claude-sonnet-4-5', 'claude-opus-4-1',
  'claude-opus-4',                 // bare -> 1024 (the lookahead alternative)
  'claude-sonnet-4',               // bare -> 1024
  'claude-opus-4-20250514',        // digit after the hyphen -> NOT bare opus-4 ... but opus-4-2? no row -> null
  'claude-sonnet-4-20250514',      // same shape on the sonnet row
  'claude-opus-4-7', 'claude-opus-4.7', 'mythos-preview', 'claude-3-5-haiku', 'haiku-3.5',
  'claude-opus-4-6', 'claude-opus-4-5', 'claude-haiku-4-5',
  'gpt-4o', '', 'sonnet', 'opus-4x',
]
const minCacheable = {}
for (const m of MODELS) minCacheable[m] = minCacheableTokensFor(m) ?? null

// ── classifyContentKind ──────────────────────────────────────────────────────────
const KIND_CASES = {
  agentmeta_billing: 'x-anthropic-billing-header: cc_version=2.1.230',
  // BOTH agentmeta and system markers: the first rule must win.
  agentmeta_beats_system: '<system-reminder>\ncc_entrypoint=cli\n</system-reminder>',
  postcompact_continued: 'This session is being continued from a previous conversation.',
  postcompact_analysis: 'Analysis:\nthe user asked for X\nSummary:\nported the thing',
  // A compaction summary that QUOTES an injected CLAUDE.md header — postcompact is checked first.
  postcompact_beats_claudemd: 'compacted the previous conversation\nContents of /w/p/CLAUDE.md (project instructions):',
  claudemd_contents: "Contents of /w/p/CLAUDE.md (project instructions, checked into the codebase):\n# CLAUDE.md\nbe good",
  claudemd_heading: '# CLAUDE.md\nproject notes',
  rule_contents: 'Contents of /Users/x/.claude/rules/commit-discipline.md (private global instructions):',
  // A memory PAGE that mentions a hook marker: memory is checked BEFORE hook on purpose.
  memory_beats_hook: 'Contents of /Users/x/.claude/projects/p/memory/MEMORY.md — see [janitor-memory] recall',
  memory_autoheader: "auto-memory, persists across conversations",
  execresult_stdout: '<local-command-stdout>ok</local-command-stdout>',
  execresult_fnresults: '<function_results>42</function_results>',
  skillcatalog: 'The following skills are available for use with the Skill tool:\n- distill',
  agentcatalog: 'Available agent types for the Agent tool:\n- Explore',
  hook_pss: '<pss-skills>rust, typescript</pss-skills>',
  hook_janitor_memory: '[janitor-memory] Memory corpus: 17 local notes',
  hook_userpromptsubmit: 'UserPromptSubmit hook additional context: budget ok',
  hook_pretooluse: 'PreToolUse:Bash hook additional context: token spike 453,881 tokens',
  hook_posttooluse: 'PostToolUse:Edit hook additional context: formatted',
  hook_tasklist: "task tools haven't been used recently",
  hook_reminder_wrapped: '<system-reminder>the janitor heartbeat fired</system-reminder>',
  date_today: "Today's date is 2026-08-21",
  date_currentdate: '# currentDate\n2026-08-21',
  system_plain: '<system-reminder>this context may or may not be relevant</system-reminder>',
  usertext: 'port the classifier to rust please',
  empty: '',
}
const contentKind = {}
for (const [k, v] of Object.entries(KIND_CASES)) contentKind[k] = classifyContentKind(v)

// ── segmentInjected ──────────────────────────────────────────────────────────────
const SEG_CASES = {
  // No boundary at all -> ONE segment, labelled by kind (the hook signature wins over the fallback).
  none_hook: ['<pss-skills>rust</pss-skills>', 'system[0]'],
  none_janitor: ['[janitor-heartbeat] fired at 05:00', 'system[0]'],
  none_usertext: ['just some prose', 'msg[3] user'],
  // A <system-reminder> whose signature resolves through the `system` arm of labelFor.
  none_system_sig: ['<system-reminder>AI Maestro inbox: 2 unread messages</system-reminder>', 'system[1]'],
  // Lead region + two marks.
  lead_and_two: [
    "cc_version=2.1.230\nToday's date is 2026-08-21\n" +
    'Contents of /w/p/CLAUDE.md (project instructions):\nbe good\n' +
    'Contents of /Users/x/.claude/rules/never_use_sed.md (private):\nno sed',
    'system[3]',
  ],
  // Mark at index 0 -> NO lead segment.
  mark_at_zero: ['Contents of /w/p/CLAUDE.md (project):\nbody', 'system[0]'],
  // The label stops at the first "(" and is trimmed; the extension class is [A-Za-z0-9_].
  label_paren: ['Contents of /w/p/notes.md   (a comment)\nbody', 'system[0]'],
  // A boundary INSIDE a message block, and a segment that classifies as memory.
  memory_segment: [
    'preamble\nContents of /Users/x/.claude/projects/p/memory/MEMORY.md (auto-memory):\n- a note',
    'msg[0] user',
  ],
  // A "Contents of" with no dotted extension is NOT a boundary (the regex needs `.ext`).
  no_extension: ['Contents of some directory\nand more text', 'system[0]'],
}
const segments = {}
for (const [k, [text, label]] of Object.entries(SEG_CASES)) segments[k] = segmentInjected(text, label)

// ── extractTurnPrefix ────────────────────────────────────────────────────────────
// The CLI environment spelling: no closing delimiter, so the region must stop at the NEXT
// "\n# " heading. `# Scratchpad Directory` is the real one that follows it in a live prompt.
const CLI_SYS = [
  '# Environment',
  'You have been invoked in the following environment:',
  ' - Primary working directory: /w/p',
  ' - Platform: darwin',
  '',
  'gitStatus: This is the git status at the start of the conversation.',
  'Current branch: main',
  'Recent commits:',
  '8eafa50 feat(rust-core): bodies_evidence',
  'c7d1db7 docs: STATE',
  '',
  'Trailing prose that is NOT part of the git region.',
  '# Scratchpad Directory',
  'use /tmp/scratch',
].join('\n')

const SDK_SYS = 'You are a helpful assistant.\n<env>\nWorking directory: /w/p\nPlatform: darwin\n</env>\nEnd.'

const TOOLS = [
  { name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } },
  { name: 'mcp__chrome-devtools__click', description: '', defer_loading: true, cache_control: { type: 'ephemeral' } },
  { name: 'Read', input_schema: null },   // nullish schema -> "{}" ; no description -> ''
  { description: 'a tool with no name at all' },  // -> '?'
]

// An emoji block pins UTF-16 `len` (2 units each) against UTF-8 `tokensApprox` (4 bytes each) in
// ONE value — a port that used bytes for both, or chars for both, cannot satisfy them together.
const EMOJI = '🔥🔥🔥 emoji block'

const BODIES = {
  null_body: null,
  not_an_object: 'a string, not a body',
  empty_object: {},
  // `typeof [] === 'object'`, so the guard ACCEPTS an array body — it is not null and not a
  // primitive. A port that rejects anything that is not a JSON object returns null here instead.
  array_body: [],

  // System as a plain STRING (the other branch), no messages, no markers anywhere.
  system_string: { model: 'claude-sonnet-5', system: SDK_SYS },

  // The full shape: array system with a cache_control marker, four tools, the CLI env + git
  // regions, and a message layer whose LAST breakpoint is msg[2].
  full: {
    model: 'claude-opus-5[1m]',
    thinking: { type: 'enabled', budget_tokens: 10000 },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'Bash' },
    speed: 'fast',
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.230' },
      { type: 'text', text: CLI_SYS, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '' },        // empty text -> skipped entirely
      { type: 'text' },                  // no text at all -> skipped
    ],
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'a plain string message' },
      { role: 'assistant', content: [{ type: 'text', text: 'first breakpoint', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'user',
        content: [
          // THE ASYMMETRY: bytes counts only the STRING text ('a' = 1) but the joined text is
          // "a\n5\n" — the number 5 is stringified by the join and the third entry yields ''.
          { type: 'tool_result', content: [{ text: 'a' }, { text: 5 }, { nope: 1 }] },
          { type: 'tool_result', content: 'a string tool_result' },
          { type: 'tool_use', name: 'Bash', input: { cmd: 'ls -la' } },
          { type: 'image', source: { data: 'AAAABBBB' } },
          { type: 'image', source: {} },              // no data -> image:0
          { type: 'thinking', thinking: 'ignored — neither text nor attachment' },
          { type: 'text', text: EMOJI, cache_control: { type: 'ephemeral' } },  // LAST breakpoint
        ],
      },
      // AFTER the breakpoint: excluded from the blocks, still counted in promptTokensApprox.
      { role: 'assistant', content: [{ type: 'text', text: 'tail content past the last breakpoint' }] },
    ],
  },

  // A body whose ONLY breakpoint sits in system[] — message prefix is EMPTY, yet the prompt total
  // must still include every message (the BELOW_MIN_CACHEABLE trap the TS comment calls out).
  breakpoint_in_system_only: {
    model: 'claude-haiku-4-5',
    system: [{ type: 'text', text: 'small system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'a'.repeat(5000) },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(5000) }] },
    ],
  },

  // No cache_control ANYWHERE -> hasCacheControl false and an empty message prefix.
  no_markers: {
    model: 'claude-opus-4-6',
    system: SDK_SYS,
    tools: [{ name: 'Grep', description: 'search', input_schema: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  },

  // paramSignature branches: null (absent), a bare scalar, an object with NO string `type`, and an
  // ARRAY — which `typeof v === 'object'` also catches, so it falls to JSON.stringify.
  param_shapes: {
    model: 'claude-sonnet-4-6',
    thinking: null,
    output_config: { effort: 42 },        // non-string effort -> ''
    tool_choice: { any: 'thing', n: 1 },  // no string type -> JSON.stringify
    speed: ['fast', 'slow'],              // array -> JSON.stringify
    messages: [],
  },

  // A git region with NO "Recent commits:" list: the region runs to the END of the system text
  // rather than guessing a boundary.
  git_no_commits: {
    model: 'claude-opus-5',
    system: 'preamble\ngitStatus: clean\nCurrent branch: main',
    messages: [],
  },

  // The CLI env region when NO later "# " heading exists: it must run to the end of input.
  env_cli_to_end: {
    model: 'claude-opus-5',
    system: '# Environment\nYou have been invoked in the following environment:\n - Platform: darwin',
    messages: [],
  },

  // Tools present but messages absent entirely (undefined) — messageCount 0, no crash.
  tools_only: { model: 'claude-opus-5', tools: TOOLS },
}
const prefixes = {}
for (const [k, v] of Object.entries(BODIES)) prefixes[k] = extractTurnPrefix(v)

const out = {
  // The BODIES are emitted alongside their results so the Rust test feeds the port the exact input
  // the TS was given, instead of a hand-copied transcription that can drift from it silently.
  bodies: BODIES,
  expectedCauses: [...EXPECTED_CAUSES],
  remediation: CACHE_BREAK_REMEDIATION,
  minCacheable,
  contentKind,
  segments,
  prefixes,
}
fs.writeFileSync(path.join(HERE, 'cbtimeline-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote cbtimeline-expected.json')
console.log(' expectedCauses:', out.expectedCauses.join(','))
console.log(' remediation keys:', Object.keys(out.remediation).length)
console.log(' minCacheable:', Object.entries(minCacheable).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(' contentKind:', Object.entries(contentKind).map(([k, v]) => `${k}=${v}`).join(' '))
console.log(' segments:', Object.entries(segments).map(([k, v]) => `${k}[${v.length}]`).join(' '))
console.log(' prefixes:', Object.entries(prefixes).map(([k, v]) => `${k}=${v ? `t${v.tools.length}/s${v.systemBlocks.length}/m${v.messageBlocks.length}` : 'null'}`).join(' '))
