// rawBodySourceIdentity — stable identity + cheap fingerprint for raw OTEL body sources.
//
// WHY THIS EXISTS (TRDD-U50JCH0J): the raw-body corpus (~800k files, ~205GB) must be migrated
// into a typed store and then retired, and the migration needs a source identity that survives
// the move. A PATH is not an identity: the corpus is a flat dir whose names are capture-time
// uuids, and a migration stage renames, moves and archives files. Two properties follow.
//
//   1. IDENTITY IS CONTENT-DERIVED. The canonical identity of a source is derived from its BYTES
//      (a full sha256) plus its kind plus the provenance evidence Claude Code recorded for it
//      (message_uuid, else session_id + timestamp). Nothing path-derived enters the identity, so a
//      rename or a move cannot change it, and two copies of the same content at different paths
//      are RECOGNISED as one identity rather than silently counted twice.
//
//   2. CLASSIFICATION IS FINGERPRINT-DERIVED. Re-hashing 205GB on every pass is not a plan, so
//      discovery compares a cheap fingerprint (size + mtime + inode + a head/tail window hash)
//      against the persisted one and only re-reads a file whose fingerprint moved. The
//      fingerprint is the CLASSIFICATION evidence; the content digest is the IDENTITY evidence.
//      They are deliberately separate: a fingerprint costs 8KB, a digest costs the whole file.
//
// THE TRADE-OFF, STATED PLAINLY: a file whose CONTENT changes while its size, mtime and inode
// all stay identical is classified UNCHANGED. Preserving mtime across a rewrite is rare but
// possible (a restore, a cp -p, some editors), and no cheap fingerprint can rule it out.
// The deepVerify option re-reads the head/tail window on every file and closes the gap at a
// cost of ~8KB per file per pass. The default is the cheap path, because the corpus is
// write-once by construction (Claude Code never rewrites a body file) and 205GB of re-hashing
// would make the migration unbudgetable.
//
// A SECOND TRADE-OFF, IN THE IDENTITY ITSELF: the identity includes the provenance evidence,
// so a body whose Claude Code index row appears AFTER the first discovery is re-identified
// once. The retired identity stays in the checkpoint log as history, so the change is
// auditable, and the re-identified source is MORE precise, never less. Two paths that hold
// byte-identical content and share no provenance therefore claim ONE identity — that is the
// ambiguous collision the index layer refuses rather than silently resolving.
import { createHash } from 'crypto'
import * as fs from 'fs'

/** Which side of the LLM exchange a body file holds. */
export type SourceKind = 'request' | 'response'

/** The evidence Claude Code recorded for a captured body, when it recorded any. */
export interface SourceProvenance {
  messageUuid: string | null
  sessionId: string | null
  timestamp: string | null
  querySource: string | null
  model: string | null
}

/** Cheap, read-only evidence about a file's current state. */
export interface SourceFingerprint {
  size: number
  mtimeMs: number
  ino: number
  head: string
  tail: string
}

/**
 * How a source's state compares with the persisted record for its path.
 *
 * 'unchanged' means "the same bytes" — it is the class of a file that was re-read and turned
 * out to be identical. A source whose METADATA is unchanged is normally never re-read at all
 * (the cheap fingerprint path short-circuits it), so 'unchanged' records are rare by design.
 * It is a legitimate class because a re-read can happen (a deep verify, a metadata touch) and
 * the result must be expressible.
 *
 * IT CAN APPEAR IN THE LOG, and when it does it is NOT the material class. A source whose
 * provenance arrives late is re-read, found byte-identical, and recorded — but the record
 * CARRIES THE PRIOR MATERIAL CLASS FORWARD (a source first seen as 'new' stays 'new'), because
 * relabelling it 'unchanged' would erase the evidence that it was never migrated. The
 * discriminating field is `reason` on the record: 'refined' means the identity was refined and
 * the bytes did not change; 'content' means the bytes changed.
 */
export type SourceClass = 'new' | 'unchanged' | 'changed' | 'truncated' | 'replaced'

/** Bytes hashed at each end of a file for the cheap fingerprint. */
const FINGERPRINT_WINDOW_BYTES = 4096

/** Domain separation for the identity hash — bump it when the encoding changes. */
const IDENTITY_SCHEME = 'alsp-v1'

/** Streaming read size for the content digest. */
const READ_CHUNK_BYTES = 1024 * 1024

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** True for a lowercase 64-char hex string — the shape of a sha256 digest. */
export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * Full sha256 of a file's bytes, read in chunks so a 12MB body is never held in memory twice.
 * Returns null when the file cannot be read — the caller must NOT treat that as an empty file.
 */
export function contentDigestOfFile(filePath: string): string | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  const hash = createHash('sha256')
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, null)
      if (got <= 0) break
      hash.update(buf.subarray(0, got))
    }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

/**
 * sha256 of the first and last FINGERPRINT_WINDOW_BYTES of a file. Two seeks, 8KB of I/O.
 * An empty file yields the sha256 of the empty string for both windows.
 */
export function windowHashesOfFile(filePath: string, size: number): { head: string; tail: string } | null {
  const win = Math.min(FINGERPRINT_WINDOW_BYTES, Math.max(0, size))
  const head = Buffer.allocUnsafe(win)
  const tail = Buffer.allocUnsafe(win)
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    if (win > 0) {
      fs.readSync(fd, head, 0, win, 0)
      fs.readSync(fd, tail, 0, win, size - win)
    }
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
  return { head: sha256Hex(head), tail: sha256Hex(tail) }
}

/** Content digest plus the cheap window hashes, read in one visit. */
export function readFileEvidence(filePath: string, size: number): { digest: string; head: string; tail: string } | null {
  const digest = contentDigestOfFile(filePath)
  if (digest === null) return null
  const windows = windowHashesOfFile(filePath, size)
  if (windows === null) return null
  return { digest, head: windows.head, tail: windows.tail }
}

/**
 * The provenance part of the identity. message_uuid is the strongest discriminator Claude Code
 * writes; session_id + timestamp is the fallback for a row that lacks it; an absent row yields
 * the empty key, which is exactly what makes two byte-identical bodies collide.
 */
export function provenanceKey(provenance: SourceProvenance | null): string {
  if (provenance === null) return ''
  if (provenance.messageUuid) return 'u:' + provenance.messageUuid
  if (provenance.sessionId) return 's:' + provenance.sessionId + '@' + (provenance.timestamp || '')
  return ''
}

/** Length-prefixed part encoding, so no two different field tuples can encode identically. */
function encodePart(value: string): string {
  return value.length + ':' + value
}

/**
 * The canonical source identity: a sha256 over the domain-separated, length-prefixed tuple
 * (scheme, kind, content digest, provenance key).
 *
 * It is deliberately independent of the path: renaming or moving a body file cannot change it.
 * Two DISTINCT paths that produce the same identity are an ambiguous collision and the index
 * layer refuses to resolve them silently.
 */
export function computeSourceIdentity(
  kind: SourceKind,
  contentDigest: string,
  provenance: SourceProvenance | null,
): string {
  const payload = [IDENTITY_SCHEME, kind, contentDigest, provenanceKey(provenance)].map(encodePart).join('')
  return sha256Hex(payload)
}

/** The persisted state of one path, as the classifier needs it. */
export interface PriorState {
  size: number
  mtimeMs: number
  ino: number
  contentDigest: string
  head: string
  tail: string
}

/** The observed state of one path. */
export interface CurrentState {
  size: number
  mtimeMs: number
  ino: number
  head: string
  tail: string
  contentDigest: string
}

/**
 * Cheap classification from metadata alone: does this file need to be read at all?
 * Returns UNCHANGED when size, mtime and inode all match, NEEDS_READ otherwise.
 */
export function classifyFromMetadata(prior: PriorState, current: CurrentState): 'unchanged' | 'needs-read' {
  const inoDiffers = prior.ino > 0 && current.ino > 0 && prior.ino !== current.ino
  if (inoDiffers) return 'needs-read'
  if (current.size !== prior.size) return 'needs-read'
  if (current.mtimeMs !== prior.mtimeMs) return 'needs-read'
  return 'unchanged'
}

/**
 * Classification once the file has been read.
 *
 * REPLACED   — the inode changed: a DIFFERENT file object now occupies this path. This is
 *              checked FIRST, and deliberately so: a replacement whose bytes happen to be
 *              identical is still a replacement — a new file object at the path — and calling
 *              it "unchanged" would hide the event a migration stage has to know about. The
 *              identity is content-derived, so the identity does NOT change; only the
 *              classification does.
 * UNCHANGED  — the content digest matches: the same file object, the same bytes.
 * TRUNCATED  — the file got shorter: the tail was cut.
 * CHANGED    — the content changed and the file was neither truncated nor replaced.
 */
export function classifyFromContent(prior: PriorState, current: CurrentState): SourceClass {
  // PRECONDITION ON 'replaced': the inode is only available where the filesystem reports one.
  // Where it does not (some FUSE and network filesystems report ino === 0), the 'replaced'
  // class is UNAVAILABLE and a replacement is classified 'changed' or 'truncated' instead.
  // The corpus lives on APFS, which reports real inodes, so this does not bite today — but a
  // consumer that reads "replaced" as "a different file object" would be silently wrong on
  // such a filesystem, and must not assume the class is always reachable.
  const inoDiffers = prior.ino > 0 && current.ino > 0 && prior.ino !== current.ino
  if (inoDiffers) return 'replaced'
  if (current.contentDigest === prior.contentDigest) return 'unchanged'
  if (current.size < prior.size) return 'truncated'
  return 'changed'
}
