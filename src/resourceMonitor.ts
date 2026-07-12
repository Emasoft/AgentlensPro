// D3K7QM2P/1c — resource monitor. Samples the ONE process's live resource pressure so the admission
// controller can shed/queue before 20+ concurrent Claude instances (plus their subagents) melt the
// server. Cheap and TTL-cached (default 1s) so sampling on every request is negligible. Runtime-
// neutral except for os/fs (Node host + standalone server; not the webview).

import * as os from 'os'
import * as fs from 'fs'

export interface ResourceSample {
  /** Resident set size in MiB. */
  rssMb: number
  /** 1-minute load average divided by CPU count (≈ per-core saturation; 0 on platforms without loadavg). */
  loadPerCore: number
  /** Free space on the data dir in MiB; Infinity when it cannot be determined (never blocks on unknown). */
  freeDiskMb: number
  /** Logical CPU count (≥ 1). */
  cpuCount: number
}

// fs.statfsSync landed in Node 18.15; older 18.x lacks it. Optional-typed so a missing impl degrades
// to "disk free unknown" (Infinity) rather than throwing.
type StatfsLike = { bavail: number; bsize: number }
const statfsSync: ((p: string) => StatfsLike) | undefined =
  (fs as unknown as { statfsSync?: (p: string) => StatfsLike }).statfsSync

export class ResourceMonitor {
  private cached: ResourceSample | null = null
  private cachedAt = -Infinity

  constructor(
    private readonly dataDir: string,
    private readonly ttlMs: number = 1000,
    // Injectable clock so the cache TTL is testable without wall-clock flake.
    private readonly now: () => number = Date.now,
  ) {}

  /** Current pressure, served from the ≤ttlMs cache when fresh. */
  sample(): ResourceSample {
    const t = this.now()
    if (this.cached && t - this.cachedAt < this.ttlMs) return this.cached
    const cpuCount = Math.max(1, os.cpus().length)
    const rssMb = process.memoryUsage().rss / 1048576
    // os.loadavg() is [0,0,0] on Windows — loadPerCore then stays 0 (RSS/disk limits still apply).
    const loadPerCore = (os.loadavg()[0] || 0) / cpuCount
    let freeDiskMb = Infinity
    if (statfsSync) {
      try {
        const st = statfsSync(this.dataDir)
        if (st && Number.isFinite(st.bavail) && Number.isFinite(st.bsize)) {
          freeDiskMb = (st.bavail * st.bsize) / 1048576
        }
      } catch { /* unknown → no disk limit */ }
    }
    this.cached = { rssMb, loadPerCore, freeDiskMb, cpuCount }
    this.cachedAt = t
    return this.cached
  }
}
