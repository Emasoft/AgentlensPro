import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'

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
