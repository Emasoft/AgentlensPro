//! alcore — the Rust server binary (TRDD-DMWOBWFH P4). P4c: OTLP listener; P4e: the UI/API
//! listener (`GET /api/summary` over the live span window).
//!
//!   alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--bind HOST]
//!
//! Spans land in `<data-dir>/spans` (the same segmented NDJSON store both engines read).
//! Default ports are 4319/3001 — NOT 4318/3000: the TS server still owns the canonical ports
//! until the P4 cutover, and 4318 doubles as the canonicality key (server.ts IS_CANONICAL).

use std::process::exit;
use std::sync::{Arc, Mutex};

fn usage(msg: &str) -> ! {
    eprintln!("alcore: {msg}");
    eprintln!("usage: alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--bind HOST]");
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
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
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
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(&spans_dir)));

    let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
        eprintln!("alcore: runtime: {e}");
        exit(1);
    });
    let addr: std::net::SocketAddr = format!("{bind}:{port}").parse().unwrap_or_else(|_| usage("bad bind/port"));
    let flush_state = state.clone();
    rt.spawn(async move {
        // Belt-and-braces flush: ingest_post already flushes per payload; this catches anything
        // buffered by future batching changes so a quiet listener still settles.
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Ok(mut st) = flush_state.lock() {
                if st.writer.pending_appends() > 0 {
                    st.writer.flush();
                }
            }
        }
    });
    let ui_addr: std::net::SocketAddr = format!("{bind}:{ui_port}").parse().unwrap_or_else(|_| usage("bad bind/ui-port"));
    let serve = agentlens_core::serve_otlp(addr, state.clone(), |bound| {
        println!("alcore: OTLP listening on http://{bound}");
    });
    let serve_ui = agentlens_core::ui::serve_ui(ui_addr, state.clone(), |bound| {
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
    // silent hole the store cannot detect.
    if let Ok(mut st) = state.lock() {
        st.writer.flush();
    };
}
