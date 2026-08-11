// Back-pressure for the RAM-disk spool (TRDD-KB17X5G2, Option 3): a single background subagent
// refilled the 2GB spool from 162MB free to 1.4MB free (100%) in ~2 minutes. At 100% the spool
// cannot accept a write, so raw bodies are DROPPED — silent data loss, the exact failure the
// whole capture feature exists to prevent.
//
// WHY THIS OPERATES AT THE CONFIG BOUNDARY, NOT AT A `fs.writeFile` CALL: the raw body write
// itself is NOT performed by this process. Claude Code's own OTEL exporter writes the file
// directly, keyed off the launch-time env var OTEL_LOG_RAW_API_BODIES=file:<dir> (see
// src/rawBodyContext.ts's header comment and src/bodyWriters.ts's "A Claude session keeps its
// launch-time OTEL_LOG_RAW_API_BODIES env until restarted" note). There is no write call in this
// codebase to wrap in a try/catch. What we DO control is which directory a session is TOLD to
// write into — so back-pressure here means: once the spool is at/over capacity, repoint the
// OWNED telemetry env var at the legacy SSD bodies dir (already drain target #2) so any NEWLY
// STARTED session spills there instead of failing writes into a full spool. This is a real trade:
// it protects every session that starts AFTER the redirect, not the bytes an already-running
// session writes in the same instant the spool crosses 100% (that window is unavoidable without
// a write hook this process does not have). Say that plainly rather than claiming elimination —
// this is the same discipline the parent TRDD applies to the "grow the spool" option.
import { ramDiskInfo, SPOOL_MOUNT_POINT } from './ramdisk'

/** Free-bytes floor under which the spool is treated as "at capacity". 64MB is comfortably above
 *  one burst's worth of bodies (each request/response pair runs ~0.7-1.9MB per bodyWriters.ts),
 *  so back-pressure engages with room left, not after the last bytes are already gone. */
export const DEFAULT_SPOOL_FLOOR_BYTES = 64 * 1024 * 1024
export const SPOOL_FLOOR_MB_ENV = 'AGENTLENS_SPOOL_FLOOR_MB'

/** Floor in bytes: env override `AGENTLENS_SPOOL_FLOOR_MB` (any positive number), else the 64MB
 *  default. Mirrors `spoolSizeMb`'s tolerant-parse shape in ramdisk.ts. */
export function spoolFloorBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SPOOL_FLOOR_MB_ENV])
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw) * 1024 * 1024
  return DEFAULT_SPOOL_FLOOR_BYTES
}

export interface SpoolCapacityCheck {
  overCapacity: boolean
  freeBytes: number | null
  floorBytes: number
}

/** Real free-bytes read (`df`, via ramdisk.ts's `ramDiskInfo`) — a pre-check is inherently a
 *  TOCTOU race against whatever writes next (nothing in THIS process performs the write it is
 *  guarding, so there is no error to catch instead), which is why it is re-evaluated on every
 *  caller tick rather than cached. `freeBytes === null` (df failed, or the mount point is not
 *  actually mounted) reads as NOT over capacity — fail OPEN, so a transient `df` hiccup never
 *  wrongly redirects sessions away from a perfectly healthy spool. */
export function checkSpoolCapacity(
  mountPoint: string = SPOOL_MOUNT_POINT,
  floorBytes: number = spoolFloorBytes(),
): SpoolCapacityCheck {
  const info = ramDiskInfo(mountPoint)
  const freeBytes = info.freeBytes
  return { overCapacity: freeBytes !== null && freeBytes < floorBytes, freeBytes, floorBytes }
}

export interface BackpressureState {
  /** True while new sessions are being pointed at the legacy SSD dir instead of the spool. */
  redirected: boolean
  /** Count of transitions INTO redirected state — the visible "we spilled to SSD N times" figure. */
  spills: number
}

export const INITIAL_BACKPRESSURE_STATE: BackpressureState = { redirected: false, spills: 0 }

export interface BackpressureDeps {
  redirectToLegacy: () => void | Promise<void>
  restoreToSpool: () => void | Promise<void>
  onWarn?: (msg: string) => void
  onInfo?: (msg: string) => void
}

/** One controller tick: given the current capacity reading and prior state, decide whether to
 *  (re)direct and apply it via the injected callbacks (kept injectable so tests never touch the
 *  real spool or a user's real Claude Code settings.json). Hysteresis on recovery — free bytes
 *  must exceed 2x the floor before switching back — so a spool oscillating right at the floor
 *  does not flap the config (a redirect writer, per telemetryConfig.ts, is a settings.json
 *  rewrite; flapping it every tick would be its own kind of disk churn). */
export async function applySpoolBackpressure(
  check: SpoolCapacityCheck,
  state: BackpressureState,
  deps: BackpressureDeps,
): Promise<BackpressureState> {
  if (check.overCapacity && !state.redirected) {
    await deps.redirectToLegacy()
    deps.onWarn?.(
      `spool at capacity (${check.freeBytes ?? 'unknown'} bytes free, floor ${check.floorBytes}) — ` +
      `new sessions redirected to the legacy SSD bodies dir until it recovers`,
    )
    return { redirected: true, spills: state.spills + 1 }
  }
  if (!check.overCapacity && state.redirected && check.freeBytes !== null && check.freeBytes > check.floorBytes * 2) {
    await deps.restoreToSpool()
    deps.onInfo?.(`spool recovered (${check.freeBytes} bytes free) — new sessions redirected back to the RAM-disk spool`)
    return { redirected: false, spills: state.spills }
  }
  return state
}
