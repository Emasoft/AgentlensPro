//! The standalone server's in-memory summarization window (TRDD-DMWOBWFH P4h) — server.ts
//! `spans` + `effectiveWindowMs`: the array every derived view (summary, SSE update payload,
//! analytics) is computed over. It is NOT the 5-minute collector SessionStore (that is the
//! VS-Code-era otlpCollector path, unused by the standalone server): at boot it is loaded from
//! the segmented span store for the last `summaryWindowHours` (default 24h), every ingested
//! span is appended, and the flush tick prunes by the span's own timestamp — "memory is the time
//! window, disk is everything". Nothing is evicted from disk.
//!
//! The TS heap/rss-pressure halving of `effectiveWindowMs` IS now ported, as
//! `apply_memory_pressure` below — keyed on RSS (portable: proc_pidinfo on macOS, /proc on Linux)
//! rather than the TS's V8 heap heuristic, which has no Rust analogue. It was deliberately skipped
//! at port time, and that gap left alcore with strictly LESS protection than the server it
//! replaced: measured 2026-08-29, a flood drove RSS to 10.25 GB and wedged the process in the
//! summary rebuild over the window.

use std::path::Path;
use std::sync::Arc;

use agentlens_spanstore::writer::{span_timestamp_ms, SpanStoreWriter};
use serde_json::Value;

/// server.ts SUMMARY_WINDOW_FLOOR_MS.
pub const SUMMARY_WINDOW_FLOOR_MS: i64 = 5 * 60_000;

/// server.ts SUMMARY_WINDOW_MS: the `summaryWindowHours` knob (retention_config.rs — env > the
/// data dir's `config.json` > 24, min 1 hour) in ms, then the 5-minute floor.
pub fn summary_window_ms(data_dir: &Path) -> i64 {
    let hours = crate::retention_config::resolve_knob(data_dir, &crate::retention_config::SUMMARY_WINDOW_HOURS);
    ((hours * 3_600_000.0) as i64).max(SUMMARY_WINDOW_FLOOR_MS)
}

pub struct SpanWindow {
    /// `Arc` per span, not `Value` (TRDD-HFV4AIT7): the summary rebuild has to run OFF the state
    /// mutex, and that needs a SNAPSHOT of the window. With plain `Value`s the snapshot is a deep
    /// clone of every span under the lock — which just moves the stall. With `Arc`s it is one
    /// pointer copy per span (~1-2 ms at 289k spans). Nothing mutates a stored span after `add`
    /// (no reader takes `iter_mut`), so sharing is safe by construction.
    pub spans: Vec<Arc<Value>>,
    pub configured_ms: i64,
    pub effective_ms: i64,
}

impl SpanWindow {
    pub fn new(configured_ms: i64) -> SpanWindow {
        SpanWindow { spans: Vec::new(), configured_ms, effective_ms: configured_ms }
    }

    /// Boot load: ONLY the segments overlapping the window — never the whole store.
    pub fn boot_load(&mut self, writer: &mut SpanStoreWriter, now_ms: i64) -> usize {
        self.spans = writer.load_range(now_ms - self.configured_ms, i64::MAX, now_ms).into_iter().map(Arc::new).collect();
        self.spans.len()
    }

    /// addSpan: stamp receivedAt when absent, append (the store append is the caller's).
    pub fn add(&mut self, mut span: Value, now_ms: i64) {
        if let Some(obj) = span.as_object_mut() {
            if !obj.contains_key("receivedAt") {
                obj.insert("receivedAt".into(), Value::from(now_ms));
            }
        }
        self.spans.push(Arc::new(span));
    }

    /// Halve `effective_ms` while RSS is over budget; step it back toward the configured value
    /// when memory recovers. The TS did this with a V8 heap heuristic (heap limit vs used) and the
    /// port deliberately dropped it — which left alcore with STRICTLY LESS protection than the
    /// server it replaced, since the window evicts on time alone and nothing else bounds it.
    ///
    /// MEASURED WHY (2026-08-29, TRDD-YU8QPU89): an isolated instance flooded for ~9 min ingested
    /// ~6M spans, reached **10.25 GB RSS**, and stopped answering `/api/server-stats` for over a
    /// minute after the load stopped. A `/usr/bin/sample` of the wedged process showed 42,991
    /// samples in `__psynch_cvwait` behind `IndexMap::get_index_of` / `clone` / `parse_iso_ms` —
    /// the summary rebuild over the window, with ZERO writer/flush/fsync frames. So the window's
    /// size is what takes the server down, and bounding it is the fix that matters.
    ///
    /// Returns true when the window was narrowed, so the caller can log a cut that would otherwise
    /// be invisible — `windowMs` is already in `/api/server-stats`, which is what makes this
    /// observable rather than a silent data cut.
    ///
    /// ponytail: halve/restore on a fixed budget rather than a controller. A PID loop over RSS is
    /// exactly the speculative machinery this does not need — the TS shipped the same crude shape
    /// for years.
    pub fn apply_memory_pressure(&mut self, rss: u64, budget: u64) -> bool {
        if budget == 0 {
            return false;
        }
        if rss > budget {
            let narrowed = (self.effective_ms / 2).max(SUMMARY_WINDOW_FLOOR_MS);
            if narrowed < self.effective_ms {
                self.effective_ms = narrowed;
                return true;
            }
            return false;
        }
        // Recovered: step back toward the configured window, never past it. Doubling (not a jump
        // straight back) so a workload hovering at the budget does not oscillate between the full
        // window and the floor every tick.
        if self.effective_ms < self.configured_ms {
            self.effective_ms = (self.effective_ms.saturating_mul(2)).min(self.configured_ms);
            return true;
        }
        false
    }

    /// The flush-tick prune: drop spans older than the effective window by their own timestamp.
    /// Returns true when the window shrank (every derived view must be rebuilt).
    pub fn prune(&mut self, now_ms: i64) -> bool {
        let cutoff = now_ms - self.effective_ms;
        let first_old = self.spans.first().and_then(|s| s.as_object()).is_some_and(|s| span_timestamp_ms(s, now_ms) < cutoff);
        if !first_old {
            return false;
        }
        self.spans.retain(|s| s.as_object().is_none_or(|o| span_timestamp_ms(o, now_ms) >= cutoff));
        true
    }
}
