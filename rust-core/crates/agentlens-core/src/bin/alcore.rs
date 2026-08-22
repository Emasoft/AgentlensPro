//! alcore — the Rust server binary (TRDD-DMWOBWFH P4). P4c: OTLP listener; P4e: the UI/API
//! listener (`GET /api/summary` over the live span window).
//!
//!   alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--mcp-port N] [--bind HOST] [--no-log-scan]
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
    eprintln!("usage: alcore serve --data-dir DIR [--otlp-port N] [--ui-port N] [--mcp-port N] [--bind HOST] [--no-log-scan]");
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
    // 4317, NOT the TS's 4316 — the same +1 convention as 4318→4319 and 3000→3001, so alcore can
    // run ALONGSIDE the TS server before the cutover instead of fighting it for a port. At cutover
    // this becomes 4316 (or the operator passes --mcp-port 4316), because that is the port every
    // existing Claude Code MCP config points at.
    let mut mcp_port: u16 = 4317;
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
            "--mcp-port" => {
                i += 1;
                mcp_port = args.get(i).and_then(|v| v.parse().ok()).unwrap_or_else(|| usage("--mcp-port needs a port"));
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
    // The shared embed key (embedAuth.ts / AgentlensPro#4 §B1), loaded BEFORE anything listens.
    // An unusable key file is a REFUSAL TO BOOT, not a warning: a mode wider than 0600 means
    // another local account can read the shared secret and mint `maestro` assertions, and corrupt
    // hex is undecidable rather than regenerable (ai-maestro holds the other copy). Exit 78
    // (EX_CONFIG) is the same deliberate-refusal code the TS server uses, so a supervisor treats
    // it as TERMINAL and does not respawn-loop. The normal case — a well-formed 0600 key, created
    // here on first boot — loads without incident.
    let embed_key = match agentlens_core::embed_auth::ensure_embed_key(std::path::Path::new(&data_dir)) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("alcore: {e}");
            eprintln!(
                "alcore: refusing to boot — chmod 600 the key file or delete it (a fresh 0600 key is created on next boot). See AgentlensPro#4."
            );
            exit(78);
        }
    };
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(std::path::Path::new(&data_dir))));
    {
        let mut st = state.lock().expect("state");
        st.embed_key = Some(embed_key);
        // What /api/server-stats reports as `ports` — the listeners this process ACTUALLY binds.
        // `mcp` used to be left at the env/TS default (4316) while nothing bound it, so the server
        // reported a port a client would find dead while MCP was in fact served elsewhere.
        st.ports.ui = ui_port;
        st.ports.otlp = port;
        st.ports.mcp = mcp_port;
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
    // Every recurring maintenance task, armed in ONE library call. These used to be declared
    // inline here; they moved to `agentlens_core::chores` so they are reachable from an
    // integration test — the measured cost of the old shape is that `run_burn_tick`, still
    // declared below, HAS NO TEST and cannot have one from outside the binary.
    // `spawn_all` runs the boot passes inline first (as the TS calls each chore once before
    // setting its interval), so a server restarted more often than a chore's period still
    // performs it.
    agentlens_core::chores::spawn_all(&rt, state.clone());
    let ui_addr: std::net::SocketAddr = format!("{bind}:{ui_port}").parse().unwrap_or_else(|_| usage("bad bind/ui-port"));
    let serve = agentlens_core::serve_otlp(addr, state.clone(), |bound| {
        println!("alcore: OTLP listening on http://{bound}");
    });
    let hub = Arc::new(agentlens_core::ui::SseHub::default());
    rt.spawn(agentlens_core::ui::run_push_loop(state.clone(), hub.clone()));
    // The 4s burn tick (server.ts tickBurn): burnStatus SSE frames + once-per-condition alert
    // frames, and the lastBurnStatus cache the TTL resolver + burn-risk read.
    rt.spawn(agentlens_core::ui::run_burn_tick(state.clone(), hub.clone()));
    let serve_ui = agentlens_core::ui::serve_ui(ui_addr, state.clone(), hub.clone(), |bound| {
        println!("alcore: UI/API listening on http://{bound}");
    });
    let mcp_addr: std::net::SocketAddr = format!("{bind}:{mcp_port}").parse().unwrap_or_else(|_| usage("bad bind/mcp-port"));
    let serve_mcp = agentlens_core::ui::serve_mcp(mcp_addr, state.clone(), hub, |bound| {
        println!("alcore: MCP listening on http://{bound}/mcp");
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
            r = serve_mcp => {
                if let Err(e) = r {
                    // EADDRINUSE is the expected one and deserves the actionable message the TS
                    // gives: the MCP port is the one most likely already held (by the TS server
                    // pre-cutover, or by a VS Code extension on the same port).
                    if e.kind() == std::io::ErrorKind::AddrInUse {
                        eprintln!(
                            "alcore: port {mcp_port} (MCP) already in use — stop the process using it or pass --mcp-port <other>."
                        );
                    } else {
                        eprintln!("alcore: MCP listener failed: {e}");
                    }
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
        // StatuslineStore.stop(): flush the buffer to the WAL, deliberately NOT sealing — the
        // WAL is fsynced and every read unions the WALs; the next boot's seal timer converts it.
        st.statusline.flush(None);
        // AccountStateTimeline.stop() (server.ts pipes SIGTERM here): the last window's state
        // changes are still in memory, and the 60s chore will never fire again.
        st.account_timeline.flush();
        // server.ts:4499 recordCollectorStop — a graceful exit marks the run stopped, so the
        // next boot's gap (if any) classifies as "shutdown", not "crash".
        let file = agentlens_core::collector_lifecycle::lifecycle_file(&st.data_dir);
        agentlens_core::collector_lifecycle::record_stop(&file, &mut st.lifecycle, agentlens_core::now_ms());
    };
}
