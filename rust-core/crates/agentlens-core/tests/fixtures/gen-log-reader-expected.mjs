// Regenerates the P5b log-reader parity fixture from the COMPILED TS finish step (the oracle):
//   1. writes the fixture HOME tree under tests/fixtures/logs-home/ (one session per source:
//      a mixed-speed Claude transcript with a Task-spawned child, a Codex rollout, a Copilot CLI
//      events log, a Copilot VS Code delta log and a legacy .json) — FIXED timestamps, so the
//      files are committed and the Rust test needs no Node;
//   2. parses each file through the Rust allogscan binary (the same library the core links);
//   3. runs src/rustLogScan.ts::finishRustTranscript on every ParsedTranscript at a HOT and a
//      COLD "now" and writes log-reader-expected.json (cards keyed by sessionId).
// Run from the repo root AFTER `pnpm run compile-tests` (and a cargo build of allogscan):
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-log-reader-expected.mjs
// DEFERRED fields are deleted from the oracle output on purpose (see log_reader.rs head):
// accountId (call-body registry), generatedFiles/generatedFilesTruncated (fs heuristics). When
// P5c ports them, drop the deletions and the same fixture pins them.
import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { finishRustTranscript } = require('../../../../../out/test/rustLogScan.js')
const dir = new URL('.', import.meta.url).pathname
const repo = join(dir, '..', '..', '..', '..', '..')
const home = join(dir, 'logs-home')
rmSync(home, { recursive: true, force: true })

// 2026-08-01T10:00:00.000Z — fixed, so the committed transcripts never drift.
const T0 = Date.UTC(2026, 7, 1, 10, 0, 0)
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString()
const NOW_HOT = T0 + 10 * 60_000          // 10 min after the session → timelines kept
const NOW_COLD = T0 + 48 * 3_600_000      // 48 h after → older than the 24 h hot age → stripped
const w = (rel, body) => { const p = join(home, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); return p }
const jsonl = (lines) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'

const claude = w('.claude/projects/-Users-someone-proj/cccccccc-1111-2222-3333-444444444444.jsonl', jsonl([
  { type: 'user', timestamp: iso(0), cwd: '/Users/someone/proj', entrypoint: 'cli',
    message: { role: 'user', content: 'please fix the crash — só 𝄞 unicode here' } },
  { type: 'ai-title', aiTitle: 'Crash fix session' },
  { type: 'assistant', timestamp: iso(1000),
    message: { id: 'msg_1', model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
      content: [{ type: 'text', text: 'looking at the loader 𝄞' }] } },
  { type: 'assistant', timestamp: iso(1500),
    message: { id: 'msg_1', model: 'claude-opus-5',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 },
      content: [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: '/Users/someone/proj/loader.ts' } }] } },
  { type: 'user', timestamp: iso(2000),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: 'line1\nline2 é' }] } },
  // speed:'fast' on one turn → a MIXED-speed session → Rust emits blendTurns → speedBlendedCostUsd
  { type: 'assistant', timestamp: iso(3000),
    message: { id: 'msg_2', model: 'claude-opus-5',
      usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, speed: 'fast' },
      content: [
        { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/Users/someone/proj/loader.ts', old_string: 'aaa', new_string: 'bbbb' } },
        { type: 'tool_use', id: 'tu_task', name: 'Task', input: { subagent_type: 'general-purpose', prompt: 'audit the loader', model: 'sonnet' } },
      ] } },
  { type: 'user', timestamp: iso(4000),
    toolUseResult: {
      usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 },
      totalTokens: 1234, totalToolUseCount: 3, totalDurationMs: 4567,
      agentId: 'agent-abc', agentType: 'general-purpose', resolvedModel: 'claude-sonnet-5',
      toolStats: { readCount: 2, bashCount: 1 },
      'output-file': '/tmp/claude-501/scratch/report.md',
    },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_task', content: [{ type: 'text', text: 'audit done: all clean' }] }] } },
  { type: 'assistant', timestamp: iso(5000),
    message: { id: 'msg_3', model: '<synthetic>',
      content: [{ type: 'tool_use', id: 'tu_agent', name: 'Agent', input: { subagent_type: 'spark', prompt: 'background chore', isolation: 'worktree' } }] } },
  { type: 'user', timestamp: iso(6000),
    toolUseResult: { status: 'async_launched', agentId: 'agent-async-1', resolvedModel: 'claude-haiku-4-5' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_agent', content: 'launched' }] } },
  { type: 'assistant', timestamp: iso(7000),
    message: { id: 'msg_4', model: 'claude-opus-5',
      usage: { input_tokens: 30, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/Users/someone/proj/out.txt', content: 'hello é world' } }] } },
]))

const codex = w('.codex/sessions/2026/08/01/ffffffff-1111-2222-3333-444444444444.jsonl', jsonl([
  { timestamp: iso(0), type: 'session_meta', payload: { cwd: '/Users/someone/codex-proj' } },
  { timestamp: iso(500), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { timestamp: iso(1000), type: 'event_msg', payload: { type: 'user_message',
    message: '# Context from my IDE setup:\n\n## Active file: x.ts\n\n## My request for Codex:\nfix the é bug' } },
  { timestamp: iso(2000), type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 25 },
    last_token_usage: { input_tokens: 1000 } } } },
  { timestamp: iso(3000), type: 'event_msg', payload: { type: 'token_count', info: {
    model: 'gpt-5-codex-high',
    total_token_usage: { input_tokens: 2500, cached_input_tokens: 900, output_tokens: 120, reasoning_output_tokens: 60 },
    last_token_usage: { input_tokens: 1500 } } } },
]))

const cpCli = w('.copilot/session-state/abababab-1111-2222-3333-444444444444/events.jsonl', jsonl([
  { timestamp: iso(0), type: 'session.start',
    data: { sessionId: 'abababab', selectedModel: 'gpt-5', startTime: iso(0), context: { cwd: '/Users/someone/cp-proj' } } },
  { timestamp: iso(1000), type: 'user.message',
    data: { transformedContent: '<current_datetime>now</current_datetime>\n<system_reminder>\nstuff\n</system_reminder>\nplease fix the parser' } },
  { timestamp: iso(2000), type: 'assistant.message',
    data: { outputTokens: 40, model: 'gpt-5-mini',
      toolRequests: [{ name: 'edit', arguments: { path: '/Users/someone/cp-proj/a.ts' } }, { name: 'bash', arguments: {} }] } },
  { timestamp: iso(3000), type: 'assistant.message', data: { outputTokens: 15 } },
  { timestamp: iso(4000), type: 'session.shutdown',
    data: { currentTokens: 99999, modelMetrics: {
      'gpt-5': { usage: { inputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 30 } },
      'gpt-5-mini': { usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } } } } },
]))
// A session-state dir WITHOUT events.jsonl — discovery's stat gate must skip it.
mkdirSync(join(home, '.copilot/session-state/no-events-here'), { recursive: true })

const vsHash = 'Library/Application Support/Code/User/workspaceStorage/hash1'
w(`${vsHash}/workspace.json`, JSON.stringify({ folder: 'file:///Users/someone/vs%20proj' }))
const cpVs = w(`${vsHash}/chatSessions/acacacac-1111-2222-3333-444444444444.jsonl`, jsonl([
  { kind: 0, v: { creationDate: T0, sessionId: 'acacacac',
    inputState: { selectedModel: { id: 'copilot/gpt-4.1', metadata: { family: 'gpt-4.1' } } } } },
  { kind: 2, k: ['requests'], v: [{ timestamp: T0 + 1000, message: { text: 'refactor the auth module' }, modelId: 'copilot/gpt-4.1' }] },
  { kind: 1, k: ['requests', 0, 'completionTokens'], v: 33 },
  { kind: 2, k: ['requests'], v: [{ timestamp: T0 + 2000, completionTokens: 21 }] },
  { kind: 1, k: ['requests', 1, 'result'], v: { usage: { completionTokens: 22, promptTokens: 400 } } },
]))
const cpJson = w(`${vsHash}/chatSessions/adadadad-1111-2222-3333-444444444444.json`, JSON.stringify({
  sessionId: 'adadadad-1111-2222-3333-444444444444',
  creationDate: T0, lastMessageDate: T0 + 5000,
  inputState: { selectedModel: { metadata: { family: 'gpt-4o' } } },
  requests: [
    { modelId: 'copilot/gpt-4o', message: { parts: [{ text: '<attachment>x</attachment>' }, { text: 'explain this stack trace' }] },
      response: [{ kind: 'toolInvocationSerialized', toolId: 'readFile' }, { kind: 'text' }] },
    { response: [{ kind: 'toolInvocationSerialized', toolId: 'readFile' }] },
  ],
}))
// A .json WITH a .jsonl sibling of the same uuid → NOT a session (the sibling rule); parsing it
// would double-count, so it must simply not be discovered.
w(`${vsHash}/chatSessions/acacacac-1111-2222-3333-444444444444.json`, JSON.stringify({ sessionId: 'acacacac', requests: [] }))

// Rust parse → NDJSON (the core links the same library; allogscan is just the CLI over it).
const bin = join(repo, 'rust-core', 'target', 'release', 'allogscan')
const parse = (mode, file) => {
  const argv = mode === 'claude' ? [file] : [`--${mode}`, file]
  return execFileSync(bin, argv, { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean).map(l => JSON.parse(l))
}
const parsed = [
  ...parse('claude', claude), ...parse('codex', codex), ...parse('copilot-cli', cpCli),
  ...parse('copilot-vscode', cpVs), ...parse('copilot-vscode-json', cpJson),
]

// accountId is fed by the live CallBodyRegistry (OTLP ingest) — absent in a pure-parse oracle on
// both sides; the Rust registry has its own test. generatedFiles IS in the oracle (P5c): the
// fixture's harvested path does not exist, so it resolves to a deterministic `missing:true` ref
// on any machine, and the fixture sessions have no scratch tree under the temp roots.
const DEFERRED = ['accountId']
const finish = (nowMs) => {
  const out = {}
  for (const p of parsed) {
    const r = finishRustTranscript(structuredClone(p), nowMs)
    for (const card of [r.card, ...(r.childCards ?? [])]) {
      for (const k of DEFERRED) delete card[k]
      out[card.sessionId] = JSON.parse(JSON.stringify(card))   // undefined fields drop, as on the wire
    }
  }
  return out
}
const expected = { t0Ms: T0, nowHotMs: NOW_HOT, nowColdMs: NOW_COLD, hot: finish(NOW_HOT), cold: finish(NOW_COLD) }
writeFileSync(join(dir, 'log-reader-expected.json'), JSON.stringify(expected, null, 1) + '\n')
console.log(`log-reader-expected.json: ${parsed.length} transcripts, ${Object.keys(expected.hot).length} cards`)
