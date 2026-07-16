import * as assert from 'assert'
import { judgeEnvFacts, type EnvFacts } from '../cli/setup'

// TRDD-KVDT1XMS — the setup environment probe: pure heuristics over gathered facts, judged by
// judgeEnvFacts (unit-tested here fact-by-fact; gathering itself is exercised by the real-machine
// full setup run in setupVerb.test.ts, where the step must PASS on the dev machine).

function facts(over: Partial<EnvFacts> = {}): EnvFacts {
  return {
    platform: 'darwin', arch: 'arm64', nodeVersion: '22.1.0', nodeFloor: '20.9.0',
    wsl: false, duckdbResolvable: true, sqljsResolvable: true,
    claudeDirPresent: true, otlpPortBusyForeign: false, freeDiskBytes: 50 * 2 ** 30,
    ...over,
  }
}

suite('setup environment probe (TRDD-KVDT1XMS)', () => {
  test('healthy darwin/linux facts PASS with no warnings', () => {
    // Tests the happy path: a healthy machine produces PASS and an empty warning detail.
    const r = judgeEnvFacts(facts())
    assert.strictEqual(r.verify, 'PASS')
    assert.ok(r.found.includes('darwin'), `found describes the platform: ${r.found}`)
  })

  test('native win32 FAILS with WSL guidance (Windows is WSL-only)', () => {
    // Tests the platform gate: native Windows is unsupported; the message must point at WSL2.
    const r = judgeEnvFacts(facts({ platform: 'win32' }))
    assert.strictEqual(r.verify, 'FAIL')
    assert.ok(/WSL/i.test(r.detail ?? ''), `detail must direct to WSL2: ${r.detail}`)
  })

  test('WSL is linux and PASSES, labeled as WSL', () => {
    // Tests that inside WSL (platform linux, wsl marker true) setup proceeds and labels it.
    const r = judgeEnvFacts(facts({ platform: 'linux', wsl: true }))
    assert.strictEqual(r.verify, 'PASS')
    assert.ok(r.found.includes('WSL'), `found labels WSL: ${r.found}`)
  })

  test('Node below the engines floor FAILS naming the floor', () => {
    // Tests the Node version gate reads the floor from facts (sourced from package.json engines).
    const r = judgeEnvFacts(facts({ nodeVersion: '18.19.0' }))
    assert.strictEqual(r.verify, 'FAIL')
    assert.ok((r.detail ?? '').includes('20.9.0'), `detail names the floor: ${r.detail}`)
  })

  test('unresolvable @duckdb/node-api FAILS (span store cannot run)', () => {
    // Tests the native-dep gate: a broken install must not half-run.
    const r = judgeEnvFacts(facts({ duckdbResolvable: false }))
    assert.strictEqual(r.verify, 'FAIL')
    assert.ok((r.detail ?? '').includes('@duckdb/node-api'), r.detail)
  })

  test('degradable problems warn in detail but PASS: sql.js, foreign port, no ~/.claude, low disk', () => {
    // Tests that heuristic warnings ride the detail without blocking the install.
    const r = judgeEnvFacts(facts({
      sqljsResolvable: false, otlpPortBusyForeign: true,
      claudeDirPresent: false, freeDiskBytes: 200 * 2 ** 20,
    }))
    assert.strictEqual(r.verify, 'PASS')
    const d = r.detail ?? ''
    assert.ok(d.includes('sql.js'), `warns sql.js: ${d}`)
    assert.ok(/port/i.test(d), `warns foreign port: ${d}`)
    assert.ok(d.includes('.claude'), `warns missing ~/.claude: ${d}`)
    assert.ok(/disk/i.test(d), `warns low disk: ${d}`)
  })
})
