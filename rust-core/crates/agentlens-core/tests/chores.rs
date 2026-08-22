//! The chore scheduler's two pieces of real logic (TRDD-DMWOBWFH tier A). `spawn_all` itself is
//! not tested — it is interval arithmetic over functions that ARE tested (`chores_purge.rs`,
//! agentlens-spanstore `writer.rs`), and a test that only proves `tokio::time::interval` works
//! would be documentation. These two are not: one ports JS truthiness, the other is the guard
//! standing between two engines and the same store.

use std::collections::HashMap;

use agentlens_core::chores::{
    hook_events_retention_days, ingest_max_bytes_per_pass, project_resident_blobs, staged_body_bytes, with_chores_lock,
};
use serde_json::json;

fn vars(v: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Some(v) = v {
        m.insert("AGENTLENS_HOOK_EVENTS_RETENTION_DAYS".to_owned(), v.to_owned());
    }
    m
}

/// `Math.max(1, Number(env) || 31)` — ported through JS TRUTHINESS, which is not the same as
/// "parse, else default", and the difference is observable at exactly the values an operator is
/// most likely to type.
#[test]
fn hook_events_retention_ports_js_truthiness_not_parse_or_default() {
    // Unset ⇒ the default. `Number(undefined)` is NaN, which is falsy.
    assert_eq!(hook_events_retention_days(&vars(None)), 31.0);

    // THE ONE THAT SURPRISES: an explicit 0 does NOT mean "keep nothing". `Number("0")` is 0,
    // which is FALSY, so the `||` takes the default. A naive parse-or-default would return 0 here
    // and the floor would raise it to 1 — a store purged to a single day instead of 31.
    assert_eq!(hook_events_retention_days(&vars(Some("0"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some("-0"))), 31.0);

    // Junk is NaN ⇒ falsy ⇒ default. "NaN" is the trap: `"NaN".parse::<f64>()` SUCCEEDS in Rust
    // and yields NaN, so without an explicit NaN filter this would return NaN and every
    // comparison against the cutoff would silently be false.
    assert_eq!(hook_events_retention_days(&vars(Some("abc"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some("NaN"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some(""))), 31.0);

    // A real value passes through, and whitespace is trimmed as `Number(" 5 ")` does.
    assert_eq!(hook_events_retention_days(&vars(Some("5"))), 5.0);
    assert_eq!(hook_events_retention_days(&vars(Some(" 7 "))), 7.0);

    // NEGATIVE is TRUTHY, so it survives the `||` and is caught by the floor instead — the two
    // guards do different jobs and both are needed.
    assert_eq!(hook_events_retention_days(&vars(Some("-3"))), 1.0);
    // Below the floor but positive: same floor, different path.
    assert_eq!(hook_events_retention_days(&vars(Some("0.5"))), 1.0);
}

/// `scanResidentBlobs`'s `.slice(0, 10).map(...)` (server.ts:1485). This value rides inside every
/// burn-status SSE frame, so both the CAP and the field list are wire-shape rules, not tidiness.
#[test]
fn resident_blob_projection_caps_at_ten_and_keeps_absent_absent() {
    let blob = |i: usize| {
        json!({
            "sessionId": format!("aaaa{i:04}"), "project": "p", "kind": "image", "label": "l",
            "isImage": true, "peakTokens": 30_000, "residentTurns": 5,
            "cumulativeReadTokens": 120_000, "cumulativeReadCostUsd": 0.6,
            // Engine-side fields the TS projection does NOT carry — they must not reach the wire.
            "model": "opus-5", "blockIndex": i,
        })
    };
    let many: Vec<_> = (0..25).map(blob).collect();
    let rows = project_resident_blobs(&json!({ "blobs": many }));

    assert_eq!(rows.len(), 10, "capped at 10 however many the engine returned");
    let first = rows[0].as_object().unwrap();
    assert_eq!(first.len(), 9, "exactly the nine projected fields");
    assert!(!first.contains_key("model"), "engine-only field must not reach the wire");
    assert!(!first.contains_key("blockIndex"));
    assert_eq!(first["sessionId"], json!("aaaa0000"), "engine ranking order is preserved");
    assert_eq!(rows[9].as_object().unwrap()["sessionId"], json!("aaaa0009"));

    // A blob missing a field yields a row WITHOUT that key — never `null`. A consumer reading
    // `isImage: null` cannot distinguish it from a real value; an absent key it can.
    let sparse = project_resident_blobs(&json!({ "blobs": [{ "sessionId": "bbbb2222", "kind": "text" }] }));
    let only = sparse[0].as_object().unwrap();
    assert_eq!(only.len(), 2);
    assert!(!only.contains_key("isImage"), "absent stays absent, not null");

    // Degenerate engine output is an EMPTY feed, not a panic — this runs on a timer forever.
    assert!(project_resident_blobs(&json!({ "blobs": [] })).is_empty());
    assert!(project_resident_blobs(&json!({})).is_empty(), "no `blobs` key at all");
    assert!(project_resident_blobs(&json!({ "blobs": "nonsense" })).is_empty());
}

/// `stagedBodyBytes` (server.ts:634) — the input to the OVER-CAP emergency valve. Counting the
/// wrong files makes the valve fire at the wrong time in whichever direction the miscount goes:
/// too high and every pass drains at age 0, too low and a runaway producer outruns the drain.
#[test]
fn staged_body_bytes_counts_only_body_files_and_fails_open() {
    let dir = std::env::temp_dir().join(format!("al-staged-bytes-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::write(dir.join("aaaa.request.json"), vec![b'x'; 100]).unwrap();
    std::fs::write(dir.join("aaaa.response.json"), vec![b'x'; 250]).unwrap();
    // Everything else in the dir is NOT ours and must not inflate the figure: the store's own
    // artifacts, a partial write, a log.
    std::fs::write(dir.join("bbbb2222.parquet"), vec![b'x'; 9_000]).unwrap();
    std::fs::write(dir.join("aaaa.request.json.tmp"), vec![b'x'; 9_000]).unwrap();
    std::fs::write(dir.join("notes.txt"), vec![b'x'; 9_000]).unwrap();

    assert_eq!(staged_body_bytes(&dir), 350, "only .request.json + .response.json");

    // Fails OPEN on a missing dir — it runs on a timer and must never throw. Zero is also the
    // honest answer: nothing is staged in a dir that does not exist.
    assert_eq!(staged_body_bytes(&dir.join("gone")), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

/// `INGEST_MAX_BYTES_PER_PASS` (server.ts:597) — the bound on how much one pass ingests, which is
/// what keeps an in-process DuckDB pass from ratcheting RSS the way the old unbounded boot sweep
/// did. Same JS truthiness trap as the retention knob, plus a hard floor.
#[test]
fn ingest_max_bytes_per_pass_floors_at_16mb_and_treats_zero_as_the_default() {
    const MB: u64 = 1024 * 1024;
    let v = |s: Option<&str>| {
        let mut m = HashMap::new();
        if let Some(s) = s {
            m.insert("AGENTLENS_INGEST_MAX_BYTES_PER_PASS".to_owned(), s.to_owned());
        }
        ingest_max_bytes_per_pass(&m)
    };

    assert_eq!(v(None), 512 * MB, "unset ⇒ DEFAULT_MAX_BYTES_PER_PASS");
    // Falsy ⇒ the default, NOT "ingest nothing" — the failure that would stall the drain silently.
    assert_eq!(v(Some("0")), 512 * MB);
    assert_eq!(v(Some("abc")), 512 * MB);
    assert_eq!(v(Some("NaN")), 512 * MB, "\"NaN\" parses in Rust — the filter is load-bearing");

    assert_eq!(v(Some("33554432")), 32 * MB, "an explicit value passes through");
    // Below the floor, the floor wins: no configuration may bound a pass so small that the drain
    // can never keep up.
    assert_eq!(v(Some("1024")), 16 * MB);
    assert_eq!(v(Some("-5")), 16 * MB, "negative is truthy, so the FLOOR catches it");
}

/// The cross-engine guard. If the TS server and alcore share a data dir, their retention passes
/// race — both enumerate the same segments and both decide the same file is expired. Busy must
/// SKIP the tick, never block and never run anyway.
#[test]
fn chores_lock_is_exclusive_and_a_busy_tick_skips_rather_than_blocks() {
    let dir = std::env::temp_dir().join(format!("al-chores-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // Uncontended: the body runs and its value comes back.
    assert_eq!(with_chores_lock(&dir, || 7), Some(7));

    // Contended: hold the flock the way another PROCESS would, then prove the tick declines.
    // `ran` is the load-bearing assertion — a guard that returns None but ran the body anyway
    // would be worse than no guard, because it would look correct in the manifest.
    {
        use fs2::FileExt;
        let held = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(".chores.lock"))
            .unwrap();
        held.try_lock_exclusive().expect("first claimant takes the lock");

        let mut ran = false;
        let out = with_chores_lock(&dir, || {
            ran = true;
            7
        });
        assert_eq!(out, None, "busy ⇒ the tick is skipped");
        assert!(!ran, "the body must NOT run while another engine holds the lock");

        fs2::FileExt::unlock(&held).unwrap();
    }

    // Released ⇒ the next tick proceeds. A lock that never came back would stop the reaper
    // forever, which is the silent-growth failure this whole tier exists to prevent.
    assert_eq!(with_chores_lock(&dir, || 9), Some(9));

    let _ = std::fs::remove_dir_all(&dir);
}
