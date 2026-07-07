import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, type LogSessionResult } from '../logReader'

// ── Why this file exists ──────────────────────────────────────────────────────
// logReader used to slurp each JSONL with fs.readFileSync(path, 'utf-8'), which
// throws "Cannot create a string longer than 0x1fffffe8 characters" once a file
// passes V8's ~512 MiB single-string cap — so a multi-GB Claude/Codex session
// crashed the scan on every poll. The reader now streams in bounded chunks and
// keeps a per-file accumulator so only newly-appended bytes are parsed. These
// tests pin the four properties that make that robust at 2-3 GB scale:
//   1. correct totals when a file is read across many small chunks,
//   2. an append re-uses the SAME accumulator (only the new bytes are read),
//   3. a truncation/rotation rebuilds from offset 0 (never a partial card),
//   4. a multi-byte UTF-8 character split across a chunk boundary survives,
// plus a slow, opt-in proof that an actual >512 MiB file parses (the exact case
// the old code crashed on). The slow test is gated behind AGENTLENS_SLOW_TESTS=1
// so the default unit run stays fast.

// ── Private-surface accessors ─────────────────────────────────────────────────
// We call the per-source scanners directly (instead of the aggregate scan()) so
// each test is hermetic and fast: scan() would also walk the machine's real
// Copilot / VS Code / OpenCode dirs. accumCache is read to prove incremental
// RESUME vs full REBUILD by object identity — the resume branch keeps the cached
// accumulator, the rebuild branch allocates a fresh one via factory().
type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
type CodexScanner = { _scanCodex(): LogSessionResult[] }
type AccumCacheHolder = { accumCache: Map<string, unknown> }

const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()
const scanCodex = (r: LogReader): LogSessionResult[] => (r as unknown as CodexScanner)._scanCodex()
const accumOf = (r: LogReader, file: string): unknown =>
  (r as unknown as AccumCacheHolder).accumCache.get(file)

const findCard = (results: LogSessionResult[], id: string): LogSessionResult | undefined =>
  results.find(r => r.card.sessionId === id)

// ── Fixtures (env-isolated temp dirs; CLAUDE_CONFIG_DIR / CODEX_HOME override the
//    real scan roots, so no machine state leaks in and nothing is left on disk) ──
let seq = 0
const uniqueId = (prefix: string): string => `${prefix}-${process.pid}-${seq++}`

interface Fixture { file: string; cwd: string; id: string; cleanup: () => void }

function makeFixture(prefix: string, envKey: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME', subParts: string[]): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `al-${prefix}-`))
  const sub = path.join(root, ...subParts)
  fs.mkdirSync(sub, { recursive: true })
  const id = uniqueId(prefix)
  const file = path.join(sub, `${id}.jsonl`)
  const orig = process.env[envKey]
  process.env[envKey] = root
  return {
    file, cwd: path.join(root, 'workspace'), id,
    cleanup() {
      if (orig === undefined) delete process.env[envKey]
      else process.env[envKey] = orig
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// CLAUDE_CONFIG_DIR points at the root; the resolver scans <root>/projects, so the
// file lives under projects/<slug>/ exactly like a real Claude session.
const claudeFixture = (): Fixture => makeFixture('claude', 'CLAUDE_CONFIG_DIR', ['projects', 'proj'])
// CODEX_HOME points at the root; the resolver scans <root>/sessions/**.
const codexFixture = (): Fixture => makeFixture('codex', 'CODEX_HOME', ['sessions', '2026', '06'])

// ── Line builders ─────────────────────────────────────────────────────────────
interface ClaudeUsage { input: number; output: number; cacheRead: number; cacheCreate: number }

const claudeUser = (ts: string, cwd: string, text: string): string =>
  JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } }) + '\n'

const claudeAssistant = (ts: string, cwd: string, u: ClaudeUsage): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      model: 'claude-opus-4-8',
      usage: {
        input_tokens: u.input, output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheCreate,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  }) + '\n'

// assistant turn carrying tool_use blocks (Read/Write/Edit) — drives per-file capture.
const claudeToolUse = (ts: string, cwd: string, blocks: Array<{ name: string; id: string; input: Record<string, unknown> }>): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: blocks.map(b => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input })),
    },
  }) + '\n'

// user turn carrying tool_result blocks — the Read's returned bytes (resolved by tool_use_id).
const claudeToolResult = (ts: string, cwd: string, results: Array<{ toolUseId: string; content: string }>): string =>
  JSON.stringify({
    type: 'user', timestamp: ts, cwd,
    message: { content: results.map(r => ({ type: 'tool_result', tool_use_id: r.toolUseId, content: r.content })) },
  }) + '\n'

// One JSONL row of an assistant message that Claude Code split across several rows: every row
// carries the SAME message.id and REPEATS the full `usage`, but a DISTINCT content block. Used to
// prove usage is counted once per message.id while each block's tool_use still counts.
const claudeMsgRow = (ts: string, cwd: string, u: ClaudeUsage, messageId: string, block: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: messageId, model: 'claude-opus-4-8',
      usage: {
        input_tokens: u.input, output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheCreate,
      },
      content: [block],
    },
  }) + '\n'

interface CodexTotal { input_tokens: number; cached_input_tokens: number; output_tokens: number; reasoning_output_tokens: number }

const codexMeta = (ts: string, cwd: string): string =>
  JSON.stringify({ type: 'session_meta', timestamp: ts, payload: { cwd } }) + '\n'
const codexTurnContext = (ts: string, model: string): string =>
  JSON.stringify({ type: 'turn_context', timestamp: ts, payload: { model } }) + '\n'
const codexUserMsg = (ts: string, text: string): string =>
  JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'user_message', message: text } }) + '\n'
const codexTokenCount = (ts: string, total: CodexTotal): string =>
  JSON.stringify({
    type: 'event_msg', timestamp: ts,
    payload: { type: 'token_count', info: { model: 'gpt-5-codex', total_token_usage: total, last_token_usage: { input_tokens: 1 } } },
  }) + '\n'

// Each Claude assistant line below uses these per-turn tokens. Since the P1
// accounting de-inflation (commit 4d28f24), the card's inputTokens stores the
// RAW input only (input_tokens); cacheRead and cacheCreate live in their OWN
// card fields and are NEVER folded into inputTokens (logReader.ts:1923-1926).
const U: ClaudeUsage = { input: 100, output: 20, cacheRead: 50, cacheCreate: 10 }
const PER_TURN_INPUT = U.input  // 100 — raw input the card records per message

suite('LogReader — large / streaming JSONL', () => {
  test('streams a Claude JSONL across tiny read chunks with correct token totals', () => {
    const fx = claudeFixture()
    try {
      // 16-byte chunks force every line to span many reads (and the pending-buffer
      // carry between chunks) — the same machinery a multi-GB file exercises.
      let content = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Fix the bug')
      for (let i = 0; i < 5; i++) content += claudeAssistant(`2026-06-23T10:0${i + 1}:00.000Z`, fx.cwd, U)
      fs.writeFileSync(fx.file, content)

      const reader = new LogReader({ streamChunkBytes: 16 })
      const card = findCard(scanClaude(reader), fx.id)?.card
      assert.ok(card, 'session should be parsed')
      assert.strictEqual(card!.model, 'claude-opus-4-8')
      assert.strictEqual(card!.userRequest, 'Fix the bug')
      assert.strictEqual(card!.turns, 5)
      assert.strictEqual(card!.inputTokens, 5 * PER_TURN_INPUT)  // 500 = 5 × raw input (de-inflated)
      assert.strictEqual(card!.outputTokens, 5 * U.output)       // 100
      assert.strictEqual(card!.cacheReadTokens, 5 * U.cacheRead) // 250
      assert.strictEqual(card!.cacheCreateTokens, 5 * U.cacheCreate) // 50
    } finally {
      fx.cleanup()
    }
  })

  test('counts a multi-row Claude message (same message.id) ONCE, not per content-block row', () => {
    const fx = claudeFixture()
    try {
      // Claude Code writes ONE assistant message as N rows (one per content block) with the SAME
      // message.id, repeating the full usage in each. Message 1 = thinking+text+2 tool_use = 4 rows;
      // message 2 = 1 text row. Usage must be counted twice (2 messages), NOT 5 times (5 rows).
      const mid1 = 'msg_aaaaaaaaaaaaaaaaaaaaaa', mid2 = 'msg_bbbbbbbbbbbbbbbbbbbbbb'
      let content = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Do work')
      content += claudeMsgRow('2026-06-23T10:01:00.000Z', fx.cwd, U, mid1, { type: 'thinking', thinking: 'hmm' })
      content += claudeMsgRow('2026-06-23T10:01:00.000Z', fx.cwd, U, mid1, { type: 'text', text: 'ok' })
      content += claudeMsgRow('2026-06-23T10:01:00.000Z', fx.cwd, U, mid1, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
      content += claudeMsgRow('2026-06-23T10:01:00.000Z', fx.cwd, U, mid1, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } })
      content += claudeMsgRow('2026-06-23T10:02:00.000Z', fx.cwd, U, mid2, { type: 'text', text: 'done' })
      fs.writeFileSync(fx.file, content)

      const reader = new LogReader({ streamChunkBytes: 16 })
      const card = findCard(scanClaude(reader), fx.id)?.card
      assert.ok(card, 'session should be parsed')
      // usage counted ONCE per message.id → 2 messages, not 5 rows.
      assert.strictEqual(card!.turns, 2, 'turns = distinct messages, not content-block rows')
      assert.strictEqual(card!.inputTokens, 2 * PER_TURN_INPUT, 'raw input counted once per message')
      assert.strictEqual(card!.outputTokens, 2 * U.output, 'output counted once per message')
      assert.strictEqual(card!.cacheReadTokens, 2 * U.cacheRead, 'cache-read counted once per message')
      assert.strictEqual(card!.cacheCreateTokens, 2 * U.cacheCreate)
      // tool counts ARE per-row (each tool_use is a distinct block) → both still counted.
      assert.strictEqual(card!.totalToolCalls, 2, 'both tool_use blocks counted despite usage dedup')
    } finally {
      fx.cleanup()
    }
  })

  test('incrementally parses only appended bytes (same accumulator) with cumulative totals', () => {
    const fx = claudeFixture()
    try {
      let content = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Refactor')
      for (let i = 0; i < 4; i++) content += claudeAssistant(`2026-06-23T10:0${i + 1}:00.000Z`, fx.cwd, U)
      fs.writeFileSync(fx.file, content)

      const reader = new LogReader({ streamChunkBytes: 64 })
      const first = findCard(scanClaude(reader), fx.id)?.card
      assert.strictEqual(first!.turns, 4)
      assert.strictEqual(first!.inputTokens, 4 * PER_TURN_INPUT)
      const accum1 = accumOf(reader, fx.file)
      assert.ok(accum1, 'first scan must cache an accumulator')

      // Append 3 more turns; the next scan must read ONLY the new bytes into the
      // SAME accumulator and report the cumulative N+M totals (not just M, and not
      // a from-scratch re-read).
      let more = ''
      for (let i = 4; i < 7; i++) more += claudeAssistant(`2026-06-23T10:0${i + 1}:00.000Z`, fx.cwd, U)
      fs.appendFileSync(fx.file, more)

      const second = findCard(scanClaude(reader), fx.id)?.card
      assert.strictEqual(second!.turns, 7, 'totals must aggregate across the append')
      assert.strictEqual(second!.inputTokens, 7 * PER_TURN_INPUT)
      // Object identity proves RESUME: a full re-read would allocate a fresh accum.
      assert.strictEqual(accumOf(reader, fx.file), accum1, 'append must extend the cached accumulator, not rebuild it')
    } finally {
      fx.cleanup()
    }
  })

  test('rebuilds from offset 0 when the file is truncated (rotation/overwrite)', () => {
    const fx = claudeFixture()
    try {
      let big = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'First session')
      for (let i = 0; i < 6; i++) big += claudeAssistant(`2026-06-23T10:0${i + 1}:00.000Z`, fx.cwd, U)
      fs.writeFileSync(fx.file, big)

      const reader = new LogReader({ streamChunkBytes: 64 })
      const first = findCard(scanClaude(reader), fx.id)?.card
      assert.strictEqual(first!.turns, 6)
      const accum1 = accumOf(reader, fx.file)

      // Overwrite with a SHORTER file (new size < previous read offset) — the
      // resume guard must fail and a fresh accumulator must rebuild from 0, so the
      // card reflects only the new content (no stale carry-over, no partial card).
      let small = claudeUser('2026-06-23T11:00:00.000Z', fx.cwd, 'Second session')
      small += claudeAssistant('2026-06-23T11:01:00.000Z', fx.cwd, U)
      small += claudeAssistant('2026-06-23T11:02:00.000Z', fx.cwd, U)
      fs.writeFileSync(fx.file, small)

      const second = findCard(scanClaude(reader), fx.id)?.card
      assert.strictEqual(second!.userRequest, 'Second session')
      assert.strictEqual(second!.turns, 2, 'truncation must rebuild, not append to stale state')
      assert.strictEqual(second!.inputTokens, 2 * PER_TURN_INPUT)
      assert.notStrictEqual(accumOf(reader, fx.file), accum1, 'truncation must allocate a fresh accumulator')
    } finally {
      fx.cleanup()
    }
  })

  test('preserves a 4-byte UTF-8 character split across a read-chunk boundary', () => {
    const fx = claudeFixture()
    try {
      // A 4-byte char (🎉 = F0 9F 8E 89) cannot fit inside a 3-byte chunk, so it is
      // GUARANTEED to straddle a read boundary regardless of alignment. The reader
      // must concatenate the raw line bytes before decoding (0x0A never appears
      // inside a multi-byte sequence), so the exact string round-trips.
      const text = 'café €20 🎉 done — façade ✓'
      fs.writeFileSync(fx.file, claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, text))

      const reader = new LogReader({ streamChunkBytes: 3 })
      const card = findCard(scanClaude(reader), fx.id)?.card
      assert.ok(card, 'session should be parsed')
      assert.strictEqual(card!.userRequest, text, 'multi-byte text must survive chunk-boundary splits')
    } finally {
      fx.cleanup()
    }
  })

  test('incrementally tracks Codex cumulative total_token_usage (last wins)', () => {
    const fx = codexFixture()
    try {
      let content = codexMeta('2026-06-23T10:00:00.000Z', fx.cwd)
      content += codexTurnContext('2026-06-23T10:00:01.000Z', 'gpt-5-codex')
      content += codexUserMsg('2026-06-23T10:00:02.000Z', 'Refactor the parser')
      content += codexTokenCount('2026-06-23T10:00:03.000Z',
        { input_tokens: 500, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 20 })
      fs.writeFileSync(fx.file, content)

      const reader = new LogReader({ streamChunkBytes: 32 })
      const first = findCard(scanCodex(reader), fx.id)?.card
      assert.ok(first, 'codex session should be parsed')
      assert.strictEqual(first!.model, 'gpt-5-codex')
      assert.strictEqual(first!.userRequest, 'Refactor the parser')
      assert.strictEqual(first!.turns, 1)
      // de-inflated: inputTokens = input_tokens(500) − cached_input_tokens(100) = 400 raw input.
      assert.strictEqual(first!.inputTokens, 400)
      const accum1 = accumOf(reader, fx.file)

      // total_token_usage is CUMULATIVE, so a later record supersedes (never sums)
      // the earlier one. Appending it and re-scanning must yield the LATEST totals
      // even though only the new bytes were read.
      fs.appendFileSync(fx.file, codexTokenCount('2026-06-23T10:05:00.000Z',
        { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 200, reasoning_output_tokens: 50 }))

      const second = findCard(scanCodex(reader), fx.id)?.card
      assert.strictEqual(second!.turns, 2)
      // last-wins AND de-inflated: 1200 input − 300 cached = 900 (not a sum of the two records).
      assert.strictEqual(second!.inputTokens, 900, 'cumulative total takes the LAST record (de-inflated), never a sum')
      assert.strictEqual(second!.cacheReadTokens, 300)
      assert.strictEqual(second!.outputTokens, 250)  // output 200 + reasoning 50
      assert.strictEqual(accumOf(reader, fx.file), accum1, 'append must extend the cached accumulator')
    } finally {
      fx.cleanup()
    }
  })

  test('captures per-file read/write/edit byte volumes (fileOps)', () => {
    const fx = claudeFixture()
    try {
      const READ = 'X'.repeat(500)   // bytes the Read returns
      const WRITE = 'Y'.repeat(300)  // bytes the Write produces
      const EDIT = 'Z'.repeat(120)   // bytes the Edit's new_string produces
      let c = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Do file work')
      c += claudeToolUse('2026-06-23T10:00:01.000Z', fx.cwd, [{ name: 'Read', id: 'tu_r1', input: { file_path: '/a.txt' } }])
      c += claudeToolResult('2026-06-23T10:00:02.000Z', fx.cwd, [{ toolUseId: 'tu_r1', content: READ }])
      c += claudeToolUse('2026-06-23T10:00:03.000Z', fx.cwd, [{ name: 'Write', id: 'tu_w1', input: { file_path: '/b.txt', content: WRITE } }])
      c += claudeToolUse('2026-06-23T10:00:04.000Z', fx.cwd, [{ name: 'Edit', id: 'tu_e1', input: { file_path: '/a.txt', new_string: EDIT } }])
      fs.writeFileSync(fx.file, c)

      const reader = new LogReader({ streamChunkBytes: 64 })
      const card = findCard(scanClaude(reader), fx.id)?.card
      assert.ok(card?.fileOps, 'fileOps should be populated for a Claude file session')
      const ops = new Map(card!.fileOps!.map(o => [o.path, o]))
      const a = ops.get('/a.txt'); const b = ops.get('/b.txt')
      assert.ok(a && b, 'both touched files should appear in fileOps')
      assert.strictEqual(a!.readBytes, 500); assert.strictEqual(a!.readCount, 1)
      assert.strictEqual(a!.editBytes, 120); assert.strictEqual(a!.editCount, 1)
      assert.strictEqual(a!.writeBytes, 0, 'a.txt was never written')
      assert.strictEqual(b!.writeBytes, 300); assert.strictEqual(b!.writeCount, 1)
      assert.strictEqual(b!.readBytes, 0, 'b.txt was never read')
    } finally {
      fx.cleanup()
    }
  })

  test('resolves a Read tool_result that arrives in a LATER scan (persisted pendingReads)', () => {
    const fx = claudeFixture()
    try {
      // The Read tool_use lands first; its tool_result (carrying the bytes) only arrives on
      // the next append. The read-bytes must still attribute correctly, which requires the
      // tool_use-id→path map to survive across scans inside the cached accumulator.
      let c = claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Read a big file')
      c += claudeToolUse('2026-06-23T10:00:01.000Z', fx.cwd, [{ name: 'Read', id: 'tu_x', input: { file_path: '/big.ts' } }])
      fs.writeFileSync(fx.file, c)

      const reader = new LogReader({ streamChunkBytes: 64 })
      const first = findCard(scanClaude(reader), fx.id)?.card
      const firstBig = first?.fileOps?.find(o => o.path === '/big.ts')
      assert.ok(!firstBig || firstBig.readBytes === 0, 'no read bytes before the tool_result is seen')

      fs.appendFileSync(fx.file, claudeToolResult('2026-06-23T10:00:05.000Z', fx.cwd, [{ toolUseId: 'tu_x', content: 'Q'.repeat(2048) }]))
      const second = findCard(scanClaude(reader), fx.id)?.card
      const secondBig = second!.fileOps!.find(o => o.path === '/big.ts')
      assert.ok(secondBig, '/big.ts should appear after its read resolves')
      assert.strictEqual(secondBig!.readBytes, 2048, 'read bytes resolved across scans via persisted pendingReads')
      assert.strictEqual(secondBig!.readCount, 1)
    } finally {
      fx.cleanup()
    }
  })

  // ── 🐌 Slow proof: an actual >512 MiB file (the exact case the old readFileSync
  //    crashed on). Opt-in via AGENTLENS_SLOW_TESTS=1 to keep the default run fast.
  const slowTest = process.env['AGENTLENS_SLOW_TESTS'] ? test : test.skip
  slowTest('🐌 parses a >512 MiB Claude JSONL without exceeding the V8 string cap', function (this: { timeout(ms: number): void }) {
    this.timeout(300000)
    const fx = claudeFixture()
    try {
      // 3 real turns carry the asserted totals; ~540 MiB of 1-MiB filler lines push
      // the file past V8's 0x1fffffe8 (536,870,888-byte) single-string limit. The
      // filler is a valid JSON object the accumulator ignores (no type/timestamp).
      const fillerOverhead = JSON.stringify({ type: 'summary', _pad: '' }).length + 1  // + '\n'
      const filler = JSON.stringify({ type: 'summary', _pad: 'x'.repeat((1 << 20) - fillerOverhead) }) + '\n'
      assert.strictEqual(Buffer.byteLength(filler), 1 << 20, 'each filler line is exactly 1 MiB')
      const FILLERS = 540  // 540 MiB, comfortably above the 512 MiB cap

      const fd = fs.openSync(fx.file, 'w')
      try {
        fs.writeSync(fd, claudeUser('2026-06-23T10:00:00.000Z', fx.cwd, 'Huge session'))
        for (let i = 0; i < 3; i++) fs.writeSync(fd, claudeAssistant(`2026-06-23T10:0${i + 1}:00.000Z`, fx.cwd, U))
        for (let i = 0; i < FILLERS; i++) fs.writeSync(fd, filler)
      } finally {
        fs.closeSync(fd)
      }
      assert.ok(fs.statSync(fx.file).size > 0x1fffffe8, 'fixture must exceed the V8 single-string cap')

      const reader = new LogReader()  // default 1 MiB chunks
      let card: LogSessionResult['card'] | undefined
      assert.doesNotThrow(() => { card = findCard(scanClaude(reader), fx.id)?.card }, 'streaming must not throw on a >512 MiB file')
      assert.ok(card, 'session should be parsed')
      assert.strictEqual(card!.turns, 3, 'filler lines must be ignored')
      assert.strictEqual(card!.inputTokens, 3 * PER_TURN_INPUT)
      assert.strictEqual(card!.outputTokens, 3 * U.output)
    } finally {
      fx.cleanup()
    }
  })
})
