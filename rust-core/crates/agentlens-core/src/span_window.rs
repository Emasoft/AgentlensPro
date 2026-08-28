//! The standalone server's in-memory summarization window (TRDD-DMWOBWFH P4h) — server.ts
//! `spans` + `effectiveWindowMs`: the array every derived view (summary, SSE update payload,
//! analytics) is computed over. It is NOT the 5-minute collector SessionStore (that is the
//! VS-Code-era otlpCollector path, unused by the standalone server): at boot it is loaded from
//! the segmented span store for the last `summaryWindowHours` (default 24h), every ingested
//! span is appended, and the flush tick prunes by the span's own timestamp — "memory is the time
//! window, disk is everything". Nothing is evicted from disk.
//!
//! The TS heap/rss-pressure halving of `effectiveWindowMs` is a V8-specific heuristic (heap limit
//! vs used); it is NOT ported — `effective_ms` stays the configured value. Recorded in the TRDD
//! STATE as a deliberate gap; a Rust-native memory guard belongs with the resource monitor.

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
