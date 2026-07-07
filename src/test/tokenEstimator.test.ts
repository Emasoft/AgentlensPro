import * as assert from 'assert'
import { countTokens, estimateTokensFromBytes, calibrateTokens } from '../tokenEstimator'

// ── tokenEstimator (TRDD-IQENK7JM) — pure-module tests ────────────────────────
// The segmenter can never be byte-exact vs Claude's real BPE, so we assert (a) it lands in a SANE
// range for known fixtures, (b) it tracks real tokenization BETTER than bytes/4 in the expected
// direction (code/JSON have more tokens/byte than prose), and (c) the calibration math is exact.

const bytes4 = (s: string): number => estimateTokensFromBytes(Buffer.byteLength(s, 'utf8'))

suite('tokenEstimator — countTokens ranges', () => {
  test('empty / whitespace-only strings', () => {
    assert.strictEqual(countTokens(''), 0)
    assert.strictEqual(countTokens(' '), 0)        // a lone space merges into a neighbour token → free
    assert.ok(countTokens('\n\n\n') >= 3)          // each newline is ~1 token
  })

  test('English prose lands near the real ~4 chars/token (within ±25%)', () => {
    // "The quick brown fox jumps over the lazy dog." — real tokenizers ≈ 10-11 tokens.
    const prose = 'The quick brown fox jumps over the lazy dog.'
    const t = countTokens(prose)
    assert.ok(t >= 8 && t <= 14, `prose tokens ${t} out of 8..14`)
  })

  test('a short common word is ~1 token, a long word splits', () => {
    assert.strictEqual(countTokens('the'), 1)
    assert.ok(countTokens('tokenization') >= 2, 'a 12-letter word is more than one token')
  })

  test('code has MORE tokens/byte than bytes/4 (operators + underscores + newlines count)', () => {
    const code = 'const get_page_title = (a, b) => { return a === b ? 1 : 0; }\n'
    const t = countTokens(code)
    // Real BPE on this is ~24-28 tokens; the point is it must clearly exceed bytes/4 (~15).
    assert.ok(t > bytes4(code), `code tokens ${t} should exceed bytes/4 ${bytes4(code)}`)
    assert.ok(t >= 18 && t <= 40, `code tokens ${t} out of 18..40`)
  })

  test('JSON symbols push tokens above bytes/4', () => {
    const json = '{"name":"agentlens","count":42,"nested":{"a":[1,2,3]}}'
    const t = countTokens(json)
    assert.ok(t > bytes4(json), `json tokens ${t} should exceed bytes/4 ${bytes4(json)}`)
  })

  test('mixed prose + inline code is between the two regimes and > 0', () => {
    const mixed = 'Call `countTokens(text)` to estimate the size of a block before shipping it.'
    const t = countTokens(mixed)
    assert.ok(t > 0)
    assert.ok(t >= 12 && t <= 30, `mixed tokens ${t} out of 12..30`)
  })

  test('CJK glyphs count ~1 token each (far above bytes/4, which under-counts 3-byte chars)', () => {
    const cjk = '日本語のテキスト'   // 8 CJK glyphs
    const t = countTokens(cjk)
    assert.ok(t >= 7 && t <= 12, `cjk tokens ${t} out of 7..12`)
  })

  test('indentation and newlines are counted (multi-line code)', () => {
    const indented = 'function f() {\n    return 1\n}\n'
    assert.ok(countTokens(indented) >= 3, 'newlines + indent contribute tokens')
  })

  test('deterministic — same input yields same count', () => {
    const s = 'repeatable input string with numbers 123 and symbols !@#'
    assert.strictEqual(countTokens(s), countTokens(s))
  })
})

suite('tokenEstimator — estimateTokensFromBytes (byte-only, bytes/4 preserved)', () => {
  test('ceil(bytes/4), 0 for non-positive', () => {
    assert.strictEqual(estimateTokensFromBytes(0), 0)
    assert.strictEqual(estimateTokensFromBytes(4), 1)
    assert.strictEqual(estimateTokensFromBytes(5), 2)
    assert.strictEqual(estimateTokensFromBytes(-10), 0)
  })
})

suite('tokenEstimator — calibrateTokens', () => {
  test('scaled blocks sum EXACTLY to the exact total', () => {
    const raw = [100, 200, 300, 33]
    const { tokens, source } = calibrateTokens(raw, 1000)
    assert.strictEqual(source, 'calibrated')
    assert.strictEqual(tokens.reduce((a, b) => a + b, 0), 1000)
  })

  test('proportions are preserved (largest stays largest, ordering intact)', () => {
    const raw = [10, 40, 25, 5]
    const { tokens } = calibrateTokens(raw, 800)
    assert.strictEqual(tokens.length, raw.length)
    // rank order preserved: 40 > 25 > 10 > 5
    assert.ok(tokens[1] > tokens[2] && tokens[2] > tokens[0] && tokens[0] > tokens[3])
  })

  test('single block scales exactly to the total', () => {
    const { tokens, source } = calibrateTokens([7], 250)
    assert.deepStrictEqual(tokens, [250])
    assert.strictEqual(source, 'calibrated')
  })

  test('zero-block group → empty, estimated', () => {
    const { tokens, source } = calibrateTokens([], 500)
    assert.deepStrictEqual(tokens, [])
    assert.strictEqual(source, 'estimated')
  })

  test('zero / undefined exact total → passthrough, estimated', () => {
    assert.deepStrictEqual(calibrateTokens([3, 4], 0), { tokens: [3, 4], source: 'estimated' })
    assert.deepStrictEqual(calibrateTokens([3, 4], undefined), { tokens: [3, 4], source: 'estimated' })
  })

  test('all-zero raw estimates → passthrough, estimated (no divide-by-zero)', () => {
    const { tokens, source } = calibrateTokens([0, 0], 100)
    assert.deepStrictEqual(tokens, [0, 0])
    assert.strictEqual(source, 'estimated')
  })

  test('out-of-band scale is REFUSED → raw estimate kept, labeled estimated', () => {
    // raw sums to 100; target 1000 ⇒ scale 10× ⇒ blocks are structurally incomplete vs the total
    // (e.g. a turn-1 input group missing the system prompt) — must NOT be inflated.
    const raw = [60, 40]
    const { tokens, source } = calibrateTokens(raw, 1000, { minScale: 0.5, maxScale: 2 })
    assert.deepStrictEqual(tokens, raw)
    assert.strictEqual(source, 'estimated')
  })

  test('in-band scale (estimator drift) IS calibrated and sums exactly', () => {
    const raw = [90, 110]           // sum 200; target 220 ⇒ scale 1.1× (drift, in [0.5,2])
    const { tokens, source } = calibrateTokens(raw, 220, { minScale: 0.5, maxScale: 2 })
    assert.strictEqual(source, 'calibrated')
    assert.strictEqual(tokens.reduce((a, b) => a + b, 0), 220)
  })

  test('output-style calibration (no band) scales any factor to exact total', () => {
    const raw = [50]
    const { tokens, source } = calibrateTokens(raw, 5000)   // 100× — allowed when no band given
    assert.deepStrictEqual(tokens, [5000])
    assert.strictEqual(source, 'calibrated')
  })
})
