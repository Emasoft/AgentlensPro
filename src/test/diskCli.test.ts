// `agentlenspro disk` and `disk-watch` (src/cli/diskCli.ts, TRDD-HTARKH87) over a real disk.duckdb in a temp DATA_DIR.
//
// What is pinned: the minute-delta views report the exact sample and size of each change (and the gap since the
// previous sample, so a missed minute is visible); `disk sql` can never write — a plain DELETE, a stacked
// statement, a WITH-wrapped DELETE and a file read are all refused and the table is unchanged; a missing
// database is its own exit code, not an empty table.

import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { assertSingleSelect, formatInterval, parseEvery, parseSince, parseSize, renderTable, runDiskCli, runDiskWatchCli } from "../cli/diskCli"
import { EXIT, UsageError } from "../cli/cliErrors"
import { insertRows, openWritable } from "../cli/diskStore"
import { disabledNotice } from "../cli/foreignTelemetry"

const T0 = Date.parse("2026-11-16T10:00:00.000Z")
const GIB = 1024 ** 3

type Row = Record<string, unknown>

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const log = console.log
  const error = console.error
  let out = ""
  let err = ""
  console.log = (...a: unknown[]) => { out += `${a.join(" ")}\n` }
  console.error = (...a: unknown[]) => { err += `${a.join(" ")}\n` }
  try {
    return { code: await fn(), out, err }
  } finally {
    console.log = log
    console.error = error
  }
}

async function json(argv: string[]): Promise<Row[]> {
  const r = await capture(() => runDiskCli([...argv, "--json"]))
  assert.strictEqual(r.code, EXIT.OK, r.err)
  return JSON.parse(r.out) as Row[]
}

function withDb(body: (dir: string) => Promise<void>, seed = true): () => Promise<void> {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-diskcli-"))
    const saved = { AGENTLENS_DATA_DIR: process.env.AGENTLENS_DATA_DIR, DATA_DIR: process.env.DATA_DIR }
    process.env.AGENTLENS_DATA_DIR = dir
    delete process.env.DATA_DIR
    try {
      if (seed) {
        const db = await openWritable()
        try {
          // Volume A: 5 samples a minute apart — flat, +5 GiB jump, flat, -1 GiB drop. Volume B: flat.
          const used = [100, 100, 100 + 5 * GIB, 100 + 5 * GIB, 100 + 4 * GIB]
          const rows = used.flatMap((u, i) => [
            [new Date(T0 + i * 60_000), "/Volumes/A", "/dev/disk9s1", "apfs", "disk9", "UUID-A", 10 * GIB * 1000, u, 10 * GIB * 1000 - u, 10 * GIB * 1000 - u, u, null, null, null, 2 * GIB, u - 2 * GIB, null],
            [new Date(T0 + i * 60_000), "/Volumes/B", "/dev/disk7s1", "apfs", "disk7", "UUID-B", 4 * GIB, GIB, 3 * GIB, 3 * GIB, GIB, null, null, null, null, null, null],
          ])
          await insertRows(db.con, "disk_volume", [
            ["ts", "TIMESTAMPTZ"], ["mount", "TEXT"], ["device", "TEXT"], ["fs_type", "TEXT"], ["container", "TEXT"], ["volume_uuid", "TEXT"],
            ["total_b", "BIGINT"], ["used_b", "BIGINT"], ["free_b", "BIGINT"], ["avail_b", "BIGINT"], ["vol_used_b", "BIGINT"], ["container_free_b", "BIGINT"],
            ["purgeable_b", "BIGINT"], ["important_avail_b", "BIGINT"], ["trash_b", "BIGINT"], ["used_minus_trash_b", "BIGINT"], ["error", "TEXT"],
          ], rows)
          await insertRows(db.con, "disk_tree", [
            ["ts_start", "TIMESTAMPTZ"], ["ts_end", "TIMESTAMPTZ"], ["path", "TEXT"], ["kind", "TEXT"], ["apparent_b", "BIGINT"], ["allocated_b", "BIGINT"],
            ["apparent_follow_b", "BIGINT"], ["allocated_follow_b", "BIGINT"], ["files", "BIGINT"], ["partial", "BOOLEAN"], ["elapsed_ms", "BIGINT"], ["error", "TEXT"],
          ], [[new Date(T0), new Date(T0 + 1000), "/some/folder", "folder", 10, 20, 30, 40, 2, false, 5, null]])
        } finally { db.close() }
      }
      await body(dir)
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const LONG_AGO = "3650d"

suite("disk CLI — parsing", () => {
  test("size, duration and bucket flags parse, and a bad value is a usage error", () => {
    assert.strictEqual(parseSize("1M"), 1024 ** 2)
    assert.strictEqual(parseSize("2.5G"), 2.5 * GIB)
    assert.strictEqual(parseSize("512"), 512)
    assert.strictEqual(parseEvery("15m"), "15 minute")
    assert.strictEqual(parseSince("6h", T0).getTime(), T0 - 6 * 3_600_000)
    assert.throws(() => parseSize("lots"), UsageError)
    assert.throws(() => parseEvery("1; drop table x"), UsageError)
    assert.throws(() => parseSince("yesterday-ish"), UsageError)
  })

  test("assertSingleSelect accepts a SELECT or WITH and refuses everything else", () => {
    assert.strictEqual(assertSingleSelect("  select 1 ; "), "select 1")
    assert.strictEqual(assertSingleSelect("select 'a;b' as x"), "select 'a;b' as x")
    assert.ok(assertSingleSelect("WITH x AS (SELECT 1) SELECT * FROM x"))
    for (const bad of ["delete from disk_volume", "select 1; select 2", "drop table disk_volume", "insert into disk_watch values (1,2)", "pragma version"]) {
      assert.throws(() => assertSingleSelect(bad), UsageError, bad)
    }
  })
})

suite("disk CLI — views over a real database", () => {
  test("now shows the latest sample of every volume; --volume filters by mount name", withDb(async () => {
    const all = await json(["now"])
    assert.deepStrictEqual(all.map(r => r.mount), ["/Volumes/A", "/Volumes/B"])
    assert.strictEqual(Number(all[0].used_b), 100 + 4 * GIB)
    assert.strictEqual(Number(all[0].used_minus_trash_b), 100 + 2 * GIB)
    assert.deepStrictEqual((await json(["now", "--volume", "B"])).map(r => r.mount), ["/Volumes/B"])
  }))

  test("changes lists the exact sample and signed size of each jump, with the gap since the previous sample", withDb(async () => {
    const rows = await json(["changes", "--since", LONG_AGO, "--min", "1M"])
    assert.strictEqual(rows.length, 2, "only volume A moved: the +5 GiB jump and the -1 GiB drop")
    assert.deepStrictEqual(rows.map(r => Number(r.delta_used_b)), [5 * GIB, -GIB])
    assert.deepStrictEqual(rows.map(r => Number(r.delta_free_b)), [-5 * GIB, GIB])
    assert.deepStrictEqual(rows.map(r => Number(r.gap_s)), [60, 120 - 60])
    assert.strictEqual(Number(rows[0].used_b), 100 + 5 * GIB)
    assert.ok(rows.every(r => r.mount === "/Volumes/A"))
  }))

  test("top-change ranks by the biggest single sample-to-sample move", withDb(async () => {
    const rows = await json(["top-change", "--since", LONG_AGO, "--top", "1"])
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(Number(rows[0].delta_used_b), 5 * GIB)
  }))

  test("history buckets samples per volume; trees shows the latest walk and a folder history", withDb(async () => {
    const h = await json(["history", "--since", LONG_AGO, "--every", "1d"])
    assert.deepStrictEqual(h.map(r => Number(r.samples)), [5, 5])
    const trees = await json(["trees"])
    assert.strictEqual(trees.length, 1)
    assert.strictEqual(Number(trees[0].allocated_follow_b), 40)
    assert.strictEqual((await json(["trees", "--folder", "/some/folder", "--since", LONG_AGO])).length, 1)
    assert.strictEqual((await json(["trees", "--folder", "/not/watched", "--since", LONG_AGO])).length, 0)
  }))

  test("the text table humanizes byte columns, the sql view does not", withDb(async () => {
    const now = await capture(() => runDiskCli(["now"]))
    assert.match(now.out, /GiB/)
    const sql = await capture(() => runDiskCli(["sql", "select used_b from disk_volume where mount = '/Volumes/B' limit 1"]))
    assert.match(sql.out, new RegExp(String(GIB)))
    assert.doesNotMatch(sql.out, /GiB/)
    assert.strictEqual(renderTable([], true), "(no rows)")
  }))

  test("a DuckDB INTERVAL renders as HH:MM:SS.mmm in the table, never [object Object]; --json keeps the raw value", withDb(async () => {
    const q = "select ts - lag(ts) over (order by ts) as gap from (select distinct ts from disk_volume) order by ts desc limit 1"
    const table = await capture(() => runDiskCli(["sql", q]))
    assert.strictEqual(table.code, EXIT.OK, table.err)
    assert.doesNotMatch(table.out, /object Object/)
    assert.match(table.out, /^gap\n00:01:00\.000\n$/)
    assert.deepStrictEqual((await json(["sql", q]))[0].gap, { months: 0, days: 0, micros: "60000000" })
  }))

  test("formatInterval covers days, months, sub-second digits and negative spans; renderTable uses it", () => {
    assert.strictEqual(formatInterval({ months: 0, days: 1, micros: "7384500000" }), "1d 02:03:04.500")
    assert.strictEqual(formatInterval({ months: 2, days: 0, micros: "0" }), "2mo 00:00:00.000")
    assert.strictEqual(formatInterval({ months: 0, days: 0, micros: "-90000000" }), "-00:01:30.000")
    assert.strictEqual(formatInterval({ months: 0, days: 0, micros: 101_500_000 }), "00:01:41.500")
    assert.strictEqual(renderTable([{ gap: { months: 0, days: 0, micros: "101500000" } }], true), "gap\n00:01:41.500")
  })

  test("now lists purgeable_b and important_avail_b next to avail_b", withDb(async () => {
    const r = (await json(["now"]))[0]
    assert.ok("purgeable_b" in r && "important_avail_b" in r && "avail_b" in r)
  }))
})

suite("disk CLI — sql is read-only", () => {
  test("a SELECT runs and returns rows", withDb(async () => {
    assert.strictEqual(Number((await json(["sql", "select count(*) AS n from disk_volume"]))[0].n), 10)
  }))

  test("every way of writing or reading elsewhere is refused and the table is unchanged", withDb(async () => {
    const attempts = [
      "delete from disk_volume",
      "select 1; delete from disk_volume",
      "with x as (select 1) delete from disk_volume",
      "select * from read_text('/etc/hosts')",
    ]
    for (const sql of attempts) {
      await assert.rejects(capture(() => runDiskCli(["sql", sql])), /./, sql)
    }
    assert.strictEqual(Number((await json(["sql", "select count(*) AS n from disk_volume"]))[0].n), 10)
  }))

  test("a missing database is exit 2 with a message, not an empty table", withDb(async () => {
    const r = await capture(() => runDiskCli(["now"]))
    assert.strictEqual(r.code, EXIT.UNKNOWN)
    assert.match(r.err, /no disk monitor data yet/)
  }, false))
})

suite("disk-watch", () => {
  test("add, list and remove round-trip; a nonexistent path is refused", withDb(async dir => {
    const target = path.join(dir, "watched")
    fs.mkdirSync(target)
    assert.strictEqual((await capture(() => runDiskWatchCli(["add", target, "--kind", "trash"]))).code, EXIT.OK)
    const listed = await capture(() => runDiskWatchCli(["list"]))
    assert.ok(listed.out.includes(target) && /trash\s+stored/.test(listed.out))
    await assert.rejects(runDiskWatchCli(["add", path.join(dir, "nope")]), UsageError)
    assert.strictEqual((await capture(() => runDiskWatchCli(["remove", target]))).code, EXIT.OK)
    assert.ok(!(await capture(() => runDiskWatchCli(["list"]))).out.includes(target))
    assert.strictEqual((await capture(() => runDiskWatchCli(["remove", target]))).code, EXIT.UNKNOWN, "removing what is not watched says so")
  }))
})

// The exemption is decided in foreignTelemetry.ts, but only the real CLI proves the whole path (main.ts gate included) lets the
// family through: it spawns the built bundle (standalone/cli.js — build it with `node esbuild.js` first, like cliDispatch.test.ts).
suite("disk family under DISABLED (real CLI)", () => {
  const CLI_JS = path.resolve(__dirname, "..", "..", "..", "standalone", "cli.js")
  function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [CLI_JS, ...args], { env })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      child.on("close", code => resolve({ code, stdout, stderr }))
    })
  }

  test("disk-watch list, disk-monitor status, and the disk-monitor install/uninstall gate pass while DISABLED is armed; the DISABLED file is untouched", async function () {
    this.timeout(60_000)
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "al-diskcli-disabled-")))
    const data = path.join(home, "data")
    try {
      fs.mkdirSync(data)
      const flag = path.join(data, "DISABLED")
      fs.writeFileSync(flag, "AgentlensPro is DISABLED.\nReason: test\n")
      const before = fs.statSync(flag).mtimeMs
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const k of Object.keys(env)) if (k.startsWith("AGENTLENS_")) delete env[k]
      delete env.DATA_DIR
      Object.assign(env, { HOME: home, USERPROFILE: home, AGENTLENS_DATA_DIR: data, AGENTLENS_NO_AUTOSETUP: "1" })
      assert.strictEqual((await runCli(["budget"], env)).code, EXIT.DISABLED, "precondition: the brake is armed for an ordinary verb")
      const list = await runCli(["disk-watch", "list"], env)
      assert.strictEqual(list.code, 0, list.stderr + list.stdout)
      if (process.platform === "darwin") { // status asks launchctl, which only exists on macOS
        const status = await runCli(["disk-monitor", "status"], env)
assert.strictEqual(status.code, EXIT.UNKNOWN, status.stderr + status.stdout) // nothing is installed under the temp HOME: exit 2 is status's own "not installed" answer, never 69 (DISABLED)
        assert.ok(/plist:\s+not installed/.test(status.stdout), status.stdout)
      }
      // The owner exempted the whole disk monitor (owner decision 2026-11-16). The gate is checked in-process with the switch REALLY armed
      // (the DISABLED flag above, in AGENTLENS_DATA_DIR), so a null can only come from the exemption. The real install/uninstall are NOT
      // run: they would load or unload the REAL launchd label com.agentlens.disk-sample on this machine.
      const savedDataDir = process.env.AGENTLENS_DATA_DIR
      process.env.AGENTLENS_DATA_DIR = data
      try {
        assert.notStrictEqual(disabledNotice(["budget"]), null, "precondition: the switch is armed in this process")
        for (const sub of ["install", "uninstall"]) assert.strictEqual(disabledNotice(["disk-monitor", sub]), null, `disk-monitor ${sub} passes the DISABLED gate`)
      } finally {
        if (savedDataDir === undefined) delete process.env.AGENTLENS_DATA_DIR
        else process.env.AGENTLENS_DATA_DIR = savedDataDir
      }
      assert.strictEqual(fs.statSync(flag).mtimeMs, before, "the exempt verbs must never touch the DISABLED file")
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})
