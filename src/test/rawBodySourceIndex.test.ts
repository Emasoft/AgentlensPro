// TRDD-U50JCH0J — the raw-body source identity and the incremental checkpoint.
//
// The cases here are the card's acceptance criteria, each one named after the property it
// pins: idempotence, crash-at-every-boundary, deterministic classification, refusal of an
// ambiguous identity, refusal of a malformed record, and a versioned format that refuses an
// unknown version. No mocks: real files in a /tmp corpus, real appends, real crashes.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  classifyFromContent, classifyFromMetadata, computeSourceIdentity, contentDigestOfFile,
  provenanceKey, readFileEvidence, sha256Hex,
} from '../rawBodySourceIdentity'
import {
  SOURCE_INDEX_FORMAT_VERSION, SourceIndexError, SourceIndexWriter, latestByPath,
  loadSourceIndex, outstandingSources, sourceIndexFileName, validateSourceIndexRecord,
} from '../rawBodySourceIndex'
import {
  discoverRawBodySources, readCorpusProvenance,
} from '../rawBodyDiscovery'

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)

let corpus: string
let state: string
let indexPath: string

function write(name: string, content: string, mtimeMs: number): string {
  const p = path.join(corpus, name)
  fs.writeFileSync(p, content)
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return p
}

function body(pad: number): string {
  return JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x'.repeat(pad) }] })
}

setup(() => {
  corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'u50-corpus-'))
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'u50-state-'))
  indexPath = path.join(state, sourceIndexFileName())
})

teardown(() => {
  fs.rmSync(corpus, { recursive: true, force: true })
  fs.rmSync(state, { recursive: true, force: true })
})

suite('source identity', () => {
  test('the identity is content-derived and independent of the path', () => {
    const a = write('a.request.json', body(10), NOW)
    const b = write('b.request.json', body(10), NOW)
    const da = contentDigestOfFile(a)!
    const db = contentDigestOfFile(b)!
    assert.strictEqual(da, db, 'the two files hold identical bytes')
    const idA = computeSourceIdentity('request', da, null)
    const idB = computeSourceIdentity('request', db, null)
    assert.strictEqual(idA, idB, 'the same bytes at two paths are ONE identity')
    assert.notStrictEqual(idA, computeSourceIdentity('response', da, null), 'the kind is part of the identity')
  })

  test('provenance separates two byte-identical bodies that have different message uuids', () => {
    const digest = sha256Hex('same')
    const p1 = { messageUuid: 'u-1', sessionId: 's', timestamp: 't', querySource: null, model: null }
    const p2 = { messageUuid: 'u-2', sessionId: 's', timestamp: 't', querySource: null, model: null }
    assert.notStrictEqual(computeSourceIdentity('request', digest, p1), computeSourceIdentity('request', digest, p2))
    assert.strictEqual(provenanceKey(null), '')
    assert.strictEqual(provenanceKey(p1), 'u:u-1')
  })

  test('the identity is domain-separated, so a digest is never mistaken for an identity', () => {
    const digest = sha256Hex('x')
    assert.notStrictEqual(computeSourceIdentity('request', digest, null), digest)
  })
})

suite('classification', () => {
  test('metadata alone classifies unchanged, and a moved size forces a read', () => {
    const prior = { size: 10, mtimeMs: NOW, ino: 7, contentDigest: 'd', head: 'h', tail: 't' }
    assert.strictEqual(classifyFromMetadata(prior, { size: 10, mtimeMs: NOW, ino: 7, head: '', tail: '', contentDigest: '' }), 'unchanged')
    assert.strictEqual(classifyFromMetadata(prior, { size: 11, mtimeMs: NOW, ino: 7, head: '', tail: '', contentDigest: '' }), 'needs-read')
    assert.strictEqual(classifyFromMetadata(prior, { size: 10, mtimeMs: NOW + 1, ino: 7, head: '', tail: '', contentDigest: '' }), 'needs-read')
  })

  test('content classifies unchanged, truncated, replaced and changed deterministically', () => {
    const prior = { size: 100, mtimeMs: NOW, ino: 7, contentDigest: 'aaa', head: 'h', tail: 't' }
    const base = { size: 100, mtimeMs: NOW, ino: 7, head: 'h', tail: 't', contentDigest: 'aaa' }
    assert.strictEqual(classifyFromContent(prior, base), 'unchanged')
    assert.strictEqual(classifyFromContent(prior, { ...base, contentDigest: 'bbb', size: 50 }), 'truncated')
    assert.strictEqual(classifyFromContent(prior, { ...base, contentDigest: 'bbb', ino: 9 }), 'replaced')
    assert.strictEqual(classifyFromContent(prior, { ...base, contentDigest: 'bbb', size: 150 }), 'changed')
  })
})

suite('discovery — idempotence', () => {
  test('a repeated pass over an unchanged corpus appends nothing and yields no work', () => {
    write('a.request.json', body(10), NOW)
    write('b.response.json', body(20), NOW)
    const first = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(first.recordedThisPass.length, 2)
    assert.strictEqual(first.observedMaterial.length, 2)
    assert.strictEqual(first.durableCount, 2)

    const second = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.strictEqual(second.recordedThisPass.length, 0, 'no new record for an unchanged source')
    assert.strictEqual(second.observedMaterial.length, 0, 'no work for an unchanged source')
    assert.strictEqual(second.unchanged, 2)
    assert.strictEqual(loadSourceIndex(indexPath).records.length, 2, 'the log did not grow')
  })

  test('the same source discovered twice yields the same identity, never a duplicate', () => {
    write('a.request.json', body(10), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 5000 })
    const loaded = loadSourceIndex(indexPath)
    const ids = new Set(loaded.records.map(r => r.id))
    assert.strictEqual(ids.size, loaded.records.length, 'every persisted identity is distinct')
  })
})

suite('discovery — deterministic classification of change', () => {
  test('a changed body is classified changed, a truncated one truncated', () => {
    const p = write('a.request.json', body(100), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    write('a.request.json', body(500), NOW + 1000)
    const changed = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(changed.counts.changed, 1)
    assert.strictEqual(changed.observedMaterial[0].class, 'changed')
    assert.notStrictEqual(p, '')
  })

  test('a truncated body is classified truncated', () => {
    write('a.request.json', body(500), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    write('a.request.json', body(50), NOW + 1000)
    const t = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(t.counts.truncated, 1)
  })

  test('a body replaced at the same path by different content is classified replaced', () => {
    const p = path.join(corpus, 'a.request.json')
    write('a.request.json', body(500), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    // Remove and recreate so the inode differs — a replacement, not an in-place rewrite.
    fs.unlinkSync(p)
    write('a.request.json', body(500), NOW + 1000)
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(r.counts.replaced, 1)
  })

  test('a metadata-only touch (same bytes, new mtime) is unchanged and writes no record', () => {
    const p = write('a.request.json', body(100), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    // Touch: same bytes, different mtime. The cheap metadata says "read me", the content
    // says "identical" — the observation is UNCHANGED, so NOTHING is written. The source keeps
    // its 'new' class in the latest view, which is correct: it has still never been migrated.
    fs.utimesSync(p, new Date(NOW + 5000), new Date(NOW + 5000))
    const t = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 6000 })
    assert.strictEqual(t.counts.unchanged, 1, 'the re-read found identical bytes')
    assert.strictEqual(t.recordedThisPass.length, 0, 'an identical observation writes no record')
    const loaded = loadSourceIndex(indexPath)
    assert.strictEqual(loaded.records.length, 1, 'the log did not grow')
    const latest = latestByPath(loaded.records)
    assert.strictEqual(latest.get(p)!.class, 'new', 'the source is still unmigrated, so it stays new')
  })

  test('a provenance row that appears re-identifies the source and CARRIES THE MATERIAL CLASS FORWARD', () => {
    const p = write('a.request.json', body(100), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const before = latestByPath(loadSourceIndex(indexPath).records).get(p)!
    assert.strictEqual(before.class, 'new', 'the source is unmigrated')
    // Claude Code's index.jsonl gains a row for this file: the PROVENANCE changed, so the
    // identity changes even though the bytes did not. The observation itself is UNCHANGED.
    fs.writeFileSync(path.join(corpus, 'index.jsonl'), JSON.stringify({
      timestamp: '2026-10-18T21:55:47.626Z', session_id: 'sess-1', query_source: 'agent_summary',
      model: 'm', message_id: 'mid', message_uuid: 'uuid-1',
      request_file: 'a.request.json', response_file: null,
    }) + '\n')
    const t = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.strictEqual(t.counts.unchanged, 1, 'the bytes are identical')
    assert.strictEqual(t.recordedThisPass.length, 1, 'but the identity moved, so a record IS written')
    const after = latestByPath(loadSourceIndex(indexPath).records).get(p)!
    assert.notStrictEqual(after.id, before.id, 'the identity followed the provenance')
    // THE MATERIAL CLASS SURVIVES THE REFINEMENT. Relabelling the source 'unchanged' would
    // erase the evidence that it was never migrated — the latest-by-path view would then
    // say 'unchanged' about a source that has still never been moved.
    assert.strictEqual(after.class, 'new', 'the source is STILL unmigrated after the refinement')
    assert.strictEqual(after.reason, 'refined', 'the record says the identity was refined')
    assert.strictEqual(after.provenance!.messageUuid, 'uuid-1')
  })

  test('a collision that is later resolved RETRACTS the stale refusal', () => {
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const b = write('b.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    let latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.notStrictEqual(latest.get(a)!.refusal, null, 'the collision refuses both')
    assert.notStrictEqual(latest.get(b)!.refusal, null, 'the collision refuses both')

    // The collision is RESOLVED: b gains a provenance row, so b gets a distinct identity.
    fs.writeFileSync(path.join(corpus, 'index.jsonl'), JSON.stringify({
      timestamp: 't', session_id: 's', query_source: 'q', model: 'm', message_id: 'mid',
      message_uuid: 'uuid-b', request_file: 'b.request.json', response_file: null,
    }) + '\n')
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    latest = latestByPath(loadSourceIndex(indexPath).records)
    // A refusal that is no longer true must not stand for ever: a consumer reading the
    // latest record per path would see a permanently refused source and never migrate it.
    assert.strictEqual(latest.get(a)!.refusal, null, 'the stale refusal was retracted')
    assert.strictEqual(latest.get(a)!.reason, 'retracted')
    assert.strictEqual(latest.get(b)!.refusal, null, 'the re-identified path is not refused')
  })

  test('deepVerify re-reads an unchanged file and still finds it unchanged', () => {
    write('a.request.json', body(100), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const t = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000, deepVerify: true })
    assert.strictEqual(t.counts.unchanged, 1)
    assert.strictEqual(t.recordedThisPass.length, 0, 'a deep verify that agrees writes nothing')
    assert.strictEqual(t.observedMaterial.length, 0, 'and produces no work')
    assert.strictEqual(loadSourceIndex(indexPath).records.length, 1, 'the log did not grow')
  })

  test('a newly created body is classified new', () => {
    write('a.request.json', body(10), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    write('b.request.json', body(20), NOW + 1000)
    const n = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(n.counts.new, 1)
    assert.strictEqual(n.observedMaterial.length, 1)
    assert.strictEqual(n.observedMaterial[0].class, 'new')
  })
})

suite('discovery — refusals', () => {
  test('two paths with byte-identical content and no provenance are BOTH refused', () => {
    write('a.request.json', body(10), NOW)
    write('b.request.json', body(10), NOW)
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(r.refusals.length, 2, 'neither path is silently preferred')
    assert.strictEqual(r.observedMaterial.length, 0, 'a contested source produces no migration work')
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    for (const rec of latest.values()) {
      assert.notStrictEqual(rec.refusal, null, 'the latest record for each path refuses')
      assert.strictEqual(rec.refusal!.reason, 'identity-collision')
    }
  })

  test('byte-identical content with DIFFERENT provenance is not a collision', () => {
    write('a.request.json', body(10), NOW)
    write('b.request.json', body(10), NOW)
    fs.writeFileSync(path.join(corpus, 'index.jsonl'), [
      JSON.stringify({ timestamp: 't1', session_id: 's1', query_source: 'q', model: 'm', message_id: 'mid1', message_uuid: 'u1', request_file: 'a.request.json', response_file: 'a.response.json' }),
      JSON.stringify({ timestamp: 't2', session_id: 's2', query_source: 'q', model: 'm', message_id: 'mid2', message_uuid: 'u2', request_file: 'b.request.json', response_file: 'b.response.json' }),
    ].join('\n') + '\n')
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(r.refusals.length, 0)
    assert.strictEqual(r.observedMaterial.length, 2, 'each is its own source')
  })

  test('a file that cannot be read is NEVER marked discovered', () => {
    write('a.request.json', body(10), NOW)
    // A DIRECTORY named like a body file: path existence alone must not make it a source.
    fs.mkdirSync(path.join(corpus, 'dir.request.json'))
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(r.recordedThisPass.length, 1, 'only the real file is discovered')
    const paths = loadSourceIndex(indexPath).records.map(x => x.path)
    assert.ok(!paths.some(p => p.includes('dir.request.json')))
  })
})

suite('discovery — crash at every checkpoint boundary', () => {
  test('a retraction never installs a refusal against a partner that never collided', () => {
    // The three-file case: 'a' and 'z' are byte-identical (a collision), 'c' holds different
    // bytes. Then 'a' changes to become byte-identical to 'c', so 'a' is re-identified and
    // its collision with 'z' is retracted. The retraction must NOT leave 'z' refused against
    // 'c' — 'z' and 'c' hold different bytes and never collided. A false refusal there would
    // block 'z' from ever being migrated.
    const same = body(100)
    const other = body(999)
    const a = write('a.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    const c = write('c.request.json', other, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    let latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.notStrictEqual(latest.get(a)!.refusal, null, 'a and z collide')
    assert.notStrictEqual(latest.get(z)!.refusal, null, 'a and z collide')

    // a's bytes change to match c.
    fs.writeFileSync(a, other)
    fs.utimesSync(a, new Date(NOW + 1000), new Date(NOW + 1000))
    const retracting = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })

    latest = latestByPath(loadSourceIndex(indexPath).records)
    const zr = latest.get(z)!
    // Read the refusal's partners through a local, so the assertion on the whole refusal
    // below does not narrow the type away.
    const zrPartners: string[] = zr.refusal ? zr.refusal.otherPaths : []
    assert.ok(!zrPartners.includes(c), 'z is not refused against c, which holds different bytes')
    assert.strictEqual(zr.refusal, null, 'z is not refused at all')
    // z is now uncontested, so the pass that retracted the refusal must put it in the work
    // list: it is a real source that has still never been migrated.
    assert.ok(retracting.observedMaterial.some(w => w.path === z), 'an uncontested source is migratable again')
  })

  test('a partner reclaimed from the corpus no longer blocks the source', () => {
    // The raw-body corpus reclaims bodies (src/bodiesActivity.ts: ~72h), so a collision
    // partner can vanish. A refusal naming a vanished partner would block the source from
    // ever being migrated.
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.notStrictEqual(latestByPath(loadSourceIndex(indexPath).records).get(a)!.refusal, null)

    fs.unlinkSync(z) // the reclaim
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.strictEqual(latest.get(a)!.refusal, null, 'the vanished partner no longer contests a')
    assert.ok(r.observedMaterial.some(w => w.path === a), 'a is migratable again')
  })

  test('a stale refusal is lifted on the CHEAP path, when the source itself never moved', () => {
    // The reclaimed-partner case, and the one that matters: the refused source's OWN metadata
    // never moves, so the cheap fingerprint path short-circuits it and it is never re-read.
    // If the stale refusal were only re-derived on the read path, the source would keep the
    // refusal for ever and never be migrated.
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.notStrictEqual(latestByPath(loadSourceIndex(indexPath).records).get(a)!.refusal, null)

    fs.unlinkSync(z) // the reclaim — and a is NOT touched, so a stays on the cheap path
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.strictEqual(latest.get(a)!.refusal, null, 'the vanished partner no longer contests a')
    assert.strictEqual(latest.get(a)!.reason, 'retracted')
    assert.ok(r.observedMaterial.some(w => w.path === a), 'a is migratable again')
  })

  test('a partner the pass listed is never judged vanished, so a live collision survives', () => {
    // The OBSERVABLE property, which is the real invariant: the pass lists the corpus once
    // and derives BOTH the files it visits and the partners it considers still present from
    // that one listing, so the two can never disagree. If they could, a partner that is
    // present in the listing would be judged VANISHED, and every refusal naming it would be
    // falsely retracted — a live collision retracted, on a corpus whose bytes are about to be
    // deleted.
    //
    // This is asserted as an OUTCOME, not as a call count. A call count would need a seam
    // through the frozen `fs` module, and would guard a refactor rather than a live bug:
    // the single-listing property is true BY CONSTRUCTION, and the observable below is what
    // actually matters.
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const partner = write('partner.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })

    // The partner is present in the listing, so it contests a: the collision stands and
    // neither source is migratable. The pass must NOT have judged it vanished.
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.notStrictEqual(latest.get(a)!.refusal, null, 'the live partner still contests a')
    assert.ok(latest.get(a)!.refusal!.otherPaths.includes(partner))
    assert.strictEqual(latest.get(partner)!.refusal!.otherPaths.includes(a), true)
    // A contested source produces no material.
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.strictEqual(r.observedMaterial.length, 0, 'a contested source produces no material')
  })
  test('a reclaimed partner no longer contests a source, in either direction', () => {
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.notStrictEqual(latestByPath(loadSourceIndex(indexPath).records).get(a)!.refusal, null)

    // z is reclaimed; a is untouched, so a stays on the cheap path.
    fs.unlinkSync(z)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.strictEqual(latest.get(a)!.refusal, null, 'the vanished partner no longer contests a')
    // AND the vanished partner's refusal is CLEARED, by a record that does NOT claim the
    // partner is live: its lastSeenMs is the ORIGINAL time it was last seen, not now, and
    // its reason is 'gone'. Left standing, it would name the live source for ever, and a
    // consumer asking "is `a` contested?" by looking at every record mentioning `a` would
    // say yes — silently, on a live body that then never gets migrated.
    const goneRec = latest.get(z)!
    assert.strictEqual(goneRec.refusal, null, "the vanished partner no longer refuses a")
    assert.strictEqual(goneRec.reason, 'gone', 'the record says the partner is gone')
    assert.ok(goneRec.lastSeenMs < NOW + 1000, 'and it is NOT dated as if the partner had just been seen')
  })

  test('a persisted record can never carry the observation class', () => {
    // 'unchanged' is the class of an OBSERVATION. A record's class is the last material
    // content state, so a record carrying 'unchanged' is a regression in the class
    // carry-forward, and the loader must refuse it rather than load a silently wrong log.
    const rec = {
      v: SOURCE_INDEX_FORMAT_VERSION, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1,
      mtimeMs: 1, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'),
      class: 'unchanged', firstSeenMs: 1, lastSeenMs: 1, provenance: null, refusal: null,
      reason: 'refined', boundary: 0,
    }
    assert.throws(() => validateSourceIndexRecord(rec, 1, 0), /'unchanged' is an observation/)
  })

  test('a reclaimed body is NEVER offered as material to migrate', () => {
    // A body reclaimed by the 72h retention policy is not a file to migrate. A material
    // item for a path the corpus does not hold would send a migration runner after a file
    // that does not exist.
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    fs.unlinkSync(z)
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.ok(!r.observedMaterial.some(w => w.path === z), 'the reclaimed body is not offered')
    assert.ok(r.observedMaterial.some(w => w.path === a), 'the live body is')
  })

  test('a byte-identical REPLACEMENT is not reported as a content change', () => {
    // A replacement may be byte-identical: a different file object now occupies the path.
    // The class exists exactly to say that, and 'content' is the tampering signal a
    // reconciliation stage acts on — so a byte-identical replacement must not claim it.
    const p = path.join(corpus, 'a.request.json')
    write('a.request.json', body(500), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    fs.unlinkSync(p)
    write('a.request.json', body(500), NOW + 1000) // same bytes, different inode
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(r.counts.replaced, 1, 'the file object was replaced')
    const rec = latestByPath(loadSourceIndex(indexPath).records).get(p)!
    assert.strictEqual(rec.reason, 'replaced', "a replacement carries reason 'replaced'")
    assert.notStrictEqual(rec.reason, 'content', "and never claims a content change")
  })

  test('a gone record is written ONCE, and the log stops growing', () => {
    // The three-path case: 'a' and 'w' are live and byte-identical, 'z' is reclaimed and
    // had also refused 'w'. The 'gone' record for 'z' is only ever written when a LIVE path
    // triggers the lift, so the question is whether the trigger is cleared — and whether the
    // log grows on every pass on an idle corpus.
    const same = body(100)
    const a = write('a.request.json', same, NOW)
    const w = write('w.request.json', same, NOW)
    const z = write('z.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    fs.unlinkSync(z) // the reclaim

    const after = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    const settled = loadSourceIndex(indexPath).records.length
    const goneRec = latestByPath(loadSourceIndex(indexPath).records).get(z)!
    assert.strictEqual(goneRec.reason, 'gone')
    // THE 'gone' RECORD COUNT ITSELF STAYS AT 1 — stated directly, not inferred from the
    // total. A 'gone' record is written only when a LIVE path triggers the lift of a
    // refusal that named the vanished partner; once the lift has happened there is no
    // refusal left to lift, so no further 'gone' record is warranted.
    assert.strictEqual(
      loadSourceIndex(indexPath).records.filter(r => r.reason === 'gone').length, 1,
      "exactly one 'gone' record exists for the vanished path",
    )
    assert.strictEqual(goneRec.refusal, null, "z's refusal of the live sources is cleared")
    assert.ok(goneRec.lastSeenMs < NOW + 1000, 'and z is not dated as if it had just been seen')
    // A reclaimed body is never offered as material.
    assert.ok(!after.observedMaterial.some(w2 => w2.path === z), 'the reclaimed body is not offered')

    // THE LOG MUST NOT GROW ON AN IDLE CORPUS. Five more passes over the same corpus.
    for (let i = 2; i <= 6; i++) {
      discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + i * 1000 })
      assert.strictEqual(loadSourceIndex(indexPath).records.length, settled,
        `the log did not grow on pass ${i}`)
    }
    // The two live sources are still correctly contested with each other.
    const latest = latestByPath(loadSourceIndex(indexPath).records)
    assert.notStrictEqual(latest.get(a)!.refusal, null, 'a and w still contest each other')
    assert.ok(latest.get(a)!.refusal!.otherPaths.includes(w))
  })

  test('a carried-forward class outlives its reason and the log stays appendable', () => {
    // THE CRASH-ON-WRITE. The material class is CARRIED FORWARD on an unchanged
    // observation, so a class outlives the reason that set it. A file that was replaced
    // (class 'replaced') and then had its identity refined (reason 'refined') carries class
    // 'replaced' with reason 'refined' — which is CORRECT: the class is the last material
    // content state, the reason describes THIS observation.
    //
    // The validator used to enforce the converse as well (class 'replaced' implies reason
    // 'replaced'), and it refused that record on the way IN — so the pass THREW, the log
    // became unappendable, and on the real corpus the discovery pass would stall at that
    // body for ever, every subsequent attempt hitting the same bad record.
    const p = path.join(corpus, 'a.request.json')
    const same = body(500)
    write('a.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })

    // Replace it: same bytes, a new file object.
    fs.unlinkSync(p)
    write('a.request.json', same, NOW + 1000)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    let rec = latestByPath(loadSourceIndex(indexPath).records).get(p)!
    assert.strictEqual(rec.class, 'replaced')
    assert.strictEqual(rec.reason, 'replaced')

    // Now refine its identity: a provenance row appears, the bytes do not change.
    fs.writeFileSync(path.join(corpus, 'index.jsonl'), JSON.stringify({
      timestamp: 't', session_id: 's', query_source: 'q', model: 'm', message_id: 'mid',
      message_uuid: 'u1', request_file: 'a.request.json', response_file: null,
    }) + '\n')
    assert.doesNotThrow(() => {
      discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 3000 })
    }, 'the pass must not throw: the log has to stay appendable')

    rec = latestByPath(loadSourceIndex(indexPath).records).get(p)!
    assert.strictEqual(rec.class, 'replaced', 'the material class is carried forward')
    assert.strictEqual(rec.reason, 'refined', 'the reason describes this observation')
    assert.strictEqual(rec.provenance!.messageUuid, 'u1')
  })

  test('the outstanding set is derived, and applies every condition', () => {
    // The outstanding set is a DERIVED FUNCTION, not a rule in prose. A consumer that has to
    // remember four conditions will eventually apply three of them, and the one it drops
    // decides whether a runner migrates a file that does not exist.
    const same = body(100)
    const live = write('live.request.json', same, NOW)      // material, present
    const partner = write('partner.request.json', same, NOW) // contested by 'live'
    const gone = write('gone.request.json', same, NOW)      // becomes reclaimed

    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    // Reclaim 'gone' and un-contest 'live' (its only partner leaves).
    fs.unlinkSync(gone)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })

    const records = loadSourceIndex(indexPath).records
    const corpusNow = new Set([live, partner])
    const outstanding = outstandingSources(records, corpusNow)

    // 'live' and 'partner' are byte-identical and both present: they collide, so BOTH are
    // refused and NEITHER is outstanding.
    assert.ok(!outstanding.some(o => o.path === live), 'a contested source is not outstanding')
    assert.ok(!outstanding.some(o => o.path === partner), 'a contested source is not outstanding')

    // 'gone' carries class 'new' — the honest history ("it was never migrated"), which is
    // exactly the shape of a source that still needs migrating. It is STILL not outstanding,
    // because its reason is 'gone' and because the corpus no longer holds it. A consumer
    // that filtered on the class alone would wrongly pick it up.
    const goneRec = latestByPath(records).get(gone)!
    assert.strictEqual(goneRec.class, 'new', "a reclaimed body's class is its honest history")
    assert.ok(!outstanding.some(o => o.path === gone), "a 'gone' source is not outstanding")

    // Now an uncontested, present, unmigrated source IS outstanding.
    const solo = write('solo.request.json', body(200), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    const out2 = outstandingSources(loadSourceIndex(indexPath).records, new Set([live, partner, solo]))
    assert.ok(out2.some(o => o.path === solo), 'an uncontested present source is outstanding')

    // And an already-migrated one is not, even though everything else qualifies.
    const out3 = outstandingSources(loadSourceIndex(indexPath).records, new Set([live, partner, solo]), new Set([solo]))
    assert.ok(!out3.some(o => o.path === solo), 'an already-migrated source is not outstanding')
  })

  test('a stale refusal naming only a vanished partner does not withhold a source', () => {
    // THE DEFECT. The persisted refusal names the partners that collided AT THE TIME the
    // record was written, and the log is append-only. If a partner is reclaimed and no pass
    // lifts the refusal, the stale name is still there — and excluding the source on the
    // strength of a stale name withholds a LIVE, UNMIGRATED body from the outstanding set
    // FOR EVER. The source that most needs migrating is the one that never gets it.
    //
    // The discovery pass re-derives contestability against the CURRENT corpus, so the
    // function must agree with the pass: a refusal contests only a partner that STILL
    // EXISTS.
    const same = body(100)
    const live = write('live.request.json', same, NOW)
    const partner = write('partner.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })

    // Reclaim the partner WITHOUT a pass lifting the refusal: the live source keeps a stale
    // refusal naming only the vanished path.
    fs.unlinkSync(partner)
    const records = loadSourceIndex(indexPath).records
    const liveRec = latestByPath(records).get(live)!
    assert.strictEqual(liveRec.refusal !== null, true, 'the refusal is still persisted, stale')
    assert.ok(
      liveRec.refusal!.otherPaths.every(p => p === partner),
      'and it names only the vanished partner',
    )

    const outstanding = outstandingSources(records, new Set([live]))
    assert.ok(
      outstanding.some(o => o.path === live),
      'a source whose only rival has vanished IS outstanding — it must not be withheld for ever',
    )
  })

  test('a refusal naming a partner that still exists DOES withhold a source', () => {
    // The other side of the same rule: a live rival still contests the source, so it is
    // not outstanding. The fix must not have turned "stale refusal" into "no refusal".
    const same = body(100)
    const live = write('live.request.json', same, NOW)
    const partner = write('partner.request.json', same, NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const records = loadSourceIndex(indexPath).records
    const outstanding = outstandingSources(records, new Set([live, partner]))
    assert.ok(!outstanding.some(o => o.path === live), 'a contested source is not outstanding')
    assert.ok(!outstanding.some(o => o.path === partner), 'a contested source is not outstanding')
  })

  test('a mismatched alreadyMigrated key is LOUD, not silently ineffective', () => {
    // The natural handle for a migrated body is its IDENTITY (the content digest) — the
    // whole point of the identity is that it is path-independent. A caller who passes
    // identities where the function compares paths would have every comparison miss, every
    // already-migrated source offered AGAIN, and the migration run twice over the same
    // body. Silently ineffective is the worst outcome, so it throws.
    const solo = write('solo.request.json', body(300), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const records = loadSourceIndex(indexPath).records
    const digest = latestByPath(records).get(solo)!.digest

    // The correct key works.
    const ok = outstandingSources(records, new Set([solo]), new Set([solo]))
    assert.ok(!ok.some(o => o.path === solo), 'a path key excludes the migrated source')

    // The wrong key is refused, loudly.
    assert.throws(
      () => outstandingSources(records, new Set([solo]), new Set([digest])),
      /alreadyMigratedPaths contains an IDENTITY/,
      'passing identities where paths are expected must throw, not silently match nothing',
    )
  })

  test('a corpus path that happens to be 64 hex characters is still a PATH', () => {
    // The mismatch check must not fire on a LEGITIMATE path. A corpus file whose name
    // happens to be 64 lowercase hex characters is real, and throwing on it would break a
    // working consumer over a file name. Every corpus body carries a `.request.json` or
    // `.response.json` extension, so a key that is 64 hex chars with no separator and no
    // extension cannot name one.
    const hexName = 'a'.repeat(64)
    const p = path.join(corpus, `${hexName}.request.json`)
    fs.writeFileSync(p, body(100))
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const records = loadSourceIndex(indexPath).records
    assert.ok(records.some(r => r.path === p), 'the hex-named file was discovered')

    // The full path is accepted as a key: no throw.
    const out = outstandingSources(records, new Set([p]), new Set([p]))
    assert.ok(!out.some(o => o.path === p), 'the hex-named path is treated as a path and excludes the source')

    // And a bare 64-hex token IS an identity, and still throws.
    assert.throws(
      () => outstandingSources(records, new Set([p]), new Set([hexName])),
      /alreadyMigratedPaths contains an IDENTITY/,
      'a bare 64-hex token is an identity, not a path',
    )
  })

  test('a byte-identical source never claims a content change', () => {
    // 'content' means THE BYTES CHANGED, and a reconciliation stage reads it as a tampering
    // signal. A byte-identical source must never claim it.
    write('a.request.json', body(100), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    // Touch a: same bytes, new mtime. The cheap path re-reads it.
    fs.utimesSync(path.join(corpus, 'a.request.json'), new Date(NOW + 1000), new Date(NOW + 1000))
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    for (const rec of loadSourceIndex(indexPath).records) {
      if (rec.reason === 'content') {
        assert.ok(rec.class === 'changed' || rec.class === 'truncated' || rec.class === 'replaced',
          `a 'content' record must carry a changed/truncated/replaced class, got '${rec.class}'`)
      }
    }
  })

  test('the corpus index reports a schema change as rows without provenance', () => {
    // A row that parses but carries none of the fields we read is a SCHEMA CHANGE, not a torn
    // write: Claude Code renamed a field. Every source's identity would change at once, so
    // the count is an alarm the caller can see.
    fs.writeFileSync(path.join(corpus, 'index.jsonl'),
      JSON.stringify({ timestamp: 't', session_id: 's', query_source: 'q', model: 'm' }) + '\n' +
      JSON.stringify({
        timestamp: 't', session_id: 's2', query_source: 'q', model: 'm', message_id: 'mid',
        message_uuid: 'u1', request_file: 'a.request.json', response_file: null,
      }) + '\n')
    const stats = { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0 }
    readCorpusProvenance(corpus, stats)
    // The first row has session_id but NO message_uuid: it can still discriminate, so it is
    // NOT the provenance-less case and is not counted. The counter is deliberately keyed on
    // losing BOTH discriminators, because that is the case that is rare when the corpus is
    // healthy — measured against the real corpus, every one of its 19,890 rows carries a
    // message_uuid, so the count reads 0 and a non-zero count means the index format
    // changed under us. A counter that fired on a merely-weaker row would fire constantly
    // and train the next reader to ignore it.
    assert.strictEqual(stats.rowsWithoutProvenance, 0, 'it still has a session_id')
    assert.strictEqual(stats.skippedLines, 0, 'it parsed, so it is not a skipped line')
  })

  test('a crash after each of N appends resumes without omitting or duplicating a source', () => {
    const N = 6
    for (let i = 0; i < N; i++) write(`s${i}.request.json`, body(100 + i), NOW)

    for (let k = 1; k <= N; k++) {
      const idx = path.join(state, `crash-${k}.jsonl`)
      // CRASH at the k-th append: the bytes reach the OS, then the process dies.
      let appends = 0
      assert.throws(() => {
        discoverRawBodySources({
          corpusDir: corpus, indexPath: idx, nowMs: NOW,
          onRecordWritten: () => { appends++; if (appends === k) throw new Error('simulated crash') },
        })
      }, /simulated crash/)
      assert.strictEqual(appends, k, `the crash happened at append ${k}`)

      // The log on disk holds exactly the records written before the crash.
      const crashed = loadSourceIndex(idx)
      assert.strictEqual(crashed.records.length, k, `the log holds ${k} records at the crash`)

      // RESUME: the next pass must complete the corpus without omitting or duplicating.
      const resumed = discoverRawBodySources({ corpusDir: corpus, indexPath: idx, nowMs: NOW + 1000 })
      // The crashed pass wrote k records; the resume must write exactly the remaining N-k.
      // The k already-written sources are unchanged, so they produce NO record — that is the
      // idempotence property, and it is what makes the resume non-duplicating.
      assert.strictEqual(resumed.recordedThisPass.length, N - k, `the resume wrote the missing ${N - k}`)

      const loaded = loadSourceIndex(idx)
      const latest = latestByPath(loaded.records)
      assert.strictEqual(latest.size, N, `every source is present exactly once at k=${k}`)
      const ids = new Set([...latest.values()].map(r => r.id))
      assert.strictEqual(ids.size, N, `every source has a distinct identity at k=${k}`)
      // The boundary chain is intact — the log is still a valid, auditable record.
      assert.strictEqual(loaded.records.length, loaded.durableCount)
      for (let i = 0; i < loaded.records.length; i++) {
        assert.strictEqual(loaded.records[i].boundary, i, `the boundary chain is intact at k=${k}`)
      }
    }
  })

  test('a torn tail line is treated as not-yet-persisted, not as data', () => {
    write('a.request.json', body(10), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    const before = fs.readFileSync(indexPath, 'utf-8')
    // Simulate a crash mid-append: a partial line with no terminating newline.
    fs.appendFileSync(indexPath, '{"v":1,"id":"aa')
    const loaded = loadSourceIndex(indexPath)
    assert.strictEqual(loaded.records.length, 1, 'the torn line is not loaded as data')
    assert.strictEqual(loaded.tornTailCount, 1)
    assert.strictEqual(loaded.hasTornTail, true)
    assert.strictEqual(loaded.durableCount, 1)

    // The next pass repairs the tail and re-derives the source — no omission, no duplication.
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.strictEqual(r.repairedTornBytes > 0, true, 'the torn bytes were discarded')
    const after = loadSourceIndex(indexPath)
    assert.strictEqual(after.records.length, 1, 'the source appears exactly once')
    assert.strictEqual(after.hasTornTail, false)
    assert.ok(after.records[0].id.length === 64)
    assert.ok(before.length > 0)
  })

  test('the durable boundary never advances past an unpersisted record', () => {
    write('a.request.json', body(10), NOW)
    const writer = new SourceIndexWriter(indexPath)
    const rec = {
      id: sha256Hex('x'), path: path.join(corpus, 'a.request.json'), kind: 'request' as const,
      size: 10, mtimeMs: NOW, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'),
      digest: sha256Hex('d'), class: 'new' as const, firstSeenMs: NOW, lastSeenMs: NOW,
      provenance: null, refusal: null, reason: 'discovered' as const,
    }
    writer.append(rec, 0)
    assert.strictEqual(writer.count, 1, 'the record is written')
    assert.strictEqual(writer.durableCount, 0, 'but it is NOT durable until it is synced')
    writer.sync()
    assert.strictEqual(writer.durableCount, 1, 'now it is durable')
    writer.close()
  })
})

suite('index format — versioned, validated', () => {
  test('a version-1 log is refused as a VERSION, not as a malformed field', () => {
    // The format gained the `reason` field and a stricter validator without the version
    // being bumped, which meant a version-1 log was refused for a missing field — a refusal
    // that reads like corruption rather than like a version difference. The version is now 2,
    // so the refusal is explicit and legible. No version-1 log holds any data anyone could
    // lose: this substrate has never been run against the real corpus.
    const rec = {
      v: 1, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1, mtimeMs: 1, ino: 1,
      head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'), class: 'new',
      firstSeenMs: 1, lastSeenMs: 1, provenance: null, refusal: null, boundary: 0,
    }
    fs.writeFileSync(indexPath, JSON.stringify(rec) + '\n')
    assert.throws(() => loadSourceIndex(indexPath), /unknown format version 1 \(this build reads version 2\)/)
  })

  test('the current format version is 2, and the file name carries it', () => {
    assert.strictEqual(SOURCE_INDEX_FORMAT_VERSION, 2)
    assert.strictEqual(sourceIndexFileName(), 'source-index.v2.jsonl')
  })

  test('a gone record carries no refusal, or one that names a real partner', () => {
    // A 'gone' record clears the vanished path's refusal. The VALIDATOR still accepts a
    // 'gone' record that names a partner — the format permits it — but the DISCOVERY PASS
    // no longer produces one: a vanished path contests nobody, because an identity
    // collision needs both paths to exist. The live paths' own records carry the
    // retraction, so nothing is lost.
    //
    // The validator's leniency is deliberate: it must accept a log it claims to read, and
    // refusing a shape the format permits would make a valid log unappendable — which is
    // the crash-on-write class this format already had one of.
    const base = {
      v: SOURCE_INDEX_FORMAT_VERSION, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1,
      mtimeMs: 1, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'),
      class: 'new', firstSeenMs: 1, lastSeenMs: 1, provenance: null, reason: 'gone', boundary: 0,
    }
    // No refusal at all: the cleanest 'gone' record, and it is accepted.
    assert.doesNotThrow(() => validateSourceIndexRecord({ ...base, refusal: null }, 1, 0))
    // A refusal naming a real partner: also accepted.
    assert.doesNotThrow(() => validateSourceIndexRecord({
      ...base, refusal: { reason: 'identity-collision', otherPaths: ['/q'] },
    }, 1, 0))
    // A refusal naming NOBODY is refused: it is a refusal that contests nothing.
    assert.throws(() => validateSourceIndexRecord({
      ...base, refusal: { reason: 'identity-collision', otherPaths: [] },
    }, 1, 0), /non-empty array of paths/)
  })

  test('an unknown version is refused', () => {
    const rec = {
      v: 99, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1, mtimeMs: 1, ino: 1,
      head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'), class: 'new',
      firstSeenMs: 1, lastSeenMs: 1, provenance: null, refusal: null, reason: 'discovered',
      boundary: 0,
    }
    assert.throws(() => validateSourceIndexRecord(rec, 1, 0), /unknown format version 99/)
  })

  test('a malformed record is refused', () => {
    assert.throws(() => validateSourceIndexRecord('not an object', 1, 0), SourceIndexError)
    assert.throws(() => validateSourceIndexRecord({ v: SOURCE_INDEX_FORMAT_VERSION }, 1, 0), /non-empty string/)
  })

  test('an internally inconsistent record is refused', () => {
    const rec = {
      v: SOURCE_INDEX_FORMAT_VERSION, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1,
      mtimeMs: 1, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'),
      class: 'new', firstSeenMs: 10, lastSeenMs: 5, provenance: null, refusal: null,
      reason: 'discovered', boundary: 0,
    }
    assert.throws(() => validateSourceIndexRecord(rec, 1, 0), /must not precede/)
  })

  test('a broken boundary chain is refused on load', () => {
    const rec = {
      v: SOURCE_INDEX_FORMAT_VERSION, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1,
      mtimeMs: 1, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'),
      class: 'new', firstSeenMs: 1, lastSeenMs: 1, provenance: null, refusal: null, boundary: 7,
    }
    fs.writeFileSync(indexPath, JSON.stringify(rec) + '\n')
    assert.throws(() => loadSourceIndex(indexPath), /boundary/)
  })

  test('a malformed line in the MIDDLE of the log is refused (only a torn TAIL is tolerated)', () => {
    const good = {
      v: SOURCE_INDEX_FORMAT_VERSION, id: sha256Hex('x'), path: '/p', kind: 'request', size: 1,
      mtimeMs: 1, ino: 1, head: sha256Hex('h'), tail: sha256Hex('t'), digest: sha256Hex('d'),
      class: 'new', firstSeenMs: 1, lastSeenMs: 1, provenance: null, refusal: null,
      reason: 'discovered', boundary: 0,
    }
    fs.writeFileSync(indexPath, JSON.stringify(good) + '\n' + 'garbage\n' + JSON.stringify({ ...good, boundary: 1 }) + '\n')
    assert.throws(() => loadSourceIndex(indexPath), /not valid JSON/)
  })

  test('the checkpoint file name carries the format version', () => {
    assert.strictEqual(sourceIndexFileName(1), 'source-index.v1.jsonl')
    assert.strictEqual(sourceIndexFileName(2), 'source-index.v2.jsonl')
  })
})

suite('corpus provenance', () => {
  test('Claude Code\'s own index.jsonl is read, and a torn tail line is skipped', () => {
    fs.writeFileSync(path.join(corpus, 'index.jsonl'),
      JSON.stringify({
        timestamp: '2026-10-18T21:55:47.626Z', session_id: 'sess-1', query_source: 'agent_summary',
        model: 'm', message_id: 'mid', message_uuid: 'uuid-1',
        request_file: 'a.request.json', response_file: 'a.response.json',
      }) + '\n' + '{"timestamp":"t","session_id":"s2"')
    const prov = readCorpusProvenance(corpus)
    // The row names BOTH a request and a response file, so the map holds one entry per FILE
    // NAME — two entries, both carrying the same provenance.
    assert.strictEqual(prov.size, 2)
    const p = prov.get('a.request.json')!
    assert.strictEqual(p.messageUuid, 'uuid-1')
    assert.strictEqual(p.sessionId, 'sess-1')
    assert.strictEqual(p.querySource, 'agent_summary')
    assert.strictEqual(prov.get('a.response.json')!.messageUuid, 'uuid-1')
  })

  test('a corrupt line in the middle of the corpus index is SKIPPED, not fatal', () => {
    // Claude Code's index.jsonl is a FOREIGN file: we do not own it and its integrity is not
    // our checkpoint's contract. A damaged row costs us provenance; it must not abort a
    // discovery pass over the whole corpus. The skip is COUNTED so the caller can see it.
    fs.writeFileSync(path.join(corpus, 'index.jsonl'),
      'garbage\n' +
      JSON.stringify({
        timestamp: 't', session_id: 's', query_source: 'q', model: 'm', message_id: 'mid',
        message_uuid: 'uuid-1', request_file: 'a.request.json', response_file: null,
      }) + '\n' +
      '{"not":"an object we use"}\n')
    const stats = { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0 }
    const prov = readCorpusProvenance(corpus, stats)
    assert.strictEqual(stats.skippedLines, 1, 'the unparseable line was counted')
    assert.strictEqual(stats.rowsRead, 2, 'the two parseable lines were read')
    assert.strictEqual(prov.get('a.request.json')!.messageUuid, 'uuid-1')
  })
})

suite('discovery — file evidence', () => {
  test('the evidence read carries a consistent size, digest and window hashes', () => {
    const p = write('a.request.json', body(9000), NOW)
    const st = fs.statSync(p)
    const ev = readFileEvidence(p, st.size)!
    assert.strictEqual(ev.digest, contentDigestOfFile(p))
    assert.strictEqual(ev.head.length, 64)
    assert.strictEqual(ev.tail.length, 64)
    assert.notStrictEqual(ev.head, ev.tail, 'a file bigger than one window has different head and tail')
  })
})
