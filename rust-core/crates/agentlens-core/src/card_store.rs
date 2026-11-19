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

/// TRDD-0BDOV3WC — the limit of the ONE compacting rewrite, boot-only: an OOM boot read is copied
/// into a fresh file on a connection at this limit. WHY 1024 MiB: the copy
/// `INSERT INTO fresh.cards SELECT * FROM cards` runs out of memory at 256 MiB on the 30-rewrite
/// copy and passes at 1024 MiB, with peak RSS 524-841 MiB in the scratch probe
/// (reports_dev/0bdov3wc-rewrite-measure.md). The steady-state connection keeps MEMORY_LIMIT. This
/// treats the OOM symptom; TRDD-USSG465Q owns the cause (whole-card rewrites leave a dead row per rewrite).
const REBUILD_MEMORY_LIMIT: &str = "1024MiB";

/// TRDD-USSG465Q: DuckDB option `vacuum_rebuild_indexes`, passed at every open of the card file. It must
/// equal u64::MAX. An upsert whose SET list contains an indexed column (last_active_ms is in idx_cards_active)
/// runs as a delete plus an insert, so every update leaves a dead row. DuckDB 1.5.6 skips the checkpoint
/// vacuum of a table that has ART indexes unless this option is set, so those dead rows are never reclaimed
/// and the file grows. The option also SILENTLY skips any table with more rows than its value, so only the
/// maximum is safe at any corpus size. Evidence: reports_dev/ussg465q-facts.md and
/// reports_dev/ussg465q-levers-measure2.md (Q2).
const VACUUM_REBUILD_INDEXES: &str = "18446744073709551615";

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

/// TRDD-0BDOV3WC — the resident scan: the statement `load_resident` runs to build the resident parsed layer.
const RESIDENT_SCAN_SQL: &str = "SELECT session_id, card FROM cards ORDER BY seq";

/// The resident parsed layer: every card as a shared tree, in first-insert order (see `CardStore::parsed`).
type ResidentCards = IndexMap<String, ResidentCard>;

/// TRDD-T0G38TZ4 — a resident card AND the byte length of the text that was stored for it.
///
/// WHY the length travels with the card: an upsert has to know how many bytes the card it
/// REPLACES occupied in the table, and the only exact source for that is the stored text
/// itself. Re-serialising the resident card to learn its length would serialise every card
/// twice on every put — `put_arc` is the hottest write path in the process (every ingested
/// card goes through it) and cards reach 2.3 MB — so the length is carried instead. It is
/// carried IN the same map entry, never in a parallel map, so it cannot drift from the card
/// it describes.
struct ResidentCard {
    /// The card, shared (copy-on-write: `Arc::make_mut` copies when a holder still points here).
    card: Arc<Value>,
    /// The byte length of the SERIALISED text the table holds for this card — the same number
    /// DuckDB's `strlen(card)` reports for it.
    stored_len: u64,
}

impl std::ops::Deref for ResidentCard {
    type Target = Value;

    /// WHY: the resident layer is read as a card everywhere (the summary rebuild, the tests'
    /// `timeline_len` helper, the demotion's `Arc::make_mut`), and deref keeps every one of those
    /// call sites unchanged while the entry carries the extra `stored_len` field.
    fn deref(&self) -> &Value {
        &self.card
    }
}

/// TRDD-T0G38TZ4 — the resident layer AND the byte total of the text it was built from. The two
/// are built together in `load_resident` and travel together into `CardStore`, so the tracked
/// counter can never describe a corpus the resident layer does not hold.
struct Resident {
    /// Every card as a shared tree, in first-insert order (see `CardStore::parsed`).
    cards: ResidentCards,
    /// The total byte length of the SERIALISED text those cards came from — the same number the
    /// old `SUM(strlen(card))` aggregate reported.
    bytes: u64,
}


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

/// Why a reuse attempt was refused (TRDD-0BDOV3WC). The variant picks the recovery: `NotEligible`
/// is the rebuild-from-snapshot path, `OutOfMemory` is the compacting rewrite. It is decided by the
/// stage that failed, never by the text of an error. The one text inspected is DuckDB's
/// "Out of Memory Error" inside a scan, which is how DuckDB reports that condition.
enum Refusal {
    NotEligible(String),
    /// The previous run was killed between `/api/clear` and the end of its rescan (`clear_in_progress` is 1).
    /// Its own variant, not a `NotEligible` text: `DurableState::restore` must tell a clear from a
    /// schema or version refusal, because the snapshot cards mean the opposite in the two cases
    /// (TRDD-JDQR0HDT).
    ClearInProgress(String),
    OutOfMemory(String),
}

impl Refusal {
    fn text(&self) -> &str {
        match self {
            Refusal::NotEligible(text) | Refusal::OutOfMemory(text) | Refusal::ClearInProgress(text) => text,
        }
    }
}

/// Classify a DuckDB error raised by a scan or a count: out of memory when DuckDB says so,
/// otherwise an ordinary refusal. `what` names the stage that failed.
fn scan_refusal(err: &agentlens_store::duckdb::Error, what: &str) -> Refusal {
    let text = format!("{what}: {err}");
    if err.to_string().contains("Out of Memory Error") {
        Refusal::OutOfMemory(text)
    } else {
        Refusal::NotEligible(text)
    }
}

/// What `open` did with the file (TRDD-0BDOV3WC). `reused()` is true for `Reused` and `Rewritten`.
#[derive(Debug)]
// `Rebuilt`'s reason is logged where the decision is made, and no production path reads the payloads: the
// variants keep them so the outcome is a complete record. Allowed in every build, not only tests.
#[allow(dead_code)]
pub(crate) enum OpenOutcome {
    /// The previous run's file was reused as it stood.
    Reused,
    /// The file was compacted by a rewrite and reused. `warning` is set when the fresh file does not
    /// load at the reopen limit, so the store keeps the rebuild limit.
    Rewritten { rows: usize, bytes_before: u64, bytes_after: u64, warning: Option<String> },
    /// The rewrite failed before the swap; the file was rebuilt from the snapshot.
    RewriteFailed(String),
    /// The reuse was refused; the file was rebuilt from the snapshot.
    Rebuilt(String),
    /// The reuse was refused because an `/api/clear` was in progress; the file was rebuilt EMPTY from the
    /// snapshot path. `CardStore::clear_was_interrupted` reads it (TRDD-JDQR0HDT).
    ClearInterrupted(String),
}

/// The memory limits and the vacuum setting of `open_with_limits` (TRDD-0BDOV3WC, TRDD-USSG465Q). Production passes MEMORY_LIMIT
/// as `read` and `reopen`, and REBUILD_MEMORY_LIMIT as `rebuild`. A test passes a small `read` to
/// reproduce an out-of-memory boot read.
pub(crate) struct OpenLimits<'a> {
    /// The reuse attempt's limit.
    pub(crate) read: &'a str,
    /// The compacting rewrite's limit, boot-only.
    pub(crate) rebuild: &'a str,
    /// The steady-state limit: the fresh file is loaded at it first after the swap (see `finish_swap`).
    pub(crate) reopen: &'a str,
    /// The card database's `vacuum_rebuild_indexes`, applied at every open of the file (see
    /// `VACUUM_REBUILD_INDEXES`). Production passes the constant. A test may pass another value to model a
    /// file that a build with the default setting wrote.
    pub(crate) vacuum_rebuild_indexes: &'a str,
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
    parsed: ResidentCards,
    /// Bumped by every `clear`; slots restart from 0 after one, so a consumer that remembers slot
    /// positions (the summary engine) can tell a restart from ordinary growth.
    epoch: u64,
    /// TRDD-AXJH3WTU: the store write generation. Bumped by `put_arc` (the one card write path, so also every `CoreState::put_log_session`),
    /// by `discard_cards`, and by `demote_cold` once per card it demotes (its stored text changes: `strip_timeline_value` sets
    /// `timelineTruncatedCount` and `timelineRetainedBytes`, which the persisted record keeps). NOT by `clear`
    /// (the clear path has `epoch` and `finish_clear_after_save`). WHY: `DurableState` compares it with the generation its last card save covered, so a writer that
    /// never calls `mark_dirty` (the `/api/import` handler, the on-demand reparse in ui.rs) still reaches the card log at the next
    /// timed tick. A plain `u64`: every writer holds `&mut CardStore` (under the CoreState mutex), so no atomic is needed.
    write_generation: u64,

    /// TRDD-T0G38TZ4 — the corpus byte total, TRACKED on the write path instead of scanned.
    /// WHY a counter: `corpus_bytes` used to run `SELECT count(*), SUM(strlen(card))` over the
    /// whole corpus, and on a 42,908-row / ~84 MB corpus that full scan of the card TEXT column
    /// ran out of memory inside the 256 MiB DuckDB pool — the live server logged "card corpus
    /// UNAVAILABLE: Out of Memory Error" on every 30 s composition tick, under the state lock.
    /// The counter is maintained on exactly the paths that change the stored text (`put_arc`,
    /// `demote_cold`, `clear`, `discard_cards`, and the reopen rebuild in `load_resident`), so it
    /// tracks the SERIALISED length of what is actually stored, and no statement scans the corpus.
    /// A drift between this and the table would be a new silent failure, so the in-module test
    /// `card_bytes_counter_matches_the_duckdb_aggregate` pins it against the aggregate itself.
    card_bytes: u64,
    /// TRDD-KMF02UEX — counts `demote_cold`'s primary-key card fetches (one per demotion candidate).
    /// Exists only so a test can assert that the card text is read for exactly the cards being
    /// demoted, and never when no timeline card lies beyond the hot set.
    demote_card_fetches: std::sync::atomic::AtomicUsize,
    /// TRDD-9VX3WTGU / TRDD-0BDOV3WC — how `open` got this store: reused as it was, rewritten
    /// compactly, or rebuilt from the snapshot, with the reason. `reused()` reads it.
    outcome: OpenOutcome,
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
    /// TRDD-JDQR0HDT: the one refusal that does NOT refill from the snapshot is `clear_in_progress` = 1 (a killed
    /// `/api/clear`): `DurableState::restore` discards the snapshot cards and tombstones both logs, because the
    /// clear meant to drop them. The rebuilt file keeps the flag at 1 until those tombstones are durable.
    ///
    /// TRDD-0BDOV3WC: a reuse that runs out of memory at [`MEMORY_LIMIT`] is not a refusal. The file
    /// is complete but too big for one scan, so it is compacted by a rewrite and reused instead; see
    /// `open_with_limits`.
    ///
    /// On reuse the resident parsed layer is rebuilt here, one parse per card, in `seq` order, and
    /// `next_seq` resumes at `max(seq)+1` (a counter restarting at 0 would sort new cards before
    /// old ones and break the first-insert tie order).
    ///
    /// Prints ONE line naming the decision and its reason (a rewrite prints its own lines).
    ///
    /// No `Default`: a card store without a data dir is not a thing, and the impl only ever
    /// existed to satisfy clippy's `new_without_default`, which does not apply to a constructor
    /// that takes an argument.
    pub fn open(data_dir: &Path) -> CardStore {
        Self::open_with_limits(
            data_dir,
            OpenLimits {
                read: MEMORY_LIMIT,
                rebuild: REBUILD_MEMORY_LIMIT,
                reopen: MEMORY_LIMIT,
                vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES,
            },
        )
    }

    /// The whole `open`, with its three memory limits (see [`OpenLimits`]), in order:
    ///
    /// a. Leftovers of an earlier rewrite (`cards.duckdb.rebuild`, `.rebuild.wal`) are removed. A
    ///    rewrite is the corpus only after its rename, so they are never reused.
    /// b. The reuse attempt at `read`: a file reused as it stands gives `Reused`.
    /// c. Refused as NotEligible: the rebuild-from-snapshot path, `Rebuilt(reason)`.
    ///    A clear in progress (`ClearInProgress`) takes the same path as `ClearInterrupted(reason)`, and
    ///    `DurableState::restore` then also discards the snapshot cards instead of restoring them (TRDD-JDQR0HDT).
    /// d. Refused as OutOfMemory: the compacting rewrite (`rewrite_in_place`). A failure BEFORE the
    ///    rename removes the rebuild files and takes the rebuild-from-snapshot path,
    ///    `RewriteFailed(reason)`. A failure AFTER the rename never deletes `cards.duckdb` (see
    ///    `finish_swap`).
    pub(crate) fn open_with_limits(data_dir: &Path, limits: OpenLimits<'_>) -> CardStore {
        // TRDD-USSG465Q: this probe is the ONLY guard against a setting DuckDB refuses. It runs before any file
        // is removed or opened. Without it, a refused option surfaces in try_reuse as a file that does not open,
        // which maps to NotEligible and deletes cards.duckdb.
        if let Err(e) = card_db_config(limits.vacuum_rebuild_indexes).and_then(Connection::open_in_memory_with_flags) {
            panic!(
                "card store: DuckDB refused vacuum_rebuild_indexes={}: {e}; refusing to touch the card files",
                limits.vacuum_rebuild_indexes
            );
        }
        std::fs::create_dir_all(data_dir).expect("create the data dir for the card store");
        let path = data_dir.join(CARD_DB_FILE);
        let wal = data_dir.join(format!("{CARD_DB_FILE}.wal"));
        remove_rebuild_leftovers(data_dir);
        let (reason, outcome) = match Self::try_reuse(&path, limits.read, limits.vacuum_rebuild_indexes) {
            Ok((conn, resident, next_seq)) => {
                eprintln!(
                    "{} alcore: card store — reusing {CARD_DB_FILE}: {} cards, ingest v{}, schema v{CARD_SCHEMA_VERSION}, restore complete, no clear in progress",
                    crate::log_ts(),
                    resident.cards.len(),
                    crate::log_reader::LOG_INGEST_VERSION
                );
                return Self::assemble(conn, resident, next_seq, OpenOutcome::Reused);
            }
            Err(Refusal::NotEligible(reason)) => (reason.clone(), OpenOutcome::Rebuilt(reason)),
            Err(Refusal::ClearInProgress(reason)) => (reason.clone(), OpenOutcome::ClearInterrupted(reason)),
            Err(Refusal::OutOfMemory(reason)) => {
                eprintln!(
                    "{} alcore: card store — reusing {CARD_DB_FILE} ran out of memory at {} ({reason}); rewriting it compactly at {}",
                    crate::log_ts(),
                    limits.read,
                    limits.rebuild
                );
                match Self::rewrite_in_place(data_dir, &path, &limits) {
                    Ok((conn, resident, next_seq, outcome)) => return Self::assemble(conn, resident, next_seq, outcome),
                    Err(failure) => {
                        remove_rebuild_leftovers(data_dir);
                        eprintln!(
                            "{} alcore: card store rewrite failed: {failure}; falling back to a rebuild from the snapshot",
                            crate::log_ts()
                        );
                        (failure.clone(), OpenOutcome::RewriteFailed(failure))
                    }
                }
            }
        };
        eprintln!(
            "{} alcore: card store — NOT reusing {CARD_DB_FILE} ({reason}); starting empty, a full restore from the card snapshot rebuilds it",
            crate::log_ts()
        );
        // Best-effort: a missing file is the NORMAL case (first boot), so this cannot be an
        // `expect`. The `DROP TABLE IF EXISTS` below is what actually guarantees an empty corpus.
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&wal);
        let conn = open_conn(&path, limits.vacuum_rebuild_indexes)
            .unwrap_or_else(|e| panic!("open the card store at {}: {e}", path.display()));
        Self::configure(&conn, limits.reopen).expect("configure the card store connection");
        // TRDD-JDQR0HDT: a rebuild that follows an interrupted clear keeps `clear_in_progress` at 1. WHY: the
        // card snapshot is still on disk and `DurableState::restore` has not yet tombstoned it. A death (or a load
        // error) in that window would otherwise leave a store flagged 0 next to the full snapshot, and the next
        // start would restore every snapshot card, which is the bug again. `finish_clear` runs only after the
        // tombstones are durable.
        let clear_flag = u8::from(matches!(outcome, OpenOutcome::ClearInterrupted(_)));
        // `restore_complete` starts at 0: only the end of a full restore (`mark_restore_complete`)
        // vouches for the corpus, so a boot killed half-way through the restore is rebuilt.
        conn.execute_batch(&format!(
            "DROP TABLE IF EXISTS cards; DROP TABLE IF EXISTS meta; {SCHEMA}; {META_SCHEMA};
             INSERT INTO meta VALUES ('ingest_version', '{}'), ('card_schema_version', '{CARD_SCHEMA_VERSION}'),
                                     ('restore_complete', '0'), ('clear_in_progress', '{clear_flag}');",
            crate::log_reader::LOG_INGEST_VERSION
        ))
        .expect("create the card store schema");
        Self::assemble(conn, Resident { cards: IndexMap::new(), bytes: 0 }, 0, outcome)
    }

    /// The one constructor: every outcome of `open` ends here.
    fn assemble(
        conn: Connection,
        resident: Resident,
        next_seq: i64,
        outcome: OpenOutcome,
    ) -> CardStore {
        CardStore {
            conn,
            next_seq,
            full_scan_calls: std::sync::atomic::AtomicUsize::new(0),
            demote_card_fetches: std::sync::atomic::AtomicUsize::new(0),
            parsed: resident.cards,
            // TRDD-T0G38TZ4: the tracked byte total starts at what the resident layer was built
            // from. For a reused store that is the corpus's real size (measured row by row in
            // `load_resident`); for a fresh one it is 0, because the table is empty.
            card_bytes: resident.bytes,
            epoch: 0,
            write_generation: 0,
            outcome,
        }
    }

    /// The thread count is `crate::cores::duckdb_threads()` (TRDD-YH822LDI), the same as the
    /// statusline store connection: these are point queries and a 32k-row sort, not an analytical
    /// scan, and a per-connection thread pool sized to the machine would be pure overhead in a
    /// process that already runs its own executor.
    ///
    /// NOT `SET temp_directory=''` (which the Parquet stores use to make an over-limit query FAIL
    /// rather than spill): here a spill is the intended behaviour of a bounded buffer pool, and
    /// failing the summary rebuild instead would lose the whole corpus from the wire.
    ///
    /// `limit` is the buffer pool's ceiling: [`MEMORY_LIMIT`] in production, [`REBUILD_MEMORY_LIMIT`]
    /// for the compacting rewrite, and a smaller value only in a test that needs an out-of-memory read.
    fn configure(conn: &Connection, limit: &str) -> agentlens_store::duckdb::Result<()> {
        conn.execute_batch(&format!("SET memory_limit='{limit}'; SET threads={};", crate::cores::duckdb_threads()))
    }

    /// The reuse attempt at `read_limit` (see `open`): the gate — the file opens, `configure`, then
    /// `check_meta` — followed by `load_resident`. `Ok` is the reusable corpus. Every `Err` drops the
    /// connection before returning, releasing the file for the caller to delete or rewrite.
    ///
    /// WHY the resident scan is part of the gate: before reuse a corrupt file healed itself because
    /// every start deleted it; now a bad row would panic on EVERY start, permanently. `count(*)` alone
    /// is answered from metadata, so it does not prove the card column is readable — only reading and
    /// parsing every card does.
    fn try_reuse(
        path: &Path,
        read_limit: &str,
        vacuum_rebuild_indexes: &str,
    ) -> Result<(Connection, Resident, i64), Refusal> {
        if !path.exists() {
            return Err(Refusal::NotEligible("no database file".to_owned()));
        }
        let conn = open_conn(path, vacuum_rebuild_indexes)
            .map_err(|e| Refusal::NotEligible(format!("the file does not open cleanly: {e}")))?;
        Self::configure(&conn, read_limit)
            .map_err(|e| Refusal::OutOfMemory(format!("cannot configure the connection at {read_limit}: {e}")))?;
        Self::check_meta(&conn)?;
        let (resident, next_seq) = Self::load_resident(&conn)?;
        Ok((conn, resident, next_seq))
    }

    /// Rebuild the resident parsed layer from the table: one parse per card, `seq` order, plus the
    /// next ordinal. The same shape `put_arc` leaves behind, so a reused store and a restored one
    /// serve the same summary.
    ///
    /// TRDD-T0G38TZ4 — the byte total is accumulated HERE, from the very text the rows hold, so a
    /// reopened store's counter starts at the corpus's real size and never needs a scan to learn
    /// it. `json.len()` is the byte length of the stored VARCHAR — the same number DuckDB's
    /// `strlen(card)` reports for it (both count UTF-8 bytes, not characters).
    fn load_resident(conn: &Connection) -> Result<(Resident, i64), Refusal> {
        let mut stmt = conn
            .prepare(RESIDENT_SCAN_SQL)
            .map_err(|e| scan_refusal(&e, "cannot prepare the resident-layer scan"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| scan_refusal(&e, "the cards table is unreadable"))?;
        let mut parsed = IndexMap::new();
        let mut bytes: u64 = 0;
        for r in rows {
            let (id, json) = r.map_err(|e| scan_refusal(&e, "a card row is unreadable"))?;
            let card = serde_json::from_str(&json)
                .map_err(|e| Refusal::NotEligible(format!("card {id} is not valid JSON: {e}")))?;
            // TRDD-T0G38TZ4: the stored length rides with the card, so a later upsert knows how
            // many bytes this row occupies WITHOUT re-serialising the card to find out.
            let stored_len = json.len() as u64;
            bytes += stored_len;
            parsed.insert(id, ResidentCard { card: Arc::new(card), stored_len });
        }
        drop(stmt);
        let next_seq: i64 = conn
            .query_row("SELECT COALESCE(MAX(seq), -1) + 1 FROM cards", [], |r| r.get(0))
            .map_err(|e| scan_refusal(&e, "cannot read the next card ordinal"))?;
        Ok((Resident { cards: parsed, bytes }, next_seq))
    }

    /// The meta checks and the row count of the reuse gate (see `try_reuse`), shared with the rewrite,
    /// which must not copy a database the gate would refuse. Every meta failure is `NotEligible`: an
    /// out-of-memory meta read means meta was never validated, which is the rebuild path. The count is
    /// classified by `scan_refusal`.
    fn check_meta(conn: &Connection) -> Result<(), Refusal> {
        let mut stmt = conn.prepare("SELECT key, value FROM meta").map_err(|e| {
            Refusal::NotEligible(format!("no readable meta table (a database from before the reuse gate): {e}"))
        })?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| Refusal::NotEligible(format!("meta table unreadable: {e}")))?;
        let meta: std::collections::HashMap<String, String> = rows
            .collect::<Result<_, _>>()
            .map_err(|e| Refusal::NotEligible(format!("meta table unreadable: {e}")))?;
        drop(stmt);
        let want_ingest = crate::log_reader::LOG_INGEST_VERSION.to_string();
        let want_schema = CARD_SCHEMA_VERSION.to_string();
        let get = |k: &str| meta.get(k).map(String::as_str);
        // TRDD-JDQR0HDT: checked FIRST. A store rebuilt after an interrupted clear carries `clear_in_progress` = 1 AND
        // `restore_complete` = 0 until the tombstones are written; if the restore-complete check ran first, a death in
        // that window would be refused as a plain "restore never completed" and the snapshot would be restored.
        // Only an explicit "1" is a clear; a missing or garbled value stays an ordinary refusal below. Because this runs
        // before the version checks, a clear in progress next to a stale ingest or schema version is still a clear and
        // discards the snapshot: a clear the user asked for wins over a layout change (intended; tested by
        // `a_clear_in_progress_wins_over_a_schema_version_mismatch`).
        if get("clear_in_progress") == Some("1") {
            return Err(Refusal::ClearInProgress("an /api/clear was in progress".to_owned()));
        }
        if get("ingest_version") != Some(want_ingest.as_str()) {
            return Err(Refusal::NotEligible(format!("ingest version {:?} != {want_ingest}", get("ingest_version"))));
        }
        if get("card_schema_version") != Some(want_schema.as_str()) {
            return Err(Refusal::NotEligible(format!(
                "card schema version {:?} != {want_schema}",
                get("card_schema_version")
            )));
        }
        if get("restore_complete") != Some("1") {
            return Err(Refusal::NotEligible("the previous restore never completed".to_owned()));
        }
        if get("clear_in_progress") != Some("0") {
            return Err(Refusal::NotEligible(format!("clear_in_progress {:?} is not 0", get("clear_in_progress"))));
        }
        // The table itself must be readable too: a header that opens but a card table that does not
        // is exactly the damage a reuse must not paper over.
        conn.query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))
            .map_err(|e| scan_refusal(&e, "the cards table is unreadable"))?;
        Ok(())
    }


    /// TRDD-0BDOV3WC step d — copy every card and meta row of `path` into `<data_dir>/cards.duckdb.rebuild`
    /// through one connection at `rebuild_limit`, and return the copied card count. The source is read
    /// through the same meta and count checks as the reuse gate, so a database the gate would refuse is
    /// never copied. The copy's schema is `SCHEMA` and `META_SCHEMA` with only the table names qualified
    /// (one source for the layout, so the copy cannot drift from what `open` creates); the two indexes keep
    /// their unqualified names, which DuckDB requires.
    fn rewrite_compact(data_dir: &Path, path: &Path, rebuild_limit: &str) -> Result<usize, String> {
        let rebuild = data_dir.join(format!("{CARD_DB_FILE}.rebuild"));
        // TRDD-USSG465Q: the source is opened plain on purpose. This connection only reads the old file and runs one
        // checkpoint, so it has no use for the vacuum option. Its one bulk INSERT goes into the fresh file and deletes nothing.
        let conn = Connection::open(path).map_err(|e| format!("open {} for the rewrite: {e}", path.display()))?;
        Self::configure(&conn, rebuild_limit)
            .map_err(|e| format!("configure the rewrite connection at {rebuild_limit}: {e}"))?;
        Self::check_meta(&conn).map_err(|refusal| refusal.text().to_owned())?;
        let rebuild_sql = rebuild.display().to_string().replace('\'', "''");
        let fresh_schema =
            SCHEMA.replace("CREATE TABLE cards", "CREATE TABLE fresh.cards").replace("ON cards", "ON fresh.cards");
        let fresh_meta = META_SCHEMA.replace("CREATE TABLE meta", "CREATE TABLE fresh.meta");
        conn.execute_batch(&format!(
            "ATTACH '{rebuild_sql}' AS fresh;
             {fresh_schema};
             {fresh_meta};
             INSERT INTO fresh.cards SELECT * FROM cards;
             INSERT INTO fresh.meta SELECT * FROM meta;"
        ))
        .map_err(|e| format!("copy the corpus into {}: {e}", rebuild.display()))?;
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM fresh.cards", [], |r| r.get(0))
            .map_err(|e| format!("count the copied cards: {e}"))?;
        conn.execute_batch("CHECKPOINT fresh; DETACH fresh; FORCE CHECKPOINT")
            .map_err(|e| format!("checkpoint {}: {e}", rebuild.display()))?;
        // WHY the explicit close: a dropped duckdb-rs connection swallows its close error, and a close
        // error here means the rewrite's WAL state is unknown. Returning Err leaves the WAL untouched.
        conn.close().map_err(|(_, e)| format!("close the rewrite connection: {e}"))?;
        Ok(rows as usize)
    }

    /// TRDD-0BDOV3WC steps d to f: copy the corpus into `cards.duckdb.rebuild`, swap it in, and load it.
    /// Every `Err` comes BEFORE the rename, so `cards.duckdb` is still the previous file and the caller may
    /// take the rebuild-from-snapshot path. After the rename nothing returns `Err` (see `finish_swap`).
    fn rewrite_in_place(
        data_dir: &Path,
        path: &Path,
        limits: &OpenLimits<'_>,
    ) -> Result<(Connection, Resident, i64, OpenOutcome), String> {
        let bytes_before = std::fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?.len();
        let rows = Self::rewrite_compact(data_dir, path, limits.rebuild)?;
        if let Some(warning) = swap_in_rebuild(data_dir)? {
            eprintln!(
                "{} alcore: card store — WARNING: {warning}; the rewritten {CARD_DB_FILE} is in place and is kept",
                crate::log_ts()
            );
        }
        Ok(Self::finish_swap(path, rows, bytes_before, limits))
    }

    /// TRDD-0BDOV3WC — after the rename the fresh file IS the corpus, so nothing here may delete
    /// `cards.duckdb`. WHY: today's delete-and-rebuild path would throw away the complete fresh file and
    /// rebuild from the card snapshot, which lags the live corpus — the very loss this rewrite exists to
    /// prevent. So a refusal here panics, naming the file that is kept, instead of returning `Err`.
    ///
    /// WHY the reopen limit is tried FIRST: the normal path then loads the resident layer with DuckDB's pool
    /// at the read limit (256 MiB), and only a file that does not fit there is loaded at the rebuild limit,
    /// with a warning. Measured (reports_dev/0bdov3wc-impl-report.md, section 9): this order lowered the peak
    /// RSS from 1.95 GB to 1.85 GB, so the DuckDB pool is a small part of the peak. The composition log lines
    /// report the mimalloc live size (about 0.5 to 0.9 GB), which is the larger share.
    fn finish_swap(
        path: &Path,
        rows: usize,
        bytes_before: u64,
        limits: &OpenLimits<'_>,
    ) -> (Connection, Resident, i64, OpenOutcome) {
        let bytes_after = std::fs::metadata(path)
            .unwrap_or_else(|e| panic!("stat the rewritten {}: {e}; the file is kept", path.display()))
            .len();
        // TRDD-T0G38TZ4: the resident layer and the tracked byte total come from the SAME
        // `try_reuse` call, so the reopened store's counter describes the corpus it actually holds.
        let (conn, resident, next_seq, warning) =
            match Self::try_reuse(path, limits.reopen, limits.vacuum_rebuild_indexes) {
                Ok((conn, resident, next_seq)) => (conn, resident, next_seq, None),
                Err(Refusal::OutOfMemory(reason)) => {
                    let (conn, resident, next_seq) =
                        Self::try_reuse(path, limits.rebuild, limits.vacuum_rebuild_indexes).unwrap_or_else(|refusal| {
                            panic!(
                                "the rewritten {} does not load at the rebuild limit {}: {}; the file is kept",
                                path.display(),
                                limits.rebuild,
                                refusal.text()
                            )
                        });
                    let warning = format!("the fresh file does not load at the reopen limit {}: {reason}", limits.reopen);
                    (conn, resident, next_seq, Some(warning))
                }
                Err(Refusal::NotEligible(reason) | Refusal::ClearInProgress(reason)) => panic!(
                    "the rewritten {} does not load at the reopen limit {}: {reason}; the file is kept",
                    path.display(),
                    limits.reopen
                ),
            };
        let running = if warning.is_some() { limits.rebuild } else { limits.reopen };
        if let Some(w) = &warning {
            eprintln!(
                "{} alcore: card store — WARNING: the live card data has outgrown the read limit {} ({w}); the store keeps the rebuild limit {} (TRDD-USSG465Q owns the cause)",
                crate::log_ts(),
                limits.reopen,
                limits.rebuild
            );
        }
        eprintln!(
            "{} alcore: card store — rewrote {CARD_DB_FILE} compactly: {rows} cards, {bytes_before} bytes before, {bytes_after} after; reusing it at memory limit {running}",
            crate::log_ts()
        );
        (conn, resident, next_seq, OpenOutcome::Rewritten { rows, bytes_before, bytes_after, warning })
    }


    /// True when `open` kept the previous run's corpus: reused as it stood, or compacted and reused.
    pub fn reused(&self) -> bool {
        matches!(self.outcome, OpenOutcome::Reused | OpenOutcome::Rewritten { .. })
    }

    /// True when `open` refused the previous run's file because an `/api/clear` was in progress. The rebuilt file
    /// is empty but keeps `clear_in_progress` at 1 until `DurableState::restore` has tombstoned the snapshot and
    /// calls `finish_clear`; this accessor is how `restore` learns the reason (TRDD-JDQR0HDT).
    pub fn clear_was_interrupted(&self) -> bool {
        matches!(self.outcome, OpenOutcome::ClearInterrupted(_))
    }

    /// How `open` got this store (see [`OpenOutcome`]). Read by the tests only.
    #[cfg(test)]
    pub(crate) fn open_outcome(&self) -> &OpenOutcome {
        &self.outcome
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

    /// TRDD-PGMMB2QG increment B: the `clear_in_progress` flag of this LIVE store, for the tests only. WHY: the
    /// test helper that reads the flag from the file needs the store closed (a second connection to a file this
    /// process has open is a second writer), and the two-clear test must read the flag between two calls on the same store.
    #[cfg(test)]
    pub(crate) fn clear_in_progress_for_test(&self) -> String {
        self.conn
            .query_row("SELECT value FROM meta WHERE key = 'clear_in_progress'", [], |r| r.get(0))
            .expect("read the clear_in_progress flag")
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
        // TRDD-AXJH3WTU: a removal outside the clear path moves the generation too (see the field).
        self.write_generation += 1;
        self.next_seq = 0;
        self.parsed.clear();
        // TRDD-T0G38TZ4: the table is empty, so the tracked byte total is 0.
        self.card_bytes = 0;
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
        // TRDD-T0G38TZ4 — the tracked byte total. An UPSERT, so the OLD card's bytes leave the
        // total and the NEW card's bytes enter it.
        //
        // WHY the old length is the resident card's CARRIED length: the stored text IS
        // `serde_json::to_string` of the resident card (this function wrote it, and `demote_cold`
        // keeps the two in step), and `ResidentCard::stored_len` is that exact byte count. It is
        // carried, NOT recomputed: re-serialising the resident card here would serialise every
        // ingested card TWICE on the hottest write path (cards reach 2.3 MB).
        //
        // WHY the new length is `json.len()` and not the card's size before the persist-strip:
        // `json` is what is ACTUALLY stored, and the counter must describe the table, not the
        // input card.
        let old_len: u64 = self.parsed.get(&id).map_or(0, |c| c.stored_len);
        let new_len = json.len() as u64;
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
        // TRDD-AXJH3WTU: every card put moves the generation, see the field.
        self.write_generation += 1;
        self.parsed.insert(id, ResidentCard { card, stored_len: new_len });
        // TRDD-T0G38TZ4 — the tracked total follows the table: the old card's bytes leave, the
        // new card's bytes enter. A first insert adds; an upsert replaces.
        self.card_bytes = self.card_bytes + new_len - old_len;
    }

    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))
            .expect("count the session cards") as usize
    }

    /// (row count, total JSON-text BYTES) over the corpus. TRDD-2JOIAH2G's composition breakdown:
    /// the caller reports what the card corpus IS so the mimalloc commit number can be interpreted
    /// against it.
    ///
    /// TRDD-T0G38TZ4 — NO DuckDB statement runs here any more. This used to be one aggregate,
    /// `SELECT count(*), COALESCE(SUM(strlen(card)), 0)::BIGINT FROM cards`, and on a 42,908-row /
    /// ~84 MB corpus that full scan of the card TEXT column ran out of memory inside the 256 MiB
    /// pool (`MEMORY_LIMIT`): the live server logged "card corpus UNAVAILABLE: Out of Memory
    /// Error" on every 30 s composition tick, under the state lock. The count and the byte total
    /// are now TRACKED on the write path (`card_bytes`, see the field), so the metric is O(1) and
    /// can never fail.
    ///
    /// The byte total is the SERIALISED length of what is ACTUALLY stored, which is the same
    /// number the old aggregate reported: `strlen` is DuckDB's byte-length function (UTF-8
    /// aware), and `serde_json::to_string` emits the same bytes the table holds.
    ///
    /// Returns `Result` (unlike `len`, which expects) because the caller is a recurring
    /// diagnostics tick with a print-an-unavailable-and-continue contract, not a fail-fast
    /// request path. The shape is kept so the caller does not change; it is always `Ok` now.
    pub fn corpus_bytes(&self) -> agentlens_store::duckdb::Result<(usize, u64)> {
        Ok((self.parsed.len(), self.card_bytes))
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
        // TRDD-T0G38TZ4: the table is empty, so the tracked byte total is 0.
        self.card_bytes = 0;
        self.epoch += 1;
    }

    /// TRDD-AXJH3WTU: see the field. `DurableState::tick` and `save_cards` read it under the state lock.
    pub fn write_generation(&self) -> u64 {
        self.write_generation
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
            // TRDD-T0G38TZ4 — the tracked byte total follows the demotion. The OLD stored text is
            // `json` (the row's own text, fetched above) and the NEW stored text is `stripped`, so
            // the delta is exact and needs no re-serialisation of the resident card.
            let bytes_delta = stripped.len() as i64 - json.len() as i64;
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
                if let Some(obj) = Arc::make_mut(&mut resident.card).as_object_mut() {
                    crate::log_reader::strip_timeline_value(obj);
                    persist_strip_map(obj);
                }
                // TRDD-T0G38TZ4: the resident card now describes the STRIPPED text, so its
                // carried length must follow — otherwise the next upsert of this card would
                // subtract a length the table never had.
                resident.stored_len = stripped.len() as u64;
            }
            // TRDD-T0G38TZ4: the table holds `stripped` now, so the tracked total moves by the
            // same delta. Applied AFTER the UPDATE committed, for the same reason the resident
            // strip is: a failed UPDATE must leave the counter describing the table.
            self.card_bytes = (self.card_bytes as i64 + bytes_delta) as u64;
            // TRDD-AXJH3WTU: the table holds the new text, so the generation moves here, once per UPDATE. A bump after the loop would be
            // skipped by the `?` returns above it, which leave the cards demoted before the failing one changed in the table.
            // WHY the card log must see it: a demotion alone, with no put in the same lock hold, must still reach the card log.
            self.write_generation += 1;
            demoted += 1;
        }
        Ok(demoted)
    }

    /// Every card as a shared pointer, first-insert order — the summary rebuild input. One
    /// refcount bump per card; no text copy, no parse (TRDD-9VX3WTGU Phase C). `cards()` /
    /// `cards_json()` stay for the cold-boot, CLI and parity paths that read the TABLE.
    pub fn parsed_cards(&self) -> Vec<Arc<Value>> {
        self.parsed.values().map(|c| c.card.clone()).collect()
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
        self.parsed.values().map(|c| c.card.clone()).collect()
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

    /// TRDD-735Q3JF4 item 3 — a second connection to the same card database, for a read that runs OFF
    /// the `CoreState` lock (`ui::composition_projects`). `try_clone` opens a connection on the same
    /// database instance, so the clone sees every committed write. WHY not read under the guard: a
    /// DuckDB read holds every other request behind the lock for its whole duration. A failed clone is returned, not
    /// panicked: the caller is the resident-blob scan, which warns and keeps its last cache.
    pub(crate) fn read_connection(&self) -> Result<Connection, String> {
        self.conn.try_clone().map_err(|e| format!("clone the card store connection for the composition read: {e}"))
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

/// TRDD-735Q3JF4 item 3 — the card rows `ui::composition_projects` reads, for the bodies closure `ids`:
/// each id's own row, its `agent-` twin and the placeholder that twin names. The feed merge decides a
/// row's fate only from those rows, so the closure is exact. One object per row, holding the JSON
/// VALUES of the fields the merge and the project resolver read. `json_extract` keeps each value's JSON
/// type: a number stays a number (`feed_merge::f` reads `as_f64`), and an absent field is null, which
/// every reader treats as absent. WHY not `json_extract_string`: it turns `8000` into the string "8000",
/// and the merge would then read that card as 0 tokens. A failed step returns an error naming it, never a panic:
/// the caller is the resident-blob scan, which warns and keeps its last cache.
pub(crate) fn composition_rows(conn: &Connection, ids: &[String]) -> Result<Vec<Value>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let marks = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT CAST(json_object(
             'sessionId', json_extract(card, '$.sessionId'),
             'source', json_extract(card, '$.source'),
             'dataSource', json_extract(card, '$.dataSource'),
             'parentSessionId', json_extract(card, '$.parentSessionId'),
             'projectPath', json_extract(card, '$.projectPath'),
             'workspace', json_extract(card, '$.workspace'),
             'inputTokens', json_extract(card, '$.inputTokens'),
             'outputTokens', json_extract(card, '$.outputTokens'),
             'cacheReadTokens', json_extract(card, '$.cacheReadTokens'),
             'cacheCreateTokens', json_extract(card, '$.cacheCreateTokens')
         ) AS VARCHAR)
         FROM cards WHERE session_id IN ({marks})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare the composition card read: {e}"))?;
    let rows = stmt
        .query_map(agentlens_store::duckdb::params_from_iter(ids.iter()), |r| r.get::<_, String>(0))
        .map_err(|e| format!("run the composition card read: {e}"))?;
    rows.map(|row| {
        let text = row.map_err(|e| format!("read a composition card row: {e}"))?;
        serde_json::from_str::<Value>(&text).map_err(|e| format!("parse a composition card row: {e}"))
    })
    .collect()
}

/// A stored card is a string THIS process wrote with `serde_json::to_string`; a parse failure
/// means the table was corrupted in memory, which is not a condition to paper over.
fn parse(json: &str) -> Value {
    serde_json::from_str(json).expect("a stored session card parses")
}

/// TRDD-0BDOV3WC step a — removes what a rewrite leaves before its rename, one log line per file. A
/// rewrite is the corpus only after its rename, so these files are never reused. Absent files are the
/// normal case and are not an error.
fn remove_rebuild_leftovers(data_dir: &Path) {
    for name in [format!("{CARD_DB_FILE}.rebuild"), format!("{CARD_DB_FILE}.rebuild.wal")] {
        let file = data_dir.join(&name);
        match std::fs::remove_file(&file) {
            Ok(()) => eprintln!("{} alcore: card store — removed the leftover {name} of an earlier rewrite", crate::log_ts()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => panic!("remove the leftover {}: {e}", file.display()),
        }
    }
}

/// TRDD-0BDOV3WC step e — makes `<data_dir>/cards.duckdb.rebuild` the database. Every failure before the
/// rename is `Err`, and the caller removes the rebuild files, so the previous file stays. ORDER IS
/// LOAD-BEARING: the WAL is removed BEFORE the rename, so a stale WAL never sits beside the new file
/// (DuckDB would replay it into the copy). A crash before the rename leaves the old checkpointed file plus
/// leftovers, which the next boot removes; a crash after it leaves the complete fresh file. After the
/// rename only the directory sync can fail: that is `Ok(Some(warning))`, because the fresh file is in place
/// and must not be deleted.
fn swap_in_rebuild(data_dir: &Path) -> Result<Option<String>, String> {
    let path = data_dir.join(CARD_DB_FILE);
    let rebuild = data_dir.join(format!("{CARD_DB_FILE}.rebuild"));
    let wal = data_dir.join(format!("{CARD_DB_FILE}.wal"));
    // WHY refuse a rebuild WAL that holds rows: the swap renames only the file, so rows still in the
    // rebuild's WAL would be lost when the rebuild file replaces cards.duckdb. Checkpointing on close should
    // leave the WAL empty; a non-empty one is a defect, and failing here (before the rename) keeps the rows.
    let rebuild_wal = data_dir.join(format!("{CARD_DB_FILE}.rebuild.wal"));
    match std::fs::metadata(&rebuild_wal) {
        Ok(meta) if meta.len() > 0 => {
            return Err(format!("{} holds {} uncheckpointed bytes; refusing to swap its file in", rebuild_wal.display(), meta.len()));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("stat {}: {e}", rebuild_wal.display())),
    }
    if wal.exists() {
        std::fs::remove_file(&wal).map_err(|e| format!("remove {}: {e}", wal.display()))?;
    }
    std::fs::File::open(&rebuild)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("sync {}: {e}", rebuild.display()))?;
    std::fs::rename(&rebuild, &path)
        .map_err(|e| format!("rename {} over {}: {e}", rebuild.display(), path.display()))?;
    #[cfg(unix)]
    {
        if let Err(e) = std::fs::File::open(data_dir).and_then(|dir| dir.sync_all()) {
            return Ok(Some(format!("sync the data dir after the rename: {e}")));
        }
    }
    Ok(None)
}

/// TRDD-USSG465Q: the connection config of every open of the card file. It carries the option
/// `vacuum_rebuild_indexes` (see `VACUUM_REBUILD_INDEXES`) and the thread count (TRDD-YH822LDI), so
/// the cap applies from the open itself, before any statement runs. A `Config` is consumed by
/// `open_with_flags`, so each open builds its own.
fn card_db_config(value: &str) -> agentlens_store::duckdb::Result<agentlens_store::duckdb::Config> {
    let threads = crate::cores::duckdb_threads().to_string();
    agentlens_store::duckdb::Config::default().with("vacuum_rebuild_indexes", value)?.with("threads", &threads)
}

/// TRDD-USSG465Q: opens the card file with the option applied. It returns the open's own errors
/// unchanged; no caller matches on error text.
fn open_conn(path: &Path, value: &str) -> agentlens_store::duckdb::Result<Connection> {
    Connection::open_with_flags(path, card_db_config(value)?)
}

/// TRDD-PGMMB2QG: the `clear_in_progress` flag of the card store under `store_dir`, read from the file.
/// The store must be closed (two live stores over one file are two writers). The `log_reader` tests call
/// it; it lives here, in the module that owns the file, so `log_reader.rs` opens no store itself
/// (`scripts/check-duckdb-only.js` counts the files that open one). It returns the value, never a handle.
#[cfg(test)]
pub(crate) fn clear_flag_on_disk_for_test(store_dir: &Path) -> String {
    Connection::open(store_dir.join(CARD_DB_FILE))
        .unwrap()
        .query_row("SELECT value FROM meta WHERE key = 'clear_in_progress'", [], |r| r.get(0))
        .unwrap()
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
        // TRDD-MEPIRHI4 box 2: abort, not skip-and-continue. Four candidates (s3, s2, s1, s0; s4 is hot):
        // the pass stops at the second, so a skip that reported its failures at the end would fetch all four.
        assert_eq!(s.demote_card_fetches(), 2, "the pass must stop at the first failing card");
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
    /// TRDD-ZRXECDAQ — the limit sits mid-window in THIS test's own sequence (one store: old query,
    /// candidate_ids, demote_cold), measured 5 runs per limit at 6afa002b on macOS arm64 and on
    /// linux/amd64 (emulated, Debian), identical counts on both (reports_dev/zrx-seq-probe.md):
    /// demote_cold fails at 6656 KiB and succeeds from 7168; the old query fails through 8192 KiB
    /// and passes at 8448, where on a fresh store it still failed 1 run in 3, so that edge is not
    /// deterministic. 7680 KiB is at least 512 KiB from both edges (6656-7168, 8192-8448). The
    /// earlier 8 MiB setting had at most 256 KiB to the old-query edge. A DuckDB bump can move these
    /// edges: re-measure on both platforms. With 4 KB entries no limit separates the two queries
    /// (the UPDATEs then need more memory than the old query), hence 1 KB.
    #[test]
    fn demote_cold_succeeds_where_the_old_one_shot_query_runs_out_of_memory() {
        let mut s = CardStore::open(&data_dir("demote-oom"));
        // FIRST, before any put: DuckDB refuses to switch the temp directory once it has been used,
        // and with spilling allowed the old query could spill instead of failing.
        s.conn.execute_batch("SET temp_directory=''").expect("forbid spilling");
        fill(&mut s, 50, 20, 1000);
        // Checked: below current usage the SET itself fails, and an ignored failure would leave
        // the limit unchanged and the test passing vacuously.
        s.conn.execute_batch("SET memory_limit='7680KiB'").expect("lower the memory limit");
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
    fn the_connection_is_bounded_and_uses_the_core_cap_threads() {
        let store = CardStore::open(&data_dir("settings"));
        let mem: String = store
            .conn
            .query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0))
            .expect("read back memory_limit");
        assert!(mem.starts_with("256"), "the buffer pool must be capped at {MEMORY_LIMIT}, got {mem}");
        let threads: i64 =
            store.conn.query_row("SELECT current_setting('threads')", [], |r| r.get(0)).expect("read back threads");
        assert_eq!(
            threads,
            crate::cores::duckdb_threads() as i64,
            "card connections run at the core cap's DuckDB share (TRDD-YH822LDI)"
        );
    }

    /// TRDD-USSG465Q — the card file opens with `vacuum_rebuild_indexes` at u64::MAX, both on the first open and on
    /// the reuse path that every later boot takes. The expected value is the literal, not the constant, so a changed
    /// constant cannot pass the test.
    #[test]
    fn the_card_file_opens_with_vacuum_rebuild_indexes_at_u64_max() {
        let dir = data_dir("vacuum-setting");
        let setting = |store: &CardStore| -> String {
            store
                .conn
                .query_row("SELECT value FROM duckdb_settings() WHERE name = ?", ["vacuum_rebuild_indexes"], |r| r.get(0))
                .expect("read back vacuum_rebuild_indexes")
        };
        let store = CardStore::open(&dir);
        assert_eq!(setting(&store), "18446744073709551615", "the first open must apply u64::MAX");
        store.mark_restore_complete();
        drop(store);
        let reused = CardStore::open(&dir);
        assert!(reused.reused(), "the second open must take the reuse path");
        assert_eq!(setting(&reused), "18446744073709551615", "the reuse path must apply u64::MAX too");
    }

    /// TRDD-USSG465Q — eleven rounds of upserts of the same eight cards, each checkpointed, leave the file no bigger
    /// than after the first round: the dead rows of earlier versions are reclaimed, not kept.
    #[test]
    fn repeated_upserts_do_not_grow_the_card_file() {
        let dir = data_dir("vacuum-growth");
        let mut s = CardStore::open(&dir);
        let mut used = Vec::new();
        for round in 0..11 {
            for id in 0..8 {
                s.put(&blob_card(id, round));
            }
            s.conn.execute_batch("CHECKPOINT").expect("checkpoint the round");
            used.push(
                s.conn
                    .query_row("SELECT used_blocks FROM pragma_database_size()", [], |r| r.get::<_, i64>(0))
                    .expect("read the used blocks"),
            );
        }
        assert!(
            used[10] <= used[0] + 2,
            "the used blocks grew from {} after round 1 to {} after round 11: {used:?}",
            used[0],
            used[10]
        );
    }

    /// TRDD-USSG465Q — a setting DuckDB refuses panics before any card file is touched, and the file keeps its bytes.
    #[test]
    fn a_refused_vacuum_setting_panics_before_the_card_file_is_touched() {
        let dir = data_dir("vacuum-refused");
        let mut s = CardStore::open(&dir);
        for id in 0..3 {
            s.put(&blob_card(id, 0));
        }
        s.mark_restore_complete();
        drop(s);
        let path = dir.join(CARD_DB_FILE);
        let before = std::fs::read(&path).expect("read the card file before the refused open");
        let payload = match std::panic::catch_unwind(|| {
            CardStore::open_with_limits(
                &dir,
                OpenLimits {
                    read: MEMORY_LIMIT,
                    rebuild: REBUILD_MEMORY_LIMIT,
                    reopen: MEMORY_LIMIT,
                    vacuum_rebuild_indexes: "not-a-number",
                },
            )
        }) {
            Ok(_) => panic!("a refused setting must panic, not open the store"),
            Err(payload) => payload,
        };
        let message = payload
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default();
        assert!(message.contains("refusing to touch the card files"), "the panic must name the refusal: {message}");
        assert_eq!(std::fs::read(&path).ok(), Some(before), "the card file must keep its bytes");
    }

    /// TRDD-0BDOV3WC — one card of the churn corpus: a root card with a 270000-character payload whose
    /// last-active instant moves with `round`, so every round is an upsert that changes the row.
    fn blob_card(id: usize, round: usize) -> Value {
        serde_json::json!({
            "sessionId": format!("c{id}"),
            "source": "claude_code",
            "startTime": "2026-08-01T10:00:00.000Z",
            "durationMs": ((round * 8 + id + 1) * 1000) as f64,
            "payload": "x".repeat(270_000),
        })
    }

    /// TRDD-0BDOV3WC — the churn corpus: 8 cards and 1 + 10 rounds of puts through the production path, so
    /// the file holds the dead rows of 88 upserts. With `keep_wal` the last round is left in the WAL.
    fn churned_corpus(dir: &Path, keep_wal: bool) {
        // TRDD-USSG465Q: an OLD-build file. At "0" the setting keeps the dead rows that the rewrite tests must compact.
        let mut s = CardStore::open_with_limits(
            dir,
            OpenLimits {
                read: MEMORY_LIMIT,
                rebuild: REBUILD_MEMORY_LIMIT,
                reopen: MEMORY_LIMIT,
                vacuum_rebuild_indexes: "0",
            },
        );
        for round in 0..11 {
            if keep_wal && round == 10 {
                s.conn.execute_batch("PRAGMA disable_checkpoint_on_shutdown").expect("keep the last round in the WAL");
            }
            for id in 0..8 {
                s.put(&blob_card(id, round));
            }
        }
        s.mark_restore_complete();
    }

    /// TRDD-0BDOV3WC — (rows, distinct session ids, max seq, sum of row hashes) over every column, read on a
    /// SEPARATE connection at 2048 MiB, so it fingerprints the file independently of the store under test.
    fn canon(path: &Path) -> (i64, i64, i64, String) {
        let conn = Connection::open(path).expect("open the file for its fingerprint");
        conn.execute_batch("SET memory_limit='2048MiB'").expect("raise the limit for the fingerprint");
        conn.query_row(
            "SELECT count(*), count(DISTINCT session_id), max(seq),
                    CAST(sum(hash(session_id, seq, last_active_ms, timeline_len, parent_session_id, source, card)) AS VARCHAR)
             FROM cards",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .expect("fingerprint the cards")
    }

    /// The two files a rewrite leaves until its rename: the rebuild file and its WAL.
    fn rebuild_files(dir: &Path) -> [std::path::PathBuf; 2] {
        [dir.join(format!("{CARD_DB_FILE}.rebuild")), dir.join(format!("{CARD_DB_FILE}.rebuild.wal"))]
    }

    /// TRDD-0BDOV3WC — a corpus whose one-shot read runs out of memory is rewritten losslessly and smaller,
    /// leaves no rebuild files behind, and is reused at the normal limit afterwards.
    #[test]
    fn rewrite_is_lossless_and_compacts() {
        let dir = data_dir("rewrite-lossless");
        churned_corpus(&dir, false);
        let path = dir.join(CARD_DB_FILE);
        let before = canon(&path);
        let bytes_before = std::fs::metadata(&path).expect("stat the corpus").len();
        match CardStore::try_reuse(&path, "4MiB", VACUUM_REBUILD_INDEXES) {
            Err(Refusal::OutOfMemory(text)) => {
                assert!(text.contains("Out of Memory Error"), "precondition: unexpected text: {text}")
            }
            Err(Refusal::NotEligible(text) | Refusal::ClearInProgress(text)) => panic!("precondition: the one-shot read must run out of memory: {text}"),
            Ok(_) => panic!("precondition: the one-shot read at 4MiB must be refused"),
        }
        let store = CardStore::open_with_limits(
            &dir,
            OpenLimits { read: "4MiB", rebuild: "256MiB", reopen: "12MiB", vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES },
        );
        match store.open_outcome() {
            OpenOutcome::Rewritten { rows, bytes_before: recorded, bytes_after, warning } => {
                assert_eq!(*rows, 8, "every card is copied");
                assert_eq!(*recorded, bytes_before, "the bytes before the rewrite");
                assert_eq!(*bytes_after, std::fs::metadata(&path).expect("stat the rewritten file").len());
                assert!(warning.is_none(), "the fresh file loads at 12MiB: {warning:?}");
            }
            other => panic!("expected a rewrite, got {other:?}"),
        }
        assert!(store.reused(), "a rewritten corpus is reused");
        let next_seq = store.next_seq;
        drop(store);
        assert_eq!(canon(&path), before, "the rewrite must not change any row");
        let rewritten = Connection::open(&path).expect("open the rewritten file for its schema");
        let indexes: Vec<String> = rewritten
            .prepare("SELECT index_name FROM duckdb_indexes() WHERE table_name = 'cards'")
            .expect("prepare the index listing")
            .query_map([], |r| r.get::<_, String>(0))
            .expect("list the indexes")
            .collect::<Result<_, _>>()
            .expect("read the index names");
        assert!(
            indexes.iter().any(|i| i == "idx_cards_active") && indexes.iter().any(|i| i == "idx_cards_parent"),
            "the rewritten file must keep both indexes: {indexes:?}"
        );
        let constraints: Vec<String> = rewritten
            .prepare("SELECT constraint_type FROM duckdb_constraints() WHERE table_name = 'cards'")
            .expect("prepare the constraint listing")
            .query_map([], |r| r.get::<_, String>(0))
            .expect("list the constraints")
            .collect::<Result<_, _>>()
            .expect("read the constraint types");
        assert!(constraints.iter().any(|c| c == "PRIMARY KEY"), "the rewritten table must keep its primary key: {constraints:?}");
        drop(rewritten);
        assert_eq!(next_seq, before.2 + 1, "next_seq resumes after the highest seq");
        let bytes_now = std::fs::metadata(&path).expect("stat the file").len();
        assert!(bytes_now < bytes_before, "the rewritten file must be smaller: {bytes_now} >= {bytes_before}");
        for leftover in rebuild_files(&dir) {
            assert!(!leftover.exists(), "{} must not remain", leftover.display());
        }
        assert!(!dir.join(format!("{CARD_DB_FILE}.wal")).exists(), "no WAL after a clean close");
        let again = CardStore::open_with_limits(
            &dir,
            OpenLimits { read: "12MiB", rebuild: "256MiB", reopen: "12MiB", vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES },
        );
        assert!(matches!(again.open_outcome(), OpenOutcome::Reused), "a second open reuses: {:?}", again.open_outcome());
    }

    /// TRDD-0BDOV3WC — a rewrite that cannot finish at its own limit falls back to the rebuild path and
    /// leaves no rebuild files behind.
    #[test]
    fn a_failed_rewrite_falls_back() {
        let dir = data_dir("rewrite-fail");
        churned_corpus(&dir, false);
        let store = CardStore::open_with_limits(
            &dir,
            OpenLimits { read: "4MiB", rebuild: "4MiB", reopen: "12MiB", vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES },
        );
        match store.open_outcome() {
            OpenOutcome::RewriteFailed(reason) => {
                // DuckDB reports the same memory exhaustion as "Out of Memory Error" in a scan and as
                // "failed to pin block" in a checkpoint; the 4 MiB rewrite fails in its checkpoint.
                assert!(
                    reason.contains("Out of Memory") || reason.contains("failed to pin block"),
                    "the rewrite must fail for lack of memory: {reason}"
                )
            }
            other => panic!("expected a failed rewrite, got {other:?}"),
        }
        assert!(!store.reused(), "a failed rewrite is not a reuse");
        drop(store);
        for leftover in rebuild_files(&dir) {
            assert!(!leftover.exists(), "{} must not remain", leftover.display());
        }
    }

    /// TRDD-0BDOV3WC — leftovers of an earlier rewrite are removed at the next open, and the store still reuses.
    #[test]
    fn leftovers_are_removed() {
        let dir = data_dir("leftovers");
        let mut s = CardStore::open(&dir);
        s.put(&card("s0", 1000.0, 2, 8));
        s.mark_restore_complete();
        drop(s);
        for leftover in rebuild_files(&dir) {
            std::fs::write(&leftover, b"garbage").expect("plant a leftover");
        }
        let store = CardStore::open(&dir);
        for leftover in rebuild_files(&dir) {
            assert!(!leftover.exists(), "{} must be removed", leftover.display());
        }
        assert!(matches!(store.open_outcome(), OpenOutcome::Reused), "outcome: {:?}", store.open_outcome());
    }

    /// TRDD-0BDOV3WC — the swap removes a stale WAL before the rename, so the file swapped in holds the
    /// rebuild's content and nothing of the previous file.
    #[test]
    fn swap_removes_the_stale_wal() {
        let source = data_dir("swap-source");
        let mut s = CardStore::open(&source);
        s.put(&card("rebuilt", 2000.0, 0, 8));
        s.mark_restore_complete();
        drop(s);
        let dir = data_dir("swap-wal");
        let mut s = CardStore::open(&dir);
        s.put(&card("old", 1000.0, 0, 8));
        s.mark_restore_complete();
        drop(s);
        let wal = dir.join(format!("{CARD_DB_FILE}.wal"));
        std::fs::write(&wal, b"a stale WAL that must not survive the swap").expect("plant a stale WAL");
        std::fs::copy(source.join(CARD_DB_FILE), dir.join(format!("{CARD_DB_FILE}.rebuild")))
            .expect("plant the rebuild file");
        let warning = swap_in_rebuild(&dir).expect("the swap must succeed");
        assert!(
            !cfg!(target_os = "macos") || warning.is_none(),
            "the directory sync must succeed on macOS: {warning:?}"
        );
        assert!(!wal.exists(), "the stale WAL must be removed");
        assert!(!dir.join(format!("{CARD_DB_FILE}.rebuild")).exists(), "the rebuild file must be renamed away");
        let store = CardStore::open(&dir);
        assert!(store.get("rebuilt").is_some(), "the swapped-in file holds the rebuild's card");
        assert!(store.get("old").is_none(), "the previous file's card must be gone");
    }

    /// TRDD-0BDOV3WC F2 — a rebuild whose WAL holds rows is refused before the rename: those rows are not in
    /// the rebuild file, so swapping the file in would lose them. `cards.duckdb` is left exactly as it was.
    #[test]
    fn swap_refuses_a_rebuild_wal_that_holds_rows() {
        let source = data_dir("swap-refuse-source");
        let mut s = CardStore::open(&source);
        s.put(&card("rebuilt", 2000.0, 0, 8));
        s.mark_restore_complete();
        drop(s);
        let dir = data_dir("swap-refuse");
        let mut s = CardStore::open(&dir);
        s.put(&card("old", 1000.0, 0, 8));
        s.mark_restore_complete();
        drop(s);
        let db = dir.join(CARD_DB_FILE);
        let before = std::fs::read(&db).expect("read the previous file");
        let rebuild = dir.join(format!("{CARD_DB_FILE}.rebuild"));
        std::fs::copy(source.join(CARD_DB_FILE), &rebuild).expect("plant a valid rebuild file");
        std::fs::write(dir.join(format!("{CARD_DB_FILE}.rebuild.wal")), b"rows not yet checkpointed")
            .expect("plant a non-empty rebuild WAL");
        let err = swap_in_rebuild(&dir).expect_err("a rebuild whose WAL holds rows must be refused");
        assert!(err.contains("rebuild.wal"), "unexpected error: {err}");
        assert!(std::fs::read(&db).expect("read the previous file") == before, "cards.duckdb must be unchanged");
        assert!(rebuild.exists(), "the rebuild file must not be renamed away");
    }

    /// TRDD-0BDOV3WC — a WAL the writer never checkpointed is carried into the rewrite, so the rewritten file
    /// holds the logical corpus and not only the checkpointed part of it.
    #[test]
    fn a_wal_is_carried_into_the_rewrite() {
        let dir = data_dir("wal-carried");
        churned_corpus(&dir, true);
        let wal = dir.join(format!("{CARD_DB_FILE}.wal"));
        assert!(wal.exists(), "precondition: the writer left a WAL behind");
        let copy = data_dir("wal-carried-copy");
        std::fs::create_dir_all(&copy).expect("create the copy");
        std::fs::copy(dir.join(CARD_DB_FILE), copy.join(CARD_DB_FILE)).expect("copy the database");
        std::fs::copy(&wal, copy.join(format!("{CARD_DB_FILE}.wal"))).expect("copy the WAL");
        // Opening the copy replays its WAL, so its fingerprint is the logical corpus.
        let expected = canon(&copy.join(CARD_DB_FILE));
        let store = CardStore::open_with_limits(
            &dir,
            OpenLimits { read: "4MiB", rebuild: "256MiB", reopen: "12MiB", vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES },
        );
        assert!(matches!(store.open_outcome(), OpenOutcome::Rewritten { .. }), "outcome: {:?}", store.open_outcome());
        drop(store);
        assert_eq!(canon(&dir.join(CARD_DB_FILE)), expected, "the rewrite must carry the WAL's rows");
        assert!(!wal.exists(), "no WAL after the rewrite");
    }

    /// TRDD-0BDOV3WC A2 — once the swap has put the fresh file in place, a reopen failure keeps that file:
    /// the store runs at the rebuild limit with a warning, and nothing deletes the corpus.
    #[test]
    fn a_reopen_failure_keeps_the_fresh_file() {
        let dir = data_dir("reopen-failure");
        churned_corpus(&dir, false);
        let path = dir.join(CARD_DB_FILE);
        let before = canon(&path);
        let store = CardStore::open_with_limits(
            &dir,
            OpenLimits { read: "4MiB", rebuild: "256MiB", reopen: "4MiB", vacuum_rebuild_indexes: VACUUM_REBUILD_INDEXES },
        );
        assert!(
            matches!(store.open_outcome(), OpenOutcome::Rewritten { warning: Some(_), .. }),
            "expected a rewrite with a warning, got {:?}",
            store.open_outcome()
        );
        assert!(store.reused(), "the rewritten corpus is still reused");
        drop(store);
        assert!(path.exists(), "the fresh file must survive a reopen failure");
        assert_eq!(canon(&path), before, "the fresh file must hold the whole corpus");
    }

    /// TRDD-T0G38TZ4 — the tracked byte total must equal what the table actually holds, on
    /// every path that changes the stored text.
    ///
    /// WHY the aggregate is the oracle and not a hand-computed number: the old implementation
    /// read exactly this aggregate (`SELECT count(*), COALESCE(SUM(strlen(card)), 0)::BIGINT
    /// FROM cards`), so comparing against it pins the counter to the OLD behaviour — the
    /// counter is a replacement for that scan, not a new definition of the corpus size. The
    /// aggregate runs on the store's own connection, in the test only.
    ///
    /// The paths covered: a first insert, an UPSERT of an existing card (the old bytes must
    /// leave the total), a demotion (the stored text changes from the full card to the
    /// stripped card), a clear, and a REOPEN (the counter is rebuilt by `load_resident`).
    /// A reopen is the path that cannot be checked any other way: it is where the counter is
    /// derived from the table rather than from the write path.
    #[test]
    fn card_bytes_counter_matches_the_duckdb_aggregate() {
        // The oracle: the aggregate the old implementation ran, read directly from the table.
        let aggregate = |s: &CardStore| -> (usize, u64) {
            s.conn
                .query_row(
                    "SELECT count(*), COALESCE(SUM(strlen(card)), 0)::BIGINT FROM cards",
                    [],
                    |r| Ok((r.get::<_, i64>(0)? as usize, r.get::<_, i64>(1)? as u64)),
                )
                .expect("aggregate the card corpus")
        };
        let assert_matches = |s: &CardStore, when: &str| {
            let expected = aggregate(s);
            let actual = s.corpus_bytes().expect("the corpus bytes are always available");
            assert_eq!(actual, expected, "the tracked counter must match the table, {when}");
        };

        let dir = data_dir("card-bytes");
        let mut s = CardStore::open(&dir);
        // Cards of DIFFERENT sizes, one with a timeline and one without: a timeline card is
        // stored whole, a timeline-free one is persist-stripped at write time, so the two
        // exercise different stored shapes.
        s.put(&card("with-timeline", 3000.0, 4, 64));
        s.put(&card("without-timeline", 2000.0, 0, 8));
        s.put(&card("big", 1000.0, 12, 512));
        assert_matches(&s, "after the puts");

        // An UPSERT: the old card's bytes must leave the total and the new card's enter it.
        s.put(&card("with-timeline", 4000.0, 8, 64));
        assert_matches(&s, "after an upsert of an existing card");

        // A demotion: the stored text changes from the full card to the stripped card. The hot
        // set is 1, so every other timeline card falls out of it.
        let demoted = s.demote_cold(1).expect("demote the cold cards");
        assert!(demoted > 0, "the demotion must have demoted something, or the test proves nothing");
        assert_matches(&s, "after a demotion");

        // A REOPEN: the counter is rebuilt by `load_resident` from the table's own text.
        s.mark_restore_complete();
        drop(s);
        let s = CardStore::open(&dir);
        assert!(s.reused(), "the store must take the reuse path, or the rebuild is not exercised");
        assert_matches(&s, "after a reopen");

        // A clear: the table is empty, so both numbers are zero.
        let mut s = s;
        s.clear();
        assert_matches(&s, "after a clear");
        assert_eq!(s.corpus_bytes().expect("the corpus bytes are always available"), (0, 0));
    }

}
