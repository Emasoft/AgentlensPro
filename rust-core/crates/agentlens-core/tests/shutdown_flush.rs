//! The stop path must flush (TRDD-HFV4AIT7, adversarial review of ae513a4 F1).
//!
//! Since the OTLP HTTP handler stopped flushing per payload, the 5 s chores tick is the durability
//! boundary — so whatever ends the process has to run the shutdown flush. `agentlenspro server
//! stop` sends **SIGTERM**, which is therefore the NORMAL stop, and the shutdown `select!`
//! originally awaited only `ctrl_c()` (SIGINT): the default disposition killed the process and up
//! to 5 s of spans died in the writer's buffer.
//!
//! Mutation-verified, not merely green: the SIGKILL case below is the same recipe with the signal
//! the handler CANNOT catch, and it must NOT find the span. Drop the SIGTERM arm from alcore.rs
//! and the first case fails exactly like the second.

#![cfg(unix)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

const SPAN_ID: &str = "00000000000000fe";

fn free_port() -> u16 {
    // Bind :0, read the port, drop the listener. A racing binder could steal it before alcore
    // gets there; the readiness wait below turns that into a clear failure, not a flake in the
    // assertion.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-shutdown-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn trace_payload() -> String {
    serde_json::json!({
        "resourceSpans": [{ "scopeSpans": [{ "spans": [{
            "traceId": "000000000000000000000000000000fe",
            "spanId": SPAN_ID,
            "name": "claude_code.interaction",
            "startTimeUnixNano": "1755600000000000000",
            "endTimeUnixNano":   "1755600001000000000",
            "attributes": [
                { "key": "session.id", "value": { "stringValue": "sess-shutdown-1" } },
                { "key": "user.account_uuid", "value": { "stringValue": "acct-1" } }
            ]
        }] }] }]
    })
    .to_string()
}

/// Spawn alcore on its own data dir + ports and wait until the OTLP listener accepts.
fn start(tag: &str) -> (Child, std::path::PathBuf, u16) {
    let data_dir = tmp(&format!("{tag}-data"));
    let media_dir = tmp(&format!("{tag}-media"));
    std::fs::write(media_dir.join("index.html"), "<html></html>").unwrap();
    let otlp = free_port();
    let mut child = Command::new(env!("CARGO_BIN_EXE_alcore"))
        .args([
            "serve",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--media-dir",
            media_dir.to_str().unwrap(),
            "--otlp-port",
            &otlp.to_string(),
            "--ui-port",
            &free_port().to_string(),
            "--mcp-port",
            &free_port().to_string(),
            "--no-log-scan",
        ])
        .spawn()
        .expect("alcore spawns");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", otlp)).is_ok() {
            return (child, data_dir, otlp);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // Reap before failing — a panic that leaks the child leaves a server holding the port.
    let _ = child.kill();
    let _ = child.wait();
    panic!("alcore never bound the OTLP port {otlp}");
}

fn post_span(port: u16) {
    let body = trace_payload();
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(
        format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
            .as_bytes(),
    )
    .unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    assert!(resp.starts_with("HTTP/1.1 200"), "ingest POST: {resp}");
}

/// True when the span reached a segment file on disk.
fn span_on_disk(data_dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(data_dir.join("spans")) else { return false };
    entries.filter_map(Result::ok).any(|e| std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains(SPAN_ID)))
}

fn signal_and_wait(child: &mut Child, sig: &str) {
    let ok = Command::new("kill").args([sig, &child.id().to_string()]).status().expect("kill runs").success();
    assert!(ok, "kill {sig} failed");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if child.try_wait().expect("try_wait").is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
    panic!("alcore did not exit after kill {sig}");
}

#[test]
fn sigterm_flushes_the_buffered_spans_before_exit() {
    let (mut child, data_dir, otlp) = start("term");
    post_span(otlp);
    // Well inside the 5 s chores tick, so the ONLY thing that can have written the span is the
    // shutdown flush.
    std::thread::sleep(Duration::from_millis(300));
    assert!(!span_on_disk(&data_dir), "the HTTP path must NOT flush per payload — that was root cause 1");
    signal_and_wait(&mut child, "-TERM");
    assert!(span_on_disk(&data_dir), "SIGTERM must run the shutdown flush (`agentlenspro server stop` sends it)");
}

#[test]
fn sigkill_loses_the_buffer_which_is_what_makes_the_sigterm_case_meaningful() {
    let (mut child, data_dir, otlp) = start("kill");
    post_span(otlp);
    std::thread::sleep(Duration::from_millis(300));
    signal_and_wait(&mut child, "-KILL");
    assert!(!span_on_disk(&data_dir), "SIGKILL cannot be caught — a span here would mean the test proves nothing");
}
