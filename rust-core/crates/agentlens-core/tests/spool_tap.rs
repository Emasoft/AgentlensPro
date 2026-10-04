//! Integration tests of the digest spool tap (TRDD-LHCHVK9Z): every test drives a REAL alcore
//! process on its own data directory and free ports, posts synthetic payloads (visibly fake ids)
//! over HTTP, and reads what the tap wrote either from the spool files or, after the scheduled
//! seal + `aldigest collect` ran, from the loaded tables through `aldigest query` (read-only).
//! agentlens-core links no DuckDB for this: the `aldigest` binary is built once by a nested
//! `cargo build` into CARGO_TARGET_TMPDIR, the way agentlens-digest's tests build `alspool`.

#![cfg(unix)]

use fs2::FileExt;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------- helpers

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn scratch(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("spool-tap").join(tag);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn manifest() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../agentlens-digest/schemas/manifest.json")
}

/// `aldigest`, built once into a private target dir (agentlens-core must not link DuckDB for this).
fn aldigest() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let target = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("aldigest-build");
        let out = Command::new(std::env::var("CARGO").expect("cargo sets CARGO for test runs"))
            .args(["build", "--offline", "--quiet", "-p", "agentlens-digest", "--manifest-path"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../Cargo.toml"))
            .arg("--target-dir")
            .arg(&target)
            .output()
            .unwrap();
        assert!(out.status.success(), "building aldigest: {}", String::from_utf8_lossy(&out.stderr));
        target.join("debug/aldigest")
    })
    .clone()
}

/// The tap flags plus `--ingest-sources` with the API bodies switched on (they are off by default).
fn tap_args_with_bodies(interval: Option<u64>) -> Vec<String> {
    let mut a = tap_args(interval);
    a.extend(["--ingest-sources".to_owned(), "hooks,statusline,events,spans,bodies".to_owned()]);
    a
}

fn tap_args(interval: Option<u64>) -> Vec<String> {
    let mut a = vec!["--ingest-manifest".to_owned(), manifest().display().to_string(), "--aldigest-bin".to_owned(), aldigest().display().to_string()];
    if let Some(n) = interval {
        a.extend(["--ingest-interval-secs".to_owned(), n.to_string()]);
    }
    a
}

struct Server {
    child: Child,
    data: PathBuf,
    log: PathBuf,
    otlp: u16,
    ui: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn media_dir(tag: &str) -> PathBuf {
    let m = scratch(&format!("{tag}-media"));
    std::fs::write(m.join("index.html"), "<html></html>").unwrap();
    m
}

/// Start alcore on `data` with `extra` arguments and wait until both HTTP listeners accept.
fn launch(tag: &str, data: &Path, extra: &[String]) -> Server {
    // free_port() cannot reserve a port: another test of this binary may take it first, so a boot
    // that died on "already in use" is retried with fresh ports (any other death is a real failure).
    for _ in 0..4 {
        match try_launch(tag, data, extra) {
            Ok(s) => return s,
            Err(log) if log.contains("already in use") => {}
            Err(log) => panic!("alcore did not come up: {log}"),
        }
    }
    panic!("alcore could not get free ports in 4 attempts");
}

fn try_launch(tag: &str, data: &Path, extra: &[String]) -> Result<Server, String> {
    let log = data.parent().unwrap().join(format!("{tag}-alcore.log"));
    let logf = std::fs::File::create(&log).unwrap();
    let (otlp, ui) = (free_port(), free_port());
    let mut child = Command::new(env!("CARGO_BIN_EXE_alcore"))
        .args(["serve", "--data-dir"])
        .arg(data)
        .arg("--media-dir")
        .arg(media_dir(tag))
        .args(["--otlp-port", &otlp.to_string(), "--ui-port", &ui.to_string(), "--mcp-port", &free_port().to_string(), "--no-log-scan"])
        .args(extra)
        .stdout(logf.try_clone().unwrap())
        .stderr(logf)
        .spawn()
        .expect("alcore spawns");
    // Generous: register creates 98 tables, and CI hosts and shared dev machines are routinely overloaded.
    let deadline = Instant::now() + Duration::from_secs(300);
    while Instant::now() < deadline {
        if let Some(st) = child.try_wait().unwrap() {
            return Err(format!("exited early ({st}): {}", std::fs::read_to_string(&log).unwrap()));
        }
        if TcpStream::connect(("127.0.0.1", otlp)).is_ok() && TcpStream::connect(("127.0.0.1", ui)).is_ok() {
            return Ok(Server { child, data: data.to_path_buf(), log, otlp, ui });
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err(format!("never bound its ports: {}", std::fs::read_to_string(&log).unwrap()))
}

/// One HTTP exchange; returns (status, body).
fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    write!(s, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    let status = resp.split(' ').nth(1).unwrap().parse().unwrap();
    (status, resp.split_once("\r\n\r\n").map_or(String::new(), |x| x.1.to_owned()))
}

impl Server {
    fn post_ui(&self, path: &str, body: &str) -> u16 {
        http(self.ui, "POST", path, body).0
    }
    fn post_otlp(&self, path: &str, body: &Value) {
        assert_eq!(http(self.otlp, "POST", path, &body.to_string()).0, 200);
    }
    fn get_ui(&self, path: &str) -> Value {
        let (status, body) = http(self.ui, "GET", path, "");
        assert_eq!(status, 200, "{path}: {body}");
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("{path}: {e}: {body}"))
    }
    fn status(&self) -> Value {
        self.get_ui("/api/ingest-status")
    }
    fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap()
    }
    /// SIGTERM, then wait for the graceful exit.
    fn stop(mut self) -> PathBuf {
        let ok = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status().unwrap().success();
        assert!(ok);
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if self.child.try_wait().unwrap().is_some() {
                return self.data.clone();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("alcore did not exit after SIGTERM");
    }
}

fn wait_for(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    // `secs` is the budget on an idle machine; shared machines run these 3x slower.
    let deadline = Instant::now() + Duration::from_secs(secs * 3);
    while Instant::now() < deadline {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

fn written(status: &Value, spool: &str) -> u64 {
    status["linesBySpool"][spool].as_u64().unwrap_or(0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// Every line of `spool` wherever it stands: the open file, ready/, done/ and failed/.
fn spool_lines(data: &Path, spool: &str) -> Vec<String> {
    let ingest = data.join("ingest");
    let mut files = vec![ingest.join("inbox").join(spool).join("current.ndjson")];
    for stage in ["ready", "done", "failed"] {
        if let Ok(rd) = std::fs::read_dir(ingest.join(stage).join(spool)) {
            let mut v: Vec<PathBuf> = rd.map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "ndjson")).collect();
            v.sort();
            files.extend(v);
        }
    }
    files.iter().filter_map(|f| std::fs::read_to_string(f).ok()).flat_map(|t| t.lines().map(str::to_owned).collect::<Vec<_>>()).collect()
}

/// The payload text of a spool line, byte for byte.
fn payload_text(line: &str) -> &str {
    line.split_once(",\"payload\":").unwrap().1.strip_suffix('}').unwrap()
}

fn query(db: &Path, sql: &str) -> Vec<Value> {
    let out = Command::new(aldigest()).args(["query", "--db"]).arg(db).args(["--sql", sql]).output().unwrap();
    assert!(out.status.success(), "query {sql}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

/// Every row of the events table of `producer_type`, in record order.
fn rows(db: &Path, producer_type: &str) -> Vec<Value> {
    let schema = query(db, &format!("SELECT duckdb_schema FROM _ingest.producer_types WHERE producer_type = '{producer_type}'"));
    let schema = schema[0]["duckdb_schema"].as_str().unwrap_or_else(|| panic!("{producer_type} is not registered"));
    query(db, &format!("SELECT * FROM \"{schema}\".\"events\" ORDER BY _meta_ingest_id, _meta_record_ordinal"))
}

/// Hold `.collect.lock`: alcore's scheduled collect skips its tick, so the database can be read.
fn hold_collect_lock(data: &Path) -> std::fs::File {
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data.join("ingest/.collect.lock")).unwrap();
    f.lock_exclusive().unwrap();
    f
}

/// Wait for a collect that STARTED after `after_ms` (so after the seal that saw every write) and exited 0.
fn wait_collected(server: &Server, after_ms: u64) -> Value {
    let mut found = Value::Null;
    wait_for("a collect after the writes", 90, || {
        let c = server.status()["lastCollect"].clone();
        let done = c["atMs"].as_u64().is_some_and(|t| t > after_ms) && c["exit"] == 0;
        if done {
            found = c;
        }
        done
    });
    found
}

// ---------------------------------------------------------------- payloads

fn session_end(n: u32) -> String {
    json!({"hook_event_name": "SessionEnd", "session_id": format!("aaaaaaaa-hook-{n}"), "cwd": "/work/aaaaaaaa", "transcript_path": "/t/aaaaaaaa.jsonl", "reason": "clear"}).to_string()
}

fn statusline_main(n: u32) -> String {
    json!({
        "hook_event_name": "StatusLineSample", "statusline_stream": "main",
        "session_id": format!("aaaaaaaa-sl-{n}"), "cwd": "/work/aaaaaaaa", "version": "2.1.285", "fast_mode": true,
        "effort": {"level": "high"},
        "cost": {"total_api_duration_ms": 5, "total_cost_usd": 0.5, "total_duration_ms": 10, "total_lines_added": 1, "total_lines_removed": 2}
    })
    .to_string()
}

fn attr(key: &str, value: Value) -> Value {
    json!({"key": key, "value": value})
}

fn logs_body() -> Value {
    let rec = |attrs: Vec<Value>| json!({"timeUnixNano": "1755600000000000000", "attributes": attrs});
    json!({"resourceLogs": [{
        "resource": {"attributes": [attr("service.name", json!({"stringValue": "claude-code"}))]},
        "scopeLogs": [{"scope": {"name": "com.anthropic.claude_code.events"}, "logRecords": [
            rec(vec![
                attr("event.name", json!({"stringValue": "claude_code.api_request"})),
                attr("session.id", json!({"stringValue": "aaaaaaaa-sess-1"})),
                attr("input_tokens", json!({"intValue": "1234"})),
                attr("output_tokens", json!({"intValue": 56})),
                attr("cost_usd", json!({"doubleValue": 0.0123})),
                attr("extra.list", json!({"arrayValue": {"values": [{"stringValue": "a"}, {"intValue": "2"}]}})),
            ]),
            rec(vec![
                attr("event.name", json!({"stringValue": "api_request"})),
                attr("session.id", json!({"stringValue": "aaaaaaaa-sess-2"})),
                attr("input_tokens", json!({"intValue": "99"})),
            ]),
            rec(vec![
                attr("event.name", json!({"stringValue": "plugin_loaded"})),
                attr("has_hooks", json!({"boolValue": true})),
            ]),
        ]}],
    }]})
}

fn traces_body() -> Value {
    json!({"resourceSpans": [{"scopeSpans": [{"spans": [
        {"traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001", "spanId": "bbbb000000000001", "parentSpanId": "bbbb000000000000", "name": "claude_code.llm_request",
         "startTimeUnixNano": "1755600000000000000", "endTimeUnixNano": "1755600001000000000", "status": {"code": 1, "message": "fine"},
         "attributes": [
            attr("session.id", json!({"stringValue": "aaaaaaaa-sess-1"})),
            attr("success", json!({"boolValue": true})),
            attr("input_tokens", json!({"intValue": "321"})),
            attr("gen_ai.response.finish_reasons", json!({"arrayValue": {"values": [{"stringValue": "end_turn"}]}})),
         ]},
        {"traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0002", "spanId": "bbbb000000000002", "name": "claude_code.llm_request",
         "startTimeUnixNano": "1755600002000000000", "endTimeUnixNano": "1755600003000000000",
         "attributes": [attr("session.id", json!({"stringValue": "aaaaaaaa-sess-2"}))]},
    ]}]}]})
}

const REQ_ID: &str = "11111111-aaaa-bbbb-cccc-000000000001";
const RESP_ID: &str = "11111111-aaaa-bbbb-cccc-000000000002";

fn request_body() -> String {
    json!({"model": "claude-test-model", "max_tokens": 1024, "stream": true, "messages": [{"role": "user", "content": "hello aaaaaaaa"}]}).to_string()
}

fn response_body() -> String {
    json!({"id": "msg_aaaaaaaa", "type": "message", "role": "assistant", "model": "claude-test-model", "stop_reason": "end_turn",
           "content": [{"type": "text", "text": "hi"}], "usage": {"input_tokens": 10, "output_tokens": 5}})
    .to_string()
}

/// A body file in `<data>/otel-bodies`, aged past the pass's 10 s settle gate.
fn put_body(data: &Path, name: &str, text: &str) {
    let dir = data.join("otel-bodies");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    filetime::set_file_mtime(&p, filetime::FileTime::from_unix_time((now_ms() / 1000 - 3600) as i64, 0)).unwrap();
}

// ---------------------------------------------------------------- tests

/// 1. Tap off (the default): after one hook event, one status-line sample, one OTLP logs body and one OTLP traces body, <data>/ingest does not exist and /api/ingest-status says off.
#[test]
fn t1_tap_off_writes_nothing_and_says_so() {
    let data = scratch("t1-data");
    let s = launch("t1", &data, &[]);
    assert_eq!(s.post_ui("/api/hook-events", &session_end(1)), 200);
    assert_eq!(s.post_ui("/api/statusline-samples", &statusline_main(1)), 200);
    s.post_otlp("/v1/logs", &logs_body());
    s.post_otlp("/v1/traces", &traces_body());
    let st = s.status();
    assert_eq!(st["enabled"], false);
    assert!(st["reason"].as_str().unwrap().contains("not configured"), "{st}");
    // The OTLP writer would run on the blocking pool: give a wrongly-on tap time to show itself.
    std::thread::sleep(Duration::from_millis(500));
    assert!(!data.join("ingest").exists(), "the tap created a directory while off");
}

/// 2. Tap on, end to end: a hook, a main status-line sample, 3 OTLP log records, 2 spans and one request and one response body file reach their spools; after the scheduled seal + collect each of the loaded tables holds the posted values.
#[test]
fn t2_every_source_lands_in_its_table_with_the_posted_values() {
    let data = scratch("t2-data");
    put_body(&data, &format!("{REQ_ID}.request.json"), &request_body());
    put_body(&data, &format!("{RESP_ID}.response.json"), &response_body());
    let s = launch("t2", &data, &tap_args_with_bodies(Some(1)));
    assert_eq!(s.post_ui("/api/hook-events", &session_end(1)), 200);
    assert_eq!(s.post_ui("/api/statusline-samples", &statusline_main(1)), 200);
    s.post_otlp("/v1/logs", &logs_body());
    s.post_otlp("/v1/traces", &traces_body());
    // 1 hook + 1 status line + 3 log records + 2 spans + 2 bodies (the boot bodies pass is async).
    wait_for("all 9 lines written", 90, || s.status()["linesWritten"] == 9);
    let st = s.status();
    assert_eq!((st["writeErrors"].clone(), st["bodiesSkipped"].clone()), (json!(0), json!(0)), "{st}");
    let done_at = now_ms();
    let collect = wait_collected(&s, done_at);
    assert!(collect["summary"].as_str().unwrap().contains("failed=0"), "{collect}");
    let db = data.join("ingest/events.duckdb");
    let _lock = hold_collect_lock(&data);

    let r = rows(&db, "hook_session_end_v1");
    assert_eq!(r.len(), 1);
    assert_eq!((&r[0]["session_id"], &r[0]["reason"], &r[0]["cwd"]), (&json!("aaaaaaaa-hook-1"), &json!("clear"), &json!("/work/aaaaaaaa")));

    for pt in ["statusline_main_core_v1", "statusline_main_effort_v1", "statusline_main_cost_v1"] {
        assert_eq!(rows(&db, pt).len(), 1, "{pt}");
    }
    let core = &rows(&db, "statusline_main_core_v1")[0];
    assert_eq!((&core["session_id"], &core["version"], &core["fast_mode"]), (&json!("aaaaaaaa-sl-1"), &json!("2.1.285"), &json!(true)));
    assert_eq!(rows(&db, "statusline_main_effort_v1")[0]["effort"]["level"], "high");
    assert_eq!(rows(&db, "statusline_main_cost_v1")[0]["cost"]["total_cost_usd"], 0.5);
    for line in spool_lines(&data, "statusline_main") {
        let p: Value = serde_json::from_str(payload_text(&line)).unwrap();
        assert!(p.get("hook_event_name").is_none() && p.get("statusline_stream").is_none(), "the CLI-added keys reached the spool: {p}");
        assert_eq!(p["session_id"], "aaaaaaaa-sl-1");
    }

    let ev = rows(&db, "telemetry_event_api_request_v1");
    assert_eq!(ev.len(), 2);
    // A dotted attribute name is a column of its own; an intValue sent as a string is an integer; a doubleValue a number.
    assert_eq!((&ev[0]["session.id"], &ev[0]["input_tokens"], &ev[0]["output_tokens"], &ev[0]["cost_usd"]), (&json!("aaaaaaaa-sess-1"), &json!(1234), &json!(56), &json!(0.0123)));
    assert_eq!((&ev[1]["session.id"], &ev[1]["input_tokens"]), (&json!("aaaaaaaa-sess-2"), &json!(99)));
    assert_eq!(rows(&db, "telemetry_event_plugin_loaded_v1")[0]["has_hooks"], true);
    // (c) the arrayValue attribute and the intValue-as-string, in the spool line itself (neither is a schema field).
    let line = spool_lines(&data, "telemetry_event_api_request_v1").remove(0);
    let p: Value = serde_json::from_str(payload_text(&line)).unwrap();
    assert_eq!((&p["extra.list"], &p["input_tokens"], &p["event.name"]), (&json!(["a", 2]), &json!(1234), &json!("claude_code.api_request")));

    let sp = rows(&db, "telemetry_span_llm_request_v1");
    assert_eq!(sp.len(), 2);
    assert_eq!(sp[0]["_span"]["traceId"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
    assert_eq!((&sp[0]["_span"]["startTimeUnixNano"], &sp[0]["_span"]["status"]["code"], &sp[0]["success"], &sp[0]["input_tokens"]), (&json!(1755600000000000000u64), &json!(1), &json!(true), &json!(321)));
    assert_eq!(sp[0]["gen_ai.response.finish_reasons"], json!(["end_turn"]));
    // (d) a span with no parentSpanId and no status loads with those `_span` fields NULL.
    assert_eq!(sp[1]["_span"]["traceId"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0002");
    assert!(sp[1]["_span"]["parentSpanId"].is_null() && sp[1]["_span"]["status"].is_null(), "{}", sp[1]["_span"]);

    // The four request producers share one spool and each loads the one line.
    for pt in ["api_request_core_v1", "api_request_system_v1", "api_request_tools_v1", "api_request_messages_v1", "api_response_core_v1", "api_response_usage_v1", "api_response_content_v1"] {
        assert_eq!(rows(&db, pt).len(), 1, "{pt}");
    }
    let rq = &rows(&db, "api_request_core_v1")[0];
    assert_eq!((&rq["link"]["body_id"], &rq["body"]["model"], &rq["body"]["max_tokens"], &rq["body"]["stream"]), (&json!(REQ_ID), &json!("claude-test-model"), &json!(1024), &json!(true)));
    let rs = &rows(&db, "api_response_core_v1")[0];
    assert_eq!((&rs["link"]["body_id"], &rs["body"]["id"], &rs["body"]["stop_reason"]), (&json!(RESP_ID), &json!("msg_aaaaaaaa"), &json!("end_turn")));
    assert_eq!(rows(&db, "api_response_usage_v1")[0]["body"]["usage"]["output_tokens"], 5);
}

/// 3. A log record whose event name the manifest does not know and a hook whose name it does not know write nothing and are counted once each (one warning per name, even when the name repeats); the known items of the same POST are written.
#[test]
fn t3_unknown_names_are_counted_never_invented_into_a_spool() {
    let data = scratch("t3-data");
    let s = launch("t3", &data, &tap_args(None));
    let unknown_hook = json!({"hook_event_name": "TotallyUnknownHook", "session_id": "aaaaaaaa-hook-9", "cwd": "/work/aaaaaaaa"}).to_string();
    assert_eq!(s.post_ui("/api/hook-events", &unknown_hook), 200);
    assert_eq!(s.post_ui("/api/hook-events", &session_end(2)), 200);
    let mut logs = logs_body();
    logs["resourceLogs"][0]["scopeLogs"][0]["logRecords"].as_array_mut().unwrap().push(json!({"attributes": [attr("event.name", json!({"stringValue": "totally_unknown_event"}))]}));
    s.post_otlp("/v1/logs", &logs);
    wait_for("the OTLP writer", 30, || s.status()["linesWritten"] == 4);
    let st = s.status();
    assert_eq!(st["unknown"], json!({"hook/totally_unknown_hook": 1, "telemetry_event/totally_unknown_event": 1}), "{st}");
    assert_eq!((written(&st, "hook_session_end_v1"), written(&st, "telemetry_event_plugin_loaded_v1")), (1, 1), "the known items of the same POST");
    assert_eq!(st["linesWritten"], 4);
    assert!(spool_lines(&data, "totally_unknown_event").is_empty() && !data.join("ingest/inbox/hook_totally_unknown_hook_v1").exists());
    assert_eq!(s.post_ui("/api/hook-events", &unknown_hook), 200);
    assert_eq!(s.status()["unknown"]["hook/totally_unknown_hook"], 2);
    let warnings = s.log_text().lines().filter(|l| l.contains("no spool for hook/totally_unknown_hook")).count();
    assert_eq!(warnings, 1, "one warning per distinct name per process");
}

/// 4. The existing stores are unaffected: the same posts leave the same hook-events bucket (minus its timestamps) and the same persistence counters with the tap on as with it off.
#[test]
fn t4_the_existing_stores_see_the_same_with_the_tap_on_and_off() {
    fn scenario(tag: &str, extra: &[String]) -> (Vec<Value>, Value) {
        let data = scratch(&format!("{tag}-data"));
        let s = launch(tag, &data, extra);
        let unknown_hook = json!({"hook_event_name": "TotallyUnknownHook", "session_id": "aaaaaaaa-hook-9"}).to_string();
        for (path, body) in [
            ("/api/hook-events", session_end(1)),
            ("/api/hook-events", unknown_hook),
            ("/api/hook-events", json!({"hook_event_name": "StatusLineSample", "session_id": "aaaaaaaa-sl-2", "cwd": "/work/aaaaaaaa"}).to_string()),
            ("/api/statusline-samples", statusline_main(1)),
            ("/api/statusline-samples", json!({"statusline_stream": "subagent", "session_id": "aaaaaaaa-sl-3"}).to_string()),
        ] {
            assert_eq!(s.post_ui(path, &body), 200);
        }
        let p = s.get_ui("/api/server-stats")["persistence"].clone();
        let counters = json!({"hookEventWrites": p["hookEventWrites"], "hookEventBytes": p["hookEventBytes"], "statuslineSamples": p["statuslineSamples"]});
        let data = s.stop();
        let mut events = Vec::new();
        for f in std::fs::read_dir(data.join("hook-events")).unwrap() {
            for l in std::fs::read_to_string(f.unwrap().path()).unwrap().lines() {
                let mut v: Value = serde_json::from_str(l).unwrap();
                v.as_object_mut().unwrap().remove("ts");
                events.push(v);
            }
        }
        (events, counters)
    }
    let off = scenario("t4-off", &[]);
    let on = scenario("t4-on", &tap_args(None));
    assert_eq!(off.0.len(), 2, "the two real hook events (the third post is a status-line sample)");
    assert_eq!(off, on);
    assert_eq!(off.1["statuslineSamples"], 3);
}

/// 5. A tap write that fails (inbox/<spool> is a regular file) does not change the POST's HTTP status or the existing store, and is counted in /api/ingest-status.
#[test]
fn t5_a_failing_tap_write_never_fails_the_capture_path() {
    let data = scratch("t5-data");
    let s = launch("t5", &data, &tap_args(None));
    std::fs::create_dir_all(data.join("ingest/inbox")).unwrap();
    std::fs::write(data.join("ingest/inbox/hook_session_end_v1"), "a file where the spool directory must go").unwrap();
    assert_eq!(s.post_ui("/api/hook-events", &session_end(1)), 200, "the capture path must not see the tap's failure");
    // The tap write runs on the blocking pool, so its failure is counted a moment after the POST returns.
    wait_for("the failed write to be counted", 30, || s.status()["writeErrors"] == 1);
    let st = s.status();
    assert_eq!(st["writeErrors"], 1, "{st}");
    assert_eq!(st["writeErrorsBySpool"]["hook_session_end_v1"], 1);
    assert_eq!(written(&st, "hook_session_end_v1"), 0);
    assert_eq!(s.get_ui("/api/hook-events?ev=SessionEnd")["count"], 1, "the existing store still has the event");
    assert!(s.log_text().contains("write to spool hook_session_end_v1 failed"));
}

/// 6. Giving only one of the two tap flags is a startup error with a clear message, before any file is created; both flags with a failing `aldigest register` still boot, with the tap off and the reason on /api/ingest-status.
#[test]
fn t6_half_a_tap_configuration_is_a_startup_error() {
    for (what, args) in [("manifest only", vec!["--ingest-manifest".to_owned(), manifest().display().to_string()]), ("bin only", vec!["--aldigest-bin".to_owned(), aldigest().display().to_string()])] {
        let data = scratch("t6-data-parent").join("never-created");
        let out = Command::new(env!("CARGO_BIN_EXE_alcore"))
            .args(["serve", "--data-dir"])
            .arg(&data)
            .arg("--media-dir")
            .arg(media_dir("t6"))
            .args(&args)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let err = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(64), "{what}: {err}");
        assert!(err.contains("--ingest-manifest and --aldigest-bin must be given together"), "{what}: {err}");
        assert!(!data.exists(), "{what}: the data dir was created");
    }
    let data = scratch("t6-fail-data");
    let false_bin = ["/usr/bin/false", "/bin/false"].into_iter().find(|p| Path::new(p).exists()).unwrap();
    let mut args = tap_args(None);
    args[3] = false_bin.to_owned();
    let s = launch("t6-fail", &data, &args);
    let st = s.status();
    assert_eq!(st["enabled"], false);
    assert!(st["reason"].as_str().unwrap().contains("aldigest register failed"), "{st}");
    assert_eq!(s.post_ui("/api/hook-events", &session_end(1)), 200, "alcore still captures");
    assert!(s.log_text().contains("SPOOL TAP DISABLED"));
}

/// 7. (a) A hook event re-delivered by the boot drain of the hook-spool directory is spooled, byte for byte.
#[test]
fn t7_the_hook_spool_drain_path_spools_the_event() {
    let data = scratch("t7-data");
    std::fs::create_dir_all(data.join("hook-spool")).unwrap();
    let raw = session_end(3);
    std::fs::write(data.join("hook-spool/20260101T000000-aaaaaaaa.json"), &raw).unwrap();
    let s = launch("t7", &data, &tap_args(None));
    wait_for("the drain's line", 30, || written(&s.status(), "hook_session_end_v1") == 1);
    let lines = spool_lines(&data, "hook_session_end_v1");
    assert_eq!(lines.len(), 1);
    assert_eq!(payload_text(&lines[0]), raw);
}

/// 8. (b) The legacy status-line diversion through /api/hook-events spools to the status-line spools without the two CLI-added keys.
#[test]
fn t8_the_legacy_statusline_route_spools_without_the_cli_keys() {
    let data = scratch("t8-data");
    let s = launch("t8", &data, &tap_args(None));
    let main = json!({"hook_event_name": "StatusLineSample", "session_id": "aaaaaaaa-sl-4", "cwd": "/work/aaaaaaaa", "statusline_stream": "main"});
    let sub = json!({"hook_event_name": "SubagentStatusLineSample", "session_id": "aaaaaaaa-sl-5", "agent_id": "agent-aaaaaaaa"});
    assert_eq!(s.post_ui("/api/hook-events", &main.to_string()), 200);
    assert_eq!(s.post_ui("/api/hook-events", &sub.to_string()), 200);
    // The tap writes run on the blocking pool, a moment after the POSTs return.
    wait_for("both status-line writes", 30, || s.status()["linesWritten"] == 2);
    let st = s.status();
    assert_eq!((written(&st, "statusline_main"), written(&st, "statusline_subagent")), (1, 1), "{st}");
    let m: Value = serde_json::from_str(payload_text(&spool_lines(&data, "statusline_main")[0])).unwrap();
    let u: Value = serde_json::from_str(payload_text(&spool_lines(&data, "statusline_subagent")[0])).unwrap();
    assert_eq!(m, json!({"session_id": "aaaaaaaa-sl-4", "cwd": "/work/aaaaaaaa"}));
    assert_eq!(u, json!({"session_id": "aaaaaaaa-sl-5", "agent_id": "agent-aaaaaaaa"}));
}

/// 9. (e) A body file whose content is a JSON array is skipped and counted; a JSON object body in the same pass is written, wrapped by string concatenation around the file text.
#[test]
fn t9_a_non_object_body_is_skipped_and_counted() {
    let data = scratch("t9-data");
    put_body(&data, "11111111-aaaa-bbbb-cccc-0000000000a1.request.json", "[1, 2, 3]");
    let pretty_free = r#"{"id":"msg_aaaaaaaa","big":18446744073709551616123,"type":"message"}"#;
    put_body(&data, "11111111-aaaa-bbbb-cccc-0000000000a2.response.json", pretty_free);
    let s = launch("t9", &data, &tap_args_with_bodies(None));
    wait_for("the bodies pass", 90, || written(&s.status(), "api_response") == 1 && s.status()["bodiesSkipped"] == 1);
    let lines = spool_lines(&data, "api_response");
    assert_eq!(payload_text(&lines[0]), format!(r#"{{"link":{{"body_id":"11111111-aaaa-bbbb-cccc-0000000000a2"}},"body":{pretty_free}}}"#), "the file text is embedded verbatim");
    assert!(spool_lines(&data, "api_request").is_empty());
}

/// 10. (f) With the capture gate off (captureEnabled=false) a hook event is dropped by the existing path and NOT spooled; the status line, which the gate never covered, still is.
#[test]
fn t10_the_tap_inherits_the_capture_switch() {
    let data = scratch("t10-data");
    std::fs::write(data.join("hook-config.json"), r#"{"captureEnabled": false}"#).unwrap();
    let s = launch("t10", &data, &tap_args(None));
    let (status, body) = http(s.ui, "POST", "/api/hook-events", &session_end(1));
    assert_eq!(status, 200);
    assert!(body.contains("captureEnabled=false"), "the gate did not drop the event: {body}");
    assert_eq!(s.post_ui("/api/statusline-samples", &statusline_main(1)), 200);
    wait_for("the status-line write", 30, || s.status()["linesWritten"] == 1);
    let st = s.status();
    assert_eq!((written(&st, "hook_session_end_v1"), written(&st, "statusline_main")), (0, 1), "{st}");
}

/// 11. (g) A graceful stop seals every spool: no non-empty inbox/*/current.ndjson is left, the lines are in ready/, and no collect ran at shutdown. (h) A hook payload with an integer beyond 2^64 and a 30-digit decimal arrives in the spool line byte-identical.
#[test]
fn t11_shutdown_seals_and_hook_bytes_are_verbatim() {
    let data = scratch("t11-data");
    let s = launch("t11", &data, &tap_args(None));
    // The scheduler's first tick is immediate (the start-up collect): let it finish so it cannot
    // seal or collect anything of what is posted below, and no further tick comes for 60 s.
    wait_for("the start-up collect", 90, || s.status()["lastCollect"]["exit"] == 0);
    let big = r#"{"hook_event_name":"SessionEnd","session_id":"aaaaaaaa-hook-8","cwd":"/work/aaaaaaaa","transcript_path":"/t/x.jsonl","reason":"clear","big":18446744073709551616123,"dec":0.123456789012345678901234567890,"dup":1,"dup":2}"#;
    assert_eq!(s.post_ui("/api/hook-events", big), 200);
    assert_eq!(s.post_ui("/api/statusline-samples", &statusline_main(1)), 200);
    s.post_otlp("/v1/logs", &logs_body());
    s.post_otlp("/v1/traces", &traces_body());
    wait_for("the OTLP writes", 30, || s.status()["linesWritten"] == 7);
    let data = s.stop();
    let inbox = data.join("ingest/inbox");
    for e in std::fs::read_dir(&inbox).unwrap() {
        let cur = e.unwrap().path().join("current.ndjson");
        assert!(std::fs::metadata(&cur).map_or(true, |m| m.len() == 0), "{} still holds lines after a graceful stop", cur.display());
    }
    let ready: Vec<_> = std::fs::read_dir(data.join("ingest/ready")).unwrap().collect();
    assert_eq!(ready.len(), 5, "hook, status line, api_request events, plugin_loaded events, llm_request spans");
    assert!(!data.join("ingest/done").exists(), "a collect ran at shutdown");
    assert_eq!(std::fs::read_to_string(data.parent().unwrap().join("t11-alcore.log")).unwrap().matches("ingest collect (run").count(), 1, "only the start-up collect");
    let lines = spool_lines(&data, "hook_session_end_v1");
    assert_eq!(payload_text(&lines[0]), big, "the hook payload must arrive byte-identical");
}

/// 12. The hook topics of the manifest are exactly the snake_case of the Claude Code hook names (the schema file stems), so a name the tap derives never misses a spool the manifest has.
#[test]
fn t12_snake_case_matches_every_hook_topic_of_the_manifest() {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(manifest()).unwrap()).unwrap();
    let mut n = 0;
    for p in doc["producers"].as_array().unwrap().iter().filter(|p| p["source"] == "hook") {
        let stem = Path::new(p["schema"].as_str().unwrap()).file_name().unwrap().to_str().unwrap().strip_suffix(".schema.json").unwrap().to_owned();
        assert_eq!(agentlens_core::spool_tap::snake_case(&stem), p["topic"].as_str().unwrap(), "{stem}");
        n += 1;
    }
    assert!(n >= 30, "only {n} hook producers");
}

/// 13. With the default source list the API bodies are NOT spooled (measured disk growth), the other sources still are, and /api/ingest-status lists the enabled sources; an unknown source is a startup error.
#[test]
fn t13_bodies_are_off_by_default() {
    let data = scratch("t13-data");
    put_body(&data, &format!("{REQ_ID}.request.json"), &request_body());
    let s = launch("t13", &data, &tap_args(None));
    assert_eq!(s.status()["sources"], json!(["hooks", "statusline", "events", "spans"]));
    assert_eq!(s.post_ui("/api/hook-events", &session_end(1)), 200);
    s.post_otlp("/v1/logs", &logs_body());
    wait_for("the OTLP writer", 30, || s.status()["linesWritten"] == 4);
    // The boot bodies pass is asynchronous: wait for it to have consumed the file, then check nothing was spooled.
    wait_for("the bodies pass", 90, || !data.join("otel-bodies").join(format!("{REQ_ID}.request.json")).exists() || s.log_text().contains("bodies pass:"));
    std::thread::sleep(Duration::from_secs(2));
    let st = s.status();
    assert_eq!((written(&st, "api_request"), st["bodiesSkipped"].clone()), (0, json!(0)), "{st}");
    assert!(spool_lines(&data, "api_request").is_empty());
    assert!(!data.join("ingest/inbox/api_request").exists());
    let bad = Command::new(env!("CARGO_BIN_EXE_alcore"))
        .args(["serve", "--data-dir"]).arg(scratch("t13-bad").join("never"))
        .arg("--media-dir").arg(media_dir("t13"))
        .args(tap_args(None)).args(["--ingest-sources", "hooks,nonsense"])
        .stdin(Stdio::null()).output().unwrap();
    assert_eq!(bad.status.code(), Some(64));
    assert!(String::from_utf8_lossy(&bad.stderr).contains("unknown source \"nonsense\""));
}


/// 14. A tap write blocked on a spool file lock (another process holds `current.ndjson`) never delays a POST: hook and status-line writes run off the request path, and once the lock is released the queued lines reach the table.
#[test]
fn t14_a_blocked_spool_lock_never_stalls_the_capture_path() {
    let data = scratch("t14-data");
    let s = launch("t14", &data, &tap_args(Some(3)));
    wait_for("the start-up collect", 90, || s.status()["lastCollect"]["exit"] == 0);
    let dir = data.join("ingest/inbox/hook_session_end_v1");
    std::fs::create_dir_all(&dir).unwrap();
    let held = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("current.ndjson")).unwrap();
    held.lock_exclusive().unwrap();
    let t0 = Instant::now();
    for n in 1..=3 {
        assert_eq!(s.post_ui("/api/hook-events", &session_end(n)), 200);
    }
    assert_eq!(s.post_ui("/api/statusline-samples", &statusline_main(1)), 200);
    assert!(t0.elapsed() < Duration::from_secs(2), "the POSTs waited {:?} on the spool lock", t0.elapsed());
    held.unlock().unwrap();
    drop(held);
    wait_for("the 4 queued writes", 30, || s.status()["linesWritten"] == 4);
    let first = wait_collected(&s, now_ms());
    // A tick that sealed before the lines landed collects nothing of them: the next tick does.
    wait_collected(&s, first["atMs"].as_u64().unwrap());
    let _lock = hold_collect_lock(&data);
    assert_eq!(rows(&data.join("ingest/events.duckdb"), "hook_session_end_v1").len(), 3);
}
