//! TRDD-9VX3WTGU — `cards.duckdb` is REUSED across restarts when its `meta` table vouches for it,
//! so a start no longer redoes the 40k indexed inserts of the restore.
//!
//! Real DuckDB files in temp dirs, no mocks. Every "restart" drops the previous store first (two
//! live stores over one reusable file would be two writers on one database), and a test that needs
//! two starts side by side gives each its OWN data dir.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agentlens_core::card_store::{CardStore, CARD_DB_FILE};
use agentlens_core::delta_log::DeltaLog;
use agentlens_core::log_reader::{persist_records_from, DurableState, LogTailer};
use agentlens_core::log_reader::{ScannedFile, LOG_INGEST_VERSION, SCAN_CHUNK};
use agentlens_core::ui::strip_session_detail;
use agentlens_core::{ingest_post, CoreState};
use agentlens_logscan::discovery::{Env, Platform};
use agentlens_store::duckdb::Connection;
use serde_json::{json, Value};

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-cardreuse-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("create the test dir");
    d
}

fn cold_card(id: &str, start: &str) -> Value {
    json!({
        "sessionId": id, "source": "claude_code", "startTime": start, "durationMs": 1000.0,
        "timeline": [], "timelineTruncatedCount": 4,
        "fileOps": { "reads": [{ "path": "/x", "bytes": 10 }] },
        "backgroundSpans": [{ "spanId": "bg" }],
        "generatedFiles": [{ "path": "/g" }], "generatedFilesTruncated": false
    })
}

fn ids(s: &CardStore) -> Vec<String> {
    s.cards().iter().map(|c| c["sessionId"].as_str().unwrap_or_default().to_owned()).collect()
}

/// A completed corpus of three cards (a, b, c) left behind by a "previous run" in a fresh dir.
fn seeded(name: &str) -> PathBuf {
    let d = dir(name);
    let mut s = CardStore::open(&d);
    for (id, start) in [("a", "2026-08-01T10:00:00.000Z"), ("b", "2026-08-01T11:00:00.000Z"), ("c", "2026-08-01T09:00:00.000Z")] {
        s.put(&cold_card(id, start));
    }
    s.mark_restore_complete();
    d
}

/// Edit the meta table of a store that is NOT open (the previous run is gone).
fn meta_sql(d: &Path, sql: &str) {
    let c = Connection::open(d.join(CARD_DB_FILE)).expect("open the database directly");
    c.execute_batch(sql).expect("edit the meta table");
}

fn assert_rebuilt(d: &Path, why: &str) {
    let s = CardStore::open(d);
    assert!(!s.reused(), "{why}: the database must NOT be reused");
    assert!(s.is_empty(), "{why}: a rebuilt database starts empty");
    assert!(s.parsed_cards().is_empty(), "{why}: and so does the resident layer");
}

/// A matching, completed database is kept: rows, `seq` order and the resident layer survive, and
/// the next card is ordered AFTER the old ones (next_seq = max(seq)+1, not 0).
#[test]
fn a_matching_completed_database_is_reused_with_its_order_and_next_seq() {
    let d = seeded("reuse");
    let mut s = CardStore::open(&d);
    assert!(s.reused());
    assert_eq!(ids(&s), ["a", "b", "c"], "first-insert order survives the restart");
    assert_eq!(s.parsed_cards().len(), 3, "the resident parsed layer was rebuilt from the table");
    s.put(&cold_card("d", "2026-08-01T08:00:00.000Z"));
    s.put(&cold_card("a", "2026-08-01T10:30:00.000Z")); // upsert keeps its slot
    assert_eq!(ids(&s), ["a", "b", "c", "d"], "a new card sorts after the old ones; an upsert keeps its slot");
    let parsed: Vec<String> = s.parsed_cards().iter().map(|c| c["sessionId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(parsed, ["a", "b", "c", "d"], "the resident layer has the same order as the table");
}

/// The database was built under another ingest version: deleted and rebuilt.
#[test]
fn a_database_from_another_ingest_version_is_rebuilt() {
    let d = seeded("ingest");
    meta_sql(&d, "UPDATE meta SET value = '1' WHERE key = 'ingest_version'");
    assert_rebuilt(&d, "ingest version mismatch");
}

/// The database was built under another card schema version: deleted and rebuilt.
#[test]
fn a_database_from_another_card_schema_version_is_rebuilt() {
    let d = seeded("schema");
    meta_sql(&d, "UPDATE meta SET value = '999' WHERE key = 'card_schema_version'");
    assert_rebuilt(&d, "schema version mismatch");
}

/// A database from before the meta table existed (the one-time migration) is rebuilt.
#[test]
fn a_database_with_no_meta_table_is_rebuilt() {
    let d = seeded("nometa");
    meta_sql(&d, "DROP TABLE meta");
    assert_rebuilt(&d, "missing meta");
}

/// A database whose restore never finished (killed half-way) is rebuilt: it is not the corpus.
#[test]
fn a_database_whose_restore_never_completed_is_rebuilt() {
    let d = dir("incomplete");
    {
        let mut s = CardStore::open(&d);
        s.put(&cold_card("a", "2026-08-01T10:00:00.000Z"));
        // no mark_restore_complete(): the process died during the restore
    }
    assert_rebuilt(&d, "restore_complete=0");
}

/// `/api/clear` flagged the database and the rescan never finished: rebuilt; once the rescan
/// finished (`finish_clear`) the same database is reusable again.
#[test]
fn a_database_with_a_clear_in_progress_is_rebuilt_until_the_rescan_finishes() {
    let d = seeded("clear");
    {
        let mut s = CardStore::open(&d);
        assert!(s.reused());
        s.clear();
        s.put(&cold_card("x", "2026-08-01T10:00:00.000Z")); // the rescan has begun refilling it
    }
    assert_rebuilt(&d, "clear_in_progress=1");

    let d = seeded("clear-done");
    {
        let mut s = CardStore::open(&d);
        s.clear();
        s.put(&cold_card("x", "2026-08-01T10:00:00.000Z"));
        s.finish_clear();
    }
    let s = CardStore::open(&d);
    assert!(s.reused(), "after the rescan finished the corpus is whole again");
    assert_eq!(ids(&s), ["x"]);
}

/// A file that is not a database at all: deleted and rebuilt, not a crash loop.
#[test]
fn a_corrupt_database_file_is_rebuilt() {
    let d = seeded("corrupt");
    std::fs::write(d.join(CARD_DB_FILE), b"this is not a duckdb file, it is garbage ".repeat(500)).unwrap();
    assert_rebuilt(&d, "corrupt file");
}


/// Valid meta (all four keys pass the gate) but one row whose `card` is not JSON: the resident
/// scan is part of the reuse gate, so this is rebuilt, not a panic on every start.
#[test]
fn a_card_row_that_is_not_json_is_rebuilt_not_a_panic() {
    let d = seeded("bad-row");
    meta_sql(&d, "UPDATE cards SET card = '{not json' WHERE session_id = 'b'");
    assert_rebuilt(&d, "an unparseable card row");
}

/// The write-time persist-strip: a card with no timeline entries is stored persist-stripped (row
/// AND resident layer), a card WITH a timeline (the hot set) is stored whole, and a card that
/// lacks the stripped keys gains none.
#[test]
fn a_cold_card_is_persist_stripped_at_write_and_a_hot_card_is_not() {
    let d = dir("strip");
    let mut s = CardStore::open(&d);
    s.put(&cold_card("cold", "2026-08-01T10:00:00.000Z"));
    let mut hot = cold_card("hot", "2026-08-01T11:00:00.000Z");
    hot["timeline"] = json!([{ "type": "api_request" }]);
    s.put(&hot);
    s.put(&json!({ "sessionId": "bare", "timeline": [] }));

    let cold = s.get("cold").unwrap();
    for gone in ["fileOps", "generatedFiles", "generatedFilesTruncated"] {
        assert!(cold.get(gone).is_none(), "{gone} must be stripped from a cold card's row");
    }
    assert_eq!(cold["backgroundSpans"], json!([]));
    assert_eq!(cold["timelineTruncatedCount"], 4, "the truncation counter is untouched");
    assert_eq!(s.get("hot").unwrap(), hot, "a card with a timeline is stored exactly as given");
    assert_eq!(s.get("bare").unwrap(), json!({ "sessionId": "bare", "timeline": [] }), "no keys are invented");
    let resident = s.parsed_cards();
    assert_eq!(*resident[0], cold, "the resident layer holds the same stripped form as the row");

    // SIZE: 300 cold cards that arrive with big fileOps must not bloat the corpus.
    for i in 0..300 {
        let mut c = cold_card(&format!("big{i}"), "2026-08-01T10:00:00.000Z");
        c["fileOps"] = json!({ "reads": (0..50).map(|n| json!({ "path": format!("/some/long/path/{n}"), "bytes": n })).collect::<Vec<_>>() });
        s.put(&c);
    }
    let (rows, bytes) = s.corpus_bytes().unwrap();
    assert!(bytes / (rows as u64) < 500, "stripped cold rows stay small: {bytes} bytes over {rows} rows");
}

/// A hot card that falls out of the hot set reaches the same stripped shape.
#[test]
fn a_demoted_card_is_persist_stripped_too() {
    let d = dir("demote");
    let mut s = CardStore::open(&d);
    for (id, start) in [("old", "2026-08-01T08:00:00.000Z"), ("new", "2026-08-01T12:00:00.000Z")] {
        let mut c = cold_card(id, start);
        c["timeline"] = json!([{ "type": "api_request" }]);
        s.put(&c);
    }
    assert_eq!(s.demote_cold(1).expect("demote"), 1);
    let old = s.get("old").unwrap();
    assert_eq!(old["timeline"], json!([]));
    assert_eq!(old["timelineTruncatedCount"], 5, "the demotion bump (4 + 1 entry) is kept");
    assert!(old.get("fileOps").is_none() && old.get("generatedFiles").is_none());
    assert!(s.get("new").unwrap().get("fileOps").is_some(), "the hot card keeps everything");
}

// ── DurableState level: parity and the first save ────────────────────────────────────────────

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn copy_tree(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(src).unwrap().flatten() {
        let p = e.path();
        let to = dst.join(e.file_name());
        if p.is_dir() { copy_tree(&p, &to) } else { std::fs::copy(&p, &to).unwrap(); }
    }
}

const PARENT: &str = "cccccccc-1111-2222-3333-444444444444";

fn otel_twin() -> String {
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": "00000000000000000000000000000abc", "spanId": "0000000000000abc",
        "startTimeUnixNano": "1785578400000000000",
        "attributes": [
            { "key": "session.id", "value": { "stringValue": PARENT } },
            { "key": "input_tokens", "value": { "intValue": "100" } }
        ]
    }] }] }] })
    .to_string()
}

struct Boot {
    st: Mutex<CoreState>,
    tailer: LogTailer,
    durable: DurableState,
}

/// One start: open the card store at `store`, restore against the shared durable dir `data`.
fn boot(store: &Path, data: &Path, env: &Env) -> (Boot, (usize, usize, usize)) {
    let st = Mutex::new(CoreState::open(store));
    let mut tailer = LogTailer::default();
    let mut durable = DurableState::open(data);
    let r = durable.restore(&mut tailer, &mut st.lock().unwrap(), env).unwrap();
    (Boot { st, tailer, durable }, r)
}

/// The previous run: a cold boot over the fixture tree at the fixture's COLD now, then a forced
/// save (a graceful stop). Leaves `<data>/a/cards.duckdb` complete plus the snapshot/offsets pair.
fn previous_run(name: &str) -> (PathBuf, Env, f64) {
    let home = dir(&format!("{name}-home"));
    copy_tree(&fixtures().join("logs-home"), &home);
    let data = dir(&format!("{name}-data"));
    let env = Env { home, platform: Platform::Darwin, vars: HashMap::new() };
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("log-reader-expected.json")).unwrap()).unwrap();
    let cold_now = expected["nowColdMs"].as_i64().unwrap();
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "nothing persisted yet");
    let (scanned, _) = b.tailer.sweep(&env, cold_now, None);
    b.st.lock().unwrap().ingest_scanned(scanned);
    b.durable.mark_dirty();
    b.durable.tick(&b.tailer, &b.st, true);
    (data, env, cold_now as f64)
}

/// SUMMARY FIELD PARITY (not byte parity): the summary served after a REUSED start equals the one
/// served after a full-restore start from the same snapshot + offsets pair, on every field the
/// served summary carries — including a session that has an OTEL twin (the one place the merge
/// reads timeline / backgroundSpans). Compared after `strip_session_detail`, the form
/// `/api/summary` serves; the reused store may hold RICHER hot-set timelines than a restore, and
/// those are exactly what that stripping blanks.
#[test]
fn a_reused_start_serves_the_same_summary_as_a_full_restore_start() {
    let (data, env, now) = previous_run("parity");

    let (reused, r1) = boot(&data.join("a"), &data, &env);
    assert!(reused.st.lock().unwrap().cards.reused(), "the previous run's database was reused");
    let (restored, r2) = boot(&data.join("c"), &data, &env);
    assert!(!restored.st.lock().unwrap().cards.reused(), "a fresh dir has nothing to reuse: full restore");
    assert_eq!(r1, (7, 5, 0));
    // TRDD-6B7VV2Z7 (B'): the refused path restores the same cards but imports no read position
    // (its boot sweep re-reads every file); only the reused path imports the 5 offsets.
    assert_eq!(r2, (7, 0, 0), "same cards either way; the refused path imports no read position");

    let served = |b: &Boot| {
        let mut st = b.st.lock().unwrap();
        ingest_post(&mut st, "/v1/traces", otel_twin().as_bytes());
        let summary = st.session_summary(now);
        let twin = summary["sessions"].as_array().unwrap().iter().find(|s| s["sessionId"] == PARENT).cloned().unwrap();
        assert!(twin["coverageNote"].is_string(), "the OTEL twin was merged (so the merge path is what is compared)");
        strip_session_detail(&summary)
    };
    assert_eq!(served(&reused), served(&restored));
}

/// After a reused start the first save writes only real changes: the delta-log hashes were seeded
/// from the stored cards without loading the snapshot, so an unchanged corpus appends 0 bytes.
#[test]
fn the_first_save_after_a_reused_start_appends_nothing_to_the_card_delta() {
    let (data, env, _) = previous_run("firstsave");
    let before = DeltaLog::new(&data, "log-sessions").disk_bytes();
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert!(b.st.lock().unwrap().cards.reused());
    assert_eq!(r.0, 7);
    let (scanned, s) = b.tailer.sweep(&env, 1_785_578_400_000 + 600_000, None);
    assert!(scanned.is_empty() && s.changed == 0, "the offsets said every file is unchanged");
    b.durable.mark_dirty();
    b.durable.tick(&b.tailer, &b.st, true);
    assert_eq!(DeltaLog::new(&data, "log-sessions").disk_bytes(), before, "0 bytes appended to the card snapshot/delta");
}

/// A reused database next to an offsets log stamped with another ingest version must not be
/// trusted: the cards are discarded and the legacy "stale stamp, restore nothing" path runs.
#[test]
fn a_reused_database_next_to_a_stale_version_stamp_is_discarded() {
    let (data, env, _) = previous_run("stale");
    std::fs::write(data.join("log-delta-version.json"), "{\"v\":1}").unwrap();
    let (b, r) = boot(&data.join("a"), &data, &env);
    assert!(b.st.lock().unwrap().cards.reused(), "the gate itself passed (meta is current)");
    assert_eq!(r, (0, 0, 0), "but the offsets stamp is stale: cold rescan");
    assert!(b.st.lock().unwrap().cards.is_empty() && b.tailer.file_state.is_empty());
}


// ── TRDD-A2KNXCNH: per-chunk read positions ──────────────────────────────────────────────────

fn stamp_is_current(data: &Path) -> bool {
    std::fs::read_to_string(data.join("log-delta-version.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).and_then(|v| v["v"].as_u64())
        == Some(LOG_INGEST_VERSION)
}

/// A fixture HOME plus `n` tiny timestamped Claude transcripts (precedent:
/// log_reader_parity.rs `sweep_incremental_flushes_in_scan_chunk_sized_batches_and_seeds_the_gate`).
fn home_with_generated(name: &str, n: usize) -> PathBuf {
    use std::io::Write;
    let home = dir(name);
    copy_tree(&fixtures().join("logs-home"), &home);
    let projects = home.join(".claude").join("projects").join("-Users-someone-chunk");
    std::fs::create_dir_all(&projects).unwrap();
    for i in 0..n {
        let mut f = std::fs::File::create(projects.join(format!("dddddddd-1111-2222-3333-{:012}.jsonl", i))).unwrap();
        writeln!(f, "{{\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\",\"cwd\":\"/Users/someone/chunk\",\"message\":{{\"role\":\"user\",\"content\":\"seed {}\"}}}}", i).unwrap();
    }
    home
}

/// T3: a cold sweep over more than SCAN_CHUNK files that dies after its FIRST chunk (later chunks
/// and the remainder are never ingested, no tick runs) leaves exactly that chunk's read positions
/// on disk, so the next start reuses the store and re-reads only the files outside chunk 1.
/// Mutation recorded in the report: positions appended once after the sweep instead of per chunk.
#[test]
fn a_sweep_killed_after_its_first_chunk_resumes_from_that_chunks_positions() {
    let home = home_with_generated("t3-home", SCAN_CHUNK + 9);
    let data = dir("t3-data");
    let env = Env { home, platform: Platform::Darwin, vars: HashMap::new() };
    let now = agentlens_core::now_ms();
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "a fresh data dir restores nothing");
    let mut chunk1: Vec<String> = Vec::new();
    let mut calls = 0usize;
    let (_never_ingested, s1) = {
        let (durable, st) = (&mut b.durable, &b.st);
        let mut ingest = |chunk: Vec<ScannedFile>| {
            calls += 1;
            if calls == 1 {
                chunk1 = chunk.iter().map(|s| s.file.clone()).collect();
                durable.ingest_chunk(st, chunk);
            }
        };
        b.tailer.sweep(&env, now, Some(&mut ingest))
    };
    assert!(calls >= 2, "precondition: the cold sweep flushed more than one chunk ({calls})");
    assert_eq!(chunk1.len(), SCAN_CHUNK, "chunk 1 is a full SCAN_CHUNK slice");
    drop(b); // the simulated death: no remainder ingest, no tick

    let (mut b2, r2) = boot(&data.join("a"), &data, &env);
    assert!(b2.st.lock().unwrap().cards.reused(), "the store holding chunk 1 is reused");
    assert_eq!((r2.1, r2.2), (chunk1.len(), 0), "exactly chunk 1's positions were persisted");
    let (scanned, s2) = b2.tailer.sweep(&env, now, None);
    assert_eq!(s2.full_reads as usize, s1.parsed - chunk1.len(), "only files outside chunk 1 are re-read");
    assert_eq!(s2.incremental_reads, 0);
    assert!(scanned.iter().all(|s| !chunk1.contains(&s.file)), "no chunk-1 file is re-read");
}

/// T4: a version-stale stamp tombstones log-offsets AND log-sessions and stamps the version at once
/// (the card tombstone is TRDD-6B7VV2Z7), so positions appended by the cold rescan survive a death
/// before any tick: the next start reuses the store and re-reads only new files.
/// Mutation recorded in the report: skip `stamp_version` in the version-stale branch.
#[test]
fn a_stale_version_boot_stamps_at_once_so_a_rescan_killed_before_a_tick_is_kept() {
    use std::io::Write;
    let (data, env, now) = previous_run("t4");
    let now = now as i64;
    std::fs::write(data.join("log-delta-version.json"), "{\"v\":1}").unwrap();
    let sessions_before = DeltaLog::new(&data, "log-sessions").load().unwrap();
    assert_eq!(sessions_before.len(), 7, "precondition: the previous run saved its cards");

    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "a stale stamp restores nothing");
    assert!(stamp_is_current(&data), "the version is stamped before the rescan");
    assert!(DeltaLog::new(&data, "log-offsets").load().unwrap().is_empty(), "log-offsets replays empty");
    assert!(DeltaLog::new(&data, "log-sessions").load().unwrap().is_empty(), "log-sessions is tombstoned at once too (TRDD-6B7VV2Z7)");

    let mut appended: Vec<String> = Vec::new();
    let (remainder, s1) = {
        let (durable, st) = (&mut b.durable, &b.st);
        let mut ingest = |chunk: Vec<ScannedFile>| {
            appended.extend(chunk.iter().map(|s| s.file.clone()));
            durable.ingest_chunk(st, chunk);
        };
        b.tailer.sweep(&env, now, Some(&mut ingest))
    };
    appended.extend(remainder.iter().map(|s| s.file.clone()));
    if !remainder.is_empty() {
        b.durable.ingest_chunk(&b.st, remainder);
    }
    assert_eq!(appended.len(), s1.parsed);
    drop(b); // death before any tick

    // One file the rescan never saw, so "only the rest is re-read" is a non-zero count.
    let extra = env.home.join(".claude").join("projects").join("-Users-someone-proj").join("eeeeeeee-1111-2222-3333-444444444444.jsonl");
    writeln!(std::fs::File::create(&extra).unwrap(), "{{\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\",\"cwd\":\"/Users/someone/proj\",\"message\":{{\"role\":\"user\",\"content\":\"late\"}}}}").unwrap();

    let (mut b2, r2) = boot(&data.join("a"), &data, &env);
    assert_eq!((r2.1, r2.2), (appended.len(), 0), "the rescan's positions were kept (store reused, not discarded)");
    assert!(r2.0 > 0 && !b2.st.lock().unwrap().cards.is_empty(), "the reused store keeps its cards");
    let (_, s2) = b2.tailer.sweep(&env, now, None);
    assert_eq!(s2.full_reads, 1, "only the file that was never appended is read");
}

/// T6: a poisoned state lock makes ingest_chunk panic before anything is appended, so log-offsets on disk stay unchanged.
/// The panic is the discriminating assertion; the byte checks after it hold because the panic comes first.
#[test]
fn ingest_chunk_on_a_poisoned_lock_panics_and_appends_nothing() {
    let home = dir("t6-home");
    copy_tree(&fixtures().join("logs-home"), &home);
    let data = dir("t6-data");
    let env = Env { home, platform: Platform::Darwin, vars: HashMap::new() };
    let (mut b, _) = boot(&data.join("a"), &data, &env);
    let (scanned, _) = b.tailer.sweep(&env, agentlens_core::now_ms(), None);
    assert!(!scanned.is_empty(), "precondition: a non-empty chunk");
    let before = std::fs::read(data.join("log-offsets.delta.ndjson")).ok();
    let before_bytes = DeltaLog::new(&data, "log-offsets").disk_bytes();
    std::thread::scope(|s| {
        let h = s.spawn(|| {
            let _g = b.st.lock().unwrap();
            panic!("T6: poison the state lock on purpose");
        });
        assert!(h.join().is_err());
    });
    assert!(b.st.is_poisoned(), "precondition: the lock is poisoned");
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| b.durable.ingest_chunk(&b.st, scanned)));
    let payload = outcome.expect_err("a poisoned state lock must make ingest_chunk panic, not skip");
    let message = payload.downcast_ref::<&str>().copied().or_else(|| payload.downcast_ref::<String>().map(String::as_str)).unwrap_or_default();
    assert!(message.contains("CoreState lock poisoned"), "panic should name the poisoned lock, got {message:?}");
    assert_eq!(DeltaLog::new(&data, "log-offsets").disk_bytes(), before_bytes, "no bytes appended");
    assert_eq!(std::fs::read(data.join("log-offsets.delta.ndjson")).ok(), before, "log-offsets unchanged");
}

/// T7: per-chunk appends fill the log's hashes, so a forced tick right after writes 0 offset bytes;
/// the appends themselves are counted in the persistence counters. Every fixture file yields a
/// card (asserted), so the chunk positions cover the whole export and 0 bytes is the right answer.
/// Mutation recorded in the report: drop the persistence-counter update in `ingest_chunk`.
#[test]
fn chunk_appends_are_counted_and_leave_a_forced_tick_nothing_to_write() {
    let home = dir("t7-home");
    copy_tree(&fixtures().join("logs-home"), &home);
    let data = dir("t7-data");
    let env = Env { home, platform: Platform::Darwin, vars: HashMap::new() };
    let (mut b, _) = boot(&data.join("a"), &data, &env);
    assert!(stamp_is_current(&data), "the fresh (stale) boot stamped the version");
    let (remainder, s) = {
        let (durable, st) = (&mut b.durable, &b.st);
        let mut ingest = |chunk: Vec<ScannedFile>| durable.ingest_chunk(st, chunk);
        b.tailer.sweep(&env, agentlens_core::now_ms(), Some(&mut ingest))
    };
    if !remainder.is_empty() {
        b.durable.ingest_chunk(&b.st, remainder);
    }
    assert_eq!((s.files, s.parsed), (5, 5), "precondition: every file yields a card");
    let disk = DeltaLog::new(&data, "log-offsets").disk_bytes();
    let (writes, bytes) = {
        let st = b.st.lock().unwrap();
        (st.persist.offsets_writes, st.persist.offsets_bytes)
    };
    assert!(disk > 0 && writes >= 1, "the chunk positions were appended");
    assert_eq!(bytes, disk, "persist.offsets_bytes counts exactly the appended bytes");
    assert_eq!(DeltaLog::new(&data, "log-offsets").load().unwrap().len(), b.tailer.file_state.len());

    b.durable.tick(&b.tailer, &b.st, true);
    assert_eq!(DeltaLog::new(&data, "log-offsets").disk_bytes(), disk, "the forced tick wrote 0 offset bytes");
    let st = b.st.lock().unwrap();
    assert_eq!((st.persist.offsets_writes, st.persist.offsets_bytes), (writes, bytes), "and counted no offsets write");
    drop(st);
    assert!(stamp_is_current(&data));
}

// ── TRDD-6B7VV2Z7 (B'): a refused reuse never imports read positions ─────────────────────────

/// The persisted form of every card in a start's store, keyed by session id (order-free, and
/// stripped the way the snapshot stores it, so two starts are compared on what they persist).
fn persisted(b: &Boot) -> BTreeMap<String, Value> {
    let st = b.st.lock().unwrap();
    persist_records_from(&st.cards.parsed_cards()).into_iter().collect()
}

/// Names the first card that differs instead of dumping thousands of cards.
fn assert_same_cards(got: &BTreeMap<String, Value>, want: &BTreeMap<String, Value>, label: &str) {
    let missing: Vec<&String> = want.keys().filter(|k| !got.contains_key(*k)).take(5).collect();
    let extra: Vec<&String> = got.keys().filter(|k| !want.contains_key(*k)).take(5).collect();
    assert!(missing.is_empty() && extra.is_empty(), "{label}: {} cards vs {} expected; missing {missing:?}, extra {extra:?}", got.len(), want.len());
    if let Some((k, w)) = want.iter().find(|(k, w)| got.get(*k) != Some(*w)) {
        panic!("{label}: card {k} differs from a fresh parse\n got: {}\nwant: {w}", got[k]);
    }
}

/// A cold run over `home` into its own empty data dir: the cards a fresh install builds.
fn fresh_parse(home: &Path, name: &str, now: i64) -> BTreeMap<String, Value> {
    let data = dir(name);
    let env = Env { home: home.to_path_buf(), platform: Platform::Darwin, vars: HashMap::new() };
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "{name}: an empty data dir restores nothing");
    let (scanned, _) = b.tailer.sweep(&env, now, None);
    b.st.lock().unwrap().ingest_scanned(scanned);
    persisted(&b)
}

/// One sweep whose chunks go through `ingest_chunk` (the boot sweeper's own path, so their read
/// positions are appended). `chunks_before_death = Some(n)` ingests only the first n chunks and
/// drops the rest, a death mid-sweep; `None` also ingests the remainder. Returns the chunk count.
fn sweep_through_durable(b: &mut Boot, env: &Env, now: i64, chunks_before_death: Option<usize>) -> usize {
    let mut calls = 0usize;
    let remainder = {
        let (durable, st) = (&mut b.durable, &b.st);
        let mut ingest = |chunk: Vec<ScannedFile>| {
            calls += 1;
            let keep = match chunks_before_death {
                None => true,
                Some(n) => calls <= n,
            };
            if keep {
                durable.ingest_chunk(st, chunk);
            }
        };
        b.tailer.sweep(env, now, Some(&mut ingest)).0
    };
    if chunks_before_death.is_none() && !remainder.is_empty() {
        b.durable.ingest_chunk(&b.st, remainder);
    }
    calls
}

/// T-lag (TRDD-6B7VV2Z7 acceptance): after a crash the read positions run AHEAD of the card
/// snapshot (per-chunk appends, offsets saved more often than cards). A start that cannot reuse
/// its store restores the snapshot but must not import those positions: it tombstones them, and
/// one sweep serves exactly what a fresh parse builds — the grown transcript G with its new turn,
/// the new transcript N present. Then the same lagged state, killed right after that restore
/// (and again after chunk 1 of its sweep), resumes on the reused store to the same cards.
/// Mutation recorded in the report: import the positions on the snapshot path again.
#[test]
fn a_refused_reuse_ignores_read_positions_that_ran_ahead_of_the_card_snapshot() {
    use std::io::Write;
    let home = home_with_generated("tlag-home", SCAN_CHUNK + 9);
    let data = dir("tlag-data");
    let env = Env { home: home.clone(), platform: Platform::Darwin, vars: HashMap::new() };
    let now = agentlens_core::now_ms();

    // 1-2. A full previous run: one sweep, then full card and offset saves (a graceful stop).
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "a fresh data dir restores nothing");
    assert!(sweep_through_durable(&mut b, &env, now, None) >= 1, "precondition: the cold sweep flushed at least one SCAN_CHUNK");
    b.durable.mark_dirty();
    b.durable.tick(&b.tailer, &b.st, true);
    let g_turns = b.st.lock().unwrap().cards.get(PARENT).unwrap()["turns"].as_u64().unwrap();
    drop(b);
    let snapshot_cards = DeltaLog::new(&data, "log-sessions").load().unwrap().len();

    // 3. G grows by one turn and N appears. A reused start sweeps both through ingest_chunk (their
    // positions are appended) and dies before any tick: no card save, so the snapshot lags.
    let projects = home.join(".claude").join("projects");
    let g = projects.join("-Users-someone-proj").join(format!("{PARENT}.jsonl"));
    writeln!(
        std::fs::OpenOptions::new().append(true).open(&g).unwrap(),
        "{{\"type\":\"assistant\",\"timestamp\":\"2026-08-01T10:00:08.000Z\",\"message\":{{\"id\":\"msg_lag9\",\"model\":\"claude-opus-5\",\"usage\":{{\"input_tokens\":7,\"output_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}},\"content\":[{{\"type\":\"text\",\"text\":\"more\"}}]}}}}"
    )
    .unwrap();
    let n_id = format!("dddddddd-1111-2222-3333-{:012}", SCAN_CHUNK + 9);
    let n = projects.join("-Users-someone-chunk").join(format!("{n_id}.jsonl"));
    writeln!(std::fs::File::create(&n).unwrap(), "{{\"type\":\"user\",\"timestamp\":\"2026-08-01T10:00:00.000Z\",\"cwd\":\"/Users/someone/chunk\",\"message\":{{\"role\":\"user\",\"content\":\"late\"}}}}").unwrap();
    let (mut b, _) = boot(&data.join("a"), &data, &env);
    assert!(b.st.lock().unwrap().cards.reused(), "precondition: the previous run's store is reused");
    sweep_through_durable(&mut b, &env, now, None);
    drop(b); // death before any tick
    let lagged_offsets = DeltaLog::new(&data, "log-offsets").load().unwrap();
    let lagged_cards = DeltaLog::new(&data, "log-sessions").load().unwrap();
    assert!(lagged_offsets.contains_key(&n.to_string_lossy().into_owned()), "precondition: N's read position is on disk");
    assert!(!lagged_cards.contains_key(&n_id), "precondition: N's card is not in the snapshot (the snapshot lags)");
    assert_eq!(lagged_cards[PARENT]["turns"].as_u64(), Some(g_turns), "precondition: the snapshot holds G's stale turn count");
    // The resume variants (step 6) start from copies of exactly this state.
    let resume_dirs: Vec<(PathBuf, Option<usize>)> = [("tlag-resume-restore", None), ("tlag-resume-chunk1", Some(1))]
        .into_iter()
        .map(|(name, chunks)| {
            let d = dir(name);
            copy_tree(&data, &d);
            (d, chunks)
        })
        .collect();

    // 4. A start that cannot reuse its store (a fresh store dir, current version): the snapshot is
    // restored, no read position is imported, and log-offsets on disk is tombstoned.
    let (mut b, r) = boot(&data.join("b"), &data, &env);
    assert!(!b.st.lock().unwrap().cards.reused(), "a fresh store dir: the reuse is refused");
    assert_eq!(r, (snapshot_cards, 0, 0), "the snapshot is restored and no read position is imported");
    assert!(b.tailer.file_state.is_empty(), "the tailer holds no read position after the restore");
    assert!(DeltaLog::new(&data, "log-offsets").load().unwrap().is_empty(), "log-offsets replays empty on disk");

    // 5. One sweep serves exactly what a fresh parse builds.
    let (scanned, _) = b.tailer.sweep(&env, now, None);
    b.st.lock().unwrap().ingest_scanned(scanned);
    let want = fresh_parse(&home, "tlag-ref", now);
    assert_eq!(want[PARENT]["turns"].as_u64(), Some(g_turns + 1), "precondition: the reference sees G's new turn");
    assert!(want.contains_key(&n_id), "precondition: the reference has N");
    let got = persisted(&b);
    assert_eq!(got.get(PARENT).and_then(|c| c["turns"].as_u64()), Some(g_turns + 1), "G's new turn is served");
    assert!(got.contains_key(&n_id), "N is served");
    assert_same_cards(&got, &want, "refused reuse then one sweep");
    drop(b);

    // 6. Resume: the same lagged state, killed right after the refused restore (no sweep, no tick)
    // or after chunk 1 of its sweep; the next start reuses that store and one sweep converges.
    for (d, chunks) in resume_dirs {
        let label = format!("resume after {chunks:?} chunk(s)");
        let (mut b, r) = boot(&d.join("b"), &d, &env);
        assert!(!b.st.lock().unwrap().cards.reused(), "{label}: the first start refuses the reuse");
        assert_eq!((r.1, r.2), (0, 0), "{label}: no read position is imported");
        if chunks.is_some() {
            // >= 2 holds: a start with no imported position takes the cold path (`sweep`,
            // log_reader.rs:473), whose `cold_scan_chunked` calls `flush(parsed)` once per
            // SCAN_CHUNK slice inside its slice loop (log_reader.rs:235-255), the last partial slice
            // included, and returns as its remainder only OpenCode db rows (log_reader.rs:260-264,
            // 296). The returned remainder in log_reader_parity.rs T3 (`sweep_incremental_...`) is
            // the INCREMENTAL path instead: it flushes only at `out.len() >= SCAN_CHUNK`
            // (log_reader.rs:514) and returns the partial tail (log_reader.rs:525).
            assert!(sweep_through_durable(&mut b, &env, now, chunks) >= 2, "{label}: precondition: the sweep flushed more than one chunk");
        }
        drop(b); // death before any tick
        let (mut b, r) = boot(&d.join("b"), &d, &env);
        assert!(b.st.lock().unwrap().cards.reused(), "{label}: the restored store is reused");
        // SCAN_CHUNK: `ingest_chunk` appends one position per chunk entry, and every file in this
        // tree parses (the cold scan's filter_map drops none), so chunk 1 is a full SCAN_CHUNK of
        // entries. The dropped chunk 2 wrote nothing: its positions would come only from a tick.
        let expected_imported = if chunks.is_some() { SCAN_CHUNK } else { 0 };
        assert_eq!((r.1, r.2), (expected_imported, 0), "{label}: only positions written after the tombstone are imported");
        let (scanned, _) = b.tailer.sweep(&env, now, None);
        b.st.lock().unwrap().ingest_scanned(scanned);
        assert_same_cards(&persisted(&b), &want, &label);
    }
}

/// T-stale (TRDD-6B7VV2Z7 residual): a version-stale start tombstones the card snapshot at once,
/// so a death before its first card save cannot leave the stale cards under the CURRENT stamp it
/// just wrote. The next start cannot reuse its store, restores the (now empty) snapshot, and one
/// sweep serves no card for the transcript B deleted in between — the stale snapshot would have
/// served B's card forever. Mutation recorded in the report: drop the log-sessions tombstone.
#[test]
fn a_stale_version_boot_tombstones_the_card_snapshot_so_a_deleted_transcript_is_not_restored() {
    let (data, env, now) = previous_run("tstale");
    let now = now as i64;
    const B_ID: &str = "ffffffff-1111-2222-3333-444444444444";
    let b_file = env.home.join(".codex/sessions/2026/08/01").join(format!("{B_ID}.jsonl"));
    let before = DeltaLog::new(&data, "log-sessions").load().unwrap();
    assert!(before.len() == 7 && before.contains_key(B_ID), "precondition: the previous run saved B's card");

    // 2-3. A stale stamp; the start takes the version-stale branch and dies before any save.
    std::fs::write(data.join("log-delta-version.json"), "{\"v\":1}").unwrap();
    let (b, r) = boot(&data.join("s"), &data, &env);
    assert_eq!(r, (0, 0, 0), "a stale stamp restores nothing");
    assert!(DeltaLog::new(&data, "log-sessions").load().unwrap().is_empty(), "log-sessions replays empty at once");
    drop(b);

    // 4-5. B is deleted; a start into a fresh store dir restores and sweeps.
    std::fs::remove_file(&b_file).unwrap();
    let (mut b, _) = boot(&data.join("t"), &data, &env);
    assert!(!b.st.lock().unwrap().cards.reused(), "a fresh store dir: the reuse is refused");
    let (scanned, _) = b.tailer.sweep(&env, now, None);
    b.st.lock().unwrap().ingest_scanned(scanned);

    // 6. B's card is absent and every other card equals a fresh parse.
    let got = persisted(&b);
    assert!(!got.contains_key(B_ID), "B's stale card must not be restored");
    assert_same_cards(&got, &fresh_parse(&env.home, "tstale-ref", now), "after a stale-version start");
}


/// T-double (TRDD-6B7VV2Z7 B' review): a refused reuse restores the snapshot into the map and then
/// re-reads every file from offset 0. That is safe only because a re-parse REPLACES the card
/// (`put_arc`'s upsert sets `card = excluded.card`); an ingest that ADDED to an existing card would
/// double every card that was current in the snapshot. Run at the HOT now so timelines are
/// non-empty (at the cold now the parse-time strip empties them and a timeline check is vacuous);
/// compare the LIVE cards (the persisted form blanks the timeline), through the production
/// `ingest_chunk` path, and again after the 1h backfill (which sets one field, never adds).
/// Mutation recorded in the report: `put_log_session` sums `turns` and concatenates `timeline`
/// into an existing card with the same id.
#[test]
fn a_refused_reuse_rebuilds_current_snapshot_cards_without_double_counting() {
    let home = dir("tdouble-home");
    copy_tree(&fixtures().join("logs-home"), &home);
    let data = dir("tdouble-data");
    let env = Env { home, platform: Platform::Darwin, vars: HashMap::new() };
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("log-reader-expected.json")).unwrap()).unwrap();
    let hot_now = expected["nowHotMs"].as_i64().unwrap();
    let live = |b: &Boot| -> BTreeMap<String, Value> {
        let st = b.st.lock().unwrap();
        st.cards.parsed_cards().iter().map(|c| (c["sessionId"].as_str().unwrap_or("").to_owned(), (**c).clone())).collect()
    };

    // The previous run: a cold sweep at the hot now, then a graceful stop (full card + offset save).
    let (mut b, r) = boot(&data.join("a"), &data, &env);
    assert_eq!(r, (0, 0, 0), "a fresh data dir restores nothing");
    sweep_through_durable(&mut b, &env, hot_now, None);
    b.durable.mark_dirty();
    b.durable.tick(&b.tailer, &b.st, true);
    let before = live(&b);
    drop(b);
    assert!(before.values().any(|c| c["timeline"].as_array().is_some_and(|t| !t.is_empty())), "precondition: a hot card has a non-empty timeline");
    assert!(before.get(PARENT).and_then(|c| c["turns"].as_u64()).is_some_and(|t| t > 0), "precondition: the parent card has turns");

    // A start that cannot reuse its store: the snapshot goes into the map, no position is imported,
    // and one sweep re-reads every file from offset 0 over those very cards.
    let (mut b, r) = boot(&data.join("b"), &data, &env);
    assert!(!b.st.lock().unwrap().cards.reused(), "a fresh store dir: the reuse is refused");
    assert_eq!(r, (before.len(), 0, 0), "every card is restored and no read position is imported");
    let s = sweep_through_durable(&mut b, &env, hot_now, None);
    assert!(s >= 1, "precondition: the sweep flushed through ingest_chunk");

    let check = |got: &BTreeMap<String, Value>, label: &str| {
        assert_eq!(got.keys().collect::<Vec<_>>(), before.keys().collect::<Vec<_>>(), "{label}: the same card ids");
        for (id, want) in &before {
            let g = &got[id];
            for f in ["turns", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens", "cacheCreate1hTokens", "speedBlendedCostUsd", "totalLlmCalls", "totalToolCalls"] {
                assert_eq!(g.get(f), want.get(f), "{label}: card {id} field {f}");
            }
            let tl = |c: &Value| c["timeline"].as_array().map_or(0, Vec::len);
            assert_eq!(tl(g), tl(want), "{label}: card {id} timeline length");
            assert_eq!(g, want, "{label}: card {id} equals its pre-boot form");
        }
    };
    check(&live(&b), "refused reuse then one sweep");
    b.durable.run_1h_backfill(&b.st);
    check(&live(&b), "after the 1h backfill");
}

/// TRDD-JDQR0HDT: the card whose transcript the previous run knew and the test then deletes.
const GONE_ID: &str = "ffffffff-1111-2222-3333-444444444444";

fn delete_gone_transcript(env: &Env) {
    std::fs::remove_file(env.home.join(".codex/sessions/2026/08/01").join(format!("{GONE_ID}.jsonl"))).unwrap();
}

fn has_card(b: &Boot, id: &str) -> bool {
    b.st.lock().unwrap().cards.parsed_cards().iter().any(|c| c["sessionId"].as_str() == Some(id))
}

/// TRDD-JDQR0HDT: a store flagged `clear_in_progress` (the previous run died between `/api/clear` and the
/// end of its rescan) next to a snapshot that still holds a card whose transcript is gone. The restore must
/// take the stale-version branch: restore 0 cards, tombstone both logs, stamp the version, and a rescan then
/// serves no card for the deleted transcript. Mutation: drop `clear_interrupted ||` in
/// `restore_from_snapshot` and this test fails (the snapshot cards come back).
#[test]
fn an_interrupted_clear_restores_no_snapshot_card_and_tombstones_both_logs() {
    let (data, env, now) = previous_run("jdqr-clear");
    let before = DeltaLog::new(&data, "log-sessions").load().unwrap();
    assert!(before.len() == 7 && before.contains_key(GONE_ID), "precondition: the previous run saved the card of the transcript to be deleted");

    // The `/api/clear` DELETE (flag set with the delete in one transaction), then death before any card save.
    {
        let mut s = CardStore::open(&data.join("a"));
        assert!(s.reused(), "precondition: the previous run left a reusable store");
        s.clear();
    }
    delete_gone_transcript(&env);

    let (mut b, r) = boot(&data.join("a"), &data, &env);
    {
        let st = b.st.lock().unwrap();
        assert!(!st.cards.reused(), "a clear in progress refuses the reuse");
        assert!(st.cards.clear_was_interrupted(), "and the store keeps the reason");
    }
    assert_eq!(r, (0, 0, 0), "an interrupted clear restores nothing");
    assert!(b.st.lock().unwrap().cards.is_empty(), "no snapshot card is in the store");
    assert!(stamp_is_current(&data), "the version is stamped before the rescan, as on the stale-version branch");
    assert!(DeltaLog::new(&data, "log-sessions").load().unwrap().is_empty(), "log-sessions is tombstoned");
    assert!(DeltaLog::new(&data, "log-offsets").load().unwrap().is_empty(), "log-offsets is tombstoned");

    let (scanned, _) = b.tailer.sweep(&env, now as i64, None);
    b.st.lock().unwrap().ingest_scanned(scanned);
    assert!(!has_card(&b, GONE_ID), "the rescan does not bring back the card of the deleted transcript");
    assert!(!b.st.lock().unwrap().cards.is_empty(), "the rescan rebuilt the cards whose files still exist");
}

/// TRDD-JDQR0HDT, the other half of the decision: a `CARD_SCHEMA_VERSION` refusal is a layout change, not a
/// change of what a card means, so the restore still puts every snapshot card back, including the card of a
/// transcript that no longer exists (its only copy). Guards against widening the clear branch to every refusal.
#[test]
fn a_schema_version_refusal_still_restores_the_card_of_a_deleted_transcript() {
    let (data, env, _now) = previous_run("jdqr-schema");
    let before = DeltaLog::new(&data, "log-sessions").load().unwrap();
    assert!(before.len() == 7 && before.contains_key(GONE_ID), "precondition: the previous run saved the card of the transcript to be deleted");
    meta_sql(&data.join("a"), "UPDATE meta SET value = '0' WHERE key = 'card_schema_version'");
    delete_gone_transcript(&env);

    let (b, r) = boot(&data.join("a"), &data, &env);
    {
        let st = b.st.lock().unwrap();
        assert!(!st.cards.reused(), "a schema-version mismatch refuses the reuse");
        assert!(!st.cards.clear_was_interrupted(), "and it is not a clear");
    }
    assert_eq!(r.0, 7, "every snapshot card is restored");
    assert!(has_card(&b, GONE_ID), "the card of the deleted transcript is kept");
    assert_eq!(DeltaLog::new(&data, "log-sessions").load().unwrap().len(), 7, "log-sessions is not tombstoned");
}

/// TRDD-JDQR0HDT: the window between the refused open and the tombstone write. The process dies after
/// `CardStore::open` rebuilt the store but before `restore_from_snapshot` tombstoned the snapshot (or loading
/// the snapshot failed): the rebuilt store must STILL say "clear in progress", so the next start discards the
/// snapshot too instead of restoring it. Once a start completes, the flag is cleared and the store is reusable.
/// Mutation: write `clear_in_progress` as 0 in the rebuilt store and this test fails at the second boot.
#[test]
fn a_death_before_the_tombstones_are_written_still_discards_the_snapshot_at_the_next_start() {
    let (data, env, _now) = previous_run("jdqr-death");
    {
        let mut s = CardStore::open(&data.join("a"));
        assert!(s.reused(), "precondition: the previous run left a reusable store");
        s.clear();
    }
    delete_gone_transcript(&env);

    // First start after the killed clear: the store is rebuilt, then the process dies before any tombstone.
    {
        let s = CardStore::open(&data.join("a"));
        assert!(s.clear_was_interrupted(), "the refusal is a clear in progress");
    }
    assert_eq!(DeltaLog::new(&data, "log-sessions").load().unwrap().len(), 7, "precondition: the snapshot is still on disk");
    let flag: String = Connection::open(data.join("a").join(CARD_DB_FILE))
        .unwrap()
        .query_row("SELECT value FROM meta WHERE key = 'clear_in_progress'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(flag, "1", "the rebuilt store keeps the clear flag until the tombstones are written");

    // Second start: still the discard branch.
    let (b, r) = boot(&data.join("a"), &data, &env);
    assert!(b.st.lock().unwrap().cards.clear_was_interrupted(), "the second start still sees a clear in progress");
    assert_eq!(r, (0, 0, 0), "no snapshot card is restored");
    assert!(!has_card(&b, GONE_ID), "the card of the deleted transcript stays gone");
    assert!(DeltaLog::new(&data, "log-sessions").load().unwrap().is_empty(), "log-sessions is tombstoned");
    assert!(DeltaLog::new(&data, "log-offsets").load().unwrap().is_empty(), "log-offsets is tombstoned");
    drop(b);

    // The completed start cleared the flag: a third start reuses the (empty) store.
    let s = CardStore::open(&data.join("a"));
    assert!(s.reused(), "after the tombstones the flag is cleared and the store is reusable");
}

/// TRDD-JDQR0HDT: a store that carries BOTH `clear_in_progress` = 1 and a stale `card_schema_version` is a clear:
/// `check_meta` tests the clear flag before the version checks, so the snapshot is discarded. Intended: the clear
/// meant to drop those cards, and the schema bump alone would not have dropped them but does not undo the clear.
#[test]
fn a_clear_in_progress_wins_over_a_schema_version_mismatch() {
    let (data, env, _now) = previous_run("jdqr-both");
    {
        let mut s = CardStore::open(&data.join("a"));
        s.clear();
    }
    meta_sql(&data.join("a"), "UPDATE meta SET value = '0' WHERE key = 'card_schema_version'");
    delete_gone_transcript(&env);

    let (b, r) = boot(&data.join("a"), &data, &env);
    assert!(b.st.lock().unwrap().cards.clear_was_interrupted(), "the clear flag decides, not the schema version");
    assert_eq!(r, (0, 0, 0), "no snapshot card is restored");
    assert!(!has_card(&b, GONE_ID), "the card of the deleted transcript stays gone");
}
