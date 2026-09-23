// Mocha bootstrap (referenced by .mocharc.cjs `require`).
//
// ---------------------------------------------------------------------------------------------
// ROUND-2 DEFAULT TEST ISOLATION — kept FIRST in this file, before anything else (including the
// vscode-mock/timeline blocks below), because any module a LATER require() pulls in could itself
// capture os.homedir()/dataDir() at ITS OWN load time, before our override took effect.
//
// Round 1 (TRDD-5IDBAJ6O) braked hookScripts.test.ts's own spawned hooks with
// AGENTLENS_NO_REVIVE=1 in that ONE file's baseEnv(). It was not enough: forwardHookEvent()
// (src/cli/hookHandlers.ts) calls spoolHookEvent(payload) — which writes a payload JSON into
// dataDir()/hook-spool — BEFORE it ever calls reviveDaemonDetached(), and reviveDaemonDetached()
// itself writes its `.daemon-revive.lock` stampede lock into dataDir() before it reaches the
// AGENTLENS_NO_REVIVE check. So ANY test file that fails a hook's POST without ALSO overriding
// HOME/DATA_DIR still touches the REAL data dir the instant it forgets to opt in — isolation was
// per-file, opt-in, and this is the third time that shape of bug has been found (TRDD-YGEV6QDD,
// TRDD-4EV3OJ19, TRDD-5IDBAJ6O). Root cause, not another per-caller patch (CLAUDE.md "Bugs"): make
// isolation the DEFAULT for the whole run. A file that genuinely needs the real corpus (read-only)
// or the real revive behavior opts back in explicitly (AGENTLENS_TEST_REAL_HOME / deleting
// AGENTLENS_NO_REVIVE for its own scope, both already how existing tests do it).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// Preserve an already-set AGENTLENS_TEST_REAL_HOME (a nested mocha run — e.g. one test spawning
// another mocha process that also loads this file — must keep pointing at the ORIGINAL real HOME,
// not re-capture whatever the outer run already swapped HOME to).
const REAL_HOME = process.env.AGENTLENS_TEST_REAL_HOME || process.env.HOME || os.homedir()
process.env.AGENTLENS_TEST_REAL_HOME = REAL_HOME

// ---- 1. free ports, SYNCHRONOUSLY, before any spec file's module-level code runs -------------
//
// The previous version of this file assigned ports in a mocha root `beforeAll` hook — but mocha
// REQUIRES every spec file (running each one's own top-level, module-scope code) BEFORE it runs
// any root hook, so a test file that reads process.env.UI_PORT/MCP_PORT/OTLP_PORT (or derives a
// URL from them) at module load time would already have read the UNSET/real value by the time
// `beforeAll` got around to setting it. A child `node -e` process binds three throwaway servers,
// prints their ports, and exits — done here, synchronously, at require time, which is BEFORE
// mocha requires any spec file.
function allocateThreeFreePorts() {
  const script =
    "const net=require('net');(async()=>{const out=[];for(let i=0;i<3;i++){" +
    'const p=await new Promise((res,rej)=>{const s=net.createServer();s.on(' +
    "'error',rej);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>res(port))})});" +
    "out.push(p)}process.stdout.write(out.join(' '))})()"
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' })
  return out.trim().split(/\s+/).map(Number)
}
{
  const needed = ['UI_PORT', 'MCP_PORT', 'OTLP_PORT'].filter((k) => !process.env[k])
  if (needed.length > 0) {
    // Deliberately accepted, KNOWN limitation, not fixed here: bind-read-close only proves a port
    // was free AT PROBE TIME — the same race helpers/freePort.ts's own header documents and
    // mitigates with a claimed-set + retry for tests that need a GUARANTEED port. Good enough for
    // a default whose only job is dodging the real server's fixed 3000/4316/4318.
    const [ui, mcp, otlp] = allocateThreeFreePorts()
    const byKey = { UI_PORT: ui, MCP_PORT: mcp, OTLP_PORT: otlp }
    for (const k of needed) process.env[k] = String(byKey[k])
  }
}

// ---- scrub inherited session endpoints ---------------------------------------------------------
//
// This mocha process itself runs INSIDE a real Claude Code session, which may have its own
// AGENTLENS_*_URL / OTEL_EXPORTER_OTLP_* / CLAUDE_CONFIG_DIR already set in the ambient shell (this
// session's own AgentlensPro hooks, or its own Claude Code telemetry wiring). Left in place, any of
// these would silently outrank the port-based defaults above or the HOME swap below, sending a test
// to a REAL endpoint instead of the throwaway one. Audited (grep) every module that reads each:
//   - AGENTLENS_UI_URL / AGENTLENS_MCP_URL / AGENTLENS_DASHBOARD_URL: src/cli/cliCore.ts
//     (uiBaseUrl/mcpEndpoint/dashboardUrl), consumed by src/cli/hookHandlers.ts, diagnosticsCli.ts,
//     heartbeatCostCli.ts, setup.ts.
//   - OTEL_EXPORTER_OTLP_ENDPOINT / _PROTOCOL / _METRICS_TEMPORALITY_PREFERENCE:
//     src/telemetryConfig.ts's ownedKeys() (the table AgentlensPro writes INTO Claude Code's own
//     settings.json) — not read back by our own code, but this IS the Claude Code session's own
//     telemetry-destination env, so it is cleared defensively rather than trusted to be harmless.
//   - CLAUDE_CONFIG_DIR: src/logReader.ts (claudeProjectsDirs) and src/subscriptionUsage.ts —
//     both fall back to `<HOME>/.claude` once this is cleared, and HOME is about to be swapped
//     below anyway, but an ambient CLAUDE_CONFIG_DIR would keep pointing at the REAL ~/.claude
//     regardless of the HOME swap.
for (const k of [
  'AGENTLENS_UI_URL', 'AGENTLENS_MCP_URL', 'AGENTLENS_DASHBOARD_URL',
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE',
  'CLAUDE_CONFIG_DIR',
]) delete process.env[k]

// ---- 2. HOME / DATA_DIR --------------------------------------------------------------------
//
// fs.realpathSync: macOS's os.tmpdir() is /var/folders/.../T, itself often reached through a
// /tmp -> /private/tmp style symlink hop — comparing an UN-resolved tmpdir() prefix against a
// resolved dataDir()/HOME later would false-negative the containment check below on this platform.
const TMP_ROOT_REAL = fs.realpathSync(os.tmpdir())
const TEST_ROOT = fs.mkdtempSync(path.join(TMP_ROOT_REAL, 'agentlens-test-'))
const TEST_ROOT_REAL = fs.realpathSync(TEST_ROOT)
const TEST_HOME = path.join(TEST_ROOT, 'home')
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data')
fs.mkdirSync(TEST_HOME, { recursive: true })
fs.mkdirSync(TEST_DATA_DIR, { recursive: true })

process.env.HOME = TEST_HOME
// The GENERIC var, deliberately — AGENTLENS_DATA_DIR (canonical) outranks DATA_DIR
// (src/dataDir.ts resolveDataDirFrom), and most test files that already isolate do it by spreading
// `{ ...process.env, HOME, DATA_DIR }` with their OWN explicit DATA_DIR (serverSingleInstance.test.ts,
// hookSpool.test.ts, ...). Setting the canonical var here would silently outrank their override and
// break every one of them; the generic default only fills the gap for a spawn that sets NEITHER.
process.env.DATA_DIR = TEST_DATA_DIR
// But AGENTLENS_DATA_DIR must not be left AMBIENT either: a developer shell that happens to export
// it (pointing anywhere) would outrank the TEST_DATA_DIR default above for every test that doesn't
// set its own DATA_DIR, sending it to that real dir completely unnoticed. Deleting it here is safe
// for isolation: audited every AGENTLENS_DATA_DIR read/write under src/test (grep) — every single
// one saves the PRIOR value, sets it to its OWN mkdtemp'd scratch dir, and restores the prior value
// in a finally/teardown; none of them relies on an ambient value being present. Any test that
// genuinely wants it sets it LATER, in its own scope, which still wins (this only runs once, at
// require time, before any test body executes).
delete process.env.AGENTLENS_DATA_DIR

// The global revive brake. Two switches exist in reviveDaemonDetached() for exactly this reason:
// the env var stops a hook that inherits THIS process's env from ever spawning a real detached
// alcore. Every test that genuinely exercises a real revive already deletes this for its own scope
// and restores it in a finally/teardown (setupVerb.test.ts's suiteSetup/suiteTeardown,
// hookSpool.test.ts's "a hook-revived server LOGS" test) — this default only removes the
// ACCIDENTAL case, which is the one this round of the bug is about.
process.env.AGENTLENS_NO_REVIVE = '1'

// git identity for the fake HOME. No test currently shells out to a real `git` inside it (audited:
// grep for execFileSync('git'/execSync('git /spawnSync('git' under src/test found none), but a
// config-less git aborts a real commit with "please tell me who you are" — cheap to seed once,
// harmless if unused, and cheaper than debugging it the day a test starts doing it.
fs.writeFileSync(path.join(TEST_HOME, '.gitconfig'), '[user]\n\tname = Test User\n\temail = test@example.invalid\n')
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) if (!process.env[k]) process.env[k] = 'Test User'
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) if (!process.env[k]) process.env[k] = 'test@example.invalid'

// Package-manager / language caches are NOT collector data. Redirecting HOME must not also
// redirect them into the throwaway temp dir, or every run pays for a full cache re-download.
// Verified first (`tldr search 'XDG_' src`) that nothing in this codebase resolves a data dir,
// spool, kill-switch, or config path from any XDG_* variable, so pointing these at the real
// machine's caches is safe.
if (!process.env.npm_config_cache) process.env.npm_config_cache = path.join(REAL_HOME, '.npm')
if (!process.env.XDG_CACHE_HOME) process.env.XDG_CACHE_HOME = path.join(REAL_HOME, '.cache')
if (!process.env.UV_CACHE_DIR) process.env.UV_CACHE_DIR = path.join(REAL_HOME, '.cache', 'uv')

// ---- 3. containment guard, checked against the SAME resolution dataDir() itself uses ----------
//
// Round-2 correction: an earlier version of this guard hand-replicated src/dataDir.ts's precedence
// rules locally — a second copy of logic that WILL drift from the original (the project's own
// standing rule against mirrors). Require the COMPILED module directly instead, so the guard is
// checking the ACTUAL function the rest of the codebase calls, not a copy of its rules.
let dataDirFrom
try {
  // tsconfig.test.json compiles src/**/*.ts with rootDir "src" / outDir "out/test", so
  // src/dataDir.ts lands at out/test/dataDir.js — two levels up from this file's own
  // src/test/setup.js, then back down into out/test/.
  ;({ dataDirFrom } = require(path.resolve(__dirname, '..', '..', 'out', 'test', 'dataDir.js')))
} catch (e) {
  throw new Error(
    'test isolation guard: could not load the compiled out/test/dataDir.js ' +
    '(needed to check the REAL data-dir resolution, not a hand-copied one) — ' +
    `run \`pnpm run compile-tests\` first. Original error: ${e && e.message}`,
  )
}

/** Fails LOUD, not silently, the moment the redirection above didn't take — a containment check
 *  by PREFIX COMPARISON, not by "is different from the real HOME" (os.tmpdir() itself can sit
 *  inside a real HOME on some setups, and /tmp vs /private/tmp on macOS breaks a naive compare in
 *  the opposite direction), and always against the REALPATH'd root so a symlink hop can't hide a
 *  false pass. A path that does not exist YET (fs.realpathSync would throw ENOENT) is treated as
 *  contained only if its nearest existing ancestor is — dataDirFrom()'s default
 *  (`<HOME>/.agentlens`) usually doesn't exist until the server first writes to it. */
function realpathOrParent(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p))
  }
}

/** Every `alcore serve --data-dir X` already running BEFORE this mocha run started, realpath'd
 *  once at load time (never re-scanned — a server THIS run itself boots is not in this list and
 *  must not be, or a test booting its own isolated server under the tmp root would trip its own
 *  guard). Widening assertContained's containment check to "anywhere under the system tmp root"
 *  (Round-3 fix above) means a LEAKED live server whose data dir also happens to sit under
 *  os.tmpdir() (e.g. a debug `alcore --data-dir .../T/al-shutdown-2141-term-data`, TRDD-4FLTDMHA)
 *  would otherwise pass the guard as "contained" even though it is someone else's real running
 *  data, not this run's own scratch space. `ps -eo pid,command` is snapshotted ONCE via the same
 *  process-table-to-a-string pattern used elsewhere in this file (never a live `ps | grep`, which
 *  would match its own invoking shell's argv). */
function findLiveServerDataDirs() {
  // ponytail: two known limits here — the (\S+) capture cuts a data-dir path at its first space
  // (realpathSync then fails and that dir silently goes unprotected), and a server started with
  // DATA_DIR in its environment and no --data-dir flag is invisible to this argv scan. Upgrade:
  // read each alcore pid's <dataDir>/server.pid or its environment instead of parsing argv.
  try {
    const out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8' })
    const dirs = []
    for (const line of out.split('\n')) {
      const m = line.match(/\balcore\b.*?\bserve\b.*?--data-dir[= ]+(\S+)/)
      if (!m) continue
      try { dirs.push(fs.realpathSync(m[1])) } catch { /* the named dir is already gone — nothing to protect */ }
    }
    return dirs
  } catch {
    return [] // ps unavailable — cannot enumerate; the guard degrades to the tmp-root-only check
  }
}


// Returns a copy of the load-time snapshot so a test can restore it exactly (setup.js exposed
// only a setter before; a test that needs to save-then-restore had no getter to save from).
exports._getLiveServerDataDirsForTest = () => LIVE_SERVER_DATA_DIRS.slice()

let LIVE_SERVER_DATA_DIRS = findLiveServerDataDirs()
// Test-only override so hookScripts.test.ts can prove the clause below throws for a pre-existing
// live server's data dir WITHOUT spawning a real alcore (this snapshot only runs once, at require
// time, before any test's own server exists to pollute it).
exports._setLiveServerDataDirsForTest = (dirs) => { LIVE_SERVER_DATA_DIRS = dirs }

function assertContained(label, p) {
  const real = realpathOrParent(p)
  // Round-3 fix (found by running the FULL suite, not just the 2 targeted regression tests):
  // many EXISTING tests legitimately point HOME/DATA_DIR at their OWN sibling mkdtemp under the
  // SAME system tmp root (e.g. os.tmpdir()/al-daemon-XXXX), not nested under THIS run's TEST_ROOT
  // — daemonCommand.test.ts, cacheStateCli.test.ts, cacheExpiredAuthoritative.test.ts,
  // ramdiskSpool.test.ts, serverStartupVerdict.test.ts, serverLogTailScope.test.ts,
  // serverSingleInstance.test.ts, killSwitch.test.ts, allAccounts.test.ts,
  // subscriptionUsage.test.ts, delegateGate.test.ts and reviewGateTriggers.test.ts all do this via
  // suiteSetup/suiteTeardown or setup/teardown save-restore, which IS correct isolation, just not
  // nested under our root. A strict TEST_ROOT-only check made the root-level afterEach below throw
  // on the first one of them mocha happened to run — and an uncaught error in a root hook plugin
  // ABORTS THE ENTIRE MOCHA RUN (not just the current suite/file), which is how the previous
  // version of this guard silently cut a 2855-test run down to 927 before reporting one failure.
  // The actual invariant this guard protects is never the REAL HOME / its real data dir — and
  // every one of those legitimate overrides already satisfies that by construction (a fresh
  // mkdtemp under the system tmp root). So contain against TMP_ROOT_REAL (the whole realpath'd
  // os.tmpdir()), not TEST_ROOT_REAL (just this run's own subdir of it).
  if (real !== TMP_ROOT_REAL && !real.startsWith(TMP_ROOT_REAL + path.sep)) {
    throw new Error(
      `ABORTING remaining tests — test isolation guard: ${label} (${real}) is not inside the system temp root ` +
      `(${TMP_ROOT_REAL}) -- refusing to run rather than risk touching the real ${label}`,
    )
  }
  // A path CAN sit under the system tmp root (satisfying the check above) and still not be OUR
  // scratch space: a live `alcore serve --data-dir X` that was already running before this run
  // started (e.g. a leaked debug instance, TRDD-4FLTDMHA) may itself have picked a data dir under
  // os.tmpdir(). That dir is real, in-use production data — refuse it just as loudly as a real
  // HOME, or this run could write into (or the afterAll cleanup could delete) a live server's data.
  for (const liveDir of LIVE_SERVER_DATA_DIRS) {
    if (real === liveDir || real.startsWith(liveDir + path.sep)) {
      throw new Error(
        `ABORTING remaining tests — test isolation guard: ${label} (${real}) is the data dir of an ` +
        `already-running alcore server (${liveDir}) -- refusing to run rather than touch its data`,
      )
    }
  }
}

assertContained('HOME', process.env.HOME)
assertContained('DATA_DIR', dataDirFrom(process.env))

// Exported so hookScripts.test.ts can exercise the ACTUAL guard (not a copy of its logic) and
// prove it throws on a real-HOME path, rather than only trusting it never fired during a run.
exports.assertContained = assertContained

// Unique per-run marker, used by the discriminating leak check in afterAll below and by
// hookScripts.test.ts's own regression test — it proves THIS run's own spool write landed under
// the temp data dir (positive proof of redirection) and never landed in the real spool dir
// (positive proof the brake held), rather than inferring either from a lock mtime or file count
// that the live session's own concurrent hooks could equally produce.
const RUN_MARKER = `agentlens-test-isolation-${process.pid}-${Date.now()}`
process.env.AGENTLENS_TEST_RUN_MARKER = RUN_MARKER
// The real spool dir routinely sits at its 20,000-file cap (a standing production crash-loop keeps
// it full independent of any test run). Scanning all 20,000 files' bodies every run is real,
// avoidable I/O — only a file WRITTEN during this run can possibly hold this run's marker. A few
// seconds of slack BEFORE the recorded start absorbs ordinary clock/mtime granularity without
// widening the scan back to the whole directory.
const RUN_START_MS = Date.now() - 5000

/** `ps -eo pid,command` snapshot to a string, then searched in memory — never a live `ps | grep`
 *  (the shell running the pipeline would match its own argv against `needle`). */
function findProcessNaming(needle) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,command'], { encoding: 'utf-8' })
    const hit = out.split('\n').find((line) => line.includes(needle))
    return hit ? hit.trim() : null
  } catch {
    return null // ps unavailable — cannot prove a leak, but cannot prove its absence either
  }
}

// Mocha "root hook plugin" shape (exports.mochaHooks) — works regardless of the configured UI
// (`tdd` here), unlike a bare top-level before/after which only the bdd interface exposes.
exports.mochaHooks = {
  // Round-2 correction: a test that deletes/overrides AGENTLENS_NO_REVIVE for its own scope and
  // forgets to restore it (or throws before its finally runs) would silently drop the global brake
  // for every test that runs afterward. Every test that legitimately touches it already
  // save/restores within its own scope (setupVerb.test.ts, hookSpool.test.ts) — this only catches
  // a future one that doesn't. Also re-checks containment (cheap) on every test, so a test that
  // mutates HOME/DATA_DIR without restoring is caught at the FIRST test after it, not only at the
  // end of the whole run.
  afterEach() {
    if (process.env.AGENTLENS_NO_REVIVE !== '1') {
      throw new Error(
        `test isolation guard: AGENTLENS_NO_REVIVE was left as ${JSON.stringify(process.env.AGENTLENS_NO_REVIVE)} ` +
        'after a test — an unrestored delete/override would drop the global revive brake for every later test',
      )
    }
    assertContained('HOME', process.env.HOME)
    assertContained('DATA_DIR', dataDirFrom(process.env))
  },

  async afterAll() {
    // Positive-containment re-check: confirm the run never drifted HOME/DATA_DIR back out before
    // removing anything.
    assertContained('HOME', process.env.HOME)
    assertContained('DATA_DIR', dataDirFrom(process.env))

    // Discriminating leak check: this run's own marker must be ABSENT from the REAL spool dir
    // (read-only — never touches it). Its presence would prove a hook wrote into
    // ~/.agentlens/hook-spool during this run despite the brake above. This is a BACKSTOP, not the
    // primary proof — the primary proof is hookScripts.test.ts's own regression test, which reads
    // its OWN marker back immediately after its own hook run, before a healthy draining server
    // could ever delete the evidence out from under it. This scan, run only once at the very end
    // of a run that may take minutes, could miss a leak the server's own drain already cleaned up
    // in the meantime — its value is catching what the regression test's own narrower window can't
    // (a leak from a DIFFERENT test file). Only files written since RUN_START_MS can possibly carry
    // this run's marker, so older entries (the dir sits at a standing 20,000-file cap from an
    // unrelated production crash-loop) are skipped unread.
    const realSpoolDir = path.join(REAL_HOME, '.agentlens', 'hook-spool')
    let leaked = false
    try {
      for (const name of fs.readdirSync(realSpoolDir)) {
        if (!name.endsWith('.json')) continue
        const full = path.join(realSpoolDir, name)
        try {
          if (fs.statSync(full).mtimeMs < RUN_START_MS) continue
          if (fs.readFileSync(full, 'utf-8').includes(RUN_MARKER)) { leaked = true; break }
        } catch { /* raced with the server's own drain — ignore */ }
      }
    } catch { /* no real spool dir on this machine — nothing to check, nothing leaked */ }

    // Process leak scan: nothing spawned during this run may still be alive naming the temp root
    // in its argv (a revive/server child that outlived its test). Async server teardown can take a
    // beat, so poll briefly rather than failing on a process still mid-exit.
    const deadline = Date.now() + 2000
    let survivor = null
    do {
      survivor = findProcessNaming(TEST_ROOT_REAL)
      if (!survivor) break
      await new Promise((r) => setTimeout(r, 200))
    } while (Date.now() < deadline)

    // Remove ONLY the exact path mkdtemp returned for THIS run (never recomputed from env — a
    // recomputed guess could resolve to something else if an env var was mutated mid-suite), and
    // only after re-asserting it really is our own scratch root under the system tmpdir — and
    // NEVER when a survivor process still names it: a live process's data dir must never be
    // deleted out from under it, and the directory is exactly the evidence a human needs to
    // diagnose why that process didn't exit.
    if (
      !survivor &&
      TEST_ROOT_REAL.startsWith(TMP_ROOT_REAL + path.sep) &&
      path.basename(TEST_ROOT_REAL).startsWith('agentlens-test-')
    ) {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true })
    }

    if (leaked) {
      throw new Error(
        `test isolation guard: a hook wrote this run's marker into the REAL spool dir ${realSpoolDir} ` +
        '— the AGENTLENS_NO_REVIVE brake did not hold',
      )
    }
    if (survivor) {
      throw new Error(
        `test isolation guard: a process is still running against the temp root after the suite (${survivor}) ` +
        `— left ${TEST_ROOT} in place for diagnosis rather than deleting it out from under a live process`,
      )
    }
  },
}

// ---------------------------------------------------------------------------------------------
// The VS Code extension was removed (TRDD-6E6416B8), and with it the runtime
// VS Code module mock that used to be installed here — no test resolves the
// editor module at runtime any more (the retained persistence/collector modules
// are exercised with plain structural fakes). Kept as a no-op comment so the history
// of why this file exists at all is not lost.

// TRDD-66IXMIGN: the parser strips timelines from sessions idle longer than the hot-age window
// (default 24h). Fixture transcripts across the suite carry FIXED past timestamps, so without
// this pin every one of them would parse as "cold" and lose the timeline its assertions read.
// 10 years keeps every fixture hot; the strip mechanics have their own unit tests
// (timelineRetention.test.ts), and the age gate itself was verified by the live OOM repro.
if (!process.env.AGENTLENS_TIMELINE_HOT_AGE_HOURS) {
  process.env.AGENTLENS_TIMELINE_HOT_AGE_HOURS = '87600'
}
