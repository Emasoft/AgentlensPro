//! Admission control (D3K7QM2P/1c) — the Rust port of `src/admissionController.ts`.
//!
//! With 20+ Claude instances (plus subagents) hammering the CLI, the ONE server must not fall
//! over: this bounds in-flight work, QUEUES the overflow briefly, and SHEDS (503 + `Retry-After`)
//! only when a hard resource wall is hit or the queue is full.
//!
//! **Shedding is LOSS-FREE by construction**, and that is what makes it an acceptable answer at
//! all: a shed hook is spooled by the CLI and reingested on the next drain tick, and a shed OTLP
//! export is retried by the exporter or backfilled by the next JSONL scan. The gate check fails
//! OPEN on a shed, so backpressure never blocks a launch.
//!
//! Ported because it existed ONLY in the TypeScript server, which no longer ships
//! (TRDD-1B98LCVR box 2) — so until now every published install ran with no admission control at
//! all and `shedTotal` permanently 0. Measured as one of 14 parity gaps in TRDD-465EXTJ6.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use tokio::sync::{Semaphore, SemaphorePermit, TryAcquireError};

/// Why a request was refused. Carried into the 503 body so a shed is diagnosable from the client
/// side — "server busy" alone cannot tell a memory wall from a full queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShedReason {
    Rss,
    Disk,
    Inflight,
    QueueTimeout,
}

impl ShedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ShedReason::Rss => "rss",
            ShedReason::Disk => "disk",
            ShedReason::Inflight => "inflight",
            ShedReason::QueueTimeout => "queue-timeout",
        }
    }

    /// The `Retry-After` seconds for this reason, matching the TS controller exactly. A memory
    /// wall clears slower than a full queue, so they are deliberately not one constant.
    pub fn retry_after_sec(self) -> u64 {
        match self {
            ShedReason::Rss => 2,
            ShedReason::Disk => 5,
            ShedReason::Inflight | ShedReason::QueueTimeout => 1,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct AdmissionLimits {
    /// Below this many in-flight, always admit (ample headroom — ignore load).
    pub soft_inflight: usize,
    /// Absolute in-flight ceiling; at/above it, new work queues (or sheds when the queue is full).
    pub max_inflight: usize,
    /// Bounded wait queue; when full, new work is shed immediately rather than growing memory.
    pub max_queue: usize,
    /// Hard RSS ceiling (MiB): over it, shed at once — never queue into a memory wall.
    pub max_rss_mb: f64,
    /// Hard floor on free disk (MiB) at the data dir: under it, shed (writes would fail anyway).
    pub min_free_disk_mb: f64,
    /// Soft per-core load ceiling: between soft and max in-flight, high load queues instead of admitting.
    pub load_per_core_max: f64,
    /// A queued request waits at most this long, then sheds — a caller is NEVER blocked unbounded.
    pub queue_wait_ms: u64,
}

impl AdmissionLimits {
    /// Defaults scaled to CPU count so a laptop and a 32-core box both get a sane ceiling, with the
    /// SAME env-var names the TypeScript server reads. The names are part of the contract — an
    /// operator who tuned `AGENTLENS_MAX_RSS_MB` for the TS server must keep that tuning after the
    /// engine swap, and silently renaming them would look like the setting stopped working.
    pub fn from_env(cpu_count: usize) -> Self {
        let n = |k: &str, d: f64| -> f64 {
            std::env::var(k).ok().and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).unwrap_or(d)
        };
        let cpus = cpu_count.max(1);
        let soft = n("AGENTLENS_MAX_INFLIGHT_SOFT", (8.0_f64).max(cpus as f64 * 4.0));
        Self {
            soft_inflight: soft as usize,
            max_inflight: n("AGENTLENS_MAX_INFLIGHT", (soft * 2.0).max(cpus as f64 * 8.0)) as usize,
            max_queue: n("AGENTLENS_ADMIT_MAX_QUEUE", 256.0) as usize,
            max_rss_mb: n("AGENTLENS_MAX_RSS_MB", 5120.0),
            min_free_disk_mb: n("AGENTLENS_MIN_FREE_DISK_MB", 200.0),
            load_per_core_max: n("AGENTLENS_LOADAVG_MAX", 4.0),
            queue_wait_ms: n("AGENTLENS_ADMIT_QUEUE_WAIT_MS", 750.0) as u64,
        }
    }
}

/// One resource reading, taken once per admission decision. Passed in rather than sampled here so
/// the controller stays pure and testable — the tests drive the walls directly instead of having to
/// manufacture real memory pressure.
#[derive(Clone, Copy, Debug)]
pub struct ResourceSample {
    pub rss_mb: f64,
    pub free_disk_mb: f64,
    pub load_per_core: f64,
}

pub struct Admission {
    limits: AdmissionLimits,
    /// `max_inflight` permits. A permit IS the reserved slot, and dropping it releases the slot —
    /// which is why there is no `leave()` here and no way to forget one. The TS twin needed a
    /// once-guard because it hooked BOTH `finish` and `close` and a client abort fires both; an
    /// RAII permit cannot double-release, so that whole class of bug does not exist in this port.
    sem: Semaphore,
    queued: AtomicUsize,
    admitted_total: AtomicU64,
    shed_total: AtomicU64,
}

/// The reserved slot. Held for the life of the response; the slot is returned on drop.
pub struct AdmitGuard<'a>(#[allow(dead_code)] SemaphorePermit<'a>);

pub enum Admit<'a> {
    Ok(AdmitGuard<'a>),
    Shed(ShedReason),
}

impl Admission {
    pub fn new(limits: AdmissionLimits) -> Self {
        Self {
            sem: Semaphore::new(limits.max_inflight),
            limits,
            queued: AtomicUsize::new(0),
            admitted_total: AtomicU64::new(0),
            shed_total: AtomicU64::new(0),
        }
    }

    /// These endpoints must ALWAYS answer, even at capacity. `/events` is a long-lived SSE stream
    /// (holding a slot for its whole lifetime would drain the pool); `/api/server-stats` is how
    /// monitors and the CLI read health UNDER LOAD — a health endpoint that sheds is useless
    /// exactly when it is needed, and it is also how a shed is observed at all; `GET
    /// /api/hook-config` is the kill-switch read, so capture/gate can be turned OFF when the box is
    /// on fire. Same set as `isAdmissionExempt` in standalone/server.ts.
    pub fn is_exempt(method: &str, path: &str) -> bool {
        path == "/events"
            || path == "/api/server-stats"
            || (method == "GET" && path == "/api/hook-config")
            || (method == "GET" && path == "/api/embed-status")
    }

    pub async fn enter(&self, s: ResourceSample) -> Admit<'_> {
        // Hard walls FIRST — queueing into these would only delay an inevitable failure, and
        // queueing into a memory wall actively makes it worse by holding the request bodies.
        if s.rss_mb > self.limits.max_rss_mb {
            return self.shed(ShedReason::Rss);
        }
        if s.free_disk_mb < self.limits.min_free_disk_mb {
            return self.shed(ShedReason::Disk);
        }
        match self.sem.try_acquire() {
            Ok(permit) => {
                // A permit was free. Below the soft mark we take it unconditionally; between soft
                // and max, HIGH LOAD is the signal to start queueing (backpressure) rather than
                // piling on more concurrent work — so the permit is given back and we fall through.
                let inflight = self.limits.max_inflight - self.sem.available_permits();
                if inflight <= self.limits.soft_inflight || s.load_per_core <= self.limits.load_per_core_max {
                    self.admitted_total.fetch_add(1, Ordering::Relaxed);
                    return Admit::Ok(AdmitGuard(permit));
                }
                drop(permit);
            }
            Err(TryAcquireError::NoPermits) => {}
            // The semaphore is only closed at shutdown; refusing is the correct answer then.
            Err(TryAcquireError::Closed) => return self.shed(ShedReason::Inflight),
        }
        if self.queued.load(Ordering::Relaxed) >= self.limits.max_queue {
            return self.shed(ShedReason::Inflight);
        }
        self.queued.fetch_add(1, Ordering::Relaxed);
        let waited = tokio::time::timeout(
            std::time::Duration::from_millis(self.limits.queue_wait_ms),
            self.sem.acquire(),
        )
        .await;
        self.queued.fetch_sub(1, Ordering::Relaxed);
        match waited {
            Ok(Ok(permit)) => {
                self.admitted_total.fetch_add(1, Ordering::Relaxed);
                Admit::Ok(AdmitGuard(permit))
            }
            // Timed out, or the semaphore closed while waiting. Either way the caller is released
            // rather than blocked — an unbounded wait is the failure this whole module prevents.
            _ => self.shed(ShedReason::QueueTimeout),
        }
    }

    fn shed(&self, reason: ShedReason) -> Admit<'_> {
        self.shed_total.fetch_add(1, Ordering::Relaxed);
        Admit::Shed(reason)
    }

    pub fn stats(&self) -> (usize, usize, u64, u64) {
        (
            self.limits.max_inflight - self.sem.available_permits(),
            self.queued.load(Ordering::Relaxed),
            self.admitted_total.load(Ordering::Relaxed),
            self.shed_total.load(Ordering::Relaxed),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> AdmissionLimits {
        AdmissionLimits {
            soft_inflight: 1,
            max_inflight: 2,
            max_queue: 1,
            max_rss_mb: 1000.0,
            min_free_disk_mb: 100.0,
            load_per_core_max: 4.0,
            queue_wait_ms: 30,
            }
    }
    fn healthy() -> ResourceSample {
        ResourceSample { rss_mb: 10.0, free_disk_mb: 10_000.0, load_per_core: 0.1 }
    }

    #[tokio::test]
    async fn the_hard_rss_wall_sheds_immediately_and_counts() {
        let a = Admission::new(limits());
        let over = ResourceSample { rss_mb: 5000.0, ..healthy() };
        assert!(matches!(a.enter(over).await, Admit::Shed(ShedReason::Rss)));
        assert_eq!(a.stats().3, 1, "a shed must be COUNTED — shedTotal is the only way an operator sees backpressure happened");
    }

    #[tokio::test]
    async fn a_disk_floor_sheds_with_its_own_retry_after() {
        let a = Admission::new(limits());
        let low = ResourceSample { free_disk_mb: 1.0, ..healthy() };
        // Extract before the match's temporary can outlive `a` — `Admit` borrows the controller.
        let reason = match a.enter(low).await {
            Admit::Shed(r) => r,
            Admit::Ok(_) => panic!("a disk floor must shed — the write would fail anyway"),
        };
        assert_eq!((reason, reason.retry_after_sec()), (ShedReason::Disk, 5));
    }

    #[tokio::test]
    async fn a_dropped_guard_returns_the_slot() {
        let a = Admission::new(limits());
        {
            let _g = match a.enter(healthy()).await { Admit::Ok(g) => g, Admit::Shed(_) => panic!("healthy must admit") };
            assert_eq!(a.stats().0, 1, "a held guard is one in-flight slot");
        }
        assert_eq!(a.stats().0, 0, "dropping the guard must return the slot — this is what replaces the TS leave()");
    }

    #[tokio::test]
    async fn a_full_queue_sheds_rather_than_growing_memory() {
        let a = Admission::new(limits());
        // Fill every permit so nothing can be admitted.
        let _g1 = match a.enter(healthy()).await { Admit::Ok(g) => g, Admit::Shed(_) => panic!("1st admits") };
        let _g2 = match a.enter(healthy()).await { Admit::Ok(g) => g, Admit::Shed(_) => panic!("2nd admits") };
        // max_queue is 1, and the queued waiter times out rather than waiting forever.
        let shed = matches!(a.enter(healthy()).await, Admit::Shed(ShedReason::QueueTimeout));
        assert!(shed);
        assert!(a.stats().3 >= 1);
        // Explicit drop order: the guards borrow `a`, so they must die before it.
        drop(_g1);
        drop(_g2);
    }

    #[tokio::test]
    async fn stats_is_exempt_so_health_is_readable_under_load() {
        assert!(Admission::is_exempt("GET", "/api/server-stats"));
        assert!(Admission::is_exempt("GET", "/events"));
        assert!(Admission::is_exempt("GET", "/api/hook-config"));
        assert!(!Admission::is_exempt("POST", "/api/hook-config"), "only the kill-switch READ is exempt");
        assert!(!Admission::is_exempt("POST", "/api/import"), "ordinary work is never exempt");
    }
}
