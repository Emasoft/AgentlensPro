import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'

// The deploy tool GATES a machine-wide-live bundle (the npm-linked CLI powers every agent's hooks +
// burn-gate), so it must itself be correct. These REAL tests shell out to scripts/safe-deploy.sh with
// every gate/build/restart command STUBBED via env — so the safety logic (abort-before-build; build
// only on all-green; never restart on a bad build) is exercised in milliseconds without the real
// ~1-minute suite. The build/restart stubs `touch` a marker; its presence/absence proves whether that
// step was reached. NO mocks of the logic under test — only the slow external commands are stubbed.

// out/test/test/safeDeploy.test.js → up 3 = repo root.
const REPO = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'safe-deploy.sh')

// All gates + smoke pass; build/restart are stubbed by each test to a marker touch.
const GREEN = {
  GATE_CHECKTYPES: 'true', GATE_LINT: 'true', GATE_MIRRORS: 'true',
  GATE_COMPILE_TESTS: 'true', GATE_MOCHA: 'true', SMOKE_CMD: 'true', RESTART_CMD: 'true',
}

function run(args: string[], env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

suite('safe-deploy.sh — gate-then-build safety (TRDD-YQZ9P8IL ops guard)', () => {
  let dir: string, built: string, restarted: string
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-deploy-${process.pid}-`))
    built = path.join(dir, 'built')
    restarted = path.join(dir, 'restarted')
  })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('the script exists and is executable', () => {
    assert.ok(fs.existsSync(SCRIPT))
    assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, 'has an exec bit')
  })

  test('all gates green → build runs, exit 0, reports GREEN + DEPLOYED', () => {
    const r = run([], { ...GREEN, BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(fs.existsSync(built), 'build step ran on green')
    assert.ok(/GREEN/.test(r.out) && /DEPLOYED/.test(r.out), r.out)
  })

  test('a RED gate ABORTS before building — the live bundle is untouched', () => {
    const r = run([], { ...GREEN, GATE_LINT: 'false', BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 1)
    assert.ok(!fs.existsSync(built), 'build MUST NOT run when a gate is red')
    assert.ok(/RED/.test(r.out) && /UNTOUCHED/.test(r.out), r.out)
  })

  test('a red gate at the LAST stage (tests) still aborts before building', () => {
    const r = run([], { ...GREEN, GATE_MOCHA: 'false', BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 1)
    assert.ok(!fs.existsSync(built), 'a failing test suite must block the build')
  })

  test('--dry-run runs the gates but never builds', () => {
    const r = run(['--dry-run'], { ...GREEN, BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 0)
    assert.ok(!fs.existsSync(built), 'dry-run must not build')
    assert.ok(/dry-run/i.test(r.out))
  })

  test('--no-restart builds on green but does NOT restart', () => {
    const r = run(['--no-restart'], { ...GREEN, BUILD_CMD: `touch ${built}`, RESTART_CMD: `touch ${restarted}` })
    assert.strictEqual(r.code, 0)
    assert.ok(fs.existsSync(built), 'build ran')
    assert.ok(!fs.existsSync(restarted), 'restart must NOT run with --no-restart')
  })

  test('a smoke failure after build does NOT restart the server', () => {
    const r = run([], { ...GREEN, BUILD_CMD: `touch ${built}`, SMOKE_CMD: 'false', RESTART_CMD: `touch ${restarted}` })
    assert.strictEqual(r.code, 1)
    assert.ok(fs.existsSync(built), 'build ran')
    assert.ok(!fs.existsSync(restarted), 'a bad smoke must block the restart')
  })

  test('--help exits 0 and does not run any gate', () => {
    const r = run(['--help'], { GATE_CHECKTYPES: 'false' })  // even a red gate stub must be ignored
    assert.strictEqual(r.code, 0)
    assert.ok(/gate-then-build/.test(r.out))
  })

  test('an unknown argument exits 2', () => {
    const r = run(['--bogus'], {})
    assert.strictEqual(r.code, 2)
  })
})
