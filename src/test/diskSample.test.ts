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
import { disabledNotice } from "../cli/foreignTelemetry"
import { recordVolumesAndPlan, runDiskSample, storeOutcomes } from "../cli/diskSample"
import { openReadOnly, openWritable } from "../cli/diskStore"
import { parseMount, parsePlistScalars, realMounts, sampleVolumes } from "../cli/diskVolumes"
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
    await recordVolumesAndPlan([], Date.now()) // creates and seeds disk.duckdb
    const db = await openWritable()
    try {
      await db.con.run("DELETE FROM disk_watch")
      await db.con.run("INSERT INTO disk_watch VALUES (?, ?)", [tree, "folder"])
    } finally { db.close() }

    const first = (await recordVolumesAndPlan([], Date.now())).find(p => p.entry.path === tree)
    assert.ok(first && first.resume === null, "a never-walked folder is due, with nothing to resume")
    const cut = startWalk(tree, Date.now()) as WalkState
    assert.strictEqual(runSegment(cut, FAR, 4), false)
    await storeOutcomes([{ plan: first, state: cut, finished: false, partial: false, error: null, tsEndMs: Date.now() }])

    const second = (await recordVolumesAndPlan([], Date.now())).find(p => p.entry.path === tree)
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
    assert.ok(!(await recordVolumesAndPlan([], Date.now())).some(p => p.entry.path === tree), "a just-finished folder is not due for 15 minutes")
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
