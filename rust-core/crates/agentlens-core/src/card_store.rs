//! TRDD-XTFDRTH2 — the log-derived session cards, in a DuckDB table instead of a resident
//! `IndexMap<String, Arc<Value>>`.
//!
//! USER architecture ruling (TRDD-7YPQWKPG, 2026-09-02): *"duckdb is your memory! the rust code
//! should only make queries and report the ephemeral answers"*. The map this replaces held 32,607
//! cards as `serde_json::Value` trees — a shape whose in-RAM cost is several times its own JSON
//! text (a `Map` node plus an owned `String` per key, per card) — and it was measured as one of
//! the three contributors to the 8.7 GB mimalloc heap. Here the corpus is JSON TEXT in one
//! long-lived DuckDB connection; a reader gets a `Vec` it drops when it is done.
//!
//! ## TRDD-TOIM26HP — the database is a FILE under the data dir, and it is REPLACED at every boot
//!
//! XTFDRTH2 landed this table in `Connection::open_in_memory()`, so the corpus was still 100%
//! resident: the win was the SHAPE of the bytes, not their residency. `<data_dir>/cards.duckdb`
//! hands the residency decision to DuckDB's buffer pool, and [`MEMORY_LIMIT`] is what makes that
//! decision bounded instead of "whatever DuckDB feels like".
//!
//! It is a SPILL file, not a durable store — `open` deletes the previous boot's database before
//! opening, and drops the table if the delete could not happen. Two reasons, and the first is a
//! correctness one:
//!
//! 1. `DurableState::restore` (log_reader.rs) treats a stale `LOG_INGEST_VERSION` as "restore
//!    nothing, cold-rescan", and it does NOT clear the card store — it never had to, because a
//!    fresh `CoreState` always had an empty one. A database that outlived the process would keep
//!    serving cards built under the OLD ingest semantics, and the version stamp — the ONLY
//!    mechanism that exists to invalidate them — would silently stop working.
//! 2. A `CoreState` is not a singleton in tests: `tests/log_reader_parity.rs` opens four of them
//!    over one data dir, with the earlier ones still alive. Deleting the file first gives each one
//!    its own inode instead of four live writers on one database.
//!
//! Because every boot starts empty, the delta-log replay is unchanged and its idempotency question
//! does not arise (it is upsert-idempotent regardless — `ON CONFLICT DO UPDATE`). Reusing a
//! previous boot's corpus would remove the replay entirely, but it must first wire that version
//! gate into this constructor; that is a follow-up, not a change this module can make alone.
//!
//! ## What `IndexMap` used to provide for free, and now has to be built
//!
//! Three behaviours were load-bearing on the wire and are re-created explicitly, each with its own
//! test in `tests/card_store.rs`:
//!
//! 1. **First-insert iteration order** (`seq`). `summary_over` hands the merged card list to a
//!    STABLE sort by `startTime`, so cards sharing a `startTime` are served in the order they were
//!    first inserted. A table has no inherent order, so every read is `ORDER BY seq`.
//! 2. **An upsert keeps its slot.** `IndexMap::insert` on an existing key does not move it;
//!    `ON CONFLICT DO UPDATE` leaves `seq` alone for the same reason. (A `DELETE`+`INSERT` would
//!    silently re-order the tie group.)
//! 3. **Ties in the demotion order fall back to insertion order.** The Rust original sorted
//!    `values().enumerate()` with `sort_by`, which is STABLE — hence
//!    `ORDER BY last_active_ms DESC, seq ASC`.
//!
//! ## Fail-fast
//!
//! Every statement here runs against a process-local database with a fixed schema and
//! bound parameters: a failure is a bug or an OOM, never a recoverable condition, and the callers
//! (`put_log_session`, `demote_cold_timelines`) have no error channel to report one through. So
//! this module panics with the offending SQL rather than swallowing a card, which would lose
//! telemetry silently — the failure mode this project treats as worse than a crash.

use std::path::Path;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::Value;

use agentlens_store::duckdb::{Connection, OptionalExt};

/// The card database's name under the data dir. Public because it is an on-disk artifact the ops
/// docs and the tests both name, and one constant is what keeps those two from drifting.
pub const CARD_DB_FILE: &str = "cards.duckdb";

/// The buffer pool's ceiling. This is the whole point of the file: the corpus lives on disk and
/// DuckDB keeps at most this much of it resident.
///
/// WATCH THE SORT. `cards_json` is `ORDER BY seq` over the whole table and runs on every summary
/// rebuild, and the sort carries the card TEXT as its payload — so a corpus larger than this limit
/// spills to `<data_dir>/cards.duckdb.tmp` on every rebuild (latency on the hot path, plus device
/// writes). If `du -sh` on the file ever passes this number, raise it here — `statusline_store.rs`
/// already runs its connection at 2GB.
///
/// `MiB`, not `MB`: DuckDB takes `MB` as 10^6 and then REPORTS the setting back in MiB, so a
/// `'256MB'` limit reads as `244.1 MiB` — a number that matches nothing anyone wrote down. Binary
/// units keep the constant, the setting, and `current_setting('memory_limit')` all saying 256.
const MEMORY_LIMIT: &str = "256MiB";

/// The one table. `card` is JSON TEXT, not DuckDB's `JSON` type: the served bytes must be
/// byte-identical to what the TS server produced, and a `JSON` column normalizes (it re-emits the
/// document from a parsed form, which can reorder keys and reformat numbers). VARCHAR round-trips
/// the exact string serde_json wrote, and `preserve_order` + `float_roundtrip` make the reverse
/// parse exact too.
const SCHEMA: &str = "CREATE TABLE cards (
    session_id VARCHAR PRIMARY KEY,
    seq BIGINT NOT NULL,
    last_active_ms DOUBLE NOT NULL,
    timeline_len BIGINT NOT NULL,
    parent_session_id VARCHAR,
    source VARCHAR,
    card VARCHAR NOT NULL
);
CREATE INDEX idx_cards_active ON cards (last_active_ms DESC, seq ASC);
CREATE INDEX idx_cards_parent ON cards (parent_session_id)";


/// One keyset page of ROOT cards (TRDD-9VX3WTGU Phase C, Amendment 1).
///
/// POINT-IN-TIME PER REQUEST: each page is its own query, not a snapshot. An upsert moves a card's
/// `last_active_ms` (it keeps `seq`), so a walk interleaved with ingest never repeats a card whose
/// activity only moves forward (it jumps ahead of the cursor, which only advances backward in
/// time) — but it can MISS a not-yet-delivered card that was just touched, and it can repeat one
/// whose `last_active_ms` DECREASES between two pages (a re-parse of a shorter transcript).
/// Consumers key cards by `sessionId`; a refresh restarts the walk.
pub struct CardPage {
    pub sessions: Vec<Value>,
    /// `(last_active_ms, seq)` of the last card in `sessions`; `Some` only when `has_more`.
    pub next_cursor: Option<(f64, i64)>,
    pub has_more: bool,
    /// Count of ALL root cards (not of this page) — what the whole listing would hold.
    pub total: i64,
}

pub struct CardStore {
    conn: Connection,
    /// The next first-insert ordinal. Handed out on every `put` — including an upsert, whose
    /// number is simply skipped. Gaps are irrelevant: only the ORDER of the values is read, and
    /// not reusing a number is what keeps an upsert from stealing a later card's position.
    next_seq: i64,
    /// TRDD-ORGJ0E3G follow-up — counts calls to `persist_records()`, the whole-store
    /// `SELECT * FROM cards` + JSON-parse-every-card scan. Exists only so a test can assert a
    /// bounded-cost caller (like `run_1h_backfill_step`) does NOT trigger it — a regression back
    /// to the old `save_cards` full-store persist path would show up as this counter growing once
    /// per backfill chunk instead of staying flat.
    full_scan_calls: std::sync::atomic::AtomicUsize,
    /// TRDD-9VX3WTGU Phase C — the RESIDENT PARSED layer: the same corpus as the table, as shared
    /// `Arc<Value>` trees in first-insert order (an `IndexMap` upsert keeps its slot, exactly like
    /// `ON CONFLICT DO UPDATE` keeps `seq`). The summary rebuild used to copy ~69 MB of card text
    /// out of DuckDB and re-parse every card on EVERY pass (25 ms cadence under ingest) — the
    /// dominant allocation-churn former; a snapshot is now one refcount bump per card.
    ///
    /// It lives HERE, not in `CoreState`, so it cannot drift from the table: every write path
    /// (`put`, `clear`, `demote_cold`) updates both inside the same method, including the callers
    /// that reach the store directly (tests call `st.cards.clear()`).
    parsed: IndexMap<String, Arc<Value>>,
}

impl CardStore {
    /// Open `<data_dir>/cards.duckdb`, EMPTY. See the module header for why a previous boot's
    /// corpus is never reused.
    ///
    /// No `Default`: a card store without a data dir is not a thing, and the impl only ever
    /// existed to satisfy clippy's `new_without_default`, which does not apply to a constructor
    /// that takes an argument.
    pub fn open(data_dir: &Path) -> CardStore {
        std::fs::create_dir_all(data_dir).expect("create the data dir for the card store");
        let path = data_dir.join(CARD_DB_FILE);
        // Best-effort: a missing file is the NORMAL case (first boot), so this cannot be an
        // `expect`. The `DROP TABLE IF EXISTS` below is what actually guarantees an empty corpus —
        // deleting the file is how each store gets its OWN inode, which is what keeps two live
        // stores over one data dir from sharing a database (and a WAL).
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(data_dir.join(format!("{CARD_DB_FILE}.wal")));
        let conn =
            Connection::open(&path).unwrap_or_else(|e| panic!("open the card store at {}: {e}", path.display()));
        // `threads=2` matches statusline_store's connection: these are point queries and a
        // 32k-row sort, not an analytical scan, and a per-connection thread pool sized to the
        // machine would be pure overhead in a process that already runs its own executor.
        //
        // NOT `SET temp_directory=''` (which the Parquet stores use to make an over-limit query
        // FAIL rather than spill): here a spill is the intended behaviour of a bounded buffer
        // pool, and failing the summary rebuild instead would lose the whole corpus from the wire.
        conn.execute_batch(&format!(
            "SET memory_limit='{MEMORY_LIMIT}'; SET threads=2; DROP TABLE IF EXISTS cards; {SCHEMA};"
        ))
        .expect("create the card store schema");
        CardStore {
            conn,
            next_seq: 0,
            full_scan_calls: std::sync::atomic::AtomicUsize::new(0),
            parsed: IndexMap::new(),
        }
    }

    /// TRDD-ORGJ0E3G follow-up — how many times `persist_records()` (the whole-store scan) has
    /// run. Test-only signal; see the field doc above.
    pub fn full_scan_calls(&self) -> usize {
        self.full_scan_calls.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Wrap a bulk-insert caller in one transaction. `put` itself stays autocommit — the
    /// incremental ingest path (one card at a time, as logs tail in) is unaffected — but the boot
    /// restore replays ~32k cards through `put` in a loop, and DuckDB commits each autocommit
    /// statement individually. One explicit transaction around the whole restore is the
    /// DuckDB-idiomatic bulk-load path; call `commit` once every card has been `put`.
    pub fn begin(&self) {
        self.conn.execute_batch("BEGIN TRANSACTION").expect("begin a card store transaction");
    }

    pub fn commit(&self) {
        self.conn.execute_batch("COMMIT").expect("commit a card store transaction");
    }

    /// putLogSession's storage half — upsert by sessionId.
    ///
    /// The key is `unwrap_or("")`, exactly as the `IndexMap` version was: a card with no
    /// `sessionId` has always occupied the one `""` slot rather than accumulating rows.
    pub fn put(&mut self, card: &Value) {
        self.put_arc(Arc::new(card.clone()));
    }

    /// `put`, taking the card already shared: the one write path, so the table row and the
    /// resident parsed layer are updated together. `CoreState::put_log_session` owns its card and
    /// wraps it here with no extra clone.
    ///
    /// `parent_session_id` / `source` are the query KEYS the pagination and stats endpoints read
    /// (TRDD-9VX3WTGU Phase C): extracted once at write time so no read ever needs `json_extract`
    /// over the card text. An empty or absent `parentSessionId` is NULL — a root — matching
    /// `link_subagent_transcripts`, which treats the empty string as "no parent". Non-Claude
    /// sources (codex / opencode / copilot) set no parent, so they land as roots.
    pub fn put_arc(&mut self, card: Arc<Value>) {
        let id = card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        let last_active = crate::log_reader::last_active_ms(&card);
        let timeline_len = card.get("timeline").and_then(Value::as_array).map_or(0, Vec::len) as i64;
        let parent = card.get("parentSessionId").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned);
        let source = card.get("source").and_then(Value::as_str).map(str::to_owned);
        let json = serde_json::to_string(&*card).expect("a session card is serializable");
        // WHY the indexed columns are in DO UPDATE too: an upsert moves `last_active_ms` (and, in
        // principle, the parent), and the page query orders and filters on exactly those.
        self.conn
            .execute(
                "INSERT INTO cards (session_id, seq, last_active_ms, timeline_len, parent_session_id, source, card)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (session_id) DO UPDATE SET
                     last_active_ms    = excluded.last_active_ms,
                     timeline_len      = excluded.timeline_len,
                     parent_session_id = excluded.parent_session_id,
                     source            = excluded.source,
                     card              = excluded.card",
                agentlens_store::duckdb::params![id, self.next_seq, last_active, timeline_len, parent, source, json],
            )
            .expect("upsert a session card");
        self.next_seq += 1;
        // `IndexMap::insert` on an existing key replaces the value and KEEPS the slot, like the
        // table keeps `seq`.
        self.parsed.insert(id, card);
    }

    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))
            .expect("count the session cards") as usize
    }

    /// (row count, total JSON-text BYTES) over the corpus — one aggregate, on this store's own
    /// connection. TRDD-2JOIAH2G's composition breakdown: the caller reports what the card corpus
    /// IS so the mimalloc commit number can be interpreted against it.
    ///
    /// `strlen(card)`, NOT `octet_length`: this bundled DuckDB build (1.10505.0) rejects
    /// `octet_length(VARCHAR)` at bind time, and the BLOB-cast workaround fails at runtime on
    /// real corpus content — cards carry literal `\n` byte sequences (JSON string escapes
    /// stored verbatim) and DuckDB's STRING→BLOB conversion refuses any non-printable byte
    /// ("Invalid byte encountered in STRING -> BLOB conversion", measured live 2026-09-28).
    /// `strlen` is DuckDB's byte-length function (6 on 'héllo' — UTF-8 aware, unlike
    /// `length` which counts characters and undercounts multilingual session content);
    /// it takes VARCHAR directly and cannot fail on any text value. Measured both ways
    /// against escape-laden cards 2026-09-28 before this choice.
    /// `COALESCE` because SUM over an empty table is NULL.
    ///
    /// Returns `Result` (unlike `len`, which expects) because the caller is a recurring
    /// diagnostics tick with a print-an-unavailable-and-continue contract, not a fail-fast
    /// request path.
    pub fn corpus_bytes(&self) -> agentlens_store::duckdb::Result<(usize, u64)> {
        self.conn.query_row(
            "SELECT count(*), COALESCE(SUM(strlen(card)), 0)::BIGINT FROM cards",
            [],
            |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as u64)),
        )
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.conn
            .query_row("SELECT count(*) FROM cards WHERE session_id = ?", [session_id], |r| r.get::<_, i64>(0))
            .expect("probe the card store")
            > 0
    }

    /// One card, parsed. `None` when the id is unknown — the `contains_key` + index pair the
    /// callers used becomes a single lookup.
    ///
    /// `.ok()` used to sit here, which silently maps ANY error (a corrupt table, a bad
    /// connection, a dropped column) to "card not found" — a fail-fast violation, since the
    /// module's whole doctrine is to panic rather than swallow a card. `optional()` maps only
    /// `QueryReturnedNoRows` to `Ok(None)`; every other error still propagates to `.expect()`.
    pub fn get(&self, session_id: &str) -> Option<Value> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT card FROM cards WHERE session_id = ?", [session_id], |r| r.get::<_, String>(0))
            .optional()
            .expect("look up a session card");
        raw.map(|j| parse(&j))
    }

    /// Every card, parsed, in first-insert order — the summary rebuild's input on the paths that
    /// own the state outright (tests, the CLI, the cold-boot first build).
    pub fn cards(&self) -> Vec<Value> {
        self.cards_json().iter().map(|j| parse(j)).collect()
    }

    /// Every card as its RAW stored JSON, in first-insert order.
    ///
    /// This is what `summary_snapshot` takes under the state lock: copying strings is the cheapest
    /// thing that can cross the lock boundary, and the parse — the expensive half — then happens
    /// in `summary_from`, off the lock, which is the split TRDD-HFV4AIT7 exists to protect.
    pub fn cards_json(&self) -> Vec<String> {
        let mut stmt = self.conn.prepare("SELECT card FROM cards ORDER BY seq").expect("prepare the card scan");
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).expect("scan the cards");
        rows.map(|r| r.expect("read a card row")).collect()
    }

    /// stripCardForPersist over the whole table, in first-insert order — the delta log's records.
    /// The stored cards are NOT mutated: persistence strips a copy.
    pub fn persist_records(&self) -> IndexMap<String, Value> {
        self.full_scan_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut stmt =
            self.conn.prepare("SELECT session_id, card FROM cards ORDER BY seq").expect("prepare the persist scan");
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .expect("scan the cards for persistence");
        rows.map(|r| {
            let (id, json) = r.expect("read a card row");
            (id, crate::log_reader::strip_card_for_persist(&parse(&json)))
        })
        .collect()
    }

    /// `/api/clear` — the cards go with the spans.
    pub fn clear(&mut self) {
        self.conn.execute_batch("DELETE FROM cards").expect("clear the card store");
        self.next_seq = 0;
        self.parsed.clear();
    }

    /// demoteColdTimelines' storage half: only the `hot_cards` most-recently-active cards keep
    /// their timelines; every colder card is stripped to headers.
    ///
    /// The candidate query filters on `timeline_len > 0` AFTER ranking, never before — the rank
    /// has to be computed over ALL cards or the cut would fall in the wrong place. Already-stripped
    /// cards are skipped, which is what makes a second pass idempotent (the truncation counter
    /// accumulates, so re-stripping an empty timeline would still be a no-op, but not re-reading
    /// and re-writing 30k unchanged rows is the point).
    ///
    /// The window operator carries `session_id` and the sort keys ONLY, and the card text is
    /// joined back afterwards for the few rows that survive the filter. Ranking with `card` inside
    /// the CTE would materialize the whole corpus on every sweep — the transient churn that is
    /// this card's whole subject.
    pub fn demote_cold(&mut self, hot_cards: usize) {
        if self.len() <= hot_cards {
            return;
        }
        let mut stmt = self
            .conn
            .prepare(
                "WITH ranked AS (
                     SELECT session_id, row_number() OVER (ORDER BY last_active_ms DESC, seq ASC) AS rn
                     FROM cards
                 )
                 SELECT c.session_id, c.card
                 FROM cards c JOIN ranked r USING (session_id)
                 WHERE r.rn > ? AND c.timeline_len > 0",
            )
            .expect("prepare the demotion scan");
        let rows = stmt
            .query_map([hot_cards as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .expect("scan the cold cards");
        let cold: Vec<(String, String)> = rows.map(|r| r.expect("read a cold card row")).collect();
        drop(stmt);
        for (id, json) in cold {
            let mut card = parse(&json);
            let Some(obj) = card.as_object_mut() else { continue };
            crate::log_reader::strip_timeline_value(obj);
            let stripped = serde_json::to_string(&card).expect("a stripped card is serializable");
            self.conn
                .execute(
                    "UPDATE cards SET card = ?, timeline_len = 0 WHERE session_id = ?",
                    agentlens_store::duckdb::params![stripped, id],
                )
                .expect("store a demoted card");
            // The resident layer must follow the table or a summary rebuilt from it would keep
            // serving a timeline the store already dropped. `Arc::make_mut` is copy-on-write: a
            // rebuild still holding the old pointer keeps its (consistent) pre-demotion view and
            // this layer gets its own stripped copy.
            if let Some(resident) = self.parsed.get_mut(&id) {
                if let Some(obj) = Arc::make_mut(resident).as_object_mut() {
                    crate::log_reader::strip_timeline_value(obj);
                }
            }
        }
    }


    /// Every card as a shared pointer, first-insert order — the summary rebuild input. One
    /// refcount bump per card; no text copy, no parse (TRDD-9VX3WTGU Phase C). `cards()` /
    /// `cards_json()` stay for the cold-boot, CLI and parity paths that read the TABLE.
    pub fn parsed_cards(&self) -> Vec<Arc<Value>> {
        self.parsed.values().cloned().collect()
    }

    /// One keyset page of ROOT cards (`parent_session_id IS NULL`), newest activity first,
    /// strictly AFTER `after` in the order `(last_active_ms DESC, seq ASC)`. Reads the key
    /// columns through `idx_cards_active`; only the page's cards TEXT is materialized.
    pub fn page(&self, after: Option<(f64, i64)>, limit: usize) -> CardPage {
        let total: i64 = self
            .conn
            .query_row("SELECT count(*) FROM cards WHERE parent_session_id IS NULL", [], |r| r.get(0))
            .expect("count the root cards");
        let fetch = limit as i64 + 1;
        const HEAD: &str = "SELECT card, seq, last_active_ms FROM cards WHERE parent_session_id IS NULL";
        const TAIL: &str = " ORDER BY last_active_ms DESC, seq ASC LIMIT ?";
        let read = |r: &agentlens_store::duckdb::Row<'_>| -> agentlens_store::duckdb::Result<(String, i64, f64)> {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        };
        let mut rows: Vec<(String, i64, f64)> = match after {
            Some((ms, seq)) => {
                let mut stmt = self
                    .conn
                    .prepare(&format!("{HEAD} AND (last_active_ms < ? OR (last_active_ms = ? AND seq > ?)){TAIL}"))
                    .expect("prepare the page query");
                let it = stmt
                    .query_map(agentlens_store::duckdb::params![ms, ms, seq, fetch], read)
                    .expect("run the page query");
                it.map(|r| r.expect("read a page row")).collect()
            }
            None => {
                let mut stmt = self.conn.prepare(&format!("{HEAD}{TAIL}")).expect("prepare the first page query");
                let it = stmt.query_map(agentlens_store::duckdb::params![fetch], read).expect("run the first page query");
                it.map(|r| r.expect("read a page row")).collect()
            }
        };
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let next_cursor = if has_more { rows.last().map(|(_, seq, ms)| (*ms, *seq)) } else { None };
        CardPage { sessions: rows.iter().map(|(j, _, _)| parse(j)).collect(), next_cursor, has_more, total }
    }

    /// The direct children (`parent_session_id = parent_id`) of one card, first-insert order.
    pub fn children(&self, parent_id: &str) -> Vec<Value> {
        self.query_cards("SELECT card FROM cards WHERE parent_session_id = ? ORDER BY seq", [parent_id])
    }

    pub fn child_count(&self, parent_id: &str) -> i64 {
        self.conn
            .query_row("SELECT count(*) FROM cards WHERE parent_session_id = ?", [parent_id], |r| r.get(0))
            .expect("count the child cards")
    }

    /// The cards named by `ids` (unknown ids are simply absent), first-insert order.
    pub fn by_ids(&self, ids: &[&str]) -> Vec<Value> {
        if ids.is_empty() {
            return Vec::new();
        }
        let marks = vec!["?"; ids.len()].join(",");
        self.query_cards(
            &format!("SELECT card FROM cards WHERE session_id IN ({marks}) ORDER BY seq"),
            agentlens_store::duckdb::params_from_iter(ids.iter()),
        )
    }

    /// `{total, roots, subagents, bySource}` from the KEY COLUMNS only — a COUNT and a GROUP BY,
    /// never `json_extract` over the card text (that is the O(corpus) scan Amendment 1 bans). A
    /// card with no `source` is counted under `"unknown"`.
    pub fn stats_key(&self) -> Value {
        let (total, roots): (i64, i64) = self
            .conn
            .query_row(
                "SELECT count(*), count(*) FILTER (WHERE parent_session_id IS NULL) FROM cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("count the cards by kind");
        let mut stmt = self
            .conn
            .prepare("SELECT source, count(*) FROM cards GROUP BY source ORDER BY source NULLS LAST")
            .expect("prepare the source breakdown");
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)))
            .expect("group the cards by source");
        let mut by_source = serde_json::Map::new();
        for r in rows {
            let (source, n) = r.expect("read a source row");
            let key = source.unwrap_or_else(|| "unknown".to_owned());
            let prev = by_source.get(&key).and_then(Value::as_i64).unwrap_or(0);
            by_source.insert(key, Value::from(prev + n));
        }
        serde_json::json!({ "total": total, "roots": roots, "subagents": total - roots, "bySource": by_source })
    }

    /// The root card with the newest activity (ties: first inserted) — the `idx_cards_active`
    /// head. `None` on an empty store.
    pub fn newest_root_id(&self) -> Option<String> {
        self.conn
            .query_row(
                "SELECT session_id FROM cards WHERE parent_session_id IS NULL
                 ORDER BY last_active_ms DESC, seq ASC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .expect("find the newest root card")
    }

    fn query_cards<P: agentlens_store::duckdb::Params>(&self, sql: &str, params: P) -> Vec<Value> {
        let mut stmt = self.conn.prepare(sql).expect("prepare a card query");
        let rows = stmt.query_map(params, |r| r.get::<_, String>(0)).expect("run a card query");
        rows.map(|r| parse(&r.expect("read a card row"))).collect()
    }

}

/// A stored card is a string THIS process wrote with `serde_json::to_string`; a parse failure
/// means the table was corrupted in memory, which is not a condition to paper over.
fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("a stored session card parses")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("al-cardstore-unit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// A real DB error (here: the table is gone) must panic, not be swallowed into `None` — the
    /// bug `.ok()` used to cause. `conn` is private, so this lives in-module rather than in the
    /// integration test file, which only ever sees a healthy store.
    #[test]
    #[should_panic(expected = "look up a session card")]
    fn get_panics_on_a_real_db_error_instead_of_reporting_not_found() {
        let store = CardStore::open(&data_dir("dberror"));
        store.conn.execute_batch("DROP TABLE cards").expect("drop the table for the test");
        store.get("anything");
    }

    /// TRDD-TOIM26HP — the connection's memory is BOUNDED. Without this the file would be a pure
    /// cost: DuckDB's default limit is a fraction of system RAM, so on this machine the buffer
    /// pool would happily keep the entire corpus resident and the card would have changed nothing
    /// it set out to change. Asserted here because `conn` is private.
    #[test]
    fn the_connection_is_bounded_and_uses_two_threads() {
        let store = CardStore::open(&data_dir("settings"));
        let mem: String = store
            .conn
            .query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0))
            .expect("read back memory_limit");
        assert!(mem.starts_with("256"), "the buffer pool must be capped at {MEMORY_LIMIT}, got {mem}");
        let threads: i64 =
            store.conn.query_row("SELECT current_setting('threads')", [], |r| r.get(0)).expect("read back threads");
        assert_eq!(threads, 2);
    }
}
