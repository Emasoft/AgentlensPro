// The post-verb server version check (TRDD-YL3EWT6N item 10): the pure plan, the memo, the lock, the real `alcore version`
// probe against scripts, the executor against a simulated server, and the cliMain wiring (when it runs, and when it does not).
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  acquireVersionLock, memoHit, probeAlcoreVersion, readVersionMemo, runVersionCheck, versionRestartPlan, writeVersionMemo,
  type BinIdentity, type DiskProbe, type VersionCheckDeps, type VersionMemo, type VersionPlanInput, type VersionStats,
} from "../cli/versionRestart"
import { cliMain, versionCheckEligible } from "../cli/main"
import { killSwitchPath, noRevivePath } from "../cli/killSwitch"
import { pushNotice } from "../cli/launchNotices"

const DIR = "/data/agentlens-plan-test"
const ID: BinIdentity = { path: "/bin/alcore", size: 100, mtimeMs: 1 }
const ok = (version: string): DiskProbe => ({ ok: true, version })
const statsOf = (o: VersionStats = {}): VersionStats => ({ pid: 100, dataDir: DIR, version: "2.33.0", startedBy: "hook-revive", ...o })
const planOf = (o: Partial<VersionPlanInput> = {}): { verdict: string; warnCli: boolean } =>
  versionRestartPlan({ stats: statsOf(), dir: DIR, envDir: DIR, cliVersion: "2.34.0", disk: ok("2.34.0"), gaveUp: false, ...o })

const dirs: string[] = []
const tmpDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentlens-vr-")); dirs.push(d); return d }
// Registered inside each suite that makes temp dirs: a teardown at the root would run for every test of the mocha process.
const removeTmpDirsAfterEach = (): void => { teardown(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) }) }

suite("versionRestartPlan: every verdict, each from its own input", () => {
  test("no answer", () => assert.strictEqual(planOf({ stats: null }).verdict, "no-answer"))
  test("a server of another data dir, or one that reports none, is other-dir and never restarts", () => {
    assert.strictEqual(planOf({ stats: statsOf({ dataDir: "/elsewhere" }) }).verdict, "other-dir")
    assert.strictEqual(planOf({ stats: statsOf({ dataDir: undefined }) }).verdict, "other-dir")
  })
  test("env-dir-mismatch: the server is this dir, but stop/start act on another", () => assert.strictEqual(planOf({ envDir: "/another" }).verdict, "env-dir-mismatch"))
  test("gave-up outranks a restart the versions would call for", () => assert.strictEqual(planOf({ gaveUp: true, disk: ok("9.9.9") }).verdict, "gave-up"))
  test("probe-failed: not probed, or the probe failed", () => {
    assert.strictEqual(planOf({ disk: null }).verdict, "probe-failed")
    assert.strictEqual(planOf({ disk: { ok: false, detail: "exit 64" } }).verdict, "probe-failed")
  })
  test("same: disk, running and CLI agree, nothing to say", () => assert.deepStrictEqual(planOf({ stats: statsOf({ version: "2.34.0" }) }), { verdict: "same", warnCli: false }))
  test("cli-differs: disk equals running, the CLI is another build: a warning, no restart", () =>
    assert.deepStrictEqual(planOf({ stats: statsOf({ version: "2.34.0" }), cliVersion: "2.35.0" }), { verdict: "cli-differs", warnCli: true }))
  test("restart-supervisor when the supervisor started the server, restart-stop-start for anyone else", () => {
    assert.deepStrictEqual(planOf({ stats: statsOf({ startedBy: "supervisor" }) }), { verdict: "restart-supervisor", warnCli: false })
    assert.deepStrictEqual(planOf({ stats: statsOf({ startedBy: "hook-revive" }) }), { verdict: "restart-stop-start", warnCli: false })
    assert.strictEqual(planOf({ stats: statsOf({ startedBy: null }) }).verdict, "restart-stop-start")
  })
  test("three-way mismatch restarts (the disk binary is what runs next) and warns about the CLI", () =>
    assert.deepStrictEqual(planOf({ cliVersion: "2.35.0" }), { verdict: "restart-stop-start", warnCli: true }))
  test("a server that reports no version is older than any that does: restart", () =>
    assert.strictEqual(planOf({ stats: statsOf({ version: undefined }) }).verdict, "restart-stop-start"))
})

suite("memoHit: only an unchanged binary, CLI and server pid short-circuit", () => {
  const memo = (o: Partial<VersionMemo> = {}): VersionMemo => ({ identity: ID, cliVersion: "2.34.0", pid: 100, verdict: "same", gaveUp: null, time: "t", ...o })
  test("hit when binary, CLI and pid match and the verdict is a settled one", () => {
    for (const verdict of ["same", "cli-differs", "probe-failed", "restarted"]) assert.strictEqual(memoHit(memo({ verdict }), ID, "2.34.0", 100), true, verdict)
  })
  test("each changed input is a miss", () => {
    assert.strictEqual(memoHit(null, ID, "2.34.0", 100), false)
    assert.strictEqual(memoHit(memo(), ID, "2.34.0", 101), false, "pid")
    assert.strictEqual(memoHit(memo(), ID, "2.35.0", 100), false, "cli version")
    assert.strictEqual(memoHit(memo(), { ...ID, size: 101 }, "2.34.0", 100), false, "size")
    assert.strictEqual(memoHit(memo(), { ...ID, mtimeMs: 2 }, "2.34.0", 100), false, "mtime")
    assert.strictEqual(memoHit(memo(), { ...ID, path: "/other" }, "2.34.0", 100), false, "path")
    assert.strictEqual(memoHit(memo({ verdict: "gave-up" }), ID, "2.34.0", 100), false, "a gave-up memo never short-circuits: it needs the running version")
  })
})

suite("memo file", () => {
  removeTmpDirsAfterEach()
  test("write then read round-trips; a malformed or foreign-shaped file reads as null", () => {
    const dir = tmpDir()
    const m: VersionMemo = { identity: ID, cliVersion: "2.34.0", pid: 7, verdict: "gave-up", gaveUp: { identity: ID, running: "2.33.0" }, time: "t" }
    writeVersionMemo(dir, m)
    assert.deepStrictEqual(readVersionMemo(dir), m)
    fs.writeFileSync(path.join(dir, "version-check.json"), "{not json")
    assert.strictEqual(readVersionMemo(dir), null)
    fs.writeFileSync(path.join(dir, "version-check.json"), JSON.stringify({ ...m, pid: "7" }))
    assert.strictEqual(readVersionMemo(dir), null)
    fs.writeFileSync(path.join(dir, "version-check.json"), JSON.stringify({ ...m, gaveUp: { identity: ID } }))
    assert.strictEqual(readVersionMemo(dir), null)
  })
})

suite("the version-restart lock", () => {
  removeTmpDirsAfterEach()
  const lockFile = (dir: string): string => path.join(dir, "version-restart.lock")
  test("a free lock is taken holding our pid and released; a second release is harmless", () => {
    const dir = tmpDir()
    const release = acquireVersionLock(dir, 111)
    assert.ok(release)
    assert.strictEqual(fs.readFileSync(lockFile(dir), "utf8"), "111")
    release()
    assert.strictEqual(fs.existsSync(lockFile(dir)), false)
    release()
  })
  test("a live holder: skip, and its file is untouched", () => {
    const dir = tmpDir()
    fs.writeFileSync(lockFile(dir), "4242")
    assert.strictEqual(acquireVersionLock(dir, 111, { pidAlive: p => p === 4242 }), null)
    assert.strictEqual(fs.readFileSync(lockFile(dir), "utf8"), "4242")
  })
  test("a dead holder is taken over by rename: the file holds our pid and no temp file is left", () => {
    const dir = tmpDir()
    fs.writeFileSync(lockFile(dir), "4242")
    const release = acquireVersionLock(dir, 111, { pidAlive: () => false })
    assert.ok(release)
    assert.strictEqual(fs.readFileSync(lockFile(dir), "utf8"), "111")
    assert.deepStrictEqual(fs.readdirSync(dir), ["version-restart.lock"])
  })
  test("release never removes a lock that is no longer ours", () => {
    const dir = tmpDir()
    const release = acquireVersionLock(dir, 111)
    assert.ok(release)
    fs.writeFileSync(lockFile(dir), "222")
    release()
    assert.strictEqual(fs.readFileSync(lockFile(dir), "utf8"), "222")
  })
  test("two takers of one dead holder: the later rename wins, the earlier stands down, exactly one proceeds", () => {
    const dir = tmpDir()
    fs.writeFileSync(lockFile(dir), "999")
    let second: (() => void) | null = null
    // Taker 111 has renamed its temp file over the lock and not yet re-read it: taker 222 runs its whole take-over now.
    // Taker 222 observed the dead holder before 111 renamed, so for it nothing is alive: its own rename lands over 111.
    const first = acquireVersionLock(dir, 111, { pidAlive: p => p !== 999, beforeReread: () => { second = acquireVersionLock(dir, 222, { pidAlive: () => false }) } })
    assert.strictEqual(first, null, "the earlier taker read the other pid and stood down")
    assert.ok(second, "the later taker proceeds")
    assert.strictEqual(fs.readFileSync(lockFile(dir), "utf8"), "222")
  })
  test("an unparseable lock is a taker mid-write while fresh and garbage once old", () => {
    const dir = tmpDir()
    fs.writeFileSync(lockFile(dir), "")
    assert.strictEqual(acquireVersionLock(dir, 111, { pidAlive: () => false }), null, "fresh and empty: someone is writing it")
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockFile(dir), old, old)
    assert.ok(acquireVersionLock(dir, 111, { pidAlive: () => false }), "old and empty: taken over")
  })
})

suite("probeAlcoreVersion against real scripts (an alcore older than the subcommand exits 64, an unsigned one 137)", () => {
  removeTmpDirsAfterEach()
  const script = (body: string): string => {
    const file = path.join(tmpDir(), "alcore")
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }
  test("a version on stdout is read", async () => assert.deepStrictEqual(await probeAlcoreVersion(script("echo 2.34.0")), ok("2.34.0")))
  test("exit 64 and exit 137 are failures that name the code", async () => {
    assert.deepStrictEqual(await probeAlcoreVersion(script("exit 64")), { ok: false, detail: "exit 64" })
    assert.deepStrictEqual(await probeAlcoreVersion(script("exit 137")), { ok: false, detail: "exit 137" })
  })
  test("a kill by signal (no exit code in Node) is a failure naming the signal", async () =>
    assert.deepStrictEqual(await probeAlcoreVersion(script("kill -9 $$")), { ok: false, detail: "killed by SIGKILL" }))
  test("a binary that does not answer in time is killed and reported as a timeout", async () =>
    assert.deepStrictEqual(await probeAlcoreVersion(script("exec sleep 5"), 300), { ok: false, detail: "timed out after 300 ms" }))
  test("empty or multi-word output is not a version", async () => {
    assert.strictEqual((await probeAlcoreVersion(script(":"))).ok, false)
    assert.strictEqual((await probeAlcoreVersion(script("echo two words"))).ok, false)
  })
  test("a missing binary is a failure, not a throw", async () => assert.strictEqual((await probeAlcoreVersion(path.join(tmpDir(), "nope"))).ok, false))
})

/** A simulated server and the injected effects around it: the executor runs for real, only the world it observes is a model. */
function harness(o: { memo?: VersionMemo | null; startedBy?: string; cliVersion?: string; disk?: DiskProbe; staysOld?: boolean } = {}) {
  const dir = tmpDir()
  const calls = { fetch: 0, probe: 0, stop: 0, start: 0 }
  const lines: string[] = []
  let memo: VersionMemo | null = o.memo ?? null
  let clock = 0
  const disk: DiskProbe = o.disk ?? ok("2.34.0")
  const world = { up: true, pid: 100, version: "2.33.0", startedBy: o.startedBy ?? "hook-revive", respawnAt: null as number | null, bin: { size: 100, mtimeMs: 1 } }
  const upgraded = (): string => (o.staysOld === true ? "2.33.0" : disk.ok ? disk.version : "2.33.0")
  const deps: VersionCheckDeps = {
    env: {}, dataDir: dir, envDir: dir, cliVersion: o.cliVersion ?? "2.34.0",
    readPidfile: () => (world.up ? world.pid : null), pidAlive: () => true,
    alcoreBin: () => "/bin/alcore", statFile: () => world.bin,
    readMemo: () => memo, writeMemo: (_d, m) => { memo = m },
    fetchStats: async () => {
      calls.fetch += 1
      if (!world.up && world.respawnAt !== null && clock >= world.respawnAt) { world.up = true; world.pid = 300; world.version = upgraded(); world.respawnAt = null }
      return world.up ? { pid: world.pid, dataDir: dir, version: world.version, startedBy: world.startedBy } : null
    },
    probe: async () => { calls.probe += 1; return disk },
    stopServer: async () => { calls.stop += 1; world.up = false; if (world.startedBy === "supervisor") world.respawnAt = clock + 1_500 },
    ensureServer: async () => { calls.start += 1; world.up = true; world.pid = 200; world.version = upgraded() },
    parentPid: () => 50, sleep: async ms => { clock += ms }, now: () => clock, say: l => { lines.push(l) }, lock: () => () => { /* uncontended */ },
  }
  return { dir, calls, lines, deps, world, memo: (): VersionMemo | null => memo, run: (extra: VersionCheckDeps = {}) => runVersionCheck({ ...deps, ...extra }) }
}

suite("runVersionCheck: the executor against a simulated server", () => {
  removeTmpDirsAfterEach()
  test("no live pidfile owner: none-no-server, and nothing else runs", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ readPidfile: () => null }), "none-no-server")
    assert.strictEqual(await h.run({ pidAlive: () => false }), "none-no-server")
    assert.deepStrictEqual(h.calls, { fetch: 0, probe: 0, stop: 0, start: 0 })
  })
  test("with AGENTLENS_DATA_DIR at a temp dir and no server.pid, the DEFAULT check returns none-no-server with zero fetch and zero probe", async () => {
    const dir = tmpDir()
    const saved = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = dir
    let fetched = 0
    let probed = 0
    try {
      const out = await runVersionCheck({ fetchStats: async () => { fetched += 1; return null }, probe: async () => { probed += 1; return ok("1.0.0") } })
      assert.strictEqual(out, "none-no-server")
    } finally { if (saved === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = saved }
    assert.deepStrictEqual([fetched, probed], [0, 0])
  })
  test("braked by the NO_REVIVE file or by AGENTLENS_NO_REVIVE=1: no restart, no network", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ env: { AGENTLENS_NO_REVIVE: "1" } }), "braked")
    fs.writeFileSync(noRevivePath(h.dir), "")
    assert.strictEqual(await h.run(), "braked")
    assert.deepStrictEqual(h.calls, { fetch: 0, probe: 0, stop: 0, start: 0 })
  })
  test("no binary, or a binary that cannot be stat-ed: none-no-binary", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ alcoreBin: () => null }), "none-no-binary")
    assert.strictEqual(await h.run({ statFile: () => null }), "none-no-binary")
    assert.strictEqual(h.calls.fetch, 0)
  })
  test("a memo hit makes zero fetch and zero probe calls", async () => {
    const memo: VersionMemo = { identity: { path: "/bin/alcore", size: 100, mtimeMs: 1 }, cliVersion: "2.34.0", pid: 100, verdict: "same", gaveUp: null, time: "t" }
    const h = harness({ memo })
    assert.strictEqual(await h.run(), "memo-hit")
    assert.deepStrictEqual(h.calls, { fetch: 0, probe: 0, stop: 0, start: 0 })
  })
  test("a pidfile owner that answers nothing: no-answer, no restart, and nothing is memoized (it must be retried)", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ fetchStats: async () => null }), "no-answer")
    assert.strictEqual(h.memo(), null)
    assert.strictEqual(h.calls.stop, 0)
  })
  test("another data dir answering never restarts", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ fetchStats: async () => ({ pid: 5, dataDir: "/elsewhere", version: "1.0.0", startedBy: "x" }) }), "other-dir")
    assert.deepStrictEqual([h.calls.probe, h.calls.stop, h.calls.start], [0, 0, 0])
  })
  test("same: silent, memoized, and the next run costs nothing", async () => {
    const h = harness({ cliVersion: "2.33.0", disk: ok("2.33.0") })
    assert.strictEqual(await h.run(), "same")
    assert.strictEqual(h.memo()?.verdict, "same")
    assert.strictEqual(await h.run(), "memo-hit")
    assert.deepStrictEqual([h.calls.fetch, h.calls.probe, h.lines.length], [1, 1, 0])
  })
  test("cli-differs: one warning, no restart, memoized so the warning is not repeated", async () => {
    const h = harness({ cliVersion: "2.35.0", disk: ok("2.33.0") })
    assert.strictEqual(await h.run(), "cli-differs")
    assert.strictEqual(await h.run(), "memo-hit")
    assert.strictEqual(h.lines.length, 1)
    assert.ok(h.lines[0].includes("2.35.0") && h.lines[0].includes("2.33.0"), h.lines[0])
    assert.strictEqual(h.calls.stop, 0)
  })
  for (const detail of ["exit 64", "exit 137"]) {
    test(`probe ${detail}: probe-failed, one line, memoized, no restart`, async () => {
      const h = harness({ disk: { ok: false, detail } })
      assert.strictEqual(await h.run(), "probe-failed")
      assert.strictEqual(await h.run(), "memo-hit")
      assert.strictEqual(h.lines.length, 1)
      assert.ok(h.lines[0].includes(detail), h.lines[0])
      assert.deepStrictEqual([h.calls.stop, h.calls.start], [0, 0])
    })
  }
  test("a stale server run by anyone but the supervisor: stop, then start, and one line names both versions; the next run is a memo hit", async () => {
    const h = harness()
    assert.strictEqual(await h.run(), "restarted")
    assert.deepStrictEqual([h.calls.stop, h.calls.start], [1, 1])
    assert.strictEqual(h.lines.length, 1)
    assert.ok(h.lines[0].includes("2.33.0") && h.lines[0].includes("2.34.0"), h.lines[0])
    assert.strictEqual(h.memo()?.verdict, "restarted")
    assert.strictEqual(h.memo()?.pid, 200)
    assert.strictEqual(await h.run(), "memo-hit")
  })
  test("a flag DISABLED present still plans and carries out the restart (the switch does not refuse a start)", async () => {
    const h = harness()
    fs.writeFileSync(killSwitchPath(h.dir), "disabled")
    assert.strictEqual(await h.run(), "restarted")
  })
  test("a supervisor-started server: only the child is stopped, the supervisor respawn is awaited, ensureServer is never called", async () => {
    const h = harness({ startedBy: "supervisor" })
    assert.strictEqual(await h.run(), "restarted")
    assert.deepStrictEqual([h.calls.stop, h.calls.start], [1, 0])
    assert.ok(h.lines[0].includes("supervisor"), h.lines[0])
    assert.strictEqual(h.memo()?.pid, 300)
  })
  test("three versions all different: restarts, and the CLI mismatch is warned about exactly once", async () => {
    const h = harness({ cliVersion: "2.35.0" })
    assert.strictEqual(await h.run(), "restarted")
    assert.strictEqual(h.lines.length, 2)
    assert.ok(h.lines[0].includes("2.35.0"), h.lines[0])
    assert.strictEqual(h.lines.filter(l => l.includes("2.35.0")).length, 1)
  })
  test("not converged: one line naming `agentlenspro server restart`, gave-up is memoized by binary and running version, and a new pid does NOT restart again", async () => {
    const h = harness({ staysOld: true })
    assert.strictEqual(await h.run(), "not-converged")
    assert.ok(h.lines[0].includes("agentlenspro server restart"), h.lines[0])
    assert.deepStrictEqual(h.memo()?.gaveUp, { identity: ID, running: "2.33.0" })
    h.world.pid = 999
    assert.strictEqual(await h.run(), "gave-up")
    assert.deepStrictEqual([h.calls.stop, h.calls.start, h.calls.probe, h.lines.length], [1, 1, 1, 1], "no second stop, no second probe, silent")
  })
  test("gave-up ends when the binary changes: a rebuilt alcore is restarted again", async () => {
    const h = harness({ staysOld: true })
    assert.strictEqual(await h.run(), "not-converged")
    h.world.bin = { size: 100, mtimeMs: 2 }
    assert.strictEqual(await h.run(), "not-converged")
    assert.strictEqual(h.calls.stop, 2)
  })
  test("a failed stop: one line, nothing started, gave-up memoized (a 15 s stop must not repeat on every launch)", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ stopServer: async () => { throw new Error("still running 15s after SIGTERM") } }), "not-converged")
    assert.ok(h.lines[0].includes("the stop failed") && h.lines[0].includes("SIGTERM"), h.lines[0])
    assert.strictEqual(h.calls.start, 0)
    assert.ok(h.memo()?.gaveUp)
  })
  test("a failed start: one line naming the start", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ ensureServer: async () => { throw new Error("the server exited during startup") } }), "not-converged")
    assert.ok(h.lines[0].includes("the start failed"), h.lines[0])
  })
  test("a held lock: lock-held, silent, no network", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ lock: () => null }), "lock-held")
    assert.deepStrictEqual([h.calls.fetch, h.lines.length], [0, 0])
  })
  test("a throwing effect never escapes: error, one line", async () => {
    const h = harness()
    assert.strictEqual(await h.run({ fetchStats: async () => { throw new Error("boom") } }), "error")
    assert.strictEqual(h.lines.length, 1)
    assert.ok(h.lines[0].includes("boom"), h.lines[0])
  })
})

suite("cliMain wiring: the check runs after the verb, only for an ordinary verb that succeeded", () => {
  let savedEnv: Record<string, string | undefined>
  let savedExit: typeof process.exitCode
  setup(() => {
    savedEnv = { AGENTLENS_NO_AUTOSETUP: process.env.AGENTLENS_NO_AUTOSETUP, AGENTLENS_NO_REVIVE: process.env.AGENTLENS_NO_REVIVE }
    delete process.env.AGENTLENS_NO_AUTOSETUP
    delete process.env.AGENTLENS_NO_REVIVE
    savedExit = process.exitCode
    // Mocha runs every test file in one process: an earlier test that left exitCode set would make the gate skip the check here.
    process.exitCode = undefined
  })
  teardown(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    process.exitCode = savedExit
  })

  /** Run cliMain with the launch check, the verbs and the version check all injected; returns what ran in order and what reached stderr. */
  async function drive(argv: string[], over: { launchCheck?: () => Promise<number | null>; diagnostics?: () => Promise<void> } = {}): Promise<{ order: string[]; stderr: string; code: number }> {
    const order: string[] = []
    const err = process.stderr.write
    const log = console.log
    console.log = (): void => { /* the usage text of help verbs is not what these tests look at */ }
    let stderr = ""
    process.stderr.write = ((c: string | Uint8Array): boolean => { stderr += String(c); return true }) as typeof process.stderr.write
    try {
      const code = await cliMain(argv, async () => undefined, {
        launchCheck: over.launchCheck ?? (async () => null),
        diagnostics: over.diagnostics ?? (async () => { order.push("verb") }),
        serverCommand: async () => { order.push("verb") },
        versionCheck: async () => { order.push("check"); pushNotice("VERSION-CHECK-LINE") },
      })
      return { order, stderr, code }
    } finally { process.stderr.write = err; console.log = log }
  }

  test("a tool call: the verb runs first, the check second, and its line reaches stderr", async () => {
    const r = await drive(["get_burn_status"])
    assert.deepStrictEqual(r.order, ["verb", "check"])
    assert.strictEqual(r.code, 0)
    assert.ok(r.stderr.includes("VERSION-CHECK-LINE"), r.stderr)
  })
  test("help, --version and `help <verb>` never run it", async () => {
    for (const argv of [["--help"], ["--version"], ["help", "server"]]) assert.deepStrictEqual((await drive(argv)).order, [], argv.join(" "))
  })
  test("the server verb never runs it", async () => assert.deepStrictEqual((await drive(["server", "status"])).order, ["verb"]))
  test("AGENTLENS_NO_AUTOSETUP=1 and AGENTLENS_NO_REVIVE=1 each switch it off", async () => {
    process.env.AGENTLENS_NO_AUTOSETUP = "1"
    assert.deepStrictEqual((await drive(["get_burn_status"])).order, ["verb"])
    delete process.env.AGENTLENS_NO_AUTOSETUP
    process.env.AGENTLENS_NO_REVIVE = "1"
    assert.deepStrictEqual((await drive(["get_burn_status"])).order, ["verb"])
  })
  test("a launch check that stops the verb (non-null code) means no check", async () => {
    const r = await drive(["get_burn_status"], { launchCheck: async () => 7 })
    assert.deepStrictEqual([r.order, r.code], [[], 7])
  })
  test("a refused tool call (process.exitCode set) is not followed by the check: stderr must stay exactly one JSON object", async () => {
    const r = await drive(["get_burn_status"], { diagnostics: async () => { process.exitCode = 2 } })
    assert.deepStrictEqual(r.order, [])
    assert.ok(!r.stderr.includes("VERSION-CHECK-LINE"), r.stderr)
  })
  test("versionCheckEligible: hook-path, read-only, server, daemon, setup, disable, enable, telemetry, help and get_account_status --all are out; a tool call is in", () => {
    for (const argv of [["hook"], ["gate"], ["statusline"], ["review-gate"], ["server"], ["daemon"], ["setup"], ["disable"], ["enable"], ["telemetry"], ["help"], ["get_account_status", "--all"]]) {
      assert.strictEqual(versionCheckEligible(argv), false, argv.join(" "))
    }
    for (const argv of [["get_burn_status"], ["get_account_status"], []]) assert.strictEqual(versionCheckEligible(argv), true, argv.join(" "))
  })
})
