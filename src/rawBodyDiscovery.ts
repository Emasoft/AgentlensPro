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
// THE CONSUMER CONTRACT.
//
// THE FULL CONTRACT IS ON THE CARD (TRDD-U50JCH0J, Scope section), not here. It is prose about
// how to consume this pass, it is long, and it grows — a contract that lives in a module
// header gets edited by whoever last touched the module, and it stops being a contract and
// becomes a comment.
//
// WHAT THIS MODULE ENFORCES, so you do not have to remember it:
//   - The OUTSTANDING MIGRATION SET is `outstandingSources(records, corpusPaths, alreadyMigrated, passOutcome)`
//     (src/rawBodySourceIndex.ts). It applies all four EXCLUSION conditions — still present in the
//     corpus, latest reason is not 'gone', not refused, and a material class — so a consumer
//     CANNOT forget one. AND IT HAS A PRECONDITION the four are not: the pass that produced
//     the log must have been COMPLETE, and the caller passes the pass's own outcome object to
//     say so. A pass that stopped early leaves tombstones standing for bodies it never reached,
//     and a tombstone is authoritative, so a present and unmigrated body would be excluded. Deriving it by hand from the class field alone is wrong: a 'gone'
//     record carries class 'new' ("it was never migrated"), which is exactly the shape of a
//     source that still needs migrating.
//   - The pass's own output is PER-PASS, and it is EMPTY on a pass over an unchanged corpus.
//     That is the idempotence property, and it is correct — but an empty list means "nothing
//     CHANGED", NOT "there is nothing to migrate". The durable LOG is the record of what has
//     been discovered.
//
// WHAT THIS MODULE CANNOT ENFORCE, and the card states: whether a source has ALREADY been
// migrated. The checkpoint deliberately carries no 'migrated' flag — migration execution is a
// sibling card's job (TRDD-IFOQAQYV), and this card cannot assert a migration it did not
// perform. So the caller passes `alreadyMigrated`.
//
// THE TWO RULES A CONSUMER MOST OFTEN GETS WRONG, stated here because they are the ones
// that decide whether a runner migrates a file that does not exist:
//   - A RECORD WHOSE REASON IS 'gone' IS NOT OUTSTANDING WORK, whatever its class says. The
//     'gone' reason is the log's statement that the path is no longer in the corpus; its class
//     is the honest history ("it was never migrated"), not a claim that it still needs
//     migrating. The corpus check and the reason check are BOTH needed: the corpus check
//     excludes a reclaimed body, and the 'gone' reason excludes a body the log knows is gone
//     even if a corpus check is skipped.
//   - ONLY A SOURCE'S OWN LATEST RECORD SAYS IT IS CONTESTED. A partner's record naming a
//     source is NOT evidence that the source is contested: a partner that was reclaimed keeps
//     its last record for ever, and that record names the live source. "Is this source
//     contested?" is a question about ONE path's latest record — never about every record
//     that mentions it.
//
// SO: consume the LOG (via `outstandingSources`) for "outstanding", consume
// `observedMaterial` for "what just moved", and check the CORPUS for whether a path still
// exists.
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
   * session_id but no message_uuid still discriminates, so it is not counted here.
   *
   * MEASURED, ON THIS MACHINE, 2026-10-19: the corpus index at
   * ~/.agentlens/otel-bodies/index.jsonl held 19,890 rows, every one carrying a message_uuid.
   * (The grounding brief's ~8,936 was an EARLIER COUNT of the SAME growing file, not a
   * different measurement — the file grows as Claude Code runs. Re-measured 2026-10-20 it
   * held 20,958 rows, still all carrying a message_uuid.) What the measurement shows is
   * that a HEALTHY CORPUS DOES NOT LOSE BOTH DISCRIMINATORS — not that the count is
   * structurally zero. A non-zero count means the index format changed under us.
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
  /**
   * The sources THIS PASS appended to the checkpoint — the pass's own output, NOT the
   * corpus's state. It is EMPTY on a pass over an unchanged corpus, exactly like
   * `observedMaterial`, and for the same reason: nothing changed. It is not a todo list.
   */
  recordedThisPass: DiscoveredSource[]
  /**
   * The sources THIS PASS observed as material — their bytes changed, their identity was
   * refined, or their contestability moved. NOT the outstanding migration set: it is EMPTY on
   * a pass over an unchanged corpus, and the outstanding set must be derived from the LOG
   * plus the consumer's own record of what it has migrated. See the module header.
   */
  observedMaterial: ObservedMaterial[]
  /**
   * The sources THIS PASS found to be contested. PER-PASS, like `observedMaterial`: a source
   * refused in an EARLIER pass and unchanged since is NOT in this list. The authoritative
   * contestability state is the LOG — one path's latest record.
   *
   * THE THREE LISTS' RELATIONSHIP, so a consumer does not have to reconstruct it. IT IS NOT
   * A PARTITION, and the counts do not add up — do not write `material.length +
   * refusals.length === recordedThisPass.length`, it is false.
   *
   * WHAT EACH LIST COUNTS:
   *   - `recordedThisPass` COUNTS APPENDS, not distinct sources. One path can produce
   *     several appends in a single pass (a discovery, then a refusal, then a corrected
   *     refusal), so it is a count of WRITES, not of sources. Three mutually identical
   *     files produce 6 appends across 3 paths.
   *   - `observedMaterial` counts DISTINCT PATHS.
   *   - `refusals` counts REFUSING RECORDS: one entry per append that carried a refusal, so
   *     it can list a path more than once.
   *
   * THE TRUE RELATIONSHIP, stated as a partition of the APPENDS rather than of the paths:
   *
   *     every append this pass wrote is exactly one of:
   *       - a MATERIAL append      — the path ends up in `observedMaterial`;
   *       - a REFUSING append      — the path ends up in `refusals`;
   *       - a 'gone' append        — neither list: the path is NOT in the corpus, so it is
   *                                not material, and it carries no refusal, so it is not a
   *                                refusal. THIS IS WHERE THE REMAINDER GOES, and it is the
   *                                only kind of remainder.
   *
   * So a consumer asking "which recorded paths are in neither list?" gets exactly the
   * 'gone' records — the records written for paths that were RECLAIMED. There is no other
   * remainder, and no other reason for a recorded path to be missing from both lists.
   *
   * `observedMaterial` and `refusals` DO NOT OVERLAP as sets of PATHS: a path whose latest
   * record refuses is excluded from the material list, so no path is in both. (They are two
   * different views of the appends, not a partition of the paths — a path can appear in
   * `refusals` for one append and in `observedMaterial` for another.)
   */
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
   * Whether this pass SCANNED THE WHOLE CORPUS.
   *
   * A pass that stopped early (maxFiles) leaves tombstones standing for bodies it never
   * reached, and a tombstone is AUTHORITATIVE - it excludes the path from the outstanding
   * set. So a body that is PRESENT and UNMIGRATED can be excluded because the pass did not
   * visit it, and the outstanding set computed from such a log is NOT the outstanding set.
   *
   * The caller MUST NOT compute the outstanding set from an incomplete pass. This flag is
   * how it knows: `complete: false` means the pass stopped early, and the log it wrote does
   * not describe the corpus.
   *
   * WHAT 'complete' DOES AND DOES NOT MEAN. It means EVERY BODY FILE IN THE LISTING WAS
   * VISITED - it does NOT mean every body was fully PROCESSED. A body that was present but
   * UNREADABLE was visited and could not be read: the pass could not produce identity
   * evidence for it, so it has no record and no tombstone, and an absent record excludes
   * nothing. The one exception: a path that carried a tombstone from an EARLIER pass keeps
   * that stale tombstone while it stays unreadable, and the tombstone excludes it.
   */
  complete: boolean
  /**
   * The tally of OBSERVATIONS by class, NOT of records, and NOT of material. It diverges
   * from the material list in four ways: a genuine no-op (unchanged observation, no record,
   * no material); a refinement (unchanged observation, record written, material emitted); a
   * lift of a stale refusal (unchanged observation, record written, material emitted); and a
   * retraction (unchanged observation, record written, material emitted). So a number
   * scanned out of `counts` says NOTHING about what the material list holds. Read the LOG
   * for the corpus's state.
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
    recordedThisPass: [], observedMaterial: [], refusals: [], scannedFiles: 0, vanished: 0, unreadable: 0,
    unchanged: 0, durableCount: 0, counts, repairedTornBytes: 0, complete: true,
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
    result.recordedThisPass.push({ ...record, refusal: record.refusal })
    if (record.refusal) {
      result.refusals.push({ ...record, refusal: record.refusal })
    }
  }

  try {
    // Whether the pass consumed EVERY body file in the listing. A body file that was never
    // visited leaves its tombstone standing, and a tombstone is authoritative - so a body
    // that is PRESENT and UNMIGRATED would be excluded from the outstanding set because
    // this pass did not look at it. The flag is set from the LISTING, not from whether the
    // limit happened to be hit: a corpus with exactly as many bodies as the limit never
    // trips the limit check and still ends the loop having visited everything.
    const totalBodyFiles = names.filter(n => bodyFileKind(n) !== null).length
    for (const name of names) {
      if (result.scannedFiles >= limit) {
        // THE PASS STOPPED EARLY. It did not visit every body, so any tombstone for a path
        // it never reached still stands - and a tombstone is authoritative, so a body that
        // is PRESENT and UNMIGRATED would be excluded from the outstanding set because this
        // pass did not look at it. The result says so; the caller must not compute the
        // outstanding set from it.
        result.complete = false
        break
      }
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
        // A PATH THAT IS BACK MUST NOT SHORT-CIRCUIT. If the prior record is a 'gone'
        // tombstone, the path was NOT in the corpus when the pass last ran, so the cheap
        // path's premise — "this file is untouched since the last observation" — does not
        // hold: the last observation was of a path that was gone. The file is HERE now, and
        // the tombstone must be superseded by a record, not left standing for ever.
        //
        // Without this, a restored body (same bytes, same inode) is silently classified
        // 'unchanged', no record is written, and its latest record stays 'gone' — so the
        // outstanding set excludes a body that is present and unmigrated.
        const priorIsGone = priorRecord.reason === 'gone'
        if (metaVerdict === 'unchanged' && !opts.deepVerify && provKeyNow === provKeyBefore && !priorIsGone) {
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
            // THE VANISHED PARTNER'S REFUSAL IS CLEARED, WITH A RECORD THAT DOES NOT CLAIM
            // THE PARTNER IS LIVE.
            //
            // `gone` is by construction NOT in the corpus: the pass never visits it. A record
            // written for it with lastSeenMs = now would claim a vanished source is live,
            // current and migratable — precisely what an append-only log exists to prevent.
            //
            // But writing NOTHING leaves the partner's refusal naming a LIVE source for
            // ever, and a consumer asking "is this source contested?" by looking at every
            // record that names it would say YES — silently, on a live body that then never
            // gets migrated.
            //
            // So a record IS written for the vanished partner, and it is honest: its
            // lastSeenMs is the ORIGINAL time the partner was last seen, NOT now, and its
            // reason is 'gone' so a reader can tell a vanished path from a live one. It
            // claims nothing about the present; it records that the partner was seen at a
            // past time and is no longer here.
            for (const gone of stalePartners) {
              const goneRecord = latest.get(gone)
              if (!goneRecord || goneRecord.refusal === null) continue
              // THE 'gone' RECORD IS WRITTEN ONCE PER VANISHED PATH, NOT ONCE PER TRIGGERING
              // LIVE PATH. This block runs for EVERY live path that refused the vanished
              // partner, so with two live paths refusing 'z', both compute 'z' as a stale
              // partner and both would append a 'gone' record for it. The log is append-only,
              // so the second append is a DUPLICATE STATEMENT about the same fact — and the
              // log then grows on every pass over an idle corpus, which breaks the growth
              // property the format depends on.
              //
              // The lift is a fact about the VANISHED PATH, not about the trigger: once the
              // vanished path's latest record says 'gone', there is nothing left to say about
              // it. `latest` is updated by appendRecord, so the first trigger's append is
              // visible to the second trigger in the SAME pass — one record, not two.
              //
              // The check is on the latest record's REASON, not on 'has this path been
              // written about': a vanished path that was never refused has no 'gone' record
              // and none is warranted.
              if (goneRecord.reason === 'gone') continue
              if (!goneRecord.refusal.otherPaths.includes(priorRecord.path)) continue
              appendRecord({
                id: goneRecord.id,
                path: goneRecord.path,
                kind: goneRecord.kind,
                size: goneRecord.size,
                mtimeMs: goneRecord.mtimeMs,
                ino: goneRecord.ino,
                head: goneRecord.head,
                tail: goneRecord.tail,
                digest: goneRecord.digest,
                class: goneRecord.class,
                firstSeenMs: goneRecord.firstSeenMs,
                // THE ORIGINAL lastSeenMs, NOT now: the partner was NOT seen now.
                lastSeenMs: goneRecord.lastSeenMs,
                provenance: goneRecord.provenance,
                // A VANISHED PATH CONTESTS NOBODY, so its 'gone' record carries NO REFUSAL.
                //
                // The earlier shape kept a partial refusal naming the partners that were
                // still present — but a path that is not in the corpus cannot contest
                // anything: the ambiguity a refusal protects against (two paths claiming one
                // identity) needs BOTH paths to exist. Keeping the partner names also made
                // the write order-dependent: the first triggering live path wrote a record
                // naming the remaining partners, and the second trigger then had to write
                // ANOTHER record to clear its own name out of that refusal — which is how two
                // 'gone' records for one path came to exist.
                //
                // The live paths' OWN records carry the retraction (their refusal is rewritten
                // to name only the partners still present), so nothing is lost by clearing it
                // here: the collision among the survivors is stated on THEIR records.
                refusal: null,
                reason: 'gone',
              })
            }
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
      // A PATH THAT IS BACK SUPERSEDES ITS OWN TOMBSTONE.
      //
      // The byte-identical observation writes no record, so a path whose latest record is a
      // 'gone' tombstone and whose file has come back — the same bytes, the same inode,
      // because the file was restored rather than rewritten — would produce NO record, and
      // the tombstone would stand for ever. The source is PRESENT, UNMIGRATED, and would be
      // excluded from the outstanding set by its own 'gone' reason: permanently invisible,
      // silently. That is the exact failure this card exists to prevent.
      //
      // So a prior 'gone' record NEVER suppresses the record. A path that is back must
      // supersede the statement that it was not.
      const priorIsGone = priorRecord?.reason === 'gone'
      if (cls === 'unchanged' && !identityMoved && !refusalMoved && !priorIsGone) {
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
        if (priorRecord!.reason === 'gone') {
          // THE BODY IS BACK. The prior record was a 'gone' tombstone, so the path was not in
          // the corpus when the pass last ran — and now it is, and the pass visited it. The
          // alternatives are both false statements: 'retracted' claims a refusal was lifted
          // (none was) and 'refined' claims the identity moved (it did not — the bytes are
          // the same). A reader asking "is this body here?" needs the answer in the log.
          // THE IDENTITY MAY STILL HAVE MOVED. A byte-identical body whose PROVENANCE has
          // since acquired a row (Claude Code writes its own index.jsonl from another
          // process) has a different id. 'restored' is still the more honest label than
          // 'refined' - the path DID come back, and the id difference carries the
          // refinement - so the reason is not a claim that nothing else changed.
          reason = 'restored'
        } else {
          reason = identityMoved ? 'refined' : 'retracted'
        }
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
    // THE PASS IS COMPLETE ONLY IF IT VISITED EVERY BODY FILE IN THE LISTING. Derived from
    // the listing rather than from whether the limit was hit: a corpus with exactly as many
    // bodies as the limit never trips the limit check, and it still visited everything - but
    // a corpus with MORE bodies than the limit leaves some unvisited, and a body that was not
    // visited keeps its tombstone.
    if (result.scannedFiles < totalBodyFiles) result.complete = false
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
    // ONLY A SOURCE THE CORPUS STILL HOLDS CAN BE MATERIAL. A path that has been reclaimed
    // (src/bodiesActivity.ts documents a ~72h reclaim) is not a file to migrate, and a
    // material item for it would send a migration runner after a file that does not exist.
    //
    // THE PRESENCE IS LIST-TIME, not read-time: the pass lists the corpus once, at the
    // start. A body reclaimed in the narrow window between the listing and the end of the
    // pass would still be offered. The migration runner, which opens the file, catches that;
    // this pass cannot, and does not pretend to.
    if (!presentPaths.has(rec.path)) continue
    result.observedMaterial.push({
      path: rec.path, id: rec.id, kind: rec.kind, class: rec.class, size: rec.size, digest: rec.digest,
    })
  }

  result.durableCount = boundary
  result.corpusIndex = corpusStats
  return result
}
