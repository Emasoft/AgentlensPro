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

/// server.ts falls back to a 5s full poll when fs.watch attaches to NO log dir; with watchers
/// the steady state is the targeted sweep + the 60s backstop (log_reader::FULL_RESCAN).
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
        let mut st = state.lock().expect("state");
        // What /api/server-stats reports as `ports` — the listeners this process binds (mcp stays
        // the configured TS default: no MCP listener in the core yet).
        st.ports.ui = ui_port;
        st.ports.otlp = port;
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
                // server.ts startLogIngestion's two warnings: roots without a watcher refresh only
                // on the backstop; no watcher at all ⇒ the fast full poll (higher CPU).
                if boot.watch_failed > 0 {
                    eprintln!(
                        "alcore: no watcher on {} log dir(s) — they refresh only on the {}s backstop sweep",
                        boot.watch_failed,
                        agentlens_core::log_reader::FULL_RESCAN.as_secs()
                    );
                }
                if boot.watch_attached == 0 {
                    eprintln!("alcore: file watching unavailable on every log dir — falling back to a {}s full poll (higher CPU)", LOG_SWEEP_INTERVAL.as_secs());
                } else {
                    println!(
                        "alcore: watching {} log dir(s); full backstop sweep every {}s",
                        boot.watch_attached,
                        agentlens_core::log_reader::FULL_RESCAN.as_secs()
                    );
                }
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
                    st.flush_spans();
                }
                st.prune_window(agentlens_core::now_ms());
            }
        }
    });
    let hb_state = state.clone();
    rt.spawn(async move {
        // server.ts:1730 — the 30s lifecycle heartbeat: a crash then leaves lastHeartbeat as a
        // truthful downtime-gap boundary (TRDD-PJC8N1HO spec 2). The TS pairs this timer with
        // scheduleDurableSave; the Rust durable cadences live on the sweeper thread (P5e), so
        // only the heartbeat lives here.
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await; // the first tick fires immediately — boot just wrote the start marker
        loop {
            tick.tick().await;
            if let Ok(mut st) = hb_state.lock() {
                let file = agentlens_core::collector_lifecycle::lifecycle_file(&st.data_dir);
                agentlens_core::collector_lifecycle::record_heartbeat(&file, &mut st.lifecycle, agentlens_core::now_ms());
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
        st.flush_spans();
        // server.ts:4499 recordCollectorStop — a graceful exit marks the run stopped, so the
        // next boot's gap (if any) classifies as "shutdown", not "crash".
        let file = agentlens_core::collector_lifecycle::lifecycle_file(&st.data_dir);
        agentlens_core::collector_lifecycle::record_stop(&file, &mut st.lifecycle, agentlens_core::now_ms());
    };
}
