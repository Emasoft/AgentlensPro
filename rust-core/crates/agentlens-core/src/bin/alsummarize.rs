//! alsummarize — the P4d end-to-end harness surface (TRDD-DMWOBWFH): a spans JSON array in
//! (file argument, or stdin when no argument), the full summarizeSpans result out as one JSON
//! line. The TS cross-engine test (src/test/rustSummarize.test.ts) replays real captured span
//! windows through both engines and deepStrictEqual's the results.
//!
//! The account registry callback is None — a fresh process has an empty callBodyRegistry on the
//! TS side too, so the engines stay comparable.

use std::io::Read;

fn main() {
    let text = match std::env::args().nth(1) {
        Some(path) => std::fs::read_to_string(&path).unwrap_or_else(|e| {
            eprintln!("alsummarize: read {path}: {e}");
            std::process::exit(2);
        }),
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).unwrap_or_else(|e| {
                eprintln!("alsummarize: stdin: {e}");
                std::process::exit(2);
            });
            s
        }
    };
    let spans: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_else(|e| {
        eprintln!("alsummarize: parse: {e}");
        std::process::exit(2);
    });
    let result = agentlens_core::summarize::summarizer::summarize_spans(&spans, &|_| None);
    println!("{}", serde_json::to_string(&result).expect("result serializes"));
}
