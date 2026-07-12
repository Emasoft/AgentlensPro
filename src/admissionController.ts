// D3K7QM2P/1c — admission control. With 20+ Claude instances (plus subagents) hammering the CLI,
// the ONE server must not fall over: this bounds in-flight work, QUEUES the overflow briefly, and
// SHEDS (503 + Retry-After) only when a hard resource wall is hit or the queue is full. Shedding is
// LOSS-FREE by construction — a shed hook is spooled by the CLI (1a) and reingested on the next
// drain tick, and a shed OTLP export is retried by the exporter / backfilled by the next scan. The
// gate check fails OPEN on a shed (the CLI returns '' = allow), so backpressure never blocks a launch.

import type { ResourceSample } from './resourceMonitor'

export interface AdmissionLimits {
  /** Below this many in-flight, always admit (ample headroom — ignore load). */
  softInflight: number
  /** Absolute in-flight ceiling; at/above it, new work queues (or sheds when the queue is full). */
  maxInflight: number
  /** Bounded wait queue; when full, new work is shed immediately rather than growing memory. */
  maxQueue: number
  /** Hard RSS ceiling (MiB): over it, shed at once — never queue into a memory wall. */
  maxRssMb: number
  /** Hard floor on free disk (MiB) at the data dir: under it, shed (writes would fail anyway). */
  minFreeDiskMb: number
  /** Soft per-core load ceiling: between soft and max in-flight, high load queues instead of admitting. */
  loadPerCoreMax: number
  /** A queued request waits at most this long, then sheds — a caller is NEVER blocked unbounded. */
  queueWaitMs: number
}

export type ShedReason = 'rss' | 'disk' | 'inflight' | 'queue-timeout'
export interface AdmitResult { ok: boolean; reason: ShedReason | 'admit'; retryAfterSec?: number }

interface Waiter { done: (r: AdmitResult) => void; timer: ReturnType<typeof setTimeout> }

export class AdmissionController {
  private inflight = 0
  private waiters: Waiter[] = []
  private shedTotal = 0
  private admittedTotal = 0

  constructor(
    private readonly limits: AdmissionLimits,
    private readonly sample: () => ResourceSample,
  ) {}

  /** Decide whether to run a request now. Resolves { ok:true } to proceed (a slot is reserved — the
   *  caller MUST call leave() when done), or { ok:false, reason, retryAfterSec } to shed. May wait
   *  up to queueWaitMs in the bounded queue before shedding. Never rejects. */
  enter(): Promise<AdmitResult> {
    const s = this.sample()
    // Hard walls → shed at once; queueing into these would just delay an inevitable failure.
    if (s.rssMb > this.limits.maxRssMb) return this.shed('rss', 2)
    if (s.freeDiskMb < this.limits.minFreeDiskMb) return this.shed('disk', 5)
    // Admit when below the ceiling AND (below the soft mark OR load is healthy). Between soft and
    // max, high load is the signal to start queueing (backpressure) rather than pile on more work.
    const admittable = this.inflight < this.limits.maxInflight
      && (this.inflight < this.limits.softInflight || s.loadPerCore <= this.limits.loadPerCoreMax)
    if (admittable) {
      this.inflight++
      this.admittedTotal++
      return Promise.resolve({ ok: true, reason: 'admit' })
    }
    if (this.waiters.length >= this.limits.maxQueue) return this.shed('inflight', 1)
    return new Promise<AdmitResult>((resolve) => {
      const w: Waiter = {
        done: resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(w)
          if (i >= 0) this.waiters.splice(i, 1)
          this.shedTotal++
          resolve({ ok: false, reason: 'queue-timeout', retryAfterSec: 1 })
        }, this.limits.queueWaitMs),
      }
      // A queue-timeout timer must not keep the process alive on its own.
      if (typeof (w.timer as { unref?: () => void }).unref === 'function') (w.timer as { unref: () => void }).unref()
      this.waiters.push(w)
    })
  }

  /** Release a reserved slot and promote the oldest queued waiter (FIFO), if any and there is room. */
  leave(): void {
    if (this.inflight > 0) this.inflight--
    if (this.waiters.length > 0 && this.inflight < this.limits.maxInflight) {
      const w = this.waiters.shift() as Waiter
      clearTimeout(w.timer)
      this.inflight++
      this.admittedTotal++
      w.done({ ok: true, reason: 'admit' })
    }
  }

  stats(): { inflight: number; queued: number; admittedTotal: number; shedTotal: number } {
    return { inflight: this.inflight, queued: this.waiters.length, admittedTotal: this.admittedTotal, shedTotal: this.shedTotal }
  }

  private shed(reason: ShedReason, retryAfterSec: number): Promise<AdmitResult> {
    this.shedTotal++
    return Promise.resolve({ ok: false, reason, retryAfterSec })
  }
}

/** Default limits, overridable by env (read once by the server at boot). Scaled to CPU count so a
 *  laptop and a 32-core box both get a sane concurrency ceiling. */
export function admissionLimitsFromEnv(env: NodeJS.ProcessEnv, cpuCount: number): AdmissionLimits {
  const n = (k: string, d: number): number => {
    const v = Number(env[k])
    return Number.isFinite(v) && v > 0 ? v : d
  }
  const soft = n('AGENTLENS_MAX_INFLIGHT_SOFT', Math.max(8, cpuCount * 4))
  return {
    softInflight: soft,
    maxInflight: n('AGENTLENS_MAX_INFLIGHT', Math.max(soft * 2, cpuCount * 8)),
    maxQueue: n('AGENTLENS_ADMIT_MAX_QUEUE', 256),
    maxRssMb: n('AGENTLENS_MAX_RSS_MB', 5120),
    minFreeDiskMb: n('AGENTLENS_MIN_FREE_DISK_MB', 200),
    loadPerCoreMax: n('AGENTLENS_LOADAVG_MAX', 4),
    queueWaitMs: n('AGENTLENS_ADMIT_QUEUE_WAIT_MS', 750),
  }
}
