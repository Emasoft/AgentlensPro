import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

// Proof that THIS mocha run is under the 4 GB test-data cap (scripts/test-data-cap.sh): src/test/setup.js
// self-wraps a bare mocha, so the cap dir must be set and os.tmpdir() must live inside it, however
// the run was launched. Does not prove the cap TRIPS above 4 GB — only that the run is covered.
suite('test-data cap coverage', () => {
  test('mocha runs inside a capped run dir and os.tmpdir() is redirected into it', () => {
    const capDir = process.env.AGENTLENS_TEST_CAP_DIR
    assert.ok(capDir, 'AGENTLENS_TEST_CAP_DIR is not set: this run is not under the cap')
    assert.ok(capDir.includes('/tests_dev/tmp/run-'), 'cap dir is not a tests_dev/tmp/run-* dir: ' + capDir)
    const real = fs.realpathSync(capDir)
    const tmp = fs.realpathSync(os.tmpdir())
    assert.ok(tmp === real || tmp.startsWith(real + '/'), 'os.tmpdir() ' + tmp + ' escapes the cap dir ' + real)
  })
})

suite('test-data cap trip', () => {
  // WHY: the other tests in this file prove coverage only; this proves the trip mechanism itself, with only CAP_KB lowered in a copy, so no test writes 4 GB (owner order 2026-11-16, 4 GB cap).
  test('the cap trips: a copy with only CAP_KB lowered stops a writer with exit 3, kills its background child and removes the run dir', async function (this: Mocha.Context) {
    this.timeout(90000)
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'test-data-cap.sh')
    const original = fs.readFileSync(scriptPath, 'utf8')
    const copyText = original.replace(/^CAP_KB=4194304 /m, 'CAP_KB=10240 ')
    const originalLines = original.split('\n')
    const copyLines = copyText.split('\n')
    assert.strictEqual(copyLines.length, originalLines.length)
    assert.strictEqual(copyLines.filter((line, i) => line !== originalLines[i]).length, 1, 'the copy must differ from the original in exactly one line (CAP_KB)')
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-trip-')))
    const liveWriters = (): string[] => {
      const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      if (ps.status !== 0) throw new Error('ps exited ' + ps.status + ': ' + ps.stderr)
      return ps.stdout.split('\n').filter((line) => line.includes(`${tmp}/writer.sh`) || line.includes(`${tmp}/tests_dev/tmp/run-`))
    }
    try {
      fs.mkdirSync(path.join(tmp, 'scripts'))
      const copy = path.join(tmp, 'scripts', 'test-data-cap.sh')
      fs.writeFileSync(copy, copyText)
      const writer = path.join(tmp, 'writer.sh')
      fs.writeFileSync(writer, [
        '#!/usr/bin/env bash',
        '(',
        '  i=0',
        '  while true; do dd if=/dev/zero of="$TMPDIR/child-$i" bs=1048576 count=1; i=$((i+1)); sleep 0.3; done',
        ') &',
        'i=0',
        'while true; do dd if=/dev/zero of="$TMPDIR/parent-$i" bs=1048576 count=1; i=$((i+1)); sleep 0.3; done',
        '',
      ].join('\n'))
      const env: NodeJS.ProcessEnv = { ...process.env }
      delete env.AGENTLENS_TEST_CAP_DIR
      const run = spawnSync('bash', [copy, 'bash', writer], { env, encoding: 'utf8', timeout: 60000 })
      assert.strictEqual(run.status, 3, 'exit status ' + run.status + ', signal ' + run.signal)
      assert.match(run.stderr, /exceeds the 4 GB cap — run stopped/)
      assert.strictEqual(fs.readdirSync(path.join(tmp, 'tests_dev', 'tmp')).length, 0, 'the run dir was not removed')
      await new Promise<void>((resolve) => setTimeout(resolve, 1500))
      assert.deepStrictEqual(liveWriters(), [], 'writers still running after the trip')
    } finally {
      // Safety net for a failed assertion: kill any writer still alive; the run dir is removed even if that lookup throws.
      try {
        const orphans = liveWriters().map((line) => line.trim().split(/\s+/)[0])
        if (orphans.length > 0) spawnSync('kill', ['-KILL', ...orphans])
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    }
  })
})
