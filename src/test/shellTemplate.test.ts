// src/test/shellTemplate.test.ts — the single-scan property of the shell substitution
// (TRDD-VHH7FXGC, review F1): data carrying a token must never be substituted into.
import * as assert from 'assert'
import { substituteTokens } from '../shellTemplate'

suite('shellTemplate.substituteTokens', () => {
  test('a value containing another token is emitted verbatim, never rescanned', () => {
    const out = substituteTokens('a=@@A@@;b=@@B@@', { '@@A@@': '"@@B@@"', '@@B@@': 'INJECTED' })
    assert.strictEqual(out, 'a="@@B@@";b=INJECTED')
  })

  test('dollar patterns in a value are literal (a string replacement would expand $&)', () => {
    assert.strictEqual(substituteTokens('x=@@V@@', { '@@V@@': '$& $1 $$' }), 'x=$& $1 $$')
  })

  test('an unknown token and a prototype key are left alone', () => {
    assert.strictEqual(substituteTokens('@@NOPE@@ @@CONSTRUCTOR@@', {}), '@@NOPE@@ @@CONSTRUCTOR@@')
  })

  test('every occurrence of a token is filled', () => {
    assert.strictEqual(substituteTokens('@@P@@/a @@P@@/b', { '@@P@@': '/lens' }), '/lens/a /lens/b')
  })
})
