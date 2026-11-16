// src/cli/diskVolumes.ts — one sample of every real volume: statfs plus `diskutil info -plist` (TRDD-HTARKH87).
//
// Every external call has a 5 s timeout and a timeout yields NULL plus an error string — never 0 —
// so a hung network mount or a wedged diskutil cannot block the minute and cannot be mistaken for an
// empty disk. macOS only: the mount table format and diskutil are Darwin.

import * as fs from "fs"
import { execFile } from "child_process"

const CALL_TIMEOUT_MS = 5000
const MOUNT_BIN = "/sbin/mount"
const DISKUTIL_BIN = "/usr/sbin/diskutil"
const OSASCRIPT_BIN = "/usr/bin/osascript"

/** Filesystems that hold user data on a local disk. Network (nfs, smbfs, afpfs), autofs, devfs and
 *  friends are absent on purpose: statfs on a dead network mount is the classic hang. */
const REAL_FS = new Set(["apfs", "hfs", "msdos", "exfat", "ntfs"])

/** System plumbing volumes that are apfs and local but are not "a disk" to the owner. The VM (swap)
 *  volume is NOT here: it is real, and its growth is exactly what a disk-space investigation wants. */
const PLUMBING_MOUNT = /^\/(System\/Volumes\/(Preboot|Update|xarts|iSCPreboot|Hardware)|Volumes\/Recovery)$/
const PLUMBING_PREFIX = ["/Library/Developer/CoreSimulator/", "/private/var/run/com.apple.security.cryptexd/", "/System/Volumes/Update/"]

export interface MountEntry {
  device: string
  mount: string
  fsType: string
  options: string[]
}

export interface VolumeSample {
  mount: string
  device: string
  fsType: string
  /** statfs st_dev of the mount, used to attribute a watch path to its volume. */
  dev: number | null
  container: string | null
  volumeUuid: string | null
  totalB: number | null
  usedB: number | null
  freeB: number | null
  availB: number | null
  /** This volume's OWN bytes (diskutil CapacityInUse); used_b is container-wide on APFS. */
  volUsedB: number | null
  containerFreeB: number | null
  /** DERIVED: importantAvailB - availB (see derivePurgeable); not a value any API returns. */
  purgeableB: number | null
  /** NSURLVolumeAvailableCapacityForImportantUsageKey, one osascript call for all volumes. */
  importantAvailB: number | null
  error: string | null
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: CALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err) reject(new Error(`${bin} ${args.join(" ")}: ${err.killed ? `timed out after ${CALL_TIMEOUT_MS} ms` : err.message}`))
      else resolve(stdout)
    })
  })
}

export function parseMount(output: string): MountEntry[] {
  const out: MountEntry[] = []
  for (const line of output.split("\n")) {
    const m = /^(.*?) on (.*) \(([^()]*)\)$/.exec(line)
    if (!m) continue
    const [fsType, ...options] = m[3].split(",").map(s => s.trim())
    out.push({ device: m[1], mount: m[2], fsType, options })
  }
  return out
}

/** The mounts worth sampling: local data filesystems, writable, not sealed, not simulator/cryptex/system plumbing. */
export function realMounts(entries: readonly MountEntry[]): MountEntry[] {
  return entries.filter(e =>
    REAL_FS.has(e.fsType)
    && !e.options.includes("read-only") && !e.options.includes("sealed")
    && !PLUMBING_MOUNT.test(e.mount)
    && !PLUMBING_PREFIX.some(p => e.mount.startsWith(p)))
}

/** Top-level `<key>K</key><integer|string|true/|false/>` pairs of a diskutil plist; first occurrence wins.
 *  A regex, not an XML parser: the keys read here are flat scalars, and a plutil spawn per volume per sample is cost for nothing. */
export function parsePlistScalars(xml: string): Map<string, string | number | boolean> {
  const out = new Map<string, string | number | boolean>()
  const re = /<key>([^<]+)<\/key>\s*(?:<(integer|real|string)>([^<]*)<\/\2>|<(true|false)\/>)/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (out.has(m[1])) continue
    if (m[4]) out.set(m[1], m[4] === "true")
    else out.set(m[1], m[2] === "string" ? m[3] : Number(m[3]))
  }
  return out
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** purgeable_b is DERIVED, not read from the OS: important_avail_b minus avail_b — the space macOS would free on demand (purgeable
 *  caches, local snapshots) that statfs does not count as available. NULL when either input is unknown or the difference is negative
 *  (never 0 for "could not tell"). */
export function derivePurgeable(importantAvailB: number | null, availB: number | null): number | null {
  if (importantAvailB === null || availB === null) return null
  const d = importantAvailB - availB
  return d >= 0 ? d : null
}

/** An important-usage figure of 0 beside a positive statfs avail is an API non-answer, not "nothing is available" — observed on the VM
 *  volume, which macOS answers 0 for while statfs shows the container's free space. It becomes NULL (the caller records why), never 0. */
export function usableImportant(importantAvailB: number | null, availB: number | null): number | null {
  return importantAvailB === 0 && (availB ?? 0) > 0 ? null : importantAvailB
}

// ONE JavaScript-for-Automation call reads NSURLVolumeAvailableCapacityForImportantUsageKey for every mount (argv). A `swift -e` call
// costs seconds; osascript costs ~0.3 s measured. Apple's documented meaning (URLResourceKey.volumeAvailableCapacityForImportantUsageKey):
// "the volume's available capacity in bytes for storing important resources". The sibling ...ForOpportunisticUsageKey ("for storing
// nonessential resources") is not read: disk_volume has no column for it.
const IMPORTANT_JXA = `function run(argv) {
  ObjC.import("Foundation")
  const key = "NSURLVolumeAvailableCapacityForImportantUsageKey"
  const out = {}
  for (const m of argv) {
    const d = $.NSURL.fileURLWithPath(m).resourceValuesForKeysError($([key]), null)
    out[m] = d.isNil() ? null : ObjC.unwrap(d.objectForKey(key))
  }
  return JSON.stringify(out)
}`

/** mount -> important-usage available bytes (null where macOS returned none). Rejects on a timeout or osascript failure. */
async function importantAvailable(mounts: readonly string[]): Promise<Map<string, number | null>> {
  const out = JSON.parse(await run(OSASCRIPT_BIN, ["-l", "JavaScript", "-e", IMPORTANT_JXA, ...mounts])) as Record<string, unknown>
  return new Map(mounts.map(m => [m, num(out[m])]))
}

async function sampleOne(e: MountEntry): Promise<VolumeSample> {
  const errors: string[] = []
  const s: VolumeSample = {
    mount: e.mount, device: e.device, fsType: e.fsType, dev: null, container: null, volumeUuid: null,
    totalB: null, usedB: null, freeB: null, availB: null, volUsedB: null, containerFreeB: null,
    purgeableB: null, importantAvailB: null, error: null,
  }
  const statfs = (async () => {
    // statfs cannot be cancelled; the race bounds THIS sample and the verb exits via exitNow, so a thread stuck in a dead mount cannot hold the process.
    const timeout = new Promise<never>((_, rej) => { const t = setTimeout(() => rej(new Error(`statfs timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS); t.unref() })
    const st = await Promise.race([fs.promises.statfs(e.mount), timeout])
    s.totalB = st.blocks * st.bsize
    s.freeB = st.bfree * st.bsize
    s.availB = st.bavail * st.bsize
    s.usedB = (st.blocks - st.bfree) * st.bsize
    s.dev = (await fs.promises.stat(e.mount)).dev
  })().catch((err: unknown) => { errors.push(`statfs: ${err instanceof Error ? err.message : String(err)}`) })
  const util = (async () => {
    const plist = parsePlistScalars(await run(DISKUTIL_BIN, ["info", "-plist", e.mount]))
    const uuid = plist.get("VolumeUUID")
    const container = plist.get("APFSContainerReference")
    s.volumeUuid = typeof uuid === "string" ? uuid : null
    s.container = typeof container === "string" ? container : null
    s.volUsedB = num(plist.get("CapacityInUse"))
    s.containerFreeB = num(plist.get("APFSContainerFree"))
  })().catch((err: unknown) => { errors.push(err instanceof Error ? err.message : String(err)) })
  await Promise.all([statfs, util])
  s.error = errors.length ? errors.join("; ") : null
  return s
}

/** Sample every real volume. Two mounts of one volume (`/` and Data on a split system volume) are one row, keyed by container + volume UUID. */
export async function sampleVolumes(): Promise<VolumeSample[]> {
  if (process.platform !== "darwin") throw new Error("disk-sample: the volume probe is macOS only (mount table + diskutil)")
  const mounts = realMounts(parseMount(await run(MOUNT_BIN, [])))
  // Started before the per-volume probes so the osascript call overlaps them; settled into a value so a failure here can never be an unhandled rejection.
  const important = importantAvailable(mounts.map(m => m.mount)).then(v => ({ v }), (e: unknown) => ({ err: e instanceof Error ? e.message : String(e) }))
  const samples = await Promise.all(mounts.map(sampleOne))
  const imp = await important
  for (const s of samples) {
    // Failure keeps NULL and records why — never 0 (a 0 would read as "nothing is available").
    if ("err" in imp) s.error = [s.error, `important-usage: ${imp.err}`].filter(Boolean).join("; ")
    else {
      const raw = imp.v.get(s.mount) ?? null
      s.importantAvailB = usableImportant(raw, s.availB)
      if (s.importantAvailB === null) s.error = [s.error, raw === null ? "important-usage: macOS returned no value" : "important-usage: macOS returned 0 while statfs avail is positive"].filter(Boolean).join("; ")
    }
    s.purgeableB = derivePurgeable(s.importantAvailB, s.availB)
  }
  const seen = new Set<string>()
  return samples.filter(s => {
    const key = s.volumeUuid ? `${s.container ?? ""}/${s.volumeUuid}` : `dev:${s.device}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
