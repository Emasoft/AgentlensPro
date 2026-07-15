// verifyVolumeInStore + the gated retention purge (TRDD-K3WDPR7M, USER directive 2026-07-15).
// These gates authorize destroying a 16 GB archive — the tests attack every way "ok" could lie:
// a lump missing from the store, a wrong capture ts, an index-less volume, and the purge callback
// contract (a volume the gate does not bless MUST survive ageing out).
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendToArchive, purgeArchiveVolumes } from '../bodyArchive'
import { flush, openStore, Store } from '../store/db'
import { ingestBody } from '../store/bodyStore'
import { verifyVolumeInStore } from '../store/archiveVerify'

function synthBody(tag: string): string {
  const tools = Array.from({ length: 4 }, (_, i) => ({ name: `tool_${i}`, schema: 'x'.repeat(300) }))
  return JSON.stringify({ model: 'claude-opus-4-8', tools, messages: [{ role: 'user', content: `q ${tag}` }] })
}

// July 2026 capture times -> the volume is bodies-2026-07.wad, and (from a 2026-07+ wall clock)
// its month has ended, so a short retention window makes it purge-eligible.
const T = Date.UTC(2026, 5, 9, 6, 0, 0) // June 9 2026 — a month guaranteed already over
const VOLUME = 'bodies-2026-06.wad'

suite('verifyVolumeInStore — per-lump proof before an archive volume may die', () => {
  let dir: string
  let archiveDir: string
  let store: Store

  setup(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-vol-'))
    dir = path.join(root, 'store')
    archiveDir = path.join(root, 'archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    store = await openStore({ dir, memoryLimit: '2GB', threads: 2 })
  })
  teardown(async () => { await store.close() })

  test('passes when every lump reconstructs AND carries its capture ts', async () => {
    for (const tag of ['a', 'b', 'c']) {
      const raw = synthBody(tag)
      appendToArchive(archiveDir, `${tag}.request.json`, Buffer.from(raw), T + 1000)
      await ingestBody(store, `${tag}.request.json`, raw, T + 1000)
    }
    await flush(store)
    const r = await verifyVolumeInStore(store, archiveDir, VOLUME)
    assert.deepStrictEqual({ ok: r.ok, entries: r.entries, verified: r.verified, failed: r.failed }, { ok: true, entries: 3, verified: 3, failed: [] })
  })

  test('FAILS (named) when a lump is not in the store at all', async () => {
    appendToArchive(archiveDir, 'orphan.request.json', Buffer.from(synthBody('orphan')), T)
    const r = await verifyVolumeInStore(store, archiveDir, VOLUME)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.failed.length, 1)
    assert.match(r.failed[0], /orphan\.request\.json/)
  })

  test('FAILS when the store holds the bytes but the WRONG capture ts (the drain bug)', async () => {
    const raw = synthBody('late')
    appendToArchive(archiveDir, 'late.request.json', Buffer.from(raw), T)
    await ingestBody(store, 'late.request.json', raw, T + 3 * 86400e3) // stamped 3 days off
    await flush(store)
    const r = await verifyVolumeInStore(store, archiveDir, VOLUME)
    assert.strictEqual(r.ok, false)
    assert.match(r.failed[0], /stored ts .* != capture time/)
  })

  test('an index-less volume with bytes is UNVERIFIABLE — never blessed', async () => {
    appendToArchive(archiveDir, 'x.request.json', Buffer.from(synthBody('x')), T)
    fs.rmSync(path.join(archiveDir, `${VOLUME}.idx`))
    const r = await verifyVolumeInStore(store, archiveDir, VOLUME)
    assert.strictEqual(r.ok, false)
    assert.match(r.failed[0], /unverifiable/)
  })

  test('a CORRUPT lump inside the volume fails verification instead of crashing the sweep', async () => {
    const raw = synthBody('gz')
    appendToArchive(archiveDir, 'gz.request.json', Buffer.from(raw), T)
    await ingestBody(store, 'gz.request.json', raw, T)
    await flush(store)
    // Flip bytes inside the gzip member: the entry stays listed, the lump no longer inflates.
    const vp = path.join(archiveDir, VOLUME)
    const buf = fs.readFileSync(vp)
    buf[Math.floor(buf.length / 2)] ^= 0xff
    fs.writeFileSync(vp, buf)
    const r = await verifyVolumeInStore(store, archiveDir, VOLUME)
    assert.strictEqual(r.ok, false)
    assert.match(r.failed[0], /unreadable lump|reconstruction|no body row|unknown body/)
  })
})

suite('purgeArchiveVolumes — ageing out is not, on its own, a licence to destroy', () => {
  let archiveDir: string
  setup(() => { archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-purge-')) })

  test('a blessed aged volume is deleted; its .idx sidecar is KEPT (capture-time provenance)', async () => {
    appendToArchive(archiveDir, 'a.request.json', Buffer.from(synthBody('a')), T)
    const r = await purgeArchiveVolumes(archiveDir, 1, async () => true)
    assert.deepStrictEqual(r.removed, [VOLUME])
    assert.deepStrictEqual(r.kept, [])
    assert.ok(!fs.existsSync(path.join(archiveDir, VOLUME)), 'volume gone')
    assert.ok(fs.existsSync(path.join(archiveDir, `${VOLUME}.idx`)), '.idx must survive')
  })

  test('a volume the gate refuses is KEPT and reported, no matter how old', async () => {
    appendToArchive(archiveDir, 'a.request.json', Buffer.from(synthBody('a')), T)
    const r = await purgeArchiveVolumes(archiveDir, 1, async () => false)
    assert.deepStrictEqual(r.removed, [])
    assert.deepStrictEqual(r.kept, [VOLUME])
    assert.ok(fs.existsSync(path.join(archiveDir, VOLUME)), 'volume must survive an unblessed purge')
  })

  test('a volume still inside the retention window is not even offered to the gate', async () => {
    appendToArchive(archiveDir, 'a.request.json', Buffer.from(synthBody('a')), Date.now())
    let asked = 0
    const r = await purgeArchiveVolumes(archiveDir, 3650, async () => { asked++; return true })
    assert.strictEqual(asked, 0)
    assert.deepStrictEqual(r.removed, [])
  })
})
