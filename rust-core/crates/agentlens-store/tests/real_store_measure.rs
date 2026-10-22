//! Opt-in measurement of open_store on a REAL store copy (sets-to-tables step 2). Ignored by
//! default; run with AL_REAL_STORE=<a COPY of a store dir> and --ignored --nocapture. Never point it
//! at a live store: open_store spills into <store>/tmp.

use std::time::Instant;

fn dir_size(p: &std::path::Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| {
            let m = e.metadata().map(|m| (m.is_dir(), m.len())).unwrap_or((false, 0));
            if m.0 { dir_size(&e.path()) } else { m.1 }
        })
        .sum()
}

fn rss_kb() -> String {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn print_rows(store: &agentlens_store::Store, sql: &str) {
    // EXPLAIN ANALYZE returns (explain_key, explain_value); the plan text is column 1.
    let mut stmt = store.con.prepare(sql).expect("prepare");
    let rows = stmt.query_map([], |r| r.get::<_, String>(1)).expect("query");
    for r in rows {
        println!("{}", r.expect("row"));
    }
}

#[test]
#[ignore]
fn measure_open_on_a_real_store_copy() {
    let Ok(dir) = std::env::var("AL_REAL_STORE") else { panic!("set AL_REAL_STORE to a store COPY") };
    let dir = std::path::PathBuf::from(dir);
    assert!(!dir.starts_with(std::env::var("HOME").unwrap_or_default() + "/.agentlens"), "never the live store");
    println!("rss before open: {} KB", rss_kb());
    let t = Instant::now();
    // AL_MEASURE_LIMIT overrides the limit (e.g. 512MiB = SERVER_MEMORY_LIMIT, to test whether
    // the store opens before the server switches to STORE_MEMORY_LIMIT).
    let limit = std::env::var("AL_MEASURE_LIMIT").unwrap_or_else(|_| agentlens_store::STORE_MEMORY_LIMIT.to_owned());
    println!("memory_limit: {limit}, threads: 1");
    let opened = agentlens_store::open_store(&dir, &limit, 1);
    println!("open wall (incl. failure): {:?}", t.elapsed());
    println!("rss after open attempt: {} KB", rss_kb());
    println!("tmp dir size after open attempt: {} MiB", dir_size(&dir.join(agentlens_store::TMP_DIR)) >> 20);
    let mut store = match opened {
        Ok(s) => s,
        Err(e) => panic!("open_store failed at {limit}: {e}"),
    };
    println!("open wall: {:?}", t.elapsed());
    let mem: i64 = store
        .con
        .query_row("SELECT CAST(sum(memory_usage_bytes) AS BIGINT) FROM duckdb_memory()", [], |r| r.get(0))
        .expect("mem");
    let temp: i64 = store
        .con
        .query_row("SELECT CAST(coalesce(sum(temporary_storage_bytes), 0) AS BIGINT) FROM duckdb_memory()", [], |r| r.get(0))
        .expect("temp");
    println!("duckdb_memory sum: {} MiB (temporary_storage {} MiB)", mem >> 20, temp >> 20);
    println!("rss after open: {} KB", rss_kb());
    {
        let mut stmt = store
            .con
            .prepare("SELECT tag, CAST(memory_usage_bytes >> 20 AS BIGINT) FROM duckdb_memory() WHERE memory_usage_bytes > 0 ORDER BY 2 DESC")
            .expect("p");
        for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).expect("q") {
            let (tag, mib) = r.expect("row");
            println!("  duckdb_memory {tag}: {mib} MiB");
        }
    }
    println!("tmp dir size: {} MiB", dir_size(&dir.join(agentlens_store::TMP_DIR)) >> 20);
    for t in ["known_blob", "part_file", "body_durable"] {
        let n: i64 = store.con.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).expect("count");
        println!("{t}: {n} rows");
    }

    // The two probe shapes ingest_body_with issues, with REAL keys: EXPLAIN ANALYZE shows whether
    // the ART index serves them.
    let shas: Vec<String> = {
        let mut stmt = store.con.prepare("SELECT lower(hex(sha)) FROM known_blob USING SAMPLE 200 ROWS").expect("p");
        stmt.query_map([], |r| r.get::<_, String>(0)).expect("q").map(|r| r.expect("r")).collect()
    };
    let bin = shas.iter().map(|s| format!("unhex(\x27{s}\x27)")).collect::<Vec<_>>().join(",");
    let hex = shas.iter().map(|s| format!("\x27{s}\x27")).collect::<Vec<_>>().join(",");
    let sha_sql = format!("SELECT lower(hex(sha)) FROM known_blob WHERE sha IN ({bin}) UNION SELECT sha FROM blob WHERE sha IN ({hex})");
    let t = Instant::now();
    // Print a failed probe instead of panicking: at 512MiB this query hit Out of Memory, and the
    // remaining probes (body probe, ingest) are still worth measuring.
    match store.con.prepare(&sha_sql).and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.count())) {
        Ok(n) => println!("sha probe (200 real shas): {n} hits in {:?}", t.elapsed()),
        Err(e) => println!("sha probe (200 real shas) FAILED after {:?}: {e}", t.elapsed()),
    }
    if limit != agentlens_store::STORE_MEMORY_LIMIT {
        // Reduced run under a smaller limit: only the two ingest-path operations, each non-fatal.
        let id: Result<String, _> = store.con.query_row("SELECT body_id FROM body_durable LIMIT 1", [], |r| r.get(0));
        match id {
            Ok(id) => {
                let t = Instant::now();
                let probe = format!("SELECT count(*) FROM body_durable WHERE body_id = \x27{id}\x27");
                match store.con.query_row(&probe, [], |r| r.get::<_, i64>(0)) {
                    Ok(c) => println!("body probe: {c} rows in {:?}", t.elapsed()),
                    Err(e) => println!("body probe FAILED: {e}"),
                }
            }
            Err(e) => println!("body_id pick FAILED: {e}"),
        }
        let raw = format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{}\"}}]}}", "z".repeat(5000), std::process::id());
        let t = Instant::now();
        match agentlens_store::ingest_body(&mut store, "measure.request.json", &raw, 1_787_000_000_000) {
            Ok(r) => println!("ingest_body (new body, staging only): {:?} new_blobs={} existed={}", t.elapsed(), r.new_blobs, r.existed),
            Err(e) => println!("ingest_body FAILED after {:?}: {e}", t.elapsed()),
        }
        println!("rss at end: {} KB", rss_kb());
        return;
    }
    println!("--- EXPLAIN ANALYZE sha probe");
    if limit == agentlens_store::STORE_MEMORY_LIMIT {
        print_rows(&store, &format!("EXPLAIN ANALYZE {sha_sql}"));
    }

    let body_id: String = store.con.query_row("SELECT body_id FROM body_durable USING SAMPLE 1 ROWS", [], |r| r.get(0)).expect("id");
    let body_sql = format!(
        "SELECT count(*), coalesce(bool_or(src_name = \x27x\x27), false) FROM (
           SELECT src_name FROM body_durable WHERE body_id = \x27{body_id}\x27
           UNION ALL SELECT src_name FROM body WHERE body_id = \x27{body_id}\x27)"
    );
    let t = Instant::now();
    let c: i64 = store.con.query_row(&body_sql, [], |r| r.get(0)).expect("body probe");
    println!("body probe (real body_id): {c} rows in {:?}", t.elapsed());
    println!("--- EXPLAIN ANALYZE body probe");
    print_rows(&store, &format!("EXPLAIN ANALYZE {body_sql}"));

    // Index-scan threshold vs the largest real body: above index_scan_max_count the IN-list probe
    // silently becomes a full scan of known_blob.
    for s in ["index_scan_max_count", "index_scan_percentage"] {
        let v: String = store.con.query_row(&format!("SELECT CAST(current_setting(\x27{s}\x27) AS VARCHAR)"), [], |r| r.get(0)).expect("setting");
        println!("{s} = {v}");
    }
    let parts = agentlens_store::parquet_scan(&dir, agentlens_store::PARTS_DIR).expect("parts");
    // A SEPARATE connection: on the store connection this GROUP BY over the parts corpus hits the
    // 1536MB limit (measured: Out of Memory, 1.4/1.4 GiB used) because known_blob + its index already
    // hold most of it.
    // Bounded and dropped right after: unbounded, this side query took the process to ~25 GB RSS.
    let side = agentlens_store::duckdb::Connection::open_in_memory().expect("side con");
    side.execute_batch("SET memory_limit = \x272GB\x27; SET threads = 1;").expect("side limits");
    let max_shas: i64 = side
        .query_row(
            &format!("SELECT max(c) FROM (SELECT count(DISTINCT sha) c FROM {parts} WHERE kind = \x27blob\x27 GROUP BY body_id)"),
            [],
            |r| r.get(0),
        )
        .expect("max shas");
    drop(side);
    println!("max distinct span shas in one body: {max_shas}");
    let big: Vec<String> = {
        let mut stmt = store.con.prepare(&format!("SELECT lower(hex(sha)) FROM known_blob USING SAMPLE {max_shas} ROWS")).expect("p");
        stmt.query_map([], |r| r.get::<_, String>(0)).expect("q").map(|r| r.expect("r")).collect()
    };
    // Single IN-list branch at increasing sizes: where does the plan stop being an index scan?
    for size in [100usize, 200, 250, 300, 400, 500, big.len()] {
        let take = &big[..size.min(big.len())];
        let bin = take.iter().map(|s| format!("unhex(\x27{s}\x27)")).collect::<Vec<_>>().join(",");
        let one_sql = format!("SELECT lower(hex(sha)) FROM known_blob WHERE sha IN ({bin})");
        let t = Instant::now();
        let n = store.con.prepare(&one_sql).expect("p").query_map([], |r| r.get::<_, String>(0)).expect("q").count();
        let mut stmt = store.con.prepare(&format!("EXPLAIN ANALYZE {one_sql}")).expect("p");
        let plan: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .expect("q")
            .flat_map(|r| r.expect("row").lines().filter(|l| l.contains("Type:")).map(|l| l.trim().to_owned()).collect::<Vec<_>>())
            .collect();
        println!("single IN list of {} shas: {n} hits in {:?}; plan {:?}", take.len(), t.elapsed(), plan);
    }
    // The exact statement ingest_body_with issues (sha_probe_sql), at the largest body size.
    let probe = agentlens_store::sha_probe_sql(&big);
    let t = Instant::now();
    let n = store.con.prepare(&probe).expect("p").query_map([], |r| r.get::<_, String>(0)).expect("q").count();
    let mut stmt = store.con.prepare(&format!("EXPLAIN ANALYZE {probe}")).expect("p");
    let plan: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .expect("q")
        .flat_map(|r| r.expect("row").lines().map(|l| l.trim().to_owned()).collect::<Vec<_>>())
        .collect();
    let joined = plan.join(" ");
    for l in plan.iter().filter(|l| l.contains("Scan") || l.contains("Index") || l.contains("Sequential")) {
        println!("  ingest probe plan: {l}");
    }
    println!(
        "ingest sha probe (sha_probe_sql) at max body size ({} shas): {n} hits in {:?}; Index Scan mentions {}, Sequential Scan mentions {}",
        big.len(),
        t.elapsed(),
        joined.matches("Index Scan").count(),
        joined.matches("Sequential Scan").count()
    );
    // One full ingest of a NEW body (both probes + staging appends). Staging only — no flush, so
    // nothing is written to the store copy.
    let raw = format!(
        "{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{}\"}}]}}",
        "z".repeat(5000),
        std::process::id()
    );
    let t = Instant::now();
    let r = agentlens_store::ingest_body(&mut store, "measure.request.json", &raw, 1_787_000_000_000).expect("ingest");
    println!("ingest_body (new body, staging only): {:?} new_blobs={} existed={}", t.elapsed(), r.new_blobs, r.existed);
    println!("rss at end: {} KB", rss_kb());
}
