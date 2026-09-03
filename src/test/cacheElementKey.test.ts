import * as assert from 'assert'
import { elementKey, isKeyExcludedText } from '../shared/cacheClassification'

// These pin the identity rule that VALIDATION FALSIFIED the first time round: comparing raw element
// bytes agreed with billed usage on 0 of 300 real turns. The cases below are the two mutations a
// moving cache_control marker performs, taken from the measured worked example.
suite('elementKey — identity that matches what Anthropic bills', () => {
  // (a) the key toggle: the marker is added to / removed from an existing block.
  test('a message is identical with and without its cache_control marker', () => {
    const withMarker = JSON.stringify({
      role: 'user',
      content: [{ type: 'tool_result', content: 'ok', is_error: false, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    })
    const without = JSON.stringify({
      role: 'user',
      content: [{ type: 'tool_result', content: 'ok', is_error: false }],
    })
    assert.strictEqual(elementKey(withMarker), elementKey(without))
  })

  // (b) the reshape: a bare string content has nowhere to hang a marker, so it gets wrapped. A
  // textual strip does NOT fix this and still failed 176 of 300 turns.
  test('a string content and its wrapped block form are the same element', () => {
    const stringForm = JSON.stringify({ role: 'user', content: '[janitor-heartbeat] fire' })
    const blockForm = JSON.stringify({
      role: 'user',
      content: [{ type: 'text', text: '[janitor-heartbeat] fire', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    })
    assert.strictEqual(elementKey(stringForm), elementKey(blockForm))
  })

  test('markers are stripped at any depth, not just the top level', () => {
    const deep = JSON.stringify({ a: [{ b: { c: [{ text: 'x', cache_control: { type: 'ephemeral' } }] } }] })
    const flat = JSON.stringify({ a: [{ b: { c: [{ text: 'x' }] } }] })
    assert.strictEqual(elementKey(deep), elementKey(flat))
  })

  // The normalization must not make genuinely different content look equal.
  test('a real content change is still a difference', () => {
    const a = JSON.stringify({ role: 'user', content: 'hello' })
    const b = JSON.stringify({ role: 'user', content: 'goodbye' })
    assert.notStrictEqual(elementKey(a), elementKey(b))
  })

  test('a changed role or block type is still a difference', () => {
    assert.notStrictEqual(
      elementKey(JSON.stringify({ role: 'user', content: 'x' })),
      elementKey(JSON.stringify({ role: 'assistant', content: 'x' })),
    )
    assert.notStrictEqual(
      elementKey(JSON.stringify({ content: [{ type: 'text', text: 'x' }] })),
      elementKey(JSON.stringify({ content: [{ type: 'tool_result', text: 'x' }] })),
    )
  })

  test('unparseable input degrades to byte identity instead of throwing', () => {
    assert.strictEqual(elementKey('not json {'), 'not json {')
    assert.notStrictEqual(elementKey('not json {'), elementKey('other junk'))
  })

  // The stored element is the whole JSON block, so a prefix test on it silently never matched.
  test('the billing header is recognised in its stored block form', () => {
    const stored = JSON.stringify({ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.259; cc_prev_req=req_x' })
    assert.ok(isKeyExcludedText(stored), 'must match the stored block, not just a bare string')
    assert.ok(isKeyExcludedText('x-anthropic-billing-header: cc_entrypoint=cli'))
    assert.ok(!isKeyExcludedText(JSON.stringify({ type: 'text', text: 'You are Claude Code' })))
  })
})
