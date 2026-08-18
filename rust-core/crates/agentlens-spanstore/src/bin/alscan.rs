//! alscan — scan a span store for call events (TRDD-DMWOBWFH Phase 1 CLI).
//!
//!   alscan <spansDir> [--since MS] [--until MS] [--json | --parity-json]
//!
//! `--parity-json` prints one compact JSON object per api_request event (requestId, ts,
//! sessionId), sorted — the shape the parity check diffs against the TS scan's output.

use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: alscan <spansDir> [--since MS] [--until MS] [--json|--parity-json]");
        std::process::exit(64);
    };
    let (mut since, mut until, mut mode) = (0_i64, i64::MAX, "summary");
    let mut pending: Option<&str> = None;
    let mut owned: Vec<String> = Vec::new();
    for a in args {
        owned.push(a);
    }
    for a in &owned {
        match (pending.take(), a.as_str()) {
            (Some("--since"), v) => since = v.parse().unwrap_or_else(|_| usage("--since needs epoch ms")),
            (Some("--until"), v) => until = v.parse().unwrap_or_else(|_| usage("--until needs epoch ms")),
            (None, "--since") => pending = Some("--since"),
            (None, "--until") => pending = Some("--until"),
            (None, "--json") => mode = "json",
            (None, "--parity-json") => mode = "parity",
            (None, other) => usage(&format!("unknown flag {other}")),
            (Some(f), _) => usage(&format!("{f} needs a value")),
        }
    }
    if pending.is_some() {
        usage("trailing flag without value");
    }

    let t0 = Instant::now();
    let result = match agentlens_spanstore::scan_call_events(&PathBuf::from(&dir), since, until) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("alscan: cannot read span store at {dir}: {e}");
            std::process::exit(1);
        }
    };
    let elapsed = t0.elapsed();

    match mode {
        "json" => println!("{}", serde_json::to_string(&result).expect("serializable")),
        "parity" => {
            for e in &result.events {
                println!(
                    "{}",
                    serde_json::json!({ "requestId": e.request_id, "ts": e.ts, "sessionId": e.session_id })
                );
            }
        }
        _ => {
            println!(
                "segments={} candidates_parsed={} api_requests={} compactions={} elapsed_ms={} threads={}",
                result.segments_visited,
                result.spans_scanned,
                result.events.len(),
                result.compactions.len(),
                elapsed.as_millis(),
                rayon::current_num_threads(),
            );
        }
    }
}

fn usage(msg: &str) -> ! {
    eprintln!("alscan: {msg}");
    std::process::exit(64); // EX_USAGE — same fail-fast contract as the TS CLI (TRDD-PIB6T4RU)
}
