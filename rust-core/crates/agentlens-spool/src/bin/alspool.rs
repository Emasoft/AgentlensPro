//! alspool — the spool writer (TRDD-LHCHVK9Z). Touches only the filesystem, never a database.
//!
//!   alspool append --ingest-dir D --spool S [--seal-bytes N]
//!       one JSON object on stdin -> one line of D/inbox/S/current.ndjson; when the file then holds
//!       at least N bytes (default 4194304) the append seals it itself, under the same lock
//!   alspool seal --ingest-dir D [--spool S]    move non-empty current.ndjson files to D/ready/S/
//!
//! Any error exits non-zero with the message on stderr and writes nothing, with ONE exception:
//! exit 2 means the line WAS appended (do not retry it: that would duplicate it) but the seal
//! that was due failed; the next append tries the seal again.

use agentlens_spool::{append, seal, Appended, Res, DEFAULT_SEAL_BYTES};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::exit;

fn usage(msg: &str) -> ! {
    eprintln!("alspool: {msg}");
    eprintln!("usage: alspool append --ingest-dir D --spool S [--seal-bytes N] | seal --ingest-dir D [--spool S]");
    exit(64);
}

/// `--name value` pairs; every flag in `required` exactly once, those in `optional` at most once.
fn flags(args: &[String], required: &[&str], optional: &[&str]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut it = args.iter();
    while let Some(name) = it.next() {
        let key = name.strip_prefix("--").filter(|k| required.contains(k) || optional.contains(k)).unwrap_or_else(|| usage(&format!("unexpected argument {name}")));
        let value = it.next().unwrap_or_else(|| usage(&format!("{name} needs a value")));
        if out.insert(key.to_owned(), value.clone()).is_some() {
            usage(&format!("{name} given twice"));
        }
    }
    for r in required {
        if !out.contains_key(*r) {
            usage(&format!("--{r} is required"));
        }
    }
    out
}

fn run(args: &[String]) -> Res<()> {
    let Some(cmd) = args.first() else { usage("command required") };
    let rest = &args[1..];
    match cmd.as_str() {
        "append" => {
            let f = flags(rest, &["ingest-dir", "spool"], &["seal-bytes"]);
            let seal_bytes = match f.get("seal-bytes") {
                Some(v) => v.parse::<u64>().unwrap_or_else(|_| usage(&format!("--seal-bytes needs a number of bytes, got {v:?}"))),
                None => DEFAULT_SEAL_BYTES,
            };
            let mut stdin = Vec::new();
            std::io::stdin().lock().read_to_end(&mut stdin).map_err(|e| format!("stdin: {e}"))?;
            match append(&PathBuf::from(&f["ingest-dir"]), &f["spool"], &stdin, seal_bytes)? {
                Appended::Written | Appended::Sealed(_) => Ok(()),
                Appended::SealFailed(why) => {
                    eprintln!("alspool: the line was appended (do not retry it) but sealing the full file failed: {why}");
                    exit(2);
                }
            }
        }
        "seal" => {
            let f = flags(rest, &["ingest-dir"], &["spool"]);
            for path in seal(&PathBuf::from(&f["ingest-dir"]), f.get("spool").map(String::as_str))? {
                println!("{}", path.display());
            }
            Ok(())
        }
        other => usage(&format!("unknown command {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("alspool: {e}");
        exit(1);
    }
}
