//! allogscan — parse Claude transcript .jsonl files into session cards (TRDD-DMWOBWFH P2).
//!
//!   allogscan [--max-entries N] [--max-bytes N] <file.jsonl>...
//!   allogscan --dir <projectsRoot> [--max-entries N] [--max-bytes N]
//!
//! Output: NDJSON — one ParsedTranscript JSON object per successfully parsed file, in no
//! guaranteed order (rayon). A file that cannot be read or yields no timestamps is skipped
//! silently, exactly like the TS boot scan (it returns null per file, never fails the sweep).
//! Final stderr line: `files=N parsed=M elapsed_ms=T threads=K` (stderr so stdout stays pure).

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use rayon::prelude::*;

fn usage(msg: &str) -> ! {
    eprintln!("allogscan: {msg}");
    eprintln!("usage: allogscan [--max-entries N] [--max-bytes N] (<file.jsonl>... | --dir ROOT)");
    std::process::exit(64); // EX_USAGE — same fail-fast contract as the TS CLI (TRDD-PIB6T4RU)
}

fn collect_jsonl(root: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_jsonl(&p, out);
        } else if p.extension().is_some_and(|e| e == "jsonl") {
            out.push(p);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut files: Vec<PathBuf> = Vec::new();
    let mut max_entries = agentlens_logscan::DEFAULT_TIMELINE_MAX_ENTRIES;
    let mut max_bytes = agentlens_logscan::DEFAULT_TIMELINE_MAX_BYTES;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                let root = args.get(i).unwrap_or_else(|| usage("--dir needs a path"));
                collect_jsonl(&PathBuf::from(root), &mut files);
            }
            "--max-entries" => {
                i += 1;
                max_entries = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage("--max-entries needs a number"));
            }
            "--max-bytes" => {
                i += 1;
                max_bytes = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage("--max-bytes needs a number"));
            }
            f if f.starts_with('-') => usage(&format!("unknown flag {f}")),
            f => files.push(PathBuf::from(f)),
        }
        i += 1;
    }
    if files.is_empty() {
        usage("no input files");
    }

    let t0 = Instant::now();
    let results: Vec<String> = files
        .par_iter()
        .filter_map(|p| {
            let path = p.to_str()?;
            let parsed = agentlens_logscan::parse_transcript(path, max_entries, max_bytes).ok()??;
            serde_json::to_string(&parsed).ok()
        })
        .collect();

    let stdout = std::io::stdout();
    let mut lock = std::io::BufWriter::new(stdout.lock());
    for line in &results {
        let _ = writeln!(lock, "{line}");
    }
    let _ = lock.flush();
    eprintln!(
        "files={} parsed={} elapsed_ms={} threads={}",
        files.len(),
        results.len(),
        t0.elapsed().as_millis(),
        rayon::current_num_threads(),
    );
}
