//! Integration tests of agentlens-digest — ONE test binary, because each test binary statically
//! links DuckDB. Fixtures are synthetic with visibly fake ids (aaaaaaaa, bbbb2222). The crash
//! tests (7, 8) drive the real `aldigest` binary built with the `crashpoints` feature (switched
//! on for test builds by the self dev-dependency in Cargo.toml) and SIGKILL it.

use agentlens_digest::collect::{collect, Summary};
use agentlens_digest::open;
use agentlens_digest::register::register;
use agentlens_digest::schema::{load_manifest, producer_schema_name, schema_hash, Producer};
use duckdb::Connection;
use serde_json::{json, Value};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

const TS0: i64 = 1_700_000_000_123_456_789;
const SE: &str = "hook_session_end_v1";

// ---------------------------------------------------------------- fixtures and helpers

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// A scratch ingest directory + database under cargo's target tmp dir, wiped at creation.
struct Fx {
    root: PathBuf,
}

impl Fx {
    fn new(name: &str) -> Fx {
        let root = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("aldigest").join(name);
        if root.exists() {
            std::fs::remove_dir_all(&root).unwrap();
        }
        std::fs::create_dir_all(root.join("ingest/ready")).unwrap();
        Fx { root }
    }
    fn db(&self) -> PathBuf {
        self.root.join("t.duckdb")
    }
    fn ingest(&self) -> PathBuf {
        self.root.join("ingest")
    }
    fn conn(&self) -> Connection {
        open(&self.db()).unwrap()
    }
    fn put(&self, spool: &str, name: &str, content: &str) {
        let dir = self.ingest().join("ready").join(spool);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name), content).unwrap();
    }
    fn names(&self, stage: &str, spool: &str) -> Vec<String> {
        let dir = self.ingest().join(stage).join(spool);
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut v: Vec<String> = rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn collect(&self) -> Summary {
        collect(&self.conn(), &self.ingest()).unwrap()
    }
}

fn crate_manifest() -> Value {
    serde_json::from_str(&std::fs::read_to_string(crate_dir().join("schemas/manifest.json")).unwrap()).unwrap()
}

/// Write `<fx>/manifest.json` with the crate manifest entries accepted by `pick` (schema paths
/// made absolute) and register them into the fixture database.
fn register_where(fx: &Fx, pick: &dyn Fn(&Value) -> bool) -> Vec<Producer> {
    let mut m = crate_manifest();
    let kept: Vec<Value> = m["producers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| pick(e))
        .map(|e| {
            let mut e = e.clone();
            e["schema"] = json!(crate_dir().join("schemas").join(e["schema"].as_str().unwrap()).to_string_lossy());
            e
        })
        .collect();
    assert!(!kept.is_empty(), "pick matched no producer");
    m["producers"] = json!(kept);
    let path = fx.root.join("manifest.json");
    std::fs::write(&path, serde_json::to_string_pretty(&m).unwrap()).unwrap();
    let producers = load_manifest(&path).unwrap();
    register(&fx.conn(), &producers).unwrap();
    producers
}

fn only(pts: &'static [&'static str]) -> impl Fn(&Value) -> bool {
    move |e| pts.iter().any(|p| e["producer_type"] == *p)
}

fn t(producer_type: &str) -> String {
    format!("\"{}\".\"events\"", producer_schema_name(producer_type))
}

fn line(ts: i64, payload: &Value) -> String {
    json!({"ts_ns": ts, "payload": payload}).to_string()
}

fn lines(payloads: &[Value]) -> String {
    payloads.iter().enumerate().map(|(i, p)| line(TS0 + i as i64, p) + "\n").collect()
}

fn select(conn: &Connection, exprs: &[&str], from: &str, order: &str) -> Vec<Vec<Option<String>>> {
    let list = exprs.iter().map(|e| format!("CAST({e} AS VARCHAR)")).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT {list} FROM {from} ORDER BY {order}");
    let mut st = conn.prepare(&sql).unwrap_or_else(|e| panic!("{sql}: {e}"));
    let n = exprs.len();
    st.query_map([], |r| (0..n).map(|i| r.get::<_, Option<String>>(i)).collect::<Result<Vec<_>, _>>())
        .unwrap()
        .map(|x| x.unwrap())
        .collect()
}

fn one(conn: &Connection, expr: &str, from: &str) -> Option<String> {
    let rows = select(conn, &[expr], from, "1");
    assert_eq!(rows.len(), 1, "expected one row from {from}");
    rows[0][0].clone()
}

fn count(conn: &Connection, from: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {from}"), [], |r| r.get(0)).unwrap()
}

fn s(v: &str) -> Option<String> {
    Some(v.to_owned())
}

fn ledger(conn: &Connection) -> Vec<Vec<Option<String>>> {
    select(conn, &["spool", "source_name", "status", "record_count", "source_size_bytes"], "_ingest.files", "ingest_id")
}

fn session_end_payload(i: usize) -> Value {
    json!({
        "agent_id": format!("agent-aaaaaaaa-{i}"), "agent_type": "general-purpose", "cwd": "/work/aaaaaaaa",
        "effort": {"level": "high"}, "hook_event_name": "SessionEnd", "permission_mode": "default",
        "prompt_id": format!("bbbb2222-{i}"), "reason": "clear", "scratchpad_dir": "/scratch/aaaaaaaa",
        "session_id": format!("aaaaaaaa-{i}"), "transcript_path": format!("/t/aaaaaaaa-{i}.jsonl")
    })
}

fn statusline_main_payload(i: usize) -> Value {
    json!({
        "agent": {"name": "agent-aaaaaaaa"}, "agent_type": "reviewer",
        "context_window": {
            "context_window_size": 200000,
            "current_usage": {"cache_creation_input_tokens": 10, "cache_read_input_tokens": 20, "input_tokens": 30, "output_tokens": 40},
            "remaining_percentage": 75, "total_input_tokens": 1000 + i, "total_output_tokens": 2000, "used_percentage": 24.5
        },
        "cost": {"total_api_duration_ms": 5, "total_cost_usd": 1.25, "total_duration_ms": 9, "total_lines_added": 3, "total_lines_removed": 1},
        "cwd": "/work/aaaaaaaa", "effort": {"level": "high"}, "exceeds_200k_tokens": false, "fast_mode": true,
        "model": {"display_name": "Model A", "id": "model-aaaaaaaa"}, "output_style": {"name": "default"},
        "pr": {"kind": "mr", "number": 7, "review_state": "approved", "url": "https://example.invalid/pr/7"},
        "prompt_cache": {
            "cache_write_tokens": 1, "caching_observed": true, "expected_rebuilds": 0, "expires_at": 1700000300, "hit_ratio": 0.5,
            "last_miss_at": null, "last_miss_cause": {"causes": ["ttl_expired_5m", "tools_changed"], "tools_added": 2},
            "miss_causes": {"ttl_expired_5m": 3, "tools_changed": 1}, "miss_recache_tokens": 0, "misses": 4,
            "recache_tokens_if_cold": null, "requests": 9, "ttl": "1h", "warm": true
        },
        "prompt_id": "bbbb2222",
        "rate_limits": {
            "five_hour": {"resets_at": 1700003600, "used_percentage": 12.5},
            "seven_day": {"resets_at": 1700600000, "used_percentage": 3.5},
            "spend_limit": {"limit_usd": 10.0, "period": "daily", "resets_at": 1700090000, "used_percentage": 1.5, "used_usd": 0.15}
        },
        "scratchpad_dir": "/scratch/aaaaaaaa", "session_id": format!("aaaaaaaa-{i}"), "session_name": "demo",
        "thinking": {"enabled": true}, "transcript_path": "/t/aaaaaaaa.jsonl", "version": "2.1.285", "vim": {"mode": "NORMAL"},
        "workspace": {
            "added_dirs": ["/a", "/b"], "current_dir": "/work", "project_dir": "/work", "git_worktree": "wt",
            "repo": {"host": "example.invalid", "name": "demo", "owner": "aaaaaaaa"}
        },
        "worktree": {"branch": "b", "name": "n", "original_branch": "main", "original_cwd": "/work", "path": "/wt"}
    })
}

/// A value of the schema node holding only what the schema requires (generated from the schema).
fn minimal(node: &Value) -> Value {
    if node.get("x-duckdb-type").is_some() {
        return json!({"k": 1});
    }
    if let Some(branches) = node.get("anyOf").and_then(Value::as_array) {
        return minimal(&branches[0]);
    }
    let kind = match &node["type"] {
        Value::String(k) => k.clone(),
        Value::Array(list) => list.iter().filter_map(Value::as_str).find(|k| *k != "null").unwrap().to_owned(),
        _ => "object".to_owned(),
    };
    match kind.as_str() {
        "string" => node["enum"][0].as_str().or(node["const"].as_str()).unwrap_or("x").into(),
        "integer" => json!(1),
        "number" => json!(1.5),
        "boolean" => json!(true),
        "array" => json!([]),
        _ => required_payload(node),
    }
}

fn required_payload(schema: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for name in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        out.insert(name.to_owned(), minimal(&schema["properties"][name]));
    }
    Value::Object(out)
}

fn session_end_fixture(name: &str) -> Fx {
    let fx = Fx::new(name);
    register_where(&fx, &only(&[SE]));
    fx
}

// ---------------------------------------------------------------- 1-2 round trips

/// 1. hook_session_end_v1: N lines in, N rows out, every column equals its expected value.
#[test]
fn t01_round_trip_session_end() {
    let fx = session_end_fixture("t01");
    let payloads: Vec<Value> = (0..5).map(session_end_payload).collect();
    fx.put(SE, "a.ndjson", &lines(&payloads));
    let sum = fx.collect();
    assert_eq!(sum, Summary { files_loaded: 1, rows: 5, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    let got = select(
        &conn,
        &["_meta_record_ordinal", "_meta_recorded_at_ns", "epoch_us(_meta_recorded_at)", "agent_id", "agent_type", "cwd", "effort.level",
          "hook_event_name", "permission_mode", "prompt_id", "reason", "scratchpad_dir", "session_id", "transcript_path"],
        &t(SE),
        "_meta_record_ordinal",
    );
    let expected: Vec<Vec<Option<String>>> = (0..5)
        .map(|i| {
            vec![
                s(&i.to_string()), s(&(TS0 + i as i64).to_string()), s(&((TS0 + i as i64) / 1000).to_string()),
                s(&format!("agent-aaaaaaaa-{i}")), s("general-purpose"), s("/work/aaaaaaaa"), s("high"),
                s("SessionEnd"), s("default"), s(&format!("bbbb2222-{i}")), s("clear"), s("/scratch/aaaaaaaa"),
                s(&format!("aaaaaaaa-{i}")), s(&format!("/t/aaaaaaaa-{i}.jsonl")),
            ]
        })
        .collect();
    assert_eq!(got, expected);
    // The rows carry the ledger's ingest id and a real ingested_at; the ledger row is complete.
    let id = one(&conn, "ingest_id", "_ingest.files").unwrap();
    assert_eq!(count(&conn, &format!("{} WHERE _meta_ingest_id = {id} AND _meta_ingested_at IS NOT NULL", t(SE))), 5);
    assert_eq!(ledger(&conn).len(), 1);
    assert_eq!(ledger(&conn)[0][..4], [s(SE), s("a.ndjson"), s("complete"), s("5")]);
    assert_eq!(count(&conn, "_ingest.files WHERE completed_at >= ingested_at"), 1);
    assert_eq!(fx.names("done", SE), ["a.ndjson"]);
}

/// 2. statusline_main (14 topic tables, one spool): nested STRUCT, LIST and JSON values round trip.
#[test]
fn t02_round_trip_statusline_main() {
    let fx = Fx::new("t02");
    register_where(&fx, &|e| e["spool"] == "statusline_main");
    let payloads: Vec<Value> = (0..3).map(statusline_main_payload).collect();
    fx.put("statusline_main", "a.ndjson", &lines(&payloads));
    assert_eq!(fx.collect().rows, 3);
    let conn = fx.conn();
    let m = |topic: &str| t(&format!("statusline_main_{topic}_v1"));
    for tbl in ["agent", "context_window", "core", "cost", "effort", "model", "output_style", "pr", "prompt_cache", "rate_limits", "thinking", "vim", "workspace", "worktree"] {
        assert_eq!(count(&conn, &m(tbl)), 3, "rows in {tbl}");
    }
    let ord = "_meta_record_ordinal";
    assert_eq!(select(&conn, &["model.id", "model.display_name"], &m("model"), ord)[1], vec![s("model-aaaaaaaa"), s("Model A")]);
    // STRUCT inside STRUCT, DOUBLE and BIGINT leaves.
    assert_eq!(
        select(
            &conn,
            &["context_window.current_usage.input_tokens", "context_window.total_input_tokens", "context_window.used_percentage", "context_window.remaining_percentage"],
            &m("context_window"),
            ord
        )[2],
        vec![s("30"), s("1002"), s("24.5"), s("75.0")]
    );
    assert_eq!(select(&conn, &["cost.total_cost_usd", "cost.total_lines_added"], &m("cost"), ord)[0], vec![s("1.25"), s("3")]);
    // LIST of VARCHAR, and a STRUCT nested in the STRUCT next to it.
    assert_eq!(
        select(&conn, &["array_to_string(workspace.added_dirs, '|')", "len(workspace.added_dirs)", "workspace.repo.owner"], &m("workspace"), ord)[0],
        vec![s("/a|/b"), s("2"), s("aaaaaaaa")]
    );
    // LIST inside a nullable STRUCT, and the open object stored as JSON.
    assert_eq!(
        select(
            &conn,
            &["array_to_string(prompt_cache.last_miss_cause.causes, '|')", "json_extract_string(prompt_cache.miss_causes, '$.ttl_expired_5m')", "prompt_cache.last_miss_at IS NULL"],
            &m("prompt_cache"),
            ord
        )[0],
        vec![s("ttl_expired_5m|tools_changed"), s("3"), s("true")]
    );
    // session_id rides in the topics that carry it; no status-line column is NOT NULL.
    assert_eq!(select(&conn, &["session_id"], &m("core"), ord)[1], vec![s("aaaaaaaa-1")]);
    assert_eq!(count(&conn, "duckdb_columns() WHERE schema_name LIKE 'p_statusline%' AND NOT is_nullable AND NOT starts_with(column_name, '_meta_')"), 0);
    assert!(count(&conn, "duckdb_columns() WHERE schema_name LIKE 'p_statusline%' AND is_nullable") > 0);
}

// ---------------------------------------------------------------- 3 every producer

/// 3. Every producer of the manifest registers; a line of only its required fields loads as one row.
#[test]
fn t03_every_producer_loads_a_required_only_line() {
    let fx = Fx::new("t03");
    let producers = register_where(&fx, &|_| true);
    assert_eq!(producers.len(), 89);
    let mut spools: Vec<&str> = producers.iter().map(|p| p.spool.as_str()).collect();
    spools.sort_unstable();
    spools.dedup();
    for spool in &spools {
        // One payload per spool: the required fields of every producer in it, merged.
        let mut payload = serde_json::Map::new();
        for p in producers.iter().filter(|p| p.spool == *spool) {
            payload.extend(required_payload(&p.schema_json).as_object().unwrap().clone());
        }
        fx.put(spool, "m.ndjson", &lines(&[Value::Object(payload)]));
    }
    let sum = fx.collect();
    assert_eq!(sum, Summary { files_loaded: spools.len() as u64, rows: spools.len() as u64, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    for p in &producers {
        assert_eq!(count(&conn, &p.qualified_table()), 1, "{}", p.producer_type);
    }
}

// ---------------------------------------------------------------- 4-6 content rules

/// 4. Unknown keys (top level, nested, and inside a LIST of structs) are ignored and the row loads.
#[test]
fn t04_unknown_keys_are_ignored() {
    let fx = session_end_fixture("t04");
    let mut p = session_end_payload(0);
    p["unknown_top"] = json!({"deep": [1, 2]});
    p["effort"]["unknown_nested"] = json!(true);
    fx.put(SE, "a.ndjson", &lines(&[p]));
    assert_eq!(fx.collect().files_loaded, 1);
    let conn = fx.conn();
    assert_eq!(select(&conn, &["effort.level", "session_id"], &t(SE), "1")[0], vec![s("high"), s("aaaaaaaa-0")]);

    let fx = Fx::new("t04b");
    register_where(&fx, &only(&["statusline_subagent_core_v1"]));
    let tasks = json!([{"id": "aaaaaaaa", "effort": "high", "tokenSamples": [1, 2], "unknown_inner": 1}, {"id": "bbbb2222", "effort": 5}]);
    fx.put("statusline_subagent", "a.ndjson", &lines(&[json!({"tasks": tasks, "columns": 80})]));
    assert_eq!(fx.collect().files_loaded, 1);
    let conn = fx.conn();
    let tbl = t("statusline_subagent_core_v1");
    assert_eq!(select(&conn, &["len(tasks)", "tasks[1].id", "tasks[2].id", "array_to_string(tasks[1].tokenSamples, '|')", "columns"], &tbl, "1")[0], vec![s("2"), s("aaaaaaaa"), s("bbbb2222"), s("1|2"), s("80")]);
    // The union-typed field is stored as JSON: a string and a number both survive.
    assert_eq!(select(&conn, &["json_extract_string(tasks[1].effort, '$')", "json_extract_string(tasks[2].effort, '$')"], &tbl, "1")[0], vec![s("high"), s("5")]);
}

/// 5. A missing optional key is NULL; a missing required key sends the file to failed/ (zero rows, ledger `failed`).
#[test]
fn t05_missing_optional_is_null_missing_required_fails_the_file() {
    let fx = session_end_fixture("t05");
    let mut p = session_end_payload(0);
    for k in ["agent_id", "effort", "prompt_id"] {
        p.as_object_mut().unwrap().remove(k);
    }
    fx.put(SE, "a.ndjson", &lines(&[p]));
    assert_eq!(fx.collect().files_loaded, 1);
    assert_eq!(
        select(&fx.conn(), &["agent_id IS NULL", "effort IS NULL", "prompt_id IS NULL", "session_id"], &t(SE), "1")[0],
        vec![s("true"), s("true"), s("true"), s("aaaaaaaa-0")]
    );

    let mut bad = session_end_payload(1);
    bad.as_object_mut().unwrap().remove("session_id");
    fx.put(SE, "b.ndjson", &lines(&[bad]));
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 1, files_reconciled: 0 });
    let conn = fx.conn();
    assert_eq!(count(&conn, &t(SE)), 1, "zero rows from the failed file");
    assert_eq!(fx.names("failed", SE), ["b.ndjson", "b.ndjson.error.txt"]);
    assert!(fx.names("ready", SE).is_empty());
    let rows = select(&conn, &["status", "error_message LIKE '%session_id%'"], "_ingest.files WHERE source_name = 'b.ndjson'", "1");
    assert_eq!(rows, vec![vec![s("failed"), s("true")]]);
    let err_file = std::fs::read_to_string(fx.ingest().join("failed").join(SE).join("b.ndjson.error.txt")).unwrap();
    assert!(err_file.contains("session_id"), "{err_file}");
}

/// 6. A wrong-typed value fails its file in every topic table of the spool, and the next file still loads.
#[test]
fn t06_wrong_type_fails_the_file_and_the_next_one_loads() {
    let fx = Fx::new("t06");
    register_where(&fx, &only(&["statusline_main_cost_v1", "statusline_main_core_v1"]));
    let good = json!({"cost": {"total_duration_ms": 9}, "session_id": "aaaaaaaa"});
    let bad = json!({"cost": {"total_duration_ms": "abc"}, "session_id": "bbbb2222"});
    fx.put("statusline_main", "a.ndjson", &lines(&[good.clone(), bad]));
    fx.put("statusline_main", "b.ndjson", &lines(&[good]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 1, files_failed: 1, files_reconciled: 0 });
    let conn = fx.conn();
    for pt in ["statusline_main_cost_v1", "statusline_main_core_v1"] {
        assert_eq!(count(&conn, &t(pt)), 1, "only b.ndjson loaded into {pt}");
    }
    assert_eq!(fx.names("failed", "statusline_main"), ["a.ndjson", "a.ndjson.error.txt"]);
    assert_eq!(fx.names("done", "statusline_main"), ["b.ndjson"]);
    let rows = select(&conn, &["source_name", "status", "error_message LIKE '%\"abc\"%'"], "_ingest.files", "ingest_id");
    assert_eq!(rows, vec![vec![s("a.ndjson"), s("failed"), s("true")], vec![s("b.ndjson"), s("complete"), None]]);
}

// ---------------------------------------------------------------- 7-8 crashes

/// Run `aldigest collect` with a crash point, wait for its marker file, SIGKILL it.
fn collect_and_kill(fx: &Fx, at: &str) {
    let marker = fx.root.join("crash-marker");
    let mut child = Command::new(env!("CARGO_BIN_EXE_aldigest"))
        .args(["collect", "--db"])
        .arg(fx.db())
        .arg("--ingest-dir")
        .arg(fx.ingest())
        .env("ALDIGEST_CRASH_AT", at)
        .env("ALDIGEST_CRASH_MARKER", &marker)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    while !marker.exists() {
        if let Some(st) = child.try_wait().unwrap() {
            panic!("aldigest exited ({st}) before reaching crash point {at}");
        }
        if start.elapsed() > Duration::from_secs(120) {
            child.kill().unwrap();
            panic!("crash point {at} not reached in 120 s");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap(); // SIGKILL
    assert_eq!(child.wait().unwrap().signal(), Some(9), "child must die by SIGKILL");
    std::fs::remove_file(marker).unwrap();
}

/// 7. SIGKILL after COMMIT, before the rename: reopening reconciles the file and the row count is unchanged.
#[test]
fn t07_crash_after_commit_before_rename() {
    let fx = session_end_fixture("t07");
    fx.put(SE, "a.ndjson", &lines(&(0..3).map(session_end_payload).collect::<Vec<_>>()));
    collect_and_kill(&fx, "after_commit");
    {
        let conn = fx.conn();
        assert_eq!(count(&conn, &t(SE)), 3, "the commit survived the kill");
        assert_eq!(fx.names("ready", SE), ["a.ndjson"], "not renamed yet");
        assert_eq!(ledger(&conn).len(), 1);
    }
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 0, files_reconciled: 1 });
    assert!(fx.names("ready", SE).is_empty());
    assert_eq!(fx.names("done", SE), ["a.ndjson"]);
    assert_eq!(count(&fx.conn(), &t(SE)), 3, "row count unchanged by the reconcile");
}

/// 8. SIGKILL after the INSERT, before COMMIT: nothing persisted, and the file then loads exactly once.
#[test]
fn t08_crash_after_insert_before_commit() {
    let fx = session_end_fixture("t08");
    fx.put(SE, "a.ndjson", &lines(&(0..3).map(session_end_payload).collect::<Vec<_>>()));
    collect_and_kill(&fx, "after_insert");
    {
        let conn = fx.conn();
        assert_eq!(count(&conn, &t(SE)), 0, "the uncommitted insert was discarded");
        assert_eq!(count(&conn, "_ingest.files"), 0, "so was the ledger row");
        assert_eq!(fx.names("ready", SE), ["a.ndjson"]);
    }
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 3, files_failed: 0, files_reconciled: 0 });
    {
        let conn = fx.conn();
        assert_eq!(count(&conn, &t(SE)), 3);
        assert_eq!(ledger(&conn).len(), 1);
        assert_eq!(ledger(&conn)[0][..4], [s(SE), s("a.ndjson"), s("complete"), s("3")]);
    }
    // A second pass finds nothing to do.
    assert_eq!(fx.collect(), Summary::default());
    assert_eq!(count(&fx.conn(), &t(SE)), 3);
}

// ---------------------------------------------------------------- 9-10 edges

/// 9. An empty ready/ is a no-op; an empty file loads zero rows and completes; a last line without a newline loads.
#[test]
fn t09_empty_inputs_and_missing_final_newline() {
    let fx = session_end_fixture("t09");
    assert_eq!(fx.collect(), Summary::default());
    fx.put(SE, "a.ndjson", "");
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 0, files_failed: 0, files_reconciled: 0 });
    {
        let conn = fx.conn();
        assert_eq!(ledger(&conn)[0][2..4], [s("complete"), s("0")]);
        assert_eq!(count(&conn, &t(SE)), 0);
    }
    let two = format!("{}\n{}", line(TS0, &session_end_payload(0)), line(TS0 + 1, &session_end_payload(1)));
    fx.put(SE, "b.ndjson", &two);
    assert_eq!(fx.collect().rows, 2);
    assert_eq!(select(&fx.conn(), &["session_id"], &t(SE), "_meta_record_ordinal"), vec![vec![s("aaaaaaaa-0")], vec![s("aaaaaaaa-1")]]);
}

/// 10. The same file name presented twice is skipped through the ledger (never loaded again, never overwritten).
#[test]
fn t10_same_file_name_twice_is_skipped() {
    let fx = session_end_fixture("t10");
    let content = lines(&[session_end_payload(0)]);
    fx.put(SE, "a.ndjson", &content);
    assert_eq!(fx.collect().files_loaded, 1);
    fx.put(SE, "a.ndjson", &content); // re-created after the first moved to done/
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 0, files_reconciled: 1 });
    let conn = fx.conn();
    assert_eq!(count(&conn, &t(SE)), 1);
    assert_eq!(count(&conn, "_ingest.files"), 1);
    assert!(fx.names("ready", SE).is_empty());
    assert_eq!(fx.names("done", SE), ["a.ndjson", "a.ndjson.dup1"]);
}

// ---------------------------------------------------------------- 11-13 catalog

fn catalog_snapshot(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    for (expr, from) in [
        ("p", "_ingest.producer_types p ORDER BY producer_type"),
        ("schema_name || '.' || table_name", "duckdb_tables() ORDER BY 1"),
        ("schema_name || '.' || function_name", "duckdb_functions() WHERE schema_name = '_ingest' ORDER BY 1"),
    ] {
        let sql = format!("SELECT CAST({expr} AS VARCHAR) FROM {from}");
        let mut st = conn.prepare(&sql).unwrap();
        out.extend(st.query_map([], |r| r.get::<_, String>(0)).unwrap().map(|x| x.unwrap()));
    }
    out
}

fn write_manifest(dir: &Path, entries: &[Value]) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("manifest.json");
    std::fs::write(&path, serde_json::to_string_pretty(&json!({"producers": entries})).unwrap()).unwrap();
    path
}

fn entry(doc: &Value, source: &str, topic: &str, version: i64, spool: &str, valid_from: Value, file: &Path) -> Value {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, serde_json::to_string_pretty(doc).unwrap()).unwrap();
    json!({
        "producer_type": format!("{source}_{topic}_v{version}"), "source": source, "topic": topic, "version": version,
        "claude_code_version": "2.1.285", "spool": spool, "valid_from": valid_from,
        "schema": file.to_string_lossy(), "sha256": schema_hash(doc)
    })
}

fn session_end_doc() -> Value {
    let m = crate_manifest();
    let e = m["producers"].as_array().unwrap().iter().find(|e| e["producer_type"] == SE).unwrap();
    serde_json::from_str(&std::fs::read_to_string(crate_dir().join("schemas").join(e["schema"].as_str().unwrap())).unwrap()).unwrap()
}

/// 11. register twice is a no-op; one changed byte of a schema fails and leaves catalog, tables and macros unchanged.
#[test]
fn t11_register_is_idempotent_and_refuses_a_changed_schema() {
    let fx = Fx::new("t11");
    let producers = register_where(&fx, &only(&[SE, "statusline_main_cost_v1"]));
    let conn = fx.conn();
    let before = catalog_snapshot(&conn);
    assert!(before.len() > 4);
    assert_eq!(register(&conn, &producers).unwrap(), 0, "second register installs nothing");
    assert_eq!(catalog_snapshot(&conn), before, "a no-op changes nothing, not even installed_at");

    let mut doc = session_end_doc();
    let title = format!("{}x", doc["title"].as_str().unwrap()); // one byte
    doc["title"] = json!(title);
    let m = write_manifest(&fx.root.join("changed"), &[entry(&doc, "hook", "session_end", 1, SE, Value::Null, &fx.root.join("changed/s.schema.json"))]);
    let changed = load_manifest(&m).unwrap();
    let err = register(&conn, &changed).unwrap_err();
    assert!(err.contains(SE) && err.contains("sha256"), "{err}");
    assert_eq!(catalog_snapshot(&conn), before, "refused register wrote nothing");
}

/// The v1 + v2 pair of test 12: v2 adds `duration_ms` and renames `reason` to `end_reason` (x-replaces).
fn version_pair(fx: &Fx) -> (Value, Value) {
    let v1_doc = session_end_doc();
    let mut v2_doc = v1_doc.clone();
    v2_doc["$id"] = json!("agentlenspro:hook.SessionEnd:v2");
    let props = v2_doc["properties"].as_object_mut().unwrap();
    let mut reason = props.remove("reason").unwrap();
    reason["x-replaces"] = json!("reason");
    props.insert("end_reason".to_owned(), reason);
    props.insert("duration_ms".to_owned(), json!({"type": "integer"}));
    let req = v2_doc["required"].as_array_mut().unwrap();
    req.retain(|r| r != "reason");
    req.push(json!("end_reason"));
    let dir = fx.root.join("versions");
    (
        entry(&v1_doc, "hook", "session_end", 1, SE, Value::Null, &dir.join("v1.schema.json")),
        entry(&v2_doc, "hook", "session_end", 2, "hook_session_end_v2", json!("2026-11-01"), &dir.join("v2.schema.json")),
    )
}

fn assert_timeline(conn: &Connection) {
    let rows = select(conn, &["producer_type", "valid_from", "valid_to", "superseded_by"], "_ingest.table_timeline", "version");
    assert_eq!(
        rows,
        vec![
            vec![s(SE), None, s("2026-11-01"), s("hook_session_end_v2")],
            vec![s("hook_session_end_v2"), s("2026-11-01"), None, None],
        ]
    );
}

/// 12. A second version gets its own table and macro; v1 shows valid_to/superseded_by; v1 rows stay queryable; x-replaces is stored.
#[test]
fn t12_second_version_has_its_own_table_and_macro() {
    let fx = Fx::new("t12");
    let (v1, v2) = version_pair(&fx);
    // One connection per database file at a time: a second in-process open would be a second instance.
    let m1 = load_manifest(&write_manifest(&fx.root.join("m1"), std::slice::from_ref(&v1))).unwrap();
    assert_eq!(register(&fx.conn(), &m1).unwrap(), 1);
    fx.put(SE, "a.ndjson", &lines(&[session_end_payload(0), session_end_payload(1)]));
    assert_eq!(fx.collect().rows, 2);

    let both = load_manifest(&write_manifest(&fx.root.join("m2"), &[v2, v1])).unwrap();
    assert_eq!(register(&fx.conn(), &both).unwrap(), 1, "only v2 is new");
    {
        let conn = fx.conn();
        assert_timeline(&conn);
        assert_eq!(count(&conn, &t(SE)), 2, "v1 rows remain queryable");
        assert_ne!(producer_schema_name(SE), producer_schema_name("hook_session_end_v2"), "own table");
        assert_eq!(
            count(&conn, "(SELECT DISTINCT function_name FROM duckdb_functions() WHERE schema_name = '_ingest' AND function_name IN ('digest_hook_session_end_v1', 'digest_hook_session_end_v2'))"),
            2,
            "own macro"
        );
        assert_eq!(
            select(&conn, &["producer_type", "CAST(replaces_json AS VARCHAR)"], "_ingest.producer_types", "version"),
            vec![vec![s(SE), s("{}")], vec![s("hook_session_end_v2"), s("{\"end_reason\":\"reason\"}")]]
        );
    }
    let mut p = session_end_payload(2);
    let reason = p.as_object_mut().unwrap().remove("reason").unwrap();
    p["end_reason"] = reason;
    p["duration_ms"] = json!(42);
    fx.put("hook_session_end_v2", "b.ndjson", &lines(&[p]));
    assert_eq!(fx.collect().rows, 1);
    let conn = fx.conn();
    assert_eq!(select(&conn, &["end_reason", "duration_ms"], &t("hook_session_end_v2"), "1")[0], vec![s("clear"), s("42")]);
    assert_eq!(count(&conn, &t(SE)), 2, "v1 untouched by the v2 load");
}

/// 12b. On a fresh database a manifest listing v2 before v1 still marks v1 as superseded (by version, not install order).
#[test]
fn t12b_timeline_follows_the_version_not_the_install_order() {
    let fx = Fx::new("t12b");
    let (v1, v2) = version_pair(&fx);
    let both = load_manifest(&write_manifest(&fx.root.join("m"), &[v2, v1])).unwrap();
    let conn = fx.conn();
    assert_eq!(register(&conn, &both).unwrap(), 2);
    assert_timeline(&conn);
}

/// 12c. Two versions of one topic may not share a spool (every line would load into both tables).
#[test]
fn t12c_two_versions_of_a_topic_cannot_share_a_spool() {
    let fx = Fx::new("t12c");
    let (v1, mut v2) = version_pair(&fx);
    v2["spool"] = v1["spool"].clone();
    let both = load_manifest(&write_manifest(&fx.root.join("m"), &[v1, v2])).unwrap();
    let conn = fx.conn();
    let err = register(&conn, &both).unwrap_err();
    assert!(err.contains("hook_session_end_v2") && err.contains("spool"), "{err}");
    assert_eq!(count(&conn, "duckdb_schemas() WHERE schema_name = '_ingest'"), 0, "the refused register rolled everything back");
}

/// 13. Generated tables carry no index and no key: only NOT NULL constraints exist.
#[test]
fn t13_no_index_and_no_key() {
    let fx = Fx::new("t13");
    register_where(&fx, &|_| true);
    let conn = fx.conn();
    assert_eq!(count(&conn, "duckdb_indexes()"), 0);
    assert_eq!(count(&conn, "duckdb_constraints() WHERE constraint_type <> 'NOT NULL'"), 0);
    assert!(count(&conn, "duckdb_constraints() WHERE constraint_type = 'NOT NULL'") > 0, "the check must see the NOT NULL constraints it allows");
}

// ---------------------------------------------------------------- 14 timing

fn time_collect(label: &str, pick: &dyn Fn(&Value) -> bool, spool: &str, payload: &dyn Fn(usize) -> Value, n: usize) {
    let fx = Fx::new(&format!("t14-{label}"));
    register_where(&fx, pick);
    let payloads: Vec<Value> = (0..n).map(payload).collect();
    fx.put(spool, "a.ndjson", &lines(&payloads));
    let conn = fx.conn();
    let start = Instant::now();
    let sum = collect(&conn, &fx.ingest()).unwrap();
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(sum.rows, n as u64);
    println!("TIMING {label:<28} lines={n:<5} collect_ms={ms:>9.2}");
}

/// 14. Timing (printed, not asserted): collect of one file of 1, 100, 1000 SessionEnd lines and 1000 statusline_main lines.
#[test]
fn t14_timing() {
    for n in [1, 100, 1000] {
        time_collect(&format!("session_end-{n}"), &only(&[SE]), SE, &session_end_payload, n);
    }
    time_collect("statusline_main-1000 (14 topics)", &|e| e["spool"] == "statusline_main", "statusline_main", &statusline_main_payload, 1000);
}

// ---------------------------------------------------------------- extra tests (coordinator items 6-8)

/// Compile `props` as a one-producer manifest; Err is the compile error.
fn compile_props(name: &str, props: Value, sha: Option<&str>) -> Result<Vec<Producer>, String> {
    let fx = Fx::new(name);
    let doc = json!({"type": "object", "properties": props, "required": []});
    let mut e = entry(&doc, "hook", "guard", 1, "hook_guard_v1", Value::Null, &fx.root.join("g.schema.json"));
    if let Some(sha) = sha {
        e["sha256"] = json!(sha);
    }
    load_manifest(&write_manifest(&fx.root, &[e]))
}

/// Guard: payload properties named ts_ns, payload, dg_path, dg_ingest_id, dg_ingested_at (macro parameters) or starting with _meta_ are rejected at compile time, whatever their letter case.
#[test]
fn g1_reserved_property_names_are_rejected() {
    for (i, name) in ["ts_ns", "payload", "_meta_extra", "dg_path", "dg_ingest_id", "dg_ingested_at", "DG_Path"].into_iter().enumerate() {
        let err = compile_props(&format!("g1-{i}"), json!({"cwd": {"type": "string"}, name: {"type": "string"}}), None).unwrap_err();
        assert!(err.contains(name) && err.contains("reserved"), "{err}");
    }
}

/// Guard: an object with no fixed properties, a multi-branch union and an untyped node need x-duckdb-type; with it they compile to JSON.
#[test]
fn g2_open_nodes_need_x_duckdb_type() {
    let open_object = json!({"type": "object"});
    let union = json!({"anyOf": [{"type": "string"}, {"type": "integer"}]});
    let untyped = json!({});
    for (i, node) in [&open_object, &union, &untyped].into_iter().enumerate() {
        let err = compile_props(&format!("g2-{i}"), json!({"x": node}), None).unwrap_err();
        assert!(err.contains("x-duckdb-type") && err.contains("/x"), "{err}");
        let mut with = node.clone();
        with["x-duckdb-type"] = json!("JSON");
        let ok = compile_props(&format!("g2-ok{i}"), json!({"x": with}), None).unwrap();
        assert_eq!(ok[0].columns[0].ty, "JSON");
    }
    // Nested: an open object inside a STRUCT is refused with its path.
    let err = compile_props("g2-nested", json!({"x": {"type": "object", "properties": {"y": {"type": "object"}}}}), None).unwrap_err();
    assert!(err.contains("/x/y"), "{err}");
}

/// Guard: a manifest sha256 that differs from the canonical hash of the schema file is refused.
#[test]
fn g3_manifest_hash_must_match_the_schema_file() {
    let err = compile_props("g3", json!({"cwd": {"type": "string"}}), Some(&"0".repeat(64))).unwrap_err();
    assert!(err.contains("hook_guard_v1") && err.contains("sha256"), "{err}");
}

/// A line without ts_ns sends the whole file to failed/ (the envelope clock is required).
#[test]
fn x1_line_without_ts_ns_fails_the_file() {
    let fx = session_end_fixture("x1");
    fx.put(SE, "a.ndjson", &(json!({"payload": session_end_payload(0)}).to_string() + "\n"));
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 1, files_reconciled: 0 });
    let conn = fx.conn();
    assert_eq!(count(&conn, &t(SE)), 0);
    assert_eq!(select(&conn, &["status", "error_message LIKE '%_meta_recorded_at_ns%'"], "_ingest.files", "1"), vec![vec![s("failed"), s("true")]]);
}

/// Failed ledger rows are append-only history: a failed file put back in ready/ is attempted again, and loads once fixed.
#[test]
fn x2_a_failed_file_left_in_ready_is_attempted_again() {
    let fx = Fx::new("x2");
    register_where(&fx, &only(&["statusline_main_cost_v1"]));
    let spool = "statusline_main";
    let bad = lines(&[json!({"cost": {"total_duration_ms": "abc"}})]);
    fx.put(spool, "a.ndjson", &bad);
    assert_eq!(fx.collect().files_failed, 1);
    fx.put(spool, "a.ndjson", &bad); // same name, ledger already has a `failed` row for it
    assert_eq!(fx.collect().files_failed, 1, "attempted again, not skipped");
    fx.put(spool, "a.ndjson", &lines(&[json!({"cost": {"total_duration_ms": 9}})]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 1, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    let statuses: Vec<Option<String>> = select(&conn, &["status"], "_ingest.files", "ingest_id").into_iter().map(|r| r[0].clone()).collect();
    assert_eq!(statuses, [s("failed"), s("failed"), s("complete")]);
    assert_eq!(count(&conn, &t("statusline_main_cost_v1")), 1);
}

/// The topic tables of one spool carry equal (_meta_ingest_id, _meta_record_ordinal) sets: the join key of one event.
#[test]
fn x3_spool_topics_share_ingest_id_and_ordinal() {
    let fx = Fx::new("x3");
    register_where(&fx, &only(&["statusline_main_cost_v1", "statusline_main_model_v1", "statusline_main_core_v1"]));
    fx.put("statusline_main", "a.ndjson", &lines(&(0..4).map(statusline_main_payload).collect::<Vec<_>>()));
    fx.put("statusline_main", "b.ndjson", &lines(&(0..2).map(statusline_main_payload).collect::<Vec<_>>()));
    assert_eq!(fx.collect().rows, 6);
    let conn = fx.conn();
    let key = |pt: &str| select(&conn, &["_meta_ingest_id", "_meta_record_ordinal"], &t(pt), "1, 2");
    let cost = key("statusline_main_cost_v1");
    assert_eq!(cost.len(), 6);
    assert_eq!(cost, key("statusline_main_model_v1"));
    assert_eq!(cost, key("statusline_main_core_v1"));
    assert_eq!(count(&conn, &format!("(SELECT DISTINCT _meta_ingest_id FROM {})", t("statusline_main_cost_v1"))), 2, "one ingest id per file");
    assert_eq!(
        count(&conn, &format!("{} c JOIN {} k USING (_meta_ingest_id, _meta_record_ordinal) WHERE c.\"cost\".total_cost_usd = 1.25", t("statusline_main_cost_v1"), t("statusline_main_core_v1"))),
        6
    );
}

/// A ready/ subdirectory that no registered producer feeds is an error, not silently ignored.
#[test]
fn x4_unknown_spool_directory_is_an_error() {
    let fx = session_end_fixture("x4");
    fx.put("not_a_spool", "a.ndjson", "{}\n");
    let err = collect(&fx.conn(), &fx.ingest()).unwrap_err();
    assert!(err.contains("not_a_spool"), "{err}");
}

// ---------------------------------------------------------------- fix pass A (review of 69b7d406)

fn ok(out: &Output) {
    assert!(out.status.success(), "exit {:?}: {}", out.status.code(), String::from_utf8_lossy(&out.stderr));
}

/// Register a one-producer manifest `hook_<topic>_v1` of `doc` into the fixture database.
fn register_doc(fx: &Fx, doc: &Value, topic: &str, spool: &str) -> Vec<Producer> {
    let e = entry(doc, "hook", topic, 1, spool, Value::Null, &fx.root.join(format!("{topic}.schema.json")));
    let producers = load_manifest(&write_manifest(&fx.root.join("m"), &[e])).unwrap();
    register(&fx.conn(), &producers).unwrap();
    producers
}

/// A1. Properties named like the former macro parameters (`path`, `ingest_id`, `ingested_at`) register and round-trip.
#[test]
fn a1_payload_properties_named_like_former_macro_parameters_round_trip() {
    let fx = Fx::new("a1");
    let props = json!({"path": {"type": "string"}, "ingest_id": {"type": "string"}, "ingested_at": {"type": "string"}, "cwd": {"type": "string"}});
    register_doc(&fx, &json!({"type": "object", "properties": props, "required": ["path"]}), "param", "hook_param_v1");
    let payload = json!({"path": "/p/aaaaaaaa", "ingest_id": "i-aaaaaaaa", "ingested_at": "t-aaaaaaaa", "cwd": "/work"});
    fx.put("hook_param_v1", "a.ndjson", &lines(&[payload]));
    assert_eq!(fx.collect().rows, 1);
    assert_eq!(
        select(&fx.conn(), &["path", "ingest_id", "ingested_at", "cwd", "_meta_ingest_id"], &t("hook_param_v1"), "1")[0],
        vec![s("/p/aaaaaaaa"), s("i-aaaaaaaa"), s("t-aaaaaaaa"), s("/work"), s("1")]
    );
}

/// A2. A line whose payload is absent or null fails the whole file, even for status-line topics with no NOT NULL column; `{}` is not an error.
#[test]
fn a2_absent_or_null_payload_fails_the_file_but_an_empty_object_loads() {
    let fx = Fx::new("a2");
    register_where(&fx, &only(&["statusline_main_cost_v1", "statusline_main_core_v1"]));
    let spool = "statusline_main";
    fx.put(spool, "a.ndjson", &lines(&[json!({})]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 1, files_failed: 0, files_reconciled: 0 });
    let good = line(TS0, &json!({"cost": {"total_duration_ms": 9}}));
    fx.put(spool, "b0.ndjson", &format!("{good}\n{}\n", json!({"ts_ns": TS0})));
    fx.put(spool, "b1.ndjson", &format!("{good}\n{}\n", json!({"ts_ns": TS0, "payload": null})));
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 2, files_reconciled: 0 });
    let conn = fx.conn();
    for pt in ["statusline_main_cost_v1", "statusline_main_core_v1"] {
        assert_eq!(count(&conn, &t(pt)), 1, "only the `{{}}` row of a.ndjson is in {pt}");
    }
    assert_eq!(one(&conn, "\"cost\" IS NULL", &t("statusline_main_cost_v1")), s("true"));
    assert_eq!(count(&conn, "_ingest.files WHERE status = 'failed' AND error_message LIKE '%absent or null payload%'"), 2);
    assert_eq!(fx.names("failed", spool), ["b0.ndjson", "b0.ndjson.error.txt", "b1.ndjson", "b1.ndjson.error.txt"]);
}

/// A3. The catalog stores its layout version; register and collect refuse another version, an old layout without catalog_meta, and a catalog_meta that does not hold exactly one row.
#[test]
fn a3_catalog_layout_version_is_stored_and_enforced() {
    let fx = Fx::new("a3");
    let producers = register_where(&fx, &only(&[SE]));
    let conn = fx.conn();
    let current = agentlens_digest::register::LAYOUT_VERSION;
    assert_eq!(select(&conn, &["layout_version"], "_ingest.catalog_meta", "1"), vec![vec![s(&current.to_string())]]);
    fx.put(SE, "a.ndjson", &lines(&[session_end_payload(0)]));
    let refused = |what: &str, needle: &str| {
        let e = register(&conn, &producers).unwrap_err();
        assert!(e.contains(needle), "register after {what}: {e}");
        let e = collect(&conn, &fx.ingest()).unwrap_err();
        assert!(e.contains(needle), "collect after {what}: {e}");
    };
    conn.execute_batch("UPDATE _ingest.catalog_meta SET layout_version = 99").unwrap();
    let e = register(&conn, &producers).unwrap_err();
    assert!(e.contains("99") && e.contains(&current.to_string()), "both versions are named: {e}");
    refused("a version change", "99");
    conn.execute_batch(&format!("UPDATE _ingest.catalog_meta SET layout_version = {current}")).unwrap();
    assert_eq!(register(&conn, &producers).unwrap(), 0, "the restored version is accepted again");
    conn.execute_batch(&format!("INSERT INTO _ingest.catalog_meta VALUES ({current})")).unwrap(); // two rows, both current
    refused("a second row", "exactly one row");
    conn.execute_batch("DELETE FROM _ingest.catalog_meta").unwrap();
    refused("no row", "exactly one row");
    conn.execute_batch("DROP TABLE _ingest.catalog_meta").unwrap();
    refused("losing catalog_meta", "old layout");
    assert_eq!(count(&conn, &t(SE)), 0, "nothing was loaded through a refused catalog");
}

/// A4. A producer already installed with the same hash but another spool is an error; another valid_from (also to/from null) is applied and the timeline refreshed.
#[test]
fn a4_changed_spool_is_refused_and_changed_valid_from_is_applied() {
    let fx = Fx::new("a4");
    let (v1, v2) = version_pair(&fx);
    let conn = fx.conn();
    let manifest = |name: &str, entries: &[Value]| load_manifest(&write_manifest(&fx.root.join(name), entries)).unwrap();
    assert_eq!(register(&conn, &manifest("m1", &[v1.clone(), v2.clone()])).unwrap(), 2);

    let mut moved = v2.clone();
    moved["spool"] = json!("elsewhere_v2");
    let before = catalog_snapshot(&conn);
    let e = register(&conn, &manifest("m2", &[v1.clone(), moved])).unwrap_err();
    assert!(e.contains("hook_session_end_v2") && e.contains("spool") && e.contains("elsewhere_v2"), "{e}");
    assert_eq!(catalog_snapshot(&conn), before, "a refused register wrote nothing");

    for from in [s("2026-12-01"), None, s("2027-01-15")] {
        let mut changed = v2.clone();
        changed["valid_from"] = from.clone().map_or(Value::Null, Value::String);
        assert_eq!(register(&conn, &manifest("m3", &[v1.clone(), changed])).unwrap(), 0, "nothing new is installed");
        assert_eq!(
            select(&conn, &["producer_type", "valid_from", "valid_to", "superseded_by"], "_ingest.table_timeline", "version"),
            vec![vec![s(SE), None, from.clone(), s("hook_session_end_v2")], vec![s("hook_session_end_v2"), from, None, None]]
        );
    }
}

/// A5. The three constant catalog columns are gone from producer_types.
#[test]
fn a5_constant_catalog_columns_are_gone() {
    let fx = Fx::new("a5");
    register_where(&fx, &only(&[SE]));
    let conn = fx.conn();
    assert_eq!(count(&conn, "duckdb_columns() WHERE schema_name = '_ingest' AND column_name IN ('recorded_at_pointer', 'recorded_at_encoding', 'order_pointers_json')"), 0);
    assert!(count(&conn, "duckdb_columns() WHERE schema_name = '_ingest' AND table_name = 'producer_types' AND column_name = 'reader_columns_sql'") == 1, "the check must see the columns it allows");
}

/// A6. collect ignores dot entries in ready/ and in each spool directory; any other unknown entry in ready/ stays an error.
#[test]
fn a6_dot_entries_are_ignored_other_unknown_entries_are_errors() {
    let fx = session_end_fixture("a6");
    let ready = fx.ingest().join("ready");
    std::fs::write(ready.join(".DS_Store"), "x").unwrap();
    std::fs::create_dir_all(ready.join(".hidden_dir")).unwrap();
    fx.put(SE, ".DS_Store", "x");
    fx.put(SE, ".hidden.ndjson", &lines(&[session_end_payload(9)]));
    fx.put(SE, "a.ndjson", &lines(&[session_end_payload(0)]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 1, files_failed: 0, files_reconciled: 0 });
    assert_eq!(fx.names("ready", SE), [".DS_Store", ".hidden.ndjson"], "dot entries are left alone");
    assert_eq!(count(&fx.conn(), &t(SE)), 1);
    std::fs::write(ready.join("stray_file"), "x").unwrap();
    let e = collect(&fx.conn(), &fx.ingest()).unwrap_err();
    assert!(e.contains("stray_file"), "{e}");
}

/// A7. Top-level properties, and fields of a nested object (also inside a list), that differ only in letter case are a compile error; reserved names are matched case-insensitively.
#[test]
fn a7_names_differing_only_in_letter_case_are_a_compile_error() {
    let string = json!({"type": "string"});
    let e = compile_props("a7-top", json!({"Cwd": string, "cwd": string}), None).unwrap_err();
    assert!(e.contains("letter case") && e.contains("Cwd") && e.contains("cwd"), "{e}");
    let nested = json!({"type": "object", "properties": {"Ab": string, "aB": string}});
    let e = compile_props("a7-nested", json!({"x": nested}), None).unwrap_err();
    assert!(e.contains("letter case") && e.contains("/x"), "{e}");
    let e = compile_props("a7-list", json!({"x": {"type": "array", "items": nested}}), None).unwrap_err();
    assert!(e.contains("letter case") && e.contains("/x/*"), "{e}");
    compile_props("a7-ok", json!({"cwd": string, "cwd2": string, "x": {"type": "object", "properties": {"Ab": string, "ab2": string}}}), None).unwrap();
    for name in ["Payload", "TS_NS", "_META_extra", "DG_Path"] {
        let e = compile_props("a7-reserved", json!({name: string}), None).unwrap_err();
        assert!(e.contains(name) && e.contains("reserved"), "{e}");
    }
}

/// A8. A successor without valid_from leaves valid_to of the superseded row NULL; `superseded_by IS NULL` (not valid_to) finds the current version.
#[test]
fn a8_current_version_is_superseded_by_null_not_valid_to() {
    let fx = Fx::new("a8");
    let (v1, mut v2) = version_pair(&fx);
    v2["valid_from"] = Value::Null;
    let both = load_manifest(&write_manifest(&fx.root.join("m"), &[v1, v2])).unwrap();
    let conn = fx.conn();
    assert_eq!(register(&conn, &both).unwrap(), 2);
    assert_eq!(
        select(&conn, &["producer_type", "valid_from", "valid_to", "superseded_by"], "_ingest.table_timeline", "version"),
        vec![vec![s(SE), None, None, s("hook_session_end_v2")], vec![s("hook_session_end_v2"), None, None, None]]
    );
    assert_eq!(select(&conn, &["producer_type"], "_ingest.table_timeline WHERE superseded_by IS NULL", "1"), vec![vec![s("hook_session_end_v2")]]);
}

// ---------------------------------------------------------------- fix pass B (aldigest rehash)

fn rehash(manifest: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_aldigest")).args(["rehash", "--manifest"]).arg(manifest).output().unwrap()
}

/// One byte more in the schema's title: a hand edit of a schema file.
fn edit_title(schema: &Path) {
    let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(schema).unwrap()).unwrap();
    let title = format!("{}x", doc["title"].as_str().unwrap());
    doc["title"] = json!(title);
    std::fs::write(schema, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
}

/// B1. After a hand edit of a schema file, load fails on the stale hash; rehash fixes it (format kept) and register on a FRESH database succeeds.
#[test]
fn b1_rehash_after_a_schema_edit_registers_on_a_fresh_database() {
    let fx = Fx::new("b1");
    let schema = fx.root.join("m/s.schema.json");
    let manifest = write_manifest(&fx.root.join("m"), &[entry(&session_end_doc(), "hook", "session_end", 1, SE, Value::Null, &schema)]);
    let original = std::fs::read_to_string(&manifest).unwrap();
    edit_title(&schema);
    assert!(load_manifest(&manifest).unwrap_err().contains("sha256"));
    let out = rehash(&manifest);
    ok(&out);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "rehashed 1 producer(s)\n");
    assert_eq!(register(&fx.conn(), &load_manifest(&manifest).unwrap()).unwrap(), 1);
    let text = std::fs::read_to_string(&manifest).unwrap();
    assert_ne!(text, original);
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(text, serde_json::to_string_pretty(&parsed).unwrap() + "\n", "2-space indent and a trailing newline");
    let keys: Vec<&str> = parsed["producers"][0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["producer_type", "source", "topic", "version", "claude_code_version", "spool", "valid_from", "schema", "sha256"]);
}

/// B2. The same edit plus rehash against a database where that producer_type is ALREADY installed is refused (owner ruling D-A).
#[test]
fn b2_an_edited_and_rehashed_schema_is_refused_when_already_installed() {
    let fx = Fx::new("b2");
    let schema = fx.root.join("m/s.schema.json");
    let manifest = write_manifest(&fx.root.join("m"), &[entry(&session_end_doc(), "hook", "session_end", 1, SE, Value::Null, &schema)]);
    let conn = fx.conn();
    assert_eq!(register(&conn, &load_manifest(&manifest).unwrap()).unwrap(), 1);
    edit_title(&schema);
    ok(&rehash(&manifest));
    let e = register(&conn, &load_manifest(&manifest).unwrap()).unwrap_err();
    assert!(e.contains(SE) && e.contains("new producer_type"), "{e}");
}

fn copy_dir(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for e in std::fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        let to = dst.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &to);
        } else {
            std::fs::copy(e.path(), &to).unwrap();
        }
    }
}

/// B3. rehash of the real, consistent crate manifest (a copy) changes nothing, byte for byte: the file format is the one rehash writes.
#[test]
fn b3_rehash_of_the_crate_manifest_is_a_byte_for_byte_no_op() {
    let fx = Fx::new("b3");
    copy_dir(&crate_dir().join("schemas"), &fx.root.join("schemas"));
    let copy = fx.root.join("schemas/manifest.json");
    let original = std::fs::read(&copy).unwrap();
    let out = rehash(&copy);
    ok(&out);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "rehashed 0 producer(s)\n");
    assert_eq!(std::fs::read(&copy).unwrap(), original);
}

// ---------------------------------------------------------------- fix pass C (alspool -> aldigest, end to end)

/// The `alspool` binary of the agentlens-spool crate, built once into a private target dir (it
/// links no DuckDB, and the digest test binary cannot name another package's binary).
fn alspool() -> PathBuf {
    static BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("alspool-build");
        let out = Command::new(std::env::var("CARGO").expect("cargo sets CARGO for test runs"))
            .args(["build", "--offline", "--quiet", "-p", "agentlens-spool", "--manifest-path"])
            .arg(crate_dir().join("../../Cargo.toml"))
            .arg("--target-dir")
            .arg(&target)
            .output()
            .unwrap();
        ok(&out);
        target.join("debug/alspool")
    })
    .clone()
}

fn alspool_append(ingest: &Path, spool: &str, payload: &str) -> Output {
    let mut child = Command::new(alspool())
        .args(["append", "--ingest-dir"])
        .arg(ingest)
        .args(["--spool", spool])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), payload.as_bytes()).unwrap();
    child.wait_with_output().unwrap()
}

fn alspool_seal(ingest: &Path) -> Output {
    Command::new(alspool()).args(["seal", "--ingest-dir"]).arg(ingest).output().unwrap()
}

fn aldigest_collect(fx: &Fx) -> Output {
    Command::new(env!("CARGO_BIN_EXE_aldigest")).args(["collect", "--db"]).arg(fx.db()).arg("--ingest-dir").arg(fx.ingest()).output().unwrap()
}

fn now_ns() -> i128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as i128
}

/// C1. append, then seal, then register, then collect: one row, the payload fields match, `_meta_recorded_at_ns` is inside the test window.
#[test]
fn c1_append_seal_register_collect_gives_one_row() {
    let fx = Fx::new("c1");
    register_where(&fx, &only(&[SE]));
    let before = now_ns();
    ok(&alspool_append(&fx.ingest(), SE, &session_end_payload(7).to_string()));
    let after = now_ns();
    ok(&alspool_seal(&fx.ingest()));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 1, files_failed: 0, files_reconciled: 0 });
    let row = select(&fx.conn(), &["session_id", "cwd", "effort.level", "_meta_recorded_at_ns"], &t(SE), "1").remove(0);
    assert_eq!(row[..3], [s("aaaaaaaa-7"), s("/work/aaaaaaaa"), s("high")]);
    let ns: i128 = row[3].clone().unwrap().parse().unwrap();
    assert!((before..=after).contains(&ns), "recorded_at_ns {ns} outside [{before}, {after}]");
}

/// C2. 22 `alspool append` processes x 50 payloads of ~8 KiB while a loop runs `alspool seal` then `aldigest collect`: exactly the 1100 (proc, seq) pairs, pads intact, nothing in failed/, ts_ns never decreasing in a file.
#[test]
fn c2_concurrent_appends_while_sealing_and_collecting_lose_nothing() {
    const PROCS: usize = 22;
    const PER_PROC: usize = 50;
    const SPOOL: &str = "hook_load_v1";
    let fx = Fx::new("c2");
    let props = json!({"proc": {"type": "integer"}, "seq": {"type": "integer"}, "pad": {"type": "string"}});
    register_doc(&fx, &json!({"type": "object", "properties": props, "required": ["proc", "seq", "pad"]}), "load", SPOOL);
    let stop = std::sync::atomic::AtomicBool::new(false);
    std::thread::scope(|scope| {
        let pump = scope.spawn(|| loop {
            // Read the flag first: the iteration that sees it set is the final seal + collect.
            let last = stop.load(std::sync::atomic::Ordering::SeqCst);
            ok(&alspool_seal(&fx.ingest()));
            let out = aldigest_collect(&fx);
            ok(&out);
            assert!(String::from_utf8_lossy(&out.stdout).contains("failed=0"), "{}", String::from_utf8_lossy(&out.stdout));
            if last {
                break;
            }
        });
        let writers: Vec<_> = (0..PROCS)
            .map(|p| {
                let fx = &fx;
                scope.spawn(move || {
                    for s in 0..PER_PROC {
                        let payload = json!({"proc": p, "seq": s, "pad": "x".repeat(8192 + (p + s) % 64)});
                        ok(&alspool_append(&fx.ingest(), SPOOL, &payload.to_string()));
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        pump.join().unwrap();
    });
    assert!(fx.names("failed", SPOOL).is_empty(), "failed/: {:?}", fx.names("failed", SPOOL));
    assert!(fx.names("ready", SPOOL).is_empty() && !fx.ingest().join("inbox").join(SPOOL).join("current.ndjson").exists());
    let conn = fx.conn();
    assert_eq!(count(&conn, "_ingest.files WHERE status <> 'complete'"), 0);
    let got = select(&conn, &["proc", "seq", "length(pad)"], &t("hook_load_v1"), "proc, seq");
    let expected: Vec<Vec<Option<String>>> =
        (0..PROCS).flat_map(|p| (0..PER_PROC).map(move |q| vec![s(&p.to_string()), s(&q.to_string()), s(&(8192 + (p + q) % 64).to_string())])).collect();
    assert_eq!(got, expected, "lost, duplicated or damaged rows");
    let mut total = 0;
    for name in fx.names("done", SPOOL) {
        let mut last = 0u64;
        for l in std::fs::read_to_string(fx.ingest().join("done").join(SPOOL).join(&name)).unwrap().lines() {
            let ts = serde_json::from_str::<Value>(l).unwrap()["ts_ns"].as_u64().unwrap();
            assert!(ts >= last, "{name}: ts_ns went backwards");
            last = ts;
            total += 1;
        }
    }
    assert_eq!(total, PROCS * PER_PROC);
    println!("c2: {} sealed files", fx.names("done", SPOOL).len());
}

use agentlens_digest::schema::qident;

// ---------------------------------------------------------------- step (e): telemetry and API-body producers

/// The sources added by step (e) and how many producers each has in the manifest.
const NEW_SOURCES: [(&str, usize); 4] = [("telemetry_event", 27), ("telemetry_span", 6), ("api_request", 4), ("api_response", 3)];
const API_REQUEST: [&str; 4] = ["api_request_core_v1", "api_request_system_v1", "api_request_tools_v1", "api_request_messages_v1"];
const API_RESPONSE: [&str; 3] = ["api_response_core_v1", "api_response_usage_v1", "api_response_content_v1"];

fn is_new_source(e: &Value) -> bool {
    NEW_SOURCES.iter().any(|(src, _)| e["source"] == *src)
}

/// A value for EVERY property of the schema node, nested objects and lists included
/// (a JSON override gets an object, any other override a string).
fn full(node: &Value) -> Value {
    if let Some(ov) = node.get("x-duckdb-type").and_then(Value::as_str) {
        return if ov == "JSON" { json!({"k": 1}) } else { json!("x") };
    }
    match node["type"].as_str().unwrap() {
        "string" => json!("x"),
        "integer" => json!(1),
        "number" => json!(1.5),
        "boolean" => json!(true),
        "array" => json!([full(&node["items"])]),
        "object" => Value::Object(node["properties"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), full(v))).collect()),
        other => panic!("unexpected schema type {other}"),
    }
}

fn deep_merge(into: &mut Value, from: &Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(k) {
                    Some(slot) => deep_merge(slot, v),
                    None => {
                        a.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (slot, v) => *slot = v.clone(),
    }
}

/// t15. Every one of the 40 new producers (27 events, 6 spans, 4 request and 3 response topics) loads a line
/// carrying a value for every property, and every column reads back equal to what was sent.
#[test]
fn t15_every_new_producer_round_trips_a_full_line() {
    let fx = Fx::new("t15");
    let producers = register_where(&fx, &is_new_source);
    assert_eq!(producers.len(), 40);
    for (src, n) in NEW_SOURCES {
        assert_eq!(producers.iter().filter(|p| p.source == src).count(), n, "producers of {src}");
    }
    let mut spools: Vec<&str> = producers.iter().map(|p| p.spool.as_str()).collect();
    spools.sort_unstable();
    spools.dedup();
    for spool in &spools {
        // One line per spool: the full payloads of every producer in it, merged (api topics share link and body).
        let mut payload = json!({});
        for p in producers.iter().filter(|p| p.spool == *spool) {
            deep_merge(&mut payload, &full(&p.schema_json));
        }
        fx.put(spool, "f.ndjson", &lines(&[payload]));
    }
    assert_eq!(fx.collect(), Summary { files_loaded: spools.len() as u64, rows: spools.len() as u64, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    for p in &producers {
        let sent = full(&p.schema_json);
        let exprs: Vec<String> = p.columns.iter().map(|c| format!("to_json({})", qident(&c.name))).collect();
        let exprs: Vec<&str> = exprs.iter().map(String::as_str).collect();
        let got = select(&conn, &exprs, &p.qualified_table(), "1");
        assert_eq!(got.len(), 1, "{}", p.producer_type);
        for (c, cell) in p.columns.iter().zip(&got[0]) {
            let back: Value = serde_json::from_str(cell.as_deref().unwrap_or("null")).unwrap();
            assert_eq!(back, sent[c.name.as_str()], "{} column {}", p.producer_type, c.name);
        }
    }
}

/// A value of the column type and its expected `CAST(... AS VARCHAR)`, distinct per column index.
fn sample(ty: &str, i: usize) -> (Value, String) {
    match ty {
        "VARCHAR" => (json!(format!("v{i}-aaaaaaaa")), format!("v{i}-aaaaaaaa")),
        "BIGINT" => (json!(i), i.to_string()),
        "DOUBLE" => (json!(i as f64 + 0.25), format!("{}.25", i)),
        "BOOLEAN" => (json!(true), "true".to_owned()),
        other => panic!("no sample for {other}"),
    }
}

/// t16. A telemetry event whose attribute names contain dots (`session.id`, `vcs.repository.url.full`) round-trips,
/// every column of the table compared with the value sent.
#[test]
fn t16_telemetry_event_with_dotted_attribute_names_round_trips() {
    const PT: &str = "telemetry_event_api_request_v1";
    let fx = Fx::new("t16");
    let p = register_where(&fx, &only(&[PT])).remove(0);
    assert!(p.columns.iter().filter(|c| c.name.contains('.')).count() >= 10, "the event must have dotted columns");
    assert!(p.columns.iter().all(|c| !c.not_null), "no telemetry column is NOT NULL");
    let mut payload = serde_json::Map::new();
    let mut expected = Vec::new();
    for (i, c) in p.columns.iter().enumerate() {
        let (v, text) = sample(&c.ty, i + 1);
        payload.insert(c.name.clone(), v);
        expected.push(Some(text));
    }
    fx.put(PT, "a.ndjson", &lines(&[Value::Object(payload)]));
    assert_eq!(fx.collect().rows, 1);
    let quoted: Vec<String> = p.columns.iter().map(|c| qident(&c.name)).collect();
    let exprs: Vec<&str> = quoted.iter().map(String::as_str).collect();
    assert_eq!(select(&fx.conn(), &exprs, &p.qualified_table(), "1"), vec![expected]);
}

/// t17. Attributes the drafts leave untyped are VARCHAR columns: an integer, a double, a boolean and an array
/// sent for them load as their JSON text; typed attributes sent as strings by `tool_result` stay strings.
#[test]
fn t17_untyped_telemetry_attributes_are_varchar_and_take_any_json_value() {
    let fx = Fx::new("t17");
    register_where(&fx, &only(&["telemetry_event_hook_execution_complete_v1", "telemetry_event_managed_settings_resolved_v1", "telemetry_event_tool_result_v1"]));
    let hook = "telemetry_event_hook_execution_complete_v1";
    fx.put(hook, "a.ndjson", &lines(&[json!({"num_hooks": 3, "total_duration_ms": 1.5, "num_success": true, "stdout_chars": "12"})]));
    let managed = "telemetry_event_managed_settings_resolved_v1";
    fx.put(managed, "a.ndjson", &lines(&[json!({"managed_settings.sources": ["user", "project"]})]));
    let tool = "telemetry_event_tool_result_v1";
    fx.put(tool, "a.ndjson", &lines(&[json!({"duration_ms": "17", "tool_result_size_bytes": "9", "tool_name": "Bash", "event.sequence": 4})]));
    assert_eq!(fx.collect(), Summary { files_loaded: 3, rows: 3, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    assert_eq!(
        select(&conn, &["typeof(num_hooks)", "num_hooks", "total_duration_ms", "num_success", "stdout_chars"], &t(hook), "1")[0],
        vec![s("VARCHAR"), s("3"), s("1.5"), s("true"), s("12")]
    );
    assert_eq!(select(&conn, &["typeof(\"managed_settings.sources\")", "\"managed_settings.sources\""], &t(managed), "1")[0], vec![s("VARCHAR"), s("[\"user\",\"project\"]")]);
    assert_eq!(
        select(&conn, &["typeof(duration_ms)", "duration_ms", "tool_result_size_bytes", "tool_name", "\"event.sequence\""], &t(tool), "1")[0],
        vec![s("VARCHAR"), s("17"), s("9"), s("Bash"), s("4")]
    );
}

/// t18. A span line round-trips: attributes and the `_span` envelope, `_span.status.code` included; the OTLP JSON form
/// that writes the nanosecond fields as strings loads into the same BIGINT columns.
#[test]
fn t18_telemetry_span_round_trips_with_its_envelope() {
    const PT: &str = "telemetry_span_tool_v1";
    let fx = Fx::new("t18");
    register_where(&fx, &only(&[PT]));
    let attrs = |i: usize| json!({"tool_name": "Bash", "duration_ms": 40 + i, "gen_ai.tool.call.id": format!("toolu_aaaaaaaa{i}"), "session.id": "aaaaaaaa"});
    let mut numeric = attrs(0);
    numeric["_span"] = json!({
        "traceId": "aaaaaaaa00000000aaaaaaaa00000000", "spanId": "bbbb222200000000", "parentSpanId": "cccc333300000000",
        "name": "claude_code.tool", "startTimeUnixNano": 1_700_000_000_000_000_000_i64, "endTimeUnixNano": 1_700_000_000_040_000_000_i64,
        "status": {"code": 2, "message": "denied"}
    });
    let mut otlp = attrs(1);
    otlp["_span"] = json!({
        "traceId": "aaaaaaaa00000000aaaaaaaa00000001", "spanId": "bbbb222200000001", "name": "claude_code.tool",
        "startTimeUnixNano": "1700000001000000000", "endTimeUnixNano": "1700000001041000000", "status": {"code": 1}
    });
    let bare = attrs(2); // a span line without the envelope: all `_span` fields NULL
    fx.put(PT, "a.ndjson", &lines(&[numeric, otlp, bare]));
    assert_eq!(fx.collect().rows, 3);
    let conn = fx.conn();
    let got = select(
        &conn,
        &["tool_name", "duration_ms", "\"gen_ai.tool.call.id\"", "\"session.id\"", "_span.traceId", "_span.spanId", "_span.parentSpanId", "_span.name",
          "_span.startTimeUnixNano", "_span.endTimeUnixNano", "_span.status.code", "_span.status.message", "typeof(_span.startTimeUnixNano)"],
        &t(PT),
        "_meta_record_ordinal",
    );
    assert_eq!(got[0][..12], [s("Bash"), s("40"), s("toolu_aaaaaaaa0"), s("aaaaaaaa"), s("aaaaaaaa00000000aaaaaaaa00000000"), s("bbbb222200000000"), s("cccc333300000000"),
        s("claude_code.tool"), s("1700000000000000000"), s("1700000000040000000"), s("2"), s("denied")]);
    assert_eq!(got[0][12], s("BIGINT"));
    assert_eq!(got[1][4..12], [s("aaaaaaaa00000000aaaaaaaa00000001"), s("bbbb222200000001"), None, s("claude_code.tool"), s("1700000001000000000"), s("1700000001041000000"), s("1"), None]);
    assert_eq!(got[2][..4], [s("Bash"), s("42"), s("toolu_aaaaaaaa2"), s("aaaaaaaa")]);
    assert_eq!(got[2][4..12], [None, None, None, None, None, None, None, None]);
}

fn api_link(i: usize) -> Value {
    json!({
        "request_id": format!("req_aaaaaaaa{i}"), "message_id": format!("msg_bbbb2222{i}"), "message_uuid": format!("uuid-aaaaaaaa-{i}"),
        "session_id": format!("aaaaaaaa-{i}"), "query_source": "repl_main_thread", "model": "model-aaaaaaaa"
    })
}

/// A request envelope with every topic's fields: string and block content mixed, tools with a nested input_schema.
fn api_request_payload(i: usize, system: Value) -> Value {
    json!({"link": api_link(i), "body": {
        "model": "model-aaaaaaaa", "max_tokens": 4096, "stream": true, "betas": ["beta-a", "beta-b"], "metadata": {"user_id": "user-aaaaaaaa"},
        "thinking": {"type": "adaptive"}, "temperature": 1.0, "tool_choice": {"type": "auto"}, "system": system,
        "tools": [
            {"name": "tool_a", "description": "does a", "type": "custom", "eager_input_streaming": true, "cache_control": {"type": "ephemeral"},
             "input_schema": {"type": "object", "properties": {"path": {"type": "string", "items": {"nested": [1, 2]}}}, "required": ["path"]}},
            {"name": "tool_b", "input_schema": {"type": "object"}, "defer_loading": true}
        ],
        "messages": [
            {"role": "user", "content": "hello aaaaaaaa"},
            {"role": "assistant", "content": [{"type": "text", "text": "hi"}, {"type": "tool_use", "id": "toolu_aaaaaaaa", "name": "tool_a", "input": {"path": "/x"}}]},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_aaaaaaaa", "content": "ok"}], "output_config": {"effort": "high"}}
        ]
    }})
}

/// t19. An api_request line with string and array `system`, string and block-array message content and tools with a nested
/// input_schema lands in the four topic tables, with equal (_meta_ingest_id, _meta_record_ordinal) key sets.
#[test]
fn t19_api_request_round_trips_into_four_topic_tables_with_equal_keys() {
    let fx = Fx::new("t19");
    register_where(&fx, &only(&API_REQUEST));
    let sys_array = json!([{"type": "text", "text": "sys A"}, {"type": "text", "text": "sys B", "cache_control": {"type": "ephemeral"}}]);
    fx.put("api_request", "a.ndjson", &lines(&[api_request_payload(0, json!("You are aaaaaaaa")), api_request_payload(1, sys_array)]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 2, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    let tb = |pt: &str| t(pt);
    let key = |pt: &str| select(&conn, &["_meta_ingest_id", "_meta_record_ordinal"], &tb(pt), "1, 2");
    let keys = key(API_REQUEST[0]);
    assert_eq!(keys.len(), 2);
    for pt in &API_REQUEST[1..] {
        assert_eq!(key(pt), keys, "{pt}");
    }
    let ord = "_meta_record_ordinal";
    let core = select(
        &conn,
        &["link.request_id", "link.session_id", "link.model", "body.model", "body.max_tokens", "body.stream", "array_to_string(body.betas, '|')", "body.metadata.user_id",
          "CAST(body.thinking AS VARCHAR)", "body.temperature", "CAST(body.tool_choice AS VARCHAR)", "body.fallbacks IS NULL"],
        &tb(API_REQUEST[0]),
        ord,
    );
    assert_eq!(core[1], [s("req_aaaaaaaa1"), s("aaaaaaaa-1"), s("model-aaaaaaaa"), s("model-aaaaaaaa"), s("4096"), s("true"), s("beta-a|beta-b"), s("user-aaaaaaaa"),
        s("{\"type\":\"adaptive\"}"), s("1.0"), s("{\"type\":\"auto\"}"), s("true")]);
    // `system` is one JSON column: a string once, an array of blocks once (json_type tells them apart).
    let system = select(&conn, &["json_type(body.system)", "CAST(body.system AS VARCHAR)", "json_extract_string(body.system, '$[1].text')", "json_extract_string(body.system, '$[1].cache_control.type')"], &tb(API_REQUEST[1]), ord);
    assert_eq!(system[0], [s("VARCHAR"), s("\"You are aaaaaaaa\""), None, None]);
    assert_eq!(system[1][0], s("ARRAY"));
    assert_eq!(system[1][1], s("[{\"type\":\"text\",\"text\":\"sys A\"},{\"type\":\"text\",\"text\":\"sys B\",\"cache_control\":{\"type\":\"ephemeral\"}}]"));
    assert_eq!(system[1][2..], [s("sys B"), s("ephemeral")]);
    let tools = select(
        &conn,
        &["len(body.tools)", "body.tools[1].name", "body.tools[1].description", "body.tools[1].type", "body.tools[1].eager_input_streaming", "json_extract_string(body.tools[1].input_schema, '$.properties.path.type')",
          "json_extract_string(body.tools[1].input_schema, '$.properties.path.items.nested[1]')", "json_extract_string(body.tools[1].input_schema, '$.required[0]')", "json_extract_string(body.tools[1].cache_control, '$.type')",
          "body.tools[2].name", "body.tools[2].description IS NULL", "body.tools[2].defer_loading", "json_extract_string(body.tools[2].input_schema, '$.type')"],
        &tb(API_REQUEST[2]),
        ord,
    );
    assert_eq!(tools[0], [s("2"), s("tool_a"), s("does a"), s("custom"), s("true"), s("string"), s("2"), s("path"), s("ephemeral"), s("tool_b"), s("true"), s("true"), s("object")]);
    let messages = select(
        &conn,
        &["len(body.messages)", "body.messages[1].role", "json_type(body.messages[1].content)", "json_extract_string(body.messages[1].content, '$')", "body.messages[1].output_config IS NULL",
          "json_type(body.messages[2].content)", "json_extract_string(body.messages[2].content, '$[1].input.path')", "json_extract_string(body.messages[3].content, '$[0].tool_use_id')",
          "json_extract_string(body.messages[3].output_config, '$.effort')"],
        &tb(API_REQUEST[3]),
        ord,
    );
    assert_eq!(messages[0], [s("3"), s("user"), s("VARCHAR"), s("hello aaaaaaaa"), s("true"), s("ARRAY"), s("/x"), s("toolu_aaaaaaaa"), s("high")]);
    assert_eq!(messages[1], messages[0]);
}

/// t20. `body` is a nullable struct: a line with no `body` key (or `"body": null`) loads with a NULL body and its link intact in
/// every topic table; a line with no payload still fails its file.
#[test]
fn t20_a_line_without_body_loads_null_but_a_line_without_payload_fails() {
    let fx = Fx::new("t20");
    register_where(&fx, &only(&API_REQUEST));
    let link_only = json!({"link": api_link(0)});
    let null_body = json!({"link": api_link(1), "body": null});
    fx.put("api_request", "a.ndjson", &lines(&[link_only, null_body]));
    assert_eq!(fx.collect(), Summary { files_loaded: 1, rows: 2, files_failed: 0, files_reconciled: 0 });
    {
        // One connection per database file at a time (see t12): this one is dropped before the next collect.
        let conn = fx.conn();
        for pt in API_REQUEST {
            assert_eq!(
                select(&conn, &["body IS NULL", "link.request_id"], &t(pt), "_meta_record_ordinal"),
                vec![vec![s("true"), s("req_aaaaaaaa0")], vec![s("true"), s("req_aaaaaaaa1")]],
                "{pt}"
            );
        }
    }
    let good = line(TS0, &api_request_payload(2, json!("s")));
    fx.put("api_request", "b.ndjson", &format!("{good}\n{}\n", json!({"ts_ns": TS0})));
    assert_eq!(fx.collect(), Summary { files_loaded: 0, rows: 0, files_failed: 1, files_reconciled: 0 });
    let conn = fx.conn();
    assert_eq!(count(&conn, &t(API_REQUEST[0])), 2, "nothing of the failed file was loaded");
    assert_eq!(count(&conn, "_ingest.files WHERE status = 'failed' AND error_message LIKE '%absent or null payload%'"), 1);
}

/// t21. An api_response line round-trips (usage tokens compare as integers, cache_creation is a struct, content is a list of
/// JSON blocks), an error-shaped response keeps its error content, and requests join responses on link.request_id.
#[test]
fn t21_api_response_round_trips_and_joins_its_request() {
    let fx = Fx::new("t21");
    register_where(&fx, &|e| e["source"] == "api_request" || e["source"] == "api_response");
    fx.put("api_request", "a.ndjson", &lines(&[api_request_payload(0, json!("s")), api_request_payload(1, json!("s"))]));
    let ok = json!({"link": api_link(0), "body": {
        "id": "msg_bbbb22220", "type": "message", "role": "assistant", "model": "model-aaaaaaaa", "stop_reason": "end_turn", "stop_sequence": null,
        "content": [{"type": "text", "text": "hi"}, {"type": "tool_use", "id": "toolu_aaaaaaaa", "name": "tool_a", "input": {"path": "/x"}}],
        "usage": {"input_tokens": 12, "output_tokens": 34, "cache_read_input_tokens": 56, "cache_creation_input_tokens": 78,
                  "cache_creation": {"ephemeral_5m_input_tokens": 70, "ephemeral_1h_input_tokens": 8},
                  "service_tier": "standard", "speed": "standard", "inference_geo": "us", "server_tool_use": {"web_search_requests": 0},
                  "output_tokens_details": {"thinking_tokens": 5}, "iterations": [{"type": "message"}], "fallback_credit": null},
        "context_management": {"applied_edits": []}, "diagnostics": {"cache_miss_reason": "ttl"}
    }});
    let error = json!({"link": api_link(1), "body": {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}});
    fx.put("api_response", "a.ndjson", &lines(&[ok, error]));
    assert_eq!(fx.collect(), Summary { files_loaded: 2, rows: 4, files_failed: 0, files_reconciled: 0 });
    let conn = fx.conn();
    let ord = "_meta_record_ordinal";
    let keys = |pt: &str| select(&conn, &["_meta_ingest_id", "_meta_record_ordinal"], &t(pt), "1, 2");
    assert_eq!(keys(API_RESPONSE[0]), keys(API_RESPONSE[1]));
    assert_eq!(keys(API_RESPONSE[0]), keys(API_RESPONSE[2]));
    let core = select(
        &conn,
        &["body.id", "body.type", "body.role", "body.model", "body.stop_reason", "body.stop_sequence IS NULL", "CAST(body.context_management AS VARCHAR)", "json_extract_string(body.diagnostics, '$.cache_miss_reason')", "body.error IS NULL"],
        &t(API_RESPONSE[0]),
        ord,
    );
    assert_eq!(core[0], [s("msg_bbbb22220"), s("message"), s("assistant"), s("model-aaaaaaaa"), s("end_turn"), s("true"), s("{\"applied_edits\":[]}"), s("ttl"), s("true")]);
    // The error response keeps its error content; the id and the other topics' fields are simply absent.
    assert_eq!(core[1][..2], [None, s("error")]);
    let err = select(&conn, &["json_extract_string(body.error, '$.type')", "json_extract_string(body.error, '$.message')"], &t(API_RESPONSE[0]), ord);
    assert_eq!(err[1], [s("overloaded_error"), s("Overloaded")]);
    let usage = select(
        &conn,
        &["typeof(body.usage.input_tokens)", "body.usage.input_tokens + body.usage.output_tokens", "body.usage.cache_read_input_tokens + body.usage.cache_creation_input_tokens",
          "typeof(body.usage.cache_creation.ephemeral_5m_input_tokens)", "body.usage.cache_creation.ephemeral_5m_input_tokens + body.usage.cache_creation.ephemeral_1h_input_tokens",
          "body.usage.service_tier", "body.usage.speed", "body.usage.inference_geo", "CAST(body.usage.server_tool_use AS VARCHAR)", "json_extract_string(body.usage.output_tokens_details, '$.thinking_tokens')",
          "json_extract_string(body.usage.iterations, '$[0].type')", "body.usage.fallback_credit IS NULL"],
        &t(API_RESPONSE[1]),
        ord,
    );
    assert_eq!(usage[0], [s("BIGINT"), s("46"), s("134"), s("BIGINT"), s("78"), s("standard"), s("standard"), s("us"), s("{\"web_search_requests\":0}"), s("5"), s("message"), s("true")]);
    assert_eq!(select(&conn, &["body.usage IS NULL"], &t(API_RESPONSE[1]), ord)[1], [s("true")]);
    let content = select(&conn, &["len(body.content)", "json_extract_string(body.content[1], '$.text')", "json_extract_string(body.content[2], '$.name')", "json_extract_string(body.content[2], '$.input.path')"], &t(API_RESPONSE[2]), ord);
    assert_eq!(content[0], [s("2"), s("hi"), s("tool_a"), s("/x")]);
    assert_eq!(select(&conn, &["body.content IS NULL"], &t(API_RESPONSE[2]), ord)[1], [s("true")]);
    // Request and response meet on link.request_id.
    let joined = select(
        &conn,
        &["q.link.request_id", "r.body.type", "q.body.model"],
        &format!("{} q JOIN {} r ON q.link.request_id = r.link.request_id", t(API_REQUEST[0]), t(API_RESPONSE[0])),
        "1",
    );
    assert_eq!(joined, vec![vec![s("req_aaaaaaaa0"), s("message"), s("model-aaaaaaaa")], vec![s("req_aaaaaaaa1"), s("error"), s("model-aaaaaaaa")]]);
}

/// t22. Timing (printed, not asserted): collect of one file holding one synthetic request body of about 2 MB, through the four
/// request topics.
#[test]
fn t22_timing_one_2mb_request_body() {
    let fx = Fx::new("t22");
    register_where(&fx, &only(&API_REQUEST));
    let block = "x".repeat(100_000);
    let blocks: Vec<Value> = (0..20).map(|i| json!({"type": "text", "text": format!("{i}{block}")})).collect();
    let mut payload = api_request_payload(0, json!("s"));
    payload["body"]["messages"][0]["content"] = json!(blocks);
    let text = lines(&[payload]);
    assert!(text.len() >= 2_000_000, "body is {} bytes", text.len());
    fx.put("api_request", "a.ndjson", &text);
    let conn = fx.conn();
    let start = Instant::now();
    let sum = collect(&conn, &fx.ingest()).unwrap();
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(sum.rows, 1);
    assert_eq!(one(&conn, "len(body.messages)", &t(API_REQUEST[3])), s("3"));
    println!("TIMING api_request-2MB               lines=1     bytes={:<8} collect_ms={ms:>9.2}", text.len());
}
