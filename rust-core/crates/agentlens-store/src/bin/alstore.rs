//! alstore — bodies→DuckDB pipeline CLI (TRDD-DMWOBWFH P3c).
//!
//!   alstore ingest <storeDir> <body.json>... [--ts-ms N]   ingest + flush, report JSON
//!   alstore reconstruct <storeDir> <bodyId>                print the exact original bytes
//!   alstore verify <storeDir> <src_name> <body.json> [--ts-ms N]
//!   alstore pass <storeDir> <bodiesDir> [--no-delete] [--durable-source]
//!       [--max-bytes N] [--max-age-ms N] [--relocate-to DIR]   one throttled ingest pass;
//!       skip/stranded state persists in <storeDir>/.pass-state.json across invocations
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
    let mut no_delete = false;
    let mut durable_source = false;
    let mut max_bytes: u64 = agentlens_store::pass::DEFAULT_MAX_BYTES_PER_PASS;
    // 0 = ingest regardless of age — matches PassOptions::default and the TS caller's over-cap mode.
    let mut max_age_ms: i64 = 0;
    let mut relocate_to: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--ts-ms" => {
                i += 1;
                ts_ms = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--ts-ms needs ms"));
            }
            "--no-delete" => no_delete = true,
            "--durable-source" => durable_source = true,
            "--max-bytes" => {
                i += 1;
                max_bytes = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--max-bytes needs bytes"));
            }
            "--max-age-ms" => {
                i += 1;
                max_age_ms = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--max-age-ms needs ms"));
            }
            "--relocate-to" => {
                i += 1;
                relocate_to = Some(args.get(i).cloned().unwrap_or_else(|| usage("--relocate-to needs a dir")));
            }
            f if f.starts_with('-') => usage(&format!("unknown flag {f}")),
            f => rest.push(f.to_owned()),
        }
        i += 1;
    }

    // One pass per store, machine-wide (see acquire_pass_lock) — taken BEFORE the store open so
    // a locked-out tick exits in milliseconds instead of paying the parts-scan open first.
    // Exit 75 = EX_TEMPFAIL: the TS wrapper treats it as "skip this tick", the cross-process
    // twin of its own bodiesPassRunning guard — every other failure stays loud.
    let _pass_lock = if cmd == "pass" {
        match agentlens_store::pass::acquire_pass_lock(std::path::Path::new(store_dir)) {
            Ok(f) => Some(f),
            Err(agentlens_store::pass::PassLockErr::Busy) => {
                eprintln!("alstore: another alstore pass owns this store");
                exit(75);
            }
            Err(agentlens_store::pass::PassLockErr::Io(e)) => {
                eprintln!("alstore: {e}");
                exit(1);
            }
        }
    } else {
        None
    };

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
        "pass" => {
            let Some(bodies_dir) = rest.first() else { usage("bodiesDir required") };
            // Skip/stranded state persists across invocations (the TS server holds these in
            // memory for its process lifetime; a CLI's process is one pass, so the state rides
            // a file). fsyncedParts stays per-invocation — correct either way, cheaper with.
            let state_file = std::path::Path::new(store_dir).join(".pass-state.json");
            let (mut skip, mut stranded) = load_state(&state_file);
            let mut fsynced = std::collections::HashSet::new();
            let opts = agentlens_store::pass::PassOptions {
                bodies_dir: std::path::PathBuf::from(bodies_dir),
                delete_after: !no_delete,
                durable_source,
                max_bytes_per_pass: max_bytes,
                max_age_ms,
                relocate_stranded_to: relocate_to.map(std::path::PathBuf::from),
                ..Default::default()
            };
            let res = agentlens_store::pass::ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
            save_state(&state_file, &skip, &stranded);
            println!("{}", serde_json::to_string(&res).expect("serializable"));
        }
        other => usage(&format!("unknown command {other}")),
    }
}

fn load_state(p: &std::path::Path) -> (std::collections::HashSet<String>, std::collections::HashSet<String>) {
    let Ok(raw) = std::fs::read_to_string(p) else { return (Default::default(), Default::default()) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { return (Default::default(), Default::default()) };
    let set = |k: &str| {
        v.get(k)
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    (set("skipNames"), set("strandedNames"))
}

fn save_state(p: &std::path::Path, skip: &std::collections::HashSet<String>, stranded: &std::collections::HashSet<String>) {
    let mut skip_v: Vec<&String> = skip.iter().collect();
    let mut str_v: Vec<&String> = stranded.iter().collect();
    skip_v.sort();
    str_v.sort();
    let json = serde_json::json!({ "skipNames": skip_v, "strandedNames": str_v });
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, json.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, p);
    }
}
