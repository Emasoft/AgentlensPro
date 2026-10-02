//! Phase B: background chores share the heavy-DuckDB slot and SKIP a tick when it is busy.

use std::collections::HashMap;
use std::time::Duration;

use agentlens_core::statusline_store::{maybe_seal, StatuslineStore};
use agentlens_store::transcript_sql::acquire_heavy_within;
use serde_json::json;

/// A statusline seal tick while a heavy query holds the slot skips (WAL untouched); the next tick seals.
#[test]
fn statusline_seal_skips_while_the_heavy_slot_is_held_then_proceeds() {
    let root = std::env::temp_dir().join(format!("al-chore-heavy-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mut store = StatuslineStore::new(root.clone());
    let vars: HashMap<String, String> = HashMap::from([("AGENTLENS_STATUSLINE_SEAL_ROWS".to_owned(), "10".to_owned())]);
    let now = agentlens_core::now_ms() as f64;
    for i in 0..40 {
        let payload = json!({ "session_id": "cccccccc-cccc-cccc-cccc-cccccccccccc", "i": i });
        store.append(payload.as_object().unwrap(), "main", now - 1000.0 + i as f64);
    }
    store.flush(None);

    let held = acquire_heavy_within(Duration::from_secs(5)).expect("take the slot");
    assert_eq!(maybe_seal(&root, &store.counters, &vars, now), 0, "busy slot => the tick is skipped");
    drop(held);
    assert!(maybe_seal(&root, &store.counters, &vars, now) >= 1, "slot free => the next tick seals");
    let _ = std::fs::remove_dir_all(&root);
}
