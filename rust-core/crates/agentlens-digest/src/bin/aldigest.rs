//! aldigest — spool NDJSON → typed native DuckDB tables (TRDD-LHCHVK9Z, TRDD-VXD881R6).
//!
//!   aldigest describe --manifest M            print every producer, its table and columns
//!   aldigest rehash --manifest M              rewrite the manifest's sha256 fields from the schema files
//!   aldigest register --db DB --manifest M    install the catalog, tables and digest macros
//!   aldigest collect --db DB --ingest-dir DIR load ready/<spool>/*.ndjson exactly once
//!
//! Writing the spool is `alspool` (crate agentlens-spool), which does not link DuckDB.
//! Any error exits non-zero. Test-only crash points (cargo feature `crashpoints`, off by
//! default): with ALDIGEST_CRASH_AT=after_insert|after_commit the process writes the file named
//! by ALDIGEST_CRASH_MARKER at that point of `collect` and then parks until it is killed.

use agentlens_digest::{collect, open, register, schema, Res};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::exit;

fn usage(msg: &str) -> ! {
    eprintln!("aldigest: {msg}");
    eprintln!("usage: aldigest describe --manifest M | rehash --manifest M | register --db DB --manifest M | collect --db DB --ingest-dir DIR");
    exit(64);
}

/// `--name value` pairs; exactly the flags in `allowed`, each given once.
fn flags(args: &[String], allowed: &[&str]) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let mut it = args.iter();
    while let Some(name) = it.next() {
        let key = name.strip_prefix("--").filter(|k| allowed.contains(k)).unwrap_or_else(|| usage(&format!("unexpected argument {name}")));
        let value = it.next().unwrap_or_else(|| usage(&format!("{name} needs a value")));
        if out.insert(key.to_owned(), PathBuf::from(value)).is_some() {
            usage(&format!("{name} given twice"));
        }
    }
    for a in allowed {
        if !out.contains_key(*a) {
            usage(&format!("--{a} is required"));
        }
    }
    out
}

#[cfg(feature = "crashpoints")]
fn crash_hook(stage: collect::Stage) {
    let at = match stage {
        collect::Stage::AfterInsert => "after_insert",
        collect::Stage::AfterCommit => "after_commit",
    };
    if std::env::var("ALDIGEST_CRASH_AT").as_deref() == Ok(at) {
        let marker = std::env::var("ALDIGEST_CRASH_MARKER").expect("ALDIGEST_CRASH_MARKER must name the marker file");
        std::fs::write(marker, at).expect("write crash marker");
        loop {
            std::thread::park();
        }
    }
}

fn run(args: &[String]) -> Res<()> {
    let Some(cmd) = args.first() else { usage("command required") };
    let rest = &args[1..];
    match cmd.as_str() {
        "describe" => {
            let f = flags(rest, &["manifest"]);
            for p in schema::load_manifest(&f["manifest"])? {
                println!("{}", p.describe());
            }
        }
        "rehash" => {
            let f = flags(rest, &["manifest"]);
            let changed = schema::rehash_manifest(&f["manifest"])?;
            println!("rehashed {changed} producer(s)");
        }
        "register" => {
            let f = flags(rest, &["db", "manifest"]);
            let producers = schema::load_manifest(&f["manifest"])?;
            let conn = open(&f["db"])?;
            let installed = register::register(&conn, &producers)?;
            println!("registered {installed} new producer(s) of {}", producers.len());
        }
        "collect" => {
            let f = flags(rest, &["db", "ingest-dir"]);
            let conn = open(&f["db"])?;
            #[cfg(feature = "crashpoints")]
            let s = collect::collect_with(&conn, &f["ingest-dir"], &mut crash_hook)?;
            #[cfg(not(feature = "crashpoints"))]
            let s = collect::collect(&conn, &f["ingest-dir"])?;
            println!("loaded files={} rows={} failed={} reconciled={}", s.files_loaded, s.rows, s.files_failed, s.files_reconciled);
        }
        other => usage(&format!("unknown command {other}")),
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = run(&args) {
        eprintln!("aldigest: {e}");
        exit(1);
    }
}
