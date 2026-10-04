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
use std::process::{Command, Stdio};
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
    assert_eq!(producers.len(), 49);
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

/// Guard: payload properties named ts_ns, payload, or starting with _meta_ are rejected at compile time.
#[test]
fn g1_reserved_property_names_are_rejected() {
    for (i, name) in ["ts_ns", "payload", "_meta_extra"].into_iter().enumerate() {
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
