//! api_call writer pins (TRDD-9SYRK6SW): a REAL bodies pass over REAL request/response bodies
//! on disk must leave durable per-call cache facts behind, in DuckDB, after the bodies themselves
//! are deleted. No mocks — `ingest_pass` is the production path, `open_store` is the production
//! store, and the assertions are SQL over the table the server queries.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use agentlens_store::pass::{ingest_pass, PassOptions};
use agentlens_store::{all_of, open_store, API_CALLS_DIR};

fn fixture(tag: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("al-apicall-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&root);
    let bodies = root.join("bodies");
    let store = root.join("store");
    fs::create_dir_all(&bodies).expect("mkdir");
    (bodies, store)
}

fn write_body(dir: &Path, name: &str, raw: &str, age_ms: u64) {
    let p = dir.join(name);
    fs::write(&p, raw).expect("write");
    let t = std::time::SystemTime::now() - std::time::Duration::from_millis(age_ms);
    let f = fs::OpenOptions::new().write(true).open(&p).expect("open");
    f.set_times(fs::FileTimes::new().set_modified(t)).expect("times");
}

/// Shaped after the real captures in `reports/cache-coldwrite/bodies-20260903_044257+0200/`:
/// the billing header at system[0] with its seven tokens, breakpoints at system[1]/system[2] and
/// the last message, the session id embedded as a JSON STRING inside `metadata.user_id`.
fn request_body(session: &str, prev_req: &str) -> String {
    let pad = "r".repeat(400);
    serde_json::json!({
        "model": "claude-opus-5",
        "metadata": { "user_id": format!("{{\"session_id\":\"{session}\"}}") },
        "system": [
            { "type": "text", "text": format!("x-anthropic-billing-header: cc_version=2.1.258.c18; cc_entrypoint=cli; cch=00000; cc_is_subagent=true; cc_prev_req={prev_req}; cc_prompt_id=bbbb2222; cc_workload=cron;") },
            { "type": "text", "text": format!("stable rules block {pad}"), "cache_control": {"type":"ephemeral"} },
            { "type": "text", "text": "project instructions", "cache_control": {"type":"ephemeral"} }
        ],
        "tools": [ {"name":"Bash"}, {"name":"Read"}, {"name":"Edit"} ],
        // The final message carries a breakpoint, as every one of the 39 real captures does.
        "messages": [ { "role":"user", "content": [ {"type":"text","text":"the first user turn", "cache_control": {"type":"ephemeral"}} ] } ],
        "thinking": { "type": "adaptive" },
        "diagnostics": { "previous_message_id": "msg_01prev" }
    })
    .to_string()
}

fn response_body(id: &str) -> String {
    serde_json::json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5",
        "stop_reason": "end_turn",
        "content": [ {"type":"text","text":"an answer long enough to sectionize into blobs"} ],
        "usage": {
            "input_tokens": 12,
            "output_tokens": 340,
            "cache_read_input_tokens": 80000,
            "cache_creation_input_tokens": 4200,
            "service_tier": "standard",
            "cache_creation": { "ephemeral_5m_input_tokens": 200, "ephemeral_1h_input_tokens": 4000 }
        },
        // DELIBERATELY != cache_creation_input_tokens (4200): the appender feeds 26 values
        // positionally, so every BIGINT in this fixture must be distinct or a transposition
        // between two of them passes the assertions that were meant to catch it.
        "diagnostics": { "cache_miss_reason": { "type": "messages_changed", "cache_missed_input_tokens": 4177 } }
    })
    .to_string()
}

/// One string column for one stem, read through `all_of` (durable parts UNIONed with staging) —
/// the same relation every consumer will read.
fn col(store: &agentlens_store::Store, stem: &str, name: &str) -> Option<String> {
    let sql = format!("SELECT {name} FROM {} WHERE stem = '{stem}'", all_of(store, "api_call"));
    store.con.query_row(&sql, [], |r| r.get::<_, Option<String>>(0)).expect("query")
}

fn col_i64(store: &agentlens_store::Store, stem: &str, name: &str) -> Option<i64> {
    let sql = format!("SELECT {name} FROM {} WHERE stem = '{stem}'", all_of(store, "api_call"));
    store.con.query_row(&sql, [], |r| r.get::<_, Option<i64>>(0)).expect("query")
}

#[test]
fn a_bodies_pass_leaves_one_row_per_kind_and_the_bodies_are_gone() {
    let (bodies, store_dir) = fixture("kinds");
    write_body(&bodies, "2f8caaaa-0000-4000-8000-000000000001.request.json", &request_body("sess-a", "req_011aaaa"), 60_000);
    write_body(&bodies, "req_011bbbb.response.json", &response_body("msg_01resp"), 50_000);

    let mut store = open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.ingested, 2, "failed: {:?}", r.failed);
    assert_eq!(r.deleted, 2, "the pass deletes what it proved durable: {:?}", r.failed);
    // THE POINT OF THE CARD: the facts outlive the bodies.
    assert!(!bodies.join("req_011bbbb.response.json").exists(), "the body is gone");

    let n: i64 = store
        .con
        .query_row(&format!("SELECT count(*) FROM {}", all_of(&store, "api_call")), [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 2, "one row per ingested FILE");

    // ── request row: request-only fields populated, response-only fields NULL ──────
    let req = "2f8caaaa-0000-4000-8000-000000000001";
    assert_eq!(col(&store, req, "kind").as_deref(), Some("request"));
    assert_eq!(col(&store, req, "session_id").as_deref(), Some("sess-a"));
    assert_eq!(col(&store, req, "model").as_deref(), Some("claude-opus-5"));
    assert_eq!(col(&store, req, "cc_prev_req").as_deref(), Some("req_011aaaa"));
    assert_eq!(col(&store, req, "previous_message_id").as_deref(), Some("msg_01prev"));
    assert_eq!(col(&store, req, "breakpoint_positions").as_deref(), Some("system:1,system:2,messages:0"));
    assert_eq!(col(&store, req, "thinking_config").as_deref(), Some("adaptive"));
    // PIN THE COLUMN MAPPING, not just presence. `append_api_call_row` feeds 26 values
    // POSITIONALLY into 26 columns; `tools_fp` and `first_user_fp` are adjacent, both VARCHAR,
    // and both bare 16-hex — so an `is_some()` assertion would let a transposition through
    // silently and permanently. Each is pinned to the hash of its own canonical string.
    let fp16 = |s: &str| agentlens_store::sections::sha256_hex(s)[..16].to_owned();
    assert_eq!(col(&store, req, "tools_fp"), Some(fp16("Bash,Read,Edit")));
    assert_eq!(col(&store, req, "first_user_fp"), Some(fp16("the first user turn")));
    assert_ne!(col(&store, req, "tools_fp"), col(&store, req, "first_user_fp"));
    assert_eq!(col(&store, req, "tool_choice"), None, "an absent parameter is NULL, not 'null'");
    assert_eq!(col(&store, req, "cache_miss_reason"), None, "response-only field is NULL on a request row");
    assert_eq!(col_i64(&store, req, "cache_creation_tokens"), None);
    // The billing header is stored WHOLE so SQL can read any of its seven tokens — including
    // cc_workload, which has no column of its own and no other reader in the repo.
    let workload: Option<String> = store
        .con
        .query_row(
            &format!(
                "SELECT regexp_extract(billing_header, 'cc_workload=([^;]+)', 1) FROM {} WHERE stem = '{req}'",
                all_of(&store, "api_call")
            ),
            [],
            |r| r.get(0),
        )
        .expect("regexp_extract");
    assert_eq!(workload.as_deref(), Some("cron"), "7YPQWKPG: the store holds the fact, SQL derives the answer");

    // ── response row: the token buckets, the tier split, the miss reason ──────────
    let resp = "req_011bbbb";
    assert_eq!(col(&store, resp, "kind").as_deref(), Some("response"));
    assert_eq!(col(&store, resp, "msg_id").as_deref(), Some("msg_01resp"));
    assert_eq!(col_i64(&store, resp, "input_tokens"), Some(12));
    assert_eq!(col_i64(&store, resp, "output_tokens"), Some(340));
    assert_eq!(col_i64(&store, resp, "cache_read_tokens"), Some(80000));
    assert_eq!(col_i64(&store, resp, "cache_creation_tokens"), Some(4200));
    assert_eq!(col_i64(&store, resp, "tier_5m_tokens"), Some(200));
    assert_eq!(col_i64(&store, resp, "tier_1h_tokens"), Some(4000));
    assert_eq!(col_i64(&store, resp, "cache_missed_input_tokens"), Some(4177));
    assert_eq!(col(&store, resp, "cache_miss_reason").as_deref(), Some("messages_changed"));
    assert_eq!(col(&store, resp, "service_tier").as_deref(), Some("standard"));
    assert_eq!(col(&store, resp, "session_id"), None, "a response carries no session id — N6A8VX3G's link resolves it");
    assert_eq!(col(&store, resp, "system_fps"), None, "request-only field is NULL on a response row");

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

#[test]
fn the_rows_flush_to_parquet_and_survive_a_reopen() {
    let (bodies, store_dir) = fixture("durable");
    write_body(&bodies, "aaaa1111-0000-4000-8000-000000000002.request.json", &request_body("sess-b", "req_011cccc"), 60_000);
    write_body(&bodies, "req_011dddd.response.json", &response_body("msg_02resp"), 50_000);

    {
        let mut store = open_store(&store_dir, "1GB", 4).expect("open");
        let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
        let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
        let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
        assert_eq!(r.ingested, 2, "failed: {:?}", r.failed);
    }

    // `open_store` must create the dir AND `flush_detailed` must write a part into it — the two
    // plumbing points the card calls out separately, because a schema alone writes nowhere.
    let parts: Vec<PathBuf> = fs::read_dir(store_dir.join(API_CALLS_DIR))
        .expect("api_calls dir exists")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "parquet"))
        .collect();
    assert!(!parts.is_empty(), "flush_detailed must write store/api_calls/*.parquet");

    // A fresh process reading only what is on disk: the staging table is empty, so every row
    // below came out of the flushed parquet part.
    let store2 = open_store(&store_dir, "1GB", 4).expect("reopen");
    let staged: i64 = store2.con.query_row("SELECT count(*) FROM api_call", [], |r| r.get(0)).expect("staging");
    assert_eq!(staged, 0, "staging starts empty after a restart");
    let durable: i64 = store2
        .con
        .query_row(&format!("SELECT count(*) FROM {}", all_of(&store2, "api_call")), [], |r| r.get(0))
        .expect("durable count");
    assert_eq!(durable, 2, "both rows survive the restart in parquet");
    assert_eq!(col(&store2, "req_011dddd", "cache_miss_reason").as_deref(), Some("messages_changed"));
    assert_eq!(col(&store2, "aaaa1111-0000-4000-8000-000000000002", "session_id").as_deref(), Some("sess-b"));

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

/// THE APPENDER WRITES 26 VALUES POSITIONALLY into a 26-column table, so a swap between two
/// same-typed neighbours compiles, runs, and passes any test that only checks a column
/// `is_some()`. Every other assertion in this file pins adjacent columns to DISTINCT values —
/// except `system_fps`/`tools_fp`/`first_user_fp`, three adjacent VARCHARs that all hold
/// 16-hex strings. This pins them BY BEHAVIOUR, through the real appender and real SQL: change
/// ONLY the tools and only `tools_fp` may move; change ONLY the first user message and only
/// `first_user_fp` may move.
#[test]
fn the_three_adjacent_fingerprint_columns_are_not_swapped_by_the_appender() {
    let (_bodies, store_dir) = fixture("fpcols");
    let mut store = open_store(&store_dir, "1GB", 4).expect("open");

    let build = |tools: serde_json::Value, first_user: &str| {
        serde_json::json!({
            "model": "claude-opus-5",
            "system": [
                { "type": "text", "text": "x-anthropic-billing-header: cc_prev_req=req_011aaaa;" },
                { "type": "text", "text": "a constant rules block" }
            ],
            "tools": tools,
            "messages": [ { "role": "user", "content": [ {"type":"text","text": first_user} ] } ]
        })
        .to_string()
    };
    let base = build(serde_json::json!([{"name":"Bash"},{"name":"Read"}]), "the first user turn");
    let other_tools = build(serde_json::json!([{"name":"Bash"},{"name":"Edit"}]), "the first user turn");
    let other_user = build(serde_json::json!([{"name":"Bash"},{"name":"Read"}]), "a completely different opening");

    for (name, raw) in [("aaa.request.json", &base), ("bbb.request.json", &other_tools), ("ccc.request.json", &other_user)] {
        agentlens_store::ingest_body(&mut store, name, raw, 1_787_000_000_000).expect("ingest");
    }

    let get = |stem: &str, c: &str| col(&store, stem, c).unwrap_or_else(|| panic!("{c} must be set on {stem}"));

    // Changing the tools moves tools_fp and NOTHING else.
    assert_ne!(get("aaa", "tools_fp"), get("bbb", "tools_fp"));
    assert_eq!(get("aaa", "first_user_fp"), get("bbb", "first_user_fp"));
    assert_eq!(get("aaa", "system_fps"), get("bbb", "system_fps"));

    // Changing the first user message moves first_user_fp and NOTHING else.
    assert_ne!(get("aaa", "first_user_fp"), get("ccc", "first_user_fp"));
    assert_eq!(get("aaa", "tools_fp"), get("ccc", "tools_fp"));
    assert_eq!(get("aaa", "system_fps"), get("ccc", "system_fps"));

    // And the three hold genuinely different values, so a swap cannot hide behind equality.
    assert_ne!(get("aaa", "tools_fp"), get("aaa", "first_user_fp"));
    assert!(get("aaa", "system_fps").starts_with("agentmeta,"), "system_fps is the positional list, not a bare hash");

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

/// The behavioural half of the column-mapping pin: `system_fps`, `tools_fp` and `first_user_fp`
/// are three ADJACENT VARCHAR columns all holding bare 16-hex, fed POSITIONALLY into a 26-value
/// `params!` list — a transposition there compiles, runs, and passes any presence check silently
/// and permanently. Change exactly ONE input and exactly ONE column must move.
#[test]
fn each_fingerprint_column_moves_only_for_its_own_input() {
    let (_bodies, store_dir) = fixture("fpmap");
    let mut store = open_store(&store_dir, "1GB", 4).expect("open");

    let body = |tools: &str, first_user: &str| {
        serde_json::json!({
            "model": "claude-opus-5",
            "system": [
                { "type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.258; cc_prev_req=req_1;" },
                { "type": "text", "text": "stable rules block" }
            ],
            "tools": tools.split(',').map(|n| serde_json::json!({"name": n})).collect::<Vec<_>>(),
            "messages": [ { "role":"user", "content": first_user } ]
        })
        .to_string()
    };

    let base = body("Bash,Read", "turn one");
    let tools_changed = body("Bash,Read,Edit", "turn one");
    let user_changed = body("Bash,Read", "turn two");
    for (name, raw) in [("base", &base), ("tools", &tools_changed), ("user", &user_changed)] {
        agentlens_store::ingest_body(&mut store, &format!("{name}.request.json"), raw, 1_787_000_000_000)
            .unwrap_or_else(|e| panic!("ingest {name}: {e}"));
    }

    let fp = |stem: &str, c: &str| col(&store, stem, c).unwrap_or_else(|| panic!("{stem}.{c} is NULL"));

    // Only the tool list changed: tools_fp moves, the other two hold.
    assert_ne!(fp("tools", "tools_fp"), fp("base", "tools_fp"), "tools_fp must track the tool list");
    assert_eq!(fp("tools", "first_user_fp"), fp("base", "first_user_fp"), "first_user_fp must NOT track tools");
    assert_eq!(fp("tools", "system_fps"), fp("base", "system_fps"), "system_fps must NOT track tools");

    // Only the first user message changed: first_user_fp moves, the other two hold.
    assert_ne!(fp("user", "first_user_fp"), fp("base", "first_user_fp"), "first_user_fp must track the first user turn");
    assert_eq!(fp("user", "tools_fp"), fp("base", "tools_fp"), "tools_fp must NOT track the user turn");
    assert_eq!(fp("user", "system_fps"), fp("base", "system_fps"), "system_fps must NOT track the user turn");

    // And the three are mutually distinct on one row, so no pair can hide a swap.
    let (a, b, c) = (fp("base", "system_fps"), fp("base", "tools_fp"), fp("base", "first_user_fp"));
    assert!(a != b && b != c && a != c, "all three fingerprints must differ: {a} {b} {c}");

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

/// The durability barrier must COVER the new directory, not just the three it knew about. A
/// schema and a flush target are not enough: an api_calls part the barrier never walks is a part
/// the pass deleted bodies against without ever forcing it to disk. Asserted on the fsynced set
/// itself — the pass's own record of what it pushed through `sync_all`.
#[test]
fn the_fsync_barrier_covers_the_new_api_calls_directory() {
    let (bodies, store_dir) = fixture("barrier");
    write_body(&bodies, "bar00000-0000-4000-8000-000000000007.request.json", &request_body("sess-e", "req_011gggg"), 60_000);

    let mut store = open_store(&store_dir, "1GB", 4).expect("open");
    // durable_source is what arms the barrier; the server sets it, the default does not.
    let opts = PassOptions { bodies_dir: bodies.clone(), durable_source: true, ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.ingested, 1, "failed: {:?}", r.failed);
    assert_eq!(r.deleted, 1, "the barrier must pass so the body can be deleted: {:?}", r.failed);

    let api_dir = store_dir.join(API_CALLS_DIR);
    assert!(
        fsynced.iter().any(|p| p.starts_with(&api_dir)),
        "no api_calls part was fsynced — the barrier still walks only the original three dirs: {fsynced:?}"
    );

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

/// The content-dedup path: the SAME bytes captured under a second filename still get their own
/// api_call row, because the writer sits inside `append_body_row` — the one place a body row is
/// created — rather than at one of `ingest_body`'s two call sites.
#[test]
fn the_content_dedup_path_still_writes_a_row_for_the_second_name() {
    let (_bodies, store_dir) = fixture("dedup");
    let raw = request_body("sess-c", "req_011eeee");
    let mut store = open_store(&store_dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "first0000-0000-4000-8000-000000000003.request.json", &raw, 1_787_000_000_000)
        .expect("ingest 1");
    let again = agentlens_store::ingest_body(
        &mut store,
        "second000-0000-4000-8000-000000000004.request.json",
        &raw,
        1_787_000_001_000,
    )
    .expect("ingest 2");
    assert!(again.existed, "same bytes: the content dedup must fire");

    let n: i64 = store.con.query_row("SELECT count(*) FROM api_call", [], |r| r.get(0)).expect("count");
    assert_eq!(n, 2, "one row per capture EVENT, not per unique body");
    assert_eq!(col_i64(&store, "second000-0000-4000-8000-000000000004", "ts_ms"), Some(1_787_000_001_000));

    // And re-ingesting a name already known writes nothing more (GATE 2 reaches this table too).
    agentlens_store::ingest_body(&mut store, "first0000-0000-4000-8000-000000000003.request.json", &raw, 1_787_000_000_000)
        .expect("re-ingest");
    let n2: i64 = store.con.query_row("SELECT count(*) FROM api_call", [], |r| r.get(0)).expect("count");
    assert_eq!(n2, 2, "a re-ingest of a known (body, name) writes no duplicate row");

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

/// A body that is not JSON must not break the pass, and must not leave a junk row behind: its
/// `body` row still lands (the bytes are stored and reconstructible), but there is nothing to
/// extract, so no api_call row is written.
#[test]
fn an_unparseable_body_still_ingests_and_writes_no_api_call_row() {
    let (bodies, store_dir) = fixture("junk");
    write_body(&bodies, "junk0000-0000-4000-8000-000000000005.request.json", &"n".repeat(500), 60_000);
    write_body(&bodies, "ok000000-0000-4000-8000-000000000006.request.json", &request_body("sess-d", "req_011ffff"), 50_000);

    let mut store = open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.ingested, 2, "both bodies still store: {:?}", r.failed);

    let bodies_rows: i64 = store
        .con
        .query_row(&format!("SELECT count(*) FROM {}", all_of(&store, "body")), [], |r| r.get(0))
        .expect("body count");
    assert_eq!(bodies_rows, 2, "the unparseable body still gets its body row");
    let calls: i64 = store
        .con
        .query_row(&format!("SELECT count(*) FROM {}", all_of(&store, "api_call")), [], |r| r.get(0))
        .expect("api_call count");
    assert_eq!(calls, 1, "only the parseable body yields per-call facts");

    let _ = fs::remove_dir_all(store_dir.parent().unwrap());
}

// ── QSFYIHUO step 2: the prefix_json column + the W1 two-stage read ──────────────

use agentlens_store::bodies_evidence::list_prefix_rows;
use agentlens_store::pass::ingest_pass_observed_with;

/// Drive one pass WITH an extractor installed (the production shape), for `n` request bodies.
fn pass_with_extractor(bodies: &Path, store_dir: &Path, tag: &str, n: usize) {
    let mut store = open_store(store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.to_path_buf(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let mut extractor = |parsed: Option<&serde_json::Value>| -> Option<String> {
        let p = parsed?;
        let model = p.get("model").and_then(|m| m.as_str()).unwrap_or("?").to_owned();
        Some(format!("{{\"v\":1,\"p\":{{\"model\":\"{model}-ext-{tag}\"}}}}"))
    };
    let r = ingest_pass_observed_with(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced, None, Some(&mut extractor), None);
    assert!(r.failed.is_empty(), "pass must be clean: {:?}", r.failed);
    assert_eq!(r.ingested, n as u64, "all bodies ingested");
}

#[test]
fn extractor_backed_pass_persists_prefix_json_and_list_prefix_rows_reads_it_back() {
    let (bodies, store_dir) = fixture("prefix");
    write_body(&bodies, "2f8caaaa-0000-4000-8000-000000000011.request.json", &request_body("sess-p", "req_p1"), 60_000);
    write_body(&bodies, "req_p2.response.json", &response_body("msg_p2"), 50_000);

    pass_with_extractor(&bodies, &store_dir, "one", 2);

    // The read path returns the request row with the extractor's envelope, verbatim.
    let rows = list_prefix_rows(&store_dir, None, 100).expect("prefix query");
    assert_eq!(rows.len(), 1, "request rows only: {rows:?}");
    assert_eq!(rows[0].stem, "2f8caaaa-0000-4000-8000-000000000011");
    assert_eq!(rows[0].session_id.as_deref(), Some("sess-p"));
    let pj = rows[0].prefix_json.as_deref().expect("the extractor's prefix MUST land on the row");
    assert_eq!(pj, "{\"v\":1,\"p\":{\"model\":\"claude-opus-5-ext-one\"}}", "envelope verbatim: {pj}");
}

#[test]
fn a_null_prefix_row_still_lists_with_none_and_the_window_filters_in_sql() {
    let (bodies, store_dir) = fixture("prefixnull");
    // Two request bodies: one ingested WITH the extractor (recent), one WITHOUT (older) —
    // a mixed-generation store.
    write_body(&bodies, "2f8caaaa-0000-4000-8000-000000000021.request.json", &request_body("sess-n1", "req_n1"), 60_000);
    pass_with_extractor(&bodies, &store_dir, "hot", 1);

    let mut store = open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    write_body(&bodies, "2f8caaaa-0000-4000-8000-000000000022.request.json", &request_body("sess-n2", "req_n2"), 120_000);
    let r = ingest_pass_observed_with(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced, None, None, None);
    assert_eq!(r.ingested, 1, "second pass ingests the older body without an extractor: {:?}", r.failed);
    drop(store);

    // Unwindowed top-2: BOTH rows come back, the NULL-prefix one honestly carrying None.
    let rows = list_prefix_rows(&store_dir, None, 2).expect("query");
    assert_eq!(rows.len(), 2, "both request rows list: {rows:?}");
    let by_stem: std::collections::HashMap<&str, &agentlens_store::bodies_evidence::PrefixRow> =
        rows.iter().map(|r| (r.stem.as_str(), r)).collect();
    assert!(by_stem["2f8caaaa-0000-4000-8000-000000000021"].prefix_json.is_some(), "extractor-fed row has its prefix");
    assert_eq!(
        by_stem["2f8caaaa-0000-4000-8000-000000000022"].prefix_json, None,
        "pre-extractor row carries None — the body-scan fallback signal"
    );

    // Windowed: only the RECENT row (60s old) is inside a 90s window; the 120s-old one is out.
    let since = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64) - 90_000.0;
    let rows = list_prefix_rows(&store_dir, Some(since), 100).expect("windowed query");
    assert_eq!(rows.len(), 1, "the window filters in SQL: {rows:?}");
    assert_eq!(rows[0].stem, "2f8caaaa-0000-4000-8000-000000000021");

    // W1/S2: the top-K precedes the wide projection — a cap of 1 returns exactly the most
    // recent row, and the query never had to read prefix_json beyond the selected stem.
    let rows = list_prefix_rows(&store_dir, None, 1).expect("capped query");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].stem, "2f8caaaa-0000-4000-8000-000000000021", "top-1 by ts DESC");
}
