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
//
// THE PASS IS A SNAPSHOT PASS. The corpus is listed ONCE, at the start, and the pass is a
// pure function of that listing plus the checkpoint — which is what makes it deterministic
// under concurrent corpus growth: two passes over the same corpus and the same checkpoint
// produce the same log. A file that APPEARS during the pass is invisible to it and is picked
// up by the next pass; a file that DISAPPEARS during the pass is counted as `vanished` and
// never marked discovered. Neither is an error, and neither loses a source.
//
// THE CONSUMER CONTRACT — READ THIS BEFORE USING THE PASS RESULT.
//
// `observedMaterial` is "what THIS PASS observed as material", NOT "what remains to be
// migrated". The two are different, and confusing them is a silent data-loss bug. The field
// is NAMED so it cannot be misread: an earlier version called it `work`, and the name WAS the
// hazard — a migration runner iterating `work` on a repeat pass over an unchanged corpus
// would see an EMPTY list and conclude there is nothing to migrate, silently, on 205GB of
// data that was never migrated.
//
//   - `observedMaterial` is EMPTY on a pass over an unchanged corpus. That is the idempotence
//     property the card demands, and it is correct. But an empty list does NOT mean "there
//     is nothing to migrate" — it means "nothing CHANGED since the last pass".
//   - The DURABLE LOG is the record of what has been discovered. A consumer that needs
//     "outstanding sources" must read the log (the latest record per path) and compare it
//     against its OWN record of what it has already migrated. The checkpoint deliberately
//     carries NO 'migrated' flag: migration execution is a sibling card's job
//     (TRDD-IFOQAQYV), and inventing a settled-marker here would let this card assert a
//     migration it cannot verify.
//   - A source is outstanding only if it is BOTH still present in the corpus AND unmigrated.
//     The log alone cannot tell outstanding from RECLAIMED, because the log is append-only
//     and never deletes a record: a body reclaimed by the 72h retention policy keeps its
//     last record forever, carrying a material class that says "not yet migrated". A
//     consumer MUST check the corpus for the path's presence.
//   - A source whose latest record refuses is CONTESTED and must not be migrated blind; a
//     source whose latest record carries a class of 'new'/'changed'/'truncated'/'replaced' has
//     not been migrated yet. The class is the MATERIAL class — it survives an identity
//     refinement, so a late-arriving provenance row does not make an unmigrated source look
//     settled.
//
// So: consume the LOG for "outstanding", consume `observedMaterial` for "what just moved",
// and check the CORPUS for whether a path still exists.
import * as fs from 'fs'
import * as path from 'path'
import {
  CurrentState, PriorState, SourceClass, SourceKind, SourceProvenance,
  classifyFromContent, classifyFromMetadata, computeSourceIdentity, provenanceKey,
  readFileEvidence,
} from './rawBodySourceIdentity'
import {
  SourceIndexRecord, SourceIndexWriter, SourceRecordReason, loadSourceIndex, latestByPath,
} from './rawBodySourceIndex'

/** The provenance map, keyed by corpus file name. */
export type CorpusProvenanceMap = Map<string, SourceProvenance>

/**
 * What the read of Claude Code's own index.jsonl found. `skippedLines` counts the lines that
 * did not parse — a torn append, or a damaged row. A non-zero count means some sources lost
 * their provenance, which can make a byte-identical source collide with another. It is
 * reported, never fatal: the file is foreign and its damage is not our checkpoint's business.
 */
export interface CorpusIndexStats {
  skippedLines: number
  rowsRead: number
  /**
   * Rows that parsed but carry NO message_uuid AND NO session_id — a row that cannot
   * discriminate anything, so the source falls back to the bare content-and-kind identity.
   *
   * This is a SCHEMA-CHANGE ALARM. A row that fails to parse is counted as a skipped line,
   * but a row that parses perfectly and carries none of the fields we read is a different
   * failure: Claude Code renamed `message_uuid` to `messageId`, or dropped it. Every source's
   * provenance would then go empty at once, which means every source's IDENTITY changes at
   * once (a mass re-identification) and the byte-identical sources that were distinguished
   * only by their provenance collapse into ONE identity (a mass collision, and a mass
   * refusal). Nothing else in the log would show why.
   *
   * IT IS RARE BY CONSTRUCTION, which is what makes it an alarm rather than a number. It
   * counts rows that lost BOTH discriminators, not rows that lost one: a row with a
   * session_id but no message_uuid still discriminates, so it is not counted here. Measured
   * against the real corpus (19,890 rows in ~/.agentlens/otel-bodies/index.jsonl, every one
   * carrying a message_uuid), the count is 0 — a healthy corpus reads 0, and a non-zero
   * count means the index format changed under us.
   *
   * AN EARLIER VERSION ALSO COUNTED ROWS MISSING ONLY message_uuid. It was DROPPED: on a
   * corpus where some writer variant omits message_uuid, that counter is permanently
   * non-zero, and a permanently-firing alarm trains the next reader to ignore it. It was
   * also an absolute count, so it could not show a CHANGE between passes — only the delta
   * could, and the delta needs state this card does not have. The count that remains is
   * the one that is rare when the corpus is healthy.
   */
  rowsWithoutProvenance: number
}

/**
 * Read Claude Code's own `index.jsonl` from the corpus dir. It is written concurrently by
 * Claude Code, and it is a FOREIGN FILE: we do not own it, we do not write it, and its
 * integrity is not our contract. The card's refusal conditions are about OUR checkpoint's
 * integrity, so a defect in THEIR file must not abort OUR pass — it must only cost us
 * provenance.
 *
 * So every unparseable line is SKIPPED and counted, wherever it is. The first assumption was
 * that only the LAST line can be torn (a single-writer appender leaves a torn line last),
 * and that a bad line in the middle is corruption. That assumption is about ANOTHER PROCESS's
 * behaviour, which this module does not control: a retry, a multi-writer, or a partial line
 * followed by a successful append all put a torn line in the middle. Treating that as fatal
 * would let a defect in a file we do not own abort a discovery pass over 205GB of data that
 * is perfectly readable.
 *
 * The cost of the tolerant policy: a damaged row means a source loses its provenance, and a
 * source that loses its provenance can collide with a byte-identical one. The skipped-line
 * count is REPORTED so the caller can see that happened; a large count is a signal that
 * Claude Code's writer is misbehaving.
 */
export function readCorpusProvenance(corpusDir: string, stats?: CorpusIndexStats): CorpusProvenanceMap {
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
      // A torn or damaged line in a FOREIGN file: skip it, keep going. The count is
      // reported so the caller can see the damage.
      if (stats) stats.skippedLines++
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) {
      if (stats) stats.skippedLines++
      continue
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
    if (stats) stats.rowsRead++
    const req = str('request_file')
    const resp = str('response_file')
    // THE ALARM KEYS ON THE FIELDS THE IDENTITY DEPENDS ON, NOT ON THE KEY BEING EMPTY. The
    // key falls back to session_id + timestamp, so a row that lost only message_uuid still
    // yields a non-empty key and a key-based check cannot see it — yet the identity it
    // produces is a weaker one, which is a DIFFERENT identity from the one the source had.
    if (stats && provenance.messageUuid === null && provenance.sessionId === null) {
      stats.rowsWithoutProvenance++
    }
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

/**
 * One source THIS PASS observed as material.
 *
 * IT IS NOT A MIGRATION TODO LIST, and the name is chosen so a caller cannot read it as one.
 * An earlier version called this `work`, and the name was the hazard: a migration runner
 * iterating `work` on a repeat pass over an unchanged corpus would see an EMPTY list and
 * conclude there is nothing to migrate — silently, on 205GB of data that was never migrated.
 * The list is empty in that case for a correct reason (nothing CHANGED), which is the
 * opposite of "nothing to do".
 */
export interface ObservedMaterial {
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
  /**
   * The sources THIS PASS observed as material — their bytes changed, their identity was
   * refined, or their contestability moved. NOT the outstanding migration set: it is EMPTY on
   * a pass over an unchanged corpus, and the outstanding set must be derived from the LOG
   * plus the consumer's own record of what it has migrated. See the module header.
   */
  observedMaterial: ObservedMaterial[]
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
  /**
   * The tally of OBSERVATIONS by class, NOT of records. `counts.unchanged` counts the
   * observations that turned out to be byte-identical, including the ones that were then
   * recorded with a carried-forward material class (a refinement records 'new', not
   * 'unchanged'). The RECORDED class tally is what the log holds; read the log for that.
   */
  counts: Record<SourceClass, number>
  /** Bytes of a torn tail discarded before this pass's first append. */
  repairedTornBytes: number
  /** What the read of Claude Code's own corpus index found. */
  corpusIndex: CorpusIndexStats
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
    recorded: [], observedMaterial: [], refusals: [], scannedFiles: 0, vanished: 0, unreadable: 0,
    unchanged: 0, durableCount: 0, counts, repairedTornBytes: 0,
    corpusIndex: { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0 },
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
  // The set of paths the corpus still holds. A refused path names its partners, and a
  // PARTNER THAT IS GONE FROM THE CORPUS CANNOT CONTEST ANYTHING: the raw-body corpus
  // reclaims bodies (src/bodiesActivity.ts documents a ~72h reclaim), so a collision partner
  // can simply disappear. A refusal naming a vanished partner is a refusal that would block
  // the source from ever being migrated, on a corpus whose bytes are about to be deleted.
  //
  // IT IS BUILT FROM THE SAME READDIR AS `names` BELOW, and that is load-bearing. The corpus
  // is ACTIVELY GROWING, so two readdirs of it can disagree: a file that appears between
  // them would be in `names` but not in `presentPaths`, and every refusal naming it would be
  // judged stale — a FALSE RETRACTION OF A LIVE COLLISION, on a corpus whose bytes are about
  // to be deleted. One readdir, one truth.
  const presentPaths = new Set<string>()
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
  for (const n of names) {
    if (bodyFileKind(n) !== null) presentPaths.add(path.join(opts.corpusDir, n))
  }

  const corpusStats: CorpusIndexStats = { skippedLines: 0, rowsRead: 0, rowsWithoutProvenance: 0 }
  const provenance = readCorpusProvenance(opts.corpusDir, corpusStats)
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
          // A STALE REFUSAL MUST BE RE-DERIVED EVEN ON THE CHEAP PATH. The refusal names the
          // paths that contest this source, and a partner that has been RECLAIMED from the
          // corpus (src/bodiesActivity.ts documents a ~72h reclaim) cannot contest anything.
          // A refusal naming a vanished partner would block the source from ever being
          // migrated — silently, on a corpus whose bytes are about to be deleted. The
          // re-derivation happens here, before the cheap path's `continue`, because a source
          // whose own metadata never moved is exactly the one that would otherwise keep a
          // stale refusal for ever.
          const stalePartners = priorRecord.refusal
            ? priorRecord.refusal.otherPaths.filter(p => !presentPaths.has(p))
            : []
          if (priorRecord.refusal !== null && stalePartners.length > 0) {
            // THE VANISHED PARTNER'S OWN RECORD IS NOT CORRECTED, AND DELIBERATELY SO.
            // `gone` is by construction NOT in the corpus: the pass never visits it, so a
            // record written for it now would carry lastSeenMs = now for a file that does
            // not exist — a log that claims a vanished source is live, current and
            // migratable. That is precisely what an append-only log exists to prevent.
            //
            // The partner's stale refusal is left in the log as HISTORY. It is harmless:
            // a consumer reads the LATEST record per path, and the partner's latest record
            // is the one the pass wrote BEFORE it was reclaimed — a record that says "seen
            // at <old time>", which a consumer can date. The partner is not in the corpus,
            // so it is not outstanding work (see the work-list filter, which admits only
            // paths the corpus still holds).
            const remaining = priorRecord.refusal.otherPaths
              .filter(p => presentPaths.has(p))
              .sort()
            appendRecord({
              id: priorRecord.id,
              path: priorRecord.path,
              kind: priorRecord.kind,
              size: priorRecord.size,
              mtimeMs: priorRecord.mtimeMs,
              ino: priorRecord.ino,
              head: priorRecord.head,
              tail: priorRecord.tail,
              digest: priorRecord.digest,
              class: priorRecord.class,
              firstSeenMs: priorRecord.firstSeenMs,
              lastSeenMs: opts.nowMs,
              provenance: priorRecord.provenance,
              refusal: remaining.length > 0
                ? { reason: 'identity-collision', otherPaths: remaining }
                : null,
              reason: remaining.length > 0 ? 'refused' : 'retracted',
            })
          }
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

      const id = computeSourceIdentity(kind, evidence.digest, prov)

      let cls: SourceClass
      let firstSeenMs = opts.nowMs
      if (hasPrior) {
        cls = classifyFromContent(priorStateOf(priorRecord), current)
        firstSeenMs = priorRecord.firstSeenMs
      } else {
        cls = 'new'
      }
      counts[cls]++

      // THE MATERIAL CLASS IS CARRIED FORWARD ON EVERY UNCHANGED OBSERVATION. The class is the
      // last material CONTENT state of the source, so only an actual content change may
      // overwrite it. Two things can happen to a source without its bytes changing: a
      // late-arriving Claude Code provenance row refines its IDENTITY, and a collision being
      // resolved lifts or imposes a REFUSAL. In both cases relabelling the source 'unchanged'
      // would OVERWRITE the material class ('new', 'changed', …) and so erase the evidence
      // that the source was never migrated — the latest-by-path view would then say
      // 'unchanged' about a source that has still never been moved.
      //
      // The reason is derived from WHAT ACTUALLY HAPPENED, never from a default:
      //   refused   — the source is contested (the refusal is present).
      //   refined   — the identity moved and the bytes did not.
      //   retracted — a refusal was lifted and the bytes did not.
      //   content   — the bytes changed. ONLY a real content change may say 'content'; a
      //               byte-identical source must never claim it, because a reconciliation
      //               stage reads 'content' as a tampering signal.
      const identityMoved = hasPrior && priorRecord!.id !== id
      let effectiveClass = cls
      let reason: SourceRecordReason = 'discovered'
      if (hasPrior) {
        if (cls === 'unchanged') {
          effectiveClass = priorRecord!.class
        } else if (cls === 'replaced') {
          // A REPLACEMENT IS NOT A CONTENT CHANGE. The file object at the path is a
          // different one, which may hold byte-identical content. Calling that 'content'
          // would claim the bytes changed when they did not — and 'content' is the tampering
          // signal a reconciliation stage acts on.
          reason = 'replaced'
        } else {
          reason = 'content'
        }
      }

      // Identity collision: a DIFFERENT path already claims this identity. The claim set holds
      // EVERY path that currently maps to this identity, refused ones included, so a third
      // colliding path names all of the others rather than only the first one seen.
      const claimants = claims.get(id)
      // A partner that is no longer in the corpus cannot contest this identity, so it does not
      // make this path refused. (See `presentPaths` for why a partner can vanish.)
      const others = claimants
        ? [...claimants].filter(p => p !== filePath && presentPaths.has(p)).sort()
        : []
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
      const refusalMoved = !sameRefusal(priorRecord?.refusal ?? null, refusal)
      if (cls === 'unchanged' && !identityMoved && !refusalMoved) {
        result.unchanged++
        continue
      }
      // A contested source is recorded as REFUSED, whatever else changed about it. A refusal
      // dominates the reason: a contested source must not be migrated blind, and that is the
      // fact a consumer acts on. The identity change is still visible from the id differing
      // from the prior record's id.
      if (refusal !== null) {
        reason = 'refused'
      } else if (hasPrior && cls === 'unchanged') {
        reason = identityMoved ? 'refined' : 'retracted'
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
        // A REFUSAL THAT IS NO LONGER TRUE MUST BE RETRACTED, or it is permanent. The other
        // claimant's record refuses THIS path, naming it as a colliding partner. Once this
        // path has been re-identified — its provenance arrived, or its bytes changed — the
        // collision no longer exists, but the other claimant's refusal still stands in the
        // log, and a consumer reading the latest record per path would see that path
        // permanently refused and never migrate it. The retraction is an appended record; the
        // append-only log has no other way to undo a statement.
        if (priorRecord.refusal !== null) {
          for (const other of priorRecord.refusal.otherPaths) {
            const otherRecord = latest.get(other)
            if (!otherRecord || otherRecord.refusal === null) continue
            if (!otherRecord.refusal.otherPaths.includes(filePath)) continue
            // THE REMAINING PARTNERS ARE EXACTLY THE OLD PARTNERS MINUS THE ONE BEING
            // RETRACTED. `otherRecord.refusal.otherPaths` already holds every genuine partner
            // of `other`; removing the re-identified path IS the retraction. Nothing else may
            // be added: `others` holds the claimants of the RE-IDENTIFIED path's NEW identity,
            // which has nothing to do with the collision being retracted, and mixing the two
            // sets installs a refusal against a partner that never existed — a false refusal
            // that blocks a source from ever being migrated.
            const remaining = otherRecord.refusal.otherPaths
              .filter(p => p !== filePath && presentPaths.has(p))
              .sort()
            if (remaining.length === 0) {
              // The collision is fully resolved: the other claimant is no longer refused at
              // all, and its material class is what it was.
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
                refusal: null,
                reason: 'retracted',
              })
            } else {
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
                refusal: { reason: 'identity-collision', otherPaths: remaining },
                reason: 'refused',
              })
            }
          }
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
        class: effectiveClass,
        firstSeenMs,
        lastSeenMs: opts.nowMs,
        provenance: prov,
        refusal,
        reason,
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
            reason: 'refused',
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
    // ONLY A SOURCE THE CORPUS STILL HOLDS CAN BE WORK. A path that has been reclaimed
    // (src/bodiesActivity.ts documents a ~72h reclaim) is not a file to migrate, and a work
    // item for it would send a migration runner after a file that does not exist.
    if (!presentPaths.has(rec.path)) continue
    result.observedMaterial.push({
      path: rec.path, id: rec.id, kind: rec.kind, class: rec.class, size: rec.size, digest: rec.digest,
    })
  }

  result.durableCount = boundary
  result.corpusIndex = corpusStats
  return result
}
