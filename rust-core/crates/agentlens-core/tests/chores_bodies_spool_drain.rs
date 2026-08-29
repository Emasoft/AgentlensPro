//! TRDD-ZW4APOPI: `bodies_pass` must drain the CONFIGURED SPOOL, not only the legacy dir.
//!
//! The regression this guards cost real data: `bodies_pass` hardcoded `data_dir.join("otel-bodies")`
//! while the TS drained both targets, so a configured RAM-disk spool had NO drain at all under
//! alcore. Measured on 2026-08-29: the 2GB spool sat 100% full for ~18h and 117 request bodies were
//! written as ZERO BYTES — silent, size-dependent loss.
//!
//! MUTATION CHECK (do this if you touch `bodies_pass`): revert the dir resolution to the hardcoded
//! `data_dir.join("otel-bodies")` and `spool_body_is_drained` MUST fail. A test that still passes
//! with the bug reinstated is guarding nothing.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

/// A body written into the dir named by `capture.spoolDir` is ingested and its file reclaimed.
#[test]
fn spool_body_is_drained() {
    let tmp = std::env::temp_dir().join(format!("al-spool-drain-{}", std::process::id()));
    let data_dir = tmp.join("data");
    let spool_dir = tmp.join("spool");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&spool_dir).unwrap();
    // The legacy dir must EXIST too: its absence is the pre-fix early-return, and letting the test
    // pass because the legacy dir is missing would prove nothing about the spool.
    std::fs::create_dir_all(data_dir.join("otel-bodies")).unwrap();

    // `spool_dir_configured` reads capture.spoolDir; raw capture must be on for the scope to
    // resolve, matching how the real install is wired.
    std::fs::write(
        data_dir.join("config.json"),
        serde_json::json!({ "capture": { "rawBodies": true, "spoolDir": spool_dir.to_str().unwrap() } }).to_string(),
    )
    .unwrap();

    let body = serde_json::json!({ "model": "claude-opus-5", "messages": [{ "role": "user", "content": "hi" }] });
    let name = "11111111-2222-3333-4444-555555555555.request.json";
    std::fs::write(spool_dir.join(name), serde_json::to_string(&body).unwrap()).unwrap();

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    assert!(
        !spool_dir.join(name).exists(),
        "the body is still in the spool — bodies_pass did not drain the configured spool dir (the ZW4APOPI regression)"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}
