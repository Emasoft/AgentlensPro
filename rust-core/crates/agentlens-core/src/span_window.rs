//! The standalone server's in-memory summarization window (TRDD-DMWOBWFH P4h) — server.ts
//! `spans` + `effectiveWindowMs`: the array every derived view (summary, SSE update payload,
//! analytics) is computed over. It is NOT the 5-minute collector SessionStore (that is the
//! VS-Code-era otlpCollector path, unused by the standalone server): every ingested span is
//! appended, and the flush tick prunes by the span's own timestamp — "memory is the time window,
//! disk is everything". Nothing is evicted from disk.
//!
//! THERE IS NO BOOT LOAD ANY MORE (TRDD-FSMISF5K). It used to replay the last
//! `summaryWindowHours` (default 24h) of the segmented store into this `Vec` at every start —
//! measured 2026-09-06 on the live collector at **528,219 spans** and a **13.2 GB** process peak
//! the allocator never returns
//! (reports/7ypqwkpg/20260906_043059+0200-heap-by-structure-after-xtfdrth2.md).
//!
//! What it bought was measured on the same server, and it was NOTHING: of the 23,274 cards
//! `/api/summary` served, **23,273 came from the log transcripts and exactly ONE from this
//! window** — a codex session 40 seconds old, i.e. from the LIVE window, not from the replay.
//! The feed-collision doctrine is why (`feed_merge.rs`): for claude_code sessions the log
//! transcript WINS, so a replayed OTEL twin is built at a cost of gigabytes and then discarded by
//! the merge. History is answered off disk instead — `session_summary_sql.rs` aggregates the same
//! segments in DuckDB, and `/api/timeline` already re-reads a single session on demand
//! (`ui.rs`, `writer.load_range`).
//!
//! So this window now holds ONLY what has arrived since boot, bounded by `effective_ms` and
//! `max_spans` exactly as before.
//!
//! The TS heap/rss-pressure halving of `effectiveWindowMs` IS now ported, as
//! `apply_memory_pressure` below — keyed on RSS (portable: proc_pidinfo on macOS, /proc on Linux)
//! rather than the TS's V8 heap heuristic, which has no Rust analogue. It was deliberately skipped
//! at port time, and that gap left alcore with strictly LESS protection than the server it
//! replaced: measured 2026-08-29, a flood drove RSS to 10.25 GB and wedged the process in the
//! summary rebuild over the window.

use std::path::Path;
use std::sync::Arc;

use agentlens_spanstore::writer::span_timestamp_ms;
use serde_json::Value;

/// server.ts SUMMARY_WINDOW_FLOOR_MS.
pub const SUMMARY_WINDOW_FLOOR_MS: i64 = 5 * 60_000;

/// The store's `receivedAt` stamp — arrival time, recorded once, never overwritten.
///
/// THE ORDER MATTERS, AND IT IS WHY THIS IS A FREE FUNCTION (TRDD-GR6WHHK5). Ingest must stamp
/// BEFORE `SpanStoreWriter::append`, not after: the appended line is the disk copy, so a span
/// stamped only on its way into the window persists with no timestamp of any kind. `"0"` is the
/// protobuf default the Codex exporter really sends (602 timestamp-less `codex.api_request` spans
/// in the 2026-09-05 segment), so those records came back from `load_range` resolvable only
/// through its `now_ms` fallback — and the first prune tick after boot evicted every one of them,
/// because since TRDD-YILE6N3T an unresolvable age resolves to `i64::MIN`. One function, called
/// from both sides, so the two copies of a span can never disagree about when it arrived.
///
/// This is also the TS order, not an invention: `standalone/server.ts` `addSpan` (recovered at
/// 567fc5c2^:557-561) stamped `receivedAt` and THEN called `spanStore.append(span)`. So a span
/// buckets into the segment of its ARRIVAL day — `span_timestamp_ms` prefers `receivedAt` — which
/// is what the port had silently lost along with the stamp.
pub fn stamp_received_at(span: &mut Value, now_ms: i64) {
    if let Some(obj) = span.as_object_mut() {
        if !obj.contains_key("receivedAt") {
            obj.insert("receivedAt".into(), Value::from(now_ms));
        }
    }
}

/// Resident span ceiling: `AGENTLENS_MAX_WINDOW_SPANS` overrides, `0` disables, default 1,000,000.
///
/// Sized against BOTH measurements rather than picked. Wedging was observed above ~1.5M spans, so
/// the cap must sit below that to protect anything. At this machine's measured real peak of 26
/// spans/s, 1M spans is ~10.7 HOURS of history — and typical load is far under peak, so an ordinary
/// day never reaches the cap and the dashboard still shows its full 24h. A cap that never binds in
/// normal use and binds before the pathology is the whole design goal; do not lower it to "save
/// memory" (the RSS guard owns that axis) or raise it past the wedge point.
pub fn max_spans_default() -> usize {
    std::env::var("AGENTLENS_MAX_WINDOW_SPANS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(1_000_000)
}

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
    /// Hard ceiling on resident span COUNT; 0 disables. See `prune` for why a second axis exists.
    pub max_spans: usize,
}

impl SpanWindow {
    pub fn new(configured_ms: i64) -> SpanWindow {
        SpanWindow { spans: Vec::new(), configured_ms, effective_ms: configured_ms, max_spans: max_spans_default() }
    }

    /// addSpan: stamp receivedAt when absent, append (the store append is the caller's).
    pub fn add(&mut self, mut span: Value, now_ms: i64) {
        stamp_received_at(&mut span, now_ms);
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

    /// The flush-tick prune: drop spans older than the effective window by their own timestamp,
    /// THEN cap the window by span COUNT. Returns true when the window shrank (every derived view
    /// must be rebuilt). A span whose timestamp cannot be read is dropped too — see the retain.
    ///
    /// WHY A SECOND AXIS (TRDD-YU8QPU89). The time cutoff — and the RSS guard that shortens it —
    /// bound BYTES. They do not bound the thing the cost actually follows: every summary rebuild is
    /// O(span count), so a window holding millions of spans wedges the server even while memory is
    /// under control. Measured 2026-08-29: a guarded instance kept RSS falling (18.2 -> 3.6 GB)
    /// and still stopped answering `/api/server-stats`, with 33-39k samples parked in
    /// `__psynch_mutexwait` behind the summarize path. Bytes were fine; the count was not.
    ///
    /// NO DATA IS LOST. This module's contract is "memory is the time window, disk is everything" —
    /// every span is already durable in the segmented store, and `load_range` reads back whatever a
    /// query needs. The cap costs dashboard RECENCY DEPTH under extreme load, nothing else, which
    /// is the same trade `apply_memory_pressure` already makes by shortening the window.
    pub fn prune(&mut self, now_ms: i64) -> bool {
        let cutoff = now_ms - self.effective_ms;
        let before = self.spans.len();
        // WHY THIS RETAIN IS UNCONDITIONAL, AND WHY THE TIMESTAMP FALLBACK IS `i64::MIN`
        // (TRDD-YILE6N3T, measured 2026-09-06 on a 432,335-span replay of the real store).
        //
        // This used to run only when ONE sentinel element — `spans.first()` — resolved older than
        // the cutoff, and it read that element's timestamp with `now_ms` as the fallback. Both
        // halves are wrong, and together they froze the window permanently:
        //
        //   * 602 of today's 432,335 spans are `codex.api_request` records carrying
        //     `startTime: "0"` / `endTime: "0"`. `span_timestamp_ms` reads neither (`"0"`/1e6 is
        //     not > 0) and returns the `now_ms` it was handed — so such a span is ALWAYS inside
        //     the window and can never age out. The first one is the segment's 40th line.
        //   * The first narrowing prune (24h -> 12h) evicted 27,755 spans (432,335 -> 404,580) and
        //     left one of those unresolvable spans at index 0. From the next tick `first_old` was
        //     false, so the retain never ran again: 404,580 spans stayed resident while `windowMs`
        //     reported 300,000, and the count only grew with live ingest.
        //
        // So: never gate the pass on one element (any element can be unresolvable, out of order,
        // or not even an object), and treat "no timestamp we can read" as INFINITELY OLD rather
        // than as "now". `span_timestamp_ms` uses its `now_ms` argument for nothing but that final
        // fallback, so passing `i64::MIN` is exactly "unknown age loses the cutoff". A non-object
        // span (which `add` cannot stamp) is evicted for the same reason — it can never age.
        // Cost is not a reason to gate this: a `retain` over <=1M `Arc`s is milliseconds, and once
        // the window is bounded again it is a few thousand.
        self.spans.retain(|s| s.as_object().is_some_and(|o| span_timestamp_ms(o, i64::MIN) >= cutoff));
        let mut changed = self.spans.len() != before;
        // Keep the NEWEST `max_spans`. `add` appends, so the front is the oldest arrival — the same
        // end the time cutoff removes.
        if self.max_spans > 0 && self.spans.len() > self.max_spans {
            let excess = self.spans.len() - self.max_spans;
            self.spans.drain(0..excess);
            changed = true;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// TRDD-YILE6N3T, the regression that froze the window: one element the timestamp reader
    /// cannot resolve must not stop the pass, and must not survive it either. The shape is the
    /// real one from the live store — a `codex.api_request` with `startTime`/`endTime` of `"0"`.
    #[test]
    fn prunes_past_a_first_element_with_no_resolvable_timestamp() {
        let now = 1_788_000_000_000i64;
        let mut w = SpanWindow::new(SUMMARY_WINDOW_FLOOR_MS);
        w.spans.push(Arc::new(json!({
            "traceId": "codex:x", "spanId": "unresolvable", "name": "codex.api_request",
            "startTime": "0", "endTime": "0", "attributes": []
        })));
        for i in 0..999 {
            w.spans.push(Arc::new(json!({ "spanId": format!("old{i}"), "receivedAt": now - 3_600_000 })));
        }

        assert!(w.prune(now), "1,000 spans an hour old must be a cut at a 5-minute window");
        assert!(
            w.spans.is_empty(),
            "the 999 resolvable spans must go even though the FIRST element is unresolvable, and \
             the unresolvable one must go too — unknown age is not `now`"
        );

        // Still a cutoff, not a purge: an in-window span survives, and a pass that removes
        // nothing reports no change (the caller keys `data_version` on that).
        w.add(json!({ "spanId": "live" }), now);
        assert!(!w.prune(now), "nothing aged out ⇒ nothing to rebuild");
        assert_eq!(w.spans.len(), 1);
    }
}
