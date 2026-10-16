//! A panic on any thread must end the process (TRDD-3RVTC1HY).
//!
//! The zombie this guards against: a panic while holding the state lock poisoned it, tokio kept the
//! process alive, and it ingested nothing for 28+ hours (2026-10-14). `--panic-after-ready` reproduces
//! that precondition on purpose. The panic hook in alcore.rs must turn it into an exit before the lock
//! can poison, and the exit must leave the pid lock as a dead pid, so a restart can claim the data dir.

#![cfg(unix)]

use std::fs::File;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Three ports bound at once, so no two of the three listeners can be handed the same port. Each port is
/// read and then released, so a racing binder can still take one before alcore binds it; that lost race
/// fails the test with alcore stderr attached, not with a wrong assertion.
fn free_ports() -> [u16; 3] {
    let listeners: Vec<std::net::TcpListener> = (0..3).map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let mut ports = [0u16; 3];
    for (port, listener) in ports.iter_mut().zip(&listeners) {
        *port = listener.local_addr().unwrap().port();
    }
    ports
}

/// A panic on a thread holding the state lock exits the process with status 1, logs the FATAL line before
/// the default panic message, and leaves the lock of the dead pid in place for a restart to take over.
#[test]
fn panic_holding_the_state_lock_exits_the_process() {
    let base = std::env::temp_dir().join(format!("al-exit-on-panic-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let data_dir = base.join("data");
    let media_dir = base.join("media");
    let home = base.join("home");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&media_dir).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(media_dir.join("index.html"), "<html></html>").unwrap();
    let stderr_path = base.join("stderr.txt");
    let [otlp_port, ui_port, mcp_port] = free_ports();
    let mut child = Command::new(env!("CARGO_BIN_EXE_alcore"))
        .args([
            "serve",
            "--data-dir",
            data_dir.to_str().unwrap(),
            "--media-dir",
            media_dir.to_str().unwrap(),
            "--otlp-port",
            &otlp_port.to_string(),
            "--ui-port",
            &ui_port.to_string(),
            "--mcp-port",
            &mcp_port.to_string(),
            "--no-log-scan",
            "--panic-after-ready",
        ])
        // RUST_BACKTRACE makes the default hook symbolicate a debug binary, which can outlast the hook alarm
        // of 10 s and turn the expected exit 1 into a SIGALRM kill, so the test must not inherit it.
        .env_remove("RUST_BACKTRACE")
        .env("HOME", &home)
        .stdout(Stdio::from(File::create(base.join("stdout.txt")).unwrap()))
        .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
        .spawn()
        .expect("alcore spawns");
    let deadline = Instant::now() + Duration::from_secs(120);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
            // Kill and reap before failing: a leaked server would keep the ports and the data dir.
            let _ = child.kill();
            let _ = child.wait();
            if stderr.contains("--panic-after-ready test trigger") {
                panic!("trigger fired but process did not exit; stderr:\n{stderr}");
            }
            panic!("trigger never fired (readiness never observed); stderr:\n{stderr}");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(status.code(), Some(1), "alcore must exit with status 1 from the panic hook, got {status:?}");
    let stderr = std::fs::read_to_string(&stderr_path).unwrap();
    let lines: Vec<&str> = stderr.lines().collect();
    let fatal = lines
        .iter()
        .position(|l| l.contains("alcore: FATAL — a thread panicked at"))
        .unwrap_or_else(|| panic!("the FATAL line is on stderr; stderr:\n{stderr}"));
    assert!(lines[fatal].contains("alcore.rs"), "the FATAL line must name the panic site: {}", lines[fatal]);
    let trigger = lines
        .iter()
        .position(|l| l.contains("alcore: --panic-after-ready test trigger"))
        .unwrap_or_else(|| panic!("the default hook prints the panic message; stderr:\n{stderr}"));
    assert!(fatal < trigger, "the FATAL line (line {fatal}) must precede the default hook output (line {trigger})");
    assert!(
        agentlens_core::pid_lock::pidfile_path(&data_dir).exists(),
        "the panic exit must leave the lock of the dead pid in place, so the claim below exercises dead-pid takeover"
    );
    assert!(
        matches!(agentlens_core::pid_lock::claim(&data_dir), agentlens_core::pid_lock::ClaimOutcome::Claimed),
        "the exit left the pid lock held by a dead process, so a restart cannot claim the data dir"
    );
    agentlens_core::pid_lock::release(&data_dir);
    let _ = std::fs::remove_dir_all(&base);
}
