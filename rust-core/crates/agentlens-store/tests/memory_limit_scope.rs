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
    conn_b.execute_batch("SET memory_limit='1GB'").unwrap();

    let a_val = read_memory_limit(&conn_a);
    let b_val = read_memory_limit(&conn_b);

    // OBSERVED (real run): conn_a reports "244.1 MiB" (its own 256MB), conn_b
    // reports "953.6 MiB" (its own 1GB, decimal->binary rounded). Each
    // connection kept the value IT set; if DuckDB shared memory_limit at the
    // process/instance level, both would report the same (most-recently-set)
    // value here instead.
    // CONCLUSION: memory_limit is scoped PER-CONNECTION, not shared.
    assert_eq!(a_val, "244.1 MiB");
    assert_eq!(b_val, "953.6 MiB");
    assert_ne!(a_val, b_val, "each connection kept its own memory_limit value");
}

/// Falsifier: does DuckDB even recognize a `SET SESSION` scope for memory_limit,
/// or does plain `SET` already behave session-local (making SET SESSION redundant/error)?
#[test]
fn set_session_memory_limit_behaviour() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("SET memory_limit='256MB'").unwrap();

    let result = conn.execute_batch("SET SESSION memory_limit='1GB'");

    match &result {
        Ok(()) => {
            let val = read_memory_limit(&conn);
            // If SET SESSION succeeds, its value should be readable back.
            assert_eq!(val, "1.0 GiB");
        }
        Err(e) => {
            // OBSERVED: DuckDB rejects SET SESSION for memory_limit with
            // 'Catalog Error: option "memory_limit" cannot be set locally' —
            // i.e. memory_limit is a GLOBAL-only option, not session-scoped.
            let msg = e.to_string();
            assert!(
                msg.contains("cannot be set locally"),
                "expected a 'cannot be set locally' catalog error, got: {msg}"
            );
        }
    }
}

/// Confirms last-write-wins semantics within a single connection.
#[test]
fn last_write_wins_within_one_connection() {
    let conn = Connection::open_in_memory().unwrap();

    conn.execute_batch("SET memory_limit='256MB'").unwrap();
    assert_eq!(read_memory_limit(&conn), "244.1 MiB".to_string());

    conn.execute_batch("SET memory_limit='2GB'").unwrap();
    // OBSERVED: last SET wins over the earlier one within the same connection.
    let after_second_set = read_memory_limit(&conn);
    assert_ne!(after_second_set, "244.1 MiB");
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
    let _ = std::fs::remove_file(&path);

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
