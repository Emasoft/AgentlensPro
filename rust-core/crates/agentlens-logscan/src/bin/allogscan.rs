//! allogscan — parse Claude transcript .jsonl files into session cards (TRDD-DMWOBWFH P2).
//!
//!   allogscan [--max-entries N] [--max-bytes N] <file.jsonl>...
//!   allogscan --dir <projectsRoot> [--max-entries N] [--max-bytes N]
//!   allogscan --files-from <list.txt>     # newline-separated paths — a 13k-file boot batch
//!                                         # exceeds ARG_MAX as argv, so the list rides a file
//!   allogscan --opencode <opencode.db>... # OpenCode SQLite (rusqlite, native WAL read; one
//!                                         # db yields MANY session lines)
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
    // Hot-age strip cutoff (epoch ms): parent cards whose last timestamp is OLDER lose their
    // timeline AT EMIT TIME — same parse-time rationale as the TS parser (TRDD-66IXMIGN), and
    // here it is also what keeps the NDJSON stream pipeable (1.2GB unstripped, tens of MB
    // stripped, measured on the 12,928-card corpus). 0 = never strip.
    let mut strip_older_than_ms: i64 = 0;
    // Parser selection: claude (default), codex, or one of the three copilot shapes.
    let mut mode = "claude";
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                i += 1;
                let root = args.get(i).unwrap_or_else(|| usage("--dir needs a path"));
                collect_jsonl(&PathBuf::from(root), &mut files);
            }
            "--files-from" => {
                i += 1;
                let list = args.get(i).unwrap_or_else(|| usage("--files-from needs a path"));
                let body = std::fs::read_to_string(list)
                    .unwrap_or_else(|e| usage(&format!("cannot read {list}: {e}")));
                for line in body.lines() {
                    if !line.is_empty() {
                        files.push(PathBuf::from(line));
                    }
                }
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
            "--codex" => mode = "codex",
            "--copilot-cli" => mode = "copilot-cli",
            "--copilot-vscode" => mode = "copilot-vscode",
            "--copilot-vscode-json" => mode = "copilot-vscode-json",
            "--opencode" => mode = "opencode",
            "--strip-older-than-ms" => {
                i += 1;
                strip_older_than_ms = args
                    .get(i)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or_else(|| usage("--strip-older-than-ms needs epoch ms"));
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

    // OpenCode: one db → MANY session lines, and no hot-age strip (the TS opencode path never
    // strips — inventing one here would break parity). Errors are LOUD (exit 1): the TS caller's
    // catch routes them to its own JSON fallback, exactly like a TS-side db error.
    if mode == "opencode" {
        let mut lines: Vec<String> = Vec::new();
        for p in &files {
            let path = p.to_string_lossy();
            match agentlens_logscan::opencode::parse_opencode_db(&path, max_entries, max_bytes) {
                Ok(r) => {
                    if r.schema_unsupported {
                        eprintln!("allogscan: opencode schema unsupported ({path}): session table lacks model/tokens columns; skipping");
                    }
                    for t in r.results {
                        if let Ok(s) = serde_json::to_string(&t) {
                            lines.push(s);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("allogscan: opencode {path}: {e}");
                    std::process::exit(1);
                }
            }
        }
        let stdout = std::io::stdout();
        let mut lock = std::io::BufWriter::new(stdout.lock());
        for line in &lines {
            let _ = writeln!(lock, "{line}");
        }
        let _ = lock.flush();
        eprintln!("files={} parsed={} elapsed_ms={} threads=1", files.len(), lines.len(), t0.elapsed().as_millis());
        return;
    }
    let results: Vec<String> = files
        .par_iter()
        .filter_map(|p| {
            let path = p.to_str()?;
            let mut parsed = match mode {
                "codex" => agentlens_logscan::codex::parse_codex_transcript(path).ok()??,
                "copilot-cli" => agentlens_logscan::copilot::parse_copilot_cli(path).ok()??,
                "copilot-vscode" => agentlens_logscan::copilot::parse_copilot_vscode(path).ok()??,
                "copilot-vscode-json" => agentlens_logscan::copilot::parse_copilot_vscode_json(path).ok()??,
                _ => agentlens_logscan::parse_transcript(path, max_entries, max_bytes).ok()??,
            };
            // PARENT card only — TS strips only the parent in _parseClaudeFile; child cards
            // carry at most one tiny entry and keep it.
            if strip_older_than_ms > 0 && parsed.last_timestamp_ms < strip_older_than_ms {
                parsed.card.strip_timeline();
            }
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
