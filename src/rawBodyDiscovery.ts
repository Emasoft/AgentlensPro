// rawBodyDiscovery — the idempotent, restartable discovery pass over the raw-body corpus.
//
// WHAT IT DOES: walks the corpus dir, and for every body file decides (a) whether it is NEW,
// UNCHANGED, CHANGED, TRUNCATED or REPLACED with respect to the persisted checkpoint, (b) what
// its content-derived identity is, and (c) whether that identity is already claimed by another
// path. The results are appended to the checkpoint; the checkpoint is the ONLY durable output.
//
// IDEMPOTENCE: a source that is UNCHANGED produces NO new record and NO work item. Re-running
// discovery over an unchanged corpus therefore appends nothing and yields an empty work list —
// the property the acceptance criteria demand. The identity is content-derived, so a re-run
// recomputes the same identity for the same bytes.
//
// DETERMINISM UNDER CONCURRENT GROWTH: the corpus is being written WHILE we scan. A file can
// appear, grow, be replaced or vanish between the readdir and the read. The pass therefore:
//   - skips a file that vanished (ENOENT) instead of crashing,
//   - re-stats and re-reads a file whose size moved between the stat and the read, so the
//     persisted (size, digest) pair is always a consistent snapshot of ONE version of the file,
//   - never lets a file's ABSENCE or a read failure mark it discovered — a source whose
//     identity evidence cannot be read is NOT discovered (the card's explicit refusal).
//
// THE COST SHAPE: a full content digest of 205GB on every pass is not a plan, so the cheap
// fingerprint (size + mtime + inode + head/tail window hash) decides whether the file must be
// read at all. A file whose fingerprint matches the persisted one is UNCHANGED and is never
// read. A file whose fingerprint moved is read, its digest recomputed, and its class derived
// from the digest — which is the only place a full read is justified.
//
// PROVENANCE: Claude Code writes its own `index.jsonl` into the corpus dir, mapping a captured
// body to { message_uuid, session_id, timestamp, query_source, model }. That file is READ-ONLY
// here and is TORN-SAFE on load (its last line may be a partial append). A source with no
// provenance row still gets an identity — a content-and-kind identity — but two such sources
// with identical bytes are an AMBIGUOUS COLLISION and are refused.
//
// THE COLLISION IS REFUSED SYMMETRICALLY, NOT IN FAVOUR OF THE FIRST SEEN. When two paths hold
// byte-identical content and share no provenance, NEITHER can be the source: the checkpoint
// records a refusal for BOTH. Because the log is append-only, the refusal for the earlier
// claimant is appended as a CORRECTION record once the collision is detected. A consumer reads
// the LATEST record per path (see `latestByPath`), and a refusal there disqualifies the source.
// The intermediate non-refusal record stays in the log as history, exactly as the append-only
// contract requires — it is superseded, not erased.
//
// THE WORK LIST IS DERIVED FROM THE FINAL STATE OF THE PASS, not from the state at the moment
// each record was written. A source discovered as uncontested and THEN found to collide must
// end up with NO work, because the refusal for it lands later in the same pass. Computing the
// work list at the end is what makes that true without a retraction mechanism the append-only
// log does not have.
//
// MEMORY: the pass holds one map entry per distinct identity (~one per source) to detect
// collisions. For the full 800k-file corpus that is a few hundred MB — proportionate to an
// operation over 205GB, and bounded by `maxFiles` for a batched run.
import * as fs from 'fs'
import * as path from 'path'
import {
  CurrentState, PriorState, SourceClass, SourceKind, SourceProvenance,
  classifyFromContent, classifyFromMetadata, computeSourceIdentity, provenanceKey,
  readFileEvidence,
} from './rawBodySourceIdentity'
import {
  SourceIndexRecord, SourceIndexWriter, loadSourceIndex, latestByPath,
} from './rawBodySourceIndex'

/** The provenance map, keyed by corpus file name. */
export type CorpusProvenanceMap = Map<string, SourceProvenance>

/**
 * Read Claude Code's own `index.jsonl` from the corpus dir. It is written concurrently by
 * Claude Code, so its final line may be a partial append: a line that does not parse is
 * SKIPPED (it is not yet durable on their side) rather than fatal. A line that parses but is
 * structurally wrong IS refused — that is corruption, not a torn write.
 */
export function readCorpusProvenance(corpusDir: string): CorpusProvenanceMap {
  const out: CorpusProvenanceMap = new Map()
  const indexPath = path.join(corpusDir, 'index.jsonl')
  let raw: string
  try {
    raw = fs.readFileSync(indexPath, 'utf-8')
  } catch {
    return out
  }
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    if (text.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // Only the LAST line can be a torn append; anything else is corruption.
      if (i === lines.length - 1) continue
      throw new Error(`corpus index.jsonl line ${i + 1} is not valid JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`corpus index.jsonl line ${i + 1} is not an object`)
    }
    const j = parsed as Record<string, unknown>
    const str = (k: string): string | null => (typeof j[k] === 'string' ? (j[k] as string) : null)
    const provenance: SourceProvenance = {
      messageUuid: str('message_uuid'),
      sessionId: str('session_id'),
      timestamp: str('timestamp'),
      querySource: str('query_source'),
      model: str('model'),
    }
    const req = str('request_file')
    const resp = str('response_file')
    if (req) out.set(req, provenance)
    if (resp) out.set(resp, provenance)
  }
  return out
}

/** The name shape of a body file. Anything else in the dir is not a source. */
export function bodyFileKind(name: string): SourceKind | null {
  if (name.endsWith('.request.json')) return 'request'
  if (name.endsWith('.response.json')) return 'response'
  return null
}

/** One discovered source, as it was written to (or withheld from) the checkpoint. */
export interface DiscoveredSource {
  path: string
  kind: SourceKind
  class: SourceClass
  id: string
  size: number
  mtimeMs: number
  ino: number
  head: string
  tail: string
  digest: string
  provenance: SourceProvenance | null
  firstSeenMs: number
  lastSeenMs: number
  refusal: { reason: 'identity-collision'; otherPaths: string[] } | null
}

/** One unit of work a later migration stage must do for this source. */
export interface DiscoveredWork {
  path: string
  id: string
  kind: SourceKind
  class: SourceClass
  size: number
  digest: string
}

/** The outcome of a discovery pass. */
export interface DiscoveryResult {
  /** Sources this pass appended to the checkpoint. */
  recorded: DiscoveredSource[]
  /** Sources that need migration work (a NEW/CHANGED/TRUNCATED/REPLACED source, not a refusal). */
  work: DiscoveredWork[]
  /** Sources whose identity is contested — the latest record for each of these paths refuses. */
  refusals: DiscoveredSource[]
  /** How many body files were seen in the corpus dir. */
  scannedFiles: number
  /** How many files were skipped because they vanished mid-scan. */
  vanished: number
  /** How many files could not be read (no identity evidence) — never marked discovered. */
  unreadable: number
  /** How many sources were unchanged and therefore produced no record and no work. */
  unchanged: number
  /** The durable boundary at the end of the pass. */
  durableCount: number
  /** The class tally. */
  counts: Record<SourceClass, number>
  /** Bytes of a torn tail discarded before this pass's first append. */
  repairedTornBytes: number
}

/** Options for a discovery pass. */
export interface DiscoveryOptions {
  /** The corpus dir to walk. */
  corpusDir: string
  /** The checkpoint file to read and append to. */
  indexPath: string
  /** Now, in ms — injectable so the tests are deterministic. */
  nowMs: number
  /** Re-read the head/tail window of every file even when the metadata says unchanged. */
  deepVerify?: boolean
  /** Cap on how many files a single pass processes (0 = no cap). Used by tests and batched runs. */
  maxFiles?: number
  /**
   * CRASH-INJECTION SEAM (tests only): called after each record reaches the OS but before the
   * writer counts it. Throwing from it simulates a crash at that exact checkpoint boundary.
   * Production callers leave it undefined.
   */
  onRecordWritten?: () => void
}

/** A source's persisted state, as the classifier needs it. */
function priorStateOf(record: SourceIndexRecord): PriorState {
  return {
    size: record.size,
    mtimeMs: record.mtimeMs,
    ino: record.ino,
    contentDigest: record.digest,
    head: record.head,
    tail: record.tail,
  }
}

/** Two refusal records describe the same collision. */
function sameRefusal(
  a: { reason: 'identity-collision'; otherPaths: string[] } | null,
  b: { reason: 'identity-collision'; otherPaths: string[] } | null,
): boolean {
  if (a === null || b === null) return a === b
  if (a.reason !== b.reason) return false
  if (a.otherPaths.length !== b.otherPaths.length) return false
  for (let i = 0; i < a.otherPaths.length; i++) {
    if (a.otherPaths[i] !== b.otherPaths[i]) return false
  }
  return true
}

/**
 * One discovery pass. Idempotent: over an unchanged corpus it appends nothing and yields no
 * work. The checkpoint is written through an append-only writer, so a crash between two
 * records leaves the log at the last durable record and the next pass re-derives the rest.
 */
export function discoverRawBodySources(opts: DiscoveryOptions): DiscoveryResult {
  const counts: Record<SourceClass, number> = { new: 0, unchanged: 0, changed: 0, truncated: 0, replaced: 0 }
  const result: DiscoveryResult = {
    recorded: [], work: [], refusals: [], scannedFiles: 0, vanished: 0, unreadable: 0,
    unchanged: 0, durableCount: 0, counts, repairedTornBytes: 0,
  }

  const loaded = loadSourceIndex(opts.indexPath)
  const prior = latestByPath(loaded.records)
  // Which paths currently claim each identity. A path that is RE-DISCOVERED under a different
  // identity stops claiming the old one, so the map always reflects the CURRENT state. A
  // REFUSED path still claims the identity: it has not been re-identified, and the claim is
  // what makes the collision detectable on the next pass.
  const claims = new Map<string, Set<string>>()
  for (const r of prior.values()) {
    let set = claims.get(r.id)
    if (!set) { set = new Set<string>(); claims.set(r.id, set) }
    set.add(r.path)
  }
  // The LATEST record per path, including the ones this pass has already written. The
  // symmetric refusal has to correct a claimant that was recorded moments ago in THIS pass,
  // not only one from a previous run — otherwise the first-seen path would keep its
  // non-refusal record and the collision would be resolved in its favour.
  const latest = new Map<string, SourceIndexRecord>(prior)

  let names: string[]
  try {
    names = fs.readdirSync(opts.corpusDir)
  } catch {
    return result
  }
  names.sort() // deterministic order, so two passes over the same corpus append in the same order

  const provenance = readCorpusProvenance(opts.corpusDir)
  const writer = new SourceIndexWriter(opts.indexPath)
  // EAGER REPAIR: a torn tail left by a crash is discarded even if this pass appends
  // nothing. The bytes were never a complete record; the source they described is
  // re-derivable from the corpus, and the next pass re-appends it.
  writer.repairTornTail()
  let boundary = loaded.durableCount
  const limit = opts.maxFiles && opts.maxFiles > 0 ? opts.maxFiles : Infinity
  // The paths this pass wrote a record for. The work list is derived from the FINAL state of
  // those paths, not from the state at the moment each was written: a source that is
  // discovered as uncontested and THEN found to collide must end up with NO work, because the
  // refusal for it lands later in the same pass.
  const touched = new Set<string>()

  /** Append a record and remember it as the latest for its path. */
  const appendRecord = (record: Omit<SourceIndexRecord, 'v' | 'boundary'>): void => {
    const written = writer.append(record, boundary, opts.onRecordWritten)
    boundary++
    latest.set(written.path, written)
    touched.add(written.path)
    result.recorded.push({ ...record, refusal: record.refusal })
    if (record.refusal) {
      result.refusals.push({ ...record, refusal: record.refusal })
    }
  }

  try {
    for (const name of names) {
      if (result.scannedFiles >= limit) break
      const kind = bodyFileKind(name)
      if (kind === null) continue
      const filePath = path.join(opts.corpusDir, name)
      result.scannedFiles++

      let st: fs.Stats
      try {
        st = fs.statSync(filePath)
      } catch {
        result.vanished++ // raced with the writer: the file is gone, not an error
        continue
      }
      if (!st.isFile()) {
        result.vanished++
        continue
      }

      const priorRecord = prior.get(filePath)
      const prov = provenance.get(name) ?? null

      // The cheap path: does the metadata say this file is untouched?
      const metaOnly: CurrentState = {
        size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, head: '', tail: '', contentDigest: '',
      }
      const hasPrior = priorRecord !== undefined && priorRecord.kind === kind
      if (hasPrior) {
        const metaVerdict = classifyFromMetadata(priorStateOf(priorRecord), metaOnly)
        // The cheap path short-circuits only when the IDENTITY cannot have moved. The identity
        // is (kind, content, provenance): the metadata covers the first two, but PROVENANCE
        // comes from Claude Code's own index.jsonl, which is written by a different process
        // and can gain a row for this file long after the file itself stopped changing. So the
        // short-circuit also requires that the provenance key is the same as last time.
        // Without this check a late-arriving provenance row would be noticed NEVER, and the
        // identity would stay the weaker content-and-kind one for ever.
        const provKeyNow = provenanceKey(prov)
        const provKeyBefore = provenanceKey(priorRecord.provenance)
        if (metaVerdict === 'unchanged' && !opts.deepVerify && provKeyNow === provKeyBefore) {
          counts.unchanged++
          result.unchanged++
          continue // no record, no work: the idempotence property
        }
      }

      // The file must be read for its identity. Read the evidence.
      let evidence = readFileEvidence(filePath, st.size)
      if (evidence === null) {
        // The file vanished or could not be read: NO identity evidence, so it is NOT
        // discovered. Marking it would be exactly the "path existence alone" the card forbids.
        result.unreadable++
        continue
      }
      // A file that changed between the stat and the read: re-stat and re-read so the persisted
      // (size, digest) pair is a consistent snapshot of ONE version of the file.
      let st2 = st
      try {
        st2 = fs.statSync(filePath)
      } catch {
        result.vanished++
        continue
      }
      if (st2.size !== st.size) {
        const reread = readFileEvidence(filePath, st2.size)
        if (reread === null) { result.unreadable++; continue }
        evidence = reread
      }

      const current: CurrentState = {
        size: st2.size, mtimeMs: st2.mtimeMs, ino: st2.ino,
        head: evidence.head, tail: evidence.tail, contentDigest: evidence.digest,
      }

      let cls: SourceClass
      let firstSeenMs = opts.nowMs
      if (hasPrior) {
        cls = classifyFromContent(priorStateOf(priorRecord), current)
        firstSeenMs = priorRecord.firstSeenMs
      } else {
        cls = 'new'
      }
      counts[cls]++

      const id = computeSourceIdentity(kind, evidence.digest, prov)

      // Identity collision: a DIFFERENT path already claims this identity. The claim set holds
      // EVERY path that currently maps to this identity, refused ones included, so a third
      // colliding path names all of the others rather than only the first one seen.
      const claimants = claims.get(id)
      const others = claimants ? [...claimants].filter(p => p !== filePath).sort() : []
      const refusal = others.length > 0
        ? { reason: 'identity-collision' as const, otherPaths: others }
        : null

      // This path now claims this identity, refused or not.
      let claimSet = claims.get(id)
      if (!claimSet) { claimSet = new Set<string>(); claims.set(id, claimSet) }
      claimSet.add(filePath)

      // A BYTE-IDENTICAL OBSERVATION WRITES NO RECORD. This is the rule that makes a repeated
      // pass over an unchanged corpus a no-op, and it is also what keeps the latest-by-path
      // view honest: a source first observed as NEW stays NEW until its bytes change, so the
      // fact that it still needs migrating is never erased by a later no-op observation.
      // The identity and the refusal state are still checked, because a provenance row that
      // appeared in the meantime DOES change the identity, and that change must be recorded.
      const identityMoved = hasPrior && priorRecord!.id !== id
      const refusalMoved = !sameRefusal(priorRecord?.refusal ?? null, refusal)
      if (cls === 'unchanged' && !identityMoved && !refusalMoved) {
        result.unchanged++
        continue
      }

      // A path that changed identity stops claiming its old identity. The claim map is the
      // CURRENT state, so a path that was refused and then re-identified must stop being
      // treated as a claimant of the contested identity.
      if (hasPrior && priorRecord.id !== id) {
        const old = claims.get(priorRecord.id)
        if (old) {
          old.delete(filePath)
          if (old.size === 0) claims.delete(priorRecord.id)
        }
      }

      appendRecord({
        id,
        path: filePath,
        kind,
        size: current.size,
        mtimeMs: current.mtimeMs,
        ino: current.ino,
        head: current.head,
        tail: current.tail,
        digest: current.contentDigest,
        class: cls,
        firstSeenMs,
        lastSeenMs: opts.nowMs,
        provenance: prov,
        refusal,
      })

      if (refusal) {
        // Refuse the OTHER claimant too, so the collision is symmetric. The other claimant's
        // record was written earlier in this pass (or in an earlier pass); the correction
        // supersedes it. This is the append-only way to say "neither of these is the source".
        const allClaimants = others.concat(filePath)
        for (const other of others) {
          const otherRecord = latest.get(other)
          if (!otherRecord) continue
          const otherPaths = allClaimants.filter(p => p !== other).sort()
          if (otherRecord.refusal && sameRefusal(otherRecord.refusal, {
            reason: 'identity-collision', otherPaths,
          })) continue
          appendRecord({
            id: otherRecord.id,
            path: otherRecord.path,
            kind: otherRecord.kind,
            size: otherRecord.size,
            mtimeMs: otherRecord.mtimeMs,
            ino: otherRecord.ino,
            head: otherRecord.head,
            tail: otherRecord.tail,
            digest: otherRecord.digest,
            class: otherRecord.class,
            firstSeenMs: otherRecord.firstSeenMs,
            lastSeenMs: opts.nowMs,
            provenance: otherRecord.provenance,
            refusal: { reason: 'identity-collision', otherPaths },
          })
        }
      }
    }
    writer.sync()
    result.repairedTornBytes = writer.repairedTornBytes
  } finally {
    writer.close()
  }

  // THE WORK LIST, derived from the final state of every path this pass touched. Writing a
  // record IS the signal that something material happened: a material class transition, an
  // identity change (a provenance row that appeared), or a refusal change. A path whose
  // latest record refuses is contested and produces no work — a refused source must not be
  // migrated blind. A path this pass did not touch produced no record and therefore no work,
  // which is the idempotence property: a repeated pass over an unchanged corpus is a no-op.
  for (const p of [...touched].sort()) {
    const rec = latest.get(p)
    if (!rec || rec.refusal !== null) continue
    result.work.push({
      path: rec.path, id: rec.id, kind: rec.kind, class: rec.class, size: rec.size, digest: rec.digest,
    })
  }

  result.durableCount = boundary
  return result
}
