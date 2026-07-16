// Draining the legacy .wad into the store is the last step before 16 GB of the user's only remaining
// history becomes eligible for deletion. So the tests prove the two things that decision rests on:
// every lump round-trips byte-identically, and a lump that does NOT is named rather than skipped.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendToArchive } from '../bodyArchive'
import { openStore, Store } from '../store/db'
import { bodyIdOf, reconstructBody } from '../store/bodyStore'
import { migrateArchiveToStore } from '../store/migrateArchive'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-wad-')) }

function body(turn: number): string {
  const tools = Array.from({ length: 5 }, (_, i) => ({ name: `t${i}`, schema: 'x'.repeat(400) }))
  const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(300)}` }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages })
}

/** A .wad archive holding `n` turn-ordered bodies, exactly as the retired archiver wrote them. */
function archive(n: number): { dir: string; raws: Map<string, string> } {
  const dir = tmp()
  const raws = new Map<string, string>()
  for (let i = 1; i <= n; i++) {
    const name = `b${String(i).padStart(3, '0')}.request.json`
    const raw = body(i)
    raws.set(name, raw)
    appendToArchive(dir, name, Buffer.from(raw, 'utf8'), Date.now() - (n - i) * 60_000)
  }
  return { dir, raws }
}

suite('migrateArchive — the .wad is the only copy of that history', () => {
  let store: Store
  let storeDir: string
  setup(async () => {
    storeDir = tmp()
    store = await openStore({ dir: storeDir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('every archived lump round-trips byte-identically through the store', async () => {
    const { dir, raws } = archive(8)
    const r = await migrateArchiveToStore({ archiveDir: dir, store, batchSize: 3 })

    assert.strictEqual(r.entries, 8)
    assert.strictEqual(r.ingested, 8)
    assert.strictEqual(r.verified, 8)
    assert.deepStrictEqual(r.failed, [])

    for (const raw of raws.values()) {
      assert.strictEqual(await reconstructBody(store, bodyIdOf(raw)), raw)
    }
  })

  test('the archive is NEVER deleted — reclaiming it is a separate human decision', async () => {
    const { dir } = archive(4)
    const before = fs.readdirSync(dir)
    await migrateArchiveToStore({ archiveDir: dir, store })
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before.sort(), 'the .wad volumes must survive')
  })

  test('it is IDEMPOTENT and resumable — a re-run costs zero new bytes', async () => {
    // A 16 GB drain will be interrupted. Re-running it must not double-store the corpus.
    const { dir } = archive(6)
    const first = await migrateArchiveToStore({ archiveDir: dir, store })
    assert.ok(first.bytesStored > 0)

    const second = await migrateArchiveToStore({ archiveDir: dir, store })
    assert.strictEqual(second.bytesStored, 0, 'a re-run must add nothing')
    assert.strictEqual(second.alreadyPresent, 6)
    assert.strictEqual(second.verified, 6, 'and must still PROVE every lump is retrievable')
  })

  test('archived turns dedup against each other (the .wad stored each one in full)', async () => {
    const { dir } = archive(10)
    const r = await migrateArchiveToStore({ archiveDir: dir, store })
    assert.ok(r.bytesStored < r.bytesIn / 2,
      `the whole point: ${r.bytesIn} archived bytes -> ${r.bytesStored} stored`)
  })

  test('an UNREADABLE lump is NAMED, not silently skipped', async () => {
    // "0 failures" has to mean something. A drain that quietly drops what it cannot parse is how a
    // corpus rots unnoticed — and here it would authorize deleting the only copy.
    const { dir } = archive(3)
    const vol = fs.readdirSync(dir).find((f) => f.endsWith('.wad'))!
    // Corrupt the gzip payload of the first lump, leaving the index intact.
    const p = path.join(dir, vol)
    const buf = fs.readFileSync(p)
    buf.fill(0, 20, 60)
    fs.writeFileSync(p, buf)

    const r = await migrateArchiveToStore({ archiveDir: dir, store })
    assert.ok(r.failed.length > 0, 'a corrupt lump MUST be reported')
    assert.ok(r.failed.some((f) => /\.request\.json/.test(f)), r.failed.join('; '))
  })

  test('an empty archive is a no-op, not a crash', async () => {
    const r = await migrateArchiveToStore({ archiveDir: tmp(), store })
    assert.strictEqual(r.entries, 0)
    assert.deepStrictEqual(r.failed, [])
  })
})
