import * as assert from 'assert'
import { checkCompositionLine } from '../cli/setup'

// Real composition_line + mi_suffix shape (rust-core chores.rs), with the committed field first.
const head = 'alcore: composition: mimalloc commit 690 MB, process rss 700 MB, window.spans 10 (~5 MB sampled est), summary-cache none MB, stripped-cache none MB, card rows 3 (~1 MB text, DuckDB own allocator, limit 256 MiB), derived slack = commit - window est = 685 MB'
const line = (committed: number, live: string, free: string): string =>
  `${head}, mi committed ${committed} MB, mi reset 0 MB, mi purged 0 MB, mi live ${live} MB, mi free-in-page ${free} MB`

suite('setup memory self-check parser', () => {
  // exact live + free-in-page = committed
  test('PASS on an exact line', () => {
    assert.strictEqual(checkCompositionLine(line(690, '600', '90')).verdict, 'PASS')
  })
  // the measured +1 MB rounding residue
  test('PASS on the +1 MB residue', () => {
    assert.strictEqual(checkCompositionLine(line(690, '600', '91')).verdict, 'PASS')
  })
  // drift > 1 MB is INFO (never FAIL) and names the line
  test('INFO on drift larger than 1 MB', () => {
    const r = checkCompositionLine(line(690, '600', '40'))
    assert.strictEqual(r.verdict, 'INFO')
    assert.ok(r.detail.includes('mi live 600 MB'))
  })
  // unmeasured fields print `?`
  test('SKIP when live/free-in-page are ?', () => {
    assert.strictEqual(checkCompositionLine(line(690, '?', '?')).verdict, 'SKIP')
  })
  // no line yet
  test('SKIP when there is no line', () => {
    assert.strictEqual(checkCompositionLine(null).verdict, 'SKIP')
  })
  // free-in-page > 50% of committed is expected until Phase D
  test('INFO when free-in-page exceeds half of committed', () => {
    const r = checkCompositionLine(line(100, '40', '60'))
    assert.strictEqual(r.verdict, 'INFO')
    assert.ok(r.detail.includes('Phase D'))
  })
  // garbage never throws
  test('WARN on garbage', () => {
    assert.strictEqual(checkCompositionLine('not a composition line').verdict, 'WARN')
  })
})