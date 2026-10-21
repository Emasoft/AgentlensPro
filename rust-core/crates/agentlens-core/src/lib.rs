//! agentlens-core — the Rust server surface (TRDD-DMWOBWFH P4).
//!
//! P4c slice: the OTLP listener behind the FROZEN wire contract (the P4a freeze report §2 is
//! the spec — reports/p4-wire-freeze/, mirrored from standalone/server.ts:4413):
//!   - `GET /agentlens/standalone` (raw path+query, exact) → 200 `{"agentlens":true,"kind":"standalone"}`
//!   - any other non-POST → 200, empty body, no headers
//!   - `POST <any path>`: 64MB cap (overflow → the connection is ABORTED, no response); body is
//!     parsed as JSON (no Content-Type inspection); routed by PATH first (`/v1/traces|logs|metrics`)
//!     then by payload classification; metrics accepted and DISCARDED; parse failure is counted
//!     and still answered 200. **Always 200, empty body, no Content-Type.**
//!
//! Behind the wire: the P3b-ported pure transforms (agentlens-ingest) feed the P3-ported
//! span-store writer. NOT in this slice (recorded in the TRDD STATE): admission-control 503s,
//! the in-memory span window + summarizer (so gen_ai injection is a no-op here), account/body
//! registries, and the dropped-log-event sink — the TS server still owns port 4318.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use indexmap::IndexMap;
use serde_json::Value;

use agentlens_ingest::IngestState;
use agentlens_spanstore::writer::SpanStoreWriter;

pub mod account_burners;
pub mod admission;
pub mod account_registry;
pub mod all_accounts;
pub mod account_state_timeline;
pub mod bg_qos;
pub mod body_archive;
pub mod body_writers;
pub mod burn;
pub mod burn_calibration;
pub mod cache_break;
pub mod cache_break_timeline;
pub mod turn_prefix_codec;
pub mod cache_turns_sql;
pub mod cache_creation_forensics;
pub mod cache_event_log;
pub mod heartbeat_cost;
pub mod session_burn_profile;
pub mod cache_risk_commands;
pub mod chores;
pub mod call_body_registry;
pub mod card_store;
pub mod collector_lifecycle;
pub mod context_composition;
pub mod context_history;
pub mod conversation;
pub mod context_composition_index;
pub mod delta_log;
pub mod derived_cache;
pub mod effort_transitions;
pub mod embed_auth;
pub mod statusline_usage;
pub mod feed_merge;
pub mod generated_files;
pub mod hook_events;
pub mod import_card;
pub mod instruction_advisor;
pub mod instruction_files;
pub mod lean_response;
pub mod loaded_plugin_versions;
pub mod log_reader;
pub mod mcp;
pub mod mcp_tools;
pub mod pid_lock;
pub mod pricing;
pub mod rate_limit_report;
pub mod raw_body_context;
pub mod request_log;
pub mod resident_cost;
pub mod retention_config;
pub mod rss_guard;
pub mod runtime_inventory;
pub mod server_stats;
pub mod session_summary_sql;
pub mod shutdown;
pub mod skill_attribution;
pub mod span_window;
pub mod spawn_rollup;
pub mod spool_tap;
pub mod statusline_store;
pub mod burn_seismic;
pub mod seismic_stats;
pub mod forensics_index;
pub mod forensics_db;
pub mod forensics_scan;
pub mod forensics_sql;
pub mod forensics_compare;
pub mod subscription_usage;
pub mod summarize;
pub mod summary_engine;
pub mod token_estimator;
pub mod tokens_by_cause;
pub mod ui;
pub mod update_payload;
pub mod window_eta;

pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Port of src/otlpParser.ts::classifyOtlpPayload — the fallback discriminator when the POST
/// path is not one of the /v1/* names.
pub fn classify(payload: &Value) -> &'static str {
    let Some(obj) = payload.as_object() else { return "unknown" };
    if obj.get("resourceSpans").is_some_and(Value::is_array) {
        return "traces";
    }
    if obj.get("resourceLogs").is_some_and(Value::is_array) {
        return "logs";
    }
    if obj.get("resourceMetrics").is_some_and(Value::is_array) {
        return "metrics";
    }
    "unknown"
}

#[derive(Default)]
pub struct Counters {
    pub traces_payloads: u64,
    pub logs_payloads: u64,
    pub metrics_payloads: u64,
    pub parse_errors: u64,
    /// TRDD-KMF02UEX — `demote_cold` calls that returned an error (served as the
    /// `alcore.demoteColdError` degradation).
    pub demote_cold_errors: u64,
    pub spans_appended: u64,
}


/// The last bodies-pass reading, kept so `/api/server-stats` can report it (TRDD-HDUETCU7).
/// Written ONLY by the bodies-pass chore (`chores::record_bodies_pass`), read by
/// `server_stats::server_stats`. Mirrors the retired TS server bodiesLastPurge/bodies.lastPass
/// (one object, overwritten every completed pass, including an empty one).
#[derive(Debug, Default, Clone, Copy)]
pub struct BodiesPassStats {
    pub last_at_ms: i64,
    pub last_removed_files: u64,
    pub last_freed_bytes: u64,
    pub reclaimed_since_boot: u64,
    pub last_non_zero_pass_at_ms: i64,
}

/// A copy of everything a summary rebuild reads, taken under the state lock so the rebuild can
/// run outside it (TRDD-HFV4AIT7). Every field holds `Arc`s, so building one is a pointer copy per
/// span/card — never a deep clone of the window or of the card corpus.
pub struct SummaryInputs {
    pub version: u64,
    pub spans: Vec<Arc<Value>>,
    /// The card corpus as shared pointers into the card store's resident parsed layer, in
    /// first-insert order (TRDD-9VX3WTGU Phase C).
    ///
    /// This WAS the raw stored JSON text (`Vec<String>`, ~69 MB over 37k cards) copied out of
    /// DuckDB under the state lock and re-parsed in `summary_from` on EVERY pass — at the 25 ms
    /// rebuild cadence that copy-and-parse was the dominant allocation-churn former behind the
    /// 2048 MB kills. A snapshot is now one refcount bump per card, so the lock hold is O(cards)
    /// pointer copies and the parse is gone entirely.
    pub log_cards: Vec<Arc<Value>>,
    /// The session→account map the summarizer resolves `accountId` through (TRDD-465EXTJ6).
    ///
    /// It has to travel IN the snapshot: `summary_over` is deliberately a free function with no
    /// `&self` so the rebuild runs OFF the state lock (TRDD-HFV4AIT7), which means it cannot reach
    /// `CoreState::accounts` on its own. Before this it was handed `&|_| None`, so the registry was
    /// never consulted and EVERY card came out with no `accountId` — measured as
    /// `accountWindows = [('None', 3)]` on an OTEL-only server.
    ///
    /// `Arc`, matching the two fields above, so building a snapshot stays a pointer copy — a deep
    /// clone here would reintroduce the under-lock stall HFV4AIT7 removed.
    pub accounts: Arc<IndexMap<String, String>>,
    /// The card store epoch the snapshot belongs to (bumped by `clear`).
    pub epoch: u64,
    /// The caches previous outputs, handed over for in-place patching (see `summary_engine`).
    pub prev: summary_engine::Prev,
    pub engine: Arc<summary_engine::SummaryEngine>,
}

pub struct CoreState {
    pub ingest: IngestState,
    pub writer: SpanStoreWriter,
    pub counters: Counters,
    /// The summarization window (server.ts `spans` + `effectiveWindowMs`, P4h): loaded from the
    /// span store for the last summaryWindowHours at boot, appended by every ingested span,
    /// pruned by time on the flush tick. Every derived view is computed over it.
    pub window: span_window::SpanWindow,
    /// Bumped on every data change; the coalesced SSE pusher rebuilds only when it moved
    /// (server.ts dataVersion).
    pub data_version: u64,
    /// server.ts `lastIngestActivityAt` (TRDD-4FMHW124 / TRDD-8ADTIGKT): the wall-clock ms of the
    /// last ingest that actually produced spans — the CAPTURE-LIVENESS clock. `0` means nothing
    /// has ever been ingested in this process, which is why it is `0` and not `now` at boot:
    /// initialising it to the start time would make a server that has never received anything
    /// look freshly active, and this value's only job is to distinguish those two states.
    ///
    /// Ported from the TS server (TRDD-1B98LCVR): `/api/debug/capture-activity` existed ONLY there,
    /// so retiring `standalone/server.js` would have deleted a live endpoint. The liveness clock is
    /// otherwise observable only indirectly (a 10-minute window and a warning on transition), which
    /// is exactly why the endpoint exists — it makes the bump itself directly testable per feed.
    pub last_ingest_activity_ms: i64,
    /// server.ts `sinkProblem` (TRDD-4FMHW124, ported in TRDD-U0L78B3Z): `None` = the primary
    /// bodies sink is a writable directory. Written ONCE PER BODIES-PASS TICK by the chore
    /// (`probe_sink`), read by `/api/server-stats` — never probed per stats call, which the
    /// dashboard polls; the TS had the same split (probe at :818, the route reads a variable).
    pub sink_problem: Option<String>,
    /// The dashboard live-reload fingerprint carried in every update frame (server.ts BUILD_ID —
    /// bundle mtimes there; here the process start, the same "changes on restart" contract).
    pub build_id: String,
    /// Where the dashboard's built assets live (server.ts `mediaDir`): `index.html` + the bundles
    /// served by `GET /` and the static route (TRDD-VHH7FXGC). Set by the binary from
    /// `--media-dir`; `None` (tests that never touch the UI) keeps those routes at the 404 fallback.
    pub media_dir: Option<std::path::PathBuf>,
    /// Log-derived session cards keyed by sessionId (server.ts `logSessions`), merged into the
    /// served summary under the feed-collision doctrine (feed_merge.rs). Fed by the log reader
    /// (log_reader.rs); `put_log_session` is the one write path and bumps data_version.
    ///
    /// TRDD-XTFDRTH2: this WAS an `IndexMap<String, Arc<Value>>` holding 32,607 cards as resident
    /// `Value` trees — measured as one of the three contributors to the 8.7 GB mimalloc heap. It
    /// is now a DuckDB table (`card_store.rs`) holding the same corpus as JSON text; a reader gets
    /// a `Vec` it drops when it is done, which is the USER's ruling in TRDD-7YPQWKPG ("duckdb is
    /// your memory… the rust code should only make queries and report the ephemeral answers").
    /// The three properties the map supplied for free — first-insert iteration order, an upsert
    /// keeping its slot, and demotion ties falling back to insertion order — are rebuilt on the
    /// `seq` column and pinned by `tests/card_store.rs`.
    pub cards: card_store::CardStore,
    /// The data dir this process owns (server.ts DATA_DIR) — the sidecar paths `/api/server-stats`
    /// measures hang off it.
    pub data_dir: std::path::PathBuf,
    /// server.ts SERVER_STARTED_AT.
    pub started_at_ms: i64,
    /// The bound listeners; alcore overwrites the defaults with what it actually bound.
    pub ports: server_stats::Ports,
    /// server.ts persistStats — every byte this process writes, counted where it is written.
    pub persist: server_stats::PersistStats,
    /// TRDD-YQZ9P8IL — the account-state timeline writer, sampled by the 4s burn tick. Change
    /// detection means a sample is a key comparison in the common case and a real write only a
    /// few times an hour, so this can sit on the hot tick without touching the disk.
    pub account_timeline: account_state_timeline::AccountStateTimeline,
    /// server.ts `logSinkWarned` — one warning per distinct sink error per boot. Not a nicety:
    /// without it a failing disk warns once per dropped event (thousands of lines), and with no
    /// set at all the loss is silent. The set is bounded by the number of DISTINCT io error
    /// messages, not by traffic.
    log_sink_warned: std::collections::HashSet<String>,
    /// server.ts `hookRuntime` — loaded at boot, replaced by POST /api/hook-config.
    pub hook_runtime: server_stats::HookRuntime,
    /// LogReader.getLogScanStats — cumulative reader counters, added after every sweep.
    pub log_scan: log_reader::LogScanStats,
    /// The sweeper's control channel (set by `start_sweeper`): /api/clear wipes the tail state
    /// and requests the full re-scan through it.
    pub sweeper: Option<log_reader::SweeperControl>,
    /// server.ts summaryCache / strippedCache — the merged summary and its stripped form,
    /// memoized by data_version (derived_cache.rs).
    pub summary_cache: derived_cache::VersionedCache<Value>,
    pub stripped_cache: derived_cache::VersionedCache<Value>,
    /// The incremental summary rebuild (TRDD-9VX3WTGU Phase C part 2). `Arc` so the off-lock rebuild
    /// owns a handle without touching the state lock; `force_full` is set wherever the OTEL window
    /// changes wholesale (prune, pressure ladder, clear).
    pub summary_engine: Arc<summary_engine::SummaryEngine>,
    /// The shared CallBodyRegistry's account half: fed by the logs ingest, read when a log card
    /// is built (accountId, TRDD-BURNWDGT).
    pub accounts: account_registry::AccountRegistry,
    /// The shared CallBodyRegistry's POINTER half (P4w.1) — raw request/response body
    /// addresses per session, fed by the logs ingest. The spine the per-session drill-down
    /// routes (freeze rows 32–37) resolve a call to its body file through.
    pub bodies: call_body_registry::CallBodyRegistry,
    /// The composition index's LRU cache (P4w.1c) — per-session composition summaries, built
    /// lazily. Only the CACHE lives here; building a composition parses body files, which must
    /// happen OFF this lock (resolve refs under it, parse on spawn_blocking, re-lock to store).
    pub composition: context_composition_index::ContextCompositionIndex,
    /// serverRuntime.ts requestLog — one row per UI/API request (ring + `requests.log`).
    pub requests: request_log::RequestLog,
    /// server.ts `otelAttributionBySession` (TRDD-5GFSFX0Q): sessionId → the OTEL card's
    /// `api_request` timeline entries, captured BEFORE the feed merge drops the OTEL twin.
    /// Rebuilt together with the memoized summary (same data_version), so it can never go stale
    /// relative to the cards it serves; read only by the `/api/timeline` graft.
    pub otel_attribution: IndexMap<String, Vec<Value>>,
    /// server.ts `lifecycle` (TRDD-PJC8N1HO spec 2) — the run log behind /api/collector-gaps
    /// and the SSE frames' collectorGaps. `open` appends this boot's start marker.
    pub lifecycle: collector_lifecycle::LifecycleStore,
    /// The discovery environment `/api/timeline`'s reparse-on-demand resolves files against —
    /// a FIELD (not Env::from_process at the call site) so tests can point it at a fixture
    /// home without racing the process environment.
    pub log_env: agentlens_logscan::discovery::Env,
    /// `latestResidentBlobs` (server.ts:1485) — the top resident blobs, refreshed on a 30s chore
    /// and READ by the burn-status enrichment. A CACHE on purpose: recomputing it inside the 4s
    /// burn tick would re-derive every session's composition four times a minute for a value that
    /// changes far more slowly, which is why the TS puts it on its own 30s timer. Empty until the
    /// first scan completes — and empty is the honest answer then, not a claim of "no blobs".
    pub latest_resident_blobs: Vec<Value>,
    /// Memory-pressure ladder stage 0..=3 (see `pressure_stage`).
    pub pressure_stage: u8,
    /// TRDD-KMF02UEX — the last `demote_cold` call failed. While set, further failures are counted
    /// (`counters.demote_cold_errors`) but not logged again; the next success logs one recovery line
    /// and clears it.
    pub demote_failing: bool,
    /// The shared HMAC key behind the signed viewer-role assertion (embedAuth.ts / AgentlensPro#4).
    /// `None` means the embed feature is DISABLED, and a present viewer header then resolves to
    /// `invalid` (403) — never a downgrade to full access. Past boot this is always `Some`: the
    /// binary refuses to start (exit 78) on an unusable key file, exactly as the TS server does.
    /// The `Option` is kept only so `resolve_viewer_role`'s pure contract stays defensively total,
    /// and so a test can construct a keyless state.
    pub embed_key: Option<Vec<u8>>,
    /// The burn subsystem's stateful glue (P4r.3): config, the tick's lastBurnStatus, the 60s
    /// account/TTL-signal cache. Tests re-point it with set_home_dir.
    pub burn: burn::runtime::BurnRuntime,
    /// server.ts `recentHookEvents` (P4r.5) — the in-memory ring the gate reads (the gate sits
    /// behind a PreToolUse hook, so every read on its path must be in-memory). Boot-seeded from
    /// the disk buckets, pushed on every /api/hook-events ingest, capped at 600 → trimmed to 500.
    pub recent_hook_events: Vec<Value>,
    /// server.ts `advisoryIssued` — the gate's per-session+code dedupe map (PostToolUse
    /// advisories + the IMG_RESIDENT warning share it; disjoint codes keep the keys disjoint).
    pub advisory_issued: std::collections::HashMap<String, f64>,
    /// server.ts `statuslineStore` (row 5) — the high-frequency sample store's buffered half.
    /// append/flush run under this lock (cheap pushes + one fsync per batch); SEALING runs on
    /// alcore's own 60s task through the free `statusline_store::maybe_seal`, which shares only
    /// the Arc'd counters — never this lock.
    pub statusline: statusline_store::StatuslineStore,
    /// The digest spool tap (spool_tap.rs): `Some` only when `alcore serve` got both
    /// `--ingest-manifest` and `--aldigest-bin` and `aldigest register` succeeded. `None` = alcore
    /// behaves exactly as before the tap existed. `Arc` so the OTLP handler and the bodies pass can
    /// hold it without the state lock.
    /// TRDD-N6A8VX3G: the durable request↔response link rows (one per BodyPointer ingested).
    /// Key: format!("{span_or_req}:{kind}:{ts}") — unique per pointer. Appended per ingest via
    /// append_changed (zero bytes when unchanged); compact_from_disk() at boot rewrites the
    /// delta into the verified snapshot. GVA8TTJF reads them through DeltaLog::for_each_live into a VARCHAR
    /// DuckDB table (cache_turns_sql.rs install_body_links), never as raw ndjson.
    pub body_links: delta_log::DeltaLog,
    pub spool_tap: Option<Arc<spool_tap::SpoolTap>>,
    /// Why `spool_tap` is `None`, for `/api/ingest-status`.
    pub spool_tap_off_reason: String,
}

impl CoreState {
    /// putLogSession — upsert by sessionId.
    pub fn put_log_session(&mut self, card: Value) {
        // The card is already a parsed `Value` here, so the resident layer costs no extra parse.
        self.cards.put_arc(Arc::new(card));
        self.data_version += 1;
    }

    /// demoteColdTimelines (server.ts, TRDD-66IXMIGN fifth repro): per-card bounds are not
    /// sufficient on a ~13k-session machine — only the `hot_cards` most-recently-active cards
    /// keep their timelines in RAM; every colder card keeps headers only.
    pub fn demote_cold_timelines(&mut self, hot_cards: usize) {
        // TRDD-XTFDRTH2: the ranking (`last_active` DESC, first-insert ASC on ties) and the strip
        // run inside the card table — see `CardStore::demote_cold`, which also strips the resident
        // parsed layer (copy-on-write via `Arc::make_mut`, so a rebuild still holding the
        // pre-demotion pointer keeps a consistent view).
        // TRDD-KMF02UEX: a failure is counted and logged, never a panic — this runs under the state
        // lock, where a panic poisons the mutex for every request thread; the next ingest batch
        // simply retries. Logged once per failing streak, not once per batch, and the streak's end
        // is logged too, so the log shows when demotion stopped and when it resumed.
        match self.cards.demote_cold(hot_cards) {
            Ok(_) => {
                if self.demote_failing {
                    self.demote_failing = false;
                    eprintln!(
                        "{} alcore: demote_cold recovered ({} failed call(s) since boot)",
                        crate::log_ts(),
                        self.counters.demote_cold_errors
                    );
                }
            }
            Err(e) => {
                self.counters.demote_cold_errors += 1;
                if !self.demote_failing {
                    self.demote_failing = true;
                    eprintln!(
                        "{} alcore: demote_cold failed, retried on the next ingest batch (further failures are counted, not logged): {e}",
                        crate::log_ts()
                    );
                }
            }
        }
    }

    /// A sweep's output into the card map (server.ts runLogScan's loop): every card through
    /// put_log_session, then the global timeline tier. The data_version bump is what the
    /// coalesced SSE pusher watches.
    pub fn ingest_scanned(&mut self, scanned: Vec<log_reader::ScannedFile>) {
        if scanned.is_empty() {
            return;
        }
        for s in scanned {
            for mut card in s.cards {
                // finishRustTranscript: `if (accountId) card.accountId = accountId` — the lookup is
                // by the card's own sessionId (a log session's id IS the Claude Code session_id,
                // the registry's key; a subagent's "agent-…" id never matches), stamped at BUILD
                // time: an account learned later reaches the card on its next re-parse, as in TS.
                if let Some(obj) = card.as_object_mut() {
                    let acct = obj.get("sessionId").and_then(Value::as_str).and_then(|sid| self.accounts.account_for(sid)).map(str::to_owned);
                    if let Some(a) = acct {
                        obj.insert("accountId".into(), Value::from(a));
                    }
                }
                self.put_log_session(card);
            }
        }
        self.demote_cold_timelines(summarize::retention::timeline_hot_cards());
    }

    /// computeSessionSummary (server.ts:2240) — summarizeSpans over the live window, then, when
    /// any log session exists, the feed-collision merge + the subagent link, sorted newest-first.
    pub fn session_summary(&self, now_ms: f64) -> Value {
        Self::summary_over(&self.window.spans, &self.cards.parsed_cards(), &self.accounts.snapshot(), now_ms).0
    }

    /// The inputs of one summary rebuild, copied under the state lock so the rebuild itself runs
    /// OUTSIDE it (TRDD-HFV4AIT7). Spans and cards are both `Arc`s, so the whole snapshot is a
    /// pointer copy: no card text crosses the lock and nothing is parsed (TRDD-9VX3WTGU Phase C —
    /// `cards_json()` is now only the cold-boot/CLI/parity read of the TABLE).
    pub fn summary_snapshot(&mut self) -> SummaryInputs {
        SummaryInputs {
            version: self.data_version,
            spans: self.window.spans.clone(),
            log_cards: self.cards.parsed_cards(),
            epoch: self.cards.epoch(),
            accounts: Arc::new(self.accounts.snapshot()),
            // TRDD-9VX3WTGU Phase C part 2: the previous outputs LEAVE the caches here so the
            // engine can patch them in place (see `summary_engine`). `&mut self` is for this.
            prev: summary_engine::Prev {
                summary: self.summary_cache.take_arc(),
                stripped: self.stripped_cache.take_arc(),
            },
            engine: self.summary_engine.clone(),
        }
    }

    /// The off-lock half: `summary_over` on a snapshot. Free function shape on purpose — it takes
    /// no `&self`, so it cannot accidentally be called while the lock is held.
    pub fn summary_from(inputs: &mut SummaryInputs, now_ms: f64) -> summary_engine::SummaryBuild {
        let _ = now_ms;
        let prev = std::mem::take(&mut inputs.prev);
        inputs.engine.build(inputs.version, &inputs.spans, &inputs.log_cards, inputs.epoch, &inputs.accounts, prev)
    }

    /// Store a summary built off the lock, together with the attribution map built WITH it. The
    /// two must move as one — the `/api/timeline` graft reads the map for the cards the summary
    /// serves — so the map is replaced only when the summary actually lands (a rebuild that lost
    /// the race is discarded whole).
    pub fn store_summary(&mut self, version: u64, build: summary_engine::SummaryBuild) -> std::sync::Arc<Value> {
        let will_store = self.summary_cache.would_store(version);
        let stored = self.summary_cache.store_arc_if_newer(version, build.summary);
        if will_store {
            self.otel_attribution = build.attribution;
            // The stripped twin lands with the summary it was derived from, never alone.
            if let Some(stripped) = build.stripped {
                self.stripped_cache.store_arc_if_newer(version, stripped);
            }
        }
        stored
    }

    /// Returns the merged summary AND `otelAttributionBySession` (server.ts:2245) — the OTEL
    /// api_request entries per claude_code session, captured off the PRE-merge sessions so the
    /// `/api/timeline` graft still has them after the merge displaces the OTEL twin.
    ///
    /// TRDD-9VX3WTGU Phase C: the summary stays a `serde_json::Value` (24 MCP tools and the
    /// dashboard read that shape), so each log card still has to become an OWNED `Value` inside
    /// the merged `sessions` array — the one deep copy that remains. What is gone is everything
    /// around it: the text copy and parse of the whole corpus, the clone of the OTEL sessions
    /// array before the merge, and the clone of every displaced OTEL card's api_request entries.
    pub(crate) fn summary_over(
        spans: &[Arc<Value>],
        log_cards: &[Arc<Value>],
        accounts: &IndexMap<String, String>,
        now_ms: f64,
    ) -> (Value, IndexMap<String, Vec<Value>>) {
        let _ = now_ms;
        // THE ACCOUNT JOIN (TRDD-465EXTJ6). This was `&|_| None`, which meant the summarizer could
        // never resolve `accountId` for a span whose own attrs carry no `user.account_uuid` — and
        // Claude Code's `api_request` records carry none: the uuid arrives on a SEPARATE
        // `api_request_body` record and is joined by `session.id`, which is exactly what this
        // registry holds. With the closure stubbed, every card came out account-less, so
        // `/api/burn-status` reported one `accountUuid: null` bucket instead of per-account
        // windows, and anything keyed on the account (P5 capacity calibration) silently never ran.
        let mut summary = summarize::summarizer::summarize_spans(spans, &|sid| accounts.get(sid).cloned());
        let mut attribution: IndexMap<String, Vec<Value>> = IndexMap::new();
        if log_cards.is_empty() {
            // No merge: every OTEL card survives into the served summary, so its entries are
            // CLONED (the card keeps its timeline).
            for s in summary.get("sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                if s.get("source").and_then(Value::as_str) != Some("claude_code") {
                    continue;
                }
                let entries: Vec<Value> = s
                    .get("timeline")
                    .and_then(Value::as_array)
                    .map(|t| t.iter().filter(|e| e.get("type").and_then(Value::as_str) == Some("api_request")).cloned().collect())
                    .unwrap_or_default();
                if !entries.is_empty() {
                    if let Some(id) = s.get("sessionId").and_then(Value::as_str) {
                        attribution.insert(id.to_owned(), entries);
                    }
                }
            }
            return (summary, attribution);
        }
        // The merge REWRITES the cards it keeps and takes them by VALUE. A log card is shared with
        // the resident layer, so it is copied out here (the one remaining deep copy, see above);
        // the OTEL sessions are MOVED out of the summary instead of cloned — the merged list
        // replaces the `sessions` key below, so nothing reads the original again.
        let log: Vec<Value> = log_cards.iter().map(|c| (**c).clone()).collect();
        let mut otel: Vec<Value> = match summary.get_mut("sessions").map(Value::take) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        };
        // Attribution is captured off the PRE-merge OTEL sessions. A card the merge is about to
        // DROP (`is_displaced_otel`, the merge's own predicate) donates its api_request entries by
        // MOVE; a surviving card keeps its timeline, so its entries are cloned.
        let wins = feed_merge::log_wins_ids(&log);
        for s in &mut otel {
            if s.get("source").and_then(Value::as_str) != Some("claude_code") {
                continue;
            }
            let is_api = |e: &Value| e.get("type").and_then(Value::as_str) == Some("api_request");
            let displaced = feed_merge::is_displaced_otel(s, &wins);
            let Some(timeline) = s.get_mut("timeline").and_then(Value::as_array_mut) else { continue };
            let entries: Vec<Value> = if displaced {
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
        let mut merged = feed_merge::link_subagent_transcripts(feed_merge::merge_otel_and_log_sessions(otel, log));
        // Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'), newest first.
        merged.sort_by(|a, b| {
            let k = |c: &Value| {
                let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
                if st.is_empty() { -62_167_219_200_000.0 } else { summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
            };
            k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
        });
        summary.as_object_mut().expect("summary object").insert("sessions".into(), Value::Array(merged));
        (summary, attribution)
    }

    /// buildSessionSummary — the merged summary, rebuilt only when data_version moved. The
    /// attribution side-map is replaced in the same compute (the TS rebuilds the module-level
    /// Map inside the memoized computeSessionSummary), so map and summary always share a version.
    ///
    /// **This rebuilds INLINE, under whatever lock the caller holds.** Every server path that can
    /// run while ingest is hot goes through `ui::summary_now` instead, which does the same work
    /// off the lock and leaves this a pointer clone (TRDD-HFV4AIT7). It stays inline only for
    /// callers that own the state outright — tests, the CLI, and the cold-boot first build.
    /// The MCP tool handlers are NO LONGER among them (TRDD-QE114936): they run inside the
    /// serving process while ingest is hot, so every one of them now reads `ui::summary_now`
    /// before taking its guard. `ui.rs` is asserted free of this call by
    /// `ui::rebuild_admission_tests::mcp_handlers_never_rebuild_the_summary_under_the_lock`.
    pub fn build_session_summary(&mut self, now_ms: f64) -> std::sync::Arc<Value> {
        // Disjoint field borrows: the cache + side-map are written, the inputs are read.
        // `accounts` joins the disjoint-borrow list for the same reason as the rest: it is READ
        // here while the cache + side-map are written (TRDD-465EXTJ6).
        let Self { summary_cache, window, cards, data_version, otel_attribution, accounts, .. } = self;
        let accounts = accounts.snapshot();
        summary_cache.get(*data_version, || {
            let (summary, attribution) = Self::summary_over(&window.spans, &cards.parsed_cards(), &accounts, now_ms);
            *otel_attribution = attribution;
            summary
        })
    }

    /// buildStrippedSummary — `/api/summary`'s body, memoized the same way.
    pub fn build_stripped_summary(&mut self, now_ms: f64) -> std::sync::Arc<Value> {
        let summary = self.build_session_summary(now_ms);
        self.stripped_cache.get(self.data_version, || ui::strip_session_detail(&summary))
    }

    /// gatherBurn (server.ts:1448) + computeBurnStatus in one step — shared by the 4s burn
    /// tick, `GET /api/burn-status` and (P4r.4) the burn-risk fallback. Does NOT store into
    /// `burn.last_status` — the TS route computes fresh without touching the tick cache.
    /// NOT PORTED: statuslineReader.getBillingEvents (the statusline store) — the gathered
    /// stream carries the api_request events only, statusline sessions contribute nothing yet.
    pub fn live_burn_status(&mut self, now_ms: f64) -> Value {
        let summary = self.build_session_summary(now_ms);
        self.burn_status_over(&summary, now_ms)
    }

    /// The same computation against a summary the caller already has (TRDD-HFV4AIT7 moved the
    /// summary REBUILD off the state lock; TRDD-O3ICDRLO then moved the gather/compute itself off
    /// it — see `burn_status_for`, which this only feeds with the two lock-guarded inputs).
    /// `live_burn_status` and the tests still take this path; the 4 s tick does not.
    pub fn burn_status_over(&mut self, summary: &Value, now_ms: f64) -> Value {
        let ttl = self.burn.ttl_context(now_ms);
        burn_status_for(summary, &self.burn.config, &ttl, now_ms)
    }

    /// `getSessionStatus` (server.ts:1573) — the same gatherBurn stream as `live_burn_status`,
    /// answered for ONE resolved session instead of the whole machine. Split out rather than
    /// folded into `live_burn_status` because the two return different shapes from the same
    /// inputs, and `compute_session_status` needs the SESSION CARDS as well as the events (it
    /// compares the caller's session to its predecessors in the same workspace).
    ///
    /// TRDD-QE114936: `summary` is READ IN by the caller (via `ui::summary_now`, off the state
    /// lock) rather than rebuilt here under the caller's guard. This was the same
    /// rebuild-under-the-lock as the eighteen direct `build_session_summary` sites in `ui.rs`,
    /// hidden one call deep — a grep for the rebuild at the call site could not see it. Named
    /// `_over` like `burn_status_over` for exactly that reason: the name says it does not build.
    pub fn session_status_over(
        &mut self,
        summary: &Value,
        session_id: Option<&str>,
        workspace: Option<&str>,
        now_ms: f64,
    ) -> Value {
        let sessions = summary.get("sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let events = burn::monitor::gather_consumption_events(sessions, &[], now_ms);
        let ttl = self.burn.ttl_context(now_ms);
        burn::monitor::compute_session_status(sessions, &events, &self.burn.config, session_id, workspace, now_ms, Some(&ttl))
    }

    /// The `/api/burn-risk` body (freeze row 12): poll the bodies watcher, then checkBurnRisk
    /// over the three feeds, then attach the verbatim spawning calls behind an active fan-out.
    /// `last_status` is filled inline when the 4s tick has not run yet (freshly booted server),
    /// exactly as the TS route does. NOT PORTED: the in-memory hook-event ring (P4m note) — the
    /// guard reads the NDJSON buckets, so the answer is the same, off disk.
    ///
    /// `fanout_threshold` / `spike_tokens_per_min` are the TS `checkBurnRisk` defaults when None —
    /// only the MCP tool exposes them, and `check_burn_risk` floors both anyway (2 / 10k), so a
    /// caller cannot disable a risk row by passing an absurdly low threshold.
    ///
    /// TRDD-QE114936 site 20: the fill-in used to call `live_burn_status` — a whole-window summary
    /// rebuild — RIGHT HERE, under the caller's guard, on every request in the first ≤4 s after a
    /// restart (before the burn tick has stored a status). The value is now computed OFF the lock
    /// by the caller (`ui::burn_status_now`) and passed in; the caller peeks `last_status` first,
    /// so it computes one only when there is genuinely none.
    pub fn burn_risk_report(
        &mut self,
        now_ms: f64,
        status_when_unset: Option<Value>,
        fanout_threshold: Option<f64>,
        spike_tokens_per_min: Option<f64>,
    ) -> Value {
        if self.burn.last_status.is_none() {
            self.burn.last_status = status_when_unset;
        }
        self.burn.bodies.poll(now_ms);
        let bodies = self.burn.bodies.report(now_ms);
        let mut report = burn::guard::check_burn_risk(&burn::guard::BurnGuardOptions {
            now: now_ms,
            bodies_dir: burn::guard::default_bodies_dir(&self.data_dir),
            hook_events_dir: self.data_dir.join("hook-events"),
            fanout_threshold: fanout_threshold.unwrap_or(5.0),
            spike_tokens_per_min: spike_tokens_per_min.unwrap_or(250_000.0),
            recent_events: None,
            bodies_activity: Some(&bodies),
            burn_status: self.burn.last_status.as_ref(),
        });
        let dirs = agentlens_logscan::discovery::claude_projects_dirs(&self.log_env);
        burn::guard::attach_risk_causing_calls(&mut report, &dirs);
        report
    }
}

/// The pure half of `CoreState::burn_status_over` — the gather over the summary's session cards
/// plus `compute_burn_status` — taking the only two lock-guarded inputs (a TTL snapshot and the
/// config) by reference so the 4 s burn tick can run it with the state lock RELEASED.
///
/// TRDD-O3ICDRLO: the tick guard's per-statement split measured this call at 96% of the guard's
/// lock time (25.8 of 26.9 s over 2h49m, max 1.5 s in one hold), with every ingest and read path
/// queued behind it. The sessions are BORROWED out of the summary rather than deep-cloned into a
/// `Vec<Value>`: the old clone copied every card, with its timeline, on every 4 s fire. Nothing
/// here may touch `CoreState` — that is the whole point of the function.
pub fn burn_status_for(summary: &Value, config: &burn::monitor::BurnConfig, ttl: &burn::cache_ttl::TtlContext, now_ms: f64) -> Value {
    let sessions = summary.get("sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let events = burn::monitor::gather_consumption_events(sessions, &[], now_ms);
    burn::monitor::compute_burn_status(&events, sessions, config, now_ms, Some(ttl))
}

impl CoreState {
    /// Open the store under `<data_dir>/spans`. The summary window starts EMPTY.
    ///
    /// TRDD-FSMISF5K: this used to run the TS boot load (server.ts:422) — every segment
    /// overlapping the last `summaryWindowHours` replayed into `window.spans`. Measured on the
    /// live collector that was 528,219 spans and a 13.2 GB peak, and it produced exactly ONE of
    /// the 23,274 cards `/api/summary` served (see `span_window`'s header for the measurement and
    /// why the feed merge makes a replayed OTEL twin worthless). Booting empty is therefore not a
    /// data cut — every span is still on disk, `session_summary_sql` aggregates it there, and
    /// `/api/timeline` re-reads one session on demand.
    pub fn open(data_dir: &std::path::Path) -> CoreState {
        let now = now_ms();
        let writer = SpanStoreWriter::open(&data_dir.join("spans"));
        let window = span_window::SpanWindow::new(span_window::summary_window_ms(data_dir));
        CoreState {
            ingest: IngestState::default(),
            writer,
            counters: Counters::default(),
            window,
            data_version: 0,
            last_ingest_activity_ms: 0,
            sink_problem: None,
            build_id: now.to_string(),
            media_dir: None,
            // TRDD-TOIM26HP: `<data_dir>/cards.duckdb`, opened EMPTY at every boot — the corpus is
            // on disk so DuckDB's bounded buffer pool decides what is resident, not the process.
            cards: card_store::CardStore::open(data_dir),
            data_dir: data_dir.to_path_buf(),
            started_at_ms: now,
            ports: server_stats::Ports::default(),
            persist: server_stats::PersistStats::default(),
            // Opened (not created) at boot: `open` seeds its change-detection key from the file's
            // last line, so a restart into an unchanged subscription state re-logs nothing.
            account_timeline: account_state_timeline::AccountStateTimeline::open(
                account_state_timeline::account_state_timeline_path(data_dir),
            ),
            log_sink_warned: std::collections::HashSet::new(),
            hook_runtime: server_stats::hook_runtime_config(data_dir),
            log_scan: log_reader::LogScanStats::default(),
            sweeper: None,
            summary_cache: derived_cache::VersionedCache::default(),
            stripped_cache: derived_cache::VersionedCache::default(),
            summary_engine: Arc::new(summary_engine::SummaryEngine::default()),
            accounts: account_registry::AccountRegistry::default(),
            bodies: call_body_registry::CallBodyRegistry::default(),
            composition: context_composition_index::ContextCompositionIndex::default(),
            requests: request_log::RequestLog::new(Some(data_dir.join("requests.log"))),
            otel_attribution: IndexMap::new(),
            lifecycle: collector_lifecycle::record_start(&collector_lifecycle::lifecycle_file(data_dir), now),
            log_env: agentlens_logscan::discovery::Env::from_process(),
            latest_resident_blobs: Vec::new(),
            pressure_stage: 0,
            demote_failing: false,
            // Not loaded here: `open` must not create a key file as a side effect of constructing
            // state (every test would mint one). The BINARY loads it at boot and refuses to start
            // if it is unusable — see bin/alcore.rs.
            embed_key: None,
            burn: {
                let env = agentlens_logscan::discovery::Env::from_process();
                burn::runtime::BurnRuntime::new(env.home, std::env::vars().collect(), data_dir)
            },
            // Boot-seed the ring from disk so a fresh server isn't blind to a stall/fan-out from
            // 5 minutes ago (server.ts:1029 — last hour, ≤500, reversed to oldest-first).
            recent_hook_events: {
                let mut seed = hook_events::read_hook_events(
                    &data_dir.join("hook-events"),
                    &hook_events::HookEventFilter { since_ms: Some(now - 3_600_000), limit: Some(500), ..Default::default() },
                );
                seed.reverse();
                seed
            },
            advisory_issued: std::collections::HashMap::new(),
            statusline: statusline_store::StatuslineStore::new(data_dir.join("statusline")),
            // TRDD-N6A8VX3G: same data-dir-rooted delta-log family as log-sessions/log-offsets;
            // constructed here because CoreState::open is the one site that owns data_dir.
            body_links: crate::delta_log::DeltaLog::new(data_dir, "body-links"),
            spool_tap: None,
            spool_tap_off_reason: "not configured: alcore serve was started without --ingest-manifest and --aldigest-bin".to_owned(),
        }
    }

    /// `/action {type:"clearAll"}` — the spans go (window + the whole on-disk store), the log
    /// cards stay. Bumps data_version so the next push carries the cleared state.
    pub fn clear_spans(&mut self) {
        self.window.spans.clear();
        self.writer.clear();
        // The OTEL window changed wholesale: rebuild every merged card rather than trust a diff.
        self.summary_engine.force_full.store(true, std::sync::atomic::Ordering::Relaxed);
        self.data_version += 1;
    }

    /// `POST /api/clear` — spans AND log cards AND the tail offsets go; the sweeper then re-reads
    /// every file from 0 (a targeted scan would only see the paths the watcher happened to name).
    pub fn clear_all(&mut self) {
        self.clear_spans();
        self.cards.clear();
        if let Some(s) = &self.sweeper {
            s.clear_and_rescan();
        }
    }

}

/// Pressure-ladder stage (0..=3) for `metric` against ascending `thresholds`. Moves UP at most one
/// stage per call; moves DOWN one stage only once the metric is 10% of the hard cap below the
/// current stage threshold (hysteresis), so a metric hovering at a boundary does not flap.
pub fn pressure_stage(metric: u64, thresholds: [u64; 3], prev: u8, cap: u64) -> u8 {
    let prev = prev.min(3);
    if prev < 3 && metric >= thresholds[prev as usize] {
        return prev + 1;
    }
    if prev > 0 && metric < thresholds[prev as usize - 1].saturating_sub(cap / 10) {
        return prev - 1;
    }
    prev
}

/// Kill switch: `AGENTLENS_PRESSURE_LADDER=off` disables the ladder (default on).
pub fn pressure_ladder_enabled(env_value: Option<&str>) -> bool {
    !env_value.is_some_and(|v| v.trim().eq_ignore_ascii_case("off"))
}

impl CoreState {
    /// The flush tick's prune (server.ts flushSpanAppends): the window shrank ⇒ every derived
    /// view must be rebuilt.
    pub fn prune_window(&mut self, now_ms: i64) {
        // HOW LONG THIS HOLDS THE STATE LOCK IS THE MEASUREMENT (TRDD-2R36W8Q1). `prune_window`
        // runs with `&mut self`, i.e. under the state lock, over the whole span window. Every
        // reader's poll loop calls `state.lock()`, so a long hold here is UNBOUNDED latency that
        // `STALE_BUDGET_MS` cannot see: that budget bounds the wait for a REBUILD, not the wait
        // for the lock. Measured 2026-08-29: the two >6 s `/api/server-stats` probes landed
        // exactly on the burst where the memory-pressure valve shrank the window 24h -> 300 s
        // (window_shrinks_so_far went 2 -> 9 between the fast probe and the slow one), and the
        // probe after the burst was back to 0.50 s. That is a CORRELATION; this log is what turns
        // it into a measurement, because this session has already spent five attempts on causes
        // that were inferred from a number that merely fit.
        let began = std::time::Instant::now();
        // Memory pressure FIRST: narrowing the window is what makes the following prune evict.
        // Order is load-bearing — halving after the prune would defer every cut by a full tick,
        // and the tick is 5s while a flood can add ~11k spans/s.
        // WHY the ladder keys on `primary_metric` against fractions of the HARD cap: the old valve
        // measured RSS against a 4096 MB budget while the kill used phys_footprint at 2048 MB, so
        // it never fired before the kill. Actions run on an UPWARD edge only (not every tick).
        let mut narrowed = false;
        if pressure_ladder_enabled(std::env::var("AGENTLENS_PRESSURE_LADDER").ok().as_deref()) {
            let cap = rss_guard::rss_hard_cap_bytes();
            let metric = rss_guard::primary_metric(crate::server_stats::rss_bytes).1;
            let thresholds = rss_guard::pressure_thresholds(&self.data_dir, cap);
            let prev = self.pressure_stage;
            let new = pressure_stage(metric, thresholds, prev, cap);
            self.pressure_stage = new;
            if new > prev {
                if new >= 1 {
                    self.stripped_cache.clear();
                }
                if new >= 2 {
                    self.summary_cache.clear();
                    self.latest_resident_blobs.clear();
                    // u64::MAX over a budget of 1 forces the time window to halve (floored at 5 min).
                    narrowed = self.window.apply_memory_pressure(u64::MAX, 1);
                }
                if new == 3 {
                    let cut = (self.window.max_spans / 2).max(10_000);
                    if cut < self.window.max_spans {
                        self.window.max_spans = cut;
                        narrowed = true;
                    }
                }
                println!("{} alcore: memory pressure stage {prev} -> {new} (metric {metric} B)", crate::log_ts());
            } else if new < 3 {
                // Below stage 2 the window may step back toward its configured size (the stage-2
                // edge halves it, so recovering while still at stage 2 would undo the cut).
                if new < 2 {
                    narrowed = self.window.apply_memory_pressure(0, 1);
                }
                if new < 3 && self.window.max_spans != span_window::max_spans_default() {
                    self.window.max_spans = span_window::max_spans_default();
                    narrowed = true;
                }
            }
        }
        // Hard ceiling, separate from and higher-severity than the soft valve above: if RSS is
        // still over AGENTLENS_RSS_HARD_CAP_MB (default 2048) after the soft valve had its
        // chance, the leak isn't in the summarization window this tick narrows — exit now with a
        // diagnostic rather than let the process grow toward an OOM kill with no evidence left.
        // A CLOSURE, not `rss_now`. `rss_now` was sampled ABOVE, before the valve ran — the valve
        // needs it, but the hard cap must not be keyed on a pre-valve reading, or on the RSS path
        // it cannot see the only thing that makes the breach meaningful: still over AFTER the cut.
        // On macOS this closure is never called; the footprint syscall answers first.
        // Snapshot fields are read into owned locals BEFORE the flush closure below, so the
        // closure's `&mut self.writer` capture (Rust 2021 disjoint field capture) never overlaps
        // an outstanding `&self.writer`/`&self.window`/`&self.cards` borrow from building the
        // snapshot — those borrows are already done by the time the closure is constructed.
        let log_path = self.data_dir.join("rss-hard-cap.log");
        let snapshot = rss_guard::CulpritSnapshot {
            cap_bytes: rss_guard::rss_hard_cap_bytes(),
            resident_spans: Some(self.window.spans.len()),
            window_effective_ms: Some(self.window.effective_ms),
            window_configured_ms: Some(self.window.configured_ms),
            card_count: Some(self.cards.len()),
            span_store_segments: Some(self.writer.stats().0),
            span_store_total_spans: Some(self.writer.stats().1),
            span_store_total_bytes: Some(self.writer.stats().2),
            uptime_ms: Some(now_ms - self.started_at_ms),
        };
        rss_guard::check_and_enforce(
            crate::server_stats::rss_bytes,
            // `exit()` skips destructors — buffered span-store appends not yet flushed to disk
            // would be lost silently at the exact moment this guard exists to prevent silent
            // loss, so flush them first. Called only on breach (check_and_enforce runs this
            // AFTER confirming the cap is exceeded), never on every 5s tick.
            || {
                self.writer.flush();
            },
            &log_path,
            snapshot,
        );
        if narrowed {
            // Said out loud: a silently shrinking window looks identical to "no traffic", and the
            // whole point of porting this guard is that the cut is visible. `windowMs` in
            // /api/server-stats carries the current value.
            println!(
                "{} alcore: memory pressure — summarization window now {}ms (configured {}ms)",
                crate::log_ts(),
                self.window.effective_ms, self.window.configured_ms
            );
        }
        if self.window.prune(now_ms) || narrowed {
            // Any prune / pressure-ladder narrowing: a full rebuild is the simplest correct rule.
            self.summary_engine.force_full.store(true, std::sync::atomic::Ordering::Relaxed);
            self.data_version += 1;
        }
        // Only when it is long enough to be someone else's latency. A per-tick line would be noise
        // on an idle server and would itself cost more than the pass it reports.
        let held = began.elapsed();
        if held >= std::time::Duration::from_millis(250) {
            println!(
                "{} alcore: prune_window held the state lock for {} ms ({} spans, window {}ms{})",
                crate::log_ts(),
                held.as_millis(),
                self.window.spans.len(),
                self.window.effective_ms,
                if narrowed { ", NARROWED" } else { "" }
            );
        }
    }

    /// The ONE span flush path (server.ts flushSpanAppends): a flush that appended counts as one
    /// write of that many bytes — the persistence row `/api/server-stats` reports. Every flush
    /// site (per payload, the 5s tick, shutdown) goes through here so the counter cannot miss one.
    pub fn flush_spans(&mut self) {
        let r = self.writer.flush();
        if r.appended_spans > 0 {
            self.persist.span_append_writes += 1;
            self.persist.span_append_bytes += r.appended_bytes;
        }
    }

    /// server.ts persistDroppedLogEvent — append ONE gate-rejected log event to its daily bucket
    /// in `<data>/log-events/`, the same NDJSON-bucket machinery hook-events uses.
    ///
    /// The error policy is deliberately NOT this project's usual fail-fast: a sink failure must
    /// not reject the whole OTLP payload, because that would lose the SPANS in it too — trading a
    /// disk problem for data loss in a subsystem that was working. So the append is best-effort
    /// per record. It is not silent either: the first occurrence of each distinct error message
    /// warns, and every attempt is counted, so a persistently failing disk is visible in the log
    /// once and in `persistedSinceBoot` staying flat while `otlpDroppedLogEvents` climbs.
    pub fn persist_dropped_log_event(&mut self, rec: &serde_json::Map<String, Value>) {
        let ts = rec.get("ts").and_then(Value::as_i64).unwrap_or_else(now_ms);
        let line = Value::Object(rec.clone()).to_string();
        match hook_events::append_bucket_line(&self.data_dir.join("log-events"), ts, &line) {
            Ok(pos) => {
                self.persist.log_event_writes += 1;
                self.persist.log_event_bytes += pos.length;
            }
            Err(e) => {
                let msg = e.to_string();
                if self.log_sink_warned.insert(msg.clone()) {
                    eprintln!("{} [AgentLens] log-event sink append FAILED (event lost — disk problem?): {msg}", crate::log_ts());
                }
            }
        }
    }
}

/// Is `started_by` a SANCTIONED lift of the NO_REVIVE brake (TRDD-Q8ZW00CI)?
///
/// `server start` and `server restart` are the documented overrides — the CLI arms the spawn with
/// them and clears the brake once the server answers — so for those two the starter DID honour the
/// brake's contract. Every other starter (a hook, the supervisor, a hand-launch, an unstamped
/// spawner) reaching a braked data dir is the case the WARN exists to surface.
///
/// A free function with a test rather than an `if` inside `alcore.rs`'s `main`: a binary's main is
/// not reachable from a test, and this predicate decides whether an operator is accused of
/// ignoring a brake they actually honoured. The original bug was exactly this branch missing.
pub fn brake_lift_is_sanctioned(started_by: &str) -> bool {
    matches!(started_by.trim(), "server start" | "server restart")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ISO 8601 local timestamp with numeric offset (`2026-09-27T14:03:11+0200`) — the prefix on
/// every alcore chore/boot diagnostic line (TRDD-DX8PYPLO D1): server.log lines carried no
/// timestamps, so no body-write rate or boot sequence was measurable from history.
pub fn log_ts() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%z").to_string()
}

/// Boot-uptime stamp for every instrument line (TRDD-2JOIAH2G round-98 item B): `[up 42s] `,
/// spliced between the `alcore: ` lead and the message. Boot phase is MEASURED, never inferred —
/// round-96 had to reconstruct boot-A uptime from kill-block adjacency because no line carried it.
/// The OnceLock seeds at FIRST CALL, not a `ctor` hook — one less init hook keeps the boot path
/// plain. T0 semantics: the first instrument call comes AFTER log restore/backfill (measured ~16s
/// after the boot provenance line, varying per boot), so the absolute `[up Ns]` UNDERCOUNTS true
/// process uptime by that boot-work duration; each boot's first tick prints the residual itself
/// (self-calibrating), and within-boot deltas are unaffected. Seconds-only keeps the stamp one
/// format — greppable and parseable at any age.
pub fn uptime_prefix() -> String {
    static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let secs = BOOT.get_or_init(std::time::Instant::now).elapsed().as_secs();
    format!("[up {secs}s] ")
}

/// One POST body through the transforms into the store. Never fails toward the wire — the
/// frozen contract answers 200 whatever happens; failures are counted, not surfaced.
/// The parse half of an OTLP POST — pure, so the HTTP handler runs it BEFORE taking the state
/// lock. Measured before this split (TRDD-HFV4AIT7 baseline): with parse + append + flush all
/// under the one `Mutex<CoreState>`, 32 concurrent posters reached 131 req/s at 29% mean CPU on
/// a 14-core machine — every request serialised behind the previous one's disk write, and the
/// parse (the CPU-heavy part) never ran on more than one core. Err = unparseable (the TS
/// collector's otlpIngestError fallback, e.g. a protobuf export) — counted by the caller, still
/// 200 on the wire. `Option`, not `Result<_, ()>`: there is exactly one failure and it carries no
/// information, and clippy's `result_unit_err` is right that a unit error is a worse `None`.
pub fn parse_payload(path: &str, body: &[u8]) -> Option<(&'static str, Value)> {
    let text = std::str::from_utf8(body).ok()?;
    let payload = serde_json::from_str::<Value>(text).ok()?;
    let kind = match path {
        "/v1/traces" => "traces",
        "/v1/logs" => "logs",
        "/v1/metrics" => "metrics",
        _ => classify(&payload),
    };
    Some((kind, payload))
}

/// Parse + ingest + flush in one call, for callers that hold the state directly (tests, the
/// import paths): the flush makes the segment readable the moment this returns. The HTTP
/// handler does NOT use this — it parses off-lock and leaves the flush to the 5 s tick
/// (chores.rs), so a burst of posters is bounded by CPU, not by one fsync per payload.
pub fn ingest_post(state: &mut CoreState, path: &str, body: &[u8]) {
    match parse_payload(path, body) {
        Some((kind, payload)) => ingest_parsed(state, kind, payload, path),
        None => state.counters.parse_errors += 1,
    }
    if state.writer.pending_appends() > 0 {
        state.flush_spans();
    }
}

/// The ingest half: process the parsed payload into the store buffer and the live window.
/// Holds the lock for serialisation + window insert only — no disk.
/// `AGENTLENS_INGEST_PROFILE=1` — read once, because this is on the per-request path and an env
/// lookup per request would itself be part of what it measures.
fn ingest_profile_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("AGENTLENS_INGEST_PROFILE").is_ok_and(|v| v != "0" && !v.is_empty()))
}

/// Accumulate the three phases of an ingest request and print a summary every 2,000 of them.
///
/// The number that decides whether ingest can ever use more than one core is `held` — time inside
/// the global state lock. Wall-clock throughput cannot distinguish "the server is slow" from "the
/// server is serialized"; a held-time that approaches the wall time per request can only mean the
/// latter. `parse` is the off-lock half and is the control: if parse is large and held is small,
/// the current shape is already right and the ceiling is elsewhere.
fn record_ingest_profile(parse_ns: u64, wait_ns: u64, held_ns: u64) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    static PARSE: AtomicU64 = AtomicU64::new(0);
    static WAIT: AtomicU64 = AtomicU64::new(0);
    static HELD: AtomicU64 = AtomicU64::new(0);
    PARSE.fetch_add(parse_ns, Ordering::Relaxed);
    WAIT.fetch_add(wait_ns, Ordering::Relaxed);
    HELD.fetch_add(held_ns, Ordering::Relaxed);
    let n = N.fetch_add(1, Ordering::Relaxed) + 1;
    if n.is_multiple_of(2000) {
        let (p, w, h) = (PARSE.load(Ordering::Relaxed), WAIT.load(Ordering::Relaxed), HELD.load(Ordering::Relaxed));
        let ms = |x: u64| x as f64 / 1e6;
        println!(
            "{} ingest-profile: n={} parse={:.1}ms/req wait_for_lock={:.1}ms/req held_lock={:.1}ms/req | totals parse={:.0}ms wait={:.0}ms held={:.0}ms",
            crate::log_ts(),
            n,
            ms(p) / n as f64,
            ms(w) / n as f64,
            ms(h) / n as f64,
            ms(p),
            ms(w),
            ms(h),
        );
    }
}

/// TRDD-N6A8VX3G — one durable request↔response link row per ingested BodyPointer. Pure so the
/// unit test can call it directly (inline construction at the ingest site would make the test
/// unreachable). The pair is NOT resolved here: rows carry both sides' pairing keys
/// (request_body_id / span_id) and GVA8TTJF's SQL join resolves the pair.
/// NO device_id, NO account_uuid — they ARE on the wire (metadata.user_id) but the no-identities
/// doctrine forbids persisting them anywhere.
fn body_link_row(p: &agentlens_ingest::BodyPointer) -> (String, Value) {
    use sha2::Digest;
    let (span_id, stem, request_id, request_body_id, message_id) = (
        p.span_id.as_deref().unwrap_or(""),
        p.body_ref.as_deref().unwrap_or(""),
        p.request_id.as_deref().unwrap_or(""),
        p.request_body_id.as_deref().unwrap_or(""),
        p.message_id.as_deref().unwrap_or(""),
    );
    // WHY (TRDD-N6A8VX3G D4): the key derives from EVERY field the row stores. The old key
    // "{span_id}:{kind}:{ts}" collided for two different same-kind pointers without a span_id in
    // one OTLP payload (ts is the payload ingest time, shared by all its pointers), and DeltaLog
    // replay keeps the last row per key, so a link row was silently lost. The fields come from
    // untrusted OTLP input, so no separator character is safe to join them with; a JSON array
    // encodes each field with quoting and escaping, so distinct field tuples give distinct
    // strings. The key is that string HASHED, not the string itself: keying by the full row
    // content roughly doubled the snapshot and the boot rewrite cost (~19M rows a year).
    // SHA-256 truncated to 128 bits (32 hex chars): a collision needs ~2^64 rows, far beyond 19M/yr,
    // and a crafted collision would only drop one telemetry link row. Identical content still
    // collapses to one row (harmless).
    let encoded = serde_json::to_string(&[p.session_id.as_str(), span_id, p.kind, stem, request_id, request_body_id, message_id, &p.ts.to_string()])
        .expect("a string array always serializes");
    let digest = sha2::Sha256::digest(encoded.as_bytes());
    let key: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    (
        key,
        serde_json::json!({
            "session_id": p.session_id,
            "span_id": span_id,
            "kind": p.kind,
            "stem": stem,
            "request_id": request_id,
            "request_body_id": request_body_id,
            "message_id": message_id,
            "ts_ms": p.ts,
        }),
    )
}
pub fn ingest_parsed(state: &mut CoreState, kind: &'static str, payload: Value, path: &str) {
    let now = now_ms();
    let mut spans: Vec<Value> = match kind {
        "traces" => {
            state.counters.traces_payloads += 1;
            state.ingest.process_traces(payload, path)
        }
        "logs" => {
            state.counters.logs_payloads += 1;
            // server.ts processLogs' gen_ai branch: the response content lands as a read-time
            // OVERLAY on the store (injectSpanAttribute — always true, so the ingest buffer is
            // consumed immediately; the buffer's fallback still covers a span in the SAME payload).
            let r = {
                let CoreState { ingest, writer, .. } = state;
                ingest.process_logs(&payload, now, |t, s, v| writer.inject_span_attribute(t, s, "gen_ai.output.messages", v))
            };
            // server.ts processLogs: the body-pointer events' user.account_uuid → the registry.
            for (sid, acct) in &r.account_pairs {
                state.accounts.record(sid, acct);
            }
            // …and the pointers themselves into the registry half (P4w.1). The transform has
            // returned these as data since P3b; until now nothing consumed them, so every
            // per-session drill-down would have resolved to an empty registry.
            for p in r.body_pointers {
                // TRDD-N6A8VX3G: a durable link row per pointer — the response side written by
                // 9SYRK6SW's api_call table joins to a session through these rows. Immediate-append
                // (ingest_parsed holds &mut state; a pending Vec would lose rows to a process kill
                // — pointer events are transient OTLP records, nothing re-delivers them).
                // The append must NEVER fail the ingest: a disk-full/corrupt-file error here logs
                // one line and continues (mirrors the sweeper's "could not save log cards
                // (partial)" — no `?`, no panic).
                let (key, row) = body_link_row(&p);
                let mut rec = IndexMap::new();
                rec.insert(key, row);
                if let Err(e) = state.body_links.append_changed(&rec) {
                    eprintln!("{} alcore: could not append body link: {e}", crate::log_ts());
                }
                state.bodies.record_ingested(p);
            }
            // server.ts persistDroppedLogEvent (TRDD-AMEA4O4Z): every event the rich-event gate
            // REJECTS is persisted to <data>/log-events/ instead of being counted and thrown
            // away. Several of these (permission decisions, hook/plugin lifecycle) exist nowhere
            // else — not in the transcripts — so dropping them was real data loss.
            for rec in r.dropped {
                state.persist_dropped_log_event(&rec);
            }
            r.spans
        }
        "metrics" => {
            // Accepted and DISCARDED — the frozen behavior.
            state.counters.metrics_payloads += 1;
            Vec::new()
        }
        _ => Vec::new(),
    };
    // Stamp arrival BEFORE the store append (TRDD-GR6WHHK5): `append` writes the line as it
    // stands, so a span stamped only by `window.add` below persisted with no timestamp at all.
    // Same `now` for both copies — one clock read per payload, one stamping helper.
    for span in &mut spans {
        span_window::stamp_received_at(span, now);
        state.writer.append(span, now);
        state.counters.spans_appended += 1;
    }
    if !spans.is_empty() {
        state.data_version += 1;
        // server.ts:2161 `if (count > 0) lastIngestActivityAt = Date.now()` — spans arriving mean
        // sessions are active. Same condition deliberately: a payload that parsed but yielded no
        // spans is NOT capture activity, and counting it would make a feed that is connected but
        // producing nothing look alive, which is the one thing this clock exists to detect.
        //
        // TRDD-X70L1O3S: …and only a CLAUDE CODE span counts. This clock feeds CAPTURE DOWN
        // ("sessions active but no raw body landed"), and only Claude Code honours
        // OTEL_LOG_RAW_API_BODIES; Codex/Copilot/OpenCode spans would tick it forever with no
        // body ever coming, so a Codex-only machine showed CAPTURE DOWN permanently. Ingest
        // re-prefixes every stored Claude span `claude_code.` (agentlens-ingest module docs).
        if spans.iter().any(|s| s.get("name").and_then(Value::as_str).is_some_and(|n| n.starts_with("claude_code."))) {
            state.last_ingest_activity_ms = now;
        }
    }
    for span in spans {
        state.window.add(span, now);
    }
}

async fn handle(
    req: Request<Incoming>,
    state: Arc<Mutex<CoreState>>,
    tap: Option<Arc<spool_tap::SpoolTap>>,
) -> Result<Response<Full<Bytes>>, String> {
    // The discovery probe matches the RAW url (path+query, no strip) — server.ts:4414 compares
    // req.url exactly, so a query string must NOT match.
    let raw_url = req.uri().path_and_query().map(|pq| pq.as_str().to_owned()).unwrap_or_else(|| req.uri().path().to_owned());
    if req.method() == Method::GET && raw_url == "/agentlens/standalone" {
        let mut resp = Response::new(Full::new(Bytes::from_static(br#"{"agentlens":true,"kind":"standalone"}"#)));
        resp.headers_mut().insert("Content-Type", hyper::header::HeaderValue::from_static("application/json"));
        return Ok(resp);
    }
    if req.method() != Method::POST {
        return Ok(Response::new(Full::new(Bytes::new())));
    }

    let path = req.uri().path().to_owned();
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("body read: {e}"))?;
        if let Some(data) = frame.data_ref() {
            if buf.len() + data.len() > MAX_BODY_BYTES {
                // Overflow ABORTS the connection with no response (the Err propagates out of the
                // service and hyper drops the socket) — the frozen twin of req.socket.destroy().
                return Err("body over 64MB cap — connection aborted".to_owned());
            }
            buf.extend_from_slice(data);
        }
    }

    // Parse on THIS worker thread, before the lock: N connections parse on N cores.
    //
    // THE COMMENT HERE USED TO SAY the lock "covers only the buffer append + window insert". That
    // is not what it covers: `ingest_parsed` runs `process_traces` — the whole OTLP→span
    // transform, the expensive part — INSIDE it. Measured 2026-08-29: the server sits at 1.02
    // cores under a concurrency-64 flood (0.90 at concurrency 8), i.e. 8× the offered load buys
    // 8% more throughput and an 8× worse p99. That is one serialized section, and this is it.
    // `AGENTLENS_INGEST_PROFILE=1` splits the per-request cost so the claim is measured rather
    // than argued.
    let profile = ingest_profile_on();
    let t_parse = profile.then(std::time::Instant::now);
    let parsed = parse_payload(&path, &buf);
    let parse_ns = t_parse.map(|t| t.elapsed().as_nanos() as u64).unwrap_or(0);
    // SPOOL TAP — placed HERE, between the parse and the lock, for two reasons: it must read the
    // payload BEFORE `ingest_parsed` below consumes it (`process_traces` takes it by value and
    // moves/stamps its fields), and it must run OUTSIDE the state lock, which every request
    // serialises on. It only builds the line strings; the file writes go to the blocking pool.
    if let (Some(tap), Some((kind, payload))) = (&tap, &parsed) {
        tap.otlp(kind, payload);
    }
    let t_wait = profile.then(std::time::Instant::now);
    {
        let mut st = state.lock_timed();
        let wait_ns = t_wait.map(|t| t.elapsed().as_nanos() as u64).unwrap_or(0);
        let t_held = profile.then(std::time::Instant::now);
        match parsed {
            Some((kind, payload)) => ingest_parsed(&mut st, kind, payload, &path),
            None => st.counters.parse_errors += 1,
        }
        if profile {
            let held_ns = t_held.map(|t| t.elapsed().as_nanos() as u64).unwrap_or(0);
            record_ingest_profile(parse_ns, wait_ns, held_ns);
        }
    }
    Ok(Response::new(Full::new(Bytes::new())))
}

/// Serve the OTLP contract on `addr` until the process ends. Returns the BOUND address (for
/// ephemeral test ports) via the callback before blocking on accept.
pub async fn serve_otlp(
    addr: SocketAddr,
    state: Arc<Mutex<CoreState>>,
    on_bound: impl FnOnce(SocketAddr),
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?);
    // The tap handle is read ONCE here, not per request: `handle` runs between the parse and the
    // state lock, and taking the lock just to look at a field that never changes after boot would
    // add a lock wait to every POST of a server that has the tap off. `CoreState.spool_tap` stays
    // the single owner; this is a clone of its `Arc`.
    let tap = state.lock_timed().spool_tap.clone();
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let state = state.clone();
        let tap = tap.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone(), tap.clone()));
            // An Err from the service aborts this connection — exactly the overflow contract.
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

// --- state-lock wait/hold attribution (TRDD-2R36W8Q1) -----------------------------------------
//
// WHY this exists: five `sample` captures on 2026-09-02 showed HTTP handlers parked waiting on
// `state.lock()` with no holder identifiable from the stack (the holder had already returned by
// the time the profiler walked it). The card's own NEXT ACTION forbids guessing which call site
// is responsible — so the lock itself now names its holder: whoever is inside `lock_timed()`
// records its call site in a global slot, and anyone that has to WAIT past the threshold prints
// that recorded site, not a guess.
use std::panic::Location;

/// `compositionProjectResolver` (server.ts:1462) — sessionId → `projectPath ?? workspace ??
/// 'unknown'`, over a summary the caller already holds.
///
/// Not optional decoration: it is what fills the `project` field of every composition and what
/// a `scope` string is matched against in `resolve_scope`. Without it every composition reads
/// `project: "unknown"` and a project-scoped query matches NOTHING while still answering 200 —
/// the row-36 route omitted it until P4x.2c and had exactly that divergence from the TS.
///
/// A pure function over the summary, NOT a `CoreState` method, on purpose (TRDD-UTFVMVT8): the
/// method form called `build_session_summary` under the state lock, and on a cache miss that is
/// the whole O(window) rebuild while every ingest and read path queues — measured on the live
/// server at 12.6 s and 30.1 s per call with the other two statements under that guard at 0 ms.
/// Callers get the summary from `ui::summary_now` (off-lock; warm, stale, or the one cold-boot
/// build) and take the lock only for what actually needs it.
pub fn composition_project_map(summary: &Value) -> std::collections::HashMap<String, String> {
    COMPOSITION_PROJECT_MAP_BUILDS.with(|c| c.set(c.get() + 1));
    let mut map = std::collections::HashMap::new();
    for s in summary.get("sessions").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let Some(id) = s.get("sessionId").and_then(Value::as_str) else { continue };
        // `projectPath ?? workspace ?? 'unknown'` — NULLISH, so an empty string is kept.
        let project = s
            .get("projectPath")
            .and_then(Value::as_str)
            .or_else(|| s.get("workspace").and_then(Value::as_str))
            .unwrap_or("unknown");
        map.insert(id.to_owned(), project.to_owned());
    }
    map
}

thread_local! {
    /// How many times `composition_project_map` has been called on THIS thread. The map is
    /// O(sessions) to build, and the scope pass used to rebuild it once PER SESSION
    /// (O(sessions²) probes per pass) — the live profile put 14,071 of 14,071 samples in
    /// exactly that shape. The counter is the regression's proof: a scope pass over N
    /// sessions must build the map ONCE.
    ///
    /// THREAD-LOCAL, not global: cargo runs the unit tests on parallel threads, and a global
    /// counter would count OTHER tests' builds and make the assertion a race. The scope pass
    /// runs on one task's thread end to end (the body parse is the only `spawn_blocking`), so
    /// a thread-local count is exactly this pass's count.
    static COMPOSITION_PROJECT_MAP_BUILDS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// The number of `composition_project_map` builds on the CALLING thread — the regression
/// counter for the O(sessions²) scope pass.
pub fn composition_project_map_builds() -> u64 {
    COMPOSITION_PROJECT_MAP_BUILDS.with(|c| c.get())
}
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
use std::sync::MutexGuard;

static HOLDER_SITE: AtomicPtr<Location<'static>> = AtomicPtr::new(std::ptr::null_mut());
static HOLDER_SINCE_NS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn lock_trace_threshold_ms() -> u64 {
    static THRESHOLD: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *THRESHOLD.get_or_init(|| {
        std::env::var("AGENTLENS_LOCK_TRACE_MS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(250)
    })
}

/// A `MutexGuard<CoreState>` that records its own acquisition site as the global "current
/// holder" for as long as it lives, and logs how long it was held if that's ≥ the threshold.
pub struct StateGuard<'a> {
    guard: MutexGuard<'a, CoreState>,
    site: &'static Location<'static>,
    since: std::time::Instant,
}

impl<'a> std::ops::Deref for StateGuard<'a> {
    type Target = CoreState;
    fn deref(&self) -> &CoreState {
        &self.guard
    }
}

impl<'a> std::ops::DerefMut for StateGuard<'a> {
    fn deref_mut(&mut self) -> &mut CoreState {
        &mut self.guard
    }
}

impl<'a> Drop for StateGuard<'a> {
    fn drop(&mut self) {
        let held = self.since.elapsed();
        // Clear the holder record ONLY if it is still ours: another CoreState mutex in the same process
        // (test binaries run several) could have set the record after us, and a plain store would erase it.
        let ptr = self.site as *const Location<'static> as *mut Location<'static>;
        let _ = HOLDER_SITE.compare_exchange(ptr, std::ptr::null_mut(), Ordering::AcqRel, Ordering::Relaxed);
        if held >= std::time::Duration::from_millis(lock_trace_threshold_ms()) {
            eprintln!("{} alcore: state lock held {} ms by {}:{}", crate::log_ts(), held.as_millis(), self.site.file(), self.site.line());
        }
    }
}

/// `state.lock()` that attributes a long WAIT to whoever is currently holding it, and records
/// itself as the new holder for the next waiter. Drop-in replacement for `Mutex::lock()`, minus
/// the `Result`: the alcore panic hook (TRDD-3RVTC1HY) exits the process before unwinding, so a
/// poisoned CoreState lock is never observed in production. In a test binary without that hook,
/// a poisoned lock panics inside `lock_timed` by design.
pub trait LockTimed {
    fn lock_timed(&self) -> StateGuard<'_>;
}

impl LockTimed for Mutex<CoreState> {
    #[track_caller]
    fn lock_timed(&self) -> StateGuard<'_> {
        let site = Location::caller();
        // Snapshot the holder BEFORE blocking. By the time `lock()` returns, the holder that
        // made us wait has released and CLEARED the slot, so a read after acquisition can only
        // ever say "unknown" — measured on the first deployed build (2026-09-02): all 13 waited
        // lines read "holder unknown" while the matching `held` lines named ui.rs:560. The site
        // holding the lock at the instant we queue is the one we are queued behind (a later
        // holder that also delayed us is not attributed here — the `held` line covers it).
        let holder_ptr = HOLDER_SITE.load(Ordering::Acquire);
        let holder_since_ns = HOLDER_SINCE_NS.load(Ordering::Acquire);
        let queued_ns = now_ns();
        let wait_started = std::time::Instant::now();
        let result = self.lock();
        let waited = wait_started.elapsed();
        if waited >= std::time::Duration::from_millis(lock_trace_threshold_ms()) {
            let holder = if holder_ptr.is_null() {
                "unknown".to_owned()
            } else {
                // SAFETY: every stored pointer came from `Location::caller()`, which is a
                // `&'static Location<'static>` — 'static, never freed, so dereferencing it here
                // is always valid. Cast const->mut only to satisfy `AtomicPtr`'s API; nothing
                // ever writes through it.
                let loc: &'static Location<'static> = unsafe { &*holder_ptr };
                let held_ms = queued_ns.saturating_sub(holder_since_ns) / 1_000_000;
                format!("{}:{} (holding for {held_ms} ms when we queued)", loc.file(), loc.line())
            };
            eprintln!("{} alcore: state lock waited {} ms at {}:{}; holder {holder}", crate::log_ts(), waited.as_millis(), site.file(), site.line());
        }
        // A poisoned lock means a thread panicked while holding CoreState. alcore's panic hook
        // (TRDD-3RVTC1HY) exits the process before unwinding, so production never reaches this
        // panic; a test binary without the hook panics here by design.
        let guard = match result {
            Ok(guard) => guard,
            Err(_) => panic!("CoreState lock poisoned"),
        };
        HOLDER_SITE.store(site as *const _ as *mut _, Ordering::Release);
        HOLDER_SINCE_NS.store(now_ns(), Ordering::Release);
        StateGuard { guard, site, since: std::time::Instant::now() }
    }
}

fn now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

/// Snapshot of who currently holds `state`'s mutex, if anyone — for a `try_lock`-failure path
/// (TRDD-N60JUWU3's bounded shutdown wait) that needs to name the holder without itself blocking
/// on `lock_timed`'s wait-then-attribute flow. Returns `(file:line, held_for_ms)`.
pub fn current_lock_holder() -> Option<(String, u64)> {
    let ptr = HOLDER_SITE.load(Ordering::Acquire);
    if ptr.is_null() {
        return None;
    }
    // SAFETY: same invariant as `lock_timed`'s read above — every stored pointer came from
    // `Location::caller()`, a `&'static Location<'static>`, so dereferencing it is always valid.
    let loc: &'static Location<'static> = unsafe { &*ptr };
    let since_ns = HOLDER_SINCE_NS.load(Ordering::Acquire);
    let held_ms = now_ns().saturating_sub(since_ns) / 1_000_000;
    Some((format!("{}:{}", loc.file(), loc.line()), held_ms))
}

#[cfg(test)]
mod body_links_tests {
    use super::*;

    #[test]
    fn body_link_rows_carry_both_sides_and_no_identity_fields() {
        // TRDD-N6A8VX3G: two BodyPointers (request + response) sharing a span_id — both link rows
        // land in the DeltaLog with the right keys, and no device_id/account_uuid field anywhere
        // (they are on the wire in metadata.user_id; the no-identities doctrine keeps them out of
        // every persisted row).
        let dir = std::env::temp_dir().join(format!("agentlens-body-links-test-{}", now_ns()));
        let mut log = delta_log::DeltaLog::new(&dir, "body-links");
        let req = agentlens_ingest::BodyPointer {
            session_id: "sess-test-1".to_owned(),
            kind: "request",
            body_ref: Some("req-body-file".to_owned()),
            inline_body: None,
            request_id: None,
            span_id: Some("span-42".to_owned()),
            model: None,
            query_source: None,
            request_body_id: Some("rbid-7".to_owned()),
            message_id: None,
            message_uuid: None,
            ts: 1_000,
        };
        let resp = agentlens_ingest::BodyPointer {
            session_id: "sess-test-1".to_owned(),
            kind: "response",
            body_ref: Some("resp-body-file".to_owned()),
            inline_body: None,
            request_id: Some("req-9".to_owned()),
            span_id: Some("span-42".to_owned()),
            model: None,
            query_source: None,
            request_body_id: Some("rbid-7".to_owned()),
            message_id: Some("msg-3".to_owned()),
            message_uuid: None,
            ts: 1_500,
        };
        let mut records = IndexMap::new();
        for p in [&req, &resp] {
            let (k, v) = body_link_row(p);
            records.insert(k, v);
        }
        let saved = log.append_changed(&records).expect("append");
        assert_eq!(saved.appended, 2, "both rows appended");
        // Reload from disk — the durable state is what GVA8TTJF's join reads.
        let mut reloaded = delta_log::DeltaLog::new(&dir, "body-links");
        let map = reloaded.load().expect("load");
        assert_eq!(map.len(), 2);
        let req_row = map.get(&body_link_row(&req).0).expect("request row key");
        let resp_row = map.get(&body_link_row(&resp).0).expect("response row key");
        assert_eq!(req_row["session_id"], "sess-test-1");
        assert_eq!(req_row["stem"], "req-body-file");
        assert_eq!(req_row["request_body_id"], "rbid-7");
        assert_eq!(resp_row["request_body_id"], "rbid-7", "the exact pairing key on both sides");
        assert_eq!(resp_row["message_id"], "msg-3");
        assert_eq!(resp_row["ts_ms"], 1_500);
        for row in [req_row, resp_row] {
            let obj = row.as_object().expect("row is an object");
            assert!(obj.get("device_id").is_none(), "no device_id (no-identities doctrine)");
            assert!(obj.get("account_uuid").is_none(), "no account_uuid (no-identities doctrine)");
            assert_eq!(obj.len(), 8, "exactly the spec'd row shape");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn spanless_pointer(body_ref: &str) -> agentlens_ingest::BodyPointer {
        agentlens_ingest::BodyPointer {
            session_id: "sess-test-2".to_owned(),
            kind: "response",
            body_ref: Some(body_ref.to_owned()),
            inline_body: None,
            request_id: None,
            span_id: None,
            model: None,
            query_source: None,
            request_body_id: None,
            message_id: None,
            message_uuid: None,
            ts: 2_000,
        }
    }

    #[test]
    fn body_link_distinct_spanless_pointers_with_shared_ts_keep_both_rows() {
        // TRDD-N6A8VX3G D4: same kind, no span_id, same ingest ts, different body_ref — the old
        // "{span_id}:{kind}:{ts}" key collided and DeltaLog replay kept only the last row.
        let dir = std::env::temp_dir().join(format!("agentlens-body-links-collide-test-{}", now_ns()));
        let mut log = delta_log::DeltaLog::new(&dir, "body-links");
        let mut records = IndexMap::new();
        for p in [spanless_pointer("body-a"), spanless_pointer("body-b")] {
            let (k, v) = body_link_row(&p);
            records.insert(k, v);
        }
        log.append_changed(&records).expect("append");
        let mut reloaded = delta_log::DeltaLog::new(&dir, "body-links");
        let map = reloaded.load().expect("load");
        assert_eq!(map.len(), 2, "two different pointers must be two rows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn body_link_same_pointer_appended_twice_is_one_row() {
        // TRDD-N6A8VX3G D4: identical row content still collapses to a single row.
        let dir = std::env::temp_dir().join(format!("agentlens-body-links-same-test-{}", now_ns()));
        let mut log = delta_log::DeltaLog::new(&dir, "body-links");
        for _ in 0..2 {
            let (k, v) = body_link_row(&spanless_pointer("body-a"));
            let mut rec = IndexMap::new();
            rec.insert(k, v);
            log.append_changed(&rec).expect("append");
        }
        let mut reloaded = delta_log::DeltaLog::new(&dir, "body-links");
        let map = reloaded.load().expect("load");
        assert_eq!(map.len(), 1, "the same pointer is one row");
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn body_link_unit_separator_shifted_across_fields_keeps_both_rows() {
        // TRDD-N6A8VX3G D4: ids are untrusted OTLP input, so a U+001F inside one field must not
        // make two different field tuples share a key (a separator join gives "a\u{1f}b\u{1f}c" for both).
        let mut one = spanless_pointer("a\u{1f}b");
        one.request_id = Some("c".to_owned());
        let mut two = spanless_pointer("a");
        two.request_id = Some("b\u{1f}c".to_owned());
        let (k1, _) = body_link_row(&one);
        let (k2, _) = body_link_row(&two);
        assert_ne!(k1, k2, "shifting U+001F across adjacent fields must stay two rows");
    }


    #[test]
    fn ingest_parsed_logs_payload_with_two_spanless_same_kind_pointers_keeps_both_link_rows() {
        // TRDD-N6A8VX3G D4 at the real entry point: an OTLP /v1/logs payload with two
        // api_response_body events (same session, no span id, different body refs) goes through
        // process_logs and ingest_parsed; both link rows must reach the body-links DeltaLog.
        // The old "{span_id}:{kind}:{ts}" key collided here (ts is the shared ingest time).
        let dir = std::env::temp_dir().join(format!("agentlens-body-links-wire-test-{}", now_ns()));
        let mut state = CoreState::open(&dir);
        let event = |body_ref: &str| {
            serde_json::json!({
                "eventName": "api_response_body",
                "attributes": [
                    { "key": "session.id", "value": { "stringValue": "sess-wire-1" } },
                    { "key": "body_ref", "value": { "stringValue": body_ref } },
                ],
            })
        };
        let payload = serde_json::json!({
            "resourceLogs": [{ "scopeLogs": [{ "logRecords": [event("/tmp/bodies/resp_a.json"), event("/tmp/bodies/resp_b.json")] }] }],
        });
        ingest_parsed(&mut state, "logs", payload, "/v1/logs");
        let mut reloaded = delta_log::DeltaLog::new(&dir, "body-links");
        let map = reloaded.load().expect("load");
        assert_eq!(map.len(), 2, "two spanless same-kind pointers in one payload must be two rows");
        let mut stems: Vec<String> = Vec::new();
        for row in map.values() {
            assert_eq!(row["session_id"], "sess-wire-1");
            assert_eq!(row["span_id"], "");
            stems.push(row["stem"].as_str().expect("stem is a string").to_owned());
        }
        stems.sort();
        assert_eq!(stems, ["/tmp/bodies/resp_a.json", "/tmp/bodies/resp_b.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identical_reingest_costs_zero_bytes() {
        // Dedup safety: a re-ingested pointer with identical content re-appends nothing
        // (append_changed skips unchanged hashes), per the spec's dedup-safe key.
        let dir = std::env::temp_dir().join(format!("agentlens-body-links-dedup-test-{}", now_ns()));
        let mut log = delta_log::DeltaLog::new(&dir, "body-links");
        let p = agentlens_ingest::BodyPointer {
            session_id: "sess-test-1".to_owned(),
            kind: "request",
            body_ref: Some("f".to_owned()),
            inline_body: None,
            request_id: None,
            span_id: Some("s".to_owned()),
            model: None,
            query_source: None,
            request_body_id: None,
            message_id: None,
            message_uuid: None,
            ts: 5,
        };
        let (k, v) = body_link_row(&p);
        let mut rec = IndexMap::new();
        rec.insert(k, v);
        log.append_changed(&rec).expect("first append");
        let again = log.append_changed(&rec).expect("second append");
        assert_eq!(again.appended, 0, "unchanged row costs zero bytes");
        assert_eq!(again.bytes, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
#[cfg(test)]
mod lock_timed_tests {
    use super::*;

    fn fresh_state() -> CoreState {
        let dir = std::env::temp_dir().join(format!("agentlens-lock-timed-test-{}", now_ns()));
        CoreState::open(&dir)
    }

    #[test]
    fn lock_timed_guard_locks_and_releases() {
        // The holder-slot checks (HOLDER_SITE) live in tests/lock_holder_site.rs, which runs alone in its own process: this unit-test binary is parallel, so a guard on another mutex can store or clear the process-wide slot while this guard lives (TRDD-7EZE3AIZ).
        let m: Mutex<CoreState> = Mutex::new(fresh_state());
        let g = m.lock_timed();
        let _ = &*g;
        drop(g);
        // try_lock, not lock_timed: if the guard failed to release, a blocking relock on this thread would hang instead of failing.
        assert!(m.try_lock().is_ok(), "the guard should release the mutex on drop");
    }

    #[test]
    #[should_panic(expected = "CoreState lock poisoned")]
    fn poisoned_mutex_panics_in_lock_timed() {
        let m: Mutex<CoreState> = Mutex::new(fresh_state());
        {
            let wrapped = std::panic::AssertUnwindSafe(&m);
            let _ = std::panic::catch_unwind(|| {
                let _g = wrapped.0.lock().unwrap();
                panic!("poison it");
            });
        }
        // alcore's panic hook makes poisoning unobservable in production; here it must panic, not return a guard.
        let _ = m.lock_timed();
    }
}
