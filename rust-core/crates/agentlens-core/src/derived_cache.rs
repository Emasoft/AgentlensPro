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

    /// `{hits, misses}` — served on /api/debug/log-scan-stats `derivedCaches`.
    pub fn stats(&self) -> (u64, u64) {
        (self.hits, self.misses)
    }
}
