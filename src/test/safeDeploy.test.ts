import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, spawnSync } from 'child_process'

// The deploy tool GATES a machine-wide-live bundle (the npm-linked CLI powers every agent's hooks +
// burn-gate), so it must itself be correct. These REAL tests shell out to scripts/safe-deploy.sh with
// every gate/build/restart command STUBBED via env — so the safety logic (abort-before-build; build
// only on all-green; never restart on a bad build) is exercised in milliseconds without the real
// ~1-minute suite. The build/restart stubs `touch` a marker; its presence/absence proves whether that
// step was reached. NO mocks of the logic under test — only the slow external commands are stubbed.
//
// The RUST half (TRDD-KRJNTSQH) is stubbed the same way: RUST_BUILD_CMD, RUST_STAGE_CMD,
// RUST_CODESIGN_CMD and RUST_VERIFY_CMD are env-overridable, so NO test ever invokes a real cargo
// build (slow, and it contends for the cargo lock with whatever else is building in this repo).
// The staged binary is a copy of a real Mach-O (/bin/ls) so the REAL default codesign step can be
// exercised on macOS — that is the claim under test, not a mock of it.

// out/test/test/safeDeploy.test.js → up 3 = repo root.
const REPO = path.resolve(__dirname, '..', '..', '..')
const SCRIPT = path.join(REPO, 'scripts', 'safe-deploy.sh')
const RUST_HELPER = path.join(REPO, 'scripts', 'deploy-rust-helper.js')

// A real Mach-O (or ELF) to stand in for the compiled alcore: the default codesign step needs a
// real signable binary, and a shell script would make codesign fail for the wrong reason.
const BINARY_SOURCE = fs.existsSync('/bin/ls') ? '/bin/ls' : process.execPath

// All gates + smoke pass; build/restart are stubbed by each test to a marker touch.
//
// The rust half is stubbed HERE, in the shared GREEN: the deploy's DEFAULT RUST_BUILD_CMD is a real
// 'cargo build --release', and a test that reached it would run a real cargo build. Every test
// inherits the stub; the rust suite below overrides it per-case where the difference matters.
const GREEN = {
  GATE_CHECKTYPES: 'true', GATE_LINT: 'true', GATE_MIRRORS: 'true',
  GATE_COMPILE_TESTS: 'true', GATE_MOCHA: 'true', SMOKE_CMD: 'true', RESTART_CMD: 'true',
  RUST_PLATFORM_CMD: 'echo test-plat',
  RUST_HASH_CMD: 'echo test-hash',
  RUST_BUILD_CMD: 'true',
  RUST_STAGE_CMD: 'true',
  RUST_CODESIGN_CMD: 'true',
  RUST_VERIFY_CMD: 'true',
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

  // The rust half needs a REAL staged binary: the script refuses to continue when the staged
  // alcore is not executable, and it must not write into the repo's own bin-native/ from a test.
  // The stage stub copies a real binary into the temp dir; the rest of the rust half is stubbed.
  function rustEnv(over: Record<string, string> = {}): Record<string, string> {
    const stageDir = path.join(dir, 'stage')
    return {
      RUST_STAGE_DIR: stageDir,
      RUST_STAMP_FILE: path.join(dir, 'stamp'),
      RUST_STAGE_CMD: `mkdir -p "${stageDir}" && cp ${BINARY_SOURCE} "${stageDir}/alcore" && chmod +x "${stageDir}/alcore"`,
      ...over,
    }
  }

  test('the script exists and is executable', () => {
    assert.ok(fs.existsSync(SCRIPT))
    assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, 'has an exec bit')
  })

  test('all gates green → build runs, exit 0, reports GREEN + DEPLOYED', () => {
    const r = run([], { ...GREEN, ...rustEnv(), BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(fs.existsSync(built), 'build step ran on green')
    assert.ok(/GREEN/.test(r.out) && /DEPLOYED/.test(r.out), r.out)
  })

  test('a RED gate ABORTS before building — the live bundle is untouched', () => {
    const r = run([], { ...GREEN, ...rustEnv(), GATE_LINT: 'false', BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 1)
    assert.ok(!fs.existsSync(built), 'build MUST NOT run when a gate is red')
    assert.ok(/RED/.test(r.out) && /UNTOUCHED/.test(r.out), r.out)
  })

  test('a red gate at the LAST stage (tests) still aborts before building', () => {
    const r = run([], { ...GREEN, ...rustEnv(), GATE_MOCHA: 'false', BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 1)
    assert.ok(!fs.existsSync(built), 'a failing test suite must block the build')
  })

  test('--dry-run runs the gates but never builds', () => {
    const r = run(['--dry-run'], { ...GREEN, ...rustEnv(), BUILD_CMD: `touch ${built}` })
    assert.strictEqual(r.code, 0)
    assert.ok(!fs.existsSync(built), 'dry-run must not build')
    assert.ok(/dry-run/i.test(r.out))
  })

  test('--no-restart builds on green but does NOT restart', () => {
    const r = run(['--no-restart'], { ...GREEN, ...rustEnv(), BUILD_CMD: `touch ${built}`, RESTART_CMD: `touch ${restarted}` })
    assert.strictEqual(r.code, 0)
    assert.ok(fs.existsSync(built), 'build ran')
    assert.ok(!fs.existsSync(restarted), 'restart must NOT run with --no-restart')
  })

  test('a smoke failure after build does NOT restart the server', () => {
    const r = run([], { ...GREEN, ...rustEnv(), BUILD_CMD: `touch ${built}`, SMOKE_CMD: 'false', RESTART_CMD: `touch ${restarted}` })
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

// ── The RUST half (TRDD-KRJNTSQH) ──────────────────────────────────────────────────────────
//
// The deployed `alcore` IS the whole backend (the TypeScript server was retired in 567fc5c2), so a
// deploy that builds only the JS bundle says nothing about what is actually serving. These tests
// pin the rust half: it builds, it stages, it signs, it verifies the RUNNING pid, and — the part
// that was missing — a rust failure is reported as a RUST failure, not as "the bundle is untouched".
suite('safe-deploy.sh — the RUST half (TRDD-KRJNTSQH)', () => {
  let dir: string
  let stageDir: string
  let buildDest: string
  let stampFile: string
  let rustBuilt: string
  let staged: string
  let codesigned: string
  let verified: string
  let restarted: string
  let built: string

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-rust-deploy-${process.pid}-`))
    stageDir = path.join(dir, 'stage')
    buildDest = path.join(dir, 'target-release')
    stampFile = path.join(dir, 'stamp')
    rustBuilt = path.join(dir, 'rust-built')
    staged = path.join(dir, 'staged')
    codesigned = path.join(dir, 'codesigned')
    verified = path.join(dir, 'verified')
    restarted = path.join(dir, 'restarted')
    built = path.join(dir, 'built')
    fs.mkdirSync(stageDir, { recursive: true })
    fs.mkdirSync(buildDest, { recursive: true })
  })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** The env for a green run with the rust half stubbed. The stage stub copies a REAL binary into
   *  the temp stage dir (the script refuses a non-executable staged alcore) and touches a marker
   *  that proves the stage step ran. */
  function env(over: Record<string, string> = {}): Record<string, string> {
    return {
      ...GREEN,
      BUILD_CMD: `touch ${built}`,
      RUST_BUILD_CMD: `touch ${rustBuilt}`,
      RUST_STAGE_CMD: `mkdir -p "${stageDir}" && cp ${BINARY_SOURCE} "${stageDir}/alcore" && chmod +x "${stageDir}/alcore" && touch ${staged}`,
      RUST_CODESIGN_CMD: `touch ${codesigned}`,
      RUST_VERIFY_CMD: `touch ${verified}`,
      RUST_STAGE_DIR: stageDir,
      RUST_STAMP_FILE: stampFile,
      RUST_BUILD_DEST: buildDest,
      ...over,
    }
  }

  test('the rust helper exists and reports the product\'s own platform-arch spelling', () => {
    assert.ok(fs.existsSync(RUST_HELPER), 'scripts/deploy-rust-helper.js exists')
    const out = execFileSync('node', [RUST_HELPER, 'platform-arch'], { encoding: 'utf8' }).trim()
    assert.strictEqual(out, `${process.platform}-${process.arch}`,
      'the key must be the one src/rustBinResolve.ts npmPlatformBin resolves, not a second spelling')
  })

  test('a green run builds the rust workspace, stages it, signs it, and verifies the running pid', () => {
    const r = run([], env())
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(fs.existsSync(rustBuilt), 'the rust build ran')
    assert.ok(fs.existsSync(staged), 'the rust staging ran')
    assert.ok(fs.existsSync(codesigned), 'the codesign ran')
    assert.ok(fs.existsSync(verified), 'the running-process verification ran')
    assert.ok(/DEPLOYED/.test(r.out), r.out)
  })

  test('the rust build is SKIPPED when the workspace is unchanged — and the skip is STATED', () => {
    // Run 1 stages and writes the stamp. Run 2 sees the same hash and the same staged binary,
    // so it must skip — and must SAY that it skipped, because a silent skip is indistinguishable
    // from a shipped rebuild.
    const first = run([], env())
    assert.strictEqual(first.code, 0, first.out)
    assert.ok(fs.existsSync(stampFile), 'the stamp was written')

    const secondBuild = path.join(dir, 'rust-built-run2')
    const second = run([], env({ RUST_BUILD_CMD: `touch ${secondBuild}`, RUST_HASH_CMD: 'echo test-hash' }))
    assert.strictEqual(second.code, 0, second.out)
    assert.ok(/SKIP/i.test(second.out), `the skip must be stated in the output: ${second.out}`)
    assert.ok(!fs.existsSync(secondBuild), 'the rust build must NOT run when the workspace is unchanged')
  })

  test('a CHANGED rust workspace forces the build even when a stamp exists', () => {
    const first = run([], env())
    assert.strictEqual(first.code, 0, first.out)
    // A different source hash ⇒ the workspace changed ⇒ the build must run again.
    const secondBuild = path.join(dir, 'rust-built-run2')
    const second = run([], env({ RUST_HASH_CMD: 'echo a-different-hash', RUST_BUILD_CMD: `touch ${secondBuild}` }))
    assert.strictEqual(second.code, 0, second.out)
    assert.ok(fs.existsSync(secondBuild), 'a changed workspace must trigger the rust build')
  })

  test('a rust build failure leaves the JS bundle alone and reports the RUST half as suspect', () => {
    const r = run([], env({ RUST_BUILD_CMD: 'false', RESTART_CMD: `touch ${restarted}` }))
    assert.strictEqual(r.code, 1, r.out)
    assert.ok(fs.existsSync(built), 'the JS bundle WAS built (the rust half runs after it)')
    assert.ok(!fs.existsSync(restarted), 'a rust failure must NOT restart the server')
    assert.ok(/RUST/i.test(r.out) && /SUSPECT/i.test(r.out),
      `the failure must say the RUST half is suspect: ${r.out}`)
    assert.ok(!/The live bundle is UNTOUCHED/.test(r.out),
      `the generic "the live bundle is UNTOUCHED" is a WRONG answer here — the JS bundle is fresh ` +
      `and only the backend is stale: ${r.out}`)
  })

  test('a rust STAGING failure is reported as a rust failure, not a generic one', () => {
    const r = run([], env({ RUST_STAGE_CMD: 'false' }))
    assert.strictEqual(r.code, 1, r.out)
    assert.ok(/RUST/i.test(r.out) && /SUSPECT/i.test(r.out), r.out)
    assert.ok(!/The live bundle is UNTOUCHED/.test(r.out), r.out)
  })

  test('--dry-run reports BOTH halves — the JS bundle AND the rust binary', () => {
    const r = run(['--dry-run'], env())
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(!fs.existsSync(rustBuilt), 'dry-run must not build the rust workspace')
    assert.ok(!fs.existsSync(staged), 'dry-run must not stage')
    assert.ok(/JS bundle/i.test(r.out), `the JS half must be reported: ${r.out}`)
    assert.ok(/RUST/i.test(r.out), `the rust half must be reported: ${r.out}`)
    assert.ok(/alcore/.test(r.out), `the rust half must name the binary it ships: ${r.out}`)
  })

  test('the script FAILS when the staged binary is not executable', () => {
    // The stage stub creates a non-executable alcore: present but unspawnable. The product's own
    // resolver (src/rustBinResolve.ts) treats that as a corrupt install, and it must not deploy.
    const notExec = `printf 'x' > "${stageDir}/alcore"`
    const r = run([], env({ RUST_STAGE_CMD: notExec }))
    assert.strictEqual(r.code, 1, r.out)
    assert.ok(/NOT EXECUTABLE/i.test(r.out), r.out)
    assert.ok(!fs.existsSync(verified), 'a non-executable binary must not reach the restart/verify')
  })

  test('the script FAILS when the binary is not executable AFTER codesigning', () => {
    // Signing rewrites the file; a signing step that dropped the x-bit would leave an unspawnable
    // binary behind a green codesign. The check runs again after the sign.
    const r = run([], env({ RUST_CODESIGN_CMD: `chmod -x "${stageDir}/alcore"` }))
    assert.strictEqual(r.code, 1, r.out)
    assert.ok(/NOT EXECUTABLE/i.test(r.out), r.out)
  })

  test('the codesign step runs on macOS and signs the staged binary', function () {
    if (process.platform !== 'darwin') { this.skip(); return }
    // The REAL default stage + codesign: a real Mach-O staged into a temp bin-native dir and
    // signed for real. No stub — the claim under test is that the deploy signs the binary.
    // The "cargo build output" is faked with a real Mach-O named alcore, because the default
    // stage step copies from $RUST_BUILD_DEST — that is the real code path, with a real binary.
    const fakeTarget = path.join(dir, 'fake-target')
    fs.mkdirSync(fakeTarget, { recursive: true })
    fs.copyFileSync(BINARY_SOURCE, path.join(fakeTarget, 'alcore'))
    fs.chmodSync(path.join(fakeTarget, 'alcore'), 0o755)
    const r = run([], env({
      RUST_STAGE_CMD: '__default_rust_stage__',
      RUST_CODESIGN_CMD: '__default_rust_codesign__',
      RUST_BUILD_DEST: fakeTarget,
    }))
    assert.strictEqual(r.code, 0, r.out)
    const stagedAlcore = path.join(stageDir, 'alcore')
    assert.ok(fs.existsSync(stagedAlcore), `the binary was staged: ${r.out}`)
    assert.ok((fs.statSync(stagedAlcore).mode & 0o111) !== 0, 'the staged binary is executable')
    // codesign -dv writes its report to STDERR (stdout stays empty on success).
    // codesign -dv writes its report to STDERR (stdout stays empty), and exits NON-ZERO on an
    // unsigned binary — so the report is read from the error, not from a successful stdout.
    let sig = ''
    try {
      const res = spawnSync('codesign', ['-dv', stagedAlcore], { encoding: 'utf8' })
      sig = `${res.stdout ?? ''}${res.stderr ?? ''}`
    } catch (e) {
      sig = `${(e as { stderr?: string }).stderr ?? ''}`
    }
    assert.ok(/adhoc/i.test(sig), `the staged binary carries an ad-hoc signature: ${sig}`)
  })

  test('--no-restart does NOT claim DEPLOYED — nothing was deployed, only built', () => {
    const r = run(['--no-restart'], env())
    assert.strictEqual(r.code, 0, r.out)
    assert.ok(!fs.existsSync(restarted), 'no restart happened')
    assert.ok(!/DEPLOYED/.test(r.out),
      `without a restart nothing was DEPLOYED, and saying otherwise is the same class of wrong ` +
      `answer the whole script exists to prevent: ${r.out}`)
    assert.ok(/BUILT/.test(r.out), r.out)
  })
  test('a verify-running MISMATCH is a LOUD failure, not a stale server that looks healthy', function () {
    // The verify loop sleeps 1 s between attempts, so a failing verify burns up to
    // RUST_VERIFY_ATTEMPTS seconds. Pin the attempts to 1 and raise the mocha timeout: the
    // point of the test is the FAILURE BEHAVIOUR, not the retry budget, and the default 2 s
    // mocha timeout fails this test on a loaded machine while the script is still waiting.
    this.timeout(15_000)
    const r = run([], env({
      RUST_VERIFY_CMD: 'echo "inodes differ" >&2; exit 1',
      RUST_VERIFY_ATTEMPTS: '1',
    }))
    assert.strictEqual(r.code, 1, r.out)
    assert.ok(/RED/.test(r.out), `the deploy must go RED: ${r.out}`)
    assert.ok(/verify-running/i.test(r.out), r.out)
    assert.ok(!/DEPLOYED/.test(r.out), 'a deploy that did not take must not claim DEPLOYED')
  })

  test('the default rust build command compiles the rust workspace', () => {
    const out = fs.readFileSync(SCRIPT, 'utf8')
    assert.ok(/cargo build --release/.test(out), 'the default RUST_BUILD_CMD builds the rust workspace')
    assert.ok(/rust-core\/Cargo\.toml/.test(out), 'it builds rust-core, not some other crate')
  })
})
