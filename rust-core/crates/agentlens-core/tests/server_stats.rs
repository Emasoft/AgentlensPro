//! `/api/server-stats` — the frozen §1.4 shape (key order EXACT, the wire freeze report) over a
//! live CoreState, with every value the core owns measured and every NOT-PORTED key carrying
//! the TS idle value.

use agentlens_core::server_stats::{archive_disk_usage, buckets_disk_usage, hook_runtime_config, server_stats};
use agentlens_core::{ingest_post, now_ms, CoreState};
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-stats-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().expect("object").keys().map(String::as_str).collect()
}

fn trace_payload(session: &str) -> String {
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": "0123456789abcdef0123456789abcdef", "spanId": "0123456789abcdef",
        "startTimeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
        "attributes": [
            { "key": "session.id", "value": { "stringValue": session } },
            { "key": "input_tokens", "value": { "intValue": "100" } }
        ]
    }] }] }] })
    .to_string()
}

/// The freeze report §1.4, transcribed key by key — a renamed or reordered key fails here
/// before it can reach a consumer (`agentlenspro server status` reads this body positionally-
/// blind but the freeze is the contract).
#[test]
fn body_matches_the_frozen_key_order_exactly() {
    let data = tmp("shape");
    let st = CoreState::open(&data);
    let body = server_stats(&st, now_ms());
    assert_eq!(keys(&body), [
        "pid", "version", "startedAt", "uptimeSec", "ports", "canonical", "dataDir", "memory", "spans", "logSessions",
        "persistence", "bodies", "hookEvents", "statusline", "logEvents", "admission", "resources", "gate",
        "otlpDroppedLogEvents", "degradations",
    ]);
    assert_eq!(keys(&body["ports"]), ["ui", "mcp", "otlp"]);
    assert_eq!(keys(&body["memory"]), ["rssMb", "heapUsedMb", "heapLimitMb"]);
    // `droppedOnFailure` was ADDED to the frozen shape on 2026-08-29 (TRDD-YU8QPU89). It is a
    // deliberate extension, not drift: the span writer can drop on a failing disk, and before this
    // key there was NO way to observe that from outside the process — a silent loss. The freeze
    // caught the addition, which is the test working; it is updated here rather than the key being
    // removed, because the counter is the point. Additive only: every pre-existing key keeps its
    // name and relative position, so a consumer reading the old keys is unaffected.
    assert_eq!(keys(&body["spans"]), ["inMemory", "windowMs", "configuredWindowMs", "retentionDays", "pendingAppends", "droppedOnFailure", "store"]);
    assert_eq!(keys(&body["spans"]["store"]), ["segments", "totalSpans", "totalBytes"]);
    assert_eq!(keys(&body["persistence"]), [
        "spanAppendWrites", "spanAppendBytes", "offsetsWrites", "offsetsBytes", "cardsWrites", "cardsBytes",
        "hookEventWrites", "hookEventBytes", "logEventWrites", "logEventBytes", "statuslineSamples",
        "gateChecks", "gateDenies", "gateWarns", "gateAdvisories", "bodiesLastPurge",
        "spoolBackpressureSpills", "spoolBackpressureActive", "totalBytesWritten", "files",
    ]);
    assert_eq!(keys(&body["persistence"]["bodiesLastPurge"]), ["at", "removedFiles", "freedBytes", "keptFiles", "keptBytes"]);
    assert_eq!(keys(&body["persistence"]["files"]), ["spans", "offsets", "cards"]);
    assert_eq!(keys(&body["bodies"]), ["archive", "lastPass", "spool"]);
    assert_eq!(keys(&body["bodies"]["archive"]), ["volumes", "bytes", "entries"]);
    assert_eq!(body["bodies"]["spool"], Value::Null, "SPOOL_MODE off ⇒ null");
    assert_eq!(keys(&body["hookEvents"]), ["files", "bytes", "receivedSinceBoot", "spooled"]);
    assert_eq!(keys(&body["statusline"]), ["parts", "partBytes", "walBytes", "bufferedRows", "sealedParts", "droppedRows", "corruptWals", "receivedSinceBoot", "retentionDays"]);
    assert_eq!(keys(&body["logEvents"]), ["files", "bytes", "persistedSinceBoot", "persistedBytesSinceBoot", "retentionDays"]);
    assert_eq!(keys(&body["admission"]), ["inflight", "queued", "admittedTotal", "shedTotal"]);
    assert_eq!(keys(&body["resources"]), ["rssMb", "loadPerCore", "freeDiskMb", "cpuCount"]);
    assert_eq!(keys(&body["gate"]), ["mode", "enabled", "captureEnabled", "advisorEnabled", "checks", "denies", "warns", "advisories"]);
    assert_eq!(body["otlpDroppedLogEvents"], json!({}));
    assert_eq!(body["degradations"], json!({}));

    // Process facts are real.
    assert_eq!(body["pid"], std::process::id());
    assert_eq!(body["version"], serde_json::from_str::<Value>(include_str!("../../../../package.json")).unwrap()["version"]);
    assert!(body["startedAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(body["canonical"], false, "alcore default otlp 4319 ≠ 4318");
    assert_eq!(body["dataDir"], data.to_string_lossy().as_ref());
    assert!(body["memory"]["rssMb"].as_u64().unwrap() > 0, "rss is measured");
    assert_eq!(body["memory"]["heapUsedMb"], 0, "no V8 heap");
    // Defaults: 30-day span retention, 24h window, 31-day log events, 90-day statusline.
    assert_eq!(body["spans"]["retentionDays"], 30);
    assert_eq!(body["spans"]["windowMs"], 24 * 3_600_000);
    assert_eq!(body["spans"]["configuredWindowMs"], body["spans"]["windowMs"]);
    assert_eq!(body["logEvents"]["retentionDays"], 31);
    assert_eq!(body["statusline"]["retentionDays"], 90);
    // Resources: a real sample (cpuCount ≥ 1, free disk known on this machine).
    assert!(body["resources"]["cpuCount"].as_u64().unwrap() >= 1);
    assert!(body["resources"]["freeDiskMb"].as_f64().unwrap() > 0.0);
    assert!(body["resources"]["rssMb"].as_f64().unwrap() > 0.0);
    // Hook runtime defaults.
    assert_eq!(body["gate"], json!({ "mode": "enforce", "enabled": true, "captureEnabled": true, "advisorEnabled": true, "checks": 0, "denies": 0, "warns": 0, "advisories": 0 }));
}

#[test]
fn the_values_the_core_owns_move_with_the_state() {
    let data = tmp("live");
    // Knobs from the data dir's config (env > file > default, floor last) + the hook config file.
    std::fs::write(data.join("config.json"), r#"{"retention":{"spansRetentionDays":7,"logEventsRetentionDays":0.2}}"#).unwrap();
    std::fs::write(data.join("hook-config.json"), r#"{"gateMode":"warn","advisorEnabled":false}"#).unwrap();
    // On-disk sidecars the stats measure: two daily buckets (+ one non-bucket file ignored), one
    // archive volume with a 2-line index and a torn tail, two spooled hook events.
    std::fs::create_dir_all(data.join("hook-events")).unwrap();
    std::fs::write(data.join("hook-events/2026-08-18.ndjsonl"), "{}\n{}\n").unwrap();
    std::fs::write(data.join("hook-events/2026-08-19.ndjsonl"), "{}\n").unwrap();
    std::fs::write(data.join("hook-events/2026-13-40.ndjsonl"), "not a calendar day").unwrap();
    std::fs::write(data.join("hook-events/notes.txt"), "ignored").unwrap();
    std::fs::create_dir_all(data.join("otel-bodies-archive")).unwrap();
    std::fs::write(data.join("otel-bodies-archive/bodies-2026-08.wad"), vec![0u8; 100]).unwrap();
    let idx = "{\"n\":\"a\",\"o\":0,\"l\":1,\"s\":1,\"m\":1}\n{\"n\":\"b\",\"o\":1,\"l\":1,\"s\":1,\"m\":1}\n{\"n\":\"c\",\"o\"";
    std::fs::write(data.join("otel-bodies-archive/bodies-2026-08.wad.idx"), idx).unwrap();
    let archive_bytes = 100 + idx.len() as u64;
    std::fs::write(data.join("otel-bodies-archive/README"), "ignored").unwrap();
    std::fs::create_dir_all(data.join("hook-spool")).unwrap();
    std::fs::write(data.join("hook-spool/1.json"), "{}").unwrap();
    std::fs::write(data.join("hook-spool/2.json"), "{}").unwrap();
    std::fs::write(data.join("hook-spool/2.json.tmp"), "{}").unwrap();
    assert_eq!(buckets_disk_usage(&data.join("hook-events")), (2, 9), "6 + 3 bytes, the non-calendar and non-bucket files skipped");
    assert_eq!(archive_disk_usage(&data.join("otel-bodies-archive")), (1, archive_bytes, 2), "volume + idx bytes; the torn tail line is not an entry");
    let h = hook_runtime_config(&data);
    assert_eq!((h.gate_mode, h.gate_enabled, h.capture_enabled, h.advisor_enabled), ("warn", true, true, false));

    let mut st = CoreState::open(&data);
    st.ports.otlp = 4318;
    let before = server_stats(&st, now_ms());
    assert_eq!(before["canonical"], true);
    assert_eq!(before["spans"]["retentionDays"], 7);
    assert_eq!(before["logEvents"]["retentionDays"], 1, "floor 1 day");
    assert_eq!(before["hookEvents"], json!({ "files": 2, "bytes": 9, "receivedSinceBoot": 0, "spooled": 2 }));
    assert_eq!(before["bodies"]["archive"], json!({ "volumes": 1, "bytes": archive_bytes, "entries": 2 }));
    assert_eq!(before["gate"]["mode"], "warn");
    assert_eq!(before["gate"]["advisorEnabled"], false);
    assert_eq!(before["spans"]["store"], json!({ "segments": 0, "totalSpans": 0, "totalBytes": 0 }));
    assert_eq!(before["persistence"]["spanAppendWrites"], 0);
    assert_eq!(before["persistence"]["totalBytesWritten"], 0);

    // One OTLP payload: the window, the store, the persistence counters and the file sizes move
    // together; a log card moves logSessions; the delta-log sizes are read from disk.
    ingest_post(&mut st, "/v1/traces", trace_payload("s1").as_bytes());
    st.put_log_session(json!({ "sessionId": "log-1" }));
    st.persist.offsets_writes = 3;
    st.persist.offsets_bytes = 40;
    std::fs::write(data.join("log-offsets.delta.ndjson"), "x".repeat(40)).unwrap();
    let after = server_stats(&st, now_ms() + 2_400);
    assert_eq!(after["spans"]["inMemory"], 1);
    assert_eq!(after["spans"]["pendingAppends"], 0);
    assert_eq!(after["spans"]["store"]["segments"], 1);
    assert_eq!(after["spans"]["store"]["totalSpans"], 1);
    let total_bytes = after["spans"]["store"]["totalBytes"].as_u64().unwrap();
    assert!(total_bytes > 0);
    assert_eq!(after["persistence"]["spanAppendWrites"], 1);
    assert_eq!(after["persistence"]["spanAppendBytes"], total_bytes);
    assert_eq!(after["persistence"]["totalBytesWritten"], total_bytes + 40);
    assert_eq!(after["persistence"]["files"], json!({ "spans": total_bytes, "offsets": 40, "cards": 0 }));
    assert_eq!(after["logSessions"], 1);
    assert!(after["uptimeSec"].as_u64().unwrap() >= 2, "Math.round of ≥2.4s");
}

/// `otlpDroppedLogEvents` is the ingest's OWN rejection tally reaching the wire — not a constant.
/// The idle `{}` in the shape test above is true for a fresh state and therefore gates nothing:
/// it passes just as happily against a hard-coded empty map, which is exactly what this field
/// used to be. So drop real events and assert the counts, the per-name split, and the insertion
/// ORDER (the TS is `Object.fromEntries(Map)`, which is insertion-ordered — a HashMap here would
/// scramble it and no other assertion would notice).
#[test]
fn dropped_log_event_counts_reach_the_wire_per_name_and_in_order() {
    let data = tmp("dropped");
    let mut st = CoreState::open(&data);
    assert_eq!(server_stats(&st, now_ms())["otlpDroppedLogEvents"], json!({}), "nothing ingested yet");

    // Neither name is a codex event, a claude tool result, or a claude rich event, so both take
    // the `note_dropped` branch. `zebra` twice, `alpha` once — different counts AND a first-seen
    // order that is the reverse of alphabetical.
    let dropped = |event: &str| {
        json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [{
            "timeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
            "attributes": [{ "key": "event.name", "value": { "stringValue": event } }]
        }] }] }] })
        .to_string()
    };
    ingest_post(&mut st, "/v1/logs", dropped("zebra.unknown").as_bytes());
    ingest_post(&mut st, "/v1/logs", dropped("alpha.unknown").as_bytes());
    ingest_post(&mut st, "/v1/logs", dropped("zebra.unknown").as_bytes());

    let body = server_stats(&st, now_ms());
    assert_eq!(body["otlpDroppedLogEvents"], json!({ "zebra.unknown": 2, "alpha.unknown": 1 }));
    assert_eq!(keys(&body["otlpDroppedLogEvents"]), ["zebra.unknown", "alpha.unknown"], "first-seen order, not sorted");
}
