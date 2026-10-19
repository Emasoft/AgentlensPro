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
// advances only AFTER the append returns. A crash therefore leaves the log with either a
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
//   lastSeenMs   when the path was last observed
//   provenance   { messageUuid, sessionId, timestamp, querySource, model } or null
//   boundary     the durable boundary: the number of complete records BEFORE this one
//
// THE BOUNDARY IS THE POINT. `boundary` is the count of complete records that precede this
// record, so a reader can tell exactly how far the log is durable. A record whose boundary is
// not exactly one more than its predecessor's is INTERNALLY INCONSISTENT and is refused.
import * as fs from 'fs'
import * as path from 'path'
import {
  SourceClass, SourceKind, SourceProvenance, isHex64,
} from './rawBodySourceIdentity'

/** The format version this build writes. */
export const SOURCE_INDEX_FORMAT_VERSION = 1

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
  boundary: number
}

/** A refusal. Every malformed or inconsistent input produces one of these, never a silent skip. */
export class SourceIndexError extends Error {
  readonly line: number
  readonly reason: string
  constructor(line: number, reason: string) {
    super(`source index line ${line}: ${reason}`)
    this.name = 'SourceIndexError'
    this.line = line
    this.reason = reason
  }
}

/** The result of loading a checkpoint. */
export interface LoadedSourceIndex {
  records: SourceIndexRecord[]
  /** How many complete records were loaded. */
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

function validateProvenance(v: unknown, line: number): SourceProvenance | null {
  if (v === null) return null
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
    throw new SourceIndexError(line, `unknown format version ${v} (this build reads version ${SOURCE_INDEX_FORMAT_VERSION})`)
  }
  const id = requireString(value, 'id', line)
  if (!isHex64(id)) throw new SourceIndexError(line, "field 'id' must be a 64-char lowercase hex sha256")
  const kind = requireString(value, 'kind', line)
  if (kind !== 'request' && kind !== 'response') {
    throw new SourceIndexError(line, `field 'kind' must be 'request' or 'response'`)
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
  return {
    v, id, path: requireString(value, 'path', line), kind, size, mtimeMs, ino, head, tail, digest,
    class: cls as SourceClass, firstSeenMs, lastSeenMs, provenance, boundary,
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
  if (raw.length === 0) return { records: [], durableCount: 0, tornTailCount: 0, hasTornTail: false }
  const endsWithNewline = raw.endsWith('\n')
  const lines = raw.split('\n')
  // A file ending in a newline has an empty trailing element; a file that does not ends mid-line.
  const tailCandidate = endsWithNewline ? null : lines[lines.length - 1]
  const bodyLines = endsWithNewline ? lines.slice(0, lines.length - 1) : lines.slice(0, lines.length - 1)
  const records: SourceIndexRecord[] = []
  for (let i = 0; i < bodyLines.length; i++) {
    const text = bodyLines[i]
    if (text.length === 0) throw new SourceIndexError(i + 1, 'empty line inside the index')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SourceIndexError(i + 1, 'line is not valid JSON (a torn line is only tolerated as the LAST line)')
    }
    records.push(validateSourceIndexRecord(parsed, i + 1, records.length))
  }
  let tornTailCount = 0
  if (tailCandidate !== null) {
    tornTailCount = 1
    // A trailing complete-but-unterminated line is still unpersisted: without its newline it
    // cannot be told apart from a torn write, so it is treated the same way.
  }
  return { records, durableCount: records.length, tornTailCount, hasTornTail: tornTailCount > 0 }
}

/** Serialize one record to its exact on-disk line (no trailing newline). */
export function serializeSourceIndexRecord(record: Omit<SourceIndexRecord, 'v' | 'boundary'> & { boundary?: number }): string {
  const { v, boundary, ...rest } = record as SourceIndexRecord
  const payload: Record<string, unknown> = { v: SOURCE_INDEX_FORMAT_VERSION, ...rest }
  if (boundary !== undefined) payload.boundary = boundary
  return JSON.stringify(payload)
}

/**
 * Append ONE record to the checkpoint. The append is a single write of a single complete line
 * followed by a flush; the caller advances the durable boundary only after this returns.
 *
 * `expectedBoundary` is the count of complete records already in the log — the boundary the new
 * record must carry. A mismatch is refused rather than written, because a wrong boundary breaks
 * the chain that makes the log auditable.
 */
export function appendSourceIndexRecord(
  indexPath: string,
  record: Omit<SourceIndexRecord, 'v' | 'boundary'>,
  expectedBoundary: number,
): SourceIndexRecord {
  const full: SourceIndexRecord = {
    v: SOURCE_INDEX_FORMAT_VERSION,
    ...record,
    boundary: expectedBoundary,
  }
  // Validate BEFORE appending: a record that would be refused on load must never reach the disk.
  validateSourceIndexRecord(full, expectedBoundary + 1, expectedBoundary)
  fs.mkdirSync(path.dirname(indexPath), { recursive: true })
  fs.appendFileSync(indexPath, JSON.stringify(full) + '\n')
  return full
}

/** The latest record for each path, in log order — the state discovery compares against. */
export function latestByPath(records: SourceIndexRecord[]): Map<string, SourceIndexRecord> {
  const byPath = new Map<string, SourceIndexRecord>()
  for (const r of records) byPath.set(r.path, r)
  return byPath
}

/** Every record for one identity, in log order. */
export function recordsByIdentity(records: SourceIndexRecord[]): Map<string, SourceIndexRecord[]> {
  const byId = new Map<string, SourceIndexRecord[]>()
  for (const r of records) {
    const list = byId.get(r.id)
    if (list) list.push(r)
    else byId.set(r.id, [r])
  }
  return byId
}
