//! alspool — the spool writer (TRDD-LHCHVK9Z). Touches only the filesystem, never a database.
//!
//!   alspool append --ingest-dir D --spool S    one JSON object on stdin -> one line of D/inbox/S/current.ndjson
//!   alspool seal --ingest-dir D [--spool S]    move non-empty current.ndjson files to D/ready/S/
//!
//! Any error exits non-zero with the message on stderr and writes nothing.

use agentlens_spool::{append, seal, Res};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::exit;

fn usage(msg: &str) -> ! {
    eprintln!("alspool: {msg}");
    eprintln!("usage: alspool append --ingest-dir D --spool S | seal --ingest-dir D [--spool S]");
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
            let f = flags(rest, &["ingest-dir", "spool"], &[]);
            let mut stdin = Vec::new();
            std::io::stdin().lock().read_to_end(&mut stdin).map_err(|e| format!("stdin: {e}"))?;
            append(&PathBuf::from(&f["ingest-dir"]), &f["spool"], &stdin)
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
