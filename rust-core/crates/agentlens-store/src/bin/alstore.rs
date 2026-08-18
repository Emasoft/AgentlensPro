//! alstore — bodies→DuckDB pipeline CLI (TRDD-DMWOBWFH P3c).
//!
//!   alstore ingest <storeDir> <body.json>... [--ts-ms N]   ingest + flush, report JSON
//!   alstore reconstruct <storeDir> <bodyId>                print the exact original bytes
//!   alstore verify <storeDir> <src_name> <body.json> [--ts-ms N]
//!
//! The parity tests drive these against the TS store on the same files/directories: the
//! Parquet parts are the compatibility boundary (both engines are DuckDB).

use std::process::exit;

fn usage(msg: &str) -> ! {
    eprintln!("alstore: {msg}");
    eprintln!("usage: alstore ingest|reconstruct|verify <storeDir> ... [--ts-ms N]");
    exit(64);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first() else { usage("command required") };
    let Some(store_dir) = args.get(1) else { usage("storeDir required") };
    let mut ts_ms: i64 = 0;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--ts-ms" => {
                i += 1;
                ts_ms = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--ts-ms needs ms"));
            }
            f if f.starts_with('-') => usage(&format!("unknown flag {f}")),
            f => rest.push(f.to_owned()),
        }
        i += 1;
    }

    let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(4)).unwrap_or(4);
    let mut store = agentlens_store::open_store(std::path::Path::new(store_dir), agentlens_store::DEFAULT_MEMORY_LIMIT, threads)
        .unwrap_or_else(|e| {
            eprintln!("alstore: cannot open store: {e}");
            exit(1);
        });

    match cmd.as_str() {
        "ingest" => {
            let mut reports = Vec::new();
            for f in &rest {
                let raw = std::fs::read_to_string(f).unwrap_or_else(|e| usage(&format!("cannot read {f}: {e}")));
                let name = std::path::Path::new(f).file_name().and_then(|s| s.to_str()).unwrap_or(f).to_owned();
                let ts = if ts_ms > 0 {
                    ts_ms
                } else {
                    std::fs::metadata(f)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0)
                };
                match agentlens_store::ingest_body(&mut store, &name, &raw, ts) {
                    Ok(r) => reports.push(serde_json::json!({
                        "srcName": name, "bodyId": r.body_id, "rawBytes": r.raw_bytes,
                        "newBlobs": r.new_blobs, "newBytes": r.new_bytes, "existed": r.existed,
                    })),
                    Err(e) => reports.push(serde_json::json!({ "srcName": name, "error": e })),
                }
            }
            let flushed = agentlens_store::flush_detailed(&mut store).unwrap_or_else(|e| {
                eprintln!("alstore: flush failed: {e}");
                exit(1);
            });
            println!(
                "{}",
                serde_json::json!({
                    "ingested": reports,
                    "flushedBlobs": flushed.n,
                    "partPaths": flushed.part_paths.iter().filter_map(|p| p.to_str()).collect::<Vec<_>>(),
                })
            );
        }
        "reconstruct" => {
            let Some(body_id) = rest.first() else { usage("bodyId required") };
            match agentlens_store::reconstruct_body(&store, body_id) {
                Ok(raw) => print!("{raw}"),
                Err(e) => {
                    eprintln!("alstore: {e}");
                    exit(2);
                }
            }
        }
        "verify" => {
            let (Some(src_name), Some(file)) = (rest.first(), rest.get(1)) else { usage("src_name and body file required") };
            let raw = std::fs::read_to_string(file).unwrap_or_else(|e| usage(&format!("cannot read {file}: {e}")));
            let items = [agentlens_store::VerifyItem {
                src_name: src_name.clone(),
                raw,
                ts_ms: if ts_ms > 0 { Some(ts_ms) } else { None },
            }];
            match agentlens_store::verify_bodies_in_store(&store, &items) {
                Ok(map) => {
                    let v = map.get(src_name).expect("result present");
                    println!("{}", serde_json::json!({ "ok": v.ok, "reason": v.reason }));
                    if !v.ok {
                        exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("alstore: {e}");
                    exit(2);
                }
            }
        }
        other => usage(&format!("unknown command {other}")),
    }
}
