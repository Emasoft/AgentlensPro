// macOS RAM-disk spool for raw-body capture (TRDD-K3WDPR7M Phase 3).
//
// Turning raw-body capture ON makes Claude Code write ~21 MB/min of raw API bodies to disk. Even if the
// server ingests and deletes them within seconds, the WRITE itself is SSD wear (~30 GB/day). A RAM disk
// makes those writes land in volatile memory, so the drain reclaims RAM instead of burning the SSD. The
// durable copy is the DuckDB store; a body not yet ingested when the RAM disk vanishes (reboot) is lost,
// and that is acceptable — it is a few seconds' window (see TRDD-K3WDPR7M Phase 3, item 7).
//
// macOS-only by design: `hdiutil attach -nomount ram://<sectors>` allocates a raw ram device WITHOUT
// sudo, and `diskutil erasevolume HFS+ <name> <dev>` formats + mounts it at /Volumes/<name>.
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/** The volume name — also the mount-point basename under /Volumes. ONE spelling, never re-typed. */
export const SPOOL_VOLUME_NAME = 'AgentLensSpool'
export const SPOOL_MOUNT_POINT = `/Volumes/${SPOOL_VOLUME_NAME}`

/** Default spool size. 2 GB comfortably holds minutes of the ~21 MB/min firehose between 60s drains. */
export const DEFAULT_SPOOL_MB = 2048
export const SPOOL_MB_ENV = 'AGENTLENS_SPOOL_MB'

export interface RamDiskInfo {
  mounted: boolean
  mountPoint: string
  /** Total volume size in bytes, or null when it could not be read. */
  sizeBytes: number | null
  /** Free bytes on the volume, or null when it could not be read. */
  freeBytes: number | null
}

export interface EnsureRamDiskResult {
  mountPoint: string
  sizeBytes: number
}

/** Spool size in MB: env override AGENTLENS_SPOOL_MB (floored at 64 MB — a smaller spool is a mistake),
 *  else the 2 GB default. */
export function spoolSizeMb(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SPOOL_MB_ENV])
  if (Number.isFinite(raw) && raw >= 64) return Math.floor(raw)
  return DEFAULT_SPOOL_MB
}

/** The bodies dir INSIDE the spool. This exact value is persisted as capture.spoolDir and used as the
 *  server's BODIES_DIR while capture is on — the ONE place the layout is defined. */
export function spoolDir(mountPoint: string = SPOOL_MOUNT_POINT): string {
  return path.join(mountPoint, 'otel-bodies')
}

function assertMac(): void {
  if (process.platform !== 'darwin') {
    throw new Error(`RAM-disk spool is macOS-only (platform: ${process.platform})`)
  }
}

/**
 * Report whether the named spool volume is mounted, and its size/free bytes. Uses `df -k <mountPoint>`:
 * a path that is not its own mount resolves to a PARENT filesystem, whose "Mounted on" column then
 * differs from mountPoint — which is exactly how we distinguish a real mount from a leftover plain dir.
 * Never throws: an absent path / df failure reads as "not mounted".
 */
export function ramDiskInfo(mountPoint: string = SPOOL_MOUNT_POINT): RamDiskInfo {
  const out: RamDiskInfo = { mounted: false, mountPoint, sizeBytes: null, freeBytes: null }
  let raw: string
  try {
    raw = execFileSync('df', ['-k', mountPoint], { encoding: 'utf8' })
  } catch {
    return out // df exits non-zero when the path does not exist → not mounted
  }
  const lines = raw.trim().split('\n')
  if (lines.length < 2) return out
  const cols = lines[lines.length - 1].trim().split(/\s+/)
  // BSD `df -k`: Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted-on
  if (cols[cols.length - 1] !== mountPoint) return out // resolved to a parent fs → not its own mount
  const totalKb = Number(cols[1])
  const availKb = Number(cols[3])
  out.mounted = true
  out.sizeBytes = Number.isFinite(totalKb) ? totalKb * 1024 : null
  out.freeBytes = Number.isFinite(availKb) ? availKb * 1024 : null
  return out
}

function dirHasFiles(dir: string): boolean {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const e of entries) {
    if (e.isFile() || e.isSymbolicLink()) return true
    if (e.isDirectory() && dirHasFiles(path.join(dir, e.name))) return true
  }
  return false
}

/**
 * Remove a LEFTOVER plain directory sitting at the mount point (e.g. a phantom `/Volumes/<name>` a
 * bodies-dir mkdir created while the spool was unmounted). If it survived, diskutil would mount the new
 * volume at "<name> 1" instead — a silent split-brain. Remove it ONLY when it is not a mount and holds
 * no regular files; if it holds real data, refuse loudly (RULE 0 — never delete data on a guess).
 */
function removeStaleMountDir(mountPoint: string): void {
  if (!fs.existsSync(mountPoint)) return
  if (ramDiskInfo(mountPoint).mounted) return // it IS a mount — never touch a mounted volume
  if (dirHasFiles(mountPoint)) {
    throw new Error(`refusing to create the spool: ${mountPoint} exists, is not a mount, and holds files — remove it by hand`)
  }
  fs.rmSync(mountPoint, { recursive: true, force: true })
}

/**
 * Ensure a mounted RAM-disk spool of the given size, returning its mount point + size. Idempotent:
 * an already-mounted spool of the same name is REUSED (just re-ensures the otel-bodies subdir). Fails
 * fast — a caller must never silently fall back to an SSD path (that is the whole point of the spool).
 */
export function ensureRamDisk(
  sizeMb: number = spoolSizeMb(),
  opts: { volumeName?: string } = {},
): EnsureRamDiskResult {
  assertMac()
  const volumeName = opts.volumeName ?? SPOOL_VOLUME_NAME
  const mountPoint = `/Volumes/${volumeName}`

  const existing = ramDiskInfo(mountPoint)
  if (existing.mounted) {
    fs.mkdirSync(spoolDir(mountPoint), { recursive: true })
    return { mountPoint, sizeBytes: existing.sizeBytes ?? sizeMb * 1024 * 1024 }
  }

  removeStaleMountDir(mountPoint)

  // 1 MB = 2048 × 512-byte sectors. hdiutil prints the new "/dev/diskN" on stdout.
  const sectors = Math.floor(sizeMb) * 2048
  const dev = execFileSync('hdiutil', ['attach', '-nomount', `ram://${sectors}`], { encoding: 'utf8' })
    .trim().split(/\s+/)[0]
  if (!dev.startsWith('/dev/')) {
    throw new Error(`hdiutil did not return a device node (got: ${JSON.stringify(dev)})`)
  }
  try {
    execFileSync('diskutil', ['erasevolume', 'HFS+', volumeName, dev], { encoding: 'utf8' })
  } catch (e) {
    // Formatting failed — detach the raw device so we do not leak an unformatted ram disk.
    try { execFileSync('hdiutil', ['detach', dev], { encoding: 'utf8' }) } catch { /* best effort */ }
    throw e
  }
  fs.mkdirSync(spoolDir(mountPoint), { recursive: true })
  const post = ramDiskInfo(mountPoint)
  if (!post.mounted) {
    throw new Error(`RAM disk ${volumeName} did not mount at ${mountPoint} after erasevolume`)
  }
  return { mountPoint, sizeBytes: post.sizeBytes ?? sizeMb * 1024 * 1024 }
}

/** Detach the spool (used by the opt-in integration test's cleanup; hdiutil accepts the mount point). */
export function detachRamDisk(mountPoint: string = SPOOL_MOUNT_POINT): void {
  assertMac()
  execFileSync('hdiutil', ['detach', mountPoint], { encoding: 'utf8' })
}
