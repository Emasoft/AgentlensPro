//! alcore — the Rust server binary (TRDD-DMWOBWFH P4). P4c: OTLP listener; P4e: the UI/API
//! listener (`GET /api/summary` over the live span window).
//!
//!   alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--bind HOST] [--no-log-scan]
//!
//! Spans land in `<data-dir>/spans` (the same segmented NDJSON store both engines read).
//! P5b: on start the local session logs (Claude/Codex/Copilot/OpenCode) are discovered and
//! parsed in parallel INTO the card map before the listeners bind — the TS server does the same
//! synchronously so the first page load is never blank. `--no-log-scan` keeps the window empty
//! (socket tests, a pure-OTLP deployment).
//! Default ports are 4319/3001 — NOT 4318/3000: the TS server still owns the canonical ports
//! until the P4 cutover, and 4318 doubles as the canonicality key (server.ts IS_CANONICAL).

use std::process::exit;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// server.ts falls back to a 5s full poll when fs.watch is unavailable; until the notify-based
/// watcher lands, the Rust sweeper IS that fallback (13.5k stats per sweep ≈ tens of ms).
const LOG_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

fn usage(msg: &str) -> ! {
    eprintln!("alcore: {msg}");
    eprintln!("usage: alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--bind HOST] [--no-log-scan]");
    exit(64);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("serve") {
        usage("command required (serve)");
    }
    let mut data_dir = String::new();
    let mut port: u16 = 4319;
    let mut ui_port: u16 = 3001;
    let mut bind = "127.0.0.1".to_owned();
    let mut log_scan = true;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--no-log-scan" => log_scan = false,
            "--data-dir" => {
                i += 1;
                data_dir = args.get(i).cloned().unwrap_or_else(|| usage("--data-dir needs a path"));
            }
            "--otlp-port" => {
                i += 1;
                port = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--otlp-port needs a port"));
            }
            "--ui-port" => {
                i += 1;
                ui_port = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--ui-port needs a port"));
            }
            "--bind" => {
                i += 1;
                bind = args.get(i).cloned().unwrap_or_else(|| usage("--bind needs a host"));
            }
            f => usage(&format!("unknown arg {f}")),
        }
        i += 1;
    }
    if data_dir.is_empty() {
        usage("--data-dir is required");
    }
    let spans_dir = std::path::Path::new(&data_dir).join("spans");
    if let Err(e) = std::fs::create_dir_all(&spans_dir) {
        eprintln!("alcore: cannot create {}: {e}", spans_dir.display());
        exit(1);
    }
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(std::path::Path::new(&data_dir))));
    {
        let st = state.lock().expect("state");
        let (segments, total_spans, _) = st.writer.stats();
        println!(
            "alcore: loaded {} span(s) (last {}h window) from {} — store holds {total_spans} span(s) across {segments} segment(s), nothing evicted",
            st.window.spans.len(),
            st.window.configured_ms / 3_600_000,
            spans_dir.display()
        );
    }

    let mut sweeper: Option<agentlens_core::log_reader::SweeperHandle> = None;
    if log_scan {
        // The boot sweep is synchronous (the card map is populated before the listeners bind);
        // the same thread then re-sweeps every LOG_SWEEP_INTERVAL, touching only files whose
        // stat moved (P5d tail + offset gate).
        let env = agentlens_logscan::discovery::Env::from_process();
        match agentlens_core::log_reader::start_sweeper(state.clone(), env, std::path::PathBuf::from(&data_dir), LOG_SWEEP_INTERVAL) {
            Ok((boot, handle)) => {
                if boot.restored_cards > 0 || boot.offsets_imported > 0 {
                    println!(
                        "alcore: resumed {} log tail offsets ({} invalid/rotated → cold read); restored {} session cards",
                        boot.offsets_imported, boot.offsets_skipped, boot.restored_cards
                    );
                }
                let s = boot.sweep;
                println!(
                    "alcore: log scan files={} changed={} parsed={} cards={} elapsed_ms={} threads={}",
                    s.files,
                    s.changed,
                    s.parsed,
                    s.cards,
                    s.elapsed_ms,
                    rayon::current_num_threads()
                );
                sweeper = Some(handle);
            }
            Err(e) => {
                eprintln!("alcore: {e}");
                exit(1);
            }
        }
    }

    let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
        eprintln!("alcore: runtime: {e}");
        exit(1);
    });
    let addr: std::net::SocketAddr = format!("{bind}:{port}").parse().unwrap_or_else(|_| usage("bad bind/port"));
    let flush_state = state.clone();
    rt.spawn(async move {
        // The flush tick (server.ts flushSpanAppends, SAVE_INTERVAL_MS=5s): settle anything still
        // buffered (ingest_post already flushes per payload) and prune the summarization window
        // by time — trimming memory is not data loss, every trimmed span is on disk.
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Ok(mut st) = flush_state.lock() {
                if st.writer.pending_appends() > 0 {
                    st.writer.flush();
                }
                st.prune_window(agentlens_core::now_ms());
            }
        }
    });
    let ui_addr: std::net::SocketAddr = format!("{bind}:{ui_port}").parse().unwrap_or_else(|_| usage("bad bind/ui-port"));
    let serve = agentlens_core::serve_otlp(addr, state.clone(), |bound| {
        println!("alcore: OTLP listening on http://{bound}");
    });
    let hub = Arc::new(agentlens_core::ui::SseHub::default());
    rt.spawn(agentlens_core::ui::run_push_loop(state.clone(), hub.clone()));
    let serve_ui = agentlens_core::ui::serve_ui(ui_addr, state.clone(), hub, |bound| {
        println!("alcore: UI/API listening on http://{bound}");
    });
    rt.block_on(async move {
        tokio::select! {
            r = serve => {
                if let Err(e) = r {
                    eprintln!("alcore: OTLP listener failed: {e}");
                    exit(1);
                }
            }
            r = serve_ui => {
                if let Err(e) = r {
                    eprintln!("alcore: UI listener failed: {e}");
                    exit(1);
                }
            }
            _ = tokio::signal::ctrl_c() => {}
        }
    });
    // Flush on the way out — the writer buffers, and losing the tail on SIGINT would be a
    // silent hole the store cannot detect. The sweeper flushes the durable state (offsets +
    // cards) the same way: a graceful stop loses nothing.
    if let Some(h) = sweeper.take() {
        h.stop();
    }
    if let Ok(mut st) = state.lock() {
        st.writer.flush();
    };
}
