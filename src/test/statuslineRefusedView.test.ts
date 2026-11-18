// src/test/statuslineRefusedView.test.ts — TRDD-RTHA7EWK item 5
//
// `agentlenspro statusline-history refused` lists the write-ahead files the sealer refused, read off disk
// from the `sealfail-<file>.json` markers the sealer leaves beside them. No server and no DuckDB: the data
// dir is a temp dir and the view runs in this process.

import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { UsageError } from '../cli/cliErrors'
import { runStatuslineHistoryCli } from '../cli/statuslineHistoryCli'

const KEYS = ['AGENTLENS_DATA_DIR'] as const

suite('statusline-history refused — refused write-ahead files are listed from their markers (TRDD-RTHA7EWK item 5)', () => {
  let dir: string
  const saved = new Map<string, string | undefined>()

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-refused-'))
    for (const k of KEYS) saved.set(k, process.env[k])
    process.env.AGENTLENS_DATA_DIR = dir
  })
  teardown(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    saved.clear()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const marker = (stream: string, day: string, file: string, body: string): void => {
    const d = path.join(dir, 'statusline', stream, day)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `sealfail-${file}.json`), body)
  }

  /** Run the view in this process and return its exit code and everything it printed to stdout. */
  async function run(args: string[]): Promise<{ code: number; out: string }> {
    const lines: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')) }
    try {
      const code = await runStatuslineHistoryCli(args)
      return { code, out: lines.join('\n') }
    } finally { console.log = realLog }
  }

  test('a valid marker gives its attempts, failures, reason and the next retry; an unparseable one is listed as unreadable, not skipped', async () => {
    marker('main', '2026-11-17', 'wal-cli.ndjson.rot-1', JSON.stringify({
      file: 'wal-cli.ndjson.rot-1', firstFailMs: 1_700_000_000_000, lastFailMs: 1_700_000_600_000, attempts: 3, nextRetryMs: 1_700_000_900_000, reason: 'duckdb: boom',
    }))
    marker('subagent', '2026-11-18', 'wal-9.ndjson', '{"file": "wal-9.nd')   // torn: not JSON

    const json = await run(['refused', '--json'])
    assert.strictEqual(json.code, 0)
    const rows = JSON.parse(json.out) as Array<Record<string, unknown>>
    assert.strictEqual(rows.length, 2, 'one row per marker, none skipped')
    const [good, bad] = rows
    assert.deepStrictEqual(good, {
      stream: 'main', day: '2026-11-17', file: 'wal-cli.ndjson.rot-1', attempts: 3,
      firstFailMs: 1_700_000_000_000, lastFailMs: 1_700_000_600_000,
      nextRetryMs: 1_700_000_900_000,   // the value the sealer wrote, shown as it is
      reason: 'duckdb: boom',
    })
    assert.deepStrictEqual(bad, { stream: 'subagent', day: '2026-11-18', file: 'wal-9.ndjson', reason: 'unreadable marker' })

    const text = await run(['refused'])
    assert.strictEqual(text.code, 0)
    assert.ok(text.out.includes('duckdb: boom') && text.out.includes('wal-cli.ndjson.rot-1'), 'the table names the file and the reason')
    assert.ok(text.out.includes('unreadable marker') && text.out.includes('wal-9.ndjson'), 'the table lists the torn marker')
  })

  // A marker the sealer wrote before nextRetryMs existed: listed with its other fields, no nextRetryMs key, not unreadable.
  test('a marker with no nextRetryMs is listed with its other fields and no nextRetryMs key', async () => {
    marker('main', '2026-11-17', 'a', JSON.stringify({ file: 'a', firstFailMs: 1000, lastFailMs: 2000, attempts: 2, reason: 'r' }))
    const rows = JSON.parse((await run(['refused', '--json'])).out) as Array<Record<string, unknown>>
    assert.deepStrictEqual(rows, [{ stream: 'main', day: '2026-11-17', file: 'a', attempts: 2, firstFailMs: 1000, lastFailMs: 2000, reason: 'r' }])
    assert.ok(!('nextRetryMs' in rows[0]), 'no nextRetryMs key')
  })

  test('an unknown flag is refused with a usage error, as on every other view', async () => {
    await assert.rejects(() => run(['refused', '--jsn']), (e: unknown) => e instanceof UsageError && /unknown flag "--jsn"/.test((e as Error).message))
  })

  test('a filter flag of the other views is refused, because this view would ignore it', async () => {
    await assert.rejects(() => run(['refused', '--session', 'abc']), (e: unknown) => e instanceof UsageError && /takes only --json, got --session/.test((e as Error).message))
  })
  test('with no marker it prints one line saying no write-ahead file is refused, and exits 0', async () => {
    fs.mkdirSync(path.join(dir, 'statusline', 'main', '2026-11-18'), { recursive: true })
    const r = await run(['refused'])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'no write-ahead file is refused')
  })

  test('with no statusline directory at all it still answers the empty case, not an error', async () => {
    const r = await run(['refused'])
    assert.strictEqual(r.code, 0)
    assert.strictEqual(r.out, 'no write-ahead file is refused')
  })
})
