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
pub mod account_registry;
pub mod account_state_timeline;
pub mod body_archive;
pub mod body_writers;
pub mod burn;
pub mod cache_break;
pub mod cache_risk_commands;
pub mod call_body_registry;
pub mod collector_lifecycle;
pub mod context_composition;
pub mod context_history;
pub mod conversation;
pub mod context_composition_index;
pub mod delta_log;
pub mod derived_cache;
pub mod effort_transitions;
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
pub mod pricing;
pub mod raw_body_context;
pub mod request_log;
pub mod resident_cost;
pub mod retention_config;
pub mod runtime_inventory;
pub mod server_stats;
pub mod skill_attribution;
pub mod span_window;
pub mod spawn_rollup;
pub mod statusline_store;
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
    /// The dashboard live-reload fingerprint carried in every update frame (server.ts BUILD_ID —
    /// bundle mtimes there; here the process start, the same "changes on restart" contract).
    pub build_id: String,
    /// Log-derived session cards keyed by sessionId (server.ts `logSessions`), merged into the
    /// served summary under the feed-collision doctrine (feed_merge.rs). Fed by the log reader
    /// (log_reader.rs); `put_log_session` is the one write path and bumps data_version. An
    /// IndexMap: insertion order kept like the JS Map, O(1) upsert (a 13k-card boot would be
    /// quadratic on a Vec).
    pub log_sessions: IndexMap<String, Value>,
    /// The data dir this process owns (server.ts DATA_DIR) — the sidecar paths `/api/server-stats`
    /// measures hang off it.
    pub data_dir: std::path::PathBuf,
    /// server.ts SERVER_STARTED_AT.
    pub started_at_ms: i64,
    /// The bound listeners; alcore overwrites the defaults with what it actually bound.
    pub ports: server_stats::Ports,
    /// server.ts persistStats — every byte this process writes, counted where it is written.
    pub persist: server_stats::PersistStats,
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
        self.log_sessions.insert(id, card);
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
            if let Some(obj) = self.log_sessions.get_index_mut(i).and_then(|(_, c)| c.as_object_mut()) {
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
        Self::summary_over(&self.window, &self.log_sessions, now_ms).0
    }

    /// Returns the merged summary AND `otelAttributionBySession` (server.ts:2245) — the OTEL
    /// api_request entries per claude_code session, captured off the PRE-merge sessions so the
    /// `/api/timeline` graft still has them after the merge displaces the OTEL twin.
    fn summary_over(window: &span_window::SpanWindow, log_sessions: &IndexMap<String, Value>, now_ms: f64) -> (Value, IndexMap<String, Vec<Value>>) {
        let _ = now_ms;
        let mut summary = summarize::summarizer::summarize_spans(&window.spans, &|_| None);
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
            let logs: Vec<Value> = log_sessions.iter().map(|(_, c)| c.clone()).collect();
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
    pub fn build_session_summary(&mut self, now_ms: f64) -> std::sync::Arc<Value> {
        // Disjoint field borrows: the cache + side-map are written, the inputs are read.
        let Self { summary_cache, window, log_sessions, data_version, otel_attribution, .. } = self;
        summary_cache.get(*data_version, || {
            let (summary, attribution) = Self::summary_over(window, log_sessions, now_ms);
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
        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
        drop(summary);
        let events = burn::monitor::gather_consumption_events(&sessions, &[], now_ms);
        let ttl = self.burn.ttl_context(now_ms);
        burn::monitor::compute_burn_status(&events, &sessions, &self.burn.config, now_ms, Some(&ttl))
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
        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
        drop(summary);
        let events = burn::monitor::gather_consumption_events(&sessions, &[], now_ms);
        let ttl = self.burn.ttl_context(now_ms);
        burn::monitor::compute_session_status(&sessions, &events, &self.burn.config, session_id, workspace, now_ms, Some(&ttl))
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
            build_id: now.to_string(),
            log_sessions: IndexMap::new(),
            data_dir: data_dir.to_path_buf(),
            started_at_ms: now,
            ports: server_stats::Ports::default(),
            persist: server_stats::PersistStats::default(),
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

    /// The flush tick's prune (server.ts flushSpanAppends): the window shrank ⇒ every derived
    /// view must be rebuilt.
    pub fn prune_window(&mut self, now_ms: i64) {
        if self.window.prune(now_ms) {
            self.data_version += 1;
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
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One POST body through the transforms into the store. Never fails toward the wire — the
/// frozen contract answers 200 whatever happens; failures are counted, not surfaced.
pub fn ingest_post(state: &mut CoreState, path: &str, body: &[u8]) {
    let Ok(text) = std::str::from_utf8(body) else {
        state.counters.parse_errors += 1;
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(text) else {
        // Counted like the TS collector's otlpIngestError fallback (a protobuf export lands
        // here) — and still 200 on the wire.
        state.counters.parse_errors += 1;
        return;
    };
    let now = now_ms();
    let kind = match path {
        "/v1/traces" => "traces",
        "/v1/logs" => "logs",
        "/v1/metrics" => "metrics",
        _ => classify(&payload),
    };
    let spans: Vec<Value> = match kind {
        "traces" => {
            state.counters.traces_payloads += 1;
            state.ingest.process_traces(&payload, path)
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
    }
    for span in spans {
        state.window.add(span, now);
    }
    if state.writer.pending_appends() > 0 {
        // Flush per payload for now: durable and deterministic for tests; batching cadence is
        // internal (not wire-frozen) and can move to a timer when rates justify it.
        state.flush_spans();
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

    {
        let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
        ingest_post(&mut st, &path, &buf);
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
