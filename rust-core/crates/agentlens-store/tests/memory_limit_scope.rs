//! Empirical test: is DuckDB's `memory_limit` setting per-connection or shared
//! across connections opened against the same (in-memory) database instance?

use duckdb::Connection;

fn read_memory_limit(conn: &Connection) -> String {
    conn.query_row("SELECT current_setting('memory_limit')", [], |row| {
        row.get::<_, String>(0)
    })
    .expect("current_setting(memory_limit) should be readable")
}

/// Proves whether memory_limit set on one connection leaks into a sibling
/// connection opened separately, or stays scoped to the connection that set it.
#[test]
fn memory_limit_is_scoped_per_connection_not_shared() {
    let conn_a = Connection::open_in_memory().unwrap();
    let conn_b = Connection::open_in_memory().unwrap();

    conn_a.execute_batch("SET memory_limit='256MB'").unwrap();
    // Read A BEFORE touching B. This ordering is what makes the test an INDEPENDENCE test rather
    // than two constants pinned side by side: if `memory_limit` were instance-wide, B's SET below
    // would move this value, and the `assert_eq!(a_val, a_before_b)` after it would catch that.
    // Asserting only the two final values cannot distinguish "each kept its own" from "both were
    // set correctly and the read happens to be per-connection for some unrelated reason".
    let a_before_b = read_memory_limit(&conn_a);

    conn_b.execute_batch("SET memory_limit='1GB'").unwrap();

    let a_val = read_memory_limit(&conn_a);
    let b_val = read_memory_limit(&conn_b);

    // OBSERVED (real run): conn_a reports "244.1 MiB" (its own 256MB), conn_b
    // reports "953.6 MiB" (its own 1GB, decimal->binary rounded). Each
    // connection kept the value IT set; if DuckDB shared memory_limit at the
    // process/instance level, both would report the same (most-recently-set)
    // value here instead.
    // CONCLUSION: memory_limit is scoped PER-CONNECTION, not shared.
    assert_eq!(a_val, a_before_b, "conn_b's SET must not reach conn_a — THIS is the independence claim");
    assert_eq!(a_val, "244.1 MiB");
    assert_eq!(b_val, "953.6 MiB");
    // No `assert_ne!(a_val, b_val)` here: given the two `assert_eq!`s above it cannot fail, and an
    // assertion that cannot fail reads like evidence while providing none.
}

/// Falsifier: does DuckDB even recognize a `SET SESSION` scope for memory_limit,
/// or does plain `SET` already behave session-local (making SET SESSION redundant/error)?
#[test]
fn set_session_memory_limit_behaviour() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("SET memory_limit='256MB'").unwrap();

    // NOT a `match` with an assert in each arm. That shape passes under BOTH of the two behaviours
    // this test exists to tell apart, so it would absorb the very change that is the news: if
    // DuckDB ever accepts `SET SESSION memory_limit`, a per-connection cap becomes possible, which
    // is precisely the lever TRDD-WKLD508O concluded does not exist. `expect_err` makes that flip
    // fail the build instead of passing quietly.
    let err = conn.execute_batch("SET SESSION memory_limit='1GB'").expect_err(
        "SET SESSION memory_limit must be REJECTED — if DuckDB now accepts it, a per-connection \
         memory cap became possible and TRDD-WKLD508O's 'the ceilings do not compose' finding \
         needs revisiting",
    );
    // OBSERVED: 'Catalog Error: option "memory_limit" cannot be set locally' — memory_limit is a
    // GLOBAL-only option with no session scope to reach for.
    let msg = err.to_string();
    assert!(
        msg.contains("cannot be set locally"),
        "expected a 'cannot be set locally' catalog error, got: {msg}"
    );
}

/// Confirms last-write-wins semantics within a single connection.
#[test]
fn last_write_wins_within_one_connection() {
    let conn = Connection::open_in_memory().unwrap();

    conn.execute_batch("SET memory_limit='256MB'").unwrap();
    assert_eq!(read_memory_limit(&conn), "244.1 MiB".to_string());

    conn.execute_batch("SET memory_limit='2GB'").unwrap();
    // OBSERVED: last SET wins over the earlier one within the same connection.
    //
    // Assert the VALUE, not merely that it changed: `assert_ne!(.., "244.1 MiB")` would also pass
    // on an empty string (read failed), on "0 bytes" (silently clamped), and on any garbage — it
    // tests that the string moved, not that the last write won.
    // "1.8 GiB", not "1.9": 2×10^9 / 2^30 = 1.8626, and DuckDB TRUNCATES the decimal rather than
    // rounding it. Measured — my first guess here was "1.9 GiB" and this assertion caught it,
    // which is the whole reason it asserts the value instead of `assert_ne!` on the old one.
    assert_eq!(read_memory_limit(&conn), "1.8 GiB");
}

/// The real-world scenario: two connections opened to the SAME on-disk
/// database FILE (as multiple pool connections into one store would be) —
/// does memory_limit set on one become visible to the other?
#[test]
fn memory_limit_across_two_connections_to_same_file() {
    let path = std::env::temp_dir().join(format!(
        "agentlens_memory_limit_scope_test_{}.duckdb",
        std::process::id()
    ));
    // STRICT on setup, best-effort on teardown — deliberately asymmetric. A stale db here is a
    // FALSE-PASS path: pids recycle, and if a leftover file from a panicked earlier run cannot be
    // removed, `v2_before` stops meaning "the platform default" and starts meaning "whatever the
    // previous run left behind". The trailing cleanup can stay best-effort because a leaked temp
    // file is only untidy. The `.wal` sibling matters for the same reason `card_store.rs` removes
    // it: the db file alone is not the whole database.
    if path.exists() {
        std::fs::remove_file(&path).expect("a stale test db must be removable, or this test measures the last run");
    }
    let _ = std::fs::remove_file(path.with_extension("duckdb.wal"));

    let conn1 = Connection::open(&path).unwrap();
    let conn2 = Connection::open(&path).unwrap();

    conn1.execute_batch("SET memory_limit='256MB'").unwrap();
    let v1 = read_memory_limit(&conn1);
    let v2_before = read_memory_limit(&conn2);

    conn2.execute_batch("SET memory_limit='2GB'").unwrap();
    let v1_after = read_memory_limit(&conn1);
    let v2_after = read_memory_limit(&conn2);

    // OBSERVED: opening two connections to the SAME on-disk file, each
    // connection has its OWN independent memory_limit — conn2's default
    // (unset) value is untouched by conn1's SET, and conn1's value is
    // untouched by conn2's later SET. Confirms memory_limit is tracked
    // per-connection-handle, not per on-disk database file.
    assert_eq!(v1, "244.1 MiB");
    assert_ne!(v2_before, v1, "conn2 keeps the platform default, not conn1's setting");
    assert_eq!(v1_after, v1, "conn1's own value is untouched by conn2's SET");
    assert_ne!(v2_after, v2_before, "conn2's own SET changed its own value");

    let _ = std::fs::remove_file(&path);
}
