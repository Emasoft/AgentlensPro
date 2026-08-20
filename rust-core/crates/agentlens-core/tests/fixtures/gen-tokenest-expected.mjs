// Regenerates tokenest-expected.json from the COMPILED TS tokenEstimator.js (the parity oracle
// for token_estimator.rs). Pure functions, no fixtures on disk. The cases target the exact
// places a port drifts: UTF-16 code-unit walking (astral chars are TWO units, both classified
// Other), the per-category run formulas and their max(1,…) floors, newline handling, and
// calibrate's refuse-band + residual folding.
// Run from the repo root AFTER `pnpm run compile-tests`:
//   node rust-core/crates/agentlens-core/tests/fixtures/gen-tokenest-expected.mjs
import { createRequire } from 'module'
import { writeFileSync } from 'fs'
import { join } from 'path'
const require = createRequire(import.meta.url)
const { countTokens, calibrateTokens, estimateTokensFromBytes } = require('../../../../../out/test/tokenEstimator.js')
const dir = new URL('.', import.meta.url).pathname

const countCases = [
  '',
  'hello world',
  'a',                                   // Letter run of 1 → max(1, round(1/4.7)) = 1
  'abcd',                                // round(4/4.7) = 1
  'abcdefgh',                            // round(8/4.7) = 2
  '1234567890',                          // ceil(10/3) = 4
  '7',                                   // max(1, ceil(1/3)) = 1
  '=>();===',                            // symbol run merging
  '    indented',                        // floor(4/4) = 1 space token + letters
  '  short',                             // floor(2/4) = 0 — a short space run is FREE
  'line1\nline2\r\nline3',               // every newline ≈ 1 token, and breaks runs
  '\n\n\n',
  '日本語のテキストです',                    // CJK ≈ 1 token/glyph
  '안녕하세요',                             // hangul syllables
  'Ωμέγα Кириллица',                     // Greek + Cyrillic count as Letters
  'café naïve',                          // Latin-1 supplement
  '🎉🎉',                                 // ASTRAL: 2 units each, all Other → ceil(4/2) = 2
  'a🎉b',                                 // surrogate halves split the letter runs
  'const x = {a: 1, b: [2, 3]};\n  return x;\n',
  'mixed123abc!!!   \n\ttabbed',
]
const calibrateCases = [
  { raw: [], exact: 100, opts: {} },
  { raw: [10, 20, 30], exact: undefined, opts: {} },
  { raw: [10, 20, 30], exact: 0, opts: {} },
  { raw: [0, 0], exact: 100, opts: {} },                          // sum 0 → refuse
  { raw: [10, 20, 30], exact: 120, opts: {} },                    // scale 2 → calibrated
  { raw: [10, 20, 30], exact: 61, opts: {} },                     // residual folds into largest
  { raw: [33, 33, 34], exact: 101, opts: {} },                    // first-max wins the fold
  { raw: [10, 20, 30], exact: 6, opts: { minScale: 0.2, maxScale: 5 } },    // scale 0.1 < min → refuse
  { raw: [10, 20, 30], exact: 600, opts: { minScale: 0.2, maxScale: 5 } },  // scale 10 > max → refuse
  { raw: [10, 20, 30], exact: 300, opts: { minScale: 0.2, maxScale: 5 } },  // scale 5 == max → allowed
  { raw: [10, 20, 30], exact: 12, opts: { minScale: 0.2, maxScale: 5 } },   // scale 0.2 == min → allowed
  { raw: [1, 1, 1], exact: 1, opts: { minScale: 0.2, maxScale: 5 } },       // heavy rounding + fold
]
const J = (v) => JSON.parse(JSON.stringify(v))
writeFileSync(join(dir, 'tokenest-expected.json'), JSON.stringify({
  countCases: J(countCases),
  counts: countCases.map(countTokens),
  calibrateCases: J(calibrateCases),
  calibrations: calibrateCases.map(c => J(calibrateTokens(c.raw, c.exact, c.opts))),
  bytes: [0, -5, 1, 3, 4, 5, 4096].map(estimateTokensFromBytes),
}, null, 1))
console.log(`tokenest-expected.json: ${countCases.length} count + ${calibrateCases.length} calibrate cases`)
