import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { StatuslineStore, queryStatusline } from '../statuslineStore'

// TRDD-ZKNP5IJY — a key first sent after the first 20,480 rows of a write-ahead file, and a fraction in a column that
// began with whole numbers, reach the reader and the TypeScript sealer. Real files and real DuckDB, no server.

suite('status-line store keeps a late key and a late fraction (TRDD-ZKNP5IJY)', () => {
  let tmp: string
  let savedSealRows: string | undefined
  const SID = 'aaaaaaaa-0000-0000-0000-000000000000'
  const LINES = 30_000
  const SQL = 'SELECT count(late_key) AS c, count(*) AS total, max(CASE WHEN late_key IS NOT NULL THEN n END) AS late_n FROM samples'
  const root = (): string => path.join(tmp, 'statusline')
  const store = (): StatuslineStore => new StatuslineStore({ root: root(), autoTimer: false })
  const fill = (s: StatuslineStore): void => {
    const now = Date.now()
    for (let i = 0; i < LINES; i++) s.append({ session_id: SID, n: i }, 'main', now - (LINES - i))
    s.append({ session_id: SID, n: 1.5, late_key: 7 }, 'main', now)
  }
  const storeFiles = (): string[] => {
    const main = path.join(root(), 'main')
    return fs.readdirSync(path.join(main, fs.readdirSync(main)[0]))
  }
  const check = async (): Promise<void> => {
    const rows = await queryStatusline(root(), 'main', SQL)
    assert.ok(rows !== null, 'the store is readable')
    assert.strictEqual(Number(rows[0].total), LINES + 1, 'every row is read')
    assert.strictEqual(Number(rows[0].c), 1, 'the late key is a column and holds its one value')
    assert.strictEqual(Number(rows[0].late_n), 1.5, 'the fraction is not rounded')
  }

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-late-key-'))
    savedSealRows = process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
    process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = '1'
  })
  teardown(() => {
    if (savedSealRows === undefined) delete process.env.AGENTLENS_STATUSLINE_SEAL_ROWS
    else process.env.AGENTLENS_STATUSLINE_SEAL_ROWS = savedSealRows
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('the reader sees a key first sent after row 20,480 of a write-ahead file, and its fraction', async () => {
    // An unsealed file longer than the default sample: the key of its last row must be a column.
    const s = store()
    fill(s)
    s.flush()
    assert.ok(storeFiles().some(f => f.startsWith('wal-') && f.endsWith('.ndjson')), 'the rows are in a write-ahead file')
    await check()
  })

  test('the TypeScript sealer writes the late key and the fraction into the part', async () => {
    // After the seal only the part is left, so what the reader sees is what the sealer wrote.
    const s = store()
    fill(s)
    s.flush()
    assert.strictEqual(await s.maybeSeal(Date.now()), 1)
    const files = storeFiles()
    assert.ok(files.some(f => /^part-.*\.parquet$/.test(f)), files.join(', '))
    assert.ok(!files.some(f => f.startsWith('wal-') && f.endsWith('.ndjson')), files.join(', '))
    await check()
  })
})
