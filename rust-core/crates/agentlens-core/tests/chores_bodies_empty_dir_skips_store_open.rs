//! TRDD-Z53IJFE9 step B, advisor verdict B-3: with the bodies pass now ticking every 60s instead
//! of hourly, the SSD `<data>/otel-bodies` dir is empty most ticks — `bodies_pass` must check
//! that BEFORE taking the pass lock and opening the DuckDB store, not after, so an idle minute
//! costs one directory read instead of a store open.
//!
//! Observable proxy: `acquire_pass_lock` and `open_store` both `create_dir_all` the store dir on
//! first touch (`pass.rs`'s own comment: "on a brand-new store THIS is the first touch"), so a
//! store dir that still does not exist after a pass over an empty bodies dir proves neither ran.
//!
//! MUTATION CHECK: remove the `scope.dirs.iter().all(|d| staged_body_bytes(d) == 0)` early return
//! in `bodies_pass` and `empty_dir_never_opens_the_store` MUST fail (the store dir gets created
//! by `acquire_pass_lock` even though there is nothing to ingest).

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

#[test]
fn empty_dir_never_opens_the_store() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap(); // exists, but holds nothing

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    assert!(
        !data_dir.join("store").exists(),
        "an empty bodies dir must never cause the pass lock or the store to be opened"
    );

    let _ = std::fs::remove_dir_all(&tmp);
}
