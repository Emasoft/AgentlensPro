// TRDD-219K7C1N — the body store must survive parts written by two schema GENERATIONS.
//
// The store writes immutable Parquet parts from a fixed `CREATE TABLE`, so every part written by one
// code version agrees. Parts written either side of a column being added do NOT, and this store has
// 2,610 parts spanning years of code. Probed on the real store first: today all parts share ONE
// schema shape, so nothing is broken right now — these tests pin the transition, which is the moment
// the defect would surface, in production, on every read at once.
//
// MEASURED against the unfixed code, on the fixture below:
//   - `read_parquet([old,new])` with the OLD file first silently DROPS the new column.
//   - with the NEW file first it throws `schema mismatch in glob`.
//   - `allOf`'s positional `UNION ALL` throws `Set operations can only apply to expressions with the
//     same number of result columns` — taking down EVERY store read until the last old part ages out.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { allOf, BODIES_DIR, openStore, Store } from '../store/db'

/** Write a Parquet part directly, bypassing the store's own writer — that is the whole point: it
 *  simulates a part left behind by an EARLIER code generation whose staging table lacked a column. */
async function writePart(store: Store, sub: string, name: string, ddl: string, values: string): Promise<void> {
  const tmp = `gen_${name.replace(/[^a-z0-9]/gi, '_')}`
  await store.con.run(`CREATE TABLE ${tmp} (${ddl})`)
  await store.con.run(`INSERT INTO ${tmp} VALUES ${values}`)
  const out = path.join(store.dir, sub, name).replace(/'/g, "''")
  await store.con.run(`COPY ${tmp} TO '${out}' (FORMAT parquet)`)
  await store.con.run(`DROP TABLE ${tmp}`)
}

async function rows(store: Store, sql: string): Promise<Array<Record<string, unknown>>> {
  return (await store.con.runAndReadAll(sql)).getRowObjects()
}

suite('store — parts from two schema generations must still read', () => {
  let dir: string
  let store: Store

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-schemagen-'))
    store = await openStore({ dir })
  })

  teardown(async () => {
    await store?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a part missing a column the staging table HAS still reads, and the gap is NULL', async () => {
    // The old generation: no `model` column at all. Named so readdir puts it FIRST, which is the
    // real-world order (parts are `part-<Date.now()>-…`, so older sorts earlier) AND the order that
    // fails silently rather than loudly.
    await writePart(store, BODIES_DIR, 'part-0000000000000-1-0.parquet',
      'body_id VARCHAR, src_name VARCHAR, kind VARCHAR, session_id VARCHAR, ts TIMESTAMP, raw_bytes BIGINT, body_sha256 VARCHAR',
      `('OLD','o.json','request','s1','2026-01-01',10,'sha-old')`)

    // The current generation, written through the store's own staging table (which HAS `model`).
    await store.con.run(
      `INSERT INTO body VALUES ('NEW','n.json','response','s1','2026-01-02','claude-opus-5',20,'sha-new')`)

    const got = await rows(store, `SELECT body_id, model FROM ${allOf(store, 'body')} ORDER BY body_id`)

    // BOTH rows survive. Unfixed, this throws on the arity check before returning anything.
    assert.strictEqual(got.length, 2, 'both generations must be readable')
    const by = new Map(got.map(r => [String(r.body_id), r.model]))
    assert.strictEqual(by.get('NEW'), 'claude-opus-5', 'the current-generation row keeps its value')
    assert.strictEqual(by.get('OLD'), null, 'the older row has no model — NULL is the truth about it')
  })

  test('two DURABLE parts that disagree reconcile by name, not by position', async () => {
    // Both parts on disk, one per generation — this is the `read_parquet([...])` half of the fix,
    // isolated from the staging table.
    await writePart(store, BODIES_DIR, 'part-0000000000000-1-0.parquet',
      'body_id VARCHAR, kind VARCHAR', `('OLD','request')`)
    await writePart(store, BODIES_DIR, 'part-9999999999999-1-0.parquet',
      'body_id VARCHAR, kind VARCHAR, model VARCHAR', `('NEW','response','claude-opus-5')`)

    const got = await rows(store, `SELECT body_id, model FROM ${allOf(store, 'body')} WHERE body_id IN ('OLD','NEW') ORDER BY body_id`)

    assert.strictEqual(got.length, 2, 'neither durable part may be dropped')
    const by = new Map(got.map(r => [String(r.body_id), r.model]))
    // Unfixed + old-file-first: `model` is silently absent, so this SELECT throws a Binder Error.
    assert.strictEqual(by.get('NEW'), 'claude-opus-5', 'the newer part keeps its added column')
    assert.strictEqual(by.get('OLD'), null)
  })

  test('a column added in the MIDDLE does not shift values into the wrong column', async () => {
    // The dangerous case positional UNION ALL cannot catch: the counts can agree while the ORDER does
    // not, and then every value lands one column over with no error anywhere.
    await writePart(store, BODIES_DIR, 'part-0000000000000-1-0.parquet',
      'body_id VARCHAR, kind VARCHAR, session_id VARCHAR', `('OLD','request','s1')`)
    await writePart(store, BODIES_DIR, 'part-9999999999999-1-0.parquet',
      'body_id VARCHAR, model VARCHAR, kind VARCHAR, session_id VARCHAR', `('NEW','claude-opus-5','response','s2')`)

    const got = await rows(store, `SELECT body_id, kind, session_id, model FROM ${allOf(store, 'body')} WHERE body_id IN ('OLD','NEW') ORDER BY body_id`)
    const by = new Map(got.map(r => [String(r.body_id), r]))

    // The assertion that matters: `kind` holds a kind, not a model id.
    assert.strictEqual(by.get('NEW')?.kind, 'response', 'kind must not be shifted by the inserted column')
    assert.strictEqual(by.get('NEW')?.session_id, 's2')
    assert.strictEqual(by.get('NEW')?.model, 'claude-opus-5')
    assert.strictEqual(by.get('OLD')?.kind, 'request')
    assert.strictEqual(by.get('OLD')?.model, null)
  })

  test('the ordinary same-schema case is unchanged', async () => {
    // Guard against the fix being a behaviour change for the 100% of reads that are single-generation.
    await store.con.run(
      `INSERT INTO body VALUES ('A','a.json','request','s1','2026-01-01','claude-opus-5',10,'sha-a')`)
    const got = await rows(store, `SELECT body_id, model, raw_bytes FROM ${allOf(store, 'body')}`)
    assert.strictEqual(got.length, 1)
    assert.strictEqual(got[0].model, 'claude-opus-5')
    assert.strictEqual(Number(got[0].raw_bytes), 10)
  })
})
