import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'

// _scanClaude is private; the sibling logReader tests reach it the same way.
type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

// One assistant row per message id (a distinct id is required or usage is deduped away).
const turn = (ts: string, cwd: string, msgId: string, cacheCreation: Record<string, number> | undefined): string =>
  JSON.stringify({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: msgId, model: 'claude-opus-4-8',
      usage: {
        input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 100,
        ...(cacheCreation ? { cache_creation: cacheCreation } : {}),
      },
      content: [{ type: 'text', text: 'hi' }],
    },
  }) + '\n'

suite('logReader cacheCreateTokens1h fill (TRDD-ME89GHUA)', () => {
  test('a row with a cache_creation tier split carries its 1h part; a row without one leaves it undefined', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cache1h-'))
    const sub = path.join(root, 'projects', 'proj')
    fs.mkdirSync(sub, { recursive: true })
    const id = 'cache1h-' + Math.random().toString(36).slice(2, 8)
    const cwd = path.join(root, 'workspace')
    const orig = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = root
    try {
      fs.writeFileSync(path.join(sub, `${id}.jsonl`),
        JSON.stringify({ type: 'user', timestamp: '2026-07-10T10:00:00Z', cwd, message: { content: 'go' } }) + '\n'
        + turn('2026-07-10T10:00:01Z', cwd, 'm1', { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 })
        + turn('2026-07-10T10:00:02Z', cwd, 'm2', undefined))
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === id)!.card
      const llm = card.timeline.filter(e => e.cacheCreateTokens !== undefined)
      assert.strictEqual(llm.length, 2, 'both turns carry usage')
      assert.strictEqual(llm[0].cacheCreateTokens1h, 40, 'tier split present → the 1h part')
      assert.strictEqual(llm[1].cacheCreateTokens1h, undefined, 'no tier split → not observed, never invented from cacheCreate')
    } finally {
      if (orig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = orig
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
