import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, type LogSessionResult } from '../logReader'
import { linkSubagentTranscripts } from '../feedMergePolicy'
import { handleGetAgentTokens, handleGetSubagentTree } from '../mcpServer'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// ── Why this file exists (TRDD-9YT1UR2F) ──────────────────────────────────────
// get_agent_tokens answers "exactly what did agent X consume" for ONE agent. These
// tests are REAL-FS: a fixture parent transcript + the child's own subagents/*.jsonl
// are written to a temp CLAUDE_CONFIG_DIR, scanned by the real LogReader, and linked
// by the real read-time merge — the handler is exercised on the same card pipeline
// production serves. Pinned contracts:
//   • exact buckets round-trip from the child transcript (the P8-linked agent-* card);
//   • id normalization: bare / agent-<id> / full sessionId, case-insensitive, with
//     exact-sessionId precedence (the ambiguity error's escape hatch);
//   • ambiguity NEVER guesses — error lists candidates; parentSessionId scopes;
//   • unknown id → clean error;
//   • cross-tool consistency with get_subagent_tree on the same fixture child;
//   • ccDisplayEquivalent reconciles Claude Code's per-agent ↓ footer: the ADDENDUM
//     decoding (2026-07-11) established ↓ = CUMULATIVE input+cacheRead+cacheCreation
//     across ALL turns (launch turn included, output excluded/sub-rounding), so
//     cumulativeInputSideTokens must equal the fixture transcript's summed input-side
//     buckets — asserted against the literal fixture arithmetic below.

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

let seq = 0
const uniqueId = (prefix: string): string => `${prefix}-${process.pid}-${seq++}`

interface Fixture { root: string; file: string; cwd: string; id: string; cleanup: () => void }

function claudeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-agent-tokens-'))
  const sub = path.join(root, 'projects', 'proj')
  fs.mkdirSync(sub, { recursive: true })
  const id = uniqueId('agenttok')
  const file = path.join(sub, `${id}.jsonl`)
  const orig = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = root
  return {
    root, file, cwd: path.join(root, 'workspace'), id,
    cleanup() {
      if (orig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = orig
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// ── Line builders (minimal real transcript shapes, same as the P8 suite) ──────

const userText = (ts: string, cwd: string, text: string): string =>
  JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } }) + '\n'

const agentSpawn = (ts: string, cwd: string, toolUseId: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }],
    },
  }) + '\n'

const agentResult = (ts: string, cwd: string, toolUseId: string, tur: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'user', timestamp: ts, cwd,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
    toolUseResult: tur,
  }) + '\n'

const asyncLaunchedTur = (agentId: string): Record<string, unknown> => ({
  status: 'async_launched', isAsync: true, agentId,
  description: 'background research', prompt: 'go research things',
  resolvedModel: 'claude-sonnet-5',
  outputFile: '/tmp/out.txt', canReadOutputFile: true,
})

const syncCompletionTur = (agentId: string): Record<string, unknown> => ({
  agentId, agentType: 'spark', status: 'completed',
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 200 },
  totalTokens: 750, totalToolUseCount: 3, totalDurationMs: 12_000,
  resolvedModel: 'claude-opus-4-8', prompt: 'do sync work',
})

// A child transcript assistant row carrying real usage (Anthropic-shaped: input cache-excluded).
const childAssistant = (ts: string, cwd: string, usage: Record<string, number>): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: `msg-${process.pid}-${seq++}`, model: 'claude-sonnet-5',
      usage, content: [{ type: 'text', text: 'child work done' }],
    },
  }) + '\n'

// Write the child's own transcript where Claude Code puts it: under a directory NAMED after the
// PARENT session id — that path IS the parent linkage the reader derives (P8).
function writeSubagentTranscript(fx: Fixture, parentId: string, agentId: string, content: string): void {
  const dir = path.join(path.dirname(fx.file), parentId, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), content)
}

// Flatten scan results exactly like the standalone server's logSessions map (parents + children),
// then apply the same read-time merge every serve path applies.
function servedCards(results: LogSessionResult[]): SessionSummaryCard[] {
  const m = new Map<string, SessionSummaryCard>()
  for (const r of results) {
    m.set(r.card.sessionId, r.card)
    for (const c of r.childCards ?? []) m.set(c.sessionId, c)
  }
  return linkSubagentTranscripts([...m.values()])
}

// The fixture child's two transcript turns — named constants so every expected figure below is
// literal fixture arithmetic, not a re-derivation through the code under test.
const TURN1 = { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 444 }
const TURN2 = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 200 }

// One linked async child (parent spawn ack + real child transcript), scanned and merged.
function linkedFixture(agentId: string): { fx: Fixture; sessions: SessionSummaryCard[] } {
  const fx = claudeFixture()
  fs.writeFileSync(fx.file,
    userText('2026-07-11T10:00:00Z', fx.cwd, 'spawn an async agent')
    + agentSpawn('2026-07-11T10:00:01Z', fx.cwd, 'tu-1', { subagent_type: 'general-purpose', prompt: 'go research things' })
    + agentResult('2026-07-11T10:00:02Z', fx.cwd, 'tu-1', asyncLaunchedTur(agentId)),
  )
  writeSubagentTranscript(fx, fx.id, agentId,
    userText('2026-07-11T10:00:05Z', fx.cwd, 'go research things')
    + childAssistant('2026-07-11T10:00:09Z', fx.cwd, TURN1)
    + childAssistant('2026-07-11T10:02:00Z', fx.cwd, TURN2),
  )
  return { fx, sessions: servedCards(scanClaude(new LogReader({}))) }
}

type AgentTokens = ReturnType<typeof handleGetAgentTokens>
const asError = (r: AgentTokens) => r as { error?: string; candidates?: Array<{ sessionId: string }> }
const asPayload = (r: AgentTokens) => {
  const p = r as {
    error?: string; agentId: string; sessionId: string; parentSessionId: string | null
    spawnedByTurn: number | null; spawnKind: string | null; warm: boolean; model: string
    startedAt: string | null; lastSeenAt: string | null; turns: number | null
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number
    totalTokens: number; cost_usd: number; asyncTokensUnknown?: boolean
    ccDisplayEquivalent: { cumulativeInputSideTokens: number; lastTurnContextRead: number | null; note: string }
    tokensSource: string | null; coverageNote?: string
  }
  assert.strictEqual(p.error, undefined, `expected a payload, got error: ${p.error}`)
  return p
}

suite('get_agent_tokens — exact per-agent buckets (real-fs, P8-linked child)', () => {
  test('bare agent id resolves the linked transcript child: exact buckets + spawn metadata round-trip', () => {
    const { fx, sessions } = linkedFixture('feedbeef11223344')
    try {
      const r = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'feedbeef11223344' }))
      assert.strictEqual(r.sessionId, 'agent-feedbeef11223344', 'served id is the transcript card (the merge winner)')
      assert.strictEqual(r.agentId, 'feedbeef11223344')
      assert.strictEqual(r.parentSessionId, fx.id)
      // Exact buckets = the child transcript's summed disjoint buckets — literal fixture arithmetic.
      assert.strictEqual(r.inputTokens, TURN1.input_tokens + TURN2.input_tokens)
      assert.strictEqual(r.outputTokens, TURN1.output_tokens + TURN2.output_tokens)
      assert.strictEqual(r.cacheReadTokens, TURN1.cache_read_input_tokens + TURN2.cache_read_input_tokens)
      assert.strictEqual(r.cacheCreateTokens, TURN1.cache_creation_input_tokens + TURN2.cache_creation_input_tokens)
      assert.strictEqual(r.totalTokens, r.inputTokens + r.outputTokens, 'totalTokens keeps the card convention (non-cache)')
      assert.ok(r.cost_usd > 0, 'four disjoint buckets bill through the shared pricer')
      // Spawn taxonomy grafted from the parent transcript by the P8 merge.
      assert.strictEqual(r.spawnedByTurn, 1)
      assert.strictEqual(r.spawnKind, 'fresh')
      assert.strictEqual(r.warm, false)
      assert.strictEqual(r.model, 'claude-sonnet-5', 'model from the child transcript rows')
      assert.strictEqual(r.turns, 2, 'turns from the child transcript, not the placeholder')
      assert.ok(r.startedAt, 'startedAt from the child card')
      assert.ok(r.lastSeenAt, 'lastSeenAt derived from start + duration')
      assert.strictEqual(r.asyncTokensUnknown, undefined, 'real parsed totals — no unknown flag')
      assert.strictEqual(r.tokensSource, 'log', 'P7 provenance: child transcript cards are log-backed at birth')
    } finally { fx.cleanup() }
  })

  test('ADDENDUM: cumulativeInputSideTokens equals the fixture transcript summed input-side buckets (the CC ↓ match)', () => {
    const { fx, sessions } = linkedFixture('cc00ddaabbcc9911')
    try {
      const r = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'cc00ddaabbcc9911' }))
      // CC's per-agent ↓ = cumulative (input + cacheRead + cacheCreation) across ALL turns,
      // launch turn included, output excluded — the empirically decoded footer semantics.
      const expectedCumulative =
        (TURN1.input_tokens + TURN1.cache_read_input_tokens + TURN1.cache_creation_input_tokens) +
        (TURN2.input_tokens + TURN2.cache_read_input_tokens + TURN2.cache_creation_input_tokens)
      assert.strictEqual(r.ccDisplayEquivalent.cumulativeInputSideTokens, expectedCumulative)
      assert.ok(
        expectedCumulative > r.totalTokens - r.outputTokens || expectedCumulative >= r.inputTokens,
        'sanity: cumulative input-side is at least the raw input share',
      )
      // The context-size proxy is the LAST turn's input-side buckets (from the per-turn timeline).
      assert.strictEqual(
        r.ccDisplayEquivalent.lastTurnContextRead,
        TURN2.input_tokens + TURN2.cache_read_input_tokens + TURN2.cache_creation_input_tokens,
      )
      // Output must NOT be in either figure — it is excluded from CC's ↓ (or below its rounding).
      assert.ok(!r.ccDisplayEquivalent.note.includes('undefined'))
      assert.ok(/volume/i.test(r.ccDisplayEquivalent.note), 'note states it is volume moved, not billing')
    } finally { fx.cleanup() }
  })

  test('agent-<id>, full sessionId, and case-insensitive forms all resolve to the same card', () => {
    const { fx, sessions } = linkedFixture('normfeed55667788')
    try {
      const bare = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'normfeed55667788' }))
      const prefixed = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'agent-normfeed55667788' }))
      const upper = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'AGENT-NORMFEED55667788' }))
      const full = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'agent-normfeed55667788' }))
      for (const r of [prefixed, upper, full]) {
        assert.strictEqual(r.sessionId, bare.sessionId)
        assert.strictEqual(r.inputTokens, bare.inputTokens)
        assert.strictEqual(r.cost_usd, bare.cost_usd)
      }
    } finally { fx.cleanup() }
  })

  test('cross-tool consistency: buckets/total/cost match get_subagent_tree for the same fixture child', () => {
    const { fx, sessions } = linkedFixture('xtool99887766aa')
    try {
      const tokens = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'xtool99887766aa' }))
      const tree = handleGetSubagentTree(sessions, { sessionId: fx.id }) as {
        children: Array<{ sessionId: string; totalTokens: number; cost_usd: number; spawnKind: string; warm: boolean; model: string; spawnedByTurn: number | null }>
      }
      const child = tree.children.find(c => c.sessionId === 'agent-xtool99887766aa')
      assert.ok(child, 'the tree serves the same linked child')
      // The acceptance contract: the two tools must agree exactly on the same child — one
      // implementation of the conventions (totalTokens non-cache, shared pricer, spawn taxonomy).
      assert.strictEqual(tokens.totalTokens, child!.totalTokens)
      assert.strictEqual(tokens.cost_usd, child!.cost_usd)
      assert.strictEqual(tokens.spawnKind, child!.spawnKind)
      assert.strictEqual(tokens.warm, child!.warm)
      assert.strictEqual(tokens.model, child!.model)
      assert.strictEqual(tokens.spawnedByTurn, child!.spawnedByTurn)
    } finally { fx.cleanup() }
  })

  test('unknown id → clean error naming the id, with no candidates block', () => {
    const { fx, sessions } = linkedFixture('known11223344ff')
    try {
      const r = asError(handleGetAgentTokens(sessions, null, { agentId: 'no-such-agent-id' }))
      assert.ok(r.error, 'must be an error')
      assert.ok(r.error!.includes('no-such-agent-id'), 'error names the queried id')
      assert.strictEqual(r.candidates, undefined)
    } finally { fx.cleanup() }
  })

  test('empty agentId → clean error, never a scan of everything', () => {
    const { fx, sessions } = linkedFixture('empty0011223344')
    try {
      const r = asError(handleGetAgentTokens(sessions, null, { agentId: '   ' }))
      assert.ok(r.error && /required/i.test(r.error))
    } finally { fx.cleanup() }
  })

  test('async child with NO transcript: zero buckets flagged asyncTokensUnknown, lastTurnContextRead null', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-11T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-11T10:00:01Z', fx.cwd, 'tu-m1', { subagent_type: 'spark', prompt: 'work' })
        + agentResult('2026-07-11T10:00:02Z', fx.cwd, 'tu-m1', asyncLaunchedTur('0rphan0transcript')),
      )
      const sessions = servedCards(scanClaude(new LogReader({})))
      const r = asPayload(handleGetAgentTokens(sessions, null, { agentId: '0rphan0transcript' }))
      assert.strictEqual(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens, 0)
      assert.strictEqual(r.asyncTokensUnknown, true, 'zero buckets must read unknown, never measured-free')
      assert.strictEqual(r.cost_usd, 0)
      assert.strictEqual(r.ccDisplayEquivalent.cumulativeInputSideTokens, 0)
      assert.strictEqual(r.ccDisplayEquivalent.lastTurnContextRead, null, 'no data → null, never a fabricated figure')
    } finally { fx.cleanup() }
  })

  test('sync placeholder (final-turn snapshot): single-turn fallback makes lastTurnContextRead the snapshot context', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-11T10:00:00Z', fx.cwd, 'spawn a sync agent')
        + agentSpawn('2026-07-11T10:00:01Z', fx.cwd, 'tu-s1', { subagent_type: 'spark', prompt: 'do sync work' })
        + agentResult('2026-07-11T10:05:00Z', fx.cwd, 'tu-s1', syncCompletionTur('sync00aabbccdd22')),
      )
      const sessions = servedCards(scanClaude(new LogReader({})))
      const r = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'sync00aabbccdd22' }))
      // A sync placeholder's card buckets ARE the final-turn usage snapshot, so with exactly one
      // recorded llm call the cumulative figure IS the last turn's context read.
      assert.strictEqual(r.inputTokens, 100)
      assert.strictEqual(r.ccDisplayEquivalent.cumulativeInputSideTokens, 100 + 400 + 200)
      assert.strictEqual(r.ccDisplayEquivalent.lastTurnContextRead, 100 + 400 + 200)
      assert.strictEqual(r.spawnKind, 'fresh')
    } finally { fx.cleanup() }
  })

  test('ambiguous id (un-merged placeholder + cross-parent transcript) errors listing candidates — never guesses', () => {
    const fx = claudeFixture()
    try {
      // Parent A spawns agentId X async (→ bare-X placeholder under parent A). A transcript
      // agent-X lives under a DIFFERENT parent's directory — the cross-parent guard in
      // linkSubagentTranscripts refuses to merge that pair, so BOTH cards serve and a bare-X
      // query is genuinely ambiguous.
      const otherParent = uniqueId('otherparent')
      fs.writeFileSync(fx.file,
        userText('2026-07-11T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-11T10:00:01Z', fx.cwd, 'tu-x1', { subagent_type: 'spark', prompt: 'work' })
        + agentResult('2026-07-11T10:00:02Z', fx.cwd, 'tu-x1', asyncLaunchedTur('amb1gu0us0011223')),
      )
      fs.writeFileSync(path.join(path.dirname(fx.file), `${otherParent}.jsonl`),
        userText('2026-07-11T09:00:00Z', fx.cwd, 'another parent session'),
      )
      writeSubagentTranscript(fx, otherParent, 'amb1gu0us0011223',
        userText('2026-07-11T09:00:05Z', fx.cwd, 'work')
        + childAssistant('2026-07-11T09:00:09Z', fx.cwd, TURN1),
      )
      const sessions = servedCards(scanClaude(new LogReader({})))

      const amb = asError(handleGetAgentTokens(sessions, null, { agentId: 'amb1gu0us0011223' }))
      assert.ok(amb.error && /ambiguous/i.test(amb.error), 'ambiguity is an ERROR, not a guess')
      assert.strictEqual(amb.candidates!.length, 2, 'both conflicting cards are listed')
      const ids = amb.candidates!.map(c => c.sessionId).sort()
      assert.deepStrictEqual(ids, ['agent-amb1gu0us0011223', 'amb1gu0us0011223'])

      // parentSessionId scopes the lookup to one candidate…
      const scoped = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'amb1gu0us0011223', parentSessionId: fx.id }))
      assert.strictEqual(scoped.sessionId, 'amb1gu0us0011223')
      assert.strictEqual(scoped.parentSessionId, fx.id)

      // …and a FULL sessionId resolves outright (exact-match precedence — the escape hatch).
      const exact = asPayload(handleGetAgentTokens(sessions, null, { agentId: 'agent-amb1gu0us0011223' }))
      assert.strictEqual(exact.sessionId, 'agent-amb1gu0us0011223')
      assert.strictEqual(exact.inputTokens, TURN1.input_tokens)

      // A parent that matches NO candidate is its own honest error carrying the real locations.
      const wrongParent = asError(handleGetAgentTokens(sessions, null, { agentId: 'amb1gu0us0011223', parentSessionId: 'not-a-parent' }))
      assert.ok(wrongParent.error && /none under parent/i.test(wrongParent.error))
      assert.strictEqual(wrongParent.candidates!.length, 2)
    } finally { fx.cleanup() }
  })
})
