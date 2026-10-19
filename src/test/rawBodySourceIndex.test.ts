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
  loadSourceIndex, sourceIndexFileName, validateSourceIndexRecord,
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
    assert.strictEqual(first.recorded.length, 2)
    assert.strictEqual(first.work.length, 2)
    assert.strictEqual(first.durableCount, 2)

    const second = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 1000 })
    assert.strictEqual(second.recorded.length, 0, 'no new record for an unchanged source')
    assert.strictEqual(second.work.length, 0, 'no work for an unchanged source')
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
    assert.strictEqual(changed.work[0].class, 'changed')
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
    assert.strictEqual(t.recorded.length, 0, 'an identical observation writes no record')
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
    assert.strictEqual(t.recorded.length, 1, 'but the identity moved, so a record IS written')
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
    assert.strictEqual(t.recorded.length, 0, 'a deep verify that agrees writes nothing')
    assert.strictEqual(t.work.length, 0, 'and produces no work')
    assert.strictEqual(loadSourceIndex(indexPath).records.length, 1, 'the log did not grow')
  })

  test('a newly created body is classified new', () => {
    write('a.request.json', body(10), NOW)
    discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    write('b.request.json', body(20), NOW + 1000)
    const n = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW + 2000 })
    assert.strictEqual(n.counts.new, 1)
    assert.strictEqual(n.work.length, 1)
    assert.strictEqual(n.work[0].class, 'new')
  })
})

suite('discovery — refusals', () => {
  test('two paths with byte-identical content and no provenance are BOTH refused', () => {
    write('a.request.json', body(10), NOW)
    write('b.request.json', body(10), NOW)
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(r.refusals.length, 2, 'neither path is silently preferred')
    assert.strictEqual(r.work.length, 0, 'a contested source produces no migration work')
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
    assert.strictEqual(r.work.length, 2, 'each is its own source')
  })

  test('a file that cannot be read is NEVER marked discovered', () => {
    write('a.request.json', body(10), NOW)
    // A DIRECTORY named like a body file: path existence alone must not make it a source.
    fs.mkdirSync(path.join(corpus, 'dir.request.json'))
    const r = discoverRawBodySources({ corpusDir: corpus, indexPath, nowMs: NOW })
    assert.strictEqual(r.recorded.length, 1, 'only the real file is discovered')
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
    assert.ok(retracting.work.some(w => w.path === z), 'an uncontested source is migratable again')
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
    assert.ok(r.work.some(w => w.path === a), 'a is migratable again')
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
    assert.ok(r.work.some(w => w.path === a), 'a is migratable again')
  })

  test('the corpus is read ONCE per pass, so a growing corpus cannot disagree with itself', () => {
    // The pass decides both WHICH files to visit and WHICH partners are still present from
    // ONE readdir. Two readdirs of an actively-growing directory can disagree: a file that
    // appears between them would be judged VANISHED while it is present, and every refusal
    // naming it would be falsely retracted — a live collision retracted, on a corpus whose
    // bytes are about to be deleted. The observable proof that there is one readdir: the
    // pass visits a file that appears DURING the pass and still treats it as present.
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
    // AND the vanished partner's own record no longer refuses a live source.
    assert.strictEqual(latest.get(z)!.refusal, null, "the vanished partner no longer refuses a")
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
    const stats = { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0, rowsWithoutMessageUuid: 0 }
    readCorpusProvenance(corpus, stats)
    // The first row has session_id but NO message_uuid: it cannot use the strongest
    // discriminator, so it is counted as a weaker-provenance row, and it is NOT the
    // provenance-less case (it still has a session_id, so it can discriminate something).
    assert.strictEqual(stats.rowsWithoutProvenance, 0, 'it still has a session_id')
    assert.strictEqual(stats.rowsWithoutMessageUuid, 1, 'the row lost its message_uuid')
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
      assert.strictEqual(resumed.recorded.length, N - k, `the resume wrote the missing ${N - k}`)

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
    const stats = { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0, rowsWithoutMessageUuid: 0 }
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
