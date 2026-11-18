//! TRDD-ZKNP5IJY (Rust half): the reader relation must infer its schema from the WHOLE write-ahead
//! file. DuckDB samples only the first 20,480 rows by default, so a key first sent after them is no
//! column at all and a query naming it fails with a Binder Error.

use std::collections::HashMap;

use agentlens_core::statusline_store::query_statusline;

#[test]
fn a_key_first_sent_after_the_default_schema_sample_is_a_column_of_the_reader() {
    // The system temp dir, never the cargo target tmp dir: the test-data cap redirects TMPDIR.
    let base = std::env::temp_dir().join(format!("sl-late-key-reader-{}-{}", std::process::id(), agentlens_core::now_ms()));
    let day = base.join("statusline").join("main").join("2020-01-01");
    std::fs::create_dir_all(&day).unwrap();

    let mut body = String::new();
    for i in 0..20_481u64 {
        body.push_str(&format!("{{\"ts\":{},\"session_id\":\"s0\",\"statusline_stream\":\"main\",\"n\":{i}}}\n", 1_577_836_800_000u64 + i));
    }
    body.push_str("{\"ts\":1577836900000,\"session_id\":\"s0\",\"statusline_stream\":\"main\",\"n\":1,\"late_key\":7}\n");
    std::fs::write(day.join("wal-late.ndjson"), body).unwrap();

    let result = query_statusline(
        &base.join("statusline"),
        "main",
        "SELECT count(*) AS total, count(late_key) AS c FROM samples",
        None,
        None,
        &HashMap::new(),
    );
    let _ = std::fs::remove_dir_all(&base);

    let rows = result.expect("a query naming late_key must bind").expect("the store holds data");
    assert_eq!(rows[0]["total"].as_f64().unwrap(), 20_482.0);
    assert_eq!(rows[0]["c"].as_f64().unwrap(), 1.0);
}
