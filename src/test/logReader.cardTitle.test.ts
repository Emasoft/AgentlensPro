import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { LogReader, type LogSessionResult } from '../logReader'

// Card enrichment from transcript signals (TRDD-B22NYTOY P4): `ai-title` records → card.title
// (latest wins — CC regenerates the title as the session evolves), top-level `entrypoint` →
// card.entrypoint (first wins — it never changes within a session).

// _scanClaude is private; the sibling logReader tests reach it the same way.
type ClaudeScanner = { _scanClaude(): LogSessionResult[] }
const scanClaude = (r: LogReader): LogSessionResult[] => (r as unknown as ClaudeScanner)._scanClaude()

function claudeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cardtitle-'))
  const sub = path.join(root, 'projects', 'proj')
  fs.mkdirSync(sub, { recursive: true })
  const id = 'cardtitle-' + Math.random().toString(36).slice(2, 8)
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

const line = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'

const userText = (ts: string, cwd: string, text: string, extra: Record<string, unknown> = {}): string =>
  line({ type: 'user', timestamp: ts, cwd, message: { content: text }, ...extra })

const turn = (ts: string, cwd: string, msgId: string): string =>
  line({
    type: 'assistant', timestamp: ts, cwd,
    message: {
      id: msgId, model: 'claude-opus-4-6',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      content: [{ type: 'text', text: 'hi' }],
    },
  })

suite('logReader card title/entrypoint enrichment (TRDD-B22NYTOY P4)', () => {
  test('ai-title records set card.title, latest wins', () => {
    // Tests that a session with two ai-title records ends up titled by the LAST one.
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'go')
        + line({ type: 'ai-title', timestamp: '2026-07-10T10:00:01Z', aiTitle: 'first-title' })
        + turn('2026-07-10T10:00:02Z', fx.cwd, 'm1')
        + line({ type: 'ai-title', timestamp: '2026-07-10T10:00:03Z', aiTitle: 'refined-title' }))
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!.card
      assert.strictEqual(card.title, 'refined-title', 'latest ai-title wins')
    } finally { fx.cleanup() }
  })

  test('top-level entrypoint sets card.entrypoint, first wins', () => {
    // Tests that the first record carrying an entrypoint field stamps the card.
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'go', { entrypoint: 'cli' })
        + turn('2026-07-10T10:00:01Z', fx.cwd, 'm1'))
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!.card
      assert.strictEqual(card.entrypoint, 'cli')
    } finally { fx.cleanup() }
  })

  test('cards without ai-title/entrypoint carry undefined (never empty strings)', () => {
    // Tests the absence case: no fabricated values on sessions lacking these signals.
    const fx = claudeFixture()
    try {
      fs.writeFileSync(fx.file,
        userText('2026-07-10T10:00:00Z', fx.cwd, 'go')
        + turn('2026-07-10T10:00:01Z', fx.cwd, 'm1'))
      const card = scanClaude(new LogReader({})).find(r => r.card.sessionId === fx.id)!.card
      assert.strictEqual(card.title, undefined)
      assert.strictEqual(card.entrypoint, undefined)
    } finally { fx.cleanup() }
  })
})
