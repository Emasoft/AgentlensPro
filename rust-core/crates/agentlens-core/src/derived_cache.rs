//! src/derivedCache.ts VersionedCache — one derived value memoized by the data version: a
//! request that arrives while nothing changed is a hit (no rebuild); the first request after a
//! change rebuilds once. At 13.5k cards the merged summary costs ~1s to build, and the dashboard
//! polls `/api/summary` + every SSE subscriber gets the same payload — without this every poll
//! paid the full rebuild (TRDD-DMWOBWFH P5b perf note). Values are shared (`Arc`): a hit is a
//! pointer copy, never a deep clone of a 13k-card tree.

use std::sync::Arc;

pub struct VersionedCache<T> {
    version: u64,
    cached: Option<Arc<T>>,
    hits: u64,
    misses: u64,
}

impl<T> Default for VersionedCache<T> {
    fn default() -> Self {
        VersionedCache { version: 0, cached: None, hits: 0, misses: 0 }
    }
}

impl<T> VersionedCache<T> {
    /// The cached value for `version`, else `compute()` (stored for that version). A compute
    /// that panics propagates — a broken derivation must be loud, never a stale value.
    pub fn get(&mut self, version: u64, compute: impl FnOnce() -> T) -> Arc<T> {
        if let Some(v) = self.cached.as_ref().filter(|_| self.version == version) {
            self.hits += 1;
            return v.clone();
        }
        let value = Arc::new(compute());
        self.cached = Some(value.clone());
        self.version = version;
        self.misses += 1;
        value
    }

    /// The cached value IF it was built for `version` — the read half of an OFF-LOCK rebuild
    /// (TRDD-HFV4AIT7). A hit costs one pointer clone while the state lock is held; a miss tells
    /// the caller to rebuild *after* releasing it, which is the whole point: `get` runs `compute`
    /// under whatever lock the caller holds, and at 13.5k cards that parked ingest on the mutex.
    pub fn current(&mut self, version: u64) -> Option<Arc<T>> {
        let v = self.cached.as_ref().filter(|_| self.version == version)?.clone();
        self.hits += 1;
        Some(v)
    }

    /// Store a value computed off the lock. A rebuild that finishes AFTER a newer one already
    /// landed is DISCARDED — its inputs are older, so storing it would move the cache backwards;
    /// the caller gets whatever is current instead. Counts a miss only when it actually stores,
    /// so the hit/miss ratio still reads as "rebuilds vs reuses".
    pub fn store_if_newer(&mut self, version: u64, value: T) -> Arc<T> {
        if let Some(v) = self.cached.as_ref().filter(|_| self.version >= version) {
            return v.clone();
        }
        let value = Arc::new(value);
        self.cached = Some(value.clone());
        self.version = version;
        self.misses += 1;
        value
    }

    /// The cached value and the version it was built for, WHATEVER that version is — the
    /// serve-stale half of a non-blocking rebuild (TRDD-2R36W8Q1).
    ///
    /// WHY THIS EXISTS. `current` demands an exact version match, and `data_version` bumps on
    /// EVERY ingest (lib.rs:247, :554, :603, :737). Measured 2026-08-29 at 2,600 spans/s (100
    /// sessions x 26/s): the key moves ~130x/second while one rebuild over the 1M-span window
    /// takes over 20 s, so `current` misses essentially every time and the exact-match contract
    /// alone can never be satisfied under sustained load. `/api/server-stats` stopped answering
    /// entirely (>20 s, zero bytes) while ingest stayed healthy at 0.3 ms.
    ///
    /// Returns the PAIR, not just the value: the caller must report the version the summary was
    /// actually built for, never the current `data_version`. `stripped_cache` is keyed on the
    /// version `summary_now` returns, so reporting a version the body does not match would key a
    /// derived value to inputs it was not derived from. Returning the real pair keeps the two
    /// caches coherent — both describe the same snapshot, merely an older one.
    ///
    /// Counts a HIT: serving this is a reuse, which is exactly what the hit/miss ratio measures.
    pub fn cached_any(&mut self) -> Option<(u64, Arc<T>)> {
        let v = self.cached.as_ref()?.clone();
        self.hits += 1;
        Some((self.version, v))
    }

    /// True until the first value of any version lands — the cold-boot discriminator (nothing to
    /// serve stale yet, so a reader may build one itself).
    pub fn is_empty(&self) -> bool {
        self.cached.is_none()
    }

    /// The version the cached value was built for (0 when empty — pair it with `is_empty`).
    pub fn version(&self) -> u64 {
        self.version
    }

    /// `{hits, misses}` — served on /api/debug/log-scan-stats `derivedCaches`.
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }
}
