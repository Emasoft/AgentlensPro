//! src/serverRuntime.ts §3 — the request log (TRDD-DMWOBWFH, freeze row 26): a fixed-size ring
//! of recent requests + one line per request appended to `<data-dir>/requests.log` (rotating,
//! one `.1` backup). Deliberately tiny — metadata lines, never bodies — so the post-mortem tool
//! can never itself become the leak it exists to diagnose. `rssMb` is recorded because heap
//! alone missed two real kills (TRDD-34B9JAZK: an external SIGKILL acts on RSS; ~67% of the TS
//! process's footprint was off-heap). Here there is no V8 at all, so `heapUsedMb` is the same
//! honest 0 the stats endpoint reports and `rssMb` carries the whole story.

use std::path::PathBuf;

use serde_json::{json, Value};

const RING_SIZE: usize = 500;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub struct RequestLog {
    file_path: Option<PathBuf>,
    ring: Vec<Value>,
    head: usize,
    filled: bool,
}

impl RequestLog {
    pub fn new(file_path: Option<PathBuf>) -> RequestLog {
        RequestLog { file_path, ring: Vec::with_capacity(RING_SIZE), head: 0, filled: false }
    }

    /// One completed request. `path` is query-stripped by the caller; bytes = response body.
    pub fn record(&mut self, method: &str, path: &str, status: u16, duration_ms: i64, bytes: u64, now_ms: i64) {
        let rss_mb = crate::server_stats::rss_bytes() as f64 / 1_048_576.0;
        let e = json!({
            "ts": crate::summarize::helpers::iso_from_ms(now_ms as f64),
            "method": method,
            "path": path,
            "status": status,
            "durationMs": duration_ms,
            "bytes": bytes,
            "heapUsedMb": 0, // no V8 heap — never a number that looks like one
            "rssMb": crate::summarize::helpers::num(rss_mb),
        });
        if let Some(f) = &self.file_path {
            let line = format!("{} {method} {status} {duration_ms}ms {bytes}b heap=0MB rss={:.0}MB {path}\n", e["ts"].as_str().unwrap_or(""), rss_mb);
            // Rotate BEFORE the write when at/over the cap, so the active file stays bounded;
            // one backup generation is enough for post-mortem attribution.
            let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
            if size + line.len() as u64 > MAX_FILE_BYTES {
                let _ = std::fs::rename(f, f.with_extension("log.1"));
            }
            if let Some(parent) = f.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::OpenOptions::new().append(true).create(true).open(f).and_then(|mut fh| {
                use std::io::Write;
                fh.write_all(line.as_bytes())
            });
        }
        // Ring insert (overwrite oldest) — O(1), bounded.
        if self.ring.len() < RING_SIZE {
            self.ring.push(e);
            self.head = self.ring.len() % RING_SIZE;
            if self.head == 0 {
                self.filled = true;
            }
        } else {
            self.ring[self.head] = e;
            self.head = (self.head + 1) % RING_SIZE;
            if self.head == 0 {
                self.filled = true;
            }
        }
    }

    /// Recent entries, oldest-first, capped.
    pub fn recent(&self, limit: usize) -> Vec<Value> {
        let all: Vec<Value> = if self.filled {
            self.ring[self.head..].iter().chain(self.ring[..self.head].iter()).cloned().collect()
        } else {
            self.ring.clone()
        };
        if limit >= all.len() {
            all
        } else {
            all[all.len() - limit..].to_vec()
        }
    }
}
