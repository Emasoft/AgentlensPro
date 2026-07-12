import * as assert from 'assert'
import { permissionSummary } from '../environment/claude'

suite('permissionSummary (TRDD-HUWJVQJA — Claude Code permissions facet)', () => {
  test('full permissions object with strings extracts defaultMode and array lengths', () => {
    const result = permissionSummary({
      permissions: { defaultMode: 'acceptEdits', allow: ['a', 'b'], deny: ['x'], ask: [] },
    })
    assert.deepStrictEqual(result, { defaultMode: 'acceptEdits', allow: 2, deny: 1, ask: 0 })
  })

  test('empty object returns all zeros and null mode', () => {
    const result = permissionSummary({})
    assert.deepStrictEqual(result, { defaultMode: null, allow: 0, deny: 0, ask: 0 })
  })

  test('null settings returns all zeros and null mode, never throws', () => {
    assert.doesNotThrow(() => permissionSummary(null))
    const result = permissionSummary(null)
    assert.deepStrictEqual(result, { defaultMode: null, allow: 0, deny: 0, ask: 0 })
  })

  test('non-array allow value is guarded to zero rather than crashing', () => {
    const result = permissionSummary({ permissions: { allow: 'notarray' } })
    assert.deepStrictEqual(result, { defaultMode: null, allow: 0, deny: 0, ask: 0 })
  })

  test('permissions field present but not an object degrades to zeros', () => {
    const result = permissionSummary({ permissions: 'oops' })
    assert.deepStrictEqual(result, { defaultMode: null, allow: 0, deny: 0, ask: 0 })
  })

  test('non-object settings value (a number) degrades to zeros, never throws', () => {
    assert.doesNotThrow(() => permissionSummary(42))
    const result = permissionSummary(42)
    assert.deepStrictEqual(result, { defaultMode: null, allow: 0, deny: 0, ask: 0 })
  })
})
