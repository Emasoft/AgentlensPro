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
//! ## TRDD-TOIM26HP / TRDD-9VX3WTGU — the database is a FILE under the data dir, REUSED when valid
//!
//! XTFDRTH2 landed this table in `Connection::open_in_memory()`, so the corpus was still 100%
//! resident: the win was the SHAPE of the bytes, not their residency. `<data_dir>/cards.duckdb`
//! hands the residency decision to DuckDB's buffer pool, and [`MEMORY_LIMIT`] is what makes that
//! decision bounded instead of "whatever DuckDB feels like".
//!
//! TOIM26HP made it a SPILL file deleted at every boot, because nothing could tell a stale
//! database from a good one: `DurableState::restore` treats a stale `LOG_INGEST_VERSION` as
//! "restore nothing, cold-rescan" without clearing the store, so a database that outlived the
//! process would have served cards built under OLD semantics. TRDD-9VX3WTGU wires that gate into
//! the database itself — a `meta` table (ingest version, card schema version, `restore_complete`,
//! `clear_in_progress`) — so `open` can keep the file and a start no longer redoes the 40k
//! indexed inserts of the restore. The rule and the fallbacks are on [`CardStore::open`].
//!
//! Tests that assumed a fresh store per open must give each open its OWN data dir: two live
//! stores over one reusable file would be two writers on one database (DuckDB's file lock is
//! fcntl, which POSIX does not enforce between two opens inside one process).
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


/// TRDD-9VX3WTGU — the card-store layout version, stamped into `meta`. Bump it whenever `SCHEMA`
/// or the PERSISTED SHAPE of a card row changes (e.g. what the write-time persist-strip removes):
/// a database stamped with another value is deleted and rebuilt, never reused. Starts at 1 — a
/// database from before the `meta` table existed has no stamp at all and is rebuilt too.
pub const CARD_SCHEMA_VERSION: u64 = 1;

/// TRDD-9VX3WTGU — the reuse gate lives in the same file as the cards it vouches for (a stamp in a
/// sidecar file could disagree with the database it describes). Four keys, all text:
/// `ingest_version` (`LOG_INGEST_VERSION` the rows were built under), `card_schema_version`,
/// `restore_complete` ("1" once a full restore finished — a database filled by a restore that was
/// killed half-way is NOT a complete corpus), `clear_in_progress` ("1" from the `/api/clear` DELETE
/// until the rescan finished — an empty database next to still-valid saved offsets would never
/// refill).
const META_SCHEMA: &str = "CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)";


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
    /// TRDD-ORGJ0E3G follow-up — DA0GN1CS: counts calls to `persist_snapshot()`, the whole-store
    /// persist input that `save_cards` takes under the state lock (a snapshot of the resident layer,
    /// not a DuckDB scan). Exists only so a test can assert that a bounded-cost caller (like
    /// `run_1h_backfill_step`) does NOT trigger it, and that the periodic save DOES (the positive
    /// control). A regression back to a whole-store persist on the bounded path would show up as this
    /// counter growing once per backfill chunk instead of staying flat.
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
    /// Bumped by every `clear`; slots restart from 0 after one, so a consumer that remembers slot
    /// positions (the summary engine) can tell a restart from ordinary growth.
    epoch: u64,
    /// TRDD-KMF02UEX — counts `demote_cold`'s primary-key card fetches (one per demotion candidate).
    /// Exists only so a test can assert that the card text is read for exactly the cards being
    /// demoted, and never when no timeline card lies beyond the hot set.
    demote_card_fetches: std::sync::atomic::AtomicUsize,
    /// TRDD-9VX3WTGU — `open` kept the previous run's database (the reuse gate passed). Read by
    /// `DurableState::restore` to skip the snapshot load and the 40k inserts.
    reused: bool,
}

impl CardStore {
    /// Open `<data_dir>/cards.duckdb`, REUSING the previous run's corpus when — and only when — it
    /// is provably the complete corpus of the current semantics (TRDD-9VX3WTGU; this replaces the
    /// TRDD-TOIM26HP delete-at-every-boot, which paid the 40k indexed INSERTs of a full restore on
    /// every start).
    ///
    /// REUSE iff ALL hold: the file opens cleanly; `meta` exists; `ingest_version` ==
    /// `LOG_INGEST_VERSION`; `card_schema_version` == [`CARD_SCHEMA_VERSION`]; `restore_complete`
    /// is 1; `clear_in_progress` is 0. Anything else — including a corrupt file, a WAL whose
    /// checksum fails (a fatal open in DuckDB), a newer storage format, or a database written by a
    /// build that had no `meta` (the one-time migration) — DELETES the database and starts empty,
    /// and the caller (`DurableState::restore`) refills it from the card snapshot + offsets pair
    /// exactly as before. NEVER a cold scan with the offsets kept: a store emptied behind valid
    /// offsets would never refill (the tailer cold-scans only when it holds no offsets).
    ///
    /// On reuse the resident parsed layer is rebuilt here, one parse per card, in `seq` order, and
    /// `next_seq` resumes at `max(seq)+1` (a counter restarting at 0 would sort new cards before
    /// old ones and break the first-insert tie order).
    ///
    /// Prints ONE line naming the decision and its reason.
    ///
    /// No `Default`: a card store without a data dir is not a thing, and the impl only ever
    /// existed to satisfy clippy's `new_without_default`, which does not apply to a constructor
    /// that takes an argument.
    pub fn open(data_dir: &Path) -> CardStore {
        std::fs::create_dir_all(data_dir).expect("create the data dir for the card store");
        let path = data_dir.join(CARD_DB_FILE);
        let wal = data_dir.join(format!("{CARD_DB_FILE}.wal"));
        let reason = match Self::try_reuse(&path) {
            // WHY the resident scan is part of the gate: before reuse a corrupt file healed itself
            // because every start deleted it; now a bad row would panic on EVERY start, permanently.
            // `count(*)` alone is answered from metadata, so it does not prove the card column is
            // readable — only reading and parsing every card does. `conn` is dropped at the end of
            // the `Err` arm, releasing the file before it is deleted below.
            Ok(conn) => match Self::load_resident(&conn) {
                Ok((parsed, next_seq)) => {
                    eprintln!(
                        "{} alcore: card store — reusing {CARD_DB_FILE}: {} cards, ingest v{}, schema v{CARD_SCHEMA_VERSION}, restore complete, no clear in progress",
                        crate::log_ts(),
                        parsed.len(),
                        crate::log_reader::LOG_INGEST_VERSION
                    );
                    return CardStore {
                        conn,
                        next_seq,
                        full_scan_calls: std::sync::atomic::AtomicUsize::new(0),
                        demote_card_fetches: std::sync::atomic::AtomicUsize::new(0),
                        parsed,
                        epoch: 0,
                        reused: true,
                    };
                }
                Err(reason) => reason,
            },
            Err(reason) => reason,
        };
        eprintln!(
            "{} alcore: card store — NOT reusing {CARD_DB_FILE} ({reason}); starting empty, a full restore from the card snapshot rebuilds it",
            crate::log_ts()
        );
        // Best-effort: a missing file is the NORMAL case (first boot), so this cannot be an
        // `expect`. The `DROP TABLE IF EXISTS` below is what actually guarantees an empty corpus.
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&wal);
        let conn =
            Connection::open(&path).unwrap_or_else(|e| panic!("open the card store at {}: {e}", path.display()));
        Self::configure(&conn).expect("configure the card store connection");
        // `restore_complete` starts at 0: only the end of a full restore (`mark_restore_complete`)
        // vouches for the corpus, so a boot killed half-way through the restore is rebuilt.
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS cards; DROP TABLE IF EXISTS meta; {SCHEMA}; {META_SCHEMA};
             INSERT INTO meta VALUES ('ingest_version', '{}'), ('card_schema_version', '{CARD_SCHEMA_VERSION}'),
                                     ('restore_complete', '0'), ('clear_in_progress', '0');",
            crate::log_reader::LOG_INGEST_VERSION
        ))
        .expect("create the card store schema");
        CardStore {
            conn,
            next_seq: 0,
            full_scan_calls: std::sync::atomic::AtomicUsize::new(0),
            demote_card_fetches: std::sync::atomic::AtomicUsize::new(0),
            parsed: IndexMap::new(),
            epoch: 0,
            reused: false,
        }
    }

    /// `threads=2` matches statusline_store's connection: these are point queries and a 32k-row
    /// sort, not an analytical scan, and a per-connection thread pool sized to the machine would
    /// be pure overhead in a process that already runs its own executor.
    ///
    /// NOT `SET temp_directory=''` (which the Parquet stores use to make an over-limit query FAIL
    /// rather than spill): here a spill is the intended behaviour of a bounded buffer pool, and
    /// failing the summary rebuild instead would lose the whole corpus from the wire.
    fn configure(conn: &Connection) -> agentlens_store::duckdb::Result<()> {
        conn.execute_batch(&format!("SET memory_limit='{MEMORY_LIMIT}'; SET threads=2;"))
    }

    /// The reuse gate (see `open`): `Ok(conn)` only when every condition holds, else the reason
    /// the database cannot be trusted. The connection is dropped on every `Err`, releasing the
    /// file before `open` deletes it.
    fn try_reuse(path: &Path) -> Result<Connection, String> {
        if !path.exists() {
            return Err("no database file".to_owned());
        }
        let conn = Connection::open(path).map_err(|e| format!("the file does not open cleanly: {e}"))?;
        Self::configure(&conn).map_err(|e| format!("cannot configure the connection: {e}"))?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM meta")
            .map_err(|e| format!("no readable meta table (a database from before the reuse gate): {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("meta table unreadable: {e}"))?;
        let meta: std::collections::HashMap<String, String> =
            rows.collect::<Result<_, _>>().map_err(|e| format!("meta table unreadable: {e}"))?;
        drop(stmt);
        let want_ingest = crate::log_reader::LOG_INGEST_VERSION.to_string();
        let want_schema = CARD_SCHEMA_VERSION.to_string();
        let get = |k: &str| meta.get(k).map(String::as_str);
        if get("ingest_version") != Some(want_ingest.as_str()) {
            return Err(format!("ingest version {:?} != {want_ingest}", get("ingest_version")));
        }
        if get("card_schema_version") != Some(want_schema.as_str()) {
            return Err(format!("card schema version {:?} != {want_schema}", get("card_schema_version")));
        }
        if get("restore_complete") != Some("1") {
            return Err("the previous restore never completed".to_owned());
        }
        if get("clear_in_progress") != Some("0") {
            return Err("an /api/clear was in progress".to_owned());
        }
        // The table itself must be readable too: a header that opens but a card table that does not
        // is exactly the damage a reuse must not paper over.
        conn.query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("the cards table is unreadable: {e}"))?;
        Ok(conn)
    }

    /// Rebuild the resident parsed layer from the table: one parse per card, `seq` order, plus the
    /// next ordinal. The same shape `put_arc` leaves behind, so a reused store and a restored one
    /// serve the same summary.
    fn load_resident(conn: &Connection) -> Result<(IndexMap<String, Arc<Value>>, i64), String> {
        let mut stmt = conn
            .prepare("SELECT session_id, card FROM cards ORDER BY seq")
            .map_err(|e| format!("cannot prepare the resident-layer scan: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("the cards table is unreadable: {e}"))?;
        let mut parsed = IndexMap::new();
        for r in rows {
            let (id, json) = r.map_err(|e| format!("a card row is unreadable: {e}"))?;
            let card = serde_json::from_str(&json).map_err(|e| format!("card {id} is not valid JSON: {e}"))?;
            parsed.insert(id, Arc::new(card));
        }
        drop(stmt);
        let next_seq: i64 = conn
            .query_row("SELECT COALESCE(MAX(seq), -1) + 1 FROM cards", [], |r| r.get(0))
            .map_err(|e| format!("cannot read the next card ordinal: {e}"))?;
        Ok((parsed, next_seq))
    }

    /// True when `open` kept the previous run's corpus (the gate in `open` passed).
    pub fn reused(&self) -> bool {
        self.reused
    }

    fn set_meta(&self, key: &str, value: &str) {
        self.conn
            .execute("UPDATE meta SET value = ? WHERE key = ?", agentlens_store::duckdb::params![value, key])
            .expect("update the card store meta");
    }

    /// The full restore finished: from now on this database is a complete corpus and the next
    /// boot may reuse it. Set by `DurableState::restore` after the LAST card is committed.
    pub fn mark_restore_complete(&self) {
        self.set_meta("restore_complete", "1");
    }

    /// The `/api/clear` rescan finished: the corpus is whole again (see `clear`).
    pub fn finish_clear(&self) {
        self.set_meta("clear_in_progress", "0");
    }

    /// Drop every row WITHOUT the `/api/clear` flag — for `restore`, which found a reused database
    /// whose offsets are version-stale and must fall back to the cold-rescan path on an empty
    /// store (the flag would be wrong: no rescan is pending on a sweeper message).
    pub fn discard_cards(&mut self) {
        // `restore_complete` goes back to 0 with the rows: an empty database must not vouch for a
        // complete corpus; the restore that follows sets it to 1 again when it returns.
        self.conn
            .execute_batch("DELETE FROM cards; UPDATE meta SET value = '0' WHERE key = 'restore_complete'")
            .expect("discard the stale card store");
        self.next_seq = 0;
        self.parsed.clear();
    }

    /// TRDD-ORGJ0E3G follow-up — how many times `persist_snapshot()` (the whole-store persist input)
    /// has run. Test-only signal; see the field doc above.
    pub fn full_scan_calls(&self) -> usize {
        self.full_scan_calls.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// TRDD-KMF02UEX — how many primary-key card fetches `demote_cold` has made. Test-only signal;
    /// see the field doc above.
    pub fn demote_card_fetches(&self) -> usize {
        self.demote_card_fetches.load(std::sync::atomic::Ordering::Relaxed)
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
        // TRDD-9VX3WTGU: strip BEFORE the row and the resident layer are derived, so both hold the
        // same persist-stripped form. WHY here and not only in `demote_cold`: a card that arrives
        // idle for more than the hot age is already timeline-EMPTY when it is put (the parse-time
        // strip), so `demote_cold`'s `timeline_len > 0` candidate filter never touches it and its
        // fileOps / backgroundSpans / generatedFiles would sit in the database forever — the
        // TWDGR75R growth ("re-parse roughly doubled cards.duckdb"), now permanent because the
        // database outlives the boot. A card WITH a timeline (the hot set) is left exactly as is.
        let card = persist_strip_cold(card);
        let id = card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        let last_active = crate::log_reader::last_active_ms(&card);
        let timeline_len = card.get("timeline").and_then(Value::as_array).map_or(0, Vec::len) as i64;
        let parent = card.get("parentSessionId").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_owned);
        let source = card.get("source").and_then(Value::as_str).map(str::to_owned);
        let json = serde_json::to_string(&*card).expect("a session card is serializable");
        // WHY the indexed columns are in DO UPDATE too: an upsert moves `last_active_ms` (and, in
        // principle, the parent), and the page query orders and filters on exactly those.
        //
        // TRDD-9VX3WTGU ORDERING CONTRACT — reuse depends on it: this is ONE autocommit statement
        // (or a transaction the caller closes before returning), and DuckDB syncs its WAL at every
        // commit (F_FULLFSYNC on macOS). The offsets log is saved LATER, on the same sweeper
        // thread (`DurableState::tick`, after the sweep's cards were put) and WITHOUT an fsync, so
        // a saved offset can never be ahead of a durable card. A reused database is therefore
        // always at least as fresh as the offsets next to it ("card ahead of offsets" is harmless:
        // the file reads as changed and is re-parsed over the row; "offsets ahead of cards" would
        // leave a stale card that nothing ever refreshes). Do not batch puts across the offsets
        // save, and do not move the offsets save before the puts of its sweep.
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

    /// `/api/clear` — the cards go with the spans.
    ///
    /// TRDD-9VX3WTGU: `clear_in_progress` is set in the SAME transaction as the DELETE, and cleared
    /// by [`CardStore::finish_clear`] only once the sweeper's rescan finished. WHY: the database now
    /// outlives the process, and the offsets log on disk is untouched until the first save after
    /// the rescan — a crash in between would otherwise leave an EMPTY database next to still-valid
    /// offsets, which read every file as unchanged, so the cards would never come back. With the
    /// flag set the next boot refuses to reuse the database and rebuilds it from the snapshot.
    pub fn clear(&mut self) {
        // WHY one transaction: a separate autocommit DELETE before it means a crash between the two leaves an empty database with clear_in_progress=0, which the next boot would REUSE next to still-valid offsets, so the cards never come back — the DELETE and the flag must commit together.
        self.conn
            .execute_batch(
                "BEGIN TRANSACTION; DELETE FROM cards;
                 UPDATE meta SET value = '1' WHERE key = 'clear_in_progress'; COMMIT",
            )
            .expect("clear the card store");
        self.next_seq = 0;
        self.parsed.clear();
        self.epoch += 1;
    }

    /// Bumped by every `clear`; see the field.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// demoteColdTimelines' storage half: only the `hot_cards` most-recently-active cards keep
    /// their timelines; every colder card is stripped to headers. Returns how many cards it demoted.
    ///
    /// The candidate query filters on `timeline_len > 0` AFTER ranking, never before — the rank
    /// has to be computed over ALL cards or the cut would fall in the wrong place. Already-stripped
    /// cards are skipped, which is what makes a second pass idempotent (the truncation counter
    /// accumulates, so re-stripping an empty timeline would still be a no-op, but not re-reading
    /// and re-writing 30k unchanged rows is the point).
    ///
    /// TRDD-KMF02UEX — WHY keys only, then one primary-key fetch per demoted card: this runs under
    /// the state lock at the end of every non-empty ingest batch. The previous query joined the
    /// `card` text of EVERY timeline card back onto the window in one shot, demoted or not; on a
    /// scratch copy of a regrown file that read failed at 224 MiB and passed at the production
    /// limit of 256 MiB (that production reaches such a file is inferred, not observed), and its
    /// `.expect` WOULD have panicked with the lock held, poisoning the mutex (never observed
    /// firing). Measured instead, on the component queries (the window alone, the candidate keys
    /// alone): at or under 16 MiB, and a primary-key fetch of the largest (2.3 MB) card at or
    /// under 8 MiB. So card text is read only for a card actually being demoted, and every
    /// DuckDB or serde failure comes back as `Err` (the caller counts and logs it; the next batch
    /// retries) instead of a panic under the lock. NOT measured: the per-card UPDATE's memory at
    /// 256 MiB with 80 KB to 2.3 MB cards (at low limits on small test cards it failed before the
    /// old read did). An Err stops the pass at the first failing card (fail-fast, TRDD-MEPIRHI4):
    /// the hotter candidates before it stay demoted; with the pinned order a card that fails on
    /// every batch blocks only the colder candidates after it; the alcore.demoteColdError
    /// counter counts it and the first-failure log line names it.
    ///
    /// The early return reads the resident layer, not `count(*)`: below the hot set no DuckDB
    /// statement runs at all (layer and table hold the same rows — `persist_snapshot` debug-asserts
    /// it). Per card the table is written FIRST and the resident layer stripped only after the
    /// UPDATE returned Ok, so an error part-way leaves every card stripped in both or in neither.
    pub fn demote_cold(&mut self, hot_cards: usize) -> Result<usize, String> {
        if self.parsed.len() <= hot_cards {
            return Ok(0);
        }
        let candidates: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare(DEMOTE_CANDIDATES_SQL)
                .map_err(|e| format!("prepare the demotion candidate query: {e}"))?;
            let rows = stmt
                .query_map([hot_cards as i64], |r| r.get::<_, String>(0))
                .map_err(|e| format!("run the demotion candidate query: {e}"))?;
            rows.collect::<Result<_, _>>().map_err(|e| format!("read a demotion candidate: {e}"))?
        };
        if candidates.is_empty() {
            return Ok(0);
        }
        // Prepared once per call; both borrow only `self.conn`, so the loop may still touch the
        // other fields (`parsed`, the counter) directly.
        let mut fetch = self
            .conn
            .prepare("SELECT card FROM cards WHERE session_id = ?")
            .map_err(|e| format!("prepare the demoted-card fetch: {e}"))?;
        let mut update = self
            .conn
            .prepare("UPDATE cards SET card = ?, timeline_len = 0 WHERE session_id = ?")
            .map_err(|e| format!("prepare the demoted-card update: {e}"))?;
        let mut demoted = 0;
        for id in candidates {
            // TRDD-MEPIRHI4: a candidate missing from the resident layer means the table and
            // `parsed` have diverged (the DA0GN1CS parity). f9e0742e stripped the table row and
            // skipped the resident strip silently, hiding it. Fail fast BEFORE touching the card:
            // the Err repeats on every batch until that session is put again (put_arc re-inserts
            // it), a clear empties both layers, or a restart rebuilds the resident layer from the
            // table; the first-failure log line names the card.
            if !self.parsed.contains_key(&id) {
                return Err(format!("demotion candidate {id} has no resident entry"));
            }
            self.demote_card_fetches.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            // `query_row` errors on a missing row too, so a candidate that vanished is an `Err`,
            // never a panic.
            let json: String = fetch
                .query_row([&id], |r| r.get(0))
                .map_err(|e| format!("fetch the demotion candidate {id}: {e}"))?;
            // Parsed locally, not through `parse`, whose `.expect` would panic under the lock.
            let mut card: Value =
                serde_json::from_str(&json).map_err(|e| format!("parse the demotion candidate {id}: {e}"))?;
            let Some(obj) = card.as_object_mut() else { continue };
            // TRDD-9VX3WTGU: the persist-strip too, so a hot card that falls out of the hot set
            // reaches the same shape `put_arc` gives a card that arrived cold (invariant: empty
            // timeline <=> persist-stripped). `strip_timeline_value` keeps its truncation bump.
            crate::log_reader::strip_timeline_value(obj);
            persist_strip_map(obj);
            let stripped =
                serde_json::to_string(&card).map_err(|e| format!("serialize the demoted card {id}: {e}"))?;
            update
                .execute(agentlens_store::duckdb::params![stripped, id])
                .map_err(|e| format!("store the demoted card {id}: {e}"))?;
            // Only now, with the UPDATE committed: the resident layer must follow the table or a
            // summary rebuilt from it would keep serving a timeline the store already dropped — and
            // stripping it BEFORE a failed UPDATE would serve a stripped card the table still holds
            // whole. `Arc::make_mut` is copy-on-write: a rebuild still holding the old pointer keeps
            // its (consistent) pre-demotion view and this layer gets its own stripped copy.
            // Always Some here: checked at the top of the loop (TRDD-MEPIRHI4); do not turn it
            // into an expect, which would panic under the state lock.
            if let Some(resident) = self.parsed.get_mut(&id) {
                if let Some(obj) = Arc::make_mut(resident).as_object_mut() {
                    crate::log_reader::strip_timeline_value(obj);
                    persist_strip_map(obj);
                }
            }
            demoted += 1;
        }
        Ok(demoted)
    }

    /// Every card as a shared pointer, first-insert order — the summary rebuild input. One
    /// refcount bump per card; no text copy, no parse (TRDD-9VX3WTGU Phase C). `cards()` /
    /// `cards_json()` stay for the cold-boot, CLI and parity paths that read the TABLE.
    pub fn parsed_cards(&self) -> Vec<Arc<Value>> {
        self.parsed.values().cloned().collect()
    }

    /// DA0GN1CS — the whole-store persist input: every card as its resident Arc, in first-insert
    /// order, one refcount bump per card and no DuckDB call. save_cards takes it under the state
    /// lock instead of scanning the table, because that scan hit the 256 MiB DuckDB limit and
    /// panicked with the lock held, which poisoned the mutex.
    pub fn persist_snapshot(&self) -> Vec<Arc<Value>> {
        // WHY: the resident layer and the table are kept in step by hand on every write path (put_arc,
        // demote_cold, clear, discard_cards, and the reopen rebuild in load_resident). A future write path
        // that updates only the table would make the persisted records silently diverge from the layer they
        // are built from. In debug builds this check runs a DuckDB COUNT(*) under the state lock; release
        // builds compile it out, so it costs nothing there.
        debug_assert_eq!(self.parsed.len(), self.len(), "resident layer and table diverged");
        self.full_scan_calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
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

/// TRDD-KMF02UEX — `demote_cold`'s candidate query: session ids ONLY, never card text. The window
/// ranks ALL cards (the cut must fall in the right place) and the `timeline_len > 0` filter runs
/// after it. Shared with the in-module tests, so their "the new query fits" precondition measures
/// the query production actually runs. `ORDER BY rn` pins the order the query already returned
/// (hottest beyond the hot set first, coldest last; measured equal to the unordered output on a
/// clone of the live copy with Python DuckDB 1.5.6, TRDD-MEPIRHI4), so an abort on a failing card
/// blocks only the colder candidates after it.
const DEMOTE_CANDIDATES_SQL: &str = "WITH ranked AS (
         SELECT session_id, timeline_len,
                row_number() OVER (ORDER BY last_active_ms DESC, seq ASC) AS rn
         FROM cards
     )
     SELECT session_id FROM ranked WHERE rn > ? AND timeline_len > 0 ORDER BY rn";

/// TRDD-9VX3WTGU — the persist-strip of a card whose timeline is already empty: drops `fileOps`,
/// `generatedFiles`, `generatedFilesTruncated` and empties `backgroundSpans`, exactly the fields
/// `log_reader::strip_card_for_persist` drops (so a stored row equals what the card snapshot would
/// hold), WITHOUT inserting keys the card did not have and WITHOUT touching the timeline or its
/// truncation counters. Returns whether anything changed.
fn persist_strip_map(obj: &mut serde_json::Map<String, Value>) -> bool {
    let mut changed = obj.shift_remove("fileOps").is_some();
    changed |= obj.shift_remove("generatedFiles").is_some();
    changed |= obj.shift_remove("generatedFilesTruncated").is_some();
    if let Some(Value::Array(spans)) = obj.get_mut("backgroundSpans") {
        if !spans.is_empty() {
            spans.clear();
            changed = true;
        }
    }
    changed
}

/// `put_arc`'s write-time strip: a card with no timeline entries is persist-stripped, a card with
/// timeline entries (the hot set) is returned untouched. Clones only when something must go.
fn persist_strip_cold(card: Arc<Value>) -> Arc<Value> {
    let Some(obj) = card.as_object() else { return card };
    if obj.get("timeline").and_then(Value::as_array).is_some_and(|t| !t.is_empty()) {
        return card;
    }
    let dirty = ["fileOps", "generatedFiles", "generatedFilesTruncated"].iter().any(|k| obj.contains_key(*k))
        || obj.get("backgroundSpans").and_then(Value::as_array).is_some_and(|s| !s.is_empty());
    if !dirty {
        return card;
    }
    let mut stripped = obj.clone();
    persist_strip_map(&mut stripped);
    Arc::new(Value::Object(stripped))
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

    /// A card with `entries` timeline entries of `payload` bytes each. Its last-active instant is
    /// start + `duration_ms`, so distinct durations give `demote_cold` a strict order.
    fn card(id: &str, duration_ms: f64, entries: usize, payload: usize) -> Value {
        serde_json::json!({
            "sessionId": id,
            "source": "claude_code",
            "startTime": "2026-08-01T10:00:00.000Z",
            "durationMs": duration_ms,
            "timeline": (0..entries)
                .map(|i| serde_json::json!({ "type": "api_request", "i": i, "payload": "x".repeat(payload) }))
                .collect::<Vec<_>>(),
        })
    }

    fn timeline_len(card: &Value) -> usize {
        card.get("timeline").and_then(Value::as_array).map_or(0, Vec::len)
    }

    /// `n` cards `s0..s{n-1}`, each more recently active than the one before.
    fn fill(s: &mut CardStore, n: usize, entries: usize, payload: usize) {
        for i in 0..n {
            s.put(&card(&format!("s{i}"), (i as f64 + 1.0) * 1000.0, entries, payload));
        }
    }

    /// The one-shot query `demote_cold` ran before TRDD-KMF02UEX, verbatim: it joins the card TEXT
    /// of every timeline card onto the window. Every row (both columns) is consumed.
    fn old_query_ids(s: &CardStore, hot_cards: usize) -> Result<Vec<String>, String> {
        let mut stmt = s
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
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([hot_cards as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.map(|r| r.map(|(id, _card)| id)).collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// The keys-only candidate query production runs now.
    fn candidate_ids(s: &CardStore, hot_cards: usize) -> Result<Vec<String>, String> {
        let mut stmt = s.conn.prepare(DEMOTE_CANDIDATES_SQL).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([hot_cards as i64], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    fn table_timeline_len(s: &CardStore, id: &str) -> i64 {
        s.conn
            .query_row("SELECT timeline_len FROM cards WHERE session_id = ?", [id], |r| r.get(0))
            .expect("read a timeline_len")
    }

    /// TRDD-KMF02UEX — a DuckDB error inside `demote_cold` comes back as `Err` (it used to be an
    /// `.expect` panicking under the state lock), and nothing is stripped on the way out.
    #[test]
    fn demote_cold_returns_err_on_a_db_error_and_strips_nothing() {
        let mut s = CardStore::open(&data_dir("demote-err"));
        fill(&mut s, 50, 3, 16);
        s.conn.execute_batch("DROP TABLE cards").expect("drop the table for the test");
        let err = s.demote_cold(1).expect_err("a DuckDB error must come back as Err");
        assert!(err.contains("demotion candidate"), "unexpected error: {err}");
        assert_eq!(s.demote_card_fetches(), 0);
        let resident = s.parsed_cards();
        assert_eq!(resident.len(), 50);
        assert!(resident.iter().all(|c| timeline_len(c) == 3), "a failed demotion must not strip the resident layer");
    }

    /// TRDD-KMF02UEX — the same failure under a mutex (as `CoreState` runs it) leaves the mutex
    /// usable: no panic while the guard is held, so no poisoning.
    #[test]
    fn a_failing_demote_cold_does_not_poison_the_lock_it_runs_under() {
        let mut s = CardStore::open(&data_dir("demote-poison"));
        fill(&mut s, 50, 3, 16);
        s.conn.execute_batch("DROP TABLE cards").expect("drop the table for the test");
        let m = Arc::new(std::sync::Mutex::new(s));
        let in_thread = Arc::clone(&m);
        let result = std::thread::spawn(move || in_thread.lock().expect("lock").demote_cold(1))
            .join()
            .expect("demote_cold must not panic");
        assert!(result.is_err());
        assert!(!m.is_poisoned(), "a failed demotion must leave the lock usable");
    }

    /// TRDD-KMF02UEX — the keys-only rewrite demotes exactly the cards the old one-shot query
    /// selected, in the table and the resident layer, with one card fetch per demoted card.
    #[test]
    fn demote_cold_demotes_exactly_the_cards_the_old_query_selected() {
        let mut s = CardStore::open(&data_dir("demote-same"));
        // Every third card arrives with no timeline (never a candidate); the rest carry two entries.
        let entries = |i: usize| if i.is_multiple_of(3) { 0 } else { 2 };
        for i in 0..30 {
            s.put(&card(&format!("s{i}"), (i as f64 + 1.0) * 1000.0, entries(i), 8));
        }
        let expected = old_query_ids(&s, 5).expect("the old query on a small corpus");
        assert_eq!(expected.len(), 16, "s0..s24 minus the nine timeline-free ones");
        assert_eq!(s.demote_cold(5), Ok(expected.len()));
        assert_eq!(s.demote_card_fetches(), expected.len());
        for i in 0..30 {
            let id = format!("s{i}");
            let keeps = entries(i) > 0 && !expected.contains(&id);
            assert_eq!(table_timeline_len(&s, &id) > 0, keeps, "table, {id}");
            let resident = s.parsed.get(&id).expect("resident card");
            assert_eq!(timeline_len(resident) > 0, keeps, "resident layer, {id}");
        }
    }


    /// TRDD-MEPIRHI4 — the candidate query returns the hottest card beyond the hot set first and
    /// the coldest last, so an abort on a failing card blocks only the colder candidates after it.
    /// Cards are put in a SHUFFLED order (durations 3,7,1,8,2,6,4,5 thousand ms), so the window
    /// order differs from both insertion order and its reverse.
    #[test]
    fn demote_cold_candidates_come_hottest_first() {
        let mut s = CardStore::open(&data_dir("demote-order-pinned"));
        for (i, d) in [3, 7, 1, 8, 2, 6, 4, 5].into_iter().enumerate() {
            s.put(&card(&format!("s{i}"), d as f64 * 1000.0, 2, 8));
        }
        let expected: Vec<String> = ["s1", "s5", "s7", "s6", "s0", "s4", "s2"].map(String::from).to_vec();
        assert_eq!(candidate_ids(&s, 1), Ok(expected));
    }


    /// TRDD-MEPIRHI4 — a candidate missing from the resident layer (table and `parsed` diverged)
    /// is an `Err` raised BEFORE the card is fetched or stripped: nothing is touched, in either layer.
    #[test]
    fn demote_cold_fails_before_touching_a_candidate_missing_from_the_resident_layer() {
        let mut s = CardStore::open(&data_dir("demote-missing-resident"));
        for (i, d) in [3, 7, 1, 8, 2, 6, 4, 5].into_iter().enumerate() {
            s.put(&card(&format!("s{i}"), d as f64 * 1000.0, 2, 8));
        }
        // s1 is the first candidate in the pinned hottest-first order.
        s.parsed.shift_remove("s1");
        let err = s.demote_cold(1).expect_err("a candidate with no resident entry must be an Err");
        assert!(err.contains("s1") && err.contains("no resident entry"), "unexpected error: {err}");
        assert_eq!(s.demote_card_fetches(), 0);
        for i in 0..8 {
            let id = format!("s{i}");
            assert!(table_timeline_len(&s, &id) > 0, "table stripped, {id}");
            if i != 1 {
                let resident = s.parsed.get(&id).expect("resident card");
                assert_eq!(timeline_len(resident), 2, "resident layer stripped, {id}");
            }
        }
        assert!(!s.parsed.contains_key("s1"), "s1 must stay absent");
    }

    /// TRDD-MEPIRHI4 — the cards ahead of a missing candidate in the same pass stay demoted in both
    /// layers, and the Err drops their count: demote_cold returns no count on failure.
    #[test]
    fn demote_cold_keeps_hotter_candidates_demoted_when_a_later_candidate_is_missing() {
        let mut s = CardStore::open(&data_dir("demote-missing-later"));
        for (i, d) in [3, 7, 1, 8, 2, 6, 4, 5].into_iter().enumerate() {
            s.put(&card(&format!("s{i}"), d as f64 * 1000.0, 2, 8));
        }
        // s7 is the third candidate in the pinned hottest-first order, after s1 and s5.
        s.parsed.shift_remove("s7");
        let err = s.demote_cold(1).expect_err("a later candidate with no resident entry must be an Err");
        assert!(err.contains("s7") && err.contains("no resident entry"), "unexpected error: {err}");
        assert_eq!(s.demote_card_fetches(), 2);
        for id in ["s1", "s5"] {
            assert_eq!(table_timeline_len(&s, id), 0, "table, {id}");
            let resident = s.parsed.get(id).expect("resident card");
            assert_eq!(timeline_len(resident), 0, "resident layer, {id}");
        }
        for id in ["s3", "s6", "s0", "s4", "s2"] {
            assert!(table_timeline_len(&s, id) > 0, "table, {id}");
            let resident = s.parsed.get(id).expect("resident card");
            assert_eq!(timeline_len(resident), 2, "resident layer, {id}");
        }
        assert!(table_timeline_len(&s, "s7") > 0, "table, s7");
        assert!(!s.parsed.contains_key("s7"), "s7 must stay absent");
    }

    /// TRDD-59OONXOV — `demote_cold` strips the resident card only after its table UPDATE
    /// succeeded, so a failure part-way leaves each card stripped in both layers or in neither.
    /// The failure is deterministic, with no memory limit: a UNIQUE index on `timeline_len` (every
    /// card starts with a different non-zero length) lets the first demotion set 0 and makes the
    /// second one violate the index inside its per-card UPDATE.
    #[test]
    fn demote_cold_strips_a_resident_card_only_after_its_update() {
        let mut s = CardStore::open(&data_dir("demote-order"));
        for i in 0..5 {
            s.put(&card(&format!("s{i}"), (i as f64 + 1.0) * 1000.0, i + 1, 8));
        }
        s.conn
            .execute_batch("CREATE UNIQUE INDEX ux_demote_test ON cards(timeline_len)")
            .expect("unique index on timeline_len");
        let err = s.demote_cold(1).expect_err("precondition: the second per-card UPDATE violates the unique index");
        assert!(err.contains("store the demoted card"), "precondition: unexpected error: {err}");
        let mut stripped = 0;
        for i in 0..5 {
            let id = format!("s{i}");
            let resident = s.parsed.get(&id).expect("resident card");
            assert_eq!(table_timeline_len(&s, &id) > 0, timeline_len(resident) > 0, "table and resident layer, {id}");
            if timeline_len(resident) == 0 {
                stripped += 1;
            }
        }
        assert_eq!(stripped, 1, "exactly the one card whose UPDATE succeeded is stripped, in both layers");
    }

    /// TRDD-KMF02UEX — the failure the rewrite removes: at a memory limit where the old one-shot
    /// query runs out of memory, the keys-only candidate query fits and `demote_cold` succeeds.
    /// Window measured on this exact setup (reports_dev/kmf02uex-impl-report.md, 5 runs per limit):
    /// the old query fails through 8 MiB and passes from 9; `demote_cold(1)` fails at 6 MiB (in its
    /// per-card UPDATEs) and succeeds from 7. With 4 KB entries no limit separates them — the
    /// UPDATEs then need more memory than the old query — hence 1 KB.
    #[test]
    fn demote_cold_succeeds_where_the_old_one_shot_query_runs_out_of_memory() {
        let mut s = CardStore::open(&data_dir("demote-oom"));
        // FIRST, before any put: DuckDB refuses to switch the temp directory once it has been used,
        // and with spilling allowed the old query could spill instead of failing.
        s.conn.execute_batch("SET temp_directory=''").expect("forbid spilling");
        fill(&mut s, 50, 20, 1000);
        // Checked: below current usage the SET itself fails, and an ignored failure would leave
        // the limit unchanged and the test passing vacuously.
        s.conn.execute_batch("SET memory_limit='8MiB'").expect("lower the memory limit");
        let old = old_query_ids(&s, 1).expect_err("precondition: the old one-shot query runs out of memory here");
        assert!(old.contains("Out of Memory"), "precondition: unexpected error from the old query: {old}");
        let new = candidate_ids(&s, 1).expect("precondition: the keys-only candidate query fits");
        assert_eq!(new.len(), 49);
        assert_eq!(s.demote_cold(1), Ok(49));
    }

    /// TRDD-KMF02UEX — no card text is read when nothing beyond the hot set has a timeline: below
    /// the hot set no statement runs at all, and above it the keys-only query finds no candidate.
    #[test]
    fn demote_cold_reads_no_card_text_when_no_timeline_card_lies_beyond_the_hot_set() {
        let mut s = CardStore::open(&data_dir("demote-none-small"));
        fill(&mut s, 10, 2, 8);
        assert_eq!(s.demote_cold(50), Ok(0));
        assert_eq!(s.demote_card_fetches(), 0);

        // 60 cards, timelines only on the 10 most recent: the corpus exceeds the hot set, so the
        // candidate query runs, and every timeline card sits inside the hot set.
        let mut s = CardStore::open(&data_dir("demote-none-big"));
        for i in 0..60 {
            s.put(&card(&format!("s{i}"), (i as f64 + 1.0) * 1000.0, if i >= 50 { 2 } else { 0 }, 8));
        }
        assert_eq!(s.demote_cold(50), Ok(0));
        assert_eq!(s.demote_card_fetches(), 0);
        assert_eq!(s.parsed_cards().iter().filter(|c| timeline_len(c) > 0).count(), 10);
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
