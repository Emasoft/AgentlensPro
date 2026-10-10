//! QSFYIHUO step 3 — scan_window store-first parity test.
//!
//! MUTATION TARGET: `investigator_scan::load_store_window` + the store-first branch of
//! `scan_window` + the raw_facts columns written by the ingest pass. Deleting the store-first
//! branch, the raw_facts_v guard, or the stem dedup must fail this test.
//!
//! Shape (A3b): capture the BODY-PATH scan output FIRST (that is the comparison baseline), ingest
//! the same bodies through the real pass with the raw-facts extractor, DELETE the bodies, then run
//! scan_window with store_dir set — resps/reqs/fingerprint families/workspace/image_bytes must
//! match the body path bit-for-bit, blind must stay None, and session_id must be equal across
//! paths. Fixture mtimes == the ts_ms values ingested (byHour buckets are mtime/ts-derived).

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use agentlens_core::burn::investigator_scan::{scan_window, BodiesScope, InvestigateOptions};
use agentlens_store::pass::{ingest_pass_observed_with, PassOptions as StorePassOptions};

fn fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("al-s3-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let spool = root.join("otel-bodies");
    let store = root.join("store");
    fs::create_dir_all(&spool).unwrap();
    (root.clone(), spool, store)
}

fn write_at(p: &Path, raw: &str, ts_ms: u64) {
    fs::write(p, raw).unwrap();
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ts_ms);
    fs::OpenOptions::new().write(true).open(p).unwrap().set_times(fs::FileTimes::new().set_modified(t)).unwrap();
}

fn req_body(session: &str, prev_req: &str) -> String {
    // `session` must be UUID-SHAPED: find_session_id (the body path) only captures hex/dash runs,
    // so both paths see the same id only for uuid-shaped values.

    let pad = "r".repeat(600);
    serde_json::json!({
        "model": "claude-opus-5",
        "metadata": { "user_id": serde_json::Value::String(format!("{{\"session_id\":\"{session}\"}}")) },
        "system": [
            { "type": "text", "text": format!("x-anthropic-billing-header: cc_version=2.1.258.c18; cc_entrypoint=cli; cc_is_subagent=true; cc_prev_req={prev_req};") },
            { "type": "text", "text": "Primary working directory: /w/sp\nmore env" },
            { "type": "text", "text": format!("stable rules {pad}"), "cache_control": {"type":"ephemeral"} }
        ],
        "tools": [ {"name":"Bash"}, {"name":"Read"} ],
        "messages": [ { "role":"user", "content": [ {"type":"text","text":format!("first user turn {pad}"), "cache_control": {"type":"ephemeral"}} ] } ]
    })
    .to_string()
}

fn resp_body(id: &str, cc: i64) -> String {
    serde_json::json!({
        "id": id, "type": "message", "model": "claude-opus-5", "stop_reason": "end_turn",
        "content": [ {"type":"text","text":"answer"} ],
        "usage": { "input_tokens": 10, "output_tokens": 30, "cache_read_input_tokens": 9000, "cache_creation_input_tokens": cc }
    })
    .to_string()
}

#[test]
fn store_path_scan_matches_body_path_scan_bit_for_bit() {
    let (root, spool, store) = fixture("parity");
    let base_ms: u64 = 1_787_000_000_000;
    // 3 requests + 3 responses at distinct mts inside one window.
    let names_req = ["c1aaaaaa-0000-4000-8000-000000000001.request.json", "c1aaaaaa-0000-4000-8000-000000000002.request.json", "c1aaaaaa-0000-4000-8000-000000000003.request.json"];
    let names_resp = ["req_r1.response.json", "req_r2.response.json", "req_r3.response.json"];
    for (i, n) in names_req.iter().enumerate() {
        write_at(&spool.join(n), &req_body("aaaaaaaa-1111-4222-8333-444444444444", &format!("req_r{}", i + 1)), base_ms + (i as u64 + 1) * 60_000);
    }
    for (i, n) in names_resp.iter().enumerate() {
        write_at(&spool.join(n), &resp_body(&format!("msg_r{}", i + 1), 12_000 + i as i64 * 1000), base_ms + (i as u64 + 1) * 60_000 + 30_000);
    }

    // 1) BODY-PATH BASELINE — pre-step-3 behavior (store_dir None), bodies on disk.
    let scope_dirs = vec![spool.to_string_lossy().into_owned()];
    let mk = |store: Option<PathBuf>| InvestigateOptions {
        scope: BodiesScope { dirs: scope_dirs.clone(), missing: vec![] },
        store_dir: store,
        hook_events_dir: root.join("hook-events"),
        home: "/w/home".to_owned(),
        window_hours: Some(1.0),
        until_ms: Some(base_ms as f64 + 600_000.0),
        max_files: None,
    };
    let body_scan = scan_window(&mk(None), base_ms as f64 + 600_000.0);
    assert!(body_scan.blind.is_none(), "body path must not be blind");
    assert_eq!(body_scan.resps.len(), 3, "3 responses on the body path");
    assert_eq!(body_scan.reqs.len(), 3, "3 requests on the body path");
    let body_ws: Vec<String> = body_scan.reqs.iter().map(|r| r.workspace.clone()).collect();
    let body_fp: Vec<String> = body_scan.reqs.iter().map(|r| r.fingerprint.clone()).collect();
    let body_img: Vec<f64> = body_scan.reqs.iter().map(|r| r.image_bytes).collect();
    let body_sid: Vec<Option<String>> = body_scan.reqs.iter().map(|r| r.session_id.clone()).collect();

    // 2) INGEST through the real pass (with both extractors) — the pass deletes the bodies.
    let mut store_con = agentlens_store::open_store(&store, agentlens_store::DEFAULT_MEMORY_LIMIT, 4).expect("open");
    let opts = StorePassOptions { bodies_dir: spool.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let mut prefix_extractor = |parsed: Option<&serde_json::Value>| -> Option<String> {
        agentlens_core::cache_break_timeline::extract_turn_prefix(parsed).map(|p| agentlens_core::turn_prefix_codec::to_prefix_json(&p))
    };
    let mut raw_facts_extractor = |raw: &str| agentlens_core::burn::investigator_scan::extract_raw_facts(raw, 6 * 1024 * 1024);
    let r = ingest_pass_observed_with(&mut store_con, &opts, &mut skip, &mut stranded, &mut fsynced, None, Some(&mut prefix_extractor), Some(&mut raw_facts_extractor));
    assert!(r.failed.is_empty(), "pass failed: {:?}", r.failed);
    assert!(!spool.join(names_req[0]).exists(), "pass deleted the ingested body");
    drop(store_con);

    // 3) STORE-PATH SCAN — same window, bodies gone.
    let store_scan = scan_window(&mk(Some(store.clone())), base_ms as f64 + 600_000.0);
    assert!(store_scan.blind.is_none(), "a drained spool with a live store is NOT blind");
    // Bit-for-bit equality of the families the detectors consume.
    assert_eq!(store_scan.resps.len(), body_scan.resps.len(), "response count");
    for (sr, br) in store_scan.resps.iter().zip(body_scan.resps.iter()) {
        assert_eq!(sr.ts, br.ts, "resp ts");
        assert_eq!(sr.model, br.model, "resp model");
        assert_eq!(sr.cc, br.cc, "resp cc");
        assert_eq!(sr.cr, br.cr, "resp cr");
        assert_eq!(sr.out, br.out, "resp out");
        assert_eq!(sr.inp, br.inp, "resp inp");
    }
    assert_eq!(store_scan.total_equiv, body_scan.total_equiv, "total_equiv");
    assert_eq!(store_scan.cc, body_scan.cc, "cc");
    assert_eq!(store_scan.cr, body_scan.cr, "cr");
    assert_eq!(store_scan.est_cost_usd, body_scan.est_cost_usd, "est_cost_usd");
    let store_ws: Vec<String> = store_scan.reqs.iter().map(|r| r.workspace.clone()).collect();
    let store_fp: Vec<String> = store_scan.reqs.iter().map(|r| r.fingerprint.clone()).collect();
    let store_img: Vec<f64> = store_scan.reqs.iter().map(|r| r.image_bytes).collect();
    let store_sid: Vec<Option<String>> = store_scan.reqs.iter().map(|r| r.session_id.clone()).collect();
    assert_eq!(store_ws, body_ws, "workspace family");
    assert_eq!(store_fp, body_fp, "fingerprint family");
    assert_eq!(store_img, body_img, "image_bytes family");
    assert_eq!(store_sid, body_sid, "session_id equality across paths (A3b)");
    assert_eq!(store_ws.iter().filter(|w| !w.is_empty()).count(), 3, "every store row carries its workspace");

    // 4) NO-CAP note (A3c): the store-first coverage note names the SQL source explicitly.
    let note = store_scan.partial["coverage"]["note"].as_str().unwrap_or("");
    assert!(note.contains("store-first"), "coverage note must disclose the store-first path: {note}");
    assert_eq!(store_scan.partial["coverage"]["requestFilesScanned"], serde_json::json!(3), "store rows counted once");
    assert_eq!(store_scan.partial["coverage"]["responseFilesScanned"], serde_json::json!(3), "store rows counted once");
    assert_eq!(store_scan.partial["coverage"]["complete"], serde_json::json!(true), "store path emits complete");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn pre_step3_rows_fall_back_and_store_pass_failure_fails_open() {
    let (root, spool, store) = fixture("fallback");
    let base_ms: u64 = 1_787_500_000_000;
    // Request ingested WITHOUT the raw-facts extractor (a pre-step-3 row: raw_facts_v NULL)
    // plus one WITH — the mixed-generation store the fallback must survive.
    let a = req_body("bbbbbbbb-1111-4222-8333-444444444444", "req_fa");
    let b = req_body("cccccccc-1111-4222-8333-444444444444", "req_fb");
    write_at(&spool.join("c2aaaaaa-0000-4000-8000-000000000001.request.json"), &a, base_ms);
    let mut store_con = agentlens_store::open_store(&store, agentlens_store::DEFAULT_MEMORY_LIMIT, 4).expect("open");
    // delete_after=false: this test needs the pre-step-3 file ON DISK for the fallback scan.
    let opts = StorePassOptions { bodies_dir: spool.clone(), delete_after: false, ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass_observed_with(&mut store_con, &opts, &mut skip, &mut stranded, &mut fsynced, None, None, None);
    assert!(r.failed.is_empty(), "pass 1 failed: {:?}", r.failed);
    drop(store_con);
    write_at(&spool.join("c2aaaaaa-0000-4000-8000-000000000002.request.json"), &b, base_ms + 60_000);
    let mut store_con = agentlens_store::open_store(&store, agentlens_store::DEFAULT_MEMORY_LIMIT, 4).expect("reopen");
    // delete_after=false in both passes, so file `a` (the NULL raw_facts_v row) is still on disk:
    // scan_window must re-scan it with the body walk, because the store row has no trusted trio.
    let mut raw_facts_extractor = |raw: &str| agentlens_core::burn::investigator_scan::extract_raw_facts(raw, 6 * 1024 * 1024);
    let r2 = ingest_pass_observed_with(&mut store_con, &opts, &mut skip, &mut stranded, &mut fsynced, None, None, Some(&mut raw_facts_extractor));
    assert_eq!(r2.ingested, 1, "pass 2 ingests only the new body: {:?}", r2.failed);
    drop(store_con);

    // Scan with the store: the NULL-version row's file is re-scanned by the body walk, the
    // v1 row is served from the store — both turns present, no double-count.
    let o = InvestigateOptions {
        scope: BodiesScope { dirs: vec![spool.to_string_lossy().into_owned()], missing: vec![] },
        store_dir: Some(store.clone()),
        hook_events_dir: root.join("hook-events"),
        home: "/w/home".to_owned(),
        window_hours: Some(1.0),
        until_ms: Some(base_ms as f64 + 600_000.0),
        max_files: None,
    };
    let scan = scan_window(&o, base_ms as f64 + 600_000.0);
    assert_eq!(scan.reqs.len(), 2, "both requests present exactly once: {:?}", scan.reqs.iter().map(|r| (r.workspace.clone(), r.fingerprint.clone())).collect::<Vec<_>>());
    // The body-scanned row (file re-scanned from disk) carries the same workspace the store row
    // would have — the fallback is faithful.
    assert_eq!(scan.partial["coverage"]["requestFilesScanned"], serde_json::json!(2), "overlap file not double-counted");
    assert!(scan.reqs.iter().all(|r| r.workspace == "/w/sp"), "fallback row keeps its workspace");

    // A3d: a NONSENSE store_dir fails open to the body walk (dirs still hold the files).
    let mut o2 = o.clone();
    o2.store_dir = Some(root.join("no-such-store"));
    let scan2 = scan_window(&o2, base_ms as f64 + 600_000.0);
    assert_eq!(scan2.reqs.len(), 2, "fail-open body walk still scans both files");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn fingerprint_is_faithful_when_messages_starts_after_the_first_chunk() {
    use agentlens_store::raw_facts::{djb2, extract_raw_facts, js_slice};
    // "messages" sits past the first 512 KiB chunk, so the fingerprint is taken from a chunk
    // text that begins with the 256-unit carry — it must still equal the whole-body slice.
    let body = serde_json::json!({
        "model": "claude-opus-5",
        "system": [ { "type": "text", "text": format!("Primary working directory: /w/sp\n{}", "x".repeat(700_000)) } ],
        "messages": [ { "role": "user", "content": "m".repeat(4000) } ]
    })
    .to_string();
    let bp = body.find("\"messages\"").unwrap();
    assert!(bp > 512 * 1024, "layout: messages must start after the first chunk (bp={bp})");
    let f = extract_raw_facts(&body, 6 * 1024 * 1024);
    assert_eq!(f.workspace, "/w/sp");
    assert_eq!(f.fp_2600, djb2(js_slice(&body[bp..], 2600)), "fingerprint across a chunk boundary");
}

/// One real ingest pass over `spool` into `store`; `with_facts` selects the raw-facts extractor.
fn ingest(store: &Path, spool: &Path, delete_after: bool, with_facts: bool) {
    let mut con = agentlens_store::open_store(store, agentlens_store::DEFAULT_MEMORY_LIMIT, 4).expect("open");
    let opts = StorePassOptions { bodies_dir: spool.to_path_buf(), delete_after, ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let mut raw_facts_extractor = |raw: &str| agentlens_core::burn::investigator_scan::extract_raw_facts(raw, 6 * 1024 * 1024);
    let r = ingest_pass_observed_with(
        &mut con, &opts, &mut skip, &mut stranded, &mut fsynced, None, None,
        if with_facts { Some(&mut raw_facts_extractor) } else { None },
    );
    assert!(r.failed.is_empty(), "pass failed: {:?}", r.failed);
}

fn opts_for(root: &Path, spool: &Path, store: &Path, hours: f64, until_ms: f64) -> InvestigateOptions {
    InvestigateOptions {
        scope: BodiesScope { dirs: vec![spool.to_string_lossy().into_owned()], missing: vec![] },
        store_dir: Some(store.to_path_buf()),
        hook_events_dir: root.join("hook-events"),
        home: "/w/home".to_owned(),
        window_hours: Some(hours),
        until_ms: Some(until_ms),
        max_files: None,
    }
}

fn hook_event(root: &Path, ts_ms: u64) {
    let mut payload = serde_json::Map::new();
    payload.insert("hook_event_name".into(), serde_json::json!("PreToolUse"));
    agentlens_core::hook_events::append_hook_event(&root.join("hook-events"), &payload, ts_ms as i64).expect("hook event");
}

#[test]
fn drained_spool_store_rows_are_not_a_capture_gap_but_a_real_hole_still_is() {
    let (root, spool, store) = fixture("gaps");
    let min = 60_000u64;
    let t: u64 = 1_787_000_000_000;
    // One request at +20 min and one response at +40 min, both ingested (and deleted).
    write_at(&spool.join("c3aaaaaa-0000-4000-8000-000000000001.request.json"), &req_body("dddddddd-1111-4222-8333-444444444444", "req_g1"), t + 20 * min);
    write_at(&spool.join("req_g1.response.json"), &resp_body("msg_g1", 12_000), t + 40 * min);
    ingest(&store, &spool, true, true);
    assert!(!spool.join("req_g1.response.json").exists(), "spool must be fully drained");
    // Hook events: +30 min (inside the 1 h window, between the two store rows) and +90 min.
    hook_event(&root, t + 30 * min);
    hook_event(&root, t + 90 * min);

    // 1 h window [t, t+60]: store rows at +20/+40 leave 20-min stretches only -> no gap, although
    // the spool is empty and a hook event sits in the middle. Before the fix the whole hour was a gap.
    let a = scan_window(&opts_for(&root, &spool, &store, 1.0, (t + 60 * min) as f64), (t + 60 * min) as f64);
    assert!(a.blind.is_none());
    assert_eq!(a.resps.len(), 1);
    assert!(a.partial["coverage"].get("captureGaps").is_none(), "store rows are captured bodies: {}", a.partial["coverage"]);

    // 2 h window [t, t+120]: +40 -> +120 is 80 min of nothing and the +90 hook event proves the
    // hook dir is really read (the same dir that produced no gap above).
    let b = scan_window(&opts_for(&root, &spool, &store, 2.0, (t + 120 * min) as f64), (t + 120 * min) as f64);
    let gaps = b.partial["coverage"]["captureGaps"].as_array().unwrap_or_else(|| panic!("gap expected: {}", b.partial["coverage"]));
    assert_eq!(gaps.len(), 1, "{gaps:?}");
    assert_eq!(gaps[0]["hookEventsDuring"], serde_json::json!(1));
    assert!((gaps[0]["hours"].as_f64().unwrap() - 80.0 / 60.0).abs() < 1e-9, "{gaps:?}");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn request_without_facts_and_without_body_is_counted_and_disclosed() {
    let (root, spool, store) = fixture("nofacts");
    let t: u64 = 1_787_500_000_000;
    let a = spool.join("c4aaaaaa-0000-4000-8000-000000000001.request.json");
    let b = spool.join("c4aaaaaa-0000-4000-8000-000000000002.request.json");
    write_at(&a, &req_body("eeeeeeee-1111-4222-8333-444444444444", "req_na"), t);
    ingest(&store, &spool, true, false); // pre-step-3 row: raw_facts_v NULL
    write_at(&b, &req_body("ffffffff-1111-4222-8333-444444444444", "req_nb"), t + 60_000);
    ingest(&store, &spool, true, true);
    assert!(!a.exists() && !b.exists(), "all bodies deleted");

    let scan = scan_window(&opts_for(&root, &spool, &store, 1.0, t as f64 + 600_000.0), t as f64 + 600_000.0);
    assert!(scan.blind.is_none(), "store rows count as seen");
    assert_eq!(scan.reqs.len(), 1, "only the request with facts is served");
    let cov = &scan.partial["coverage"];
    assert_eq!(cov["storeRequestsWithoutFacts"], serde_json::json!(1), "{cov}");
    let note = cov["note"].as_str().unwrap_or("");
    assert!(note.contains("1 request(s) are in the store without workspace/fingerprint facts"), "{note}");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn response_in_both_store_and_spool_is_counted_once() {
    let (root, spool, store) = fixture("dupresp");
    let t: u64 = 1_787_600_000_000;
    let r = spool.join("req_dup.response.json");
    write_at(&r, &resp_body("msg_dup", 12_000), t);
    ingest(&store, &spool, false, true); // delete_after=false: the file stays next to its store row
    assert!(r.exists(), "the spool file must still exist for the overlap to be real");

    let scan = scan_window(&opts_for(&root, &spool, &store, 1.0, t as f64 + 600_000.0), t as f64 + 600_000.0);
    assert_eq!(scan.resps.len(), 1, "one response, not store row + file");
    assert_eq!(scan.cc, 12_000.0);
    assert_eq!(scan.partial["coverage"]["responseFilesScanned"], serde_json::json!(1));

    let _ = fs::remove_dir_all(&root);
}
