import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MAX_OBJECT_SIZE, transcriptReadSpec, tornLineSql } from '../ndjsonDuck'

let seq = 0
function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `al-ndjson-duck-${process.pid}-${seq++}-`))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

suite('ndjsonDuck — the shared transcript reader spec', () => {
  test('transcriptReadSpec escapes an apostrophe in a path', () => {
    const sql = transcriptReadSpec(["/tmp/o'brien/session.jsonl"])
    assert.ok(sql.includes("/tmp/o''brien/session.jsonl"), 'apostrophe must be doubled, not left bare')
    assert.ok(sql.includes(`maximum_object_size=${MAX_OBJECT_SIZE}`))
    assert.ok(sql.includes('ignore_errors=true'))
    assert.ok(sql.includes('filename=true'))
  })

  test('tornLineSql emits both count(*) and count(<col>)', () => {
    const sql = tornLineSql('lines', 'timestamp')
    assert.ok(sql.includes('count(*) AS total'))
    assert.ok(sql.includes('count(timestamp) AS withCol'))
    assert.ok(sql.includes('FROM lines'))
  })

  // Load-bearing: a real DuckDB round-trip proves ignore_errors=true does NOT drop a torn NDJSON
  // line — it lands as an all-NULL row, so count(*) alone would have missed the loss and only
  // tornLineSql's count(*) vs count(requiredCol) comparison detects it.
  test('a truncated last line is detected by tornLineSql, not by count(*) alone', async function () {
    let duck: typeof import('@duckdb/node-api')
    try {
      duck = await import('@duckdb/node-api')
    } catch {
      this.skip()
      return
    }

    const { dir, cleanup } = tmpDir()
    try {
      const file = path.join(dir, 'transcript.jsonl')
      const goodLines = [
        JSON.stringify({ timestamp: '2026-06-01T12:00:00Z', type: 'assistant', message: { role: 'assistant', content: [] } }),
        JSON.stringify({ timestamp: '2026-06-01T12:00:01Z', type: 'assistant', message: { role: 'assistant', content: [] } }),
      ]
      // A crash mid-write: the JSON object is cut off before its closing brace, so it is not
      // parseable at all — exactly the shape ignore_errors is documented to tolerate by nulling.
      const tornLine = '{"timestamp":"2026-06-01T12:00:02Z","type":"assistant","message":{"role":"assis'
      fs.writeFileSync(file, [...goodLines, tornLine].join('\n') + '\n')

      const inst = await duck.DuckDBInstance.create(':memory:')
      const con = await inst.connect()
      const readSpec = transcriptReadSpec([file])
      const check = tornLineSql(`(SELECT * FROM ${readSpec})`, 'timestamp')
      const rows = (await con.runAndReadAll(check)).getRowObjects()

      assert.strictEqual(rows.length, 1)
      const total = Number(rows[0].total)
      const withCol = Number(rows[0].withCol)
      // count(*) sees 3 rows (the torn line becomes an all-NULL row, not a dropped one) while
      // count(timestamp) sees only the 2 real records — the gap IS the detection.
      assert.strictEqual(total, 3, 'the torn line must still be counted as a row by count(*)')
      assert.strictEqual(withCol, 2, 'the torn line must be all-NULL, so count(timestamp) excludes it')
      assert.ok(total > withCol, 'count(*) alone would have hidden the torn line — the gap is the detector')
    } finally {
      cleanup()
    }
  })

  test('the required column must be one EVERY record carries — `timestamp` is not, and lies', async function () {
    // The probe reads the UNFILTERED scan, so its required column decides what counts as "torn".
    // Measured over 482,993 real transcript records: `type` is missing from 0, `timestamp` from
    // 81,814 (16.9%) — `attachment`, `queue-operation` and `last-prompt` records legitimately carry
    // no timestamp. Keying on `timestamp` therefore reports a healthy machine's ordinary records as
    // unparseable. A disclosure that lies is worse than no disclosure, which is the whole reason the
    // probe exists, so this test pins the column choice rather than leaving it to taste.
    let duck: typeof import('@duckdb/node-api')
    try {
      duck = await import('@duckdb/node-api')
    } catch {
      this.skip()
      return
    }

    const { dir, cleanup } = tmpDir()
    try {
      const file = path.join(dir, 'mixed.jsonl')
      fs.writeFileSync(file, [
        // A real assistant turn: has both columns.
        JSON.stringify({ timestamp: '2026-06-01T12:00:00Z', type: 'assistant', message: { role: 'assistant', content: [] } }),
        // A real attachment: NO timestamp, and perfectly well-formed. Not torn.
        JSON.stringify({ type: 'attachment', message: { content: 'x' } }),
      ].join('\n') + '\n')

      const inst = await duck.DuckDBInstance.create(':memory:')
      const con = await inst.connect()
      const readSpec = transcriptReadSpec([file])
      const read = async (col: string): Promise<{ total: number; withCol: number }> => {
        const r = (await con.runAndReadAll(tornLineSql(`(SELECT * FROM ${readSpec})`, col))).getRowObjects()[0]
        return { total: Number(r.total), withCol: Number(r.withCol) }
      }

      const byType = await read('type')
      assert.strictEqual(byType.total - byType.withCol, 0, '`type` must report ZERO torn lines here — both records are well-formed')

      const byTimestamp = await read('timestamp')
      assert.strictEqual(byTimestamp.total - byTimestamp.withCol, 1,
        'this is the bug being pinned: keying on `timestamp` miscounts a well-formed attachment as torn')
    } finally {
      cleanup()
    }
  })
})
