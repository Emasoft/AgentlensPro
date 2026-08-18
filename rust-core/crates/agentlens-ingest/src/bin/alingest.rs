//! alingest — run the OTLP transform over a captured payload file (TRDD-DMWOBWFH P3b).
//!
//!   alingest --traces|--logs|--metrics <payload.json> [--now MS] [--path /v1/traces]
//!
//! Output: one JSON object — { spans, accountPairs?, bodyPointers?, dropped?, metrics?, points? }.
//! Pure transform, no store: the parity tests diff this against the TS collector's addSpan calls.

use std::process::exit;

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
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
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
    let body = std::fs::read_to_string(&file).unwrap_or_else(|e| usage(&format!("cannot read {file}: {e}")));
    let payload: serde_json::Value = serde_json::from_str(&body).unwrap_or_else(|e| usage(&format!("bad JSON: {e}")));

    let mut state = agentlens_ingest::IngestState::default();
    let out = match mode {
        "traces" => serde_json::json!({ "spans": state.process_traces(&payload, &collector_path) }),
        "logs" => {
            let r = state.process_logs(&payload, now_ms, |_, _, _| false);
            serde_json::json!({
                "spans": r.spans,
                "accountPairs": r.account_pairs,
                "bodyPointers": r.body_pointers,
                "dropped": r.dropped.iter().map(|(n, _)| n).collect::<Vec<_>>(),
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
