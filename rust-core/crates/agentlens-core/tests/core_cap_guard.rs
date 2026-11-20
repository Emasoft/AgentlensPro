//! Executable guard for the core cap (TRDD-YH822LDI). It fails when a literal thread count is put
//! back into a DuckDB connection or a thread pool, when the core count of the machine sizes a pool,
//! or when a runtime or an open_store call ignores the cap. The regression then shows up in cargo
//! test instead of in a boot-time measurement nobody repeats.
//!
//! It reads the sources of agentlens-core and agentlens-store, skips every `bin/` folder except
//! `bin/alcore.rs` (the other binaries are CLIs, not part of the alcore process), and skips comment
//! lines. Limit: it cannot detect a DuckDB connection opened with NO threads setting, which defaults
//! to every core. The one-off audit in docs_dev/20261022-core-cap-report.md covered that case.

use std::fs;
use std::path::{Path, PathBuf};

/// The two crates whose code runs inside the alcore process.
fn source_roots() -> Vec<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    vec![manifest.join("src"), manifest.join("../agentlens-store/src")]
}

/// The binary of the alcore process itself: the one file under a `bin/` folder that the guard reads.
fn alcore_binary() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/bin/alcore.rs")
}

/// Appends every `.rs` file under `dir`, recursing, and skips any directory named `bin`.
fn collect_rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("directory entry").path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "bin") {
                continue;
            }
            collect_rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// Every source file the guard reads, sorted: the crate sources without their bin folders, plus alcore.
fn scanned_files() -> Vec<PathBuf> {
    let mut files = vec![alcore_binary()];
    for root in source_roots() {
        collect_rust_files(&root, &mut files);
    }
    files.sort();
    files
}

/// Every non-comment line of the scanned sources that `flag` accepts, as `file:line: text`.
fn flagged_lines(flag: impl Fn(&Path, &str) -> bool) -> Vec<String> {
    let mut hits = Vec::new();
    for file in scanned_files() {
        let text = fs::read_to_string(&file).unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        for (index, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            if flag(&file, line) {
                hits.push(format!("{}:{}: {}", file.display(), index + 1, line.trim()));
            }
        }
    }
    hits
}

/// Every `open_store(` call whose last argument is a literal integer, as `file:line: text`. The
/// argument list is read up to its closing parenthesis, so a call split across lines is caught too.
/// Comment lines are blanked first. A string literal with an unbalanced parenthesis would confuse
/// the reader; no such literal exists in these sources.
fn flagged_open_store_calls() -> Vec<String> {
    open_store_calls()
        .into_iter()
        .filter(|(_, _, _, args)| args.last().is_some_and(|last| last.bytes().all(|b| b.is_ascii_digit())))
        .map(|(file, line_no, line, _)| format!("{}:{line_no}: {line}", file.display()))
        .collect()
}

/// Every `open_store(` call in the scanned sources, as `(file, line number, trimmed line, arguments)`.
/// The arguments come from `call_arguments`, trimmed, with empty pieces dropped.
fn open_store_calls() -> Vec<(PathBuf, usize, String, Vec<String>)> {
    let mut calls = Vec::new();
    for file in scanned_files() {
        let text = fs::read_to_string(&file).unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        let blanked: Vec<&str> = text
            .lines()
            .map(|line| if line.trim_start().starts_with("//") { "" } else { line })
            .collect();
        let code = blanked.join("\n");
        for (at, call) in code.match_indices("open_store(") {
            let preceded_by_ident = code[..at]
                .chars()
                .next_back()
                .is_some_and(|p| p.is_alphanumeric() || "_".contains(p));
            if preceded_by_ident {
                continue;
            }
            let args: Vec<String> = call_arguments(&code[at + call.len()..])
                .into_iter()
                .map(|arg| arg.trim().to_owned())
                .filter(|arg| !arg.is_empty())
                .collect();
            let line_no = code[..at].matches("\n").count() + 1;
            let line = code.lines().nth(line_no - 1).unwrap_or("").trim().to_owned();
            calls.push((file.clone(), line_no, line, args));
        }
    }
    calls
}

/// The arguments of a call whose opening parenthesis comes just before `rest`: the top-level pieces
/// between commas, up to the matching closing parenthesis.
fn call_arguments(rest: &str) -> Vec<&str> {
    let mut args = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (at, c) in rest.char_indices() {
        if ")]}".contains(c) && depth == 0 {
            args.push(&rest[start..at]);
            return args;
        }
        if "([{".contains(c) {
            depth += 1;
        } else if ")]}".contains(c) {
            depth -= 1;
        } else if ",".contains(c) && depth == 0 {
            args.push(&rest[start..at]);
            start = at + c.len_utf8();
        }
    }
    args.push(&rest[start..]);
    args
}

/// True when `path` ends with one of the allowlisted suffixes, such as `agentlens-core/src/ui.rs`.
fn allowlisted(path: &Path, suffixes: &[&str]) -> bool {
    suffixes.iter().any(|suffix| path.ends_with(suffix))
}

/// The value after a DuckDB thread setting name: an optional `=` or `TO`, then the value.
/// The caller passes lowercase text, so `TO` and `to` match alike.
fn value_after_setting(rest: &str) -> &str {
    let rest = rest.trim_start();
    let rest = rest
        .strip_prefix("=")
        .or_else(|| rest.strip_prefix("to").filter(|after| after.starts_with(char::is_whitespace)))
        .unwrap_or(rest);
    rest.trim_start()
}

/// A DuckDB thread setting with a literal digit, in any letter case: `SET threads = 2`,
/// `SET threads=1`, `SET THREADS TO 4` or `PRAGMA threads=2`. A formatted value such as
/// `SET threads = {}` is not a literal and is not flagged.
fn sets_literal_threads(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let set_or_pragma = ["set threads", "pragma threads"].iter().any(|&keyword| {
        lower.match_indices(keyword).any(|(at, _)| {
            value_after_setting(&lower[at + keyword.len()..]).starts_with(|c: char| c.is_ascii_digit())
        })
    });
    set_or_pragma || config_literal_threads(&lower)
}

/// The DuckDB config form of the same literal, `.with("threads", "2")`, in any letter case.
fn config_literal_threads(lower: &str) -> bool {
    lower.match_indices("\"threads\"").any(|(at, key)| {
        lower[at + key.len()..]
            .trim_start()
            .strip_prefix(",")
            .map(str::trim_start)
            .and_then(|rest| rest.strip_prefix("\""))
            .is_some_and(|value| value.starts_with(|c: char| c.is_ascii_digit()))
    })
}

/// A `num_threads(` or `worker_threads(` call given a literal digit (spaces allowed), or any
/// `Runtime::new()`. A pool or runtime built that way ignores the core cap.
fn sizes_pool_literally(line: &str) -> bool {
    ["num_threads(", "worker_threads("].iter().any(|&call| {
        line.match_indices(call)
            .any(|(at, _)| line[at + call.len()..].trim_start().starts_with(|c: char| c.is_ascii_digit()))
    }) || line.contains("Runtime::new()")
}

/// No DuckDB thread setting in the crates alcore is built from takes a literal digit, except the allowlisted sites.
#[test]
fn no_literal_duckdb_threads_outside_the_allowlist() {
    // transcript_sql.rs holds `SET threads = 1` on purpose: it is a memory bound, and 1 is at or
    // under any cap of 1 or more (TRDD-YH822LDI). Any other literal bypasses the core cap.
    let allowlist = ["agentlens-store/src/transcript_sql.rs"];
    // One test-only line of agentlens-store/src/lib.rs is allowed by its exact text, not by its file:
    // seeding_many_rows_per_body_stays_within_a_tiny_spill_cap (TRDD-R36S0PS9) needs a bare connection
    // at 64MB and 1 thread for its pass margin, and 1 is at or under any cap. Allowing the whole file
    // would let a production literal in lib.rs through (TRDD-HSPUF5XH).
    let allowed_lines = [(
        "agentlens-store/src/lib.rs",
        "\"SET threads=1; SET memory_limit='64MB'; SET max_temp_directory_size='32MB'; SET temp_directory={};",
    )];
    let hits = flagged_lines(|path, line| {
        !allowlisted(path, &allowlist)
            && !allowed_lines.iter().any(|(file, text)| path.ends_with(file) && line.trim() == *text)
            && sets_literal_threads(line)
    });
    assert!(
        hits.is_empty(),
        "a DuckDB thread setting takes a literal digit; use crate::cores::duckdb_threads() instead:\n{}",
        hits.join("\n")
    );
}

/// The scanner reads the store sources: the allowlisted literal is visible to it, so the test above is not vacuous.
#[test]
fn scanner_sees_the_allowlisted_literal() {
    let hits = flagged_lines(|_, line| sets_literal_threads(line));
    assert!(
        hits.iter().any(|hit| hit.contains("transcript_sql.rs")),
        "no SET threads literal found in transcript_sql.rs; the guard would be vacuous:\n{}",
        hits.join("\n")
    );
}

/// No pool or runtime takes a literal thread count, and no bare `Runtime::new()` is built.
#[test]
fn no_literal_pool_sizes_or_bare_runtimes() {
    let hits = flagged_lines(|_, line| sizes_pool_literally(line));
    assert!(
        hits.is_empty(),
        "a pool or runtime is sized by a literal or built with Runtime::new(); size it from crate::cores::max_cores() instead:\n{}",
        hits.join("\n")
    );
}

/// `open_store` never takes a literal integer as its thread count, even when the call is split across lines.
#[test]
fn no_literal_open_store_threads() {
    let hits = flagged_open_store_calls();
    assert!(
        hits.is_empty(),
        "open_store takes a literal thread count; pass crate::cores::duckdb_threads() instead:\n{}",
        hits.join("\n")
    );
}

/// `available_parallelism()` never sizes a pool: only ui.rs and server_stats.rs may call it, to report the core count.
#[test]
fn available_parallelism_is_reporting_only() {
    // Both sites report the core count of the machine to a reader; neither sizes a thread pool.
    let reporting_only = ["agentlens-core/src/ui.rs", "agentlens-core/src/server_stats.rs"];
    let hits = flagged_lines(|path, line| !allowlisted(path, &reporting_only) && line.contains("available_parallelism()"));
    assert!(
        hits.is_empty(),
        "available_parallelism() sizes a pool; size it from crate::cores::max_cores() instead:\n{}",
        hits.join("\n")
    );
}

/// The bodies pass opens its store with STORE_MEMORY_LIMIT, never SERVER_MEMORY_LIMIT: the store ART
/// indexes cannot spill, and at 512MiB the sha probe ran out of memory (TRDD-2HRA270Y).
/// Step 3 (open the store once per process) must move this guard to wherever the bodies-pass store is opened.
#[test]
fn bodies_pass_opens_its_store_with_the_store_memory_limit() {
    let calls: Vec<_> = open_store_calls()
        .into_iter()
        .filter(|(file, _, _, _)| file.ends_with("src/chores.rs"))
        .collect();
    assert!(!calls.is_empty(), "no open_store call in chores.rs; the guard would be vacuous");
    // The limit may be written qualified (agentlens_store::STORE_MEMORY_LIMIT) or as a bare name
    // under a `use` import. Either passes; SERVER_MEMORY_LIMIT, or anything not ending in
    // STORE_MEMORY_LIMIT, fails.
    let wrong: Vec<String> = calls
        .iter()
        .filter(|(_, _, _, args)| {
            let limit = args.get(1).map_or("", String::as_str);
            !limit.ends_with("STORE_MEMORY_LIMIT") || limit.contains("SERVER_MEMORY_LIMIT")
        })
        .map(|(file, line_no, line, _)| format!("{}:{line_no}: {line}", file.display()))
        .collect();
    assert!(
        wrong.is_empty(),
        "the bodies pass must open its store with the store memory limit, not SERVER_MEMORY_LIMIT (TRDD-2HRA270Y):\n{}",
        wrong.join("\n")
    );
}


/// TRDD-2HRA270Y step 3 (A10): the bodies export and purge routes read the shared store the bodies
/// pass opened, so body_archive.rs must not open a store of its own (a second ~1 GB store per
/// request is what step 3 removed).
#[test]
fn body_archive_opens_no_store() {
    let calls: Vec<String> = open_store_calls()
        .into_iter()
        .filter(|(file, _, _, _)| file.ends_with("src/body_archive.rs"))
        .map(|(file, line_no, line, _)| format!("{}:{line_no}: {line}", file.display()))
        .collect();
    assert!(calls.is_empty(), "body_archive.rs must not call open_store (TRDD-2HRA270Y):\n{}", calls.join("\n"));
}
