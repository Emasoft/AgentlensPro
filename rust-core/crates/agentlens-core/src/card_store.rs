//! TRDD-XTFDRTH2 — the log-derived session cards, in a DuckDB table instead of a resident
//! `IndexMap<String, Arc<Value>>`.
//!
//! USER architecture ruling (TRDD-7YPQWKPG, 2026-09-02): *"duckdb is your memory! the rust code
//! should only make queries and report the ephemeral answers"*. The map this replaces held 32,607
//! cards as `serde_json::Value` trees — a shape whose in-RAM cost is several times its own JSON
//! text (a `Map` node plus an owned `String` per key, per card) — and it was measured as one of
//! the three contributors to the 8.7 GB mimalloc heap. Here the corpus is JSON TEXT in one
//! long-lived in-memory DuckDB connection; a reader gets a `Vec` it drops when it is done.
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
//! Every statement here runs against a process-local in-memory database with a fixed schema and
//! bound parameters: a failure is a bug or an OOM, never a recoverable condition, and the callers
//! (`put_log_session`, `demote_cold_timelines`) have no error channel to report one through. So
//! this module panics with the offending SQL rather than swallowing a card, which would lose
//! telemetry silently — the failure mode this project treats as worse than a crash.

use indexmap::IndexMap;
use serde_json::Value;

use agentlens_store::duckdb::Connection;

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
    card VARCHAR NOT NULL
)";

pub struct CardStore {
    conn: Connection,
    /// The next first-insert ordinal. Handed out on every `put` — including an upsert, whose
    /// number is simply skipped. Gaps are irrelevant: only the ORDER of the values is read, and
    /// not reusing a number is what keeps an upsert from stealing a later card's position.
    next_seq: i64,
}

impl Default for CardStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CardStore {
    pub fn new() -> CardStore {
        let conn = Connection::open_in_memory().expect("open the in-memory card store");
        // `threads=2` matches statusline_store's connection: these are point queries and a
        // 32k-row sort, not an analytical scan, and a per-connection thread pool sized to the
        // machine would be pure overhead in a process that already runs its own executor.
        // NO memory_limit override: this table IS the server's card corpus, so a limit would turn
        // "a big machine" into "the server lost cards". DuckDB's own default (a fraction of system
        // RAM) stays as the backstop.
        conn.execute_batch(&format!("SET threads=2; {SCHEMA};")).expect("create the card store schema");
        CardStore { conn, next_seq: 0 }
    }

    /// putLogSession's storage half — upsert by sessionId.
    ///
    /// The key is `unwrap_or("")`, exactly as the `IndexMap` version was: a card with no
    /// `sessionId` has always occupied the one `""` slot rather than accumulating rows.
    pub fn put(&mut self, card: &Value) {
        let id = card.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let last_active = crate::log_reader::last_active_ms(card);
        let timeline_len = card.get("timeline").and_then(Value::as_array).map_or(0, Vec::len) as i64;
        let json = serde_json::to_string(card).expect("a session card is serializable");
        self.conn
            .execute(
                "INSERT INTO cards (session_id, seq, last_active_ms, timeline_len, card) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (session_id) DO UPDATE SET
                     last_active_ms = excluded.last_active_ms,
                     timeline_len   = excluded.timeline_len,
                     card           = excluded.card",
                agentlens_store::duckdb::params![id, self.next_seq, last_active, timeline_len, json],
            )
            .expect("upsert a session card");
        self.next_seq += 1;
    }

    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))
            .expect("count the session cards") as usize
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
    pub fn get(&self, session_id: &str) -> Option<Value> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT card FROM cards WHERE session_id = ?", [session_id], |r| r.get::<_, String>(0))
            .ok();
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
    }

    /// demoteColdTimelines' storage half: only the `hot_cards` most-recently-active cards keep
    /// their timelines; every colder card is stripped to headers.
    ///
    /// The candidate query filters on `timeline_len > 0` AFTER ranking, never before — the rank
    /// has to be computed over ALL cards or the cut would fall in the wrong place. Already-stripped
    /// cards are skipped, which is what makes a second pass idempotent (the truncation counter
    /// accumulates, so re-stripping an empty timeline would still be a no-op, but not re-reading
    /// and re-writing 30k unchanged rows is the point).
    pub fn demote_cold(&mut self, hot_cards: usize) {
        if self.len() <= hot_cards {
            return;
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT session_id, card FROM (
                     SELECT session_id, card, timeline_len,
                            row_number() OVER (ORDER BY last_active_ms DESC, seq ASC) AS rn
                     FROM cards
                 ) WHERE rn > ? AND timeline_len > 0",
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
        }
    }
}

/// A stored card is a string THIS process wrote with `serde_json::to_string`; a parse failure
/// means the table was corrupted in memory, which is not a condition to paper over.
fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("a stored session card parses")
}
