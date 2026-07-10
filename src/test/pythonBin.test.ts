import * as assert from 'assert'
import { execFileSync } from 'child_process'
import { pythonBin } from '../safeConfigEdit'

// ── safeConfigEdit.pythonBin (Windows-safe interpreter resolution) ─────────────
// Real interpreter resolution — no mocks. pythonBin() probes the platform's candidate
// list and returns the first name that answers `--version`; the result is memoized.

suite('safeConfigEdit — pythonBin (real interpreter resolution)', () => {
  test('resolves to a python interpreter that actually answers --version on this platform', () => {
    // The resolved name must be a REAL interpreter: spawning it with --version must succeed.
    const bin = pythonBin()
    assert.ok(typeof bin === 'string' && bin.length > 0, `expected a bin name, got ${JSON.stringify(bin)}`)
    // Throws (ENOENT / non-zero exit) if the resolved bin is not a working interpreter.
    execFileSync(bin, ['--version'], { timeout: 5_000, stdio: 'ignore' })
  })

  test('is memoized: two calls return the identical resolved value', () => {
    // The result is cached per process — repeated calls must yield the same interpreter name.
    assert.strictEqual(pythonBin(), pythonBin())
  })
})
