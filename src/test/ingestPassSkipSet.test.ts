// IngestPass skip-set (TRDD-K3WDPR7M P1 efficiency lever, salvaged from a deleted spool test file
// in TRDD-Z53IJFE9 step D): the 60 s SSD-drain pass must never re-read a body
// the store provably already holds, and a durable file must still be RECLAIMED (deleted) even when
// its ingest is skipped. Pure store behavior — no spool, no RAM disk.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openStore, Store } from '../store/db'
import { ingestPass } from '../store/ingestPass'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlens-ingestpass-')) }

suite('ingestPass — skipNames avoids re-reading durable bodies', () => {
  let store: Store
  setup(async () => { store = await openStore({ dir: tmp(), memoryLimit: '2GB', threads: 2 }) })
  teardown(async () => { await store.close() })

  function body(turn: number): string {
    const messages = Array.from({ length: turn }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(300)}` }))
    return JSON.stringify({ model: 'claude-opus-4-8', tools: [{ name: 't', schema: 'x'.repeat(200) }], messages })
  }
  function corpus(n: number): { dir: string; names: string[] } {
    const dir = tmp()
    const names: string[] = []
    for (let i = 1; i <= n; i++) {
      const name = `body-${String(i).padStart(3, '0')}.request.json`
      fs.writeFileSync(path.join(dir, name), body(i))
      names.push(name)
    }
    return { dir, names }
  }

  test('a name already in skipNames is NOT ingested; the set grows with the names it DID ingest', async () => {
    const { dir, names } = corpus(3)
    const skip = new Set<string>([names[0]])
    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(r.ingested, 2, 'the pre-seeded name must be skipped by the INGEST')
    assert.ok(skip.has(names[1]) && skip.has(names[2]), 'ingested names are added to the set')
    assert.strictEqual(fs.existsSync(path.join(dir, names[0])), true, 'a skipped file is left untouched')
    // The set claimed this name was durable and the store does not have it, so the claim was
    // false and it is DROPPED — the set self-heals and the next pass ingests it for real. Keeping
    // it would strand the file forever: never re-ingested, never verifiable, never deleted.
    assert.strictEqual(skip.has(names[0]), false, 'a name the store cannot confirm leaves the set')
    assert.ok(r.failed.some(f => f.includes(names[0])), 'and the unverifiable name is reported')
  })

  test('a second pass with the grown set ingests nothing — no re-read, no re-hash', async () => {
    const { dir } = corpus(4)
    const skip = new Set<string>()
    const first = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(first.ingested, 4)
    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(second.ingested, 0, 'every name is now in the skip-set')
  })

  test('an already-durable body is RECLAIMED, not stranded — the skip is on the ingest, not the delete', async () => {
    // The bug this pins: skipNames filtered candidates out of the pass entirely, so a body the store
    // already held was never re-ingested (right) AND never deleted (wrong). On a fixed-size RAM spool
    // that is fatal — it fills with files the store already has until capture silently dies. Measured
    // on this machine: 3,615 bodies stranded in a 2 GB spool at 100%.
    const { dir, names } = corpus(3)
    const skip = new Set<string>()
    const first = await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
    assert.strictEqual(first.ingested, 3)
    assert.strictEqual(first.deleted, 0, 'deleteAfter:false must delete nothing')

    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(second.ingested, 0, 'nothing to re-ingest — every name is durable')
    assert.strictEqual(second.deleted, 3, 'but every durable file must still be reclaimed')
    assert.strictEqual(second.reclaimedDurable, 3, 'and counted as having needed no re-ingest')
    assert.deepStrictEqual(second.failed, [], 'a durable body has nothing to fail on')
    for (const n of names) {
      assert.strictEqual(fs.existsSync(path.join(dir, n)), false, `${n} must be gone from the bodies dir`)
    }
  })

  test('a durable NAME whose BYTES differ is KEPT and named — never deleted on the strength of its filename', async () => {
    // The counter-case that keeps the widening honest: reclaiming by name alone would delete a body
    // the store cannot return. The gate re-reads and re-proves, so this file survives.
    const { dir, names } = corpus(2)
    const skip = new Set<string>()
    await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })

    // Same name, same mtime, different bytes — so the ONLY thing that can fail the gate is the content.
    const victim = path.join(dir, names[0])
    const mtime = fs.statSync(victim).mtime
    fs.writeFileSync(victim, JSON.stringify({ model: 'x', tools: [], messages: [{ role: 'user', content: 'tampered' }] }))
    fs.utimesSync(victim, mtime, mtime)

    const r = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(fs.existsSync(victim), true, 'a body the store cannot return must survive')
    assert.strictEqual(r.failed.length, 1, 'and it must be NAMED — a silent skip looks like success')
    assert.ok(r.failed[0].includes(names[0]), `failed should name ${names[0]}, got: ${r.failed[0]}`)
    assert.strictEqual(r.reclaimedDurable, 1, 'only the untampered sibling counts as reclaimed')
    assert.strictEqual(fs.existsSync(path.join(dir, names[1])), false, 'the untampered sibling still reclaims')

    // AND it must not be stranded: a name whose bytes no longer match is not durable, so it leaves
    // the skip-set and the NEXT pass re-ingests the true bytes. Without this the file is skipped
    // forever AND never deleted — it holds a slot in a fixed-size spool permanently, which is the
    // fills-until-capture-dies failure this whole pass exists to prevent.
    assert.strictEqual(skip.has(names[0]), false, 'a failed durable name must leave the skip-set')
    const second = await ingestPass({ bodiesDir: dir, store, deleteAfter: true, skipNames: skip })
    assert.strictEqual(second.ingested, 1, 'the next pass re-ingests the true bytes')
    assert.strictEqual(fs.existsSync(victim), false, 'and then reclaims it')
    assert.deepStrictEqual(second.failed, [])
  })

  test('a body that VANISHES mid-pass is not reported as a verification failure', () => new Promise<void>((done, fail) => {
    // The ingest path has always treated a vanished file as fine; the durable path must too, or a
    // drained/rotated file raises a "could NOT be verified and were KEPT on disk" alarm about a
    // file that no longer exists.
    void (async () => {
      try {
        const { dir, names } = corpus(2)
        const skip = new Set<string>()
        await ingestPass({ bodiesDir: dir, store, deleteAfter: false, skipNames: skip })
        const gone = path.join(dir, names[0])
        const r = await ingestPass({
          bodiesDir: dir, store, deleteAfter: true, skipNames: skip,
          readFile: (p: string) => {
            if (p === gone) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e }
            return fs.readFileSync(p, 'utf8')
          },
        })
        assert.deepStrictEqual(r.failed, [], 'a vanished file is not a failure')
        assert.strictEqual(r.deleted, 1, 'the file that IS there still reclaims')
        done()
      } catch (e) { fail(e as Error) }
    })()
  }))
})
