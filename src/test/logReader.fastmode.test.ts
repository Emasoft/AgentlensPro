import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'
import { calcTokenCostUsd } from '../shared/pricing'

// _scanClaude is private; the sibling logReader tests reach it the same way.
type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

function claudeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-fastmode-'))
  const sub = path.join(root, 'projects', 'proj')
  fs.mkdirSync(sub, { recursive: true })
  const id = 'fastmode-' + Math.random().toString(36).slice(2, 8)
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

const userText = (ts: string, cwd: string, text: string): string =>
  JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } }) + '\n'

// One assistant "turn". A distinct message.id is required or usage is deduped away.
const turn = (ts: string, cwd: string, msgId: string, model: string, speed: 'fast' | undefined): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: msgId, model,
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(speed ? { speed } : {}) },
      content: [{ type: 'text', text: 'hi' }],
    },
  }) + '\n'

suite('logReader fast-mode pricing (S1-F9)', () => {
  // Base input $5.00/MTok, `-fast` $10.00/MTok. Was opus-4-6 until 2026-07-26: Claude Code 2.1.219
  // dropped 4.6/4.7 from fast mode, and a fast-tagged 4.6 call is now billed at STANDARD rates — so
  // its `-fast` rate equals its base rate and this suite's "the blend is cheaper than all-fast"
  // assertion had nothing left to measure. The subject under test is the BLEND, so it needs a model
  // where fast is genuinely premium; 4.8 is one of the two that still is.
  const MODEL = 'claude-opus-4-8'

  test('a uniformly-fast session stamps <model>-fast and carries no speedBlendedCostUsd', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'go')
        + turn('2026-07-10T10:00:01Z', fx.cwd, 'm1', MODEL, 'fast')
        + turn('2026-07-10T10:00:02Z', fx.cwd, 'm2', MODEL, 'fast'))
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!.card
      assert.strictEqual(card.model, `${MODEL}-fast`, 'all-fast → -fast model')
      assert.strictEqual(card.speedBlendedCostUsd, undefined, 'uniform session uses the aggregate model rate')
    } finally { fx.cleanup() }
  })

  test('a mixed-speed session keeps the base model and blends per-turn cost (not all-fast)', () => {
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'go')
        + turn('2026-07-10T10:00:01Z', fx.cwd, 'm1', MODEL, 'fast')       // 1M input @ $10 = $10
        + turn('2026-07-10T10:00:02Z', fx.cwd, 'm2', MODEL, undefined))   // 1M input @ $5  = $5
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!.card
      assert.strictEqual(card.model, MODEL, 'mixed session keeps the base model (not -fast)')
      const expected = calcTokenCostUsd(1_000_000, 0, 0, 0, `${MODEL}-fast`) + calcTokenCostUsd(1_000_000, 0, 0, 0, MODEL)
      assert.ok(card.speedBlendedCostUsd !== undefined, 'mixed session carries a blended cost')
      assert.ok(Math.abs(card.speedBlendedCostUsd! - expected) < 1e-6, `blended expected ${expected}, got ${card.speedBlendedCostUsd}`)
      // The pre-fix bug priced BOTH turns at the fast rate — the blend must be strictly cheaper.
      const buggyAllFast = calcTokenCostUsd(2_000_000, 0, 0, 0, `${MODEL}-fast`)
      assert.ok(card.speedBlendedCostUsd! < buggyAllFast, 'blend is cheaper than the buggy all-fast price')
    } finally { fx.cleanup() }
  })
})
