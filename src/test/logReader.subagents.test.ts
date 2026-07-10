import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, type LogSessionResult } from '../logReader'

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
      // inputTokens is stored total-incl-cache (parent/OTEL convention): 100 + 400 + 200.
      assert.strictEqual(child!.inputTokens, 700)
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
      assert.strictEqual(children[0].inputTokens, 700, 'zero-bucket placeholder was overwritten with measured usage')
    } finally { fx.cleanup() }
  })
})
