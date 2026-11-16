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
  purgeableB: number | null
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
 *  A regex, not an XML parser: the keys read here are flat scalars, and a plutil spawn per volume per minute is cost for nothing. */
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

/** First numeric value whose key matches `re` — only a key diskutil really returned is used, else NULL. */
function firstNumeric(plist: Map<string, string | number | boolean>, re: RegExp): number | null {
  for (const [k, v] of plist) if (re.test(k)) return num(v)
  return null
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
    // diskutil returns no purgeable/important-usage figure on the macOS builds checked; take one only if a key by that name appears, else NULL.
    s.purgeableB = firstNumeric(plist, /purgeable/i)
    s.importantAvailB = firstNumeric(plist, /important/i)
  })().catch((err: unknown) => { errors.push(err instanceof Error ? err.message : String(err)) })
  await Promise.all([statfs, util])
  s.error = errors.length ? errors.join("; ") : null
  return s
}

/** Sample every real volume. Two mounts of one volume (`/` and Data on a split system volume) are one row, keyed by container + volume UUID. */
export async function sampleVolumes(): Promise<VolumeSample[]> {
  if (process.platform !== "darwin") throw new Error("disk-sample: the volume probe is macOS only (mount table + diskutil)")
  const mounts = realMounts(parseMount(await run(MOUNT_BIN, [])))
  const samples = await Promise.all(mounts.map(sampleOne))
  const seen = new Set<string>()
  return samples.filter(s => {
    const key = s.volumeUuid ? `${s.container ?? ""}/${s.volumeUuid}` : `dev:${s.device}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
