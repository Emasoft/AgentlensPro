import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildConversationFromFile } from '../conversation'
import type { Conversation } from '../shared/summarizerTypes'

// ── Conversation transcript parser (TRDD-B22NYTOY) — fixture-driven, real files ─────────────────
// Each test writes a synthetic .jsonl (shapes copied from REAL live transcripts — see the research
// report reports/research/20260716_005512+0200-token-companion-jsonl-ingest-distill.md) into a
// tmpdir and drives the real streaming parser. No mocks: the parser IS a file contract.

let seq = 0
function writeFixture(lines: Array<Record<string, unknown>>): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-conv-${process.pid}-${seq++}-`))
  const file = path.join(dir, 'sess-1.jsonl')
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** An assistant record chunk (CC writes one per content type, same message.id). */
function asst(msgId: string, content: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant', uuid: `u-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2026-07-16T00:00:01.000Z', sessionId: 'sess-1', entrypoint: 'cli', cwd: '/tmp/proj',
    message: { id: msgId, model: 'claude-opus-4-8', content, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 13 } } },
    ...extra,
  }
}

function user(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user', uuid: `u-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: '2026-07-16T00:00:00.000Z', sessionId: 'sess-1',
    message: { role: 'user', content },
    ...extra,
  }
}

function build(lines: Array<Record<string, unknown>>): Promise<Conversation | null> {
  const { file } = writeFixture(lines)
  return buildConversationFromFile(file, 'sess-1')
}

suite('conversation — verbatim ordered narrative from the session .jsonl', () => {
  test('intra-turn block ORDER is preserved: thinking → text → tool_use, across streaming chunks merged by message.id', async () => {
    const conv = await build([
      user('do the thing'),
      // CC writes one record per content type, all sharing message.id — must merge into ONE turn
      asst('m1', [{ type: 'thinking', thinking: 'let me think' }]),
      asst('m1', [{ type: 'text', text: 'doing it now' }]),
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }]),
    ])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 2)
    const a = conv.turns[1]
    assert.strictEqual(a.role, 'assistant')
    assert.strictEqual(a.messageId, 'm1')
    assert.deepStrictEqual(a.blocks.map(b => b.kind), ['thinking', 'assistantText', 'toolUse'])
    assert.strictEqual(a.blocks[0].text, 'let me think')
    assert.strictEqual(a.blocks[1].text, 'doing it now')
    assert.strictEqual(a.blocks[2].toolName, 'Bash')
    assert.strictEqual(a.blocks[2].text, 'ls -la') // Bash shows the command, not JSON
  })

  test('tool_result (arriving in a user record) is PAIRED to its toolUse turn by tool_use_id — not turned into a user turn', async () => {
    const conv = await build([
      user('run it'),
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here' }]),
      asst('m2', [{ type: 'text', text: 'read it' }]),
    ])
    assert.ok(conv)
    // user, assistant(m1 + paired result), assistant(m2) — the tool_result user record makes NO turn
    assert.strictEqual(conv.turns.length, 3)
    const a1 = conv.turns[1]
    assert.deepStrictEqual(a1.blocks.map(b => b.kind), ['toolUse', 'toolResult'])
    assert.strictEqual(a1.blocks[1].toolUseId, 't1')
    assert.strictEqual(a1.blocks[1].toolName, 'Read')
    assert.strictEqual(a1.blocks[1].text, 'file contents here')
  })

  test('TWO calls of the same tool in one turn stay separate ordered blocks (the case contextHistory merges away)', async () => {
    const conv = await build([
      user('grep twice'),
      asst('m1', [
        { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'alpha' } },
        { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'beta' } },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: 'alpha hit' },
        { type: 'tool_result', tool_use_id: 't2', content: 'beta hit' },
      ]),
    ])
    assert.ok(conv)
    const a = conv.turns[1]
    assert.deepStrictEqual(a.blocks.map(b => `${b.kind}:${b.toolUseId}`), [
      'toolUse:t1', 'toolUse:t2', 'toolResult:t1', 'toolResult:t2',
    ])
    assert.strictEqual(a.blocks[2].text, 'alpha hit')
    assert.strictEqual(a.blocks[3].text, 'beta hit')
    assert.strictEqual(conv.totals.toolCalls, 2)
  })

  test('a mixed user record (tool_result + real text) pairs the result AND starts a new user turn with the text', async () => {
    const conv = await build([
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }]),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: '/home' },
        { type: 'text', text: 'now do more' },
      ]),
    ])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 2)
    assert.strictEqual(conv.turns[0].blocks[1].kind, 'toolResult')
    assert.strictEqual(conv.turns[1].role, 'user')
    assert.strictEqual(conv.turns[1].blocks[0].text, 'now do more')
  })

  test('sidechain (subagent) records are labeled; usage + cache tier5m/1h captured once per message.id', async () => {
    const conv = await build([
      user('spawn'),
      asst('m1', [{ type: 'text', text: 'child working' }], { isSidechain: true }),
    ])
    assert.ok(conv)
    const a = conv.turns[1]
    assert.strictEqual(a.sidechain, true)
    assert.ok(a.usage)
    assert.strictEqual(a.usage.tier5m, 7)
    assert.strictEqual(a.usage.tier1h, 13)
    assert.strictEqual(a.usage.cacheRead, 100)
    assert.strictEqual(conv.totals.usage.tier1h, 13)
  })

  test('system/turn_duration attaches durationMs to the just-finished assistant turn; totals sum it', async () => {
    const conv = await build([
      user('q'),
      asst('m1', [{ type: 'text', text: 'a' }]),
      { type: 'system', subtype: 'turn_duration', durationMs: 4321, messageCount: 3, timestamp: '2026-07-16T00:00:02.000Z' },
    ])
    assert.ok(conv)
    assert.strictEqual(conv.turns[1].durationMs, 4321)
    assert.strictEqual(conv.totals.durationMs, 4321)
  })

  test('system/compact_boundary lands in compactions[] with pre/post/dropped tokens and afterTurn position', async () => {
    const conv = await build([
      user('q'),
      asst('m1', [{ type: 'text', text: 'a' }]),
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 607539, postTokens: 20891, cumulativeDroppedTokens: 586648 } },
      user('after compact'),
    ])
    assert.ok(conv)
    assert.strictEqual(conv.compactions.length, 1)
    const c = conv.compactions[0]
    assert.strictEqual(c.afterTurn, 2)
    assert.strictEqual(c.trigger, 'manual')
    assert.strictEqual(c.preTokens, 607539)
    assert.strictEqual(c.postTokens, 20891)
    assert.strictEqual(c.droppedTokens, 586648)
  })

  test('ai-title (latest wins) → title; agent-name → agentName; entrypoint + cwd from the first assistant record', async () => {
    const conv = await build([
      { type: 'ai-title', aiTitle: 'First title', sessionId: 'sess-1' },
      user('q'),
      asst('m1', [{ type: 'text', text: 'a' }]),
      { type: 'ai-title', aiTitle: 'Better later title', sessionId: 'sess-1' },
      { type: 'agent-name', agentName: 'my-agent', sessionId: 'sess-1' },
    ])
    assert.ok(conv)
    assert.strictEqual(conv.title, 'Better later title')
    assert.strictEqual(conv.agentName, 'my-agent')
    assert.strictEqual(conv.entrypoint, 'cli')
    assert.strictEqual(conv.cwd, '/tmp/proj')
    assert.strictEqual(conv.model, 'claude-opus-4-8')
  })

  test('session-resume duplicate assistant chunks (same message.id seen again) do not double turns or usage', async () => {
    const chunk = asst('m1', [{ type: 'text', text: 'once' }])
    const conv = await build([user('q'), chunk, { ...chunk }]) // resume re-appends the same record
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 2)
    assert.strictEqual(conv.totals.usage.input, 10) // counted once
  })

  test('user record dedup by uuid (resume rewrites) — one user turn', async () => {
    const u = user('hello')
    const conv = await build([u, { ...u }])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 1)
  })

  test('unknown record types are COUNTED in otherRecords, never silently dropped and never noise turns', async () => {
    const conv = await build([
      user('q'),
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'totally-new-record-type', payload: 1 },
      { type: 'system', subtype: 'stop_hook_summary', content: 'hooks ran' },
    ])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 1)
    assert.strictEqual(conv.otherRecords['file-history-snapshot'], 2)
    assert.strictEqual(conv.otherRecords['totally-new-record-type'], 1)
    assert.strictEqual(conv.otherRecords['system/stop_hook_summary'], 1)
  })

  test('meta/caveat user records become systemNote turns (role system), not user prompts', async () => {
    const conv = await build([
      user('[janitor-heartbeat]\nstub output', { isMeta: true }),
      user('real prompt'),
    ])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 2)
    assert.strictEqual(conv.turns[0].role, 'system')
    assert.strictEqual(conv.turns[0].blocks[0].kind, 'systemNote')
    assert.strictEqual(conv.turns[1].role, 'user')
  })

  test('<synthetic> zero-usage records are skipped (title-gen noise)', async () => {
    const synthetic = {
      type: 'assistant', uuid: 'u-syn', timestamp: '2026-07-16T00:00:03.000Z', sessionId: 'sess-1',
      message: { id: 'syn1', model: '<synthetic>', content: [{ type: 'text', text: 'ignored' }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }
    const conv = await build([user('q'), synthetic])
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 1)
  })

  test('attachment records become an attachment block on the NEXT turn (injected-context semantics)', async () => {
    const conv = await build([
      { type: 'attachment', attachment: { type: 'file', displayPath: '/tmp/a.txt', content: 'attached body' } },
      user('with attachment'),
    ])
    assert.ok(conv)
    const u = conv.turns[0]
    assert.strictEqual(u.role, 'user')
    assert.deepStrictEqual(u.blocks.map(b => b.kind), ['attachment', 'userText'])
    assert.strictEqual(u.blocks[0].meta?.['label'], 'file: a.txt')
  })

  test('missing file → null; empty file → empty conversation, not a crash', async () => {
    assert.strictEqual(await buildConversationFromFile('/nonexistent/x.jsonl', 's'), null)
    const { file } = writeFixture([])
    fs.writeFileSync(file, '')
    const conv = await buildConversationFromFile(file, 'sess-1')
    assert.ok(conv)
    assert.strictEqual(conv.turns.length, 0)
    assert.strictEqual(conv.totals.turns, 0)
  })
})
