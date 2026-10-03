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
        if !self.would_store(version) {
            return self.cached.clone().unwrap_or_else(|| Arc::new(value));
        }
        let value = Arc::new(value);
        self.cached = Some(value.clone());
        self.version = version;
        self.misses += 1;
        value
    }

    /// Would a build for `version` land? A held value only yields to a STRICTLY newer build. An
    /// EMPTY slot (its value was `take_arc`ed by the rebuild in flight) still remembers the version
    /// it held and refuses anything OLDER than that: without this a late old build stored into the
    /// emptied slot would move the cache backwards and the next pass would patch from stale inputs.
    /// Equal is allowed when empty — the cold start (version 0) and a pressure-ladder `clear` both
    /// rebuild at the version the slot already remembers.
    pub fn would_store(&self, version: u64) -> bool {
        // Defensive: rebuild_gate already serializes production rebuilds (ui.rs rebuild_once and summary_now hold it from snapshot to store); this guard keeps a future ungated caller from moving the cache backwards.
        if self.cached.is_some() { version > self.version } else { version >= self.version }
    }


    /// `store_if_newer` for a value the caller already wrapped in an `Arc`. The summary engine
    /// (TRDD-9VX3WTGU Phase C part 2) records the pointer it published so it can recognise its own
    /// previous output next pass; wrapping inside the cache would hide that pointer from it.
    pub fn store_arc_if_newer(&mut self, version: u64, value: Arc<T>) -> Arc<T> {
        if !self.would_store(version) {
            return self.cached.clone().unwrap_or(value);
        }
        self.cached = Some(value.clone());
        self.version = version;
        self.misses += 1;
        value
    }

    /// Hand the cached `Arc` to the caller and leave the cache EMPTY (its version is kept). The
    /// summary engine takes its previous output this way so that, when no reader still holds it,
    /// `Arc::try_unwrap` yields the value for in-place patching instead of a deep copy. While the
    /// value is out, `cached_any`/`current` answer `None` and readers wait on the rebuild gate —
    /// a pass is now O(changed cards), so that wait is short.
    pub fn take_arc(&mut self) -> Option<(u64, Arc<T>)> {
        let v = self.cached.take()?;
        Some((self.version, v))
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

    /// The stored value WHATEVER version it was built for, WITHOUT counting a hit — the
    /// measurement half of the cache (TRDD-2JOIAH2G round-73). Unlike `cached_any` this is a
    /// pure observer: the composition tick samples it every 60s, and counting those reads as
    /// hits would inflate the served hit/miss ratio on /api/debug/log-scan-stats. The clone is
    /// one refcount bump; the caller serializes OFF the lock — a multi-MB `Value` must never be
    /// walked while the state mutex is held.
    pub fn cached_value(&self) -> Option<Arc<T>> {
        self.cached.clone()
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


    /// Drop the stored value so the next `get` recomputes (memory-pressure ladder). Leaves
    /// `version` and the hit/miss counters alone — no data_version moves, only the memo is shed.
    pub fn clear(&mut self) {
        self.cached = None;
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cached_value_observes_without_counting_a_hit() {
        let mut c = VersionedCache::default();
        assert!(c.cached_value().is_none(), "empty cache must report None");
        c.store_if_newer(7, json!({"k": [1, 2, 3]}));
        let before = c.stats();
        let v = c.cached_value().expect("stored value must be observable");
        assert_eq!(*v, json!({"k": [1, 2, 3]}));
        assert_eq!(c.version(), 7);
        assert_eq!(c.stats(), before, "a measurement read is NOT a hit");
    }

    #[test]
    fn cached_value_serializes_to_the_value_bytes() {
        let mut c = VersionedCache::default();
        c.store_if_newer(1, json!("hello"));
        let v = c.cached_value().unwrap();
        assert_eq!(serde_json::to_vec(v.as_ref()).unwrap().len(), 7); // "hello" quoted
    }


    /// A held value yields only to a STRICTLY newer build.
    #[test]
    fn a_held_value_yields_only_to_a_strictly_newer_build() {
        let mut c = VersionedCache::default();
        c.store_if_newer(5, json!("five"));
        assert!(!c.would_store(4) && !c.would_store(5) && c.would_store(6));
        assert_eq!(*c.store_if_newer(4, json!("late")), json!("five"), "a late older build is discarded, the held value served");
        assert_eq!(c.version(), 5);
    }

    /// The slot a rebuild in flight emptied (`take_arc`) still remembers its version: a late OLDER
    /// build must not land in it (that moved the cache backwards), while an equal or newer one may.
    #[test]
    fn an_emptied_slot_refuses_an_older_build_but_takes_an_equal_or_newer_one() {
        let mut c = VersionedCache::default();
        c.store_if_newer(5, json!("five"));
        let (v, _held) = c.take_arc().expect("held");
        assert_eq!(v, 5);
        assert!(c.is_empty() && !c.would_store(4) && c.would_store(5) && c.would_store(6));
        assert_eq!(*c.store_arc_if_newer(4, Arc::new(json!("late"))), json!("late"), "the refused build is handed back to its caller");
        assert!(c.is_empty(), "the refused build did not land");
        c.store_arc_if_newer(5, Arc::new(json!("same")));
        assert_eq!(c.version(), 5);
        assert!(!c.is_empty());
    }

    /// Cold start (version 0, empty) and a pressure-ladder `clear` both rebuild at the version the
    /// slot remembers.
    #[test]
    fn a_cold_or_cleared_slot_accepts_the_version_it_remembers() {
        let mut c: VersionedCache<serde_json::Value> = VersionedCache::default();
        assert!(c.would_store(0));
        c.store_if_newer(7, json!(1));
        c.clear();
        assert!(c.would_store(7) && !c.would_store(6));
    }

}
