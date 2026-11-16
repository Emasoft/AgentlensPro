// rawBodySourceIndex — the versioned, append-safe incremental checkpoint of raw-body sources.
//
// WHAT IT IS: the durable record of WHICH raw-body sources have been discovered, what their
// identity is, and what state they were last seen in. The migration stages that come after
// (TRDD-U50JCH0J's siblings) read this to learn what still needs moving, without rescanning
// 205GB every time.
//
// WHERE IT LIVES: a caller-supplied state dir, NEVER inside the corpus dir. Claude Code writes
// its own `index.jsonl` into the corpus dir (OTEL_LOG_RAW_API_BODIES=file:<dir>), so a file of
// that name there would collide with a writer we do not own, and the corpus dir is data, not
// state. The default is `<dataDir>/raw-body-migration/`, and the filename carries the FORMAT
// version: `source-index.v1.jsonl`.
//
// WHY APPEND-ONLY AND NEVER REWRITTEN: the checkpoint must be crash-safe at every boundary.
// A record is written to the log in ONE append of ONE complete line, and the durable boundary
// advances only AFTER the append is fsynced. A crash therefore leaves the log with either a
// complete record or a torn tail line — never a half-written record that a later load would
// mistake for data.
//
// HOW A TORN TAIL IS TREATED: the LAST line of the log is the only line that can be torn, and
// only because a crash interrupted its append. It is treated as NOT YET PERSISTED: it is
// skipped, counted, and the durable boundary stays at the last complete record. The next run
// re-derives that source from the corpus and re-appends it — the source is neither lost nor
// duplicated, because the identity is content-derived and a re-append of the same identity is
// idempotent at the consumer. A torn line in the MIDDLE of the log is NOT a crash artefact —
// it is corruption, and it is refused.
//
// WHY A VERSIONED FORMAT: a checkpoint that outlives a migration must be readable by a later
// build. The version is the FIRST field of every record, so a reader can refuse an unknown
// version outright rather than misparse it, and a future version can be introduced without
// rewriting the log.
//
// RECORD SHAPE (one JSON object per line):
//   v            format version (currently 1)
//   id           the source identity (content-derived, path-independent)
//   path         the path the source was seen at — a POINTER, never part of the identity
//   kind         'request' | 'response'
//   size         byte length at last observation
//   mtimeMs      mtime at last observation
//   ino          inode at last observation
//   head, tail   the cheap fingerprint window hashes
//   digest       the full content sha256
//   class        the classification against the previous record for this path
//   firstSeenMs  when the path was first observed
//   lastSeenMs   when the path was last observed in this state
//   provenance   { messageUuid, sessionId, timestamp, querySource, model } or null
//   refusal      { reason: 'identity-collision', otherPaths: [...] } or null
//   reason       why this record was written: discovered | content | refined | refused | retracted
//   boundary     the durable boundary: the number of complete records BEFORE this one
//
// THE BOUNDARY IS THE POINT. `boundary` is the count of complete records that precede this
// record, so a reader can tell exactly how far the log is durable. A record whose boundary is
// not exactly one more than its predecessor's is INTERNALLY INCONSISTENT and is refused.
//
// A REFUSAL IS A RECORD, NOT AN ABSENCE. When a source's identity is already claimed by a
// different path, the source is REFUSED rather than one of the two being silently preferred.
// The refusal is written down, naming the other path, so a later migration stage that reads
// only this log still learns that the source is contested and must not be migrated blind.
import * as fs from 'fs'
import * as path from 'path'
import {
  SourceClass, SourceKind, SourceProvenance, isHex64,
} from './rawBodySourceIdentity'

/**
 * The format version this build writes.
 *
 * IT IS 2, AND THE BUMP IS DELIBERATE. The first version of this format did not have the
 * `reason` field, and its validator accepted a record whose class was 'unchanged'. Both
 * changed: `reason` was added (a record must say WHY it was written, so a refinement is
 * distinguishable from a content change) and the validator became STRICTER (a record's class
 * is the last MATERIAL content state, so 'unchanged' is an observation and never a persisted
 * class). A validator stricter than the format it claims to read REFUSES a legitimate log —
 * verified: a log written by the first version of this format does not load under the
 * stricter rules, and it is not loadable because the `reason` field is absent entirely.
 *
 * The bump makes that refusal EXPLICIT: a version-1 log is refused as an unknown version,
 * with a message that says why, instead of being refused for a malformed field. The version
 * is a CONTRACT, and a contract that changes without a version bump is a contract that lies.
 *
 * WHAT THE BUMP DOES NOT SAY. An earlier draft of this comment claimed that no version-1 log
 * holds data worth keeping, because this substrate has never been run against the real
 * corpus. That was true on the machine where this was written, and it is a claim about a
 * SESSION, not about the format — and a permanent library must not tell an operator to
 * delete a file on the strength of someone else's session. The refusal message therefore
 * says only what the code knows: the formats differ, this build does not convert, and if the
 * old log holds anything you need, keep a copy.
 */
/**
 * The IDENTITIES the log knows about.
 *
 * TWO different strings identify a body, and BOTH are in this set:
 *   - `record.id` — the SOURCE IDENTITY (kind + content digest + provenance, hashed). This is
 *     the body's handle in this format, and it is what a migration runner would naturally key
 *     its "already migrated" set on.
 *   - `record.digest` — the CONTENT DIGEST of the bytes.
 *
 * They are different values (measured: `id !== digest` for the same record), and a caller
 * might reasonably key on either. The guard must recognise BOTH, or it recognises only the
 * one nobody uses.
 *
 * WHY EXACT MEMBERSHIP. A SOURCE IDENTITY is a string, and a PATH is a different string, so
 * exact membership is a perfect discriminator: a key that equals one of these identities IS
 * an identity, and a key that does not is not. No pattern-matching, no false positives.
 *
 * WHY NOT A PATTERN ALONE. The obvious discriminator is "64 lowercase hex characters", but a
 * corpus file may legitimately be NAMED by its digest (a content-addressed store), and a file
 * whose name happens to be 64 hex characters is a real path. A pattern would refuse both.
 *
 * AND WHY MEMBERSHIP ALONE IS NOT ENOUGH. Membership only fires for identities THIS LOG
 * KNOWS. The log is append-only and never deletes a record, so every identity it ever saw
 * stays known — and the realistic misuse is a caller keying on the identities of the bodies
 * it migrated, which are exactly the bodies this log discovered. So membership catches the
 * realistic case. But an identity from a DIFFERENT corpus (a body this log never saw) would
 * match nothing silently, so the shape check is kept as a BACKSTOP underneath.
 */
function knownIdentities(records: SourceIndexRecord[]): Set<string> {
  const set = new Set<string>()
  for (const r of records) {
    set.add(r.id)
    set.add(r.digest)
  }
  return set
}

/**
 * Whether a key has the SHAPE of an identity and cannot be a path.
 *
 * 64 lowercase hex characters, with no path separator and no extension: every corpus body is
 * a `.request.json` or a `.response.json`, so a token shaped like this cannot name one. It is
 * the BACKSTOP for an identity from a corpus this log has never seen.
 */
function looksLikeIdentityShape(key: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(key)) return false
  if (key.includes('/') || key.includes(path.sep)) return false
  if (key.includes('.')) return false
  return true
}

/**
 * The format version. A CONTRACT, and a contract that changes without a version bump is a
 * contract that lies.
 *
 * VERSION 3 — the reason set gained 'restored'. A body that was reclaimed from the corpus
 * and later came back supersedes its own 'gone' tombstone with a record whose reason is
 * 'restored' (a reason of its own, because 'retracted' would claim a refusal was lifted and
 * 'refined' would claim the identity moved, and in the byte-identical case neither is true).
 *
 * WHY THE BUMP MATTERS AND IS NOT OPTIONAL. The validator checks the version PER RECORD, and
 * the writer stamps the current version on every record it writes. A log containing a
 * 'restored' record is therefore readable by this build and NOT by a build that predates it.
 * Without a bump, that older build would PASS the version check (the record claims the same
 * version) and then fail MID-FILE on the reason — an unreadable and unappendable log with no
 * version signal at all. That is exactly the failure the version-2 bump was made to prevent:
 * a validator stricter than the format it claims to read, refusing a legitimate log. A
 * version-2 log is now refused as an unknown version, with a message that says why.
 */
export const SOURCE_INDEX_FORMAT_VERSION = 3

/** The file name of a version-N checkpoint inside the state dir. */
export function sourceIndexFileName(version = SOURCE_INDEX_FORMAT_VERSION): string {
  return `source-index.v${version}.jsonl`
}

/** The default state dir: inside the data dir, never inside the corpus dir. */
export function defaultSourceIndexStateDir(dataDir: string): string {
  return path.join(dataDir, 'raw-body-migration')
}

/** The full path of a version-N checkpoint inside a state dir. */
export function sourceIndexPath(stateDir: string, version = SOURCE_INDEX_FORMAT_VERSION): string {
  return path.join(stateDir, sourceIndexFileName(version))
}

/**
 * WHY a record was written.
 *
 * The class alone cannot tell a LATE-IDENTITY REFINEMENT from a CONTENT CHANGE, and the two
 * must be told apart: a refinement means "a Claude Code provenance row appeared, so this
 * source now has a stronger identity" and the source's bytes are untouched; a content change
 * means "the bytes moved". A reconciliation stage reading the log needs to know which it is —
 * a refinement after a migration is bookkeeping, a content change after a migration is a
 * tampering signal. Without this field the log says only "a new record for this path", and
 * the two are indistinguishable.
 *
 *   'discovered'   — the first observation of this path.
 *   'content'      — the BYTES changed (the class is 'changed' or 'truncated').
 *   'replaced'     — a DIFFERENT FILE OBJECT now occupies this path. It has its own reason
 *                     because a replacement may be BYTE-IDENTICAL — the class exists exactly
 *                     to say "a different file object, possibly with the same bytes" — and
 *                     calling that 'content' would make a byte-identical replacement
 *                     indistinguishable from a byte change. 'content' is what a reconciliation
 *                     stage reads as a tampering signal, so the two must not share it.
 *                     'replaced' is the ONE reason whose class is implied by the reason
 *                     itself: a writer sets both from the same observation, and the validator
 *                     requires them to agree — so the pair is self-checking.
 *   'refined'      — the identity was refined (a provenance row appeared); the bytes did not.
 *   'refused'      — the source is contested; the record carries a refusal.
 *   'retracted'    — a refusal was lifted because the collision was resolved. The path is
 *                     STILL IN THE CORPUS: it was RE-IDENTIFIED (its provenance arrived, or
 *                     its bytes changed), so the collision it was in no longer exists.
 *   'restored'     — THE PATH IS BACK. A body that was reclaimed and then came back (restored
 *                     from a backup, moved back by the retention policy) is VISITED by the pass
 *                     again, and this record supersedes its own 'gone' tombstone. It is its own
 *                     reason because the alternatives are both false statements: 'retracted'
 *                     claims a refusal was lifted (none was) and 'refined' claims the identity
 *                     moved (it did not — the bytes are the same). A reader asking "is this body
 *                     here?" needs the answer to be in the log, and 'restored' says it.
 *   'gone'         — THE PATH IS NO LONGER IN THE CORPUS. This is a different statement from
 *                     'retracted' and the difference is the one a migration runner needs:
 *                     'retracted' means "this source is still here but no longer contested";
 *                     'gone' means "this source is not here any more". Both lift a refusal
 *                     and both carry `refusal: null`, so the REASON is the only field that
 *                     tells them apart — a consumer that ignores it cannot distinguish a
 *                     live-but-retracted source from a reclaimed one.
 *
 *                     A 'gone' record NEVER NAMES ANOTHER PATH: its refusal is always null.
 *                     That is the mechanical support for the rule that only a source's OWN
 *                     latest record says it is contested — a consumer scanning the partner
 *                     names in a log finds nothing to misread in a 'gone' record.
 *                     A 'gone' record keeps the path's ORIGINAL lastSeenMs — the time it was
 *                     really last seen — so it never claims the file is live, and it exists
 *                     to clear a refusal that would otherwise name a live source for ever.
 *                     A 'gone' record is the only record a pass may write for a path it did
 *                     not visit.
 *
 * A 'gone' RECORD IS NOT OUTSTANDING WORK WHILE THE PATH IS ABSENT, whatever its class says.
 * The class is the honest history ("it was never migrated"), not a claim that it still needs
 * migrating.
 *
 * PRESENCE IS THE GROUND TRUTH, AND THE 'gone' REASON IS NOT BY ITSELF ENOUGH. A 'gone'
 * record is a statement about the PAST — "this path was not here when the pass ran" — and a
 * body can come back (restored from a backup, moved back by the retention policy). So a
 * 'gone' record does not exclude a source that is PRESENT in the corpus: the corpus wins.
 * A 'gone' record for a path that is absent from the corpus is excluded, but so is every
 * other record for an absent path — the exclusion is really the corpus check, and the reason
 * is the log's explanation of WHY.
 *
 * WHY THE REASON IS STILL WORTH HAVING: it tells a consumer that the log KNOWS about this
 * path and deliberately recorded its absence, which is different from a path the log has
 * never seen. And it is the reason a restored body must SUPERSEDE its own tombstone — the
 * pass writes a fresh record for a path that is back, so the tombstone stops being the
 * latest statement about it.
 *
 * THE FORMAT MODELS ABSENCE. Every other record is an OBSERVATION about a path at a time —
 * "this path was here, then". A 'gone' record is the one that asserts a path is NOT there,
 * which is a different kind of statement, and the only one a pass may make about a path it
 * did not visit.
 */
export type SourceRecordReason =
  | 'discovered'
  | 'content'
  | 'replaced'
  | 'refined'
  | 'refused'
  | 'retracted'
  | 'restored'
  | 'gone'

/** Why a source was refused instead of accepted. */
export interface SourceRefusal {
  reason: 'identity-collision'
  /** The other paths that claim the same identity. */
  otherPaths: string[]
}

/** One persisted record. */
export interface SourceIndexRecord {
  v: number
  id: string
  path: string
  kind: SourceKind
  size: number
  mtimeMs: number
  ino: number
  head: string
  tail: string
  digest: string
  class: SourceClass
  firstSeenMs: number
  lastSeenMs: number
  provenance: SourceProvenance | null
  refusal: SourceRefusal | null
  reason: SourceRecordReason
  boundary: number
}

/** A refusal. Every malformed or inconsistent input produces one of these, never a silent skip. */
export class SourceIndexError extends Error {
  readonly line: number
  readonly reason: string
  constructor(line: number, reason: string) {
    // A line of 0 means the error is NOT about a line of the log — it is about the CALLER's
    // arguments. The message must not read "source index line 0", which is nonsense and
    // would send a reader looking in the file for a line that does not exist.
    super(line > 0 ? `source index line ${line}: ${reason}` : reason)
    this.name = 'SourceIndexError'
    this.line = line
    this.reason = reason
  }
}

/** The result of loading a checkpoint. */
export interface LoadedSourceIndex {
  records: SourceIndexRecord[]
  /**
   * How many complete records were read back.
   *
   * THIS IS A COUNT OF COMPLETE RECORDS, NOT A PROOF OF DURABILITY, and the difference
   * matters. A record that reached the page cache but was never fsynced is indistinguishable
   * from a durable one after a crash: the loader cannot tell them apart, because nothing in
   * the file says which records were synced. So the loader does NOT claim durability it
   * cannot prove — it reports what it can prove, which is that the record is COMPLETE
   * (newline-terminated, valid, and part of an intact boundary chain).
   *
   * The durability guarantee is the OTHER half of the contract, and it is enforced by the
   * writer: `SourceIndexWriter.sync()` fsyncs, and `SourceIndexWriter.durableCount` counts
   * only the records that were synced. A caller that needs the stronger guarantee asks the
   * writer, not the loader. Fsyncing per record would cost 800k fsyncs on a full-corpus
   * pass; the writer syncs once per pass, and the pass boundary is the durability boundary.
   */
  durableCount: number
  /** How many trailing bytes were discarded as a torn (unpersisted) tail line. 0 or 1. */
  tornTailCount: number
  /** True when the last line was torn and therefore not durable. */
  hasTornTail: boolean
}

const CLASSES: readonly SourceClass[] = ['new', 'unchanged', 'changed', 'truncated', 'replaced']

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(obj: Record<string, unknown>, key: string, line: number): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new SourceIndexError(line, `field '${key}' must be a non-empty string`)
  }
  return v
}

function requireNumber(obj: Record<string, unknown>, key: string, line: number): number {
  const v = obj[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new SourceIndexError(line, `field '${key}' must be a finite number`)
  }
  return v
}

function validateRefusal(v: unknown, line: number): SourceRefusal | null {
  if (v === undefined || v === null) return null
  if (!isPlainObject(v)) throw new SourceIndexError(line, "field 'refusal' must be an object or null")
  const reason = v.reason
  if (reason !== 'identity-collision') {
    throw new SourceIndexError(line, `field 'refusal.reason' must be 'identity-collision'`)
  }
  const other = v.otherPaths
  if (!Array.isArray(other) || other.length === 0) {
    throw new SourceIndexError(line, "field 'refusal.otherPaths' must be a non-empty array of paths")
  }
  for (const p of other) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new SourceIndexError(line, "field 'refusal.otherPaths' must contain non-empty strings")
    }
  }
  return { reason, otherPaths: other as string[] }
}

function validateProvenance(v: unknown, line: number): SourceProvenance | null {
  if (v === undefined || v === null) return null
  if (!isPlainObject(v)) throw new SourceIndexError(line, "field 'provenance' must be an object or null")
  const str = (k: string): string | null => {
    const raw = v[k]
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'string') throw new SourceIndexError(line, `provenance.${k} must be a string or null`)
    return raw
  }
  return {
    messageUuid: str('messageUuid'),
    sessionId: str('sessionId'),
    timestamp: str('timestamp'),
    querySource: str('querySource'),
    model: str('model'),
  }
}

/**
 * Validate ONE parsed record. Throws SourceIndexError on anything malformed or internally
 * inconsistent. `expectedBoundary` is the boundary the record MUST carry, given its position.
 */
export function validateSourceIndexRecord(
  value: unknown,
  line: number,
  expectedBoundary: number,
): SourceIndexRecord {
  if (!isPlainObject(value)) throw new SourceIndexError(line, 'record must be a JSON object')
  const v = value.v
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new SourceIndexError(line, "field 'v' must be an integer format version")
  }
  if (v !== SOURCE_INDEX_FORMAT_VERSION) {
    throw new SourceIndexError(line, `unknown format version ${v} (this build reads version ${SOURCE_INDEX_FORMAT_VERSION}) — a version-${v} log is a different format and this build does not convert it; if it holds anything you need, keep a copy before replacing it`)
  }
  const id = requireString(value, 'id', line)
  if (!isHex64(id)) throw new SourceIndexError(line, "field 'id' must be a 64-char lowercase hex sha256")
  const kind = requireString(value, 'kind', line)
  if (kind !== 'request' && kind !== 'response') {
    throw new SourceIndexError(line, "field 'kind' must be 'request' or 'response'")
  }
  const cls = requireString(value, 'class', line)
  if (!CLASSES.includes(cls as SourceClass)) {
    throw new SourceIndexError(line, `field 'class' must be one of ${CLASSES.join(', ')}`)
  }
  const digest = requireString(value, 'digest', line)
  if (!isHex64(digest)) throw new SourceIndexError(line, "field 'digest' must be a 64-char lowercase hex sha256")
  const head = requireString(value, 'head', line)
  if (!isHex64(head)) throw new SourceIndexError(line, "field 'head' must be a 64-char lowercase hex sha256")
  const tail = requireString(value, 'tail', line)
  if (!isHex64(tail)) throw new SourceIndexError(line, "field 'tail' must be a 64-char lowercase hex sha256")
  const boundary = requireNumber(value, 'boundary', line)
  if (!Number.isInteger(boundary) || boundary < 0) {
    throw new SourceIndexError(line, "field 'boundary' must be a non-negative integer")
  }
  if (boundary !== expectedBoundary) {
    throw new SourceIndexError(line, `field 'boundary' is ${boundary} but must be ${expectedBoundary} for this position`)
  }
  const size = requireNumber(value, 'size', line)
  if (size < 0) throw new SourceIndexError(line, "field 'size' must be non-negative")
  const mtimeMs = requireNumber(value, 'mtimeMs', line)
  const ino = requireNumber(value, 'ino', line)
  if (ino < 0) throw new SourceIndexError(line, "field 'ino' must be non-negative")
  const firstSeenMs = requireNumber(value, 'firstSeenMs', line)
  const lastSeenMs = requireNumber(value, 'lastSeenMs', line)
  if (lastSeenMs < firstSeenMs) {
    throw new SourceIndexError(line, "field 'lastSeenMs' must not precede 'firstSeenMs'")
  }
  const provenance = validateProvenance(value.provenance, line)
  const refusal = validateRefusal(value.refusal, line)
  const reason = value.reason
  if (reason !== 'discovered' && reason !== 'content' && reason !== 'replaced'
      && reason !== 'refined' && reason !== 'refused' && reason !== 'retracted'
      && reason !== 'restored' && reason !== 'gone') {
    throw new SourceIndexError(line, "field 'reason' must be one of discovered, content, replaced, refined, refused, retracted, restored, gone")
  }
  if (reason === 'refused' && refusal === null) {
    throw new SourceIndexError(line, "field 'refusal' is required when reason is 'refused'")
  }
  if (reason === 'gone' && refusal !== null && refusal.otherPaths.length === 0) {
    throw new SourceIndexError(line, "field 'refusal' must be null or name a partner when reason is 'gone'")
  }
  if (reason === 'retracted' && refusal !== null) {
    // A retraction LIFTS a refusal, so the record must NOT carry one. Carrying a refusal on a
    // retraction would leave the contested claim standing.
    throw new SourceIndexError(line, "field 'refusal' must be null when reason is 'retracted'")
  }
  if ((reason === 'discovered' || reason === 'content' || reason === 'replaced'
       || reason === 'refined' || reason === 'restored') && refusal !== null) {
    throw new SourceIndexError(line, `field 'refusal' must be null when reason is '${reason}'`)
  }
  if (reason === 'gone' && refusal !== null) {
    // A 'gone' record may still refuse the partners that ARE present, so a refusal is
    // allowed here — but only one that names at least one partner.
    if (refusal.otherPaths.length === 0) {
      throw new SourceIndexError(line, "field 'refusal' must be null when reason is 'gone' and it names no partner")
    }
  }
  // 'content' means THE BYTES CHANGED. A byte-identical source must never claim it: a
  // reconciliation stage reads 'content' as a tampering signal, so a false one on the
  // artifact whose whole purpose is to make a 205GB retirement auditable is worse than no
  // signal at all. The class is the observable content state, so this is checkable.
  if (reason === 'content' && cls !== 'changed' && cls !== 'truncated') {
    throw new SourceIndexError(line, `field 'reason' is 'content' but class is '${cls}' — only changed or truncated may claim a content change`)
  }
  // A REPLACEMENT IS ITS OWN REASON. A 'replaced' file may be byte-identical, so calling it
  // 'content' would claim the bytes changed when they did not — and 'content' is the tampering
  // signal a reconciliation stage acts on.
  if (reason === 'replaced' && cls !== 'replaced') {
    throw new SourceIndexError(line, `field 'reason' is 'replaced' but class is '${cls}'`)
  }
  // THE INVARIANT IS ONE-DIRECTIONAL, AND IT MUST STAY THAT WAY.
  //
  // A reason of 'content' or 'replaced' IMPLIES the matching class. The converse is NOT
  // enforced, and enforcing it was a CRASH-ON-WRITE: the material class is CARRIED FORWARD
  // on an unchanged observation, so a class outlives the reason that set it. A file that
  // was replaced (class 'replaced') and then had its identity refined (reason 'refined')
  // carries class 'replaced' with reason 'refined' — which is CORRECT, because the class is
  // the last material content state and the reason describes THIS observation. The
  // two-directional rule refused that record on the way IN, so the pass threw, the log
  // became unappendable, and on the real corpus the discovery pass would stall at that
  // body for ever — every subsequent attempt hitting the same bad record.
  //
  // So: a reason implies a class, but a class does NOT imply a reason.
  // THE MATERIAL-CLASS INVARIANT. A record's class is the last MATERIAL content state of the
  // source, so only a real content change may set it to 'changed'/'truncated'/'replaced', and
  // 'unchanged' — which is the class of an OBSERVATION, never of a record — must never appear
  // in a persisted record. A record that is not a content change carries the prior material
  // class forward, which is never 'unchanged'. This is the machine check that keeps the class
  // carry-forward from regressing: without it, a record with reason 'refined' and class
  // 'unchanged' would load cleanly and be silently wrong — which is exactly the bug the
  // carry-forward was added to prevent.
  if (reason !== 'content' && reason !== 'replaced' && reason !== 'gone' && cls === 'unchanged') {
    // 'restored' is in this list: a restored body carries the MATERIAL class forward (its
    // bytes are the same), so its class is never 'unchanged'.
    throw new SourceIndexError(line, `field 'class' is 'unchanged' but reason is '${reason}' — 'unchanged' is an observation, never a persisted material class`)
  }
  return {
    v, id, path: requireString(value, 'path', line), kind, size, mtimeMs, ino, head, tail, digest,
    class: cls as SourceClass, firstSeenMs, lastSeenMs, provenance, refusal,
    reason: reason as SourceRecordReason, boundary,
  }
}

/**
 * Load a checkpoint. A TORN FINAL LINE is tolerated (it is the crash artefact of an append in
 * flight) and reported; a malformed line ANYWHERE ELSE, an unknown version, or a broken
 * boundary chain is REFUSED.
 */
export function loadSourceIndex(indexPath: string): LoadedSourceIndex {
  let raw: string
  try {
    raw = fs.readFileSync(indexPath, 'utf-8')
  } catch {
    return { records: [], durableCount: 0, tornTailCount: 0, hasTornTail: false }
  }
  if (raw.length === 0) {
    return { records: [], durableCount: 0, tornTailCount: 0, hasTornTail: false }
  }
  const endsWithNewline = raw.endsWith('\n')
  const lines = raw.split('\n')
  // A file ending in a newline has an empty trailing element; a file that does not ends mid-line.
  // Either way the LAST element is not a complete, terminated record.
  const completeLines = lines.slice(0, lines.length - 1)
  const records: SourceIndexRecord[] = []
  for (let i = 0; i < completeLines.length; i++) {
    const text = completeLines[i]
    if (text.length === 0) throw new SourceIndexError(i + 1, 'empty line inside the index')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SourceIndexError(i + 1, 'line is not valid JSON (a torn line is only tolerated as the LAST line)')
    }
    records.push(validateSourceIndexRecord(parsed, i + 1, records.length))
  }
  // The trailing element is dropped: without its terminating newline it cannot be told apart
  // from a torn write, so it counts as not-yet-persisted rather than as data.
  const tornTailCount = endsWithNewline ? 0 : 1
  return {
    records,
    durableCount: records.length,
    tornTailCount,
    hasTornTail: tornTailCount > 0,
  }
}

/** The latest record for each path, in log order — the state discovery compares against. */
export function latestByPath(records: SourceIndexRecord[]): Map<string, SourceIndexRecord> {
  const byPath = new Map<string, SourceIndexRecord>()
  for (const r of records) byPath.set(r.path, r)
  return byPath
}

/**
 * The OUTSTANDING MIGRATION SET, derived from the log.
 *
 * WHY THIS IS A FUNCTION AND NOT A RULE IN PROSE. A consumer that has to REMEMBER four
 * conditions (present in the corpus, unmigrated, not 'gone', not refused) will eventually
 * apply three of them, and the one it drops decides whether the runner migrates a file that
 * does not exist or skips a file that does. The class field alone is not enough to derive
 * this: a 'gone' record carries the honest class history ("it was never migrated", i.e.
 * class 'new'), which is exactly the shape of a source that still needs migrating.
 *
 * THE FOUR CONDITIONS, AND WHAT EACH ONE IS FOR:
 *   - STILL PRESENT IN THE CORPUS. The log is append-only and never deletes a record, so a
 *     body reclaimed by the retention policy keeps its last record for ever. The log alone
 *     cannot tell outstanding from reclaimed, so the corpus must be consulted.
 *   - ITS OWN LATEST RECORD'S REASON IS NOT 'gone'. This excludes a body the log already
 *     KNOWS is gone even when the corpus check is skipped or is stale. Either the corpus
 *     check or the reason check alone is not enough.
 *   - ITS OWN LATEST RECORD DOES NOT REFUSE IT. A contested source must not be migrated
 *     blind.
 *   - ITS CLASS IS MATERIAL (not 'unchanged'). 'unchanged' is an OBSERVATION, never a
 *     persisted class — the log never carries it — so a record with class 'unchanged' is
 *     malformed and is refused by the validator. This condition is therefore normally
 *     vacuous, and it is spelled out so the function stays correct if a future format
 *     version makes 'unchanged' persistable.
 *
 * 'MATERIAL' means class 'new' | 'changed' | 'truncated' | 'replaced' — the classes that
 * say "this content has not been migrated yet".
 *
 * NOTE ON WHAT THIS FUNCTION DOES NOT KNOW: whether a source has ALREADY been migrated.
 * The checkpoint deliberately carries no 'migrated' flag, because migration execution is a
 * sibling card's job (TRDD-IFOQAQYV) and this card cannot assert a migration it did not
 * perform. So the caller supplies `alreadyMigratedPaths` — a set of PATHS, not identities —
 * and a path in that set is excluded even if everything else qualifies.
 *
 * THE KEYING IS BY PATH, AND IT IS DELIBERATE. Both sets are paths, because the function's
 * question is "what does the corpus hold RIGHT NOW", and the corpus is a set of paths.
 *
 * A RENAME IS HANDLED CORRECTLY, and this was MEASURED rather than assumed: after a file is
 * renamed, the pass writes a record under the NEW path carrying the SAME identity (the
 * identity is path-independent — that is the module's whole point), and the old path's
 * record lingers in the append-only log. Because the function also requires the path to be
 * in the CURRENT corpus, the old path is excluded (it is not a file that exists any more)
 * and the new path is offered. So a rename neither duplicates a source nor loses one.
 *
 * The one thing the caller must get right is that `corpusPaths` is the CURRENT corpus. A
 * STALE set silently excludes live sources, and there is no way for the function to detect
 * that from the log alone — the log cannot know what is on disk now. That is why the
 * discovery pass, which does know, is the natural caller.
 */
export function outstandingSources(
  records: SourceIndexRecord[],
  corpusPaths: ReadonlySet<string>,
  alreadyMigratedPaths: ReadonlySet<string> | undefined,
  passOutcome: { readonly complete: boolean; readonly recordCount: number },
  logRecordCount: number,
): SourceIndexRecord[] {
  // THE LOG MUST DESCRIBE THE WHOLE CORPUS, OR THIS FUNCTION CANNOT ANSWER.
  //
  // A 'gone' tombstone is AUTHORITATIVE: it excludes the path from the outstanding set. A
  // tombstone survives only for a path the pass did NOT visit — and a pass that stopped
  // early (maxFiles) visits only part of the corpus. So a body that is PRESENT and UNMIGRATED
  // can be excluded because the pass never looked at it, and the set computed from such a log
  // is not the outstanding set: it is a set with a hole in it, and the hole is exactly the
  // bodies the caller most needs.
  //
  // The caller says whether its pass was complete, and it says so BY PASSING THE PASS'S OWN
  // OUTCOME - an object carrying `complete` - rather than a bare boolean. The shape is
  // deliberate: a caller that wrote `true` by hand would be asserting completeness it never
  // checked, and the compiler stops that, because a boolean is not `{ complete: boolean }`.
  // The natural call - pass the result of discoverRawBodySources - cannot misstate the flag.
  //
  // WHAT THIS DOES NOT PREVENT: a caller that CONSTRUCTS a fake outcome object. The guard
  // protects against a mistake, not against a deliberate misstatement - the runner's own
  // review is what prevents the latter. The argument is REQUIRED rather than optional on
  // purpose: a default of `true` would let a caller who forgot to think about it get a
  // silently incomplete answer, and the whole point of this check is that the incomplete
  // answer must never be returned quietly.
  // THE OUTCOME MUST BELONG TO THE PASS THAT PRODUCED THIS LOG. A caller that runs the
  // pass, does other work, and then asks with a STALE outcome - or with the outcome of a
  // DIFFERENT pass - would otherwise be believed. Both sides carry a RECORD COUNT - the
  // number of records in the log - and the log must hold AT LEAST as many as the outcome
  // claims the pass wrote.
  //
  // BOTH COUNTS ARE RECORD COUNTS, AND THE NAME SAYS SO. The loader's field is called
  // `durableCount` but it holds `records.length`; the writer's field of the same name
  // holds the FSYNCED count, which is a different quantity. Comparing the pass's boundary
  // against the loader's `records.length` is comparing like with like - the pass's boundary
  // starts from the loaded record count and increments once per appended record, so after
  // the pass it equals the file's record count. MEASURED on a fresh pass and on a pass
  // following a repaired torn tail: the two agree, and the natural call is not refused.
  //
  // THE ARGUMENT IS REQUIRED: a caller that has the log's records has the log's count, so
  // requiring it costs the natural call nothing and cannot be opted out of.
  if (logRecordCount < passOutcome.recordCount) {
    throw new SourceIndexError(0,
      `outstandingSources: the pass outcome does not belong to this log - the outcome says the pass ` +
      `wrote ${passOutcome.recordCount} records, but the log holds only ${logRecordCount}. ` +
      'The outcome is from a LATER pass than this log, or from a different pass entirely. Pass the ' +
      'outcome of the pass that produced THIS log.')
  }
  if (!passOutcome.complete) {
    throw new SourceIndexError(0,
      'outstandingSources: the log does not describe the whole corpus (the discovery pass stopped early), ' +
      'so the outstanding set would be silently incomplete - a body that is present and unmigrated can be ' +
      'excluded by a tombstone the pass never had the chance to supersede. Run the pass to completion, ' +
      'or pass an outcome whose complete is false deliberately and handle the incomplete set yourself.')
  }
  // A MISMATCHED KEY MUST BE LOUD, NOT SILENT. The caller might hand us a set of
  // IDENTITIES (the content digest) where the function compares PATHS — every comparison
  // then misses, every already-migrated source is offered AGAIN, and the migration runs
  // twice over the same body. An identity is a 64-character hex string and a path is not,
  // so a mismatched key is DETECTABLE, and detectable mismatches throw rather than
  // silently doing nothing.
  // A MISMATCHED KEY MUST BE LOUD, NOT SILENT — AND IT MUST BE LOUD IN BOTH SETS.
  //
  // The caller might hand us a set of IDENTITIES (the content digest) where the function
  // compares PATHS. Every comparison then misses and every already-migrated source is
  // offered AGAIN — the migration runs twice over the same body.
  //
  // The TWO SETS FAIL IN OPPOSITE DIRECTIONS, and the WORSE one is unguarded if only the
  // first is checked:
  //   - a bad `alreadyMigratedPaths` → every source is offered again (a duplicate run);
  //   - a bad `corpusPaths` → NO source is offered at all, and the function returns an EMPTY
  //     list. A migration over an empty outstanding set reports SUCCESS and migrates
  //     nothing. That is the more dangerous of the two, and it is the one a check that only
  //     guards the first set would miss.
  //
  // So BOTH are checked, and the check is EXACT: a key that equals a digest the log knows is
  // an identity, whatever it looks like.
  const identities = knownIdentities(records)
  const isIdentity = (key: string): boolean => identities.has(key) || looksLikeIdentityShape(key)
  for (const entry of corpusPaths) {
    if (isIdentity(entry)) {
      throw new SourceIndexError(0,
        `outstandingSources: corpusPaths contains an IDENTITY ("${entry}"), not a path. ` +
        'This function is keyed by PATH; pass the paths of the corpus you are migrating. ' +
        'Passing identities here matches nothing and the outstanding set comes back EMPTY — ' +
        'a migration over an empty set reports success and migrates nothing.')
    }
  }
  if (alreadyMigratedPaths) {
    for (const entry of alreadyMigratedPaths) {
      if (isIdentity(entry)) {
        throw new SourceIndexError(0,
          `outstandingSources: alreadyMigratedPaths contains an IDENTITY ("${entry}"), not a path. ` +
          'This function is keyed by PATH; pass the paths of the sources you have already migrated. ' +
          'Passing identities here silently matches nothing and every migrated source is offered again.')
      }
    }
  }

  const latest = latestByPath(records)
  const out: SourceIndexRecord[] = []
  for (const rec of latest.values()) {
    // A 'gone' TOMBSTONE IS AUTHORITATIVE, AND IT IS NOT DEAD CODE.
    //
    // A 'gone' record is the log's statement that the path was not in the corpus WHEN THE
    // PASS LAST RAN. It is the BACKSTOP against a corpus set that is not fresh: if the
    // consumer's `corpusPaths` still lists a body that has since been reclaimed, the corpus
    // check cannot catch it — the file is in the set — and the tombstone can. Removing that
    // backstop would offer a RECLAIMED body to a deletion runner, which is the one thing
    // this card must never do.
    //
    // THE RESTORED BODY IS HANDLED BY THE PASS, NOT HERE. When a body comes back (restored
    // from a backup, moved back by the retention policy), the next pass VISITS it and writes
    // a fresh record that supersedes its own tombstone — with reason 'restored'. So a
    // restored body's latest record is no longer 'gone', and it IS offered. The tombstone
    // only ever survives for a path the pass did not see, which is exactly the case where
    // the corpus check cannot be trusted.
    //
    // THE CALLER OBLIGATION THIS IMPLIES: the outstanding set is computed from a log that
    // reflects the LATEST pass, so the caller must run the pass before asking for the
    // outstanding set. A log that has never been passed over has no 'gone' records at all,
    // and a stale log's tombstones are as authoritative as its other records.
    if (rec.reason === 'gone') continue
    // A REFUSAL CONTESTS ONLY A PARTNER THAT STILL EXISTS. The persisted refusal names the
    // partners that collided AT THE TIME the record was written, and the log is append-only:
    // if a partner has since been reclaimed and no pass has lifted the refusal, the stale
    // names are still there. Excluding the source on the strength of a stale name withholds
    // a LIVE, UNMIGRATED body from the outstanding set for ever — the source that most
    // needs migrating is the one that never gets it.
    //
    // This is the SAME PRESENCE FILTER the discovery pass uses: it re-derives contestability
    // against the CURRENT corpus (its partner list is filtered by presence), so the function
    // and the pass apply the same filter. The function is the one that decides what gets
    // deleted, so it follows the pass.
    //
    // THE TWO DO NOT AGREE ON EVERYTHING, and the difference is worth stating rather than
    // hiding: the pass ALSO re-derives contestability from CONTENT, so a partner that is
    // still present but whose bytes have since changed no longer contests the source — and
    // the pass writes a retraction for it, so the LOG carries the truth. The function reads
    // the log, so it inherits that truth; it just cannot itself tell that a present partner
    // has changed content. The window is self-correcting (the next pass retracts it), so
    // this is an over-withholding window, not a permanent loss.
    if (rec.refusal !== null && rec.refusal.otherPaths.some(p => corpusPaths.has(p))) continue
    if (!corpusPaths.has(rec.path)) continue
    if (alreadyMigratedPaths && alreadyMigratedPaths.has(rec.path)) continue
    if (rec.class !== 'new' && rec.class !== 'changed' && rec.class !== 'truncated' && rec.class !== 'replaced') continue
    out.push(rec)
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}

/**
 * Append-only writer over a checkpoint file.
 *
 * The writer owns the durable boundary: `count` is the number of complete records written, and
 * `durableCount` is the number of those whose bytes have been fsynced. A record is only ever
 * reported as persisted after the append returns; a caller that needs the bytes on the platter
 * calls `sync()`.
 *
 * TAIL REPAIR: if the log ends with a torn line (a crash during a previous append), the writer
 * truncates those unpersisted bytes before its first append. Truncating is safe BECAUSE those
 * bytes were never durable and their content is re-derivable from the corpus; the next
 * discovery pass re-appends the source. This is the only write this module ever makes that
 * removes bytes, and it removes ONLY bytes that were never a complete record.
 */
export class SourceIndexWriter {
  readonly indexPath: string
  private fd: number | null = null
  private written = 0
  private synced = 0
  private tornBytesRepaired = 0

  constructor(indexPath: string) {
    this.indexPath = indexPath
  }

  /** Number of complete records written by this writer. */
  get count(): number {
    return this.written
  }

  /** Number of complete records known to be on the platter. */
  get durableCount(): number {
    return this.synced
  }

  /** Bytes of a torn tail discarded by this writer. */
  get repairedTornBytes(): number {
    return this.tornBytesRepaired
  }

  private open(): number {
    if (this.fd === null) {
      fs.mkdirSync(path.dirname(this.indexPath), { recursive: true })
      this.repairTail()
      this.fd = fs.openSync(this.indexPath, 'a')
    }
    return this.fd
  }

  /**
   * Discard an unterminated trailing line, if any, and report how many bytes went.
   *
   * The repair is done EAGERLY — a caller that is about to append must repair first, and a
   * caller that appends NOTHING must also be able to repair (a pass over an unchanged corpus
   * writes no record, and the torn bytes would otherwise sit there for ever). A crash
   * interrupted an append, so those bytes were never a complete record; the source they
   * described is re-derivable from the corpus, and the next pass re-appends it.
   */
  repairTornTail(): number {
    this.repairTail()
    return this.tornBytesRepaired
  }

  /** Discard an unterminated trailing line, if any. */
  private repairTail(): void {
    let raw: Buffer
    try {
      raw = fs.readFileSync(this.indexPath)
    } catch {
      return
    }
    if (raw.length === 0) return
    // The cut is computed in BYTES, not characters: a body path can carry non-ASCII, and a
    // character-index cut would truncate a multi-byte sequence and leave a corrupt file.
    const lastNewline = raw.lastIndexOf(0x0a)
    if (lastNewline === raw.length - 1) return // the log ends with a newline: nothing torn
    const keep = lastNewline + 1 // 0 when there is no complete line at all
    fs.truncateSync(this.indexPath, keep)
    this.tornBytesRepaired = raw.length - keep
  }

  /**
   * Append ONE record. The record must carry the boundary of its position; a mismatch is
   * refused rather than written, because a wrong boundary breaks the chain that makes the log
   * auditable. The record is validated BEFORE it reaches the disk.
   *
   * `onAfterWrite` is a CRASH-INJECTION SEAM: it runs after each append reaches the OS but
   * before the write is counted. A test that throws from it simulates a crash at that exact
   * checkpoint boundary — the bytes are on disk, the writer's own bookkeeping is not. The next
   * run must recover from that state without omitting or duplicating a source. It is optional
   * and defaults to undefined, so production code cannot come to depend on it.
   */
  append(
    record: Omit<SourceIndexRecord, 'v' | 'boundary'>,
    boundary: number,
    onAfterWrite?: () => void,
  ): SourceIndexRecord {
    const full: SourceIndexRecord = { v: SOURCE_INDEX_FORMAT_VERSION, ...record, boundary }
    validateSourceIndexRecord(full, boundary + 1, boundary)
    const fd = this.open()
    fs.writeSync(fd, JSON.stringify(full) + '\n')
    if (onAfterWrite) onAfterWrite()
    this.written++
    return full
  }

  /** Flush the appended bytes to the platter. */
  sync(): void {
    if (this.fd === null) return
    fs.fsyncSync(this.fd)
    this.synced = this.written
  }

  close(): void {
    if (this.fd === null) return
    try { fs.fsyncSync(this.fd) } catch { /* the fd is going away anyway */ }
    this.synced = this.written
    try { fs.closeSync(this.fd) } catch { /* already closed */ }
    this.fd = null
  }
}
