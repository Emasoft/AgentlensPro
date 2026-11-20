//! TRDD-9VX3WTGU Phase C part 2 — the INCREMENTAL summary rebuild.
//!
//! WHY. Part 1 made a rebuild's input a set of `Arc<Value>` pointers, but `summary_over` still
//! deep-cloned every log card into the merged `sessions` array and `strip_session_detail` then
//! cloned every card AGAIN: a `Value` clone allocates the same node graph a parse does, so the
//! per-pass churn survived (37k cards, 25 ms cadence under ingest). Here the published summary
//! is PATCHED IN PLACE (its stripped twin was removed by TRDD-091Z1FU0): only the entries whose
//! inputs changed since the last build are recomputed, everything else is moved, not copied.
//!
//! HOW. The engine takes its previous output back out of the caches (`take_arc`). When no reader
//! still holds it, `Arc::try_unwrap` yields the `Value` for free; otherwise the sessions array is
//! deep-copied once (ponytail: a reader that holds the previous Arc forces one full copy per pass
//! — the ceiling of this scheme; the upgrade path is a Value type with shared subtrees).
//!
//! WHAT IS DIRTY (an entry's output is a function of exactly these inputs):
//!   * its own log card (pointer-compared against the snapshot of the previous pass — a `put`, an
//!     upsert and a demotion all swap the `Arc`), and any NEW card;
//!   * its OTEL twin's status (absent / displaced / survives), recomputed from the fresh OTEL
//!     sessions every pass and diffed against the last pass — this is the OTEL-side invalidation:
//!     an OTEL session arriving, growing into a collision, being evicted, or flipping which feed
//!     wins changes the status and marks the card dirty even though the card was not touched;
//!   * its link partners (`agent-<id>` / the placeholder it belongs to), which are dirtied
//!     whenever the other side is.
//!
//! A clear (card-store `epoch`), a window prune / pressure-ladder action (`force_full`), a cache
//! the engine cannot recognise as its own output, a NaN sort key, or an empty card set all fall
//! back to a FULL rebuild — the simplest correct rule: a stale merged card is a silent wrong
//! answer, worse than churn. The full path IS the engine run with every slot dirty, and
//! `CoreState::summary_over` stays as the independent oracle the tests compare against.
//!
//! ORDER. The legacy merge sorts `[log cards by first-insert slot…, OTEL cards…]` with a STABLE
//! sort on startTime descending. That equals sorting by `(startTime desc, rank asc)` with rank =
//! slot for log cards and `OTEL_BASE + index` for OTEL cards — valid while no key is NaN (an
//! inconsistent comparator is the one case where stable-sort output depends on the algorithm,
//! hence the NaN fallback). New/changed entries are sorted and merged into the retained ones.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use serde_json::Value;

use crate::{feed_merge, summarize, CoreState};

const OTEL_BASE: u64 = 1 << 40;


/// `Arc::try_unwrap` failures: a reader still held the previous summary, so
/// `take_sessions` deep-copied the sessions array instead of moving it — one full-corpus copy each.
/// Process-wide, like the rebuild gate in `ui.rs`: one server (one engine) per process, and a
/// field on `SummaryEngine` cannot be added through `fastedit` (the struct and its impl share a
/// name). Served on `/api/debug/log-scan-stats` as `summaryEngine.sharedCopies`.
static SHARED_COPIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn shared_copies() -> u64 {
    SHARED_COPIES.load(AtomicOrdering::Relaxed)
}

/// What a rebuild produces.
pub struct SummaryBuild {
    pub summary: Arc<Value>,
    pub attribution: IndexMap<String, Vec<Value>>,
}

/// The caches' previous values, taken under the state lock by `CoreState::summary_snapshot`.
#[derive(Default)]
pub struct Prev {
    pub summary: Option<(u64, Arc<Value>)>,
}

#[derive(Clone, Copy)]
struct Meta {
    key: f64,
    rank: u64,
}

struct EngineState {
    epoch: u64,
    /// The previous pass's snapshot, pinned so pointer comparison is sound (a freed `Arc` could be
    /// reallocated at the same address) and so a demotion's `Arc::make_mut` copies instead of
    /// mutating a tree this state still compares against.
    cards: Vec<Arc<Value>>,
    slot_of: HashMap<String, usize>,
    /// Parallel to the published `sessions` array.
    metas: Vec<Meta>,
    /// OTEL sessionId → "displaced by its log twin", for ids that have a log card.
    twin_status: HashMap<String, bool>,
    version: u64,
    /// The Arc this engine published last pass, held WEAKLY: a `Weak` keeps the allocation (not the
    /// value) reserved, so a freed summary's address cannot be recycled by a foreign `Arc` and then
    /// pass the pointer-equality test. A bare `usize` address did not: the freed slot is reused
    /// immediately for a same-size `Arc`, and with the stripped twin gone this is the ONLY proof that
    /// "the previous output is ours". A `Weak` does not block `Arc::try_unwrap` in `take_sessions`.
    summary_ref: std::sync::Weak<Value>,
}

#[derive(Default)]
pub struct SummaryEngine {
    /// Set by anything that changes the OTEL window wholesale (prune, ladder, clear).
    pub force_full: AtomicBool,
    /// Passes that patched the previous output in place / passes that rebuilt everything. Test and
    /// benchmark signal: a regression to always-full shows as `incremental_passes` staying flat.
    pub incremental_passes: std::sync::atomic::AtomicU64,
    pub full_passes: std::sync::atomic::AtomicU64,
    state: Mutex<Option<EngineState>>,
}

fn card_id(c: &Value) -> &str {
    c.get("sessionId").and_then(Value::as_str).unwrap_or("")
}

/// The merge's sort key (`Date.parse(startTime || '0')`); NaN for an unparseable non-empty string.
fn start_key(c: &Value) -> f64 {
    let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
    if st.is_empty() { -62_167_219_200_000.0 } else { summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
}

/// Newest first, then rank ascending — see the module header.
fn order(a: (f64, u64), b: (f64, u64)) -> Ordering {
    b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal).then(a.1.cmp(&b.1))
}

/// The `sessions` array out of a previous output. Unique Arc → moved; shared → one copy of the
/// array (the documented ceiling).
/// Each shared copy is counted in `SHARED_COPIES` so the ceiling is visible, not silent.
fn take_sessions(a: Arc<Value>) -> Vec<Value> {
    match Arc::try_unwrap(a) {
        Ok(mut v) => match v.get_mut("sessions").map(Value::take) {
            Some(Value::Array(arr)) => arr,
            _ => Vec::new(),
        },
        Err(shared) => {
            SHARED_COPIES.fetch_add(1, AtomicOrdering::Relaxed);
            shared.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default()
        }
    }
}

impl SummaryEngine {
    /// One rebuild pass. `version` is the data version the inputs belong to.
    pub fn build(
        &self,
        version: u64,
        spans: &[Arc<Value>],
        cards: &[Arc<Value>],
        epoch: u64,
        accounts: &IndexMap<String, String>,
        prev: Prev,
    ) -> SummaryBuild {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let force = self.force_full.swap(false, AtomicOrdering::Relaxed);
        let legacy = |guard: &mut Option<EngineState>| {
            *guard = None;
            self.full_passes.fetch_add(1, AtomicOrdering::Relaxed);
            let (summary, attribution) = CoreState::summary_over(spans, cards, accounts, 0.0);
            SummaryBuild { summary: Arc::new(summary), attribution }
        };
        if cards.is_empty() {
            return legacy(&mut guard);
        }

        // Is the previous output ours, current, and unmodified? Anything else → start from scratch.
        let mut state = guard.take();
        let mut old_sessions: Vec<Value> = Vec::new();
        if let Some(st) = &state {
            // The previous output is ours only if the engine itself published exactly this Arc:
            // version AND pointer equality on the summary. The pointer check is the sole guard
            // against a foreign value in `summary_cache` (the stripped twin used to double it),
            // so it must never be weakened to a version-only or shape check.
            let ok = !force
                && st.epoch == epoch
                && cards.len() >= st.cards.len()
                // TRDD-ER88PXNB: the old cards must still be an id-for-id prefix of the new list. The card window
                // drops cards from the front and the middle as they age out, so the count can grow while every slot
                // shifts; slot_of and the per-slot Arc checks are positional, so a shifted list must take a full pass,
                // or OTEL twins and agent-<id> links would resolve to the wrong card. Arc::ptr_eq first: an unchanged
                // slot is the same Arc, so the steady state costs one pointer compare per slot, not two id lookups.
                && st.cards.iter().zip(cards.iter()).all(|(old, new)| Arc::ptr_eq(old, new) || card_id(old) == card_id(new))
                && prev.summary.as_ref().is_some_and(|(v, a)| *v == st.version && std::ptr::eq(Arc::as_ptr(a), st.summary_ref.as_ptr()));
            if ok {
                old_sessions = take_sessions(prev.summary.expect("checked").1);
                if old_sessions.len() != st.metas.len() {
                    state = None;
                    old_sessions.clear();
                }
            } else {
                state = None;
            }
        }
        let mut st = state.unwrap_or_else(|| EngineState {
            epoch,
            cards: Vec::new(),
            slot_of: HashMap::new(),
            metas: Vec::new(),
            twin_status: HashMap::new(),
            version,
            summary_ref: std::sync::Weak::new(),
        });
        let old_n = st.cards.len();
        let counter = if old_n > 0 { &self.incremental_passes } else { &self.full_passes };
        counter.fetch_add(1, AtomicOrdering::Relaxed);
        let n = cards.len();

        // 1. Dirty slots: changed or new log cards.
        let mut dirty = vec![false; n];
        for i in 0..n {
            if i >= old_n {
                dirty[i] = true;
                st.slot_of.insert(card_id(&cards[i]).to_owned(), i);
            } else if !Arc::ptr_eq(&cards[i], &st.cards[i]) {
                dirty[i] = true;
            }
        }

        // 2. The OTEL side, fresh every pass.
        let mut summary = summarize::summarizer::summarize_spans(spans, &|sid| accounts.get(sid).cloned());
        let mut otel: Vec<Value> = match summary.get_mut("sessions").map(Value::take) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        };
        let mut displaced: Vec<bool> = Vec::with_capacity(otel.len());
        let mut twin_status: HashMap<String, bool> = HashMap::new();
        for s in &otel {
            let slot = st.slot_of.get(card_id(s)).copied();
            let d = slot.is_some_and(|i| {
                feed_merge::otel_displaced_by(s, cards[i].get("source").and_then(Value::as_str).unwrap_or(""))
            });
            displaced.push(d);
            if slot.is_some() {
                twin_status.insert(card_id(s).to_owned(), d);
            }
        }
        // OTEL-side invalidation: a twin appearing, vanishing or flipping marks its log card dirty.
        for (id, d) in &twin_status {
            if st.twin_status.get(id) != Some(d) {
                if let Some(&i) = st.slot_of.get(id) {
                    dirty[i] = true;
                }
            }
        }
        for id in st.twin_status.keys() {
            if !twin_status.contains_key(id) {
                if let Some(&i) = st.slot_of.get(id) {
                    dirty[i] = true;
                }
            }
        }

        // 3. Attribution — off the PRE-merge OTEL sessions (the legacy capture, byte for byte).
        let mut attribution: IndexMap<String, Vec<Value>> = IndexMap::new();
        for (s, &disp) in otel.iter_mut().zip(&displaced) {
            if s.get("source").and_then(Value::as_str) != Some("claude_code") {
                continue;
            }
            let is_api = |e: &Value| e.get("type").and_then(Value::as_str) == Some("api_request");
            let Some(timeline) = s.get_mut("timeline").and_then(Value::as_array_mut) else { continue };
            // A displaced twin is dropped by the merge, so its entries MOVE; a survivor keeps its
            // timeline, so they are cloned.
            let entries: Vec<Value> = if disp {
                std::mem::take(timeline).into_iter().filter(|e| is_api(e)).collect()
            } else {
                timeline.iter().filter(|e| is_api(e)).cloned().collect()
            };
            if !entries.is_empty() {
                if let Some(id) = s.get("sessionId").and_then(Value::as_str) {
                    attribution.insert(id.to_owned(), entries);
                }
            }
        }

        // 4. Link partners of every dirty slot are dirty too.
        let seeds: Vec<usize> = (0..n).filter(|&i| dirty[i]).collect();
        for &i in &seeds {
            let id = card_id(&cards[i]);
            if let Some(&j) = st.slot_of.get(&format!("agent-{id}")) {
                dirty[j] = true;
            }
            if let Some(&k) = id.strip_prefix("agent-").and_then(|rest| st.slot_of.get(rest)) {
                dirty[k] = true;
            }
        }

        // 5. Recompute the dirty entries.
        let base = |j: usize| -> Option<Value> {
            feed_merge::merge_one_log_card(&cards[j], twin_status.get(card_id(&cards[j])).copied())
        };
        let mut ins: Vec<(f64, u64, Value)> = Vec::new();
        let mut has_nan = false;
        for i in (0..n).filter(|&i| dirty[i]) {
            let Some(b) = base(i) else { continue };
            let id = card_id(&cards[i]);
            // Consumed as a placeholder?
            if feed_merge::is_link_placeholder(&b) {
                if let Some(&j) = st.slot_of.get(&feed_merge::link_twin_id(&b)) {
                    if j != i && base(j).is_some_and(|t| feed_merge::link_pair_ok(&b, &t)) {
                        continue;
                    }
                }
            }
            // Or the transcript a placeholder linked into?
            let entry = match id.strip_prefix("agent-").and_then(|rest| st.slot_of.get(rest)).copied() {
                Some(k) if k != i => match base(k) {
                    Some(p) if feed_merge::is_link_placeholder(&p) && feed_merge::link_pair_ok(&p, &b) => {
                        feed_merge::linked_winner(&p, &b)
                    }
                    _ => b,
                },
                _ => b,
            };
            let key = start_key(&entry);
            has_nan |= key.is_nan();
            ins.push((key, i as u64, entry));
        }
        let mut kept_otel = 0u64;
        for (s, &disp) in otel.drain(..).zip(&displaced) {
            if disp {
                continue;
            }
            let mut s = s;
            feed_merge::stamp_plain(&mut s, "otel");
            let key = start_key(&s);
            has_nan |= key.is_nan();
            ins.push((key, OTEL_BASE + kept_otel, s));
            kept_otel += 1;
        }
        if has_nan {
            // An unparseable startTime makes the legacy comparator non-transitive; only the legacy
            // algorithm reproduces its output. `summary` here is the OTEL half only — discard it.
            drop(summary);
            *guard = None;
            self.full_passes.fetch_add(1, AtomicOrdering::Relaxed);
            let (summary, attribution) = CoreState::summary_over(spans, cards, accounts, 0.0);
            return SummaryBuild { summary: Arc::new(summary), attribution };
        }
        ins.sort_by(|a, b| order((a.0, a.1), (b.0, b.1)));

        // 6. Merge the retained entries with the recomputed ones.
        let cap = old_sessions.len() + ins.len();
        let mut new_sessions: Vec<Value> = Vec::with_capacity(cap);
        let mut new_metas: Vec<Meta> = Vec::with_capacity(cap);
        let mut ins_it = ins.into_iter().peekable();
        let push_ins = |x: (f64, u64, Value), ns: &mut Vec<Value>, nm: &mut Vec<Meta>| {
            nm.push(Meta { key: x.0, rank: x.1 });
            ns.push(x.2);
        };
        let old_metas = std::mem::take(&mut st.metas);
        for (v, m) in old_sessions.into_iter().zip(old_metas) {
            let retained = m.rank < OTEL_BASE && !dirty[m.rank as usize];
            if !retained {
                continue;
            }
            while ins_it.peek().is_some_and(|x| order((x.0, x.1), (m.key, m.rank)) == Ordering::Less) {
                let x = ins_it.next().expect("peeked");
                push_ins(x, &mut new_sessions, &mut new_metas);
            }
            new_sessions.push(v);
            new_metas.push(m);
        }
        for x in ins_it {
            push_ins(x, &mut new_sessions, &mut new_metas);
        }

        // 7. Publish.
        summary.as_object_mut().expect("summary object").insert("sessions".into(), Value::Array(new_sessions));
        let summary = Arc::new(summary);
        for i in 0..n {
            if i >= old_n {
                st.cards.push(cards[i].clone());
            } else if dirty[i] {
                st.cards[i] = cards[i].clone();
            }
        }
        st.metas = new_metas;
        st.twin_status = twin_status;
        st.epoch = epoch;
        st.version = version;
        st.summary_ref = Arc::downgrade(&summary);
        *guard = Some(st);
        SummaryBuild { summary, attribution }
    }
}
