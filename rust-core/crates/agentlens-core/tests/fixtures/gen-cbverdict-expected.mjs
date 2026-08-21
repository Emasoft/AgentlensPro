// Regenerates cbverdict-expected.json from the COMPILED src/cacheBreakTimeline.ts — the parity
// oracle for SLICE 2 of the cacheBreakTimeline port (TRDD-DMWOBWFH P4x.2j): `classifyCacheBreak`,
// the verdict engine, and the two diffs it drives (diffTools, diffBlocks). Run from the repo root
// AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-cbverdict-expected.mjs
//
// Every case is expressed as RAW REQUEST BODIES, never as hand-built TurnPrefix literals: the Rust
// side re-derives its prefixes with its own extract_turn_prefix (slice 1), so the two engines are
// compared end to end and a hand-transcribed prefix cannot quietly drift from the real shape.
//
// The engine is a PRIORITY LADDER — model → tools → params → env/git → system → message → timing —
// and almost every bug in such a ladder is an ORDERING bug, invisible to a fixture that exercises
// one rule at a time. So the cases below deliberately arm two rules at once wherever the TS commits
// to a precedence:
//   - `plugins_reloaded_2` churns tools AND the skill catalog: naming TOOLSET_CHANGED there hides
//     the machine's #1 cache-break cost behind its own symptom.
//   - `interleave_aba` arms a MODEL_SWITCH that must NOT be claimed, because the "switch" is two
//     streams sharing one session id and neither broke the other's cache.
//   - `sys_timestamp` arms a system-block change whose `norm` is equal — the clock, not the file.
//   - `env_and_timestamp` moves the clock INSIDE the env region: `envNorm` is then equal too, so
//     WORKING_DIR_CHANGED must stand down and let the block diff name SYSTEM_TIMESTAMP.
//   - `param_absent_to_present` is the documented NO-OP: absent→'high' is undecidable without a
//     per-model defaults table, so it must fall THROUGH to a later rule rather than be guessed.
//   - `skill_injection_spliced` is both an insertion and a skill-catalog first-appearance; the TS
//     comment records that running the generic splice branch first demoted it to SKILL_CHANGED.
//   - `timing_4m42s` sits in the 4.5-6m window, which fires BELOW the nominal 5m TTL — an
//     implementation that only tests `gap >= FIVE_MIN` misses it and reports the wrong tier.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { classifyCacheBreak, extractTurnPrefix } = await import(path.join(HERE, '../../../../../out/test/cacheBreakTimeline.js'))

// ── body builders ───────────────────────────────────────────────────────────────
const tool = (name, desc = 'd', extra = {}) => ({ name, description: desc, input_schema: { type: 'object' }, ...extra })
const sysBlocks = (texts, cc = true) =>
  texts.map((t, i) => ({ type: 'text', text: t, ...(cc && i === texts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }))
const msgBlocks = (groups, cc = true) =>
  groups.map((blocks, gi) => ({
    role: gi % 2 === 0 ? 'user' : 'assistant',
    content: blocks.map((b, bi) => {
      const isLast = cc && gi === groups.length - 1 && bi === blocks.length - 1
      const block = typeof b === 'string' ? { type: 'text', text: b } : b
      return isLast ? { ...block, cache_control: { type: 'ephemeral' } } : block
    }),
  }))
const body = ({ model = 'claude-opus-5', tools = [], sys = ['system prose'], msgs = [['hello']], cc = true, ...rest }) => ({
  model,
  tools,
  system: sysBlocks(sys, cc),
  messages: msgBlocks(msgs, cc),
  ...rest,
})

// Texts chosen so `classifyContentKind` gives the KIND each branch needs.
const K = {
  user: (s) => `plain conversation text ${s}`,
  skills: (s) => `The following skills are available for use with the Skill tool:\n- ${s}`,
  agents: (s) => `Available agent types for the Agent tool:\n- ${s}`,
  hook: (s) => `<pss-skills>${s}</pss-skills>`,
  date: (s) => `Today's date is ${s}`,
  post: () => 'This session is being continued from a previous conversation.',
  meta: (v) => `x-anthropic-billing-header: cc_version=${v}`,
  claudemd: (s) => `Contents of /w/p/CLAUDE.md (project instructions):\n${s}`,
}
const ENV = (dir) => `<env>\nWorking directory: ${dir}\nPlatform: darwin\n</env>`
const GIT = (sha) => `gitStatus: clean\nCurrent branch: main\nRecent commits:\n${sha} feat: x\n\ntrailing prose`

// A timing with real cache activity, so `diagnoseNoCacheActivity` never short-circuits a case that
// is about something else.
const T = (over = {}) => ({ cacheReadTokens: 5000, cacheCreateTokens: 20000, ephemeral5mTokens: 0, ephemeral1hTokens: 20000, ...over })

const CASES = {
  // ── the pre-ladder guards ─────────────────────────────────────────────────────
  cold_start_no_prev: { prev: null, cur: body({}), timing: T() },
  caching_disabled: { prev: null, cur: body({ cc: false }), timing: T({ cacheReadTokens: 0, cacheCreateTokens: 0 }) },
  below_min_cacheable: {
    prev: null,
    cur: body({ model: 'claude-haiku-4-5' }),
    timing: T({ cacheReadTokens: 0, cacheCreateTokens: 0 }),
  },
  // Same 0/0 shape, but no documented minimum for the model → NO size verdict; falls to COLD_START.
  no_min_row_for_model: { prev: null, cur: body({ model: 'gpt-4o' }), timing: T({ cacheReadTokens: 0, cacheCreateTokens: 0 }) },

  // ── 0. the interleave artifact, which must outrank model + tools ──────────────
  interleave_aba: {
    prev2: body({ model: 'claude-opus-5', tools: [tool('Bash')] }),
    prev: body({ model: 'claude-sonnet-5', tools: [tool('Grep')] }),
    cur: body({ model: 'claude-opus-5', tools: [tool('Bash')] }),
    timing: T(),
  },
  // prev2 exists but does NOT match cur's stream → the artifact is not claimed and MODEL_SWITCH is.
  interleave_not_claimed: {
    prev2: body({ model: 'claude-fable-5', tools: [tool('Read')] }),
    prev: body({ model: 'claude-sonnet-5', tools: [tool('Grep')] }),
    cur: body({ model: 'claude-opus-5', tools: [tool('Bash')] }),
    timing: T(),
  },

  // ── 1-2. model, then tools ────────────────────────────────────────────────────
  model_switch: { prev: body({ model: 'claude-sonnet-5' }), cur: body({ model: 'claude-opus-5' }), timing: T() },
  tools_added: { prev: body({ tools: [tool('Bash')] }), cur: body({ tools: [tool('Bash'), tool('Grep')] }), timing: T() },
  tools_removed: { prev: body({ tools: [tool('Bash'), tool('Grep')] }), cur: body({ tools: [tool('Bash')] }), timing: T() },
  // Added AND all-deferred AND nothing removed — the most specific tools verdict.
  tools_deferred_loaded: {
    prev: body({ tools: [tool('Bash')] }),
    cur: body({ tools: [tool('Bash'), tool('WebSearch', 'd', { defer_loading: true })] }),
    timing: T(),
  },
  // A deferred ADD together with a removal is NOT tool-search: it falls through to TOOLSET_CHANGED.
  tools_deferred_plus_removal: {
    prev: body({ tools: [tool('Bash'), tool('Grep')] }),
    cur: body({ tools: [tool('Bash'), tool('WebSearch', 'd', { defer_loading: true })] }),
    timing: T(),
  },
  tools_mcp_server: {
    prev: body({ tools: [tool('Bash'), tool('mcp__chrome__click'), tool('mcp__chrome__type')] }),
    cur: body({ tools: [tool('Bash')] }),
    timing: T(),
  },
  // Every changed name is a harness deferred built-in → ONE stable actor, not the churn list.
  tools_harness_builtins: {
    prev: body({ tools: [tool('Bash'), tool('CronList'), tool('TaskGet')] }),
    cur: body({ tools: [tool('Bash')] }),
    timing: T(),
  },
  // >3 changed names exercises fmtList's "+N more" tail.
  tools_many_added: {
    prev: body({ tools: [tool('Bash')] }),
    cur: body({ tools: [tool('Bash'), tool('A1'), tool('B2'), tool('C3'), tool('D4'), tool('E5')] }),
    timing: T(),
  },
  tools_reordered: {
    prev: body({ tools: [tool('Bash'), tool('Grep')] }),
    cur: body({ tools: [tool('Grep'), tool('Bash')] }),
    timing: T(),
  },
  tools_definition_changed: {
    prev: body({ tools: [tool('Bash', 'run a command')] }),
    cur: body({ tools: [tool('Bash', 'run a command, now with more words')] }),
    timing: T(),
  },

  // ── 2a. the cross-layer reload, which must outrank the tools verdict ──────────
  plugins_reloaded_2: {
    prev: body({ tools: [tool('Bash')], sys: [K.skills('one'), K.agents('a')] }),
    cur: body({ tools: [tool('Bash'), tool('Grep')], sys: [K.skills('one and two'), K.agents('a')] }),
    timing: T(),
  },
  plugins_reloaded_3: {
    prev: body({ tools: [tool('Bash')], sys: [K.skills('one'), K.agents('a')] }),
    cur: body({ tools: [tool('Bash'), tool('Grep')], sys: [K.skills('one and two'), K.agents('a and b')] }),
    timing: T(),
  },
  // A catalog that did not EXIST in prev is session warmup, not a reload — one churn, not two.
  catalog_first_appearance: {
    prev: body({ tools: [tool('Bash')], sys: ['plain prose'] }),
    cur: body({ tools: [tool('Bash'), tool('Grep')], sys: [K.skills('one')] }),
    timing: T(),
  },

  // ── 3. request parameters ─────────────────────────────────────────────────────
  param_thinking: {
    prev: body({ thinking: { type: 'enabled', budget_tokens: 1000 } }),
    cur: body({ thinking: { type: 'enabled', budget_tokens: 2000 } }),
    timing: T(),
  },
  param_effort: {
    prev: body({ output_config: { effort: 'low' } }),
    cur: body({ output_config: { effort: 'high' } }),
    timing: T(),
  },
  param_tool_choice: {
    prev: body({ tool_choice: { type: 'auto' } }),
    cur: body({ tool_choice: { type: 'tool', name: 'Bash' } }),
    timing: T(),
  },
  param_speed: { prev: body({ speed: 'standard' }), cur: body({ speed: 'fast' }), timing: T() },
  // ABSENT → EXPLICIT is a documented no-op and must NOT be claimed; with nothing else changed the
  // ladder walks all the way to the timing floor.
  param_absent_to_present: { prev: body({}), cur: body({ output_config: { effort: 'high' } }), timing: T({ gapMs: 1000 }) },

  // ── 4. the env / git regions ─────────────────────────────────────────────────
  env_changed: {
    prev: body({ sys: [`prose\n${ENV('/w/one')}`] }),
    cur: body({ sys: [`prose\n${ENV('/w/two')}`] }),
    timing: T(),
  },
  git_changed: {
    prev: body({ sys: [`prose\n${GIT('aaaaaaa')}`] }),
    cur: body({ sys: [`prose\n${GIT('bbbbbbb')}`] }),
    timing: T(),
  },
  // The env region differs ONLY by a clock: envNorm is equal, so the region rule stands down and
  // the block diff names the timestamp.
  env_and_timestamp: {
    prev: body({ sys: [`<env>\nWorking directory: /w/one\nToday's date is 2026-08-20\n</env>`] }),
    cur: body({ sys: [`<env>\nWorking directory: /w/one\nToday's date is 2026-08-21\n</env>`] }),
    timing: T(),
  },

  // ── 5. system blocks ─────────────────────────────────────────────────────────
  sys_timestamp: { prev: body({ sys: [K.date('2026-08-20')] }), cur: body({ sys: [K.date('2026-08-21')] }), timing: T() },
  sys_postcompact: { prev: body({ sys: ['prose'] }), cur: body({ sys: [K.post()] }), timing: T() },
  // The billing header changes every turn and is NOT in the cache key — dropped before the diff, so
  // this pair is byte-identical where it matters and falls through to timing.
  sys_billing_header_ignored: {
    prev: body({ sys: [K.meta('2.1.229'), 'stable prose'] }),
    cur: body({ sys: [K.meta('2.1.230'), 'stable prose'] }),
    timing: T({ gapMs: 90 * 60_000 }),
  },
  sys_skill_injection: {
    prev: body({ sys: ['prose', 'more prose'] }),
    cur: body({ sys: ['prose', K.skills('one')] }),
    timing: T(),
  },
  sys_skill_truncation: {
    prev: body({ sys: [K.skills('a-very-long-list-of-skill-names-that-fills-the-catalog-out')] }),
    cur: body({ sys: [K.skills('short')] }),
    timing: T(),
  },
  sys_order_changed: {
    prev: body({ sys: ['alpha block', 'beta block'] }),
    cur: body({ sys: ['beta block', 'alpha block'] }),
    timing: T(),
  },
  sys_generic_change: { prev: body({ sys: [K.claudemd('be good')] }), cur: body({ sys: [K.claudemd('be better')] }), timing: T() },
  sys_shrank: { prev: body({ sys: ['alpha block', 'beta block'] }), cur: body({ sys: ['alpha block'] }), timing: T() },

  // ── 5b. message blocks ───────────────────────────────────────────────────────
  // msg[0] usertext differing on BOTH sides = two conversations sharing a session id.
  msg0_interleave: {
    prev: body({ msgs: [[K.user('conversation A opening')]] }),
    cur: body({ msgs: [[K.user('conversation B opening')]] }),
    timing: T(),
  },
  // msg[0] differing where the KIND is not usertext is a real file change, not an interleave.
  msg0_memory_change: {
    prev: body({ msgs: [[K.claudemd('rev 1')]] }),
    cur: body({ msgs: [[K.claudemd('rev 2')]] }),
    timing: T(),
  },
  msg_spliced: {
    prev: body({ msgs: [[K.user('one'), K.user('two')]] }),
    cur: body({ msgs: [[K.user('one'), K.hook('injected'), K.user('two')]] }),
    timing: T(),
  },
  // A splice whose content matches NO kind matcher still gets the STRUCTURE named — never
  // UNCLASSIFIED, and never CONTEXT_ORDER_CHANGED, whose "identical content" claim would be false.
  // The divergence is deliberately in msg[1]: an unrecognised-kind change at msg[0] is claimed by
  // the interleave rule ABOVE these branches (measured — the first draft of this case reported
  // SUBAGENT_INTERLEAVE, which is the TS behaving correctly and the FIXTURE testing nothing).
  msg_spliced_unknown_kind: {
    prev: body({ msgs: [[K.user('root')], [K.user('one'), K.user('two')]] }),
    cur: body({ msgs: [[K.user('root')], [K.user('one'), K.user('mystery'), K.user('two')]] }),
    timing: T(),
  },
  // The mirror image: prev's block was REMOVED and cur's shifted UP. The culprit is the removed
  // block, never the untouched one that merely moved. Same msg[1] reason as above.
  msg_trimmed_midway: {
    prev: body({ msgs: [[K.user('root')], [K.user('one'), K.user('two'), K.user('three')]] }),
    cur: body({ msgs: [[K.user('root')], [K.user('one'), K.user('three')]] }),
    timing: T(),
  },
  msg_growth: {
    prev: body({ msgs: [[K.user('one')]] }),
    cur: body({ msgs: [[K.user('one'), K.user('two')]] }),
    timing: T(),
  },

  // ── 6. the timing floor ──────────────────────────────────────────────────────
  timing_1h: { prev: body({}), cur: body({}), timing: T({ gapMs: 61 * 60_000 }) },
  // Inside the 4.5-6m window — and BELOW the nominal 5m, which is the whole point of the window.
  timing_4m42s: { prev: body({}), cur: body({}), timing: T({ gapMs: 282_000 }) },
  timing_over_5m: { prev: body({}), cur: body({}), timing: T({ gapMs: 7 * 60_000 }) },
  lookback_overflow: {
    prev: body({}),
    cur: body({}),
    timing: T({ gapMs: 1000, cacheReadTokens: 0, cacheCreateTokens: 500_000, blocksAddedSinceLastWrite: 25 }),
  },
  // Same shape, one block short of the window → NOT an overflow; it is a cold read.
  lookback_under_window: {
    prev: body({}),
    cur: body({}),
    timing: T({ gapMs: 1000, cacheReadTokens: 0, cacheCreateTokens: 500_000, blocksAddedSinceLastWrite: 19 }),
  },
  unclassified: { prev: body({}), cur: body({}), timing: T({ gapMs: 1000 }) },
}

const prefixOf = (b) => (b === null || b === undefined ? null : extractTurnPrefix(b))
const out = { cases: {} }
for (const [name, raw] of Object.entries(CASES)) {
  // `any` because most cases carry no `prev2` at all and the editor's checkJs otherwise reads the
  // union as "that property does not exist".
  const c = /** @type {any} */ (raw)
  out.cases[name] = {
    prev: c.prev ?? null,
    cur: c.cur,
    prev2: c.prev2 ?? null,
    timing: c.timing,
    verdict: classifyCacheBreak(prefixOf(c.prev), extractTurnPrefix(c.cur), c.timing, prefixOf(c.prev2)),
  }
}
fs.writeFileSync(path.join(HERE, 'cbverdict-expected.json'), JSON.stringify(out, null, 2) + '\n')
console.log('wrote cbverdict-expected.json —', Object.keys(out.cases).length, 'cases')
for (const [k, v] of Object.entries(out.cases)) {
  console.log(` ${k}: ${v.verdict.cause} / ${v.verdict.culpritLayer} / ${v.verdict.culpritId}`)
}
