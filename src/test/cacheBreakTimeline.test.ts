import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  extractTurnPrefix, classifyCacheBreak, buildCacheBreakTimeline, formatTimeline,
  DEFAULT_BODIES_DIR, type RawRequestForBreak, type BreakTiming,
} from '../cacheBreakTimeline'

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

  test('EFFORT_SWITCH — extended-thinking setting changed', () => {
    const v = classify(reqBody({ thinking: { type: 'adaptive' } }), reqBody({ thinking: { type: 'enabled', budget_tokens: 10000 } }))
    assert.strictEqual(v.cause, 'EFFORT_SWITCH')
  })

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

  test('AGENT_METADATA_CHANGED — billing header cc_version changed (upgrade)', () => {
    const prev = reqBody({ system: [{ text: 'x-anthropic-billing-header: cc_version=2.1.204.d03; cc_entrypoint=cli;', cache_control: CC }] })
    const cur = reqBody({ system: [{ text: 'x-anthropic-billing-header: cc_version=2.1.205.a01; cc_entrypoint=cli;', cache_control: CC }] })
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
function respBody(id: string, cacheCreate: number, cacheRead = 50_000, model = 'claude-opus-4-8') {
  return { id, model, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, cache_creation: { ephemeral_5m_input_tokens: cacheCreate, ephemeral_1h_input_tokens: 0 } } }
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

suite('cacheBreakTimeline — real machine data', () => {
  // 🐌 slow — scans the real ~/.agentlens/otel-bodies directory (thousands of files). Skips when the
  // directory is absent (CI / a machine that never enabled OTEL_LOG_RAW_API_BODIES).
  test('builds a timeline from the REAL OTEL bodies without crashing and reports honest coverage', async function () {
    if (!fs.existsSync(DEFAULT_BODIES_DIR)) { this.skip(); return }
    this.timeout(120_000)
    const report = await buildCacheBreakTimeline({ windowHours: 5, minTokens: 50_000 })
    assert.ok(report.coverage.dirExists)
    assert.ok(report.coverage.note.length > 0)
    assert.ok(report.turnsClassified >= 0)
    // Every event names a cause and its wasted tokens meet the floor.
    for (const e of report.events) {
      assert.ok(e.cause.length > 0)
      assert.ok(e.cacheCreateTokens >= 50_000)
    }
  })
})
