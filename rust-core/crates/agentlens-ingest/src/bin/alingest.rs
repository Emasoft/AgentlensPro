//! alingest — run the OTLP transform over a captured payload file (TRDD-DMWOBWFH P3b).
//!
//!   alingest --traces|--logs|--metrics <payload.json> [--now MS] [--path /v1/traces] [--bench]
//!
//! Output: one JSON object — { spans, accountPairs?, bodyPointers?, dropped?, metrics?, points? }.
//! Pure transform, no store: the parity tests diff this against the TS collector's addSpan calls.
//!
//! `--bench` exists because that default output makes the transform UNMEASURABLE. Serializing the
//! result costs more than producing it — on a 200k-span, 81.3 MB payload the JSON written back to
//! stdout is 96.6 MB, larger than the input — and the in-process path this CLI stands in for
//! (alcore links `agentlens_ingest` directly; nothing execs this binary in production) never pays
//! it. Timing the default output therefore measures the harness: it made Rust look 3.6× SLOWER
//! than the TS collector, a number about `serde_json::to_string`, not about the transform.
//! `--bench` runs the identical transform and prints only per-phase timings and counts.

use std::process::exit;

/// EXPERIMENT (TRDD-DMWOBWFH D2): after the by-value fix the transform's profile is dominated by
/// the ALLOCATOR — `_xzm_free`/`malloc`/`free` ≈ 87 samples against 27 for hashing — because the
/// output side allocates ~9 times per span (7 String map keys, a Map, a Vec) and Rust's `String`
/// has no small-string optimization, so `"traceId".into()` heap-allocates 7 bytes every time.
/// V8 bump-allocates the equivalent object in a nursery with a hidden class for the fixed shape,
/// which is the structural reason the TS collector wins this workload.
///
/// Wired into the BINARY only, never the library: a global allocator is a process-wide decision
/// and a library that imposes one on its dependents is antisocial. If this proves out, the same
/// three lines belong in `alcore`'s main, not here.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn usage(msg: &str) -> ! {
    eprintln!("alingest: {msg}");
    eprintln!("usage: alingest --traces|--logs|--metrics <payload.json> [--now MS] [--path P]");
    exit(64);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut mode = "";
    let mut file = String::new();
    let mut now_ms: i64 = 0;
    let mut collector_path = "/v1/traces".to_owned();
    let mut bench = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--bench" => bench = true,
            "--traces" => mode = "traces",
            "--logs" => mode = "logs",
            "--metrics" => mode = "metrics",
            "--now" => {
                i += 1;
                now_ms = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--now needs ms"));
            }
            "--path" => {
                i += 1;
                collector_path = args.get(i).cloned().unwrap_or_else(|| usage("--path needs a value"));
            }
            f if f.starts_with('-') => usage(&format!("unknown flag {f}")),
            f => file = f.to_owned(),
        }
        i += 1;
    }
    if mode.is_empty() || file.is_empty() {
        usage("mode and payload file required");
    }
    let t0 = std::time::Instant::now();
    let body = std::fs::read_to_string(&file).unwrap_or_else(|e| usage(&format!("cannot read {file}: {e}")));
    let read_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = std::time::Instant::now();
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|e| usage(&format!("bad JSON: {e}")));
    let parse_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let mut state = agentlens_ingest::IngestState::default();
    // Phases are reported SEPARATELY rather than as one total, because they are not equally
    // portable: read+parse is real work the in-process server also does on every OTLP POST, but
    // it is dominated by input SIZE, while the transform is dominated by span COUNT. A single
    // number hides which one a future regression landed in.
    if bench {
        let t2 = std::time::Instant::now();
        let n = match mode {
            "traces" => state.process_traces(payload, &collector_path).len(),
            "logs" => state.process_logs(&payload, now_ms, |_, _, _| false).spans.len(),
            // `process_metrics` already returns its point count as a u64 rather than a Vec.
            _ => agentlens_ingest::process_metrics(&payload).1 as usize,
        };
        let transform_ms = t2.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{}",
            serde_json::json!({
                "mode": mode,
                "inputBytes": body.len(),
                "emitted": n,
                "readMs": read_ms,
                "parseMs": parse_ms,
                "transformMs": transform_ms,
                "totalMs": read_ms + parse_ms + transform_ms,
            })
        );
        return;
    }
    let out = match mode {
        "traces" => serde_json::json!({ "spans": state.process_traces(payload, &collector_path) }),
        "logs" => {
            let r = state.process_logs(&payload, now_ms, |_, _, _| false);
            serde_json::json!({
                "spans": r.spans,
                "accountPairs": r.account_pairs,
                "bodyPointers": r.body_pointers,
                // The event NAMES only — the drop side channel now carries the full sink record,
                // but this debug surface has always reported names and nothing reads more.
                "dropped": r.dropped.iter().filter_map(|rec| rec.get("name")).collect::<Vec<_>>(),
                "count": r.count,
            })
        }
        _ => {
            let (metrics, points, pairs) = agentlens_ingest::process_metrics(&payload);
            serde_json::json!({ "metrics": metrics, "points": points, "accountPairs": pairs })
        }
    };
    println!("{}", serde_json::to_string(&out).expect("serializable"));
}
