import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { checkCompositionLine, compareHookConfig, memoryCheckFromLog, COMPOSITION_STALE_MS } from '../cli/setup'

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
suite('setup hook-config + memory-log self-checks', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'al-selfcheck-'))
  const write = (dir: string, text: string): string => { const p = path.join(dir, 'server.log'); fs.writeFileSync(p, text); return p }

  // missing hook-config.json is an explicit SKIP, not a pass
  test('hook-config: absent file is SKIP', () => {
    assert.strictEqual(compareHookConfig({ gateEnabled: true }, null).verify, 'SKIP')
  })
  // served config equal to the file
  test('hook-config: matching file is PASS', () => {
    assert.strictEqual(compareHookConfig({ gateEnabled: true, advisorEnabled: false }, { gateEnabled: true, advisorEnabled: false }).verify, 'PASS')
  })
  // served config differing from the file
  test('hook-config: a differing boolean is FAIL', () => {
    assert.strictEqual(compareHookConfig({ gateEnabled: true }, { gateEnabled: false }).verify, 'FAIL')
  })
  // a fresh, healthy line passes
  test('memory log: fresh healthy line is PASS', () => {
    const d = tmp()
    try { assert.strictEqual(memoryCheckFromLog(write(d, line(690, '600', '90') + '\n')).verify, 'PASS') } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
  // an unparseable composition line is a broken instrument: never PASS
  test('memory log: unparseable line is SKIP, not PASS', () => {
    const d = tmp()
    try {
      const r = memoryCheckFromLog(write(d, 'alcore: composition: garbage mi live x\n'))
      assert.strictEqual(r.verify, 'SKIP')
      assert.ok(r.detail.includes('unparseable'))
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
  // a log not written within 2.5 composition ticks has no fresh line
  test('memory log: stale server.log is SKIP', () => {
    const d = tmp()
    try {
      const p = write(d, line(690, '600', '90') + '\n')
      const old = new Date(Date.now() - COMPOSITION_STALE_MS - 60_000)
      fs.utimesSync(p, old, old)
      const r = memoryCheckFromLog(p)
      assert.strictEqual(r.verify, 'SKIP')
      assert.ok(r.detail.includes('no fresh composition line'))
    } finally { fs.rmSync(d, { recursive: true, force: true }) }
  })
  // an absent log is SKIP
  test('memory log: absent file is SKIP', () => {
    assert.strictEqual(memoryCheckFromLog(path.join(os.tmpdir(), 'al-no-such-dir', 'server.log')).verify, 'SKIP')
  })
})
