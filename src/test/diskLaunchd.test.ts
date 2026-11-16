// The launchd plist of the disk monitor (src/cli/diskLaunchd.ts, TRDD-HTARKH87). Written to a temp LaunchAgents dir and
// validated by macOS's own `plutil -lint`; nothing is ever loaded into the real launchd here.

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFileSync } from "child_process"
import { DISK_LABEL, diskMonitorInstall, diskMonitorUninstall, diskPlist } from "../cli/diskLaunchd"

suite("disk-monitor launchd job", () => {
  test("the plist runs disk-sample --quiet every 60 s with the data dir pinned, and escapes XML", () => {
    const xml = diskPlist({ node: "/usr/local/bin/node", cli: "/opt/a&b/cli.js", dataDir: "/data/<x>" })
    assert.match(xml, new RegExp(`<string>${DISK_LABEL}</string>`))
    assert.match(xml, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/)
    assert.match(xml, /<string>disk-sample<\/string>\s*<string>--quiet<\/string>/)
    assert.match(xml, /<key>AGENTLENS_DATA_DIR<\/key>\s*<string>\/data\/&lt;x&gt;<\/string>/)
    assert.ok(xml.includes("/opt/a&amp;b/cli.js"))
    assert.ok(!xml.includes("KeepAlive"), "no KeepAlive: a failing sampler must not respawn in a tight loop")
  })

  test("install (load: false) writes a plist plutil accepts, uninstall removes it", function (this: Mocha.Context) {
    if (process.platform !== "darwin") this.skip()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-disklaunchd-"))
    const savedData = process.env.AGENTLENS_DATA_DIR
    process.env.AGENTLENS_DATA_DIR = path.join(dir, "data")
    try {
      const { path: file, loaded } = diskMonitorInstall({ launchAgentsDir: dir, load: false })
      assert.strictEqual(loaded, false)
      assert.strictEqual(path.basename(file), `${DISK_LABEL}.plist`)
      execFileSync("/usr/bin/plutil", ["-lint", file], { stdio: "pipe" })
      assert.ok(fs.existsSync(path.join(dir, "data", "logs")), "the log directory launchd writes into exists")
      assert.strictEqual(diskMonitorUninstall({ launchAgentsDir: dir, load: false }).removed, true)
      assert.ok(!fs.existsSync(file))
    } finally {
      if (savedData === undefined) delete process.env.AGENTLENS_DATA_DIR; else process.env.AGENTLENS_DATA_DIR = savedData
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
