import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, type LogSessionResult } from '../logReader'
import { linkSubagentTranscripts } from '../feedMergePolicy'
import { buildSpawnRollup } from '../shared/spawnRollup'
import type { SessionSummaryCard } from '../shared/summarizerTypes'

// ── Why this file exists ──────────────────────────────────────────────────────
// Sub-agent child cards come in two transcript shapes. A SYNCHRONOUS Task/Agent
// completion writes a toolUseResult carrying `usage` + `totalTokens` — the only
// token figure the parent transcript ever gets. An ASYNC/background launch
// instead writes ONLY a status:"async_launched" acknowledgment (the completion
// later arrives as a <task-notification> user message, never as a usage-carrying
// toolUseResult — verified 2026-07-10 on a real 54MB transcript: 57/57 Agent
// spawns async, zero `totalTokens` in the whole file). The reader used to skip
// those entirely, so async-heavy sessions reported childCount 0. These tests pin
// the fixed contract: async spawns still yield a LINKAGE card (agentId/model
// from the launch record) with zero buckets honestly flagged spawnAsync, sync
// spawns are unchanged, and a late usage-carrying result upgrades the async
// placeholder in place.

type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

let seq = 0
const uniqueId = (prefix: string): string => `${prefix}-${process.pid}-${seq++}`

interface Fixture { file: string; cwd: string; id: string; cleanup: () => void }

function claudeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-subagents-'))
  const sub = path.join(root, 'projects', 'proj')
  fs.mkdirSync(sub, { recursive: true })
  const id = uniqueId('subagents')
  const file = path.join(sub, `${id}.jsonl`)
  const orig = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = root
  return {
    file, cwd: path.join(root, 'workspace'), id,
    cleanup() {
      if (orig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = orig
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// ── Line builders (minimal real transcript shapes) ────────────────────────────

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

// A tool_result user row whose sibling toolUseResult carries the Agent launch/completion record.
const agentResult = (ts: string, cwd: string, toolUseId: string, tur: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'user', timestamp: ts, cwd,
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
    toolUseResult: tur,
  }) + '\n'

// The exact key set a real async_launched acknowledgment carries (no usage, no totalTokens).
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

const findChild = (r: LogSessionResult, agentId: string) =>
  (r.childCards ?? []).find(c => c.sessionId === agentId)

suite('logReader sub-agent child cards (sync vs async launches)', () => {
  test('async_launched spawn yields a linkage card: zero buckets flagged spawnAsync, outcome unknown', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-async-1', { subagent_type: 'general-purpose', prompt: 'go research things' })
        + agentResult('2026-07-10T10:00:02Z', fx.cwd, 'tu-async-1', asyncLaunchedTur('agent-async-1')),
      )
      const results = scanClaude(new LogReader({}))
      const parent = results.find(r => r.card.sessionId === fx.id)
      assert.ok(parent, 'parent card parsed')
      const child = findChild(parent!, 'agent-async-1')
      assert.ok(child, 'async spawn must still produce a child card (the pre-fix reader skipped it)')
      assert.strictEqual(child!.parentSessionId, fx.id)
      assert.strictEqual(child!.spawnAsync, true)
      assert.strictEqual(child!.outcome, 'unknown', 'result never reaches the parent transcript — outcome must not be fabricated')
      assert.strictEqual(child!.model, 'claude-sonnet-5', 'model comes from the launch record resolvedModel')
      assert.strictEqual(child!.inputTokens, 0)
      assert.strictEqual(child!.outputTokens, 0)
      assert.strictEqual(child!.cacheReadTokens, 0)
      assert.strictEqual(child!.cacheCreateTokens, 0)
    } finally { fx.cleanup() }
  })

  test('synchronous completion still yields a fully-measured card without the async flag', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn a sync agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-sync-1', { subagent_type: 'spark', prompt: 'do sync work' })
        + agentResult('2026-07-10T10:05:00Z', fx.cwd, 'tu-sync-1', syncCompletionTur('agent-sync-1')),
      )
      const results = scanClaude(new LogReader({}))
      const parent = results.find(r => r.card.sessionId === fx.id)
      const child = findChild(parent!, 'agent-sync-1')
      assert.ok(child, 'sync child card exists')
      assert.strictEqual(child!.spawnAsync, undefined, 'sync completions are not flagged async')
      // inputTokens is RAW uncached input — four disjoint buckets on every card family.
      assert.strictEqual(child!.inputTokens, 100)
      assert.strictEqual(child!.outputTokens, 50)
      assert.strictEqual(child!.cacheReadTokens, 400)
      assert.strictEqual(child!.cacheCreateTokens, 200)
      assert.strictEqual(child!.outcome, 'tool_calls')
    } finally { fx.cleanup() }
  })

  test('a late usage-carrying result for the same tool_use id upgrades the async placeholder', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn then complete')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-both-1', { subagent_type: 'spark', prompt: 'work' })
        + agentResult('2026-07-10T10:00:02Z', fx.cwd, 'tu-both-1', asyncLaunchedTur('agent-both-1'))
        + agentResult('2026-07-10T10:09:00Z', fx.cwd, 'tu-both-1', syncCompletionTur('agent-both-1')),
      )
      const results = scanClaude(new LogReader({}))
      const parent = results.find(r => r.card.sessionId === fx.id)
      const children = (parent!.childCards ?? []).filter(c => c.sessionId === 'agent-both-1')
      assert.strictEqual(children.length, 1, 'one card per tool_use id, not a placeholder + a completion')
      assert.strictEqual(children[0].spawnAsync, undefined, 'real completion clears the async flag')
      assert.strictEqual(children[0].inputTokens, 100, 'zero-bucket placeholder was overwritten with measured usage')
    } finally { fx.cleanup() }
  })

  test('a multi-tool_result entry does not attribute one shared toolUseResult to several sub-agents (S1-F8)', () => {
    const fx = claudeFixture()
    try {
      // Two Task spawns, then ONE user entry carrying TWO tool_result blocks but only ONE sibling
      // toolUseResult (the ambiguous shape — the entry-level tur has no tool_use_id to key on). The
      // pre-fix reader passed that single tur to BOTH blocks, stamping one sub-agent's 100/50/400/200
      // usage onto both children. The fix attributes it only in the 1:1 case, so the shared usage
      // must appear on at most one child.
      const multiResult = JSON.stringify({
        type: 'user', timestamp: '2026-07-10T10:05:00Z', cwd: fx.cwd,
        message: { content: [
          { type: 'tool_result', tool_use_id: 'tu-a', content: 'done a' },
          { type: 'tool_result', tool_use_id: 'tu-b', content: 'done b' },
        ] },
        toolUseResult: syncCompletionTur('agent-a'),
      }) + '\n'
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn two')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-a', { subagent_type: 'spark', prompt: 'a' })
        + agentSpawn('2026-07-10T10:00:02Z', fx.cwd, 'tu-b', { subagent_type: 'spark', prompt: 'b' })
        + multiResult)
      const parent = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!
      const withSharedUsage = (parent.childCards ?? []).filter(c => c.inputTokens === 100)
      assert.ok(withSharedUsage.length <= 1, `shared usage must not be duplicated across children (got ${withSharedUsage.length})`)
    } finally { fx.cleanup() }
  })
})

// ── P8: async child token resolution (subagents/*.jsonl ↔ spawn placeholder) ──
// An async launch leaves a ZERO-bucket placeholder in the parent (the transcript never carries the
// child's usage — upstream gap anthropics/claude-code#76484), but the child's OWN transcript exists
// at <mangled-project>/<parentSessionId>/subagents/agent-<agentId>.jsonl. These tests pin the local
// resolution: the transcript card is parent-linked from its path at parse time, and the read-time
// merge (linkSubagentTranscripts) collapses placeholder + transcript into ONE child that carries the
// real parsed totals — while a child whose transcript is missing keeps its honest unknown.

// A child transcript assistant row carrying real usage (Anthropic-shaped: input cache-excluded).
const childAssistant = (ts: string, cwd: string, usage: Record<string, number>): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: `msg-${process.pid}-${seq++}`, model: 'claude-sonnet-5',
      usage, content: [{ type: 'text', text: 'child work done' }],
    },
  }) + '\n'

// Write the child's own transcript where Claude Code puts it: next to the parent transcript, under
// a directory NAMED after the parent session id — that path IS the parent linkage the reader derives.
function writeSubagentTranscript(fx: Fixture, agentId: string, content: string): void {
  const dir = path.join(path.dirname(fx.file), fx.id, 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), content)
}

// Flatten scan results exactly like the standalone server's logSessions map (parents + children).
function allCards(results: LogSessionResult[]): SessionSummaryCard[] {
  const m = new Map<string, SessionSummaryCard>()
  for (const r of results) {
    m.set(r.card.sessionId, r.card)
    for (const c of r.childCards ?? []) m.set(c.sessionId, c)
  }
  return [...m.values()]
}

const costOf = (c: SessionSummaryCard): number =>
  (c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheCreateTokens) / 1_000_000

suite('P8 — async child token resolution (transcript linking + read-time merge)', () => {
  test('a subagents/*.jsonl transcript is parent-linked from its path, not served as an orphan', () => {
    const fx = claudeFixture()
    try {
      writeSubagentTranscript(fx, 'a1b2c3d4e5f60718',
        userText('2026-07-10T10:00:05Z', fx.cwd, 'go research things')
        + childAssistant('2026-07-10T10:00:09Z', fx.cwd, { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 444 }),
      )
      const cards = allCards(scanClaude(new LogReader({})))
      const t = cards.find(c => c.sessionId === 'agent-a1b2c3d4e5f60718')
      assert.ok(t, 'subagents transcript parsed into an agent-* card')
      assert.strictEqual(t!.parentSessionId, fx.id, 'parent id derived from the directory that contains subagents/')
      assert.strictEqual(t!.initiator, 'agent')
      assert.strictEqual(t!.inputTokens, 111)
      assert.strictEqual(t!.cacheCreateTokens, 444)
    } finally { fx.cleanup() }
  })

  test('link resolves: ONE child with real totals, spawnAsync cleared, rollup includes the cost', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-a1', { subagent_type: 'general-purpose', prompt: 'go research things' })
        + agentResult('2026-07-10T10:00:02Z', fx.cwd, 'tu-a1', asyncLaunchedTur('feedbeef00112233')),
      )
      writeSubagentTranscript(fx, 'feedbeef00112233',
        userText('2026-07-10T10:00:05Z', fx.cwd, 'go research things')
        + childAssistant('2026-07-10T10:00:09Z', fx.cwd, { input_tokens: 111, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 444 }),
      )
      const linked = linkSubagentTranscripts(allCards(scanClaude(new LogReader({}))))

      // The pair collapsed: the transcript id serves the child; the bare placeholder id is gone.
      assert.strictEqual(linked.filter(c => c.sessionId === 'agent-feedbeef00112233').length, 1)
      assert.strictEqual(linked.filter(c => c.sessionId === 'feedbeef00112233').length, 0, 'placeholder consumed — no duplicate serving')

      const child = linked.find(c => c.sessionId === 'agent-feedbeef00112233')!
      assert.strictEqual(child.parentSessionId, fx.id, 'still a child of the spawning session')
      assert.strictEqual(child.spawnAsync, undefined, 'tokens are no longer zero-by-absence')
      assert.strictEqual(child.inputTokens, 111, 'real parsed totals from the child transcript')
      assert.strictEqual(child.outputTokens, 22)
      assert.strictEqual(child.cacheReadTokens, 333)
      assert.strictEqual(child.cacheCreateTokens, 444)
      // Spawn taxonomy only the parent transcript knows survives the merge.
      assert.strictEqual(child.spawnedByTurn, 1)
      assert.strictEqual(child.spawnKind, 'fresh')
      assert.strictEqual(child.spawnSubagentType, 'general-purpose')
      assert.ok(child.mergedFrom?.includes('feedbeef00112233'), 'merge is auditable via mergedFrom')

      // The spawn rollup now bills the child's REAL cost and reports no unreported-async children.
      const children = linked.filter(c => c.parentSessionId === fx.id)
      assert.strictEqual(children.length, 1)
      const rollup = buildSpawnRollup(children, { parentModel: 'claude-opus-4-8', costOf })
      assert.strictEqual(rollup.totalInputTokens, 111)
      assert.strictEqual(rollup.totalOutputTokens, 22)
      assert.strictEqual(rollup.totalCacheReadTokens, 333)
      assert.strictEqual(rollup.totalCacheCreateTokens, 444)
      assert.strictEqual(rollup.asyncUnreportedChildren, undefined, 'the async child is no longer unreported')
      assert.ok(rollup.totalCostUsd > 0, 'child cost participates in the rollup')
    } finally { fx.cleanup() }
  })

  test('missing transcript keeps the honest unknown: zero buckets + spawnAsync + unreported count', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-m1', { subagent_type: 'spark', prompt: 'work' })
        + agentResult('2026-07-10T10:00:02Z', fx.cwd, 'tu-m1', asyncLaunchedTur('0missing0transcript')),
      )
      const linked = linkSubagentTranscripts(allCards(scanClaude(new LogReader({}))))
      const child = linked.find(c => c.sessionId === '0missing0transcript')
      assert.ok(child, 'placeholder still served — absence is not erasure')
      assert.strictEqual(child!.spawnAsync, true)
      assert.strictEqual(child!.inputTokens + child!.outputTokens + child!.cacheReadTokens + child!.cacheCreateTokens, 0)
      const rollup = buildSpawnRollup(linked.filter(c => c.parentSessionId === fx.id), { parentModel: 'claude-opus-4-8', costOf })
      assert.strictEqual(rollup.asyncUnreportedChildren, 1, 'zero totals must never read as measured coverage')
    } finally { fx.cleanup() }
  })

  test('a usage-less transcript still collapses the pair but keeps spawnAsync (unknown, not free)', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn an async agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-z1', { subagent_type: 'spark', prompt: 'work' })
        + agentResult('2026-07-10T10:00:02Z', fx.cwd, 'tu-z1', asyncLaunchedTur('00justlaunched00')),
      )
      // Child transcript exists but no assistant turn has been tailed yet — zero usage.
      writeSubagentTranscript(fx, '00justlaunched00', userText('2026-07-10T10:00:05Z', fx.cwd, 'work'))
      const linked = linkSubagentTranscripts(allCards(scanClaude(new LogReader({}))))
      const children = linked.filter(c => c.parentSessionId === fx.id)
      assert.strictEqual(children.length, 1, 'one child, not a placeholder + an empty transcript twin')
      assert.strictEqual(children[0].sessionId, 'agent-00justlaunched00')
      assert.strictEqual(children[0].spawnAsync, true, 'zero buckets stay flagged unknown')
    } finally { fx.cleanup() }
  })

  test('a SYNC pair dedupes too: the call-complete transcript beats the final-turn snapshot', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'spawn a sync agent')
        + agentSpawn('2026-07-10T10:00:01Z', fx.cwd, 'tu-s1', { subagent_type: 'spark', prompt: 'do sync work' })
        + agentResult('2026-07-10T10:05:00Z', fx.cwd, 'tu-s1', syncCompletionTur('5y4c00aabbccdd11')),
      )
      // The transcript sums EVERY turn (two assistant rows) — more than the snapshot's final turn.
      writeSubagentTranscript(fx, '5y4c00aabbccdd11',
        userText('2026-07-10T10:00:05Z', fx.cwd, 'do sync work')
        + childAssistant('2026-07-10T10:01:00Z', fx.cwd, { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 })
        + childAssistant('2026-07-10T10:04:00Z', fx.cwd, { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 200 }),
      )
      const linked = linkSubagentTranscripts(allCards(scanClaude(new LogReader({}))))
      const children = linked.filter(c => c.parentSessionId === fx.id)
      assert.strictEqual(children.length, 1, 'sync placeholder + transcript twin collapse to one child')
      assert.strictEqual(children[0].sessionId, 'agent-5y4c00aabbccdd11')
      assert.strictEqual(children[0].inputTokens, 140, 'summed transcript totals win over the final-turn snapshot')
      assert.strictEqual(children[0].spawnAsync, undefined)
      assert.strictEqual(children[0].spawnKind, 'fresh')
    } finally { fx.cleanup() }
  })

  test('cross-parent guard: a transcript linked to another parent never absorbs the placeholder', () => {
    const mk = (id: string, over: Partial<SessionSummaryCard>): SessionSummaryCard => ({
      sessionId: id, traceId: id, source: 'claude_code', dataSource: 'log', workspace: 'ws',
      userRequest: 'x', model: 'claude-sonnet-5', turns: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      cacheHitRate: 0, durationMs: 0, startTime: '2026-07-10T10:00:00Z',
      filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
      toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
      outcome: 'unknown', timeline: [], backgroundSpans: [], loopSignals: [], ...over,
    })
    const placeholder = mk('abc123', { parentSessionId: 'parent-A', spawnAsync: true })
    const transcript = mk('agent-abc123', { parentSessionId: 'parent-B', inputTokens: 500 })
    const linked = linkSubagentTranscripts([placeholder, transcript])
    assert.strictEqual(linked.length, 2, 'ids collide but parents differ — no merge')
    assert.strictEqual(linked.find(c => c.sessionId === 'abc123')!.spawnAsync, true)
  })

  test('an OTEL card is never mistaken for a transcript twin', () => {
    const mk = (id: string, over: Partial<SessionSummaryCard>): SessionSummaryCard => ({
      sessionId: id, traceId: id, source: 'claude_code', dataSource: 'log', workspace: 'ws',
      userRequest: 'x', model: 'claude-sonnet-5', turns: 1,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      cacheHitRate: 0, durationMs: 0, startTime: '2026-07-10T10:00:00Z',
      filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [],
      toolCounts: {}, totalToolCalls: 0, totalLlmCalls: 1, errors: 0,
      outcome: 'unknown', timeline: [], backgroundSpans: [], loopSignals: [], ...over,
    })
    const placeholder = mk('def456', { parentSessionId: 'parent-A', spawnAsync: true })
    const otelTwin = mk('agent-def456', { dataSource: 'otel', inputTokens: 500 })
    const linked = linkSubagentTranscripts([placeholder, otelTwin])
    assert.strictEqual(linked.length, 2, 'the twin must be a parsed LOG transcript, never an OTEL card')
    assert.strictEqual(linked.find(c => c.sessionId === 'def456')!.spawnAsync, true)
  })
})
