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
pub mod body_archive;
pub mod body_writers;
pub mod burn;
pub mod burn_calibration;
pub mod cache_break;
pub mod cache_break_timeline;
pub mod cache_creation_forensics;
pub mod cache_event_log;
pub mod heartbeat_cost;
pub mod session_burn_profile;
pub mod cache_risk_commands;
pub mod chores;
pub mod call_body_registry;
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
pub mod runtime_inventory;
pub mod server_stats;
pub mod skill_attribution;
pub mod span_window;
pub mod spawn_rollup;
pub mod spool_backpressure;
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
    pub spans_appended: u64,
}

/// A copy of everything a summary rebuild reads, taken under the state lock so the rebuild can
/// run outside it (TRDD-HFV4AIT7). Both fields hold `Arc`s, so building one is a pointer copy per
/// span/card — never a deep clone of the window.
pub struct SummaryInputs {
    pub version: u64,
    pub spans: Vec<Arc<Value>>,
    pub log_sessions: IndexMap<String, Arc<Value>>,
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
    /// The dashboard live-reload fingerprint carried in every update frame (server.ts BUILD_ID —
    /// bundle mtimes there; here the process start, the same "changes on restart" contract).
    pub build_id: String,
    /// Where the dashboard's built assets live (server.ts `mediaDir`): `index.html` + the bundles
    /// served by `GET /` and the static route (TRDD-VHH7FXGC). Set by the binary from
    /// `--media-dir`; `None` (tests that never touch the UI) keeps those routes at the 404 fallback.
    pub media_dir: Option<std::path::PathBuf>,
    /// Log-derived session cards keyed by sessionId (server.ts `logSessions`), merged into the
    /// served summary under the feed-collision doctrine (feed_merge.rs). Fed by the log reader
    /// (log_reader.rs); `put_log_session` is the one write path and bumps data_version. An
    /// IndexMap: insertion order kept like the JS Map, O(1) upsert (a 13k-card boot would be
    /// quadratic on a Vec). `Arc` per card for the same reason the window holds `Arc`s
    /// (TRDD-HFV4AIT7): `summary_snapshot` has to copy this map under the lock so the rebuild can
    /// run outside it, and a deep clone of 13k cards there would be the stall it removes.
    pub log_sessions: IndexMap<String, Arc<Value>>,
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
}

impl CoreState {
    /// putLogSession — upsert by sessionId.
    pub fn put_log_session(&mut self, card: Value) {
        let id = card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        self.log_sessions.insert(id, Arc::new(card));
        self.data_version += 1;
    }

    /// demoteColdTimelines (server.ts, TRDD-66IXMIGN fifth repro): per-card bounds are not
    /// sufficient on a ~13k-session machine — only the `hot_cards` most-recently-active cards
    /// keep their timelines in RAM; every colder card keeps headers only.
    pub fn demote_cold_timelines(&mut self, hot_cards: usize) {
        if self.log_sessions.len() <= hot_cards {
            return;
        }
        let mut order: Vec<(f64, usize)> =
            self.log_sessions.values().enumerate().map(|(i, c)| (log_reader::last_active_ms(c), i)).collect();
        // Newest first; a stable sort keeps insertion order among ties, as the JS sort does.
        order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, i) in order.into_iter().skip(hot_cards) {
            // `Arc::make_mut` — copy-on-write, so a card a rebuild in flight is still reading is
            // cloned before it is stripped instead of being mutated underneath it. The clone hits
            // only the cards actually demoted (the tail past `hot_cards`), and only while a
            // snapshot still holds them.
            if let Some(obj) = self.log_sessions.get_index_mut(i).and_then(|(_, c)| Arc::make_mut(c).as_object_mut()) {
                log_reader::strip_timeline_value(obj);
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
        Self::summary_over(&self.window.spans, &self.log_sessions, &self.accounts.snapshot(), now_ms).0
    }

    /// The inputs of one summary rebuild, copied under the state lock so the rebuild itself runs
    /// OUTSIDE it (TRDD-HFV4AIT7). Both containers hold `Arc`s, so this is a pointer copy per
    /// element, not a deep clone of the window.
    pub fn summary_snapshot(&self) -> SummaryInputs {
        SummaryInputs {
            version: self.data_version,
            spans: self.window.spans.clone(),
            log_sessions: self.log_sessions.clone(),
            accounts: Arc::new(self.accounts.snapshot()),
        }
    }

    /// The off-lock half: `summary_over` on a snapshot. Free function shape on purpose — it takes
    /// no `&self`, so it cannot accidentally be called while the lock is held.
    pub fn summary_from(inputs: &SummaryInputs, now_ms: f64) -> (Value, IndexMap<String, Vec<Value>>) {
        Self::summary_over(&inputs.spans, &inputs.log_sessions, &inputs.accounts, now_ms)
    }

    /// Store a summary built off the lock, together with the attribution map built WITH it. The
    /// two must move as one — the `/api/timeline` graft reads the map for the cards the summary
    /// serves — so the map is replaced only when the summary actually lands (a rebuild that lost
    /// the race is discarded whole).
    pub fn store_summary(&mut self, version: u64, summary: Value, attribution: IndexMap<String, Vec<Value>>) -> std::sync::Arc<Value> {
        let will_store = self.summary_cache.is_empty() || version > self.summary_cache.version();
        let stored = self.summary_cache.store_if_newer(version, summary);
        if will_store {
            self.otel_attribution = attribution;
        }
        stored
    }

    /// Returns the merged summary AND `otelAttributionBySession` (server.ts:2245) — the OTEL
    /// api_request entries per claude_code session, captured off the PRE-merge sessions so the
    /// `/api/timeline` graft still has them after the merge displaces the OTEL twin.
    fn summary_over(
        spans: &[Arc<Value>],
        log_sessions: &IndexMap<String, Arc<Value>>,
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
        if !log_sessions.is_empty() {
            let otel: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
            // The merge REWRITES the cards it keeps, so this deep clone stays — but it now runs
            // off the state lock (ui::summary_now), which is what made it affordable.
            let logs: Vec<Value> = log_sessions.values().map(|c| (**c).clone()).collect();
            let mut merged = feed_merge::link_subagent_transcripts(feed_merge::merge_otel_and_log_sessions(otel, logs));
            // Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'), newest first.
            merged.sort_by(|a, b| {
                let k = |c: &Value| {
                    let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
                    if st.is_empty() { -62_167_219_200_000.0 } else { summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
                };
                k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
            });
            summary.as_object_mut().expect("summary object").insert("sessions".into(), Value::Array(merged));
        }
        (summary, attribution)
    }

    /// buildSessionSummary — the merged summary, rebuilt only when data_version moved. The
    /// attribution side-map is replaced in the same compute (the TS rebuilds the module-level
    /// Map inside the memoized computeSessionSummary), so map and summary always share a version.
    ///
    /// **This rebuilds INLINE, under whatever lock the caller holds.** Every server path that can
    /// run while ingest is hot goes through `ui::summary_now` instead, which does the same work
    /// off the lock and leaves this a pointer clone (TRDD-HFV4AIT7). It stays inline for callers
    /// that own the state outright — tests, the CLI/MCP surfaces, and the cold-boot first build.
    pub fn build_session_summary(&mut self, now_ms: f64) -> std::sync::Arc<Value> {
        // Disjoint field borrows: the cache + side-map are written, the inputs are read.
        // `accounts` joins the disjoint-borrow list for the same reason as the rest: it is READ
        // here while the cache + side-map are written (TRDD-465EXTJ6).
        let Self { summary_cache, window, log_sessions, data_version, otel_attribution, accounts, .. } = self;
        let accounts = accounts.snapshot();
        summary_cache.get(*data_version, || {
            let (summary, attribution) = Self::summary_over(&window.spans, log_sessions, &accounts, now_ms);
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

    /// The same computation against a summary the caller already has — what the 4 s burn tick
    /// uses, so the tick's summary REBUILD happens off the state lock (ui::summary_now) and only
    /// this comparatively cheap gather/compute runs under it (TRDD-HFV4AIT7).
    ///
    /// The sessions are BORROWED out of the summary rather than deep-cloned into a `Vec<Value>`:
    /// the old clone copied every card, with its timeline, on every 4 s fire while holding the
    /// lock ingest needs.
    pub fn burn_status_over(&mut self, summary: &Value, now_ms: f64) -> Value {
        let sessions = summary.get("sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let events = burn::monitor::gather_consumption_events(sessions, &[], now_ms);
        let ttl = self.burn.ttl_context(now_ms);
        burn::monitor::compute_burn_status(&events, sessions, &self.burn.config, now_ms, Some(&ttl))
    }

    /// `compositionProjectResolver` (server.ts:1462) — sessionId → `projectPath ?? workspace ??
    /// 'unknown'`, built from the live summary.
    ///
    /// Not optional decoration: it is what fills the `project` field of every composition and what
    /// a `scope` string is matched against in `resolve_scope`. Without it every composition reads
    /// `project: "unknown"` and a project-scoped query matches NOTHING while still answering 200 —
    /// the row-36 route omitted it until P4x.2c and had exactly that divergence from the TS.
    pub fn composition_project_map(&mut self, now_ms: f64) -> std::collections::HashMap<String, String> {
        let summary = self.build_session_summary(now_ms);
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

    /// `getSessionStatus` (server.ts:1573) — the same gatherBurn stream as `live_burn_status`,
    /// answered for ONE resolved session instead of the whole machine. Split out rather than
    /// folded into `live_burn_status` because the two return different shapes from the same
    /// inputs, and `compute_session_status` needs the SESSION CARDS as well as the events (it
    /// compares the caller's session to its predecessors in the same workspace).
    pub fn live_session_status(&mut self, session_id: Option<&str>, workspace: Option<&str>, now_ms: f64) -> Value {
        let summary = self.build_session_summary(now_ms);
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
    pub fn burn_risk_report(&mut self, now_ms: f64, fanout_threshold: Option<f64>, spike_tokens_per_min: Option<f64>) -> Value {
        if self.burn.last_status.is_none() {
            let s = self.live_burn_status(now_ms);
            self.burn.last_status = Some(s);
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

impl CoreState {
    /// Open the store under `<data_dir>/spans` and load the summary window from it — the TS boot
    /// load (server.ts:422): only the segments overlapping the window, nothing evicted.
    pub fn open(data_dir: &std::path::Path) -> CoreState {
        let now = now_ms();
        let mut writer = SpanStoreWriter::open(&data_dir.join("spans"));
        let mut window = span_window::SpanWindow::new(span_window::summary_window_ms(data_dir));
        window.boot_load(&mut writer, now);
        CoreState {
            ingest: IngestState::default(),
            writer,
            counters: Counters::default(),
            window,
            data_version: 0,
            last_ingest_activity_ms: 0,
            build_id: now.to_string(),
            media_dir: None,
            log_sessions: IndexMap::new(),
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
            accounts: account_registry::AccountRegistry::default(),
            bodies: call_body_registry::CallBodyRegistry::default(),
            composition: context_composition_index::ContextCompositionIndex::default(),
            requests: request_log::RequestLog::new(Some(data_dir.join("requests.log"))),
            otel_attribution: IndexMap::new(),
            lifecycle: collector_lifecycle::record_start(&collector_lifecycle::lifecycle_file(data_dir), now),
            log_env: agentlens_logscan::discovery::Env::from_process(),
            latest_resident_blobs: Vec::new(),
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
        }
    }

    /// `/action {type:"clearAll"}` — the spans go (window + the whole on-disk store), the log
    /// cards stay. Bumps data_version so the next push carries the cleared state.
    pub fn clear_spans(&mut self) {
        self.window.spans.clear();
        self.writer.clear();
        self.data_version += 1;
    }

    /// `POST /api/clear` — spans AND log cards AND the tail offsets go; the sweeper then re-reads
    /// every file from 0 (a targeted scan would only see the paths the watcher happened to name).
    pub fn clear_all(&mut self) {
        self.clear_spans();
        self.log_sessions.clear();
        if let Some(s) = &self.sweeper {
            s.clear_and_rescan();
        }
    }

/// RSS budget for the summarization window, in bytes. `AGENTLENS_RSS_BUDGET_MB` overrides;
/// default 4096 MB.
///
/// Chosen against measurement, not taste: the TS server sat at ~1.5 GB on this machine's real
/// corpus, and an alcore flood reached 10.25 GB before wedging. 4 GB leaves generous headroom over
/// normal operation while cutting in well before the window can take the process down. A budget
/// this guard never reaches would be decoration.
pub fn rss_budget_bytes() -> u64 {
    std::env::var("AGENTLENS_RSS_BUDGET_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(4096)
        * 1024
        * 1024
}

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
        let narrowed = self
            .window
            .apply_memory_pressure(crate::server_stats::rss_bytes(), Self::rss_budget_bytes());
        if narrowed {
            // Said out loud: a silently shrinking window looks identical to "no traffic", and the
            // whole point of porting this guard is that the cut is visible. `windowMs` in
            // /api/server-stats carries the current value.
            println!(
                "alcore: memory pressure — summarization window now {}ms (configured {}ms)",
                self.window.effective_ms, self.window.configured_ms
            );
        }
        if self.window.prune(now_ms) || narrowed {
            self.data_version += 1;
        }
        // Only when it is long enough to be someone else's latency. A per-tick line would be noise
        // on an idle server and would itself cost more than the pass it reports.
        let held = began.elapsed();
        if held >= std::time::Duration::from_millis(250) {
            println!(
                "alcore: prune_window held the state lock for {} ms ({} spans, window {}ms{})",
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
            Ok(bytes) => {
                self.persist.log_event_writes += 1;
                self.persist.log_event_bytes += bytes;
            }
            Err(e) => {
                let msg = e.to_string();
                if self.log_sink_warned.insert(msg.clone()) {
                    eprintln!("[AgentLens] log-event sink append FAILED (event lost — disk problem?): {msg}");
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
            "ingest-profile: n={} parse={:.1}ms/req wait_for_lock={:.1}ms/req held_lock={:.1}ms/req | totals parse={:.0}ms wait={:.0}ms held={:.0}ms",
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

pub fn ingest_parsed(state: &mut CoreState, kind: &'static str, payload: Value, path: &str) {
    let now = now_ms();
    let spans: Vec<Value> = match kind {
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
    for span in &spans {
        state.writer.append(span, now);
        state.counters.spans_appended += 1;
    }
    if !spans.is_empty() {
        state.data_version += 1;
        // server.ts:2161 `if (count > 0) lastIngestActivityAt = Date.now()` — spans arriving mean
        // sessions are active. Same condition deliberately: a payload that parsed but yielded no
        // spans is NOT capture activity, and counting it would make a feed that is connected but
        // producing nothing look alive, which is the one thing this clock exists to detect.
        state.last_ingest_activity_ms = now;
    }
    for span in spans {
        state.window.add(span, now);
    }
}

async fn handle(
    req: Request<Incoming>,
    state: Arc<Mutex<CoreState>>,
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
    let t_wait = profile.then(std::time::Instant::now);
    {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let state = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone()));
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
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
use std::sync::{LockResult, MutexGuard, PoisonError};

static HOLDER_SITE: AtomicPtr<Location<'static>> = AtomicPtr::new(std::ptr::null_mut());
static HOLDER_SINCE_NS: AtomicU64 = AtomicU64::new(0);

fn lock_trace_threshold_ms() -> u64 {
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
        // Clear the holder record ONLY if it's still us — a poisoned-then-recovered guard built
        // via `into_inner()` (see LockTimed::lock_timed below) never set the record, and clearing
        // it unconditionally there would erase whoever's actually still holding it.
        let ptr = self.site as *const Location<'static> as *mut Location<'static>;
        let _ = HOLDER_SITE.compare_exchange(ptr, std::ptr::null_mut(), Ordering::AcqRel, Ordering::Relaxed);
        if held >= std::time::Duration::from_millis(lock_trace_threshold_ms()) {
            eprintln!("alcore: state lock held {} ms by {}:{}", held.as_millis(), self.site.file(), self.site.line());
        }
    }
}

/// `state.lock()` that attributes a long WAIT to whoever is currently holding it, and records
/// itself as the new holder for the next waiter. Drop-in replacement for `Mutex::lock()`.
pub trait LockTimed {
    fn lock_timed(&self) -> LockResult<StateGuard<'_>>;
}

impl LockTimed for Mutex<CoreState> {
    #[track_caller]
    fn lock_timed(&self) -> LockResult<StateGuard<'_>> {
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
            eprintln!("alcore: state lock waited {} ms at {}:{}; holder {holder}", waited.as_millis(), site.file(), site.line());
        }
        match result {
            Ok(guard) => {
                HOLDER_SITE.store(site as *const _ as *mut _, Ordering::Release);
                HOLDER_SINCE_NS.store(now_ns(), Ordering::Release);
                Ok(StateGuard { guard, site, since: std::time::Instant::now() })
            }
            Err(poisoned) => {
                // Poisoned: still hand back a usable guard (matches every existing call site's
                // recovery pattern — `unwrap_or_else(|e| e.into_inner())` etc.) but do NOT claim
                // the holder record, since this guard never went through the "we're now holding
                // it" path above.
                let guard = poisoned.into_inner();
                Err(PoisonError::new(StateGuard { guard, site, since: std::time::Instant::now() }))
            }
        }
    }
}

fn now_ns() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
}

#[cfg(test)]
mod lock_timed_tests {
    use super::*;

    fn fresh_state() -> CoreState {
        let dir = std::env::temp_dir().join(format!("agentlens-lock-timed-test-{}", now_ns()));
        CoreState::open(&dir)
    }

    #[test]
    fn records_and_clears_the_holder() {
        let m: Mutex<CoreState> = Mutex::new(fresh_state());
        let line_of_lock;
        {
            let _g = m.lock_timed().unwrap();
            line_of_lock = line!() - 1;
            let ptr = HOLDER_SITE.load(Ordering::Acquire);
            assert!(!ptr.is_null(), "holder should be recorded while the guard is alive");
            let loc: &'static Location<'static> = unsafe { &*ptr };
            assert!(loc.file().ends_with("lib.rs"));
            assert_eq!(loc.line(), line_of_lock);
        }
        assert!(HOLDER_SITE.load(Ordering::Acquire).is_null(), "holder should clear on drop");
    }

    #[test]
    fn poisoned_mutex_still_yields_a_usable_guard() {
        let m: Mutex<CoreState> = Mutex::new(fresh_state());
        {
            let wrapped = std::panic::AssertUnwindSafe(&m);
            let _ = std::panic::catch_unwind(|| {
                let _g = wrapped.0.lock().unwrap();
                panic!("poison it");
            });
        }
        match m.lock_timed() {
            Ok(_) => panic!("expected poisoned"),
            Err(poisoned) => {
                let guard = poisoned.into_inner();
                // Just needs to deref to a CoreState without panicking.
                let _ = guard.data_version;
            }
        };
    }
}
