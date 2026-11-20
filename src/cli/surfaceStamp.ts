// src/cli/surfaceStamp.ts: the version stamp of an installed skill or agent file and the verdict that
// decides whether the shipped copy may overwrite it (TRDD-YL3EWT6N item 4). Pure: no fs, no process state.
//
// WHY a module of its own and not src/loadedPluginVersions.ts compareVersions: that one parses `2.34.0-rc.1`
// as 2.34.0 plus a fourth part and so orders the prerelease ABOVE the release, which would let an old
// prerelease copy keep a release out. compareStampVersions here orders a prerelease below its release.

/** The stamp line scripts/stamp-surfaces.js writes as the last line of the frontmatter. The regexp must
 *  stay identical to that script's STAMP_RE: a reader that disagrees with the writer reads every stamp as absent. */
const STAMP_RE = /^# agentlenspro-version: (\S+)$/
/** The version shape the writer accepts (its VERSION_RE): X.Y.Z with an optional prerelease. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** The version of the stamp line inside the first frontmatter block of a text, else null. Never throws:
 *  installed files are user-editable, so any shape (no frontmatter, CRLF, empty) is a plain null. */
export function readSurfaceStamp(text: string): string | null {
  const lines = text.split('\n')
  if (lines[0] !== '---') return null
  const end = lines.indexOf('---', 1)
  if (end < 0) return null
  let found: string | null = null
  for (let i = 1; i < end; i++) {
    const m = STAMP_RE.exec(lines[i])
    if (m) found = m[1]   // the writer keeps the LAST stamp line of the frontmatter; so does the reader
  }
  return found
}

/** True when the string has the shape of a stamp version (the writer's VERSION_RE). */
export function isStampVersion(v: string): boolean {
  return VERSION_RE.test(v)
}

/** Semver precedence of two prerelease strings: numeric identifiers compare numerically and rank below
 *  alphanumeric ones, and a longer list outranks its own prefix. */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1
}

/** Negative when a is older than b, 0 when equal, positive when newer. X.Y.Z compare numerically; a
 *  prerelease orders below its release. Throws on a string that is not a stamp version: callers test
 *  isStampVersion first (surfaceVerdict does). */
export function compareStampVersions(a: string, b: string): number {
  const ma = VERSION_RE.exec(a)
  const mb = VERSION_RE.exec(b)
  if (!ma || !mb) throw new Error(`not a stamp version: ${JSON.stringify(ma ? b : a)}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  const pa = ma[4]
  const pb = mb[4]
  if (pa === undefined && pb === undefined) return 0
  if (pa === undefined) return 1
  if (pb === undefined) return -1
  return comparePrerelease(pa, pb)
}

export type SurfaceVerdict = 'install' | 'current' | 'overwrite' | 'keep-newer' | 'keep-edited'

export interface SurfaceVerdictInput {
  /** Text of the installed stamp-carrying file (an agent file, a skill's SKILL.md); null when it is absent. */
  installed: string | null
  /** Text of the same file as shipped. */
  shipped: string
  /** Same content: the bytes of an agent file, the tree hash over the shipped file list for a skill. */
  sameContent: boolean
  /** A git checkout (a src folder beside the package root) rather than a release. */
  checkout: boolean
}

/** The verdict table of item 4, tested in this order. An unreadable or malformed stamp counts as no stamp. */
export function surfaceVerdict(input: SurfaceVerdictInput): SurfaceVerdict {
  if (input.installed === null) return 'install'
  if (input.sameContent) return 'current'
  const shipped = readSurfaceStamp(input.shipped)
  if (shipped === null || !isStampVersion(shipped)) return 'overwrite'   // an unstamped shipped file keeps the content-only rule of before the stamps
  const installed = readSurfaceStamp(input.installed)
  if (installed === null || !isStampVersion(installed)) return 'overwrite'
  const c = compareStampVersions(installed, shipped)
  if (c < 0) return 'overwrite'
  if (c > 0) return 'keep-newer'
  return input.checkout ? 'overwrite' : 'keep-edited'
}
