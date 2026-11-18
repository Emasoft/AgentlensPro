// TRDD-YL3EWT6N item 8a: the status line commands carry a version stamp (`agentlenspro statusline [--subagent] --stamp V [--inner Q]`), one parser
// (parseOurStatusline), one writer (statuslineCommand) and one verdict (statuslineVerdict) per settings key. Real files in a scratch dir under
// os.tmpdir(), the real safeConfigEdit engine; the argv test runs the written command through a real sh word split.
import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import {
  STATUSLINE_CMD, STATUSLINE_SURFACES, SUBAGENT_STATUSLINE_CMD, installStatusline, isOurStatuslineCommand, parseOurStatusline,
  planStatuslineSurface, statuslineCommand, statuslineVerdict, unwrapStatuslineCommand,
} from "../cli/hookInstall"
import { parseStatuslineArgs } from "../cli/statuslineCapture"
import { packageVersion } from "../packageVersion"

const RUN = packageVersion()
// Derived from the running version, never literals: the running version moves with every release.
const NEWER = `${Number(RUN.split(".")[0]) + 1}.0.0`
const OLDER = "0.0.1"
// One literal single quote, built from its char code so the quoting in the expected strings below is spelled out by hand
// and the writer is never compared against itself.
const Q = String.fromCharCode(39)
const MAIN = STATUSLINE_SURFACES[0]
const QUOTED_INNER = "/opt/my dir/py3 " + Q + "/Users/me/x y.py" + Q + " --flag"

interface Fx { dir: string; settingsPath: string; pathEnv: string; cleanup: () => void }

function makeFx(): Fx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-stamp-"))
  const binDir = path.join(dir, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, "agentlenspro"), "#!/bin/sh\nexit 0\n")
  fs.chmodSync(path.join(binDir, "agentlenspro"), 0o755)
  return { dir, settingsPath: path.join(dir, "settings.json"), pathEnv: binDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const writeSettings = (f: Fx, obj: unknown): void => fs.writeFileSync(f.settingsPath, JSON.stringify(obj, null, 2))
const readSettings = (f: Fx): Record<string, { command?: string; type?: string; padding?: number }> =>
  JSON.parse(fs.readFileSync(f.settingsPath, "utf8")) as Record<string, { command?: string; type?: string; padding?: number }>

suite("statusline stamp (item 8a): the writer pins the exact stamped strings", () => {
  test("statuslineCommand writes base, stamp, then --inner with the quoted inner", () => {
    assert.strictEqual(statuslineCommand(STATUSLINE_CMD, "2.40.0", ""), "agentlenspro statusline --stamp 2.40.0")
    assert.strictEqual(statuslineCommand(SUBAGENT_STATUSLINE_CMD, "2.40.0", ""), "agentlenspro statusline --subagent --stamp 2.40.0")
    assert.strictEqual(statuslineCommand(STATUSLINE_CMD, "2.40.0", "x.sh"), "agentlenspro statusline --stamp 2.40.0 --inner " + Q + "x.sh" + Q)
    assert.strictEqual(
      statuslineCommand(SUBAGENT_STATUSLINE_CMD, "2.40.0-rc.1", "it" + Q + "s.sh"),
      "agentlenspro statusline --subagent --stamp 2.40.0-rc.1 --inner " + Q + "it" + Q + "\\" + Q + Q + "s.sh" + Q,
    )
  })

  test("install creates both keys capture-only in the stamped form", async () => {
    const f = makeFx()
    try {
      await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      const s = readSettings(f)
      assert.strictEqual(s.statusLine.command, "agentlenspro statusline --stamp " + RUN)
      assert.strictEqual(s.subagentStatusLine.command, "agentlenspro statusline --subagent --stamp " + RUN)
      assert.strictEqual(s.statusLine.type, "command")
      assert.strictEqual(s.subagentStatusLine.type, "command")
    } finally { f.cleanup() }
  })

  test("install wraps a foreign status line in the stamped form and unwrap returns it byte-identical", async () => {
    const f = makeFx()
    try {
      writeSettings(f, { statusLine: { type: "command", command: QUOTED_INNER, padding: 2 } })
      await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      const s = readSettings(f)
      const quoted = Q + "/opt/my dir/py3 " + Q + "\\" + Q + Q + "/Users/me/x y.py" + Q + "\\" + Q + Q + " --flag" + Q
      assert.strictEqual(s.statusLine.command, "agentlenspro statusline --stamp " + RUN + " --inner " + quoted)
      assert.strictEqual(unwrapStatuslineCommand(s.statusLine.command as string), QUOTED_INNER)
      assert.strictEqual(s.statusLine.padding, 2, "siblings of command survive")
    } finally { f.cleanup() }
  })
})

suite("statusline stamp (item 8a): one parser for every old and new form", () => {
  test("parseOurStatusline: bare, --subagent, --inner, --subagent --inner, each with and without --stamp", () => {
    for (const subagent of [false, true]) {
      for (const stamp of [null, "2.40.0", "2.40.0-rc.1"]) {
        for (const inner of ["", "a b.sh", "it" + Q + "s " + Q + "x" + Q]) {
          let cmd = "agentlenspro statusline" + (subagent ? " --subagent" : "") + (stamp ? " --stamp " + stamp : "")
          if (inner) cmd += " --inner " + Q + inner.split(Q).join(Q + "\\" + Q + Q) + Q
          assert.deepStrictEqual(parseOurStatusline(cmd), { subagent, stamp, inner }, cmd)
        }
      }
    }
  })

  test("a malformed stamp counts as unstamped and the inner text is still recovered", () => {
    assert.deepStrictEqual(parseOurStatusline("agentlenspro statusline --stamp latest --inner " + Q + "x.sh" + Q), { subagent: false, stamp: null, inner: "x.sh" })
    assert.deepStrictEqual(parseOurStatusline("agentlenspro statusline --subagent --stamp 2.40"), { subagent: true, stamp: null, inner: "" })
  })

  test("parseOurStatusline rejects what it cannot read: null, never a guess", () => {
    const bad = [
      "agentlenspro statusline --inner " + Q + "a" + Q + " trailing",
      "agentlenspro statusline --inner " + Q + "a" + Q + " --stamp 2.40.0",
      "agentlenspro statusline --inner a",
      "agentlenspro statusline --inner " + Q + "unterminated",
      "agentlenspro statusline --unknown-flag",
      "agentlenspro statusline --stamp",
      "agentlenspro statusline --stamp  2.40.0",
      "agentlenspro statusline --stamp 2.40.0 extra",
      "agentlenspro statusline --stamp --inner " + Q + "a" + Q,
      "/usr/bin/foo.sh",
    ]
    for (const cmd of bad) assert.strictEqual(parseOurStatusline(cmd), null, cmd)
    assert.strictEqual(parseOurStatusline(42), null, "never throws on a non-string")
    assert.strictEqual(parseOurStatusline(null), null)
  })

  test("leading and trailing whitespace are accepted, as before", () => {
    assert.deepStrictEqual(parseOurStatusline("  agentlenspro statusline"), { subagent: false, stamp: null, inner: "" })
    assert.deepStrictEqual(parseOurStatusline("agentlenspro statusline --inner " + Q + "x y" + Q + "  \n"), { subagent: false, stamp: null, inner: "x y" })
    assert.deepStrictEqual(parseOurStatusline("agentlenspro statusline\n"), { subagent: false, stamp: null, inner: "" }, "a capture-only wrapper followed only by a newline stays ours")
    assert.strictEqual(isOurStatuslineCommand("agentlenspro statusline\t"), true)
  })

  test("statusline-history and a longer word are not ours (token boundary)", () => {
    for (const cmd of ["agentlenspro statusline-history x", "agentlenspro statuslineX", "agentlenspro statusline-history"]) {
      assert.strictEqual(isOurStatuslineCommand(cmd), false, cmd)
      assert.strictEqual(parseOurStatusline(cmd), null, cmd)
      assert.strictEqual(unwrapStatuslineCommand(cmd), null, cmd)
      assert.strictEqual(statuslineVerdict(cmd, RUN).kind, "foreign", cmd)
    }
    assert.strictEqual(isOurStatuslineCommand("agentlenspro statusline"), true)
    assert.strictEqual(isOurStatuslineCommand("agentlenspro statusline --subagent"), true)
  })

  test("unwrap keeps its contract: empty for capture-only (stamped or not), the inner text, null for foreign or unparseable", () => {
    assert.strictEqual(unwrapStatuslineCommand(STATUSLINE_CMD), "")
    assert.strictEqual(unwrapStatuslineCommand(SUBAGENT_STATUSLINE_CMD), "")
    assert.strictEqual(unwrapStatuslineCommand("agentlenspro statusline --stamp 2.40.0"), "")
    assert.strictEqual(unwrapStatuslineCommand("agentlenspro statusline --stamp 2.40.0 --inner " + Q + "x y" + Q), "x y")
    assert.strictEqual(unwrapStatuslineCommand("/usr/bin/foo.sh"), null)
    assert.strictEqual(unwrapStatuslineCommand("agentlenspro statusline --inner " + Q + "unterminated"), null)
  })
})

suite("statusline stamp (item 8a): the verdict per key", () => {
  test("absent, foreign, unparseable, current, older (older stamp or none), newer", () => {
    assert.strictEqual(statuslineVerdict(null, RUN).kind, "absent")
    assert.strictEqual(statuslineVerdict("", RUN).kind, "absent")
    assert.strictEqual(statuslineVerdict("/usr/bin/foo.sh", RUN).kind, "foreign")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline --inner " + Q + "unterminated", RUN).kind, "unparseable")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline --stamp " + RUN, RUN).kind, "current")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline --stamp " + OLDER, RUN).kind, "older")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline", RUN).kind, "older", "no stamp is older")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline --stamp bogus", RUN).kind, "older", "a malformed stamp is no stamp")
    assert.strictEqual(statuslineVerdict("agentlenspro statusline --stamp " + NEWER, RUN).kind, "newer")
  })
})

suite("statusline stamp (item 8a): explicit install (the verb)", () => {
  test("an unstamped entry of ours whose inner holds single quotes is rewritten stamped, inner byte-identical", async () => {
    const f = makeFx()
    try {
      const old = "agentlenspro statusline --inner " + Q + "/opt/my dir/py3 " + Q + "\\" + Q + Q + "/Users/me/x y.py" + Q + "\\" + Q + Q + " --flag" + Q
      assert.strictEqual(unwrapStatuslineCommand(old), QUOTED_INNER, "fixture sanity: the old form parses to the original")
      writeSettings(f, { statusLine: { type: "command", command: old, padding: 2 }, subagentStatusLine: { type: "command", command: SUBAGENT_STATUSLINE_CMD } })
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      assert.ok(r.changed)
      const s = readSettings(f)
      assert.strictEqual(parseOurStatusline(s.statusLine.command)?.stamp, RUN)
      assert.strictEqual(unwrapStatuslineCommand(s.statusLine.command as string), QUOTED_INNER)
      assert.strictEqual(s.subagentStatusLine.command, "agentlenspro statusline --subagent --stamp " + RUN)
      assert.strictEqual(s.statusLine.padding, 2)
    } finally { f.cleanup() }
  })

  test("current is unchanged: nothing written", async () => {
    const f = makeFx()
    try {
      await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      const before = fs.readFileSync(f.settingsPath, "utf8")
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      assert.strictEqual(r.changed, false)
      assert.deepStrictEqual(r.surfaces.map(x => x.action), ["unchanged", "unchanged"])
      assert.strictEqual(fs.readFileSync(f.settingsPath, "utf8"), before)
    } finally { f.cleanup() }
  })

  test("an older stamp is refreshed and a NEWER stamp is overwritten by the explicit verb, inner kept, the replaced stamp logged", async () => {
    const f = makeFx()
    try {
      writeSettings(f, {
        statusLine: { type: "command", command: statuslineCommand(STATUSLINE_CMD, OLDER, "keep me.sh") },
        subagentStatusLine: { type: "command", command: statuslineCommand(SUBAGENT_STATUSLINE_CMD, NEWER, "") },
      })
      const lines: string[] = []
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => lines.push(l) })
      assert.ok(r.changed)
      const s = readSettings(f)
      assert.strictEqual(s.statusLine.command, "agentlenspro statusline --stamp " + RUN + " --inner " + Q + "keep me.sh" + Q)
      assert.strictEqual(s.subagentStatusLine.command, "agentlenspro statusline --subagent --stamp " + RUN)
      assert.ok(lines.some(l => l.includes(NEWER) && l.includes("subagentStatusLine")), "the log names the newer stamp it replaced: " + lines.join(" | "))
    } finally { f.cleanup() }
  })

  test("an unparseable entry is refused naming its key, and the OTHER key is not written either (one transaction)", async () => {
    const f = makeFx()
    try {
      writeSettings(f, {
        statusLine: { type: "command", command: statuslineCommand(STATUSLINE_CMD, OLDER, "x.sh") },
        subagentStatusLine: { type: "command", command: "agentlenspro statusline --inner " + Q + "unterminated" },
      })
      const before = fs.readFileSync(f.settingsPath, "utf8")
      await assert.rejects(() => installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} }), /subagentStatusLine/)
      assert.strictEqual(fs.readFileSync(f.settingsPath, "utf8"), before, "nothing written")
    } finally { f.cleanup() }
  })

  test("uninstall restores the original from a stamped wrapper and removes a stamped capture-only key", async () => {
    const f = makeFx()
    try {
      writeSettings(f, { statusLine: { type: "command", command: QUOTED_INNER, padding: 2 } })
      await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {} })
      await installStatusline(true, { settingsPath: f.settingsPath, log: () => {} })
      const s = readSettings(f)
      assert.deepStrictEqual(s.statusLine, { type: "command", command: QUOTED_INNER, padding: 2 })
      assert.strictEqual(s.subagentStatusLine, undefined)
    } finally { f.cleanup() }
  })
})

suite("statusline stamp (item 8a): repairOnly (the launch repair of 8b)", () => {
  test("plan: absent is not created, foreign is not wrapped, newer is kept, unparseable is skipped, older is refreshed", () => {
    const p = (cur: string | null) => planStatuslineSurface(MAIN, cur, false, "/s.json", RUN, true)
    assert.deepStrictEqual(p(null).ops, [])
    assert.strictEqual(p(null).result.action, "absent")
    assert.deepStrictEqual(p("/usr/bin/foo.sh").ops, [])
    assert.strictEqual(p("/usr/bin/foo.sh").result.action, "absent")
    const newer = statuslineCommand(STATUSLINE_CMD, NEWER, "x.sh")
    assert.deepStrictEqual(p(newer).ops, [])
    assert.strictEqual(p(newer).result.action, "kept-newer")
    assert.strictEqual(p(newer).result.stamp, NEWER)
    const bad = "agentlenspro statusline --inner " + Q + "unterminated"
    assert.deepStrictEqual(p(bad).ops, [])
    assert.strictEqual(p(bad).result.action, "skipped")
    const older = p("agentlenspro statusline --inner " + Q + "x.sh" + Q)
    assert.strictEqual(older.result.action, "refreshed")
    assert.deepStrictEqual(older.ops, [{ op: "set", path: ["statusLine", "command"], value: "agentlenspro statusline --stamp " + RUN + " --inner " + Q + "x.sh" + Q }])
  })

  test("install with repairOnly on an empty settings file writes nothing and creates no key", async () => {
    const f = makeFx()
    try {
      writeSettings(f, { other: 1 })
      const before = fs.readFileSync(f.settingsPath, "utf8")
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: () => {}, repairOnly: true })
      assert.strictEqual(r.changed, false)
      assert.strictEqual(fs.readFileSync(f.settingsPath, "utf8"), before)
    } finally { f.cleanup() }
  })

  test("install with repairOnly skips an unparseable key with one warning and still refreshes the other", async () => {
    const f = makeFx()
    try {
      writeSettings(f, {
        statusLine: { type: "command", command: "agentlenspro statusline --inner " + Q + "unterminated" },
        subagentStatusLine: { type: "command", command: SUBAGENT_STATUSLINE_CMD },
      })
      const lines: string[] = []
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => lines.push(l), repairOnly: true })
      assert.ok(r.changed)
      const s = readSettings(f)
      assert.strictEqual(s.statusLine.command, "agentlenspro statusline --inner " + Q + "unterminated", "the unparseable key is untouched")
      assert.strictEqual(s.subagentStatusLine.command, "agentlenspro statusline --subagent --stamp " + RUN)
      assert.strictEqual(lines.filter(l => l.startsWith("statusLine:") && /not parseable|skipped/.test(l)).length, 1, lines.join(" | "))
    } finally { f.cleanup() }
  })

  test("install with repairOnly keeps a newer stamp, writes nothing, and logs one notice", async () => {
    const f = makeFx()
    try {
      writeSettings(f, { statusLine: { type: "command", command: statuslineCommand(STATUSLINE_CMD, NEWER, "x.sh") } })
      const before = fs.readFileSync(f.settingsPath, "utf8")
      const lines: string[] = []
      const r = await installStatusline(false, { settingsPath: f.settingsPath, pathEnv: f.pathEnv, log: l => lines.push(l), repairOnly: true })
      assert.strictEqual(r.changed, false)
      assert.strictEqual(r.surfaces[0].action, "kept-newer")
      assert.strictEqual(fs.readFileSync(f.settingsPath, "utf8"), before)
      assert.strictEqual(lines.filter(l => l.includes(NEWER)).length, 1, lines.join(" | "))
    } finally { f.cleanup() }
  })
})

suite("statusline stamp (item 8a): the wrapper reads a stamped command the way the settings string says", () => {
  test("parseStatuslineArgs on the real sh word split of a stamped wrapped command gives the same inner text and subagent flag", () => {
    for (const subagent of [false, true]) {
      const cmd = statuslineCommand(subagent ? SUBAGENT_STATUSLINE_CMD : STATUSLINE_CMD, RUN, QUOTED_INNER)
      // `agentlenspro` is a shell function that prints each received argument NUL-terminated, so the written string is tokenized by a real sh.
      const script = "agentlenspro() { for a in \"$@\"; do printf \"%s\\0\" \"$a\"; done; }; " + cmd
      const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" })
      assert.strictEqual(r.status, 0, r.stderr)
      const argv = r.stdout.split("\0").slice(0, -1)
      assert.deepStrictEqual(argv.slice(0, subagent ? 4 : 3), subagent ? ["statusline", "--subagent", "--stamp", RUN] : ["statusline", "--stamp", RUN])
      assert.deepStrictEqual(parseStatuslineArgs(argv.slice(1)), { inner: QUOTED_INNER, subagent })
    }
  })
})
