import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { DuckDBConnection } from "@duckdb/node-api"
import { sq, sqPath } from "../duckPath"
import { transcriptReadSpec } from "../ndjsonDuck"
import { StatuslineStore, dayKey, queryStatusline } from "../statuslineStore"
import { PARTS_DIR, parquetScan } from "../store/db"

// TRDD-CXNUWXX7 box 3: a file path that is only quote-doubled and holds * ? or [ is read by read_json, read_json_auto, read_ndjson_objects and
// read_parquet as a FILE PATTERN, so a folder named a*b also reads the files of axb, with no error. Every read site uses sqPath (src/duckPath.ts).
// Each fixture pair is a special folder and a sibling folder that the plain pattern also matches; each file holds a marker naming its folder.
// Real files and real DuckDB, no server. The canary test of each pair proves the fixture shows the expansion, the fix test proves the repo code does not.

// * and ? are illegal in Windows file names, so the file-based suites do not run there.
const WIN = process.platform === "win32"
const PAIRS: ReadonlyArray<readonly [string, string]> = [["a*b", "axb"], ["a?b", "azb"], ["a[x]b", "axb"]]
const DAY = "2026-11-18"

async function withDuck<T>(fn: (con: DuckDBConnection) => Promise<T>): Promise<T> {
  const { DuckDBInstance } = await import("@duckdb/node-api")
  const inst = await DuckDBInstance.create(":memory:", { memory_limit: "2GB", threads: "1" })
  const con = await inst.connect()
  try { return await fn(con) } finally { con.closeSync(); inst.closeSync() }
}
const markers = (sql: string): Promise<string[]> =>
  withDuck(async con => (await con.runAndReadAll(sql)).getRowObjects().map(r => String(r.m)))
const writeText = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
// COPY TO takes its path literally, so plain quoting (sq) is right for the target.
const writePart = (file: string, marker: string): Promise<unknown> => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return withDuck(con => con.run(`COPY (SELECT 1::BIGINT AS ts, ${sq("s")} AS session_id, ${sq(marker)} AS m) TO ${sq(file)} (FORMAT PARQUET)`))
}
/** The markers a plain quote-doubled path reads: the special folder only when its name is not a bracket class, plus the sibling. */
const canaryExpected = (pair: readonly [string, string], suffixes: string[]): string[] => {
  const [special, sibling] = pair
  const folders = special.includes("[") ? [sibling] : [special, sibling]
  return folders.flatMap(f => suffixes.map(s => f + s)).sort()
}

suite("duckPath: sqPath (TRDD-CXNUWXX7)", () => {
  test("wraps * ? and [ in a bracket class", () => {
    assert.strictEqual(sqPath("a*b?c[d"), sq("a[*]b[?]c[[]d"))
    assert.strictEqual(sqPath("a*b?c[d"), "'a[*]b[?]c[[]d'")
  })
  test("doubles a single quote", () => {
    assert.strictEqual(sqPath("o'b"), "'o''b'")
  })
  test("leaves a path holding a backslash unwrapped", () => {
    assert.strictEqual(sqPath("a\\*b[c]"), "'a\\*b[c]'")
  })
})

for (const pair of PAIRS) {
  const [special, sibling] = pair
  // Each pair has its own scratch root, so the folders of one pair are not siblings of the folders of another pair.
  suite(`duckPath: the read sites name exactly one file, folder ${special} (TRDD-CXNUWXX7)`, function () {
    this.timeout(60000)
    let tmp = ""
    const dirOf = (name: string): string => path.join(tmp, name)
    const transcript = (name: string): string => path.join(dirOf(name), "s.jsonl")
    const statuslineRoot = (name: string): string => path.join(dirOf(name), "statusline")
    const walOf = (name: string): string => path.join(statuslineRoot(name), "main", DAY, "wal-cli.ndjson")
    const partOf = (name: string): string => path.join(statuslineRoot(name), "main", DAY, "part-1-1-0.parquet")
    const storeDir = (name: string): string => path.join(dirOf(name), "store")
    const storePart = (name: string): string => path.join(storeDir(name), PARTS_DIR, "part-1.parquet")

    suiteSetup(async () => {
      if (WIN) return
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckpath-"))
      for (const name of [special, sibling]) {
        writeText(transcript(name), `{"timestamp":"t","type":"${name}","message":{}}\n`)
        writeText(walOf(name), `{"ts":1,"session_id":"s","m":"${name}/wal"}\n`)
        await writePart(partOf(name), `${name}/part`)
        await writePart(storePart(name), name)
      }
    })
    suiteTeardown(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    })

    test("B canary: a plain literal in read_ndjson_objects reads the sibling too", async () => {
      if (WIN) return
      const got = await markers(`SELECT json_extract_string(json, ${sq("$.type")}) AS m FROM read_ndjson_objects(${sq(transcript(special))})`)
      assert.deepStrictEqual(got.sort(), canaryExpected(pair, [""]))
    })
    test("B fix: transcriptReadSpec reads exactly the special folder", async () => {
      if (WIN) return
      const got = await markers(`SELECT type AS m FROM ${transcriptReadSpec([transcript(special)])}`)
      assert.deepStrictEqual(got.sort(), [special])
    })
    test("C canary: plain literals in read_json_auto and read_parquet read the sibling too", async () => {
      if (WIN) return
      const wal = await markers(`SELECT m FROM read_json_auto(${sq(walOf(special))}, sample_size=-1, ignore_errors=true)`)
      const part = await markers(`SELECT m FROM read_parquet(${sq(partOf(special))})`)
      assert.deepStrictEqual([...wal, ...part].sort(), canaryExpected(pair, ["/wal", "/part"]))
    })
    test("C fix: the status-line reader reads exactly the special folder", async () => {
      if (WIN) return
      const rows = await queryStatusline(statuslineRoot(special), "main", "SELECT m FROM samples")
      assert.ok(rows !== null, "the store is readable")
      assert.deepStrictEqual(rows.map(r => String(r.m)).sort(), [`${special}/part`, `${special}/wal`])
    })
    test("D canary: a plain literal in the read_parquet list form reads the sibling too", async () => {
      if (WIN) return
      const got = await markers(`SELECT m FROM read_parquet([${sq(storePart(special))}], union_by_name := true)`)
      assert.deepStrictEqual(got.sort(), canaryExpected(pair, [""]))
    })
    test("D fix: parquetScan reads exactly the special folder", async () => {
      if (WIN) return
      const scan = parquetScan(storeDir(special), PARTS_DIR)
      assert.ok(scan !== null, "the part is listed")
      const got = await markers(`SELECT m FROM ${scan}`)
      assert.deepStrictEqual(got.sort(), [special])
    })
  })
}

suite("duckPath: the status-line seal (TRDD-CXNUWXX7)", function () {
  this.timeout(60000)
  let tmp = ""
  suiteSetup(() => {
    if (!WIN) tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckpath-seal-"))
  })
  suiteTeardown(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  test("the seal of a write-ahead file under a*b reads and seals only that file", async () => {
    if (WIN) return
    // An orphan write-ahead file (a name that is not this pid) is sealed in place, so the sibling can hold a file with the same name.
    const day = dayKey(Date.now())
    const mk = (name: string): string => {
      const wal = path.join(tmp, name, "statusline", "main", day, "wal-cli.ndjson")
      writeText(wal, `{"ts":1,"session_id":"s","m":"${name}/wal"}\n`)
      return wal
    }
    const walSpecial = mk("a*b")
    const walSibling = mk("axb")
    const root = path.join(tmp, "a*b", "statusline")
    const sealed = await new StatuslineStore({ root, autoTimer: false }).maybeSeal(Date.now())
    assert.strictEqual(sealed, 1, "the one write-ahead file is sealed")
    const files = fs.readdirSync(path.dirname(walSpecial))
    assert.ok(files.some(f => /^part-.*\.parquet$/.test(f)), files.join(", "))
    assert.ok(!fs.existsSync(walSpecial), "the sealed write-ahead file is gone")
    assert.ok(fs.existsSync(walSibling), "the sibling write-ahead file is untouched")
    const rows = await queryStatusline(root, "main", "SELECT m FROM samples")
    assert.ok(rows !== null, "the store is readable")
    assert.deepStrictEqual(rows.map(r => String(r.m)), ["a*b/wal"])
  })
})
