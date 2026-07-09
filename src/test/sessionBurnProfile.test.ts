import * as assert from 'assert'
import { sessionIdOf, extractToolNames } from '../sessionBurnProfile'

// REAL tests for the two raw-body extractors the burn profile depends on. Both were written to avoid
// JSON.parsing multi-MB bodies (a naive full-parse of ~18k bodies exhausted a 4GB heap), so both operate
// on raw text — which is exactly where a sloppy regex silently mis-attributes data.

suite('sessionBurnProfile — sessionIdOf (raw-body session attribution)', () => {
  // The body shape Claude Code actually emits: metadata.user_id is a JSON blob inside a JSON string.
  const body = (sessionId: string, messageText: string) => JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: [{ type: 'text', text: messageText }] }],
    metadata: { user_id: JSON.stringify({ device_id: 'dev-1', account_uuid: 'acct-1', session_id: sessionId }) },
  })

  test('reads the session id from metadata.user_id', () => {
    assert.strictEqual(sessionIdOf(body('aaaa1111-2222-3333', 'hello')), 'aaaa1111-2222-3333')
  })

  test('THE BUG: a session id MENTIONED in message text must never be attributed', () => {
    // A transcript that merely discusses another session (an agent analysing "28e3a88d") must still be
    // attributed to its OWN session. The first-match-anywhere regex this replaces returned '28e3a88d…',
    // so two different queries produced byte-identical profiles.
    const raw = body('bbbb4444-5555-6666', 'investigate session_id 28e3a88d-47e4-48ea and its "session_id":"deadbeef-0000" burn')
    assert.strictEqual(sessionIdOf(raw), 'bbbb4444-5555-6666')
  })

  test('fails CLOSED (null) when metadata.user_id is absent or unparseable', () => {
    assert.strictEqual(sessionIdOf(JSON.stringify({ model: 'x', messages: [] })), null)
    assert.strictEqual(sessionIdOf('{"user_id":"not-json"}'), null)
  })
})

suite('sessionBurnProfile — extractToolNames (tools[] fingerprint without a full parse)', () => {
  test('extracts only the names inside the tools array', () => {
    const raw = JSON.stringify({
      tools: [
        { name: 'Bash', description: 'run', input_schema: { type: 'object' } },
        { name: 'mcp__lean-ctx__ctx_read', description: 'read', input_schema: {} },
      ],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', name: 'ShouldNotAppear' }] }],
    })
    assert.deepStrictEqual(extractToolNames(raw), ['Bash', 'mcp__lean-ctx__ctx_read'])
  })

  test('bracket-matches past brackets that appear INSIDE description strings', () => {
    const raw = JSON.stringify({
      tools: [{ name: 'Grep', description: 'match [a-z] and ] and [', input_schema: { pattern: '[' } }],
      messages: [],
    })
    assert.deepStrictEqual(extractToolNames(raw), ['Grep'])
  })

  test('returns [] when there is no tools array', () => {
    assert.deepStrictEqual(extractToolNames('{"model":"x"}'), [])
  })
})
