// src/test/rustLogScan.test.ts — P2 cross-engine parity (TRDD-DMWOBWFH): the Rust transcript
// parser + TS wrapper must produce EXACTLY what LogReader._parseClaudeFile produces, compared on
// the JSON wire shape (JSON round-trip normalizes explicit-undefined vs absent, which is also
// what persistence and the dashboard actually see).
//
// The fixture deliberately exercises every parity trap the port documents: usage dedup across
// multi-row messages, "<synthetic>" model rows, fast/standard mixed speed (speedBlendedCostUsd),
// Read byte correlation via tool_result, full-result attachment, Task sync completion + Agent
// async launch, ai-title/entrypoint enrichment, the local-command-caveat api initiator, scratch
// path harvest (a missing referenced file resolves deterministically), and astral characters
// (UTF-16 length parity in the retention accounting).

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { LogReader } from '../logReader'
import { finishRustTranscript } from '../rustLogScan'

const BIN = path.join(__dirname, '..', '..', '..', 'rust-core', 'target', 'release', 'allogscan')
const haveBin = fs.existsSync(BIN)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-logscan-'))
const fixture = path.join(tmpDir, 'cccccccc-1111-2222-3333-444444444444.jsonl')

const T0 = Date.now() - 60_000
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const LINES: unknown[] = [
  { type: 'user', timestamp: iso(0), cwd: '/Users/someone/proj', entrypoint: 'cli',
    message: { role: 'user', content: 'please fix the crash — só 𝄞 unicode here' } },
  { type: 'ai-title', aiTitle: 'Crash fix session' },
  // One assistant MESSAGE split over two rows repeating the same usage — must count ONCE.
  { type: 'assistant', timestamp: iso(1000),
    message: { id: 'msg_1', model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'looking at the loader 𝄞' }] } },
  { type: 'assistant', timestamp: iso(1500),
    message: { id: 'msg_1', model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
      content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/Users/someone/proj/loader.ts' } }] } },
  // tool_result resolves the Read's byte volume + attaches the full result.
  { type: 'user', timestamp: iso(2000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: 'line1\nline2 é' }] } },
  // A FAST turn on a different message id → mixed-speed session → speedBlendedCostUsd.
  { type: 'assistant', timestamp: iso(3000),
    message: { id: 'msg_2', model: 'claude-opus-5',
      usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, speed: 'fast' },
      content: [
        { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/Users/someone/proj/loader.ts', old_string: 'aaa', new_string: 'bbbb' } },
        { type: 'tool_use', id: 'tu_task', name: 'Task', input: { subagent_type: 'general-purpose', prompt: 'audit the loader', model: 'sonnet' } },
      ] } },
  // Synchronous Task completion: sibling toolUseResult carries the sub-agent footprint.
  { type: 'user', timestamp: iso(4000),
    toolUseResult: {
      usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
      totalTokens: 1234, totalToolUseCount: 3, totalDurationMs: 4567,
      agentId: 'agent-abc', agentType: 'general-purpose', resolvedModel: 'claude-sonnet-5',
      toolStats: { readCount: 2, bashCount: 1 },
      'output-file': '/tmp/claude-501/scratch/report.md',
    },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_task', content: [{ type: 'text', text: 'audit done: all clean' }] }] } },
  // An async Agent launch: acknowledgment only, zero usage — linked child, spawnAsync.
  { type: 'assistant', timestamp: iso(5000),
    message: { id: 'msg_3', model: '<synthetic>',
      content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'spark', prompt: 'background chore', isolation: 'worktree' } }] } },
  { type: 'user', timestamp: iso(6000),
    toolUseResult: { status: 'async_launched', agentId: 'agent-async-1', resolvedModel: 'claude-haiku-4-5' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'launched' }] } },
  // A Write with content bytes.
  { type: 'assistant', timestamp: iso(7000),
    message: { id: 'msg_4', model: 'claude-opus-5',
      usage: { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/Users/someone/proj/out.txt', content: 'hello é world' } }] } },
]
fs.writeFileSync(fixture, LINES.map(l => JSON.stringify(l)).join('\n') + '\n')

// An api-initiated (claude -p) transcript: caveat prefix flips initiator to 'api'.
const apiFixture = path.join(tmpDir, 'dddddddd-1111-2222-3333-444444444444.jsonl')
fs.writeFileSync(apiFixture, [
  JSON.stringify({ type: 'user', timestamp: iso(0), cwd: '/w',
    message: { role: 'user', content: '<local-command-caveat>injected</local-command-caveat>  run the batch' } }),
  JSON.stringify({ type: 'assistant', timestamp: iso(1000),
    message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'done' }] } }),
].join('\n') + '\n')

function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v))
}

function tsParse(file: string): unknown {
  const r = new LogReader().parseFile(file, 'claude')
  assert.ok(r, `TS parser returned null for ${file}`)
  return normalize(r)
}

function rustParse(file: string): unknown {
  const out = execFileSync(BIN, [file], { maxBuffer: 1 << 28 }).toString()
  const lines = out.split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 1, `expected one NDJSON result for ${file}`)
  const parsed = JSON.parse(lines[0]) as Parameters<typeof finishRustTranscript>[0]
  return normalize(finishRustTranscript(parsed))
}

suite('rustLogScan — P2 cross-engine parity', () => {
  const parityTest = haveBin ? test : test.skip

  parityTest('🐌 the rich fixture parses IDENTICALLY through both engines (card + child cards)', function () {
    this.timeout(30_000)
    const ts = tsParse(fixture) as { card: Record<string, unknown>; childCards?: unknown[] }
    const rust = rustParse(fixture) as { card: Record<string, unknown>; childCards?: unknown[] }
    // Assert the field the port most easily gets wrong FIRST, for a readable failure…
    assert.strictEqual(rust.card.speedBlendedCostUsd, ts.card.speedBlendedCostUsd,
      'mixed-speed blended cost must price identically from blendTurns')
    assert.deepStrictEqual(rust.card, ts.card, 'parent card must match field-for-field')
    assert.deepStrictEqual(rust.childCards, ts.childCards, 'sub-agent child cards must match')
    assert.deepStrictEqual(rust, ts)
  })

  parityTest('🐌 the api-initiated (caveat) transcript parses identically', function () {
    this.timeout(30_000)
    assert.deepStrictEqual(rustParse(apiFixture), tsParse(apiFixture))
  })

  parityTest('🐌 a REAL transcript from this machine parses identically', function () {
    this.timeout(60_000)
    const real = path.join(os.homedir(),
      '.claude', 'projects', '-Users-emanuelesabetta-Code-AgentlensPro')
    let candidate: string | null = null
    try {
      for (const f of fs.readdirSync(real)) {
        if (f.endsWith('.jsonl')) {
          const p = path.join(real, f)
          if (fs.statSync(p).size > 1_000_000) { candidate = p; break }
        }
      }
    } catch { /* dir absent on other machines */ }
    if (!candidate) this.skip()
    assert.deepStrictEqual(rustParse(candidate!), tsParse(candidate!))
  })
})
