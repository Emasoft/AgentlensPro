//! TRDD-RBBEX59R step c1 — alcore BOOTS in no-collection mode (it used to exit 78 under DISABLED,
//! TRDD-NZ9Z9ALO, which left the burn gate allowing everything). Three spawned boots:
//!
//! 1. the `<data>/DISABLED` file only (the backstop for an alcore started outside the CLI);
//! 2. `--no-collection` only, no file (the authoritative CLI input);
//! 3. a normal-mode CONTROL with neither.
//!
//! Every boot runs with hook capture ON (asserted on its first read: with capture off the hook POST
//! would take the ring-only path for a different reason and prove nothing about the mode) and gets
//! the same four POSTs: OTLP traces, OTLP logs, a SubagentStart hook event, a status-line sample.
//! The control proves each read can SEE a present item; the mutation runs recorded in
//! reports_dev/rbbex59r/ prove each absence assertion can fail:
//! - drop the `if no_collection` return in `lib.rs` `handle` ⇒ the span and log-event asserts go red;
//! - drop the `no_collection` arm of `hook_events::hook_ring_only_reason` ⇒ the hook-events-file assert goes red;
//! - drop the `st.no_collection` check at the `captureDownSince` caller in `server_stats` ⇒ that assert goes red;
//! - drop the blank filter on `started_by_stamp` in `alcore.rs` ⇒ the blank-stamp `startedBy` assert goes red.

#![cfg(unix)]

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Three ports bound at once so no two listeners can be handed the same port (see exit_on_panic.rs).
/// Ephemeral ports only: this test never binds 4318 or 3000.
fn free_ports() -> [u16; 3] {
    let listeners: Vec<std::net::TcpListener> = (0..3).map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let mut ports = [0u16; 3];
    for (port, listener) in ports.iter_mut().zip(&listeners) {
        *port = listener.local_addr().unwrap().port();
    }
    ports
}

struct Server {
    child: Child,
    base: PathBuf,
    data: PathBuf,
    log: PathBuf,
    otlp: u16,
    ui: u16,
}

impl Drop for Server {
    // Kill, reap and remove the temp dir on every exit path (a failed assert included): a leaked
    // server would keep its ports and its data dir.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

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
    fn stats(&self) -> Value {
        let (status, body) = http(self.ui, "GET", "/api/server-stats", "");
        assert_eq!(status, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }
    fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

#[derive(Clone, Copy)]
enum Stamp {
    Unset,
    Blank,
    Supervisor,
}

fn try_launch(tag: &str, disabled_file: bool, flag: bool, stamp: Stamp) -> Result<Server, String> {
    let base = std::env::temp_dir().join(format!("al-nocoll-boot-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let (data, media, home) = (base.join("data"), base.join("media"), base.join("home"));
    for d in [&data, &media, &home] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(media.join("index.html"), "<html></html>").unwrap();
    if disabled_file {
        std::fs::write(data.join("DISABLED"), "").unwrap();
    }
    let log = base.join("alcore.log");
    let logf = File::create(&log).unwrap();
    let [otlp, ui, mcp] = free_ports();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_alcore"));
    cmd.args(["serve", "--data-dir", data.to_str().unwrap(), "--media-dir", media.to_str().unwrap()])
        .args(["--otlp-port", &otlp.to_string(), "--ui-port", &ui.to_string(), "--mcp-port", &mcp.to_string(), "--no-log-scan"])
        .env_remove("AGENTLENS_DISABLED")
        .env_remove("AGENTLENS_STARTED_BY")
        .env("HOME", &home)
        .stdout(Stdio::from(logf.try_clone().unwrap()))
        .stderr(Stdio::from(logf));
    if flag {
        cmd.arg("--no-collection");
    }
    match stamp {
        Stamp::Unset => {}
        Stamp::Blank => {
            cmd.env("AGENTLENS_STARTED_BY", "   ");
        }
        Stamp::Supervisor => {
            cmd.env("AGENTLENS_STARTED_BY", "supervisor");
        }
    }
    let child = cmd.spawn().expect("alcore spawns");
    let mut server = Server { child, base, data, log, otlp, ui };
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Some(st) = server.child.try_wait().unwrap() {
            return Err(format!("exited early ({st}): {}", server.log_text()));
        }
        if TcpStream::connect(("127.0.0.1", otlp)).is_ok() && TcpStream::connect(("127.0.0.1", ui)).is_ok() {
            return Ok(server);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("never bound its ports: {}", server.log_text()))
}

fn launch(tag: &str, disabled_file: bool, flag: bool, stamp: Stamp) -> Server {
    // free_ports cannot reserve a port past its return; a boot that lost one is retried.
    for _ in 0..4 {
        match try_launch(tag, disabled_file, flag, stamp) {
            Ok(s) => return s,
            Err(log) if log.contains("already in use") => {}
            Err(log) => panic!("alcore did not come up: {log}"),
        }
    }
    panic!("alcore could not get free ports in 4 attempts");
}

fn attr(key: &str, value: Value) -> Value {
    json!({ "key": key, "value": value })
}

fn now_nanos() -> String {
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()).to_string()
}

/// A Claude span the ingest stores (a `claude_code.` name with a session id).
fn traces_body() -> Value {
    let t = now_nanos();
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001", "spanId": "bbbb000000000001", "name": "claude_code.llm_request",
        "startTimeUnixNano": t, "endTimeUnixNano": t,
        "attributes": [attr("session.id", json!({ "stringValue": "aaaaaaaa-sess-1" }))],
    }] }] }] })
}

/// Pinned from `agentlens-ingest` `process_logs`: `api_request` is one of CLAUDE_RICH_LOG_EVENTS, so
/// normal mode turns it into a span (not counted in otlpDroppedLogEvents); `plugin_loaded` is not, so
/// normal mode rejects it and PERSISTS it to `<data>/log-events/` (logEvents.persistedSinceBoot).
fn logs_body() -> Value {
    let t = now_nanos();
    json!({ "resourceLogs": [{
        "resource": { "attributes": [attr("service.name", json!({ "stringValue": "claude-code" }))] },
        "scopeLogs": [{ "scope": { "name": "com.anthropic.claude_code.events" }, "logRecords": [
            { "timeUnixNano": t, "attributes": [
                attr("event.name", json!({ "stringValue": "claude_code.api_request" })),
                attr("session.id", json!({ "stringValue": "aaaaaaaa-sess-2" })),
                attr("input_tokens", json!({ "intValue": "99" })),
            ] },
            { "timeUnixNano": t, "attributes": [
                attr("event.name", json!({ "stringValue": "plugin_loaded" })),
                attr("has_hooks", json!({ "boolValue": true })),
            ] },
        ] }],
    }] })
}

fn statusline_body() -> String {
    json!({
        "session_id": "aaaaaaaa-sl-1", "cwd": "/work/aaaaaaaa", "version": "2.1.285",
        "cost": { "total_api_duration_ms": 5, "total_cost_usd": 0.5, "total_duration_ms": 10, "total_lines_added": 1, "total_lines_removed": 2 }
    })
    .to_string()
}

fn hook_files(data: &Path) -> usize {
    std::fs::read_dir(data.join("hook-events")).map(|rd| rd.flatten().count()).unwrap_or(0)
}

/// The first read (capture ON, the mode, the stamp), then the four POSTs; returns the stats after.
fn exercise(s: &Server, collection: &str, started_by: Value) -> (Value, String) {
    let first = s.stats();
    assert_eq!(first["gate"]["captureEnabled"], true, "hook capture must be ON for this boot to prove anything");
    assert_eq!(first["collection"], collection, "log:\n{}", s.log_text());
    assert_eq!(first["startedBy"], started_by);
    assert_eq!(http(s.otlp, "POST", "/v1/traces", &traces_body().to_string()).0, 200, "traces POST");
    assert_eq!(http(s.otlp, "POST", "/v1/logs", &logs_body().to_string()).0, 200, "logs POST");
    let ev = json!({ "hook_event_name": "SubagentStart", "session_id": "aaaaaaaa-hook-1", "agent_type": "general-purpose" }).to_string();
    let (status, hook_body) = http(s.ui, "POST", "/api/hook-events", &ev);
    assert_eq!(status, 200, "{hook_body}");
    assert_eq!(http(s.ui, "POST", "/api/statusline-samples", &statusline_body()).0, 200, "status-line POST");
    (s.stats(), hook_body)
}

fn assert_mode_boot(s: &Server, started_by: Value) {
    let (v, hook_body) = exercise(s, "off", started_by);
    assert_eq!(v["spans"]["inMemory"], 0, "no span may be stored in the mode");
    assert_eq!(v["spans"]["pendingAppends"], 0, "no span may be queued for the store in the mode");
    assert_eq!(v["otlp"]["tracesPayloads"], 0, "the payload is dropped before the ingest");
    assert_eq!(v["logEvents"]["persistedSinceBoot"], 0, "no log-event may be persisted in the mode");
    assert!(!s.data.join("log-events").exists(), "no log-events dir in the mode");
    // The disk check comes first so the ingest_hook_event mutation goes red on the FILE assertion.
    assert_eq!(hook_files(&s.data), 0, "no hook-events file may appear in the mode");
    assert_eq!(hook_body, r#"{"ok":true,"dropped":"collection=off"}"#);
    assert_eq!(v["hookEvents"]["receivedSinceBoot"], 1, "the hook event is accepted (ring-only)");
    assert_eq!(v["statusline"]["receivedSinceBoot"], 1, "the status-line sample is stored");
    assert_eq!(v["bodies"]["captureDownSince"], Value::Null, "no CAPTURE DOWN for capture switched off on purpose");
}

#[test]
fn boot_with_the_disabled_file_runs_in_no_collection_mode() {
    let s = launch("file", true, false, Stamp::Supervisor);
    assert_mode_boot(&s, json!("supervisor"));
}

#[test]
fn boot_with_the_flag_and_no_file_runs_in_no_collection_mode() {
    let s = launch("flag", false, true, Stamp::Unset);
    assert!(!s.data.join("DISABLED").exists());
    assert_mode_boot(&s, Value::Null);
}

/// The CONTROL: the same POSTs and the same reads see every item when the mode is off.
#[test]
fn normal_boot_stores_what_the_mode_drops() {
    let s = launch("control", false, false, Stamp::Blank);
    let (v, hook_body) = exercise(&s, "on", Value::Null);
    assert_eq!(v["spans"]["inMemory"], 2, "the trace span and the rich log event are stored");
    assert_eq!(v["otlp"]["tracesPayloads"], 1);
    assert_eq!(v["logEvents"]["persistedSinceBoot"], 1, "the rejected log event is persisted");
    assert_eq!(hook_body, r#"{"ok":true}"#);
    assert_eq!(v["hookEvents"]["receivedSinceBoot"], 1);
    assert_eq!(hook_files(&s.data), 1, "the hook-events bucket file appears");
    assert_eq!(v["statusline"]["receivedSinceBoot"], 1);
    // Status-line activity and no body ever ⇒ capture_down_since returns the boot time at once.
    assert!(v["bodies"]["captureDownSince"].is_i64() || v["bodies"]["captureDownSince"].is_u64(), "control must report CAPTURE DOWN: {}", v["bodies"]);
}
