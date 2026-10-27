//! alcore refuses to boot while `<data_dir>/DISABLED` exists (TRDD-NZ9Z9ALO).
//!
//! The retired TS server had this gate; the Rust port dropped it, so a supervisor spawned under DISABLED
//! got a live server. The gate must run before any file, lock or key is created.

#![cfg(unix)]

use std::fs::File;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Three ports bound at once so no two listeners can be handed the same port (see exit_on_panic.rs).
fn free_ports() -> [u16; 3] {
    let listeners: Vec<std::net::TcpListener> = (0..3).map(|_| std::net::TcpListener::bind("127.0.0.1:0").unwrap()).collect();
    let mut ports = [0u16; 3];
    for (port, listener) in ports.iter_mut().zip(&listeners) {
        *port = listener.local_addr().unwrap().port();
    }
    ports
}

/// With the DISABLED flag present alcore exits 78 naming the flag, and has created no pid lock, span dir or embed key.
#[test]
fn alcore_refuses_to_boot_while_the_disabled_flag_is_present() {
    let base = std::env::temp_dir().join(format!("al-disabled-refuses-boot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let data_dir = base.join("data");
    let media_dir = base.join("media");
    let home = base.join("home");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&media_dir).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(media_dir.join("index.html"), "<html></html>").unwrap();
    std::fs::write(data_dir.join("DISABLED"), "").unwrap();
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
        ])
        .env_remove("AGENTLENS_DISABLED")
        .env("HOME", &home)
        .stdout(Stdio::from(File::create(base.join("stdout.txt")).unwrap()))
        .stderr(Stdio::from(File::create(&stderr_path).unwrap()))
        .spawn()
        .expect("alcore spawns");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
            // Kill and reap before failing: a leaked server would keep the ports and the data dir.
            let _ = child.kill();
            let _ = child.wait();
            panic!("alcore kept running with the DISABLED flag present; stderr:\n{stderr}");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stderr = std::fs::read_to_string(&stderr_path).unwrap();
    assert_eq!(status.code(), Some(78), "alcore must exit 78 (EX_CONFIG), got {status:?}; stderr:\n{stderr}");
    assert!(stderr.contains("DISABLED flag present"), "stderr must name the flag; stderr:\n{stderr}");
    assert!(!agentlens_core::pid_lock::pidfile_path(&data_dir).exists(), "no pid lock may be taken before the gate");
    assert!(!data_dir.join("spans").exists(), "no span dir may be created before the gate");
    assert!(!data_dir.join("embed-key").exists(), "no embed key may be created before the gate");
    let _ = std::fs::remove_dir_all(&base);
}
