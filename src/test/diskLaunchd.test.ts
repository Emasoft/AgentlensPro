// The launchd plist of the disk monitor (src/cli/diskLaunchd.ts, TRDD-HTARKH87). Written to a temp LaunchAgents dir and
// validated by macOS's own `plutil -lint`; nothing is ever loaded into the real launchd here.

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { DISK_JOBS, DISK_LABEL, DISK_WALK_LABEL, diskMonitorInstall, diskMonitorUninstall, diskPlist } from "../cli/diskLaunchd"

suite("disk-monitor launchd jobs", () => {
  test("the minute job is a resident KeepAlive sampler (--volumes-only --resident, throttled to one restart a minute) and the walk job --walks-only every 300 s, with the data dir pinned, XML escaped, own logs", () => {
    const [vol, walk] = DISK_JOBS
    const xml = diskPlist({ node: "/usr/local/bin/node", cli: "/opt/a&b/cli.js", dataDir: "/data/<x>", job: vol })
    assert.strictEqual(vol.label, DISK_LABEL)
    assert.match(xml, new RegExp(`<string>${DISK_LABEL}</string>`))
    assert.ok(!xml.includes("StartInterval"), "a resident job has no StartInterval")
    assert.match(xml, /<string>disk-sample<\/string>\s*<string>--volumes-only<\/string>\s*<string>--resident<\/string>\s*<string>--quiet<\/string>/)
    assert.match(xml, /<key>AGENTLENS_DATA_DIR<\/key>\s*<string>\/data\/&lt;x&gt;<\/string>/)
    assert.ok(xml.includes("/opt/a&amp;b/cli.js"))
    assert.ok(xml.includes("/data/&lt;x&gt;/logs/disk-sample.log"))
    assert.match(xml, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/)
    assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/)
    assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/, "a crashing sampler restarts at most once a minute")
    assert.ok(!xml.includes("<key>Nice</key>"), "the minute sampler runs at default priority")
    assert.ok(!xml.includes("LowPriorityIO"), "the minute sampler runs at default priority")
    const w = diskPlist({ node: "/n", cli: "/c.js", dataDir: "/d", job: walk })
    assert.strictEqual(walk.label, DISK_WALK_LABEL)
    assert.match(w, new RegExp(`<string>${DISK_WALK_LABEL}</string>`))
    assert.match(w, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
    assert.match(w, /<string>disk-sample<\/string>\s*<string>--walks-only<\/string>\s*<string>--quiet<\/string>/)
    assert.ok(w.includes("/d/logs/disk-walk.log"))
    assert.match(w, /<key>ProcessType<\/key>\s*<string>Background<\/string>/)
    assert.match(w, /<key>Nice<\/key>\s*<integer>10<\/integer>/)
    assert.match(w, /<key>LowPriorityIO<\/key>\s*<true\/>/)
    assert.ok(!w.includes("KeepAlive"), "the walk job is interval-driven, never kept alive")
  })

  test("install (load: false) writes both plists plutil accepts, twice in a row replaces them, uninstall removes both", function (this: Mocha.Context) {
    if (process.platform !== "darwin") this.skip()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-disklaunchd-"))
    const savedData = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = path.join(dir, "data")
    try {
      diskMonitorInstall({ launchAgentsDir: dir, load: false })
      const { jobs } = diskMonitorInstall({ launchAgentsDir: dir, load: false }) // idempotent: a re-install replaces
      assert.deepStrictEqual(jobs.map(j => j.loaded), [false, false])
      assert.deepStrictEqual(jobs.map(j => path.basename(j.path)), [`${DISK_LABEL}.plist`, `${DISK_WALK_LABEL}.plist`])
      for (const j of jobs) execFileSync("/usr/bin/plutil", ["-lint", j.path], { stdio: "pipe" })
      assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith(".plist")).sort(), [`${DISK_WALK_LABEL}.plist`, `${DISK_LABEL}.plist`].sort())
      assert.ok(fs.existsSync(path.join(dir, "data", "logs")), "the log directory launchd writes into exists")
      assert.deepStrictEqual(diskMonitorUninstall({ launchAgentsDir: dir, load: false }).jobs.map(j => j.removed), [true, true])
      assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith(".plist")), [])
    } finally {
      if (savedData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = savedData
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a failed bootstrap of the second job boots out the first and rethrows: no half-installed state (injected launchctl, real launchd untouched)", function (this: Mocha.Context) {
    if (process.platform !== "darwin") this.skip()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-disklaunchd-"))
    const savedData = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = path.join(dir, "data")
    const calls: string[] = []
    const launchctl = (args: string[]): string => {
      calls.push(args.join(" "))
      if (args[0] === "bootstrap" && args[2].endsWith(`${DISK_WALK_LABEL}.plist`)) throw new Error("bootstrap refused")
      return ""
    }
    try {
      assert.throws(() => diskMonitorInstall({ launchAgentsDir: dir, launchctl }), /bootstrap refused/)
      const boots = calls.filter(c => c.startsWith("bootstrap")).map(c => path.basename(c.split(" ")[2]))
      assert.deepStrictEqual(boots, [`${DISK_LABEL}.plist`, `${DISK_WALK_LABEL}.plist`])
      assert.ok(calls.some(c => c.startsWith("bootout") && c.endsWith(`/${DISK_LABEL}`)), "the first job was unloaded again")
      assert.strictEqual(calls[calls.length - 1].endsWith(`/${DISK_LABEL}`), true, "the rollback is the last launchctl call")
    } finally {
      if (savedData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = savedData
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
