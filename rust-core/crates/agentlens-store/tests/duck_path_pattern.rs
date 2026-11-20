//! TRDD-C6W0SWUT: DuckDB `read_*` functions treat their path argument as a glob, so a data dir whose path
//! holds `*`, `?` or `[` was read as a file pattern while the apostrophe doubling of the old quoting looked
//! right. These tests pin `glob_escape` / `sq_path` against the real bundled DuckDB, and one real
//! production builder chain (open_store, flush, reopen, sync, all_of, parquet_scan) on a store dir holding
//! all three characters. They measure the library code that alcore links, not a run of the alcore binary.
//! Scratch lives under `std::env::temp_dir()`, which the test-data-cap runner redirects and counts.

use std::fs;
use std::path::{Path, PathBuf};

use agentlens_store::duckdb::Connection;
use agentlens_store::{all_of, flush_detailed, glob_escape, ingest_body, open_store, parquet_scan, sq_path, sync_new_parts, BLOBS_DIR};

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-duckpath-{}-{tag}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).expect("mkdir scratch");
    d
}

/// The old quoting: apostrophe doubling only (what `q` did before the escape existed).
fn plain_q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn ids(con: &Connection, sql: &str) -> Result<Vec<i64>, String> {
    let mut stmt = con.prepare(sql).map_err(|e| e.to_string())?;
    let mut v: Vec<i64> = stmt
        .query_map([], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    v.sort();
    Ok(v)
}

/// (directory name, the one id its file holds). The first three names hold a pattern character that DuckDB reads as a
/// pattern (`[xy]` is a class matching x or y); `aXb`, `ayb` are siblings they also match. `a[b` has an UNTERMINATED
/// bracket: measured, DuckDB reads it literally, so it is a control, not a bug case. No two names differ only by case:
/// the default macOS volume is case-insensitive and such names would be one directory.
const DIRS: [(&str, i64); 6] = [("a*b", 2), ("a?b", 3), ("a[xy]b", 4), ("aXb", 1), ("ayb", 5), ("a[b", 6)];

fn canary_tree(tag: &str) -> PathBuf {
    let base = scratch(tag);
    let con = Connection::open_in_memory().expect("open duckdb");
    for (d, id) in DIRS {
        let dir = base.join(d);
        fs::create_dir_all(&dir).expect("mkdir");
        let file = dir.join(format!("{d}.parquet"));
        // COPY TO is a write path, not a glob: plain quoting is right here.
        con.execute_batch(&format!("COPY (SELECT {id}::BIGINT AS id) TO {} (FORMAT PARQUET)", plain_q(&file.to_string_lossy())))
            .expect("write fixture parquet");
    }
    base
}

fn own_file(base: &Path, d: &str) -> String {
    base.join(d).join(format!("{d}.parquet")).to_string_lossy().into_owned()
}

#[test]
fn the_old_quoting_reads_the_wrong_files_and_sq_path_reads_exactly_its_own() {
    let base = canary_tree("canary");
    let con = Connection::open_in_memory().expect("open duckdb");
    for (d, own) in DIRS.iter().take(3) {
        let path = own_file(&base, d);
        let old = ids(&con, &format!("SELECT id FROM read_parquet({})", plain_q(&path)));
        // RED observation: what DuckDB does with the old quoting for this name.
        eprintln!("[measure] old quoting, dir {d}: {old:?}");
        assert_ne!(old, Ok(vec![*own]), "the old quoting must NOT read exactly its own file for {d}: that is the bug under test");
        let fixed = ids(&con, &format!("SELECT id FROM read_parquet({})", sq_path(&path)));
        assert_eq!(fixed, Ok(vec![*own]), "sq_path must read exactly its own file for {d}");
        let list = ids(&con, &format!("SELECT id FROM read_parquet([{}], union_by_name := true)", sq_path(&path)));
        assert_eq!(list, Ok(vec![*own]), "sq_path inside a list must read exactly its own file for {d}");
    }
    // Control: an unterminated bracket is read literally by DuckDB (measured), and the escape keeps it correct.
    let control = own_file(&base, "a[b");
    assert_eq!(ids(&con, &format!("SELECT id FROM read_parquet({})", plain_q(&control))), Ok(vec![6]));
    assert_eq!(ids(&con, &format!("SELECT id FROM read_parquet({})", sq_path(&control))), Ok(vec![6]));
    // The sibling has no pattern character: escaping must leave it alone.
    assert_eq!(glob_escape(&own_file(&base, "aXb")), own_file(&base, "aXb"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_directory_escape_keeps_an_intended_glob_suffix_working() {
    let base = canary_tree("suffix");
    let con = Connection::open_in_memory().expect("open duckdb");
    for (d, own) in DIRS.iter().take(3) {
        let dir = base.join(d).to_string_lossy().into_owned();
        let sql = format!("SELECT id FROM read_parquet({})", plain_q(&format!("{}/*.parquet", glob_escape(&dir))));
        assert_eq!(ids(&con, &sql), Ok(vec![*own]), "escaped directory plus /*.parquet reads only the files of {d}");
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn a_bound_parameter_path_is_a_glob_too_and_glob_escape_fixes_it() {
    // The digest loader binds the file path into a macro over read_ndjson (agentlens-digest register.rs
    // and collect.rs). This reproduces that shape, without the digest crate: macro parameter, bound value.
    let base = scratch("bound");
    for (d, id) in DIRS {
        let dir = base.join(d);
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join(format!("{d}.ndjson")), format!("{{\"id\":{id}}}\n")).expect("write ndjson");
    }
    let con = Connection::open_in_memory().expect("open duckdb");
    con.execute_batch("CREATE MACRO m(dg_path) AS TABLE SELECT id FROM read_ndjson(dg_path, columns = {id: 'BIGINT'}, ignore_errors = false)")
        .expect("macro");
    let run = |p: &str| -> Result<Vec<i64>, String> {
        let mut stmt = con.prepare("SELECT id FROM m(?::VARCHAR)").map_err(|e| e.to_string())?;
        let mut v: Vec<i64> =
            stmt.query_map([p], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        v.sort();
        Ok(v)
    };
    for (d, own) in DIRS.iter().take(3) {
        let path = base.join(d).join(format!("{d}.ndjson")).to_string_lossy().into_owned();
        let old = run(&path);
        eprintln!("[measure] bound path, dir {d}: {old:?}");
        assert_ne!(old, Ok(vec![*own]), "a bound path is expanded as a glob for {d}");
        assert_eq!(run(&glob_escape(&path)), Ok(vec![*own]), "glob_escape on the bound value reads exactly its own file for {d}");
    }
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn glob_escape_changes_only_the_three_pattern_characters_and_never_a_backslash_path() {
    assert_eq!(glob_escape("/data/plain dir/it's.parquet"), "/data/plain dir/it's.parquet");
    assert_eq!(glob_escape("/a*b?c[d]e"), "/a[*]b[?]c[[]d]e");
    assert_eq!(glob_escape(r"C:\data\a*b"), r"C:\data\a*b", "a path with a backslash is left as is");
    assert_eq!(sq_path("/it's*"), "'/it''s[*]'");
}

const BODY_PAD: usize = 600;

fn body(tag: &str) -> String {
    format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{tag}\"}}]}}", "s".repeat(BODY_PAD))
}

#[test]
fn a_store_dir_with_star_question_and_bracket_round_trips_through_the_real_builders() {
    let base = scratch("store");
    let dir = base.join("st*or?e[xy]z");
    let raw1 = body("one");
    let raw2 = body("two");
    let ts = 1_787_000_000_000_i64;

    let mut store = open_store(&dir, "512MB", 1).expect("open");
    let r1 = ingest_body(&mut store, "a.request.json", &raw1, ts).expect("ingest 1");
    flush_detailed(&mut store).expect("flush");
    drop(store);

    // DuckDB falls back to the literal path when a pattern matches nothing (measured by the canary above:
    // a bracket class that matches no sibling still read its own file), so an unescaped dir only misreads when
    // the pattern also matches ANOTHER path. This sibling is matched by `st*or?e[xy]z` and holds copies of the
    // same part files, so an unescaped read would pick up the copies: duplicate rows, and part files that
    // part_file does not know (the open fails on its orphan check).
    let sibling = base.join("stZorQeyz");
    for sub in agentlens_store::PART_DIRS {
        fs::create_dir_all(sibling.join(sub)).expect("mkdir sibling");
        for entry in fs::read_dir(dir.join(sub)).expect("read part dir").flatten() {
            fs::copy(entry.path(), sibling.join(sub).join(entry.file_name())).expect("copy part");
        }
    }

    // Reopen seeds known_blob, known_part and body_durable from filename := true scans (sites in open_store,
    // index_blob_shas, index_part_bodies, scan_of): each names the part files by their real paths.
    let mut store2 = open_store(&dir, "512MB", 1).expect("reopen must read parts under a pattern path");
    let n_blob: i64 = store2.con.query_row("SELECT count(*) FROM known_blob", [], |r| r.get(0)).expect("count known_blob");
    assert!(n_blob > 0, "known_blob must reload from the durable parts");
    assert_eq!(agentlens_store::reconstruct_body(&store2, &r1.body_id).expect("reconstruct"), raw1, "byte identity through part_fetch_sql and blob_fetch_sql");

    // all_of / parquet_scan over the blob dir: every durable blob row is read, once.
    let scan = parquet_scan(&dir, BLOBS_DIR).expect("blob parts exist");
    let rows: i64 = store2.con.query_row(&format!("SELECT count(*) FROM {scan}"), [], |r| r.get(0)).expect("count parquet_scan");
    assert_eq!(rows, n_blob, "parquet_scan reads exactly the durable blob rows");
    let via_all_of: i64 = store2.con.query_row(&format!("SELECT count(*) FROM {}", all_of(&store2, "blob")), [], |r| r.get(0)).expect("count all_of");
    assert_eq!(via_all_of, n_blob, "all_of reads exactly the durable blob rows");

    // A part another writer adds is registered and its facts loaded by sync_new_parts (scan_of, one file).
    let mut other = open_store(&dir, "512MB", 1).expect("second handle");
    ingest_body(&mut other, "b.request.json", &raw2, ts + 1000).expect("ingest 2");
    flush_detailed(&mut other).expect("flush 2");
    drop(other);
    let stats = sync_new_parts(&mut store2).expect("sync");
    assert!(stats.total_new_files() > 0, "the second writer's parts are new files: {stats:?}");
    assert!(stats.skipped.is_empty(), "no part may be skipped as unreadable: {:?}", stats.skipped);
    assert!(stats.new_blob_shas > 0, "the second writer's blob shas reach known_blob: {stats:?}");
    let _ = fs::remove_dir_all(&base);
}
