// The disk monitor sampler (src/cli/diskSample.ts, diskVolumes.ts, diskStore.ts, TRDD-HTARKH87) against real
// volumes and a real DuckDB file in a temp DATA_DIR/HOME. No mocks: statfs and diskutil are the production calls.
//
// What is pinned, in order of how badly each would mislead: (1) volume rows are real numbers or NULL, never a
// fake 0; (2) the walk cursor survives a close and reopen of disk.duckdb, so ~ and ~/Code can finish over many
// runs; (3) the sampler runs with DISABLED armed and never touches that file; (4) trash_b is the latest finished
// trash walk joined onto the volume that holds it.

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { disabledNotice } from "../cli/foreignTelemetry"
import { nextMinuteBoundary, planWalks, recordVolumes, runDiskSample, runDiskSampleCli, runResident, storeOutcomes } from "../cli/diskSample"
import { openReadOnly, openWritable } from "../cli/diskStore"
import { derivePurgeable, parseMount, parsePlistScalars, realMounts, sampleVolumes, usableImportant } from "../cli/diskVolumes"
import { runSegment, startWalk, type WalkState } from "../cli/diskWalk"

const FAR = Date.now() + 3_600_000

function withTempEnv(body: (t: { home: string; data: string }, ctx: Mocha.Context) => Promise<void>): () => Promise<void> {
  return async function (this: Mocha.Context) {
    this.timeout(60_000) // two real samples, each bounded by a 4 s walk budget, plus diskutil calls
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "al-disksample-")))
    const home = path.join(root, "home")
    const data = path.join(root, "data")
    fs.mkdirSync(home)
    fs.mkdirSync(data)
    const saved = { HOME: process.env.HOME, AGENTLENS_DATA_DIR: process.env.AGENTLENS_DATA_DIR, DATA_DIR: process.env.DATA_DIR }
    process.env.HOME = home
    process.env.AGENTLENS_DATA_DIR = data
    delete process.env.DATA_DIR
    try {
      await body({ home, data }, this)
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

async function query(sql: string): Promise<Record<string, unknown>[]> {
  const db = await openReadOnly()
  try { return (await db.con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[] } finally { db.close() }
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const error = console.error
  let err = ""
  console.error = (...a: unknown[]) => { err += `${a.join(" ")}\n` }
  try {
    return { code: await fn(), err }
  } finally {
    console.error = error
  }
}

suite("diskVolumes — parsing", () => {
  test("realMounts keeps writable local data volumes and drops sealed, read-only, network, simulator and plumbing mounts", () => {
    const out = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "devfs on /dev (devfs, local, nobrowse)",
      "/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)",
      "/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)",
      "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
      "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
      "/dev/disk9s1 on /Volumes/My Drive (apfs, local, nodev, nosuid, journaled, noowners)",
      "/dev/disk5s1 on /Library/Developer/CoreSimulator/Volumes/iOS_23A343 (apfs, local, nodev, nosuid, journaled, nobrowse)",
      "/dev/disk33s1 on /System/Volumes/Update/SFR/mnt1 (apfs, local, journaled, nobrowse)",
      "OrbStack:/OrbStack on /Users/x/OrbStack (nfs, nodev, nosuid, noatime, mounted by x)",
    ].join("\n")
    assert.deepStrictEqual(realMounts(parseMount(out)).map(m => m.mount), ["/System/Volumes/VM", "/System/Volumes/Data", "/Volumes/My Drive"])
  })

  test("parsePlistScalars reads flat integer, string and boolean keys, first occurrence wins", () => {
    const xml = "<dict><key>VolumeUUID</key><string>ABC-1</string><key>CapacityInUse</key><integer>42</integer>"
      + "<key>Writable</key><true/><key>CapacityInUse</key><integer>7</integer></dict>"
    const p = parsePlistScalars(xml)
    assert.strictEqual(p.get("VolumeUUID"), "ABC-1")
    assert.strictEqual(p.get("CapacityInUse"), 42)
    assert.strictEqual(p.get("Writable"), true)
  })
})

suite("diskVolumes — the real machine", () => {
  test("sampleVolumes returns real volumes with sane numbers and no duplicate volume", async function (this: Mocha.Context) {
    if (process.platform !== "darwin") this.skip()
    this.timeout(30_000) // five diskutil calls, each allowed 5 s
    const vols = await sampleVolumes()
    assert.ok(vols.length >= 1)
    for (const v of vols) {
      assert.ok(v.totalB !== null && v.totalB > 0, `${v.mount}: total ${v.totalB} (${v.error})`)
      assert.ok(v.freeB !== null && v.freeB <= v.totalB, `${v.mount}: free ${v.freeB} <= total`)
      assert.ok(v.usedB !== null && v.usedB <= v.totalB)
    }
    assert.strictEqual(new Set(vols.map(v => v.mount)).size, vols.length)
    assert.ok(!vols.some(v => v.mount.startsWith("/Library/Developer/CoreSimulator")))
  })
})

suite("diskVolumes — important-usage and derived purgeable", () => {
  test("derivePurgeable is important minus avail, NULL when either side is unknown or the difference is negative", () => {
    assert.strictEqual(derivePurgeable(150, 100), 50)
    assert.strictEqual(derivePurgeable(100, 100), 0)
    assert.strictEqual(derivePurgeable(90, 100), null)
    assert.strictEqual(derivePurgeable(null, 100), null)
    assert.strictEqual(derivePurgeable(150, null), null)
  })

  test("usableImportant turns a 0 beside a positive avail into NULL and leaves every other figure alone", () => {
    assert.strictEqual(usableImportant(0, 1000), null)
    assert.strictEqual(usableImportant(0, 0), 0)
    assert.strictEqual(usableImportant(0, null), 0)
    assert.strictEqual(usableImportant(5, 1000), 5)
    assert.strictEqual(usableImportant(null, 1000), null)
  })

  test("sampleVolumes fills important_avail_b from macOS in one call, and purgeable_b is exactly important minus avail", async function (this: Mocha.Context) {
    if (process.platform !== "darwin") this.skip()
    this.timeout(30_000)
    const vols = await sampleVolumes()
    const withImportant = vols.filter(v => v.importantAvailB !== null)
    assert.ok(withImportant.length >= 1, `no volume got an important-usage figure: ${vols.map(v => `${v.mount}: ${v.error}`).join(" | ")}`)
    for (const v of withImportant) {
      assert.ok((v.importantAvailB ?? 0) > 0, `${v.mount}: important ${v.importantAvailB}`) // a 0 beside a positive avail was turned into NULL + error
      assert.strictEqual(v.purgeableB, derivePurgeable(v.importantAvailB, v.availB))
    }
    for (const v of vols.filter(x => x.importantAvailB === null)) assert.ok(v.purgeableB === null && v.error !== null, `${v.mount}: a missing figure is NULL plus an error, never 0`)
  })
})
suite("diskSample — persistence and the DISABLED exemption", () => {
  test("a walk cut mid-way is stored, resumed from disk.duckdb, and finishes into disk_tree", withTempEnv(async ({ home }) => {
    const tree = path.join(home, "tree")
    for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) {
      fs.mkdirSync(path.join(tree, `d${i}`, `e${j}`), { recursive: true })
      fs.writeFileSync(path.join(tree, `d${i}`, `e${j}`, "f.bin"), Buffer.alloc(100 * (i + 1) + j, 1))
    }
    const outside = path.join(home, "outside") // a symlink target outside the tree: its identity must survive the cursor round-trip
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "o.bin"), Buffer.alloc(900, 1))
    fs.symlinkSync(outside, path.join(tree, "link"))
    await planWalks(Date.now()) // creates and seeds disk.duckdb
    const db = await openWritable()
    try {
      await db.con.run("DELETE FROM disk_watch")
      await db.con.run("INSERT INTO disk_watch VALUES (?, ?)", [tree, "folder"])
    } finally { db.close() }

    const first = (await planWalks(Date.now())).find(p => p.entry.path === tree)
    assert.ok(first && first.resume === null, "a never-walked folder is due, with nothing to resume")
    const cut = startWalk(tree, Date.now()) as WalkState
    assert.strictEqual(runSegment(cut, FAR, 4), false)
    await storeOutcomes([{ plan: first, state: cut, finished: false, partial: false, error: null, tsEndMs: Date.now() }])

    const second = (await planWalks(Date.now())).find(p => p.entry.path === tree)
    assert.ok(second?.resume, "the unfinished walk is due again and carries its cursor")
    assert.deepStrictEqual(second.resume.pending, cut.pending)
    assert.strictEqual(cut.followed.length, 1, "the outside link was taken on in the first segment")
    assert.deepStrictEqual(second.resume.followed, cut.followed, "the followed set round-trips through disk_walk_followed")
    assert.deepStrictEqual(second.resume.totals, cut.totals)
    assert.strictEqual(second.resume.tsStartMs, cut.tsStartMs)

    assert.strictEqual(runSegment(second.resume, FAR), true)
    await storeOutcomes([{ plan: second, state: second.resume, finished: true, partial: false, error: null, tsEndMs: Date.now() }])
    const trees = await query(`SELECT apparent_b, files, partial FROM disk_tree WHERE path = '${tree}'`)
    assert.strictEqual(trees.length, 1)
    assert.strictEqual(Number(trees[0].apparent_b), second.resume.totals.apparent)
    assert.strictEqual(trees[0].partial, false)
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_walk_state"))[0].n), 0)
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_walk_pending"))[0].n), 0)
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_walk_followed"))[0].n), 0, "the dedupe state is cleared when the walk completes")
    assert.ok(!(await planWalks(Date.now())).some(p => p.entry.path === tree), "a just-finished folder is not due for 15 minutes")
  }))

  test("runs with DISABLED armed without touching it, and trash_b joins the latest finished trash walk", withTempEnv(async ({ home, data }, ctx) => {
    if (process.platform !== "darwin") ctx.skip() // the volume probe (mount + diskutil) is macOS only; CI runs Linux
    const flag = path.join(data, "DISABLED")
    fs.writeFileSync(flag, "Reason: test\n")
    const before = fs.statSync(flag).mtimeMs
    assert.notStrictEqual(disabledNotice(["budget"]), null, "precondition: the brake is armed for an ordinary verb")
    assert.strictEqual(disabledNotice(["disk-sample"]), null, "disk-sample is exempt from DISABLED")
    assert.strictEqual(disabledNotice(["disk", "now"]), null, "disk is exempt from DISABLED")
    assert.strictEqual(disabledNotice(["disk-watch", "list"]), null, "disk-watch is exempt from DISABLED")
    assert.strictEqual(disabledNotice(["disk-monitor", "status"]), null, "disk-monitor status is exempt from DISABLED")
    assert.strictEqual(disabledNotice(["disk-monitor", "install"]), null, "disk-monitor install passes the DISABLED gate")
    assert.strictEqual(disabledNotice(["disk-monitor", "uninstall"]), null, "disk-monitor uninstall passes the DISABLED gate")
    fs.mkdirSync(path.join(home, ".Trash"))
    fs.writeFileSync(path.join(home, ".Trash", "junk.bin"), Buffer.alloc(50_000, 1))

    const a = await runDiskSample({ budgetMs: 4000 })
    assert.ok(a.volumes >= 1)
    const b = await runDiskSample({ budgetMs: 4000 })
    assert.ok(b.volumes >= 1)
    assert.strictEqual(fs.statSync(flag).mtimeMs, before, "the sampler must never touch the DISABLED file")

    const latest = await query("SELECT mount, used_b, trash_b, used_minus_trash_b FROM disk_volume WHERE ts = (SELECT max(ts) FROM disk_volume)")
    const withTrash = latest.filter(r => r.trash_b !== null)
    // Other volumes may carry a real, empty .Trashes/<uid> (trash_b 0) — a valid answer; only the volume holding the temp .Trash must show its bytes.
    assert.ok(withTrash.some(r => Number(r.trash_b) >= 50_000), "the volume holding the temp .Trash gets its bytes as trash_b")
    for (const r of withTrash) {
      assert.ok(Number(r.trash_b) >= 0)
      assert.strictEqual(Number(r.used_minus_trash_b), Number(r.used_b) - Number(r.trash_b))
    }
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_volume WHERE ts = (SELECT min(ts) FROM disk_volume) AND trash_b IS NOT NULL"))[0].n), 0, "the first sample had no finished trash walk yet: NULL, not 0")
  }))
})

// ── run modes and the writer lock ──────────────────────────────────────────────────────────────────────

/** A REAL second process holding the READ_WRITE lock on disk.duckdb for `ms` — what the other launchd job looks like to this one. */
async function holdWriterLock(ms: number): Promise<ChildProcess> {
  // The child opens through the product entry point (diskStore.openWritable), not its own DuckDB handle: the data dir comes from the inherited env.
  const child = spawn(process.execPath, ["-e",
    "require(process.argv[1]).openWritable().then(db => { console.log(\"locked\"); setTimeout(() => db.close(), Number(process.argv[2])) })",
    require.resolve("../cli/diskStore"), String(ms)], { stdio: ["ignore", "pipe", "inherit"] })
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", d => { if (String(d).includes("locked")) resolve() })
    child.on("exit", code => reject(new Error(`lock holder exited early (${code})`)))
  })
  return child
}

suite("diskSample — run modes", () => {
  test("--volumes-only writes volume rows and touches no walk table; --walks-only walks and writes no volume row", withTempEnv(async ({ home }, ctx) => {
    if (process.platform !== "darwin") ctx.skip()
    const tree = path.join(home, "tree")
    fs.mkdirSync(path.join(tree, "d"), { recursive: true })
    fs.writeFileSync(path.join(tree, "d", "f.bin"), Buffer.alloc(1000, 1))
    await planWalks(Date.now()) // creates and seeds disk.duckdb
    const db = await openWritable()
    try {
      await db.con.run("DELETE FROM disk_watch")
      await db.con.run("INSERT INTO disk_watch VALUES (?, ?)", [tree, "folder"])
    } finally { db.close() }

    const v = await runDiskSample({ mode: "volumes" })
    assert.ok(v.volumes >= 1)
    assert.deepStrictEqual([v.due, v.finished], [0, 0], "a volumes-only run plans and walks nothing")
    assert.ok(Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n) >= 1)
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_tree"))[0].n), 0)
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_walk_state"))[0].n), 0)

    const volumeRows = Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n)
    const w = await runDiskSample({ mode: "walks", budgetMs: 4000 })
    assert.strictEqual(w.volumes, 0, "a walks-only run probes no volume")
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n), volumeRows, "and adds no volume row")
    assert.strictEqual(Number((await query(`SELECT count(*) AS n FROM disk_tree WHERE path = '${tree}'`))[0].n), 1, "the due folder was walked to the end")
  }))

  test("--volumes-only together with --walks-only is a usage error", async () => {
    await assert.rejects(runDiskSampleCli(["--volumes-only", "--walks-only"]), /mutually exclusive/)
  })
})

suite("diskSample — the resident minute loop", () => {
  const T0 = Date.UTC(2026, 10, 16, 12, 0, 30) // 30 s past a minute boundary
  const at = (m: number): number => Date.UTC(2026, 10, 16, 12, m, 0)

  // A fake clock: sleep advances it by exactly the requested time (plus lateMs), so ticks land where the loop aimed them, with no real waiting.
  function fakeClock(startMs: number, lateMs = 0): { now(): number; sleep(ms: number): Promise<void> } {
    let t = startMs
    return { now: () => t, sleep: async (ms: number) => { t += ms + lateMs } }
  }
  // A watchdog that never fires and an exit that must never be called.
  const calm = { deadline: () => ({ expired: new Promise<void>(() => {}), cancel: () => {} }), exit: (): void => { throw new Error("unexpected exit") } }

  test("nextMinuteBoundary is the first minute boundary strictly after the given time", () => {
    assert.strictEqual(nextMinuteBoundary(T0), at(1))
    assert.strictEqual(nextMinuteBoundary(at(1)), at(2), "exactly on a boundary: the next one")
    assert.strictEqual(nextMinuteBoundary(Date.UTC(2026, 10, 16, 12, 0, 59, 999)), at(1))
  })

  test("the first tick runs immediately at the start time, then one tick per minute boundary, and maxTicks stops the loop", async () => {
    const clock = fakeClock(T0, 3) // every wake is 3 ms late
    const slots: number[] = []
    await runResident({ ...clock, ...calm, tick: async slot => { slots.push(slot) }, log: () => { throw new Error("nothing to log") }, maxTicks: 4 })
    assert.deepStrictEqual(slots, [T0, at(1), at(2), at(3)], "no blind spot after a start: the first sample is at the start time itself")
    assert.ok(slots.slice(1).every(s => s % 60_000 === 0))
  })

  test("a timer that fires 2 ms early is slept out: every boundary tick runs exactly on its boundary, once", async () => {
    let t = T0
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms > 5 ? ms - 2 : ms } } // the long sleep wakes 2 ms early, the short top-up is exact
    const slots: number[] = []
    await runResident({ ...clock, ...calm, tick: async slot => { slots.push(slot); assert.strictEqual(t, slot, "never before the boundary") }, log: () => {}, maxTicks: 3 })
    assert.deepStrictEqual(slots, [T0, at(1), at(2)])
  })

  test("after a clock jump of 5 minutes (system sleep) the loop skips to the next boundary: one gap, no backlog of catch-up ticks", async () => {
    let t = T0
    const slots: number[] = []
    await runResident({
      now: () => t,
      sleep: async ms => { t += ms },
      ...calm,
      tick: async slot => { slots.push(slot); if (slots.length === 1) t += 5 * 60_000 }, // the machine slept through the next 5 minutes during the first tick
      log: () => {},
      maxTicks: 2,
    })
    assert.deepStrictEqual(slots, [T0, at(6)], "12:01-12:05 are skipped, not replayed")
  })

  test("a tick that throws is logged as one line and the next tick still runs", async () => {
    const clock = fakeClock(T0)
    const slots: number[] = []
    const lines: string[] = []
    await runResident({
      ...clock,
      ...calm,
      tick: async slot => { slots.push(slot); if (slots.length === 1) throw new Error("writer lock timeout") },
      log: line => lines.push(line),
      maxTicks: 2,
    })
    assert.strictEqual(slots.length, 2, "the loop survived the failed tick")
    assert.strictEqual(lines.length, 1)
    assert.match(lines[0], /2026-11-16T12:00:30\.000Z failed: writer lock timeout/)
  })

  test("a tick that never settles trips the watchdog: one stderr line, exit code 1, and no further tick", async () => {
    const clock = fakeClock(T0)
    const lines: string[] = []
    const exits: number[] = []
    let ticks = 0
    await runResident({
      ...clock,
      tick: () => { ticks++; return new Promise<void>(() => {}) }, // never resolves
      log: line => lines.push(line),
      deadline: () => ({ expired: Promise.resolve(), cancel: () => {} }), // the deadline has already passed
      exit: code => { exits.push(code) },
    })
    assert.strictEqual(ticks, 1)
    assert.deepStrictEqual(exits, [1])
    assert.strictEqual(lines.length, 1)
    assert.match(lines[0], /still running after \d+ ms; exiting so launchd restarts the sampler/)
  })

  test("--resident without --volumes-only is a usage error", async () => {
    await assert.rejects(runDiskSampleCli(["--resident"]), /--resident is only valid with --volumes-only/)
    await assert.rejects(runDiskSampleCli(["--walks-only", "--resident"]), /--resident is only valid with --volumes-only/)
  })
})

suite("diskSample — the writer lock between minutes", () => {
  // DiskDb.close() closes the connection AND the DuckDB instance (diskStore.ts:65), so nothing is held after recordVolumes returns.
  test("after recordVolumes ran twice in this process, a separate child process opens the same disk.duckdb read-write at once", withTempEnv(async (_env, ctx) => {
    if (process.platform !== "darwin") ctx.skip()
    const volumes = await sampleVolumes()
    await recordVolumes(volumes, Date.now())
    await recordVolumes(volumes, Date.now() + 60_000)
    const t0 = Date.now()
    const child = spawnSync(process.execPath, ["-e",
      "require(process.argv[1]).openWritable().then(db => { db.close(); console.log(\"opened\") })",
      require.resolve("../cli/diskStore")], { encoding: "utf8", timeout: 20_000 }) // inherits AGENTLENS_DATA_DIR from withTempEnv
    assert.strictEqual(child.status, 0, child.stderr)
    assert.strictEqual(child.stdout.trim(), "opened")
    assert.ok(Date.now() - t0 < 4000, "the child did not wait out the 5 s lock retry")
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n), 2 * volumes.length)
  }))
})

suite("diskSample — the other job holds the writer lock", () => {
  test("a lock held for 1.5 s is waited out: the volume row still lands", withTempEnv(async ({ data }, ctx) => {
    if (process.platform !== "darwin") ctx.skip()
    await planWalks(Date.now()) // creates the file and schema
    const volumes = await sampleVolumes()
    const holder = await holdWriterLock(1500)
    try {
      const t0 = Date.now()
      await recordVolumes(volumes, Date.now())
      assert.ok(Date.now() - t0 >= 800, "the insert had to wait for the other process")
    } finally { holder.kill("SIGKILL") }
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n), volumes.length)
    assert.ok(fs.existsSync(data))
  }))

  test("a lock held past the 5 s wait fails the run: exit code 1 and a line on stderr (the launchd log), never a silent drop", withTempEnv(async (_env, ctx) => {
    if (process.platform !== "darwin") ctx.skip()
    ctx.timeout(60_000)
    await planWalks(Date.now())
    const holder = await holdWriterLock(20_000)
    try {
      const r = await capture(() => runDiskSampleCli(["--volumes-only", "--quiet"]))
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /disk-sample failed: .*lock/i)
    } finally { holder.kill("SIGKILL") }
    assert.strictEqual(Number((await query("SELECT count(*) AS n FROM disk_volume"))[0].n), 0, "no half-written row")
  }))
})
