import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  extractTurnPrefix, classifyCacheBreak, buildCacheBreakTimeline, buildCauseCostPeakReport, formatTimeline,
  defaultBodiesDir, CACHE_BREAK_REMEDIATION, EXPECTED_CAUSES,
  type RawRequestForBreak, type BreakTiming,
} from '../cacheBreakTimeline'
import { loadScaledTimeout, skipIfUnmeasurable } from './loadAware'

// TRDD-6TQ2FBUR — REAL tests for the cache-break ROOT-CAUSE timeline. The classifier tests build a
// synthetic before/after request pair per cause code and prove the classifier names the right culprit.
// The integration tests write real request/response JSON files to a tmp dir and drive the actual
// bounded disk scan + the actual previous_message_id chain reconstruction + the repeat-offender rollup.
// The only "skip if absent" test reads the machine's real ~/.agentlens/otel-bodies directory (CI-absent).

const CC = { type: 'ephemeral' as const }

// A minimal-but-real Anthropic request body. Overrides drive the one dimension a test varies.
function reqBody(o: {
  model?: string
  thinking?: unknown
  tools?: Array<{ name: string; description?: string; input_schema?: unknown; defer_loading?: boolean }>
  system?: Array<{ text: string; cache_control?: unknown }>
  messages?: RawRequestForBreak['messages']
  sessionId?: string
  previousMessageId?: string
} = {}): RawRequestForBreak {
  return {
    model: o.model ?? 'claude-opus-4-8',
    thinking: o.thinking ?? { type: 'adaptive' },
    tools: o.tools ?? [{ name: 'Bash', description: 'run a shell command' }, { name: 'Read', description: 'read a file' }],
    system: o.system ?? [{ type: 'text', text: 'You are a helpful agent.', cache_control: CC }],
    messages: o.messages ?? [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: CC }] }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: o.sessionId ? 'acct-' + o.sessionId : 'acct-1', session_id: o.sessionId ?? 'sess-1' }) },
    diagnostics: o.previousMessageId ? { previous_message_id: o.previousMessageId } : undefined,
  }
}

const TIMING: BreakTiming = { gapMs: 60_000, cacheReadTokens: 100_000, cacheCreateTokens: 200_000, ephemeral5mTokens: 200_000, ephemeral1hTokens: 0 }

// Classify a prev→cur transition built from two request-body overrides.
function classify(prevBody: RawRequestForBreak, curBody: RawRequestForBreak, timing: BreakTiming = TIMING) {
  const prev = extractTurnPrefix(prevBody)
  const cur = extractTurnPrefix(curBody)
  assert.ok(cur, 'cur prefix must parse')
  return classifyCacheBreak(prev, cur!, timing)
}

// A message with an injected cache-controlled text block (so it lands in the cached message prefix).
function injectedMsg(text: string): RawRequestForBreak['messages'] {
  return [{ role: 'user', content: [{ type: 'text', text, cache_control: CC }] }]
}

suite('cacheBreakTimeline — classifyCacheBreak (one synthetic before/after per cause code)', () => {
  test('MODEL_SWITCH — model changed, everything else identical', () => {
    const v = classify(reqBody({ model: 'claude-opus-4-8' }), reqBody({ model: 'claude-haiku-4-5' }))
    assert.strictEqual(v.cause, 'MODEL_SWITCH')
    assert.strictEqual(v.culpritLayer, 'model')
  })

  // The extended-thinking case moved to its own documented cause (THINKING_CONFIG_CHANGED) in
  // TRDD-B9ERTBZ9 — see that suite. EFFORT_SWITCH is now the residual for a request parameter with
  // no specific detector (today: `speed` / fast mode), so it is tested there too.

  test('TOOLSET_CHANGED — a non-deferred non-MCP tool added', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'TOOLSET_CHANGED')
    assert.ok(v.culpritSummary.includes('Write'))
  })

  test('TOOLS_REORDERED — same tool set, different order', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }] })
    const cur = reqBody({ tools: [{ name: 'Write' }, { name: 'Read' }, { name: 'Bash' }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'TOOLS_REORDERED')
  })

  test('TOOL_SEARCH_DEFERRED — a newly-present deferred tool loaded mid-session', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'NotebookEdit', defer_loading: true }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'TOOL_SEARCH_DEFERRED')
    assert.ok(v.culpritSummary.includes('NotebookEdit'))
  })

  test('MCP_TOOLS_CHANGED — an mcp__ tool added (non-deferred)', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'mcp__slack__send' }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'MCP_TOOLS_CHANGED')
    assert.ok(v.culpritSummary.includes('mcp__slack__send'))
  })

  test('SYSTEM_TIMESTAMP — only diff is a moving date in a system block', () => {
    const prev = reqBody({ system: [{ text: 'billing', cache_control: CC }, { text: "Today's date is 2026-07-08", cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'billing', cache_control: CC }, { text: "Today's date is 2026-07-09", cache_control: CC }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'SYSTEM_TIMESTAMP')
  })

  test('CLAUDE_MD_CHANGED — injected CLAUDE.md content changed (not a date)', () => {
    const prev = reqBody({ system: [{ text: 'Contents of /w/CLAUDE.md (project):\n\nrule alpha applies', cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'Contents of /w/CLAUDE.md (project):\n\nrule beta applies now', cache_control: CC }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'CLAUDE_MD_CHANGED')
  })

  test('billing header change is NOT blamed — agentmeta is cache-excluded (falls through to timing)', () => {
    // The billing header (cc_prev_req/cc_version) mutates on EVERY turn yet long sessions measure >95%
    // cache_read — proof Anthropic excludes it from the cache key. Blaming it produced a false
    // SYSTEMATIC verdict masking the true cause (TTL / message-prefix), so diffBlocks filters agentmeta
    // before the positional diff; with nothing else differing the verdict must land in the timing layer.
    const prev = reqBody({ system: [{ text: 'x-anthropic-billing-header: cc_version=2.1.204.d03; cc_entrypoint=cli;', cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'x-anthropic-billing-header: cc_version=2.1.205.a01; cc_entrypoint=cli;', cache_control: CC }] })
    const v = classify(prev, cur)
    assert.notStrictEqual(v.cause, 'AGENT_METADATA_CHANGED')
    assert.strictEqual(v.culpritLayer, 'timing')
  })

  test('AGENT_METADATA_CHANGED — the agent-types catalog changed (still cache-relevant)', () => {
    const prev = reqBody({ system: [{ text: 'Available agent types for the Agent tool:\n- scout\n- judge', cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'Available agent types for the Agent tool:\n- scout\n- judge\n- kraken', cache_control: CC }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'AGENT_METADATA_CHANGED')
  })

  test('SKILL_CHANGED — available-skills catalog content changed (grew)', () => {
    const prev = reqBody({ messages: injectedMsg('The following skills are available for use with the Skill tool:\n- alpha\n- beta') })
    const cur = reqBody({ messages: injectedMsg('The following skills are available for use with the Skill tool:\n- alpha\n- beta\n- gamma-added') })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'SKILL_CHANGED')
  })

  test('SKILL_INJECTION — a skill catalog appears where there was none', () => {
    const stable = 'stable trailing user text block that does not change'
    const prev = reqBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'lead text' }, { type: 'text', text: stable, cache_control: CC }] }] })
    const cur = reqBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'lead text' }, { type: 'text', text: 'The following skills are available for use with the Skill tool:\n- alpha' }, { type: 'text', text: stable, cache_control: CC }] }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'SKILL_INJECTION')
  })

  test('SKILL_DESCRIPTION_TRUNCATION — the skill catalog shrank turn-to-turn', () => {
    const long = 'The following skills are available for use with the Skill tool:\n' + Array.from({ length: 40 }, (_, i) => `- skill-${i}: a fairly long description of what skill ${i} does in detail`).join('\n')
    const short = 'The following skills are available for use with the Skill tool:\n- skill-0: short'
    const prev = reqBody({ messages: injectedMsg(long) })
    const cur = reqBody({ messages: injectedMsg(short) })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'SKILL_DESCRIPTION_TRUNCATION')
  })

  test('HOOK_INJECTION — a per-turn hook system-reminder mutated', () => {
    const prev = reqBody({ messages: injectedMsg('<system-reminder>heartbeat hook: inbox has 0 messages</system-reminder>') })
    const cur = reqBody({ messages: injectedMsg('<system-reminder>heartbeat hook: inbox has 2 messages</system-reminder>') })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'HOOK_INJECTION')
  })

  test('HOOK_INJECTION — the PreToolUse hook header is a hook, not usertext', () => {
    // Measured incident (2026-08-13T01:08:10Z, 453,881 tokens, $2.84, report
    // reports/cache-invalidation-research/20260813_040019+0200-unclassified-break-msg363.md):
    // the harness moved its PreToolUse token-spike warning from an appended text block inside a
    // user message to a standalone role:"system" message spliced mid-array. The content matcher
    // covered `PostToolUse:` and `UserPromptSubmit` hook headers but NOT `PreToolUse:`, so the
    // block classified as usertext and a $2.84 full-prefix rewrite landed in UNCLASSIFIED with the
    // actor unnamed. The string below is the real injected header, verbatim from the raw body.
    const HOOK = 'PreToolUse:Edit hook additional context: ⚠ Token spike: this turn output ~10k. Be terse, wrap up the step, or compact — long output is billed at full price.'
    const prev = reqBody({ messages: injectedMsg(HOOK) })
    const cur = reqBody({ messages: injectedMsg(HOOK.replace('~10k', '~20k')) })
    const v = classify(prev, cur)
    // Without the PreToolUse matcher both sides read as usertext, and a usertext↔usertext diff at
    // msg[0] is (correctly) claimed by the SUBAGENT_INTERLEAVE guard — so the failure mode is not
    // merely "UNCLASSIFIED", it is a confidently WRONG cause. The assertion is on the right one.
    assert.strictEqual(v.cause, 'HOOK_INJECTION')
  })

  test('a message SPLICED mid-array is the actor — never the shifted bystander, never UNCLASSIFIED', () => {
    // The structural half of the same incident: the harness inserted a standalone role:"system"
    // message mid-array, shifting every later message +1. Position-wise diffing then blames the
    // SHIFTED block ("changed at pos N") — a bystander — and unknown content lands UNCLASSIFIED.
    const base = [
      { role: 'user', content: [{ type: 'text', text: 'do the thing', cache_control: CC }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done step one', cache_control: CC }] },
      { role: 'user', content: [{ type: 'text', text: 'now step two', cache_control: CC }] },
    ]
    const spliced = [
      base[0], base[1],
      // Content deliberately matches NO kind matcher, so only the structural detector can name it.
      { role: 'system', content: 'entirely novel injected content the matchers have never seen' },
      base[2],
    ]
    const v = classify(reqBody({ messages: base as RawRequestForBreak['messages'] }),
      reqBody({ messages: spliced as RawRequestForBreak['messages'] }))
    assert.strictEqual(v.cause, 'MESSAGE_SPLICED')
    assert.ok(/spliced/.test(v.culpritSummary), `culprit must say spliced, got: ${v.culpritSummary}`)
  })

  test('an in-place rewrite with a DUPLICATE of the old content elsewhere is NOT a splice (review finding 8)', () => {
    // prevFps/curFps are content-only sets that collapse duplicates, so a rewrite of X→Y while a
    // byte-identical copy of X survives elsewhere satisfied the old set-membership splice test. The
    // discriminator is structural: an insertion CHANGES the block count; a rewrite keeps it.
    const HOOK = '<system-reminder>heartbeat hook: inbox has 0 messages</system-reminder>'
    const mk = (mid: string): RawRequestForBreak['messages'] => ([
      { role: 'user', content: [{ type: 'text', text: HOOK, cache_control: CC }] },      // duplicate lives here
      { role: 'user', content: [{ type: 'text', text: mid, cache_control: CC }] },        // this one is rewritten
      { role: 'user', content: [{ type: 'text', text: HOOK, cache_control: CC }] },
    ])
    const v = classify(reqBody({ messages: mk(HOOK) }), reqBody({ messages: mk('<system-reminder>heartbeat hook: inbox has 2 messages</system-reminder>') }))
    assert.notStrictEqual(v.cause, 'MESSAGE_SPLICED', 'equal block counts cannot be an insertion')
    assert.ok(!/spliced/.test(v.culpritSummary), `no splice claim for a rewrite, got: ${v.culpritSummary}`)
  })

  test('a message REMOVED mid-array is MESSAGE_TRIMMED naming the removed block, not the shifted one (review finding 9)', () => {
    const A = { role: 'user', content: [{ type: 'text', text: 'alpha content', cache_control: CC }] }
    const B = { role: 'user', content: [{ type: 'text', text: 'bravo content — the one that gets trimmed', cache_control: CC }] }
    const C = { role: 'user', content: [{ type: 'text', text: 'charlie content', cache_control: CC }] }
    const v = classify(reqBody({ messages: [A, B, C] as RawRequestForBreak['messages'] }),
      reqBody({ messages: [A, C] as RawRequestForBreak['messages'] }))
    assert.strictEqual(v.cause, 'MESSAGE_TRIMMED')
    assert.ok(/bravo|removed/.test(v.culpritSummary), `must name the REMOVED block, got: ${v.culpritSummary}`)
  })

  test('INLINE_EXEC_RESULT_CHANGED — a skill `!`-operator shell result differs', () => {
    const prev = reqBody({ messages: injectedMsg('<local-command-stdout>branch main clean tree abc</local-command-stdout>') })
    const cur = reqBody({ messages: injectedMsg('<local-command-stdout>branch main dirty tree def</local-command-stdout>') })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'INLINE_EXEC_RESULT_CHANGED')
  })

  test('CONTEXT_ORDER_CHANGED — identical blocks injected in a different order', () => {
    const prev = reqBody({ system: [{ text: 'alpha block content', cache_control: CC }, { text: 'beta block content', cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'beta block content', cache_control: CC }, { text: 'alpha block content', cache_control: CC }] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'CONTEXT_ORDER_CHANGED')
  })

  test('COMPACTION — a compaction summary replaced the message prefix', () => {
    const prev = reqBody({ messages: injectedMsg('ordinary earlier conversation content here') })
    const cur = reqBody({ messages: injectedMsg('This session is being continued from a previous conversation that ran out of context. Summary: ...') })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'COMPACTION')
  })

  test('TTL_EXPIRY — identical prefix, a ~5-minute gap expired the cache', () => {
    const body = reqBody()
    const v = classify(body, reqBody(), { gapMs: 5 * 60_000, cacheReadTokens: 50_000, cacheCreateTokens: 180_000, ephemeral5mTokens: 180_000, ephemeral1hTokens: 0 })
    assert.strictEqual(v.cause, 'TTL_EXPIRY')
    assert.strictEqual(v.ttlTier, '5m')
  })

  test('COLD_START — no previous turn to diff against', () => {
    const cur = extractTurnPrefix(reqBody())
    assert.ok(cur)
    const v = classifyCacheBreak(null, cur!, TIMING)
    assert.strictEqual(v.cause, 'COLD_START')
  })

  test('COLD_START — identical prefix, no prior cache_read to break, small gap', () => {
    const v = classify(reqBody(), reqBody(), { gapMs: 30_000, cacheReadTokens: 0, cacheCreateTokens: 90_000, ephemeral5mTokens: 90_000, ephemeral1hTokens: 0 })
    assert.strictEqual(v.cause, 'COLD_START')
  })

  test('UNCLASSIFIED — identical prefix, cache_read present, sub-TTL gap → an unlocalised re-write', () => {
    const v = classify(reqBody(), reqBody(), { gapMs: 30_000, cacheReadTokens: 80_000, cacheCreateTokens: 120_000, ephemeral5mTokens: 120_000, ephemeral1hTokens: 0 })
    assert.strictEqual(v.cause, 'UNCLASSIFIED')
    assert.ok(v.rawDiffSummary && v.rawDiffSummary.length > 0)
  })

  test('a structural prefix change ALWAYS beats a timing gap (tool change wins over a 5m gap)', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Write' }] })
    const v = classify(prev, cur, { gapMs: 5 * 60_000, cacheReadTokens: 10_000, cacheCreateTokens: 200_000, ephemeral5mTokens: 200_000, ephemeral1hTokens: 0 })
    assert.strictEqual(v.cause, 'TOOLSET_CHANGED')
  })
})

// ── TRDD-B9ERTBZ9 — the documented causes the classifier used to lack ─────────────────────────────
// Every fixture below reproduces a shape MEASURED in the machine's real captured bodies on
// 2026-08-04 (1,377 requests in the live spool), with the identity-bearing values replaced by
// placeholders: the two environment-block spellings (`<env>` for SDK/sub-agent requests,
// `# Environment` for the CLI), the `gitStatus:` snapshot with its trailing prose, the real
// `output_config: {effort}` param (present on every sampled request, and invisible to the old
// classifier), and the 4-of-1,377 requests that carry NO cache_control marker at all.
// Synthetic-only fixtures were what hid BOTH method errors behind TRDD-V8YOWHVT, so the shapes are
// real even though the values are not.
const ENV_SDK = (cwd: string) =>
  `<env>\nWorking directory: ${cwd}\nIs directory a git repo: Yes\nAdditional working directories: /tmp\nPlatform: darwin\nShell: zsh\nOS Version: Darwin 25.6.0\n</env>\nYou are powered by the model named Opus 5.`
const ENV_CLI = (cwd: string) =>
  `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: true\n - Additional working directories:\n  - /tmp\n - Platform: darwin\n - Shell: zsh\n - OS Version: Darwin 25.6.0\n\n# Scratchpad Directory\n\nIMPORTANT: use the scratchpad.`
const GIT_BLOCK = (branch: string, sha: string) =>
  `gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\n\nCurrent branch: ${branch}\n\nMain branch (you will usually use this for PRs): main\n\nGit user: tester\n\nStatus:\n(clean)\n\nRecent commits:\n${sha} feat: the most recent commit subject\n`
const TRAILING_PROSE = '\nIf you intend to call multiple tools, make all of the independent calls in the same block.'

/** A request whose ONE cache-controlled system block carries the harness prose we are varying. */
function sysReq(text: string, extra: Partial<RawRequestForBreak> = {}): RawRequestForBreak {
  return { ...reqBody({ system: [{ text, cache_control: CC }] }), ...extra }
}

suite('cacheBreakTimeline — TRDD-B9ERTBZ9 documented causes (env / git / params / lookback / minimum)', () => {
  test('WORKING_DIR_CHANGED — the <env> working directory differs (SDK spelling)', () => {
    const v = classify(sysReq(ENV_SDK('/Users/tester/proj-alpha')), sysReq(ENV_SDK('/Users/tester/proj-beta')))
    assert.strictEqual(v.cause, 'WORKING_DIR_CHANGED')
    assert.strictEqual(v.culpritLayer, 'system')
  })

  test('WORKING_DIR_CHANGED — the same detector reads the CLI `# Environment` spelling', () => {
    const v = classify(sysReq(ENV_CLI('/Users/tester/proj-alpha')), sysReq(ENV_CLI('/Users/tester/proj-alpha/.claude/worktrees/wt1')))
    assert.strictEqual(v.cause, 'WORKING_DIR_CHANGED')
  })

  test('the env detector does NOT steal a pure timestamp move (SYSTEM_TIMESTAMP still wins)', () => {
    const a = sysReq(ENV_SDK('/Users/tester/proj-alpha') + "\nToday's date is 2026-08-03")
    const b = sysReq(ENV_SDK('/Users/tester/proj-alpha') + "\nToday's date is 2026-08-04")
    assert.strictEqual(classify(a, b).cause, 'SYSTEM_TIMESTAMP')
  })

  test('GIT_STATE_CHANGED — the startup git snapshot differs (branch + head commit)', () => {
    const a = sysReq(ENV_SDK('/Users/tester/proj-alpha') + '\n' + GIT_BLOCK('main', 'aaaaaaa'))
    const b = sysReq(ENV_SDK('/Users/tester/proj-alpha') + '\n' + GIT_BLOCK('feat/x', 'bbbbbbb'))
    const v = classify(a, b)
    assert.strictEqual(v.cause, 'GIT_STATE_CHANGED')
  })

  test('the git region STOPS at the commit list — trailing harness prose is not blamed on git', () => {
    const git = GIT_BLOCK('main', 'aaaaaaa')
    const a = sysReq(git + TRAILING_PROSE)
    const b = sysReq(git + TRAILING_PROSE.replace('multiple tools', 'several tools'))
    assert.notStrictEqual(classify(a, b).cause, 'GIT_STATE_CHANGED')
  })

  test('THINKING_CONFIG_CHANGED — two explicit thinking configs differ', () => {
    const v = classify(reqBody({ thinking: { type: 'adaptive' } }), reqBody({ thinking: { type: 'enabled', budget_tokens: 10000 } }))
    assert.strictEqual(v.cause, 'THINKING_CONFIG_CHANGED')
    assert.strictEqual(v.culpritLayer, 'effort')
  })

  test('EFFORT_PARAM_CHANGED — two explicit output_config.effort values differ', () => {
    const v = classify(sysReq('stable system prose', { output_config: { effort: 'high' } }),
      sysReq('stable system prose', { output_config: { effort: 'xhigh' } }))
    assert.strictEqual(v.cause, 'EFFORT_PARAM_CHANGED')
  })

  test('EFFORT_PARAM_CHANGED does NOT fire when effort goes absent→explicit (the documented no-op)', () => {
    // "Setting effort explicitly to the model's default is equivalent to omitting it and does not
    // invalidate." No page enumerates the per-model defaults, so absent→'high' is UNDECIDABLE — and a
    // guess here is exactly the false positive this criterion exists to prevent.
    const v = classify(sysReq('stable system prose'), sysReq('stable system prose', { output_config: { effort: 'high' } }))
    assert.notStrictEqual(v.cause, 'EFFORT_PARAM_CHANGED')
  })

  test('TOOL_CHOICE_CHANGED — two explicit tool_choice values differ', () => {
    const v = classify(sysReq('stable system prose', { tool_choice: { type: 'auto' } }),
      sysReq('stable system prose', { tool_choice: { type: 'any' } }))
    assert.strictEqual(v.cause, 'TOOL_CHOICE_CHANGED')
  })

  test('LOOKBACK_OVERFLOW — unchanged prefix, zero cache_read, ≥20 blocks since the last write', () => {
    const v = classify(reqBody(), reqBody(), {
      gapMs: 30_000, cacheReadTokens: 0, cacheCreateTokens: 300_000,
      ephemeral5mTokens: 300_000, ephemeral1hTokens: 0, blocksAddedSinceLastWrite: 24,
    })
    assert.strictEqual(v.cause, 'LOOKBACK_OVERFLOW')
  })

  test('LOOKBACK_OVERFLOW does NOT replace the honest verdict below the 20-block window', () => {
    const v = classify(reqBody(), reqBody(), {
      gapMs: 30_000, cacheReadTokens: 0, cacheCreateTokens: 300_000,
      ephemeral5mTokens: 300_000, ephemeral1hTokens: 0, blocksAddedSinceLastWrite: 19,
    })
    assert.strictEqual(v.cause, 'COLD_START')
  })

  test('BELOW_MIN_CACHEABLE — markers present, both counters 0, prompt under the model minimum', () => {
    const cur = extractTurnPrefix(reqBody({ model: 'claude-opus-5' }))
    assert.ok(cur)
    const v = classifyCacheBreak(null, cur!, { gapMs: 1000, cacheReadTokens: 0, cacheCreateTokens: 0, ephemeral5mTokens: 0, ephemeral1hTokens: 0 })
    assert.strictEqual(v.cause, 'BELOW_MIN_CACHEABLE')
  })

  test('BELOW_MIN_CACHEABLE reads a PER-MODEL minimum — the same prompt is over 512 and under 4,096', () => {
    // ~2,000 estimated tokens: above Opus 5's 512-token minimum, below Haiku 4.5's 4,096.
    const filler = 'x'.repeat(8000)
    const timing = { gapMs: 1000, cacheReadTokens: 0, cacheCreateTokens: 0, ephemeral5mTokens: 0, ephemeral1hTokens: 0 }
    const opus = extractTurnPrefix(reqBody({ model: 'claude-opus-5', system: [{ text: filler, cache_control: CC }] }))
    const haiku = extractTurnPrefix(reqBody({ model: 'claude-haiku-4-5-20251001', system: [{ text: filler, cache_control: CC }] }))
    assert.ok(opus && haiku)
    assert.notStrictEqual(classifyCacheBreak(null, opus!, timing).cause, 'BELOW_MIN_CACHEABLE')
    assert.strictEqual(classifyCacheBreak(null, haiku!, timing).cause, 'BELOW_MIN_CACHEABLE')
  })

  test('CACHING_DISABLED — no cache_control marker anywhere, and no cache activity to show for it', () => {
    const bare: RawRequestForBreak = {
      model: 'claude-haiku-4-5-20251001',
      thinking: { type: 'adaptive' },
      tools: [],
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize this' }] }],
      metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: 'acct-1', session_id: 'sess-1' }) },
    }
    const cur = extractTurnPrefix(bare)
    assert.ok(cur)
    const v = classifyCacheBreak(null, cur!, { cacheReadTokens: 0, cacheCreateTokens: 0, ephemeral5mTokens: 0, ephemeral1hTokens: 0 })
    // A marker-less request is CACHING_DISABLED even when it is also below the minimum: nothing was
    // ever offered to the cache, so "the prompt was too small" would name a condition that never applied.
    assert.strictEqual(v.cause, 'CACHING_DISABLED')
  })

  // ── TRDD-00NOBU9W — msg[0] is the CONVERSATION's identity, not a mutable block ────────────────
  // Measured over 2,003 consecutive real turn-pairs: 397 of them diverge FIRST at a `usertext`
  // segment of msg[0], and every one is a different SUB-AGENT TASK PROMPT ("You are doing a CODE
  // REVIEW of…", "You are auditing source files…") sharing the parent's session id. Nothing broke —
  // each stream keeps its own cache — yet the block diff filed them as UNCLASSIFIED and the report
  // crowned that segment "Dominant AVOIDABLE perpetrator, 23.2%", i.e. told the operator to go fix
  // something that never happened. The user's own first words are immutable within a conversation;
  // the FILES injected around them are not, which is why the discriminator is the segment KIND.
  const AGENT_A = 'You are doing a CODE REVIEW of a diff in the repo /w/proj (a plugin; Rust crate at scripts/x). Get your review scope with: git diff'
  const AGENT_B = 'You are auditing source files in /w/proj for REAL BUGS. Read each file COMPLETELY (offset/limit chunks for files >2000 lines).'

  test('a DIFFERENT msg[0] task prompt is a different conversation — not an avoidable break', () => {
    const v = classify(reqBody({ messages: injectedMsg(AGENT_A) }), reqBody({ messages: injectedMsg(AGENT_B) }))
    assert.strictEqual(v.cause, 'SUBAGENT_INTERLEAVE')
    assert.ok(EXPECTED_CAUSES.has(v.cause), 'a stream switch must rank as EXPECTED, never as a perpetrator')
  })

  test('an injected MEMORY file inside msg[0] is still MEMORY_FILE_CHANGED (the 19% cause survives)', () => {
    const mem = (body: string) => `Contents of /w/.claude/projects/p/memory/MEMORY.md (user's auto-memory, persists across conversations):\n${body}`
    const v = classify(reqBody({ messages: injectedMsg(mem('- [a](a.md) — one line')) }),
      reqBody({ messages: injectedMsg(mem('- [a](a.md) — one line\n- [b](b.md) — another')) }))
    assert.strictEqual(v.cause, 'MEMORY_FILE_CHANGED')
  })

  test('an injected CLAUDE.md inside msg[0] is still CLAUDE_MD_CHANGED', () => {
    const md = (body: string) => `Contents of /w/CLAUDE.md (project instructions):\n${body}`
    const v = classify(reqBody({ messages: injectedMsg(md('rule alpha')) }), reqBody({ messages: injectedMsg(md('rule beta')) }))
    assert.strictEqual(v.cause, 'CLAUDE_MD_CHANGED')
  })

  test('a compaction that rewrites msg[0] is still COMPACTION, not a stream switch', () => {
    const v = classify(reqBody({ messages: injectedMsg(AGENT_A) }),
      reqBody({ messages: injectedMsg('This session is being continued from a previous conversation that ran out of context. Summary: …') }))
    assert.strictEqual(v.cause, 'COMPACTION')
  })

  test('a usertext change at a LATER message is NOT a stream switch — only msg[0] carries identity', () => {
    const tail = { type: 'text' as const, text: 'stable tail block', cache_control: CC }
    const msgs = (mid: string): RawRequestForBreak['messages'] => [
      { role: 'user', content: [{ type: 'text', text: AGENT_A }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: mid }, tail] },
    ]
    const v = classify(reqBody({ messages: msgs('first follow-up') }), reqBody({ messages: msgs('a different follow-up') }))
    assert.notStrictEqual(v.cause, 'SUBAGENT_INTERLEAVE')
  })

  test('every new cause carries a remediation stating its CONDITION, never an absolute', () => {
    // The lesson from c6802f0: the reload/MCP remediation asserted an unconditional reset that the
    // docs contradict. A remediation that names no condition is how that error gets re-shipped.
    const added = [
      'WORKING_DIR_CHANGED', 'GIT_STATE_CHANGED', 'THINKING_CONFIG_CHANGED', 'EFFORT_PARAM_CHANGED',
      'TOOL_CHOICE_CHANGED', 'LOOKBACK_OVERFLOW', 'BELOW_MIN_CACHEABLE', 'CACHING_DISABLED',
    ] as const
    for (const cause of added) {
      const text = CACHE_BREAK_REMEDIATION[cause]
      assert.ok(text && text.length > 40, `${cause} needs a real remediation`)
      assert.ok(/\bonly\b|\bwhen\b|\bunless\b|\bnever fires\b/i.test(text),
        `${cause} remediation must state the CONDITION it fires under, not an absolute: ${text}`)
    }
  })
})

// ── Integration: real disk scan + chain reconstruction + repeat-offender rollup ──────────────────
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cbtimeline-'))
suiteTeardown(() => { try { fs.rmSync(tmpBase, { recursive: true, force: true }) } catch { /* best effort */ } })

let dirCounter = 0
function freshDir(): string {
  const d = path.join(tmpBase, `s${++dirCounter}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
function writeAt(dir: string, name: string, body: unknown, mtimeMs: number): void {
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(body))
  const t = new Date(mtimeMs)
  fs.utimesSync(p, t, t)
}
function respBody(id: string, cacheCreate: number, cacheRead = 50_000, model = 'claude-opus-4-8', output = 5) {
  return { id, model, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, cache_creation: { ephemeral_5m_input_tokens: cacheCreate, ephemeral_1h_input_tokens: 0 } } }
}

suite('cacheBreakTimeline — buildCacheBreakTimeline (disk scan + previous_message_id chain)', () => {
  // Build a 5-turn session whose per-turn injected HOOK block mutates every turn, so turns 2/3/4 all
  // break the cache with the SAME culprit element → one SYSTEMATIC repeat-offender.
  test('a hook that mutates every turn becomes ONE flagged SYSTEMATIC repeat-offender', async () => {
    const dir = freshDir()
    const sid = 'sess-hook'
    const base = Date.now() - 3_600_000
    const respIds = ['msg_h1', 'msg_h2', 'msg_h3', 'msg_h4', 'msg_h5']
    for (let i = 0; i < 5; i++) {
      const prevId = i === 0 ? 'msg_root' : respIds[i - 1]
      const req = reqBody({
        sessionId: sid, previousMessageId: prevId,
        messages: injectedMsg(`<system-reminder>heartbeat hook fired; inbox has ${i} messages pending</system-reminder>`),
      })
      writeAt(dir, `r${i}.request.json`, req, base + i * 60_000)
      // Response i is paired to request i; its id becomes request i+1's previous_message_id.
      writeAt(dir, `resp${i}.response.json`, respBody(respIds[i], 200_000), base + i * 60_000 + 30_000)
    }

    const report = await buildCacheBreakTimeline({ bodiesDir: dir, sessionId: sid, minTokens: 5000 })
    assert.strictEqual(report.sessionId, sid)
    assert.ok(report.turnsInSession >= 5)
    // Turns 2,3,4 are HOOK_INJECTION (turn 1 is COLD_START; turn 5 has no following request → unpaired).
    const hookEvents = report.events.filter(e => e.cause === 'HOOK_INJECTION')
    assert.strictEqual(hookEvents.length, 3, 'expected 3 hook-injection break events')
    // The chronic-offender rollup collapses them into ONE flagged systematic offender.
    const off = report.repeatOffenders.find(o => o.cause === 'HOOK_INJECTION')
    assert.ok(off, 'expected a HOOK_INJECTION repeat-offender')
    assert.strictEqual(off!.occurrences, 3)
    assert.strictEqual(off!.systematic, true)
    assert.ok(off!.totalCacheCreateTokens >= 600_000)
    assert.ok(off!.medianCacheCreateTokens > 0)
    assert.ok(off!.pctOfSessionCacheCreate > 0)
    assert.ok(off!.verdict.startsWith('SYSTEMATIC'), 'the verdict must flag it SYSTEMATIC')
    // The busiest offender ranks first.
    assert.strictEqual(report.repeatOffenders[0].cause, 'HOOK_INJECTION')
  })

  test('a one-off tool change is NOT flagged systematic (below the ≥3-turn threshold)', async () => {
    const dir = freshDir()
    const sid = 'sess-oneoff'
    const base = Date.now() - 3_600_000
    const respIds = ['msg_o1', 'msg_o2', 'msg_o3']
    // 3 requests: turn 2 adds a tool ONCE; turns are otherwise identical.
    const toolsA = [{ name: 'Bash' }, { name: 'Read' }]
    const toolsB = [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }]
    const perTurnTools = [toolsA, toolsB, toolsB]
    for (let i = 0; i < 3; i++) {
      const prevId = i === 0 ? 'msg_root' : respIds[i - 1]
      writeAt(dir, `r${i}.request.json`, reqBody({ sessionId: sid, previousMessageId: prevId, tools: perTurnTools[i] }), base + i * 60_000)
      writeAt(dir, `resp${i}.response.json`, respBody(respIds[i], 150_000), base + i * 60_000 + 30_000)
    }
    const report = await buildCacheBreakTimeline({ bodiesDir: dir, sessionId: sid, minTokens: 5000 })
    const toolOff = report.repeatOffenders.find(o => o.cause === 'TOOLSET_CHANGED')
    assert.ok(toolOff, 'the single tool change is still recorded as an offender')
    assert.strictEqual(toolOff!.occurrences, 1)
    assert.strictEqual(toolOff!.systematic, false)
  })

  test('coverage reports honest scan bounds and an absent directory never throws', async () => {
    const missing = path.join(tmpBase, 'nope-' + Math.random().toString(36).slice(2))
    const report = await buildCacheBreakTimeline({ bodiesDir: missing })
    assert.strictEqual(report.coverage.dirExists, false)
    assert.strictEqual(report.events.length, 0)
    assert.ok(report.coverage.note.includes('OTEL_LOG_RAW_API_BODIES'))
  })

  test('is POINTER-ONLY: raw block text / base64 / device_id never cross the boundary', async () => {
    const dir = freshDir()
    const sid = 'sess-ptr'
    const base = Date.now() - 3_600_000
    const secret = 'SENSITIVE_SECRET_PROMPT_TEXT_' + 'Z'.repeat(200)
    const respIds = ['msg_p1', 'msg_p2', 'msg_p3']
    for (let i = 0; i < 3; i++) {
      const prevId = i === 0 ? 'msg_root' : respIds[i - 1]
      writeAt(dir, `r${i}.request.json`, reqBody({ sessionId: sid, previousMessageId: prevId, messages: injectedMsg(`<system-reminder>heartbeat hook ${i}: ${secret}</system-reminder>`) }), base + i * 60_000)
      writeAt(dir, `resp${i}.response.json`, respBody(respIds[i], 120_000), base + i * 60_000 + 30_000)
    }
    const report = await buildCacheBreakTimeline({ bodiesDir: dir, sessionId: sid, minTokens: 5000 })
    const serialized = JSON.stringify(report)
    assert.ok(!serialized.includes(secret), 'raw injected block text must never cross the boundary')
    assert.ok(!serialized.includes('dev-1'), 'the device_id from metadata.user_id must never cross the boundary')
    assert.ok(serialized.includes(sid), 'the session id (an identifier) is expected in the report')
  })

  test('formatTimeline renders markdown / table / timeline strings; json returns the object', async () => {
    const dir = freshDir()
    const sid = 'sess-fmt'
    const base = Date.now() - 3_600_000
    const respIds = ['msg_f1', 'msg_f2', 'msg_f3']
    for (let i = 0; i < 3; i++) {
      const prevId = i === 0 ? 'msg_root' : respIds[i - 1]
      writeAt(dir, `r${i}.request.json`, reqBody({ sessionId: sid, previousMessageId: prevId, messages: injectedMsg(`<system-reminder>hook heartbeat ${i}</system-reminder>`) }), base + i * 60_000)
      writeAt(dir, `resp${i}.response.json`, respBody(respIds[i], 100_000), base + i * 60_000 + 30_000)
    }
    const report = await buildCacheBreakTimeline({ bodiesDir: dir, sessionId: sid, minTokens: 5000 })
    assert.strictEqual(formatTimeline(report, 'json'), report)
    for (const fmt of ['markdown', 'table', 'timeline'] as const) {
      const out = formatTimeline(report, fmt) as { format: string; text: string }
      assert.strictEqual(out.format, fmt)
      assert.ok(typeof out.text === 'string' && out.text.length > 0)
    }
  })
})

// ── D2: buildCauseCostPeakReport (get_cache_creation_report's groupBy=cause dimension) ──────────────
suite('cacheBreakTimeline — buildCauseCostPeakReport (cross-session cause cost-peak)', () => {
  test('aggregates break events by CAUSE across ALL sessions in the scan, not just one target', async () => {
    const dir = freshDir()
    const base = Date.now() - 3_600_000

    // Session "sess-hook": 5 turns, same shape as the single-session repeat-offender fixture — turn0 is
    // COLD_START (no prior turn to diff against), turns 1-3 mutate the hook block each time -> 3
    // HOOK_INJECTION break events, turn4 has no following request so its own cc is unmeasured. The turn
    // i cache_creation is billed on the response REFERENCED BY turn i+1's previousMessageId (the proven
    // previous_message_id chain — see the module doc), so N+1 requests are needed to measure N turns.
    const hookRespIds = ['msg_hk0', 'msg_hk1', 'msg_hk2', 'msg_hk3', 'msg_hk4']
    for (let i = 0; i < 5; i++) {
      const prevId = i === 0 ? 'msg_hkroot' : hookRespIds[i - 1]
      writeAt(dir, `hk${i}.request.json`, reqBody({ sessionId: 'sess-hook', previousMessageId: prevId, messages: injectedMsg(`<system-reminder>heartbeat hook fired; inbox has ${i} messages pending</system-reminder>`) }), base + i * 60_000)
      writeAt(dir, `hkresp${i}.response.json`, respBody(hookRespIds[i], 40_000), base + i * 60_000 + 30_000)
    }

    // Session "sess-tool": turn0 baseline tools (COLD_START, its cc measured via turn1); turn1 adds ONE
    // tool -> ONE TOOLSET_CHANGED event (measured via turn2's previousMessageId); turn2 is just the
    // closing request that makes turn1's write measurable — its own cc is unmeasured (no turn3).
    const toolsA = [{ name: 'Bash' }, { name: 'Read' }]
    const toolsB = [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }]
    writeAt(dir, 'tl0.request.json', reqBody({ sessionId: 'sess-tool', previousMessageId: 'msg_tlroot', tools: toolsA }), base)
    writeAt(dir, 'tlresp0.response.json', respBody('msg_tl0', 100), base + 30_000) // turn0's own cc (COLD_START) — below minTokens, excluded
    writeAt(dir, 'tl1.request.json', reqBody({ sessionId: 'sess-tool', previousMessageId: 'msg_tl0', tools: toolsB }), base + 60_000)
    writeAt(dir, 'tlresp1.response.json', respBody('msg_tl1', 20_000), base + 90_000) // bills turn1's TOOLSET_CHANGED write
    writeAt(dir, 'tl2.request.json', reqBody({ sessionId: 'sess-tool', previousMessageId: 'msg_tl1', tools: toolsB }), base + 120_000)

    const report = await buildCauseCostPeakReport({ bodiesDir: dir, minTokens: 5000 })
    assert.strictEqual(report.groupBy, 'cause')
    assert.strictEqual(report.bucket, 'cache_creation')

    const hookGroup = report.groups.find(g => g.key === 'HOOK_INJECTION')
    const toolGroup = report.groups.find(g => g.key === 'TOOLSET_CHANGED')
    assert.ok(hookGroup, 'expected a HOOK_INJECTION cause group aggregated across sess-hook')
    assert.ok(toolGroup, 'expected a TOOLSET_CHANGED cause group from sess-tool')
    assert.strictEqual(hookGroup!.events, 3)
    assert.strictEqual(hookGroup!.cacheCreateTokens, 120_000)
    assert.strictEqual(toolGroup!.events, 1)
    assert.strictEqual(toolGroup!.cacheCreateTokens, 20_000)
    // Heaviest cause (by cache_creation) ranks first.
    assert.strictEqual(report.groups[0].key, 'HOOK_INJECTION')
  })

  test('bucket=output surfaces an OUTPUT-token-spike cause even when cache_creation ranks a different cause first', async () => {
    const dir = freshDir()
    const base = Date.now() - 3_600_000

    // Session "sess-modelswitch": turn0 baseline (COLD_START); turn1 MODEL_SWITCH with a modest
    // cache_creation write (just above the minTokens=5000 floor — the classifier's floor is always on
    // cache_creation, regardless of the ranking bucket) but a HUGE output-token spike (billed ~5x);
    // turn2 is the closing request that makes turn1's write measurable (see the note in the test above).
    writeAt(dir, 'ms0.request.json', reqBody({ sessionId: 'sess-modelswitch', previousMessageId: 'msg_msroot', model: 'claude-opus-4-8' }), base)
    writeAt(dir, 'msresp0.response.json', respBody('msg_ms0', 100, 50_000, 'claude-opus-4-8'), base + 30_000)
    writeAt(dir, 'ms1.request.json', reqBody({ sessionId: 'sess-modelswitch', previousMessageId: 'msg_ms0', model: 'claude-haiku-4-5' }), base + 60_000)
    writeAt(dir, 'msresp1.response.json', respBody('msg_ms1', 6000, 50_000, 'claude-haiku-4-5', 90_000), base + 90_000)
    writeAt(dir, 'ms2.request.json', reqBody({ sessionId: 'sess-modelswitch', previousMessageId: 'msg_ms1', model: 'claude-haiku-4-5' }), base + 120_000)

    // Session "sess-hook2": turn0 baseline hook value (COLD_START); turn1 HOOK_INJECTION with a big
    // cache_creation write but a tiny output; turn2 closes turn1's measurement.
    writeAt(dir, 'hk0.request.json', reqBody({ sessionId: 'sess-hook2', previousMessageId: 'msg_hkroot2', messages: injectedMsg('<system-reminder>heartbeat hook: inbox 0</system-reminder>') }), base)
    writeAt(dir, 'hkresp0.response.json', respBody('msg_hk20', 100), base + 30_000)
    writeAt(dir, 'hk1.request.json', reqBody({ sessionId: 'sess-hook2', previousMessageId: 'msg_hk20', messages: injectedMsg('<system-reminder>heartbeat hook: inbox 2</system-reminder>') }), base + 60_000)
    writeAt(dir, 'hkresp1.response.json', respBody('msg_hk21', 50_000, 50_000, 'claude-opus-4-8', 5), base + 90_000)
    writeAt(dir, 'hk2.request.json', reqBody({ sessionId: 'sess-hook2', previousMessageId: 'msg_hk21', messages: injectedMsg('<system-reminder>heartbeat hook: inbox 2</system-reminder>') }), base + 120_000)

    const byCache = await buildCauseCostPeakReport({ bodiesDir: dir, minTokens: 5000 })
    assert.strictEqual(byCache.groups[0].key, 'HOOK_INJECTION', '50000 cache_creation beats 1000 on the default bucket')

    const byOutput = await buildCauseCostPeakReport({ bodiesDir: dir, minTokens: 5000, bucket: 'output' })
    assert.strictEqual(byOutput.bucket, 'output')
    assert.strictEqual(byOutput.groups[0].key, 'MODEL_SWITCH', '90000 output beats 5 on bucket=output')
    assert.strictEqual(byOutput.groups[0].bucketValue, 90_000)

    // The output-spike list surfaces the MODEL_SWITCH turn regardless of which bucket ranked the groups.
    assert.ok(byCache.outputSpikes.top.some(s => s.outputTokens === 90_000 && s.sessionId === 'sess-modelswitch'))
  })

  test('an absent bodies directory returns an empty report, never throwing', async () => {
    const missing = path.join(tmpBase, 'nope-causepeak-' + Math.random().toString(36).slice(2))
    const report = await buildCauseCostPeakReport({ bodiesDir: missing })
    assert.strictEqual(report.groupBy, 'cause')
    assert.strictEqual(report.groups.length, 0)
    assert.strictEqual(report.coverage.dirExists, false)
    assert.ok(report.coverage.note.includes('OTEL_LOG_RAW_API_BODIES'))
  })

  // 🐌 slow — scans the real ~/.agentlens/otel-bodies directory (thousands of files). Skips when the
  // directory is absent (CI / a machine that never enabled OTEL_LOG_RAW_API_BODIES).
  test('builds a cause cost-peak report from the REAL OTEL bodies without crashing', async function () {
    if (!fs.existsSync(defaultBodiesDir())) { this.skip(); return }
    if (skipIfUnmeasurable(this)) return
    this.timeout(loadScaledTimeout(120_000))
    // scanCap is not decoration: this reads a LIVE capture directory that grows all day (measured
    // 1,377 → 5,467 files in one evening on this machine), so an uncapped scan is a test whose
    // runtime is set by how busy the user was — it passed for weeks and then blew a 120 s timeout
    // with no code change. The cap makes the cost of this test a constant.
    const report = await buildCauseCostPeakReport({ windowHours: 5, minTokens: 50_000, scanCap: 300 })
    assert.ok(report.coverage.note.length > 0)
    assert.strictEqual(report.groupBy, 'cause')
    for (const g of report.groups) assert.ok(g.key.length > 0)
  })
})

// ── agent-* child sessions (2026-07-11 field fix) ────────────────────────────────
// A child card's id is `agent-<agentId>` but its API calls carry the PARENT session_id in
// metadata.user_id, so the exact-id lookup returned turnsClassified 0 for every child. The fix
// carves the child's stream out of the parent bucket via the child transcript's message-id chain.
suite('cacheBreakTimeline — agent-* child sessions resolve via the subagents transcript', () => {
  const PARENT = 'aaaa1111-2222-3333-4444-555566667777'
  const CHILD_ID = 'a3c49e3a7b59fd50c'

  function writeChildTranscript(projectsRoot: string, msgIds: string[]): void {
    const dir = path.join(projectsRoot, '-Users-x-proj', PARENT, 'subagents')
    fs.mkdirSync(dir, { recursive: true })
    const lines = [
      JSON.stringify({ type: 'user', sessionId: PARENT, message: { role: 'user', content: 'child task: analyze X' } }),
      ...msgIds.map(id => JSON.stringify({ type: 'assistant', sessionId: PARENT, message: { id, role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })),
    ]
    fs.writeFileSync(path.join(dir, `agent-${CHILD_ID}.jsonl`), lines.join('\n') + '\n')
  }

  // The child conversation's own head block — byte-identical across the child's turns (the
  // stream-head recovery anchor); the parent stream has a different head.
  const childHead = { role: 'user' as const, content: [{ type: 'text' as const, text: 'child task: analyze X in depth', cache_control: CC }] }
  const hookBlock = (i: number) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: `<system-reminder>heartbeat hook: inbox ${i}</system-reminder>`, cache_control: CC }] })

  test('a child timeline classifies the CHILD stream carved out of the parent bucket (head recovered by fingerprint)', async () => {
    const bodies = freshDir()
    const projects = freshDir()
    const base = Date.now() - 3_600_000
    writeChildTranscript(projects, ['msg_c0', 'msg_c1', 'msg_c2'])

    // Parent stream: 3 turns chained on parent msg ids (p0 is the parent's own stream head).
    const parentMsg = (i: number) => ({ role: 'user' as const, content: [{ type: 'text' as const, text: `parent conversation content ${i > 0 ? 'grows' : 'starts'} here`, cache_control: CC }] })
    writeAt(bodies, 'p0.request.json', reqBody({ sessionId: PARENT, messages: [parentMsg(0)] }), base)
    writeAt(bodies, 'presp0.response.json', respBody('msg_p0', 120_000), base + 5_000)
    writeAt(bodies, 'p1.request.json', reqBody({ sessionId: PARENT, previousMessageId: 'msg_p0', messages: [parentMsg(0), parentMsg(1)] }), base + 120_000)
    writeAt(bodies, 'presp1.response.json', respBody('msg_p1', 90_000), base + 125_000)
    writeAt(bodies, 'p2.request.json', reqBody({ sessionId: PARENT, previousMessageId: 'msg_p1', messages: [parentMsg(0), parentMsg(1), parentMsg(2)] }), base + 240_000)

    // Child stream, INTERLEAVED under the SAME session id: c0 (fresh head, no previous id) →
    // c1 (prev msg_c0) → c2 (prev msg_c1).
    writeAt(bodies, 'c0.request.json', reqBody({ sessionId: PARENT, messages: [childHead] }), base + 60_000)
    writeAt(bodies, 'cresp0.response.json', respBody('msg_c0', 180_000, 100), base + 65_000)
    writeAt(bodies, 'c1.request.json', reqBody({ sessionId: PARENT, previousMessageId: 'msg_c0', messages: [childHead, hookBlock(1)] }), base + 180_000)
    writeAt(bodies, 'cresp1.response.json', respBody('msg_c1', 150_000), base + 185_000)
    writeAt(bodies, 'c2.request.json', reqBody({ sessionId: PARENT, previousMessageId: 'msg_c1', messages: [childHead, hookBlock(2)] }), base + 300_000)

    const report = await buildCacheBreakTimeline({ bodiesDir: bodies, sessionId: `agent-${CHILD_ID}`, minTokens: 5000, projectsDirs: [projects] })
    assert.strictEqual(report.sessionId, `agent-${CHILD_ID}`)
    assert.strictEqual(report.turnsInSession, 3, 'exactly the child\'s 3 turns — the parent\'s 3 stay out')
    assert.strictEqual(report.turnsClassified, 2, 'c0 (measured via c1\'s chain link) + c1 (via c2\'s)')
    assert.strictEqual(report.events[0].cause, 'COLD_START', 'the recovered stream head is the child\'s cold start')
    assert.strictEqual(report.events[0].cacheCreateTokens, 180_000, 'the head\'s own big first write is attributed, not lost')
    assert.ok(report.coverage.note.includes('sub-agent CHILD'), report.coverage.note)
    assert.ok(report.coverage.note.includes(PARENT), 'the parent linkage is disclosed')

    // The bare agentId (a spawn placeholder's id, no agent- prefix) resolves to the same stream.
    const bare = await buildCacheBreakTimeline({ bodiesDir: bodies, sessionId: CHILD_ID, minTokens: 5000, projectsDirs: [projects] })
    assert.strictEqual(bare.turnsInSession, 3)
  })

  test('an agent-* id with no transcript returns an HONEST empty report naming the resolution path', async () => {
    const bodies = freshDir()
    const projects = freshDir()
    writeAt(bodies, 'x0.request.json', reqBody({ sessionId: PARENT }), Date.now() - 60_000)
    const report = await buildCacheBreakTimeline({ bodiesDir: bodies, sessionId: 'agent-ffffffffffffffff0', minTokens: 5000, projectsDirs: [projects] })
    assert.strictEqual(report.turnsClassified, 0)
    assert.ok(report.coverage.note.includes('sub-agent child id'), report.coverage.note)
    assert.ok(report.coverage.note.includes('subagents'), report.coverage.note)
  })
})

suite('cacheBreakTimeline — real machine data', () => {
  // 🐌 slow — scans the real ~/.agentlens/otel-bodies directory (thousands of files). Skips when the
  // directory is absent (CI / a machine that never enabled OTEL_LOG_RAW_API_BODIES).
  test('🐌 builds a timeline from the REAL OTEL bodies without crashing and reports honest coverage', async function () {
    if (!fs.existsSync(defaultBodiesDir())) { this.skip(); return }
    // 4 minutes, not 2: this scans every captured body in the window, and on a machine with a live
    // capture spool it shares the run with the second real-corpus test below. It timed out at 120s
    // in a full-suite run while passing in 58s alone — a harness bound, not a product property.
    if (skipIfUnmeasurable(this)) return
    this.timeout(loadScaledTimeout(240_000))
    // Capped for the same reason as the cost-peak test above: the capture directory is live and
    // grows all day, so an uncapped scan makes this test's runtime a function of the user's traffic.
    const report = await buildCacheBreakTimeline({ windowHours: 5, minTokens: 50_000, scanCap: 300 })
    assert.ok(report.coverage.dirExists)
    assert.ok(report.coverage.note.length > 0)
    assert.ok(report.turnsClassified >= 0)
    // Every event names a cause and its wasted tokens meet the floor — EXCEPT the two diagnoses whose
    // whole finding is that the turn was never cached at all (TRDD-B9ERTBZ9). Those carry 0
    // cache_creation by construction, so a cache_creation floor would drop exactly the turns that pay
    // the full input rate on every call; they are admitted deliberately.
    const NO_CACHE_ACTIVITY = new Set(['CACHING_DISABLED', 'BELOW_MIN_CACHEABLE'])
    for (const e of report.events) {
      assert.ok(e.cause.length > 0)
      if (NO_CACHE_ACTIVITY.has(e.cause)) assert.strictEqual(e.cacheCreateTokens, 0)
      else assert.ok(e.cacheCreateTokens >= 50_000)
    }
  })

  // The acceptance criterion that produced TRDD-V8YOWHVT: both method errors there were invisible to
  // synthetic fixtures. This drives the two region extractors over the machine's REAL captured bodies
  // and asserts they find the shapes they claim to — a regex that silently matches nothing would keep
  // every other test green while WORKING_DIR_CHANGED / GIT_STATE_CHANGED became unemittable.
  test('🐌 the env + git region extractors actually match the REAL captured system prompts', async function () {
    const dir = defaultBodiesDir()
    if (!fs.existsSync(dir)) { this.skip(); return }
    if (skipIfUnmeasurable(this)) return
    this.timeout(loadScaledTimeout(120_000))
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.request.json')).slice(0, 200)
    if (files.length === 0) { this.skip(); return }
    let withEnv = 0, withGit = 0, parsed = 0
    for (const f of files) {
      let body: RawRequestForBreak
      try { body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as RawRequestForBreak } catch { continue }
      const p = extractTurnPrefix(body)
      if (!p) continue
      parsed += 1
      if (p.envFp) withEnv += 1
      if (p.gitFp) withGit += 1
      // POINTER-ONLY: the regions carry an absolute home path and a branch name; only hashes may exist.
      assert.strictEqual(p.envFp.length === 0 || p.envFp.length === 8, true, 'env region must be kept as a hash')
      assert.strictEqual(p.gitFp.length === 0 || p.gitFp.length === 8, true, 'git region must be kept as a hash')
    }
    assert.ok(parsed > 0, 'no real request body parsed')
    assert.ok(withEnv > 0, `the environment-block extractor matched none of ${parsed} real requests`)
    assert.ok(withGit > 0, `the git-snapshot extractor matched none of ${parsed} real requests`)
  })
})

suite('cacheBreakTimeline — PLUGINS_RELOADED (TRDD-EYA3X5MQ — cross-layer catalog co-churn)', () => {
  // A plugin reload re-registers tools + the skill catalog + the agent catalog together, so it churns
  // the tools LAYER and two system BLOCKS at once. Build system blocks whose text triggers the
  // skillcatalog / agentcatalog content kinds, then vary how many churn.
  const skillBlk = (n: number) => ({ type: 'text' as const, text: `The following skills are available for use with the Skill tool: ${Array.from({ length: n }, (_, i) => 'skill-' + i).join(', ')}`, cache_control: CC })
  const agentBlk = (n: number) => ({ type: 'text' as const, text: `Available agent types for the Agent tool: ${Array.from({ length: n }, (_, i) => 'agent-' + i).join(', ')}`, cache_control: CC })
  const sysHead = { type: 'text' as const, text: 'You are a helpful agent.', cache_control: CC }

  test('tools + skill catalog + agent catalog all churn → PLUGINS_RELOADED, confidence high', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }], system: [sysHead, skillBlk(3), agentBlk(2)] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }], system: [sysHead, skillBlk(4), agentBlk(3)] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'PLUGINS_RELOADED')
    assert.strictEqual(v.confidence, 'high')
    assert.ok(v.culpritSummary.includes('tools') && v.culpritSummary.includes('skills') && v.culpritSummary.includes('agents'))
  })

  test('exactly 2 catalogs churn (tools + skills; agents unchanged) → PLUGINS_RELOADED, confidence medium', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }], system: [sysHead, skillBlk(3), agentBlk(2)] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }], system: [sysHead, skillBlk(4), agentBlk(2)] })
    const v = classify(prev, cur)
    assert.strictEqual(v.cause, 'PLUGINS_RELOADED')
    assert.strictEqual(v.confidence, 'medium')
  })

  test('only the skill catalog changes → NOT a reload (single-catalog cause wins)', () => {
    const prev = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }], system: [sysHead, skillBlk(3), agentBlk(2)] })
    const cur = reqBody({ tools: [{ name: 'Bash' }, { name: 'Read' }], system: [sysHead, skillBlk(4), agentBlk(2)] })
    const v = classify(prev, cur)
    assert.notStrictEqual(v.cause, 'PLUGINS_RELOADED')
    assert.strictEqual(v.confidence, undefined)
  })
})
