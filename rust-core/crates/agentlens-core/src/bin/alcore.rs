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

use std::io::Write;
use std::process::exit;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agentlens_core::LockTimed;

/// server.ts falls back to a 5s full poll when fs.watch attaches to NO log dir; with watchers
/// the steady state is the targeted sweep + the 60s backstop (log_reader::FULL_RESCAN).
const LOG_SWEEP_INTERVAL: Duration = Duration::from_secs(5);

/// MEASURED (TRDD-DMWOBWFH D2), not a default anyone should copy without measuring: the OTLP
/// transform's profile after the by-value fix was dominated by the system allocator —
/// `_xzm_free`/`malloc`/`free` ≈ 87 samples against 27 for hashing — because building each output
/// span allocates ~9 times (7 String map keys, a Map, a Vec) and Rust's `String` has no
/// small-string optimization, so `"traceId".into()` heap-allocates 7 bytes every time. Swapping
/// the allocator took the transform 2593 -> 1698 ms and the JSON parse 1769 -> 1422 ms on a
/// 1M-span payload (**35% and 20%**), both far outside the ±6% run-to-run variance.
///
/// It belongs in the BINARY, never in a library crate: a global allocator is a process-wide
/// decision, and a library that imposes one on its dependents is antisocial.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// SIGTERM as a future, so the shutdown `select!` can await it beside `ctrl_c()`. Non-unix has no
/// SIGTERM: return a future that never completes, so the arm is simply inert there rather than
/// resolving immediately and killing the server the moment it starts.
async fn terminate_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            // Registration failed: fall back to never firing. Exiting here would turn a signal
            // problem into an immediate shutdown.
            Err(e) => {
                eprintln!("{} alcore: SIGTERM handler not installed ({e}) — stop will not flush", agentlens_core::log_ts());
                std::future::pending::<()>().await;
            }
        }
    }
    #[cfg(not(unix))]
    std::future::pending::<()>().await;
}

/// TRDD-3RVTC1HY: a panic on any thread but main (an unjoined std thread such as the log-sweeper, or a
/// tokio task, which tokio catches) leaves the process running. On 2026-10-14 16:21 a log-sweeper panic
/// poisoned the state lock and the process stayed up 28+ hours ingesting nothing, and no revive or
/// supervisor could see it as dead. Exiting makes the death visible so the hook revive or the supervisor
/// restarts a clean process. The hook must never take the state lock.
fn install_exit_on_panic() {
    static ALARM_ARMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let default_hook = std::panic::take_hook();
    // SAFETY: signal(2) changes only the process-wide disposition and touches no Rust memory, so it is safe
    // with or without other threads. It restores SIGALRM's default action (terminate): an ignored disposition
    // (SIG_IGN) survives exec from a parent that ignores it, and would silently turn the alarm backstop below
    // into a no-op.
    unsafe { libc::signal(libc::SIGALRM, libc::SIG_DFL) };
    std::panic::set_hook(Box::new(move |info| {
        // SAFETY: alarm(2) is async-signal-safe and takes no lock. Nothing in alcore handles SIGALRM (tokio
        // registers only SIGINT and SIGTERM), so its default action terminates the process if anything below
        // blocks, for example a full stderr pipe or a slow backtrace symbolication. A blocked hook would be
        // the same live-looking zombie this hook exists to remove. Armed only by the first panic, because
        // alarm(2) re-arms on every call and a panic stream would otherwise postpone the backstop indefinitely.
        if !ALARM_ARMED.swap(true, std::sync::atomic::Ordering::SeqCst) {
            unsafe { libc::alarm(10) };
        }
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_else(|| "unknown location".to_owned());
        // Written BEFORE the default hook on purpose: with RUST_BACKTRACE set, the default hook captures and
        // symbolicates a backtrace, which can itself panic under memory pressure (a double panic aborts with
        // exit 134), so the FATAL line with the location must already be in the log. writeln with its result
        // ignored, NOT eprintln: eprintln panics when the stderr write fails, and a panic inside the hook aborts.
        let _ = writeln!(std::io::stderr(), "{} alcore: FATAL — a thread panicked at {loc}; exiting so the hook revive or supervisor restarts a clean process", agentlens_core::log_ts());
        default_hook(info);
        // SAFETY: _exit(2) is async-signal-safe and never returns. std::process::exit runs atexit handlers and
        // DuckDB C++ static destructors while other threads may still hold DuckDB locks, so it can block, and a
        // blocked exit is the zombie again; _exit cannot block. Nothing is flushed on this path either way: spans
        // not yet written by the 5 s chores flush are lost, the same as kill -9.
        unsafe { libc::_exit(1) };
    }));
}
fn usage(msg: &str) -> ! {
    eprintln!("{} alcore: {msg}", agentlens_core::log_ts());
    eprintln!("usage: alcore serve --data-dir DIR --media-dir DIR [--otlp-port N] [--ui-port N] [--mcp-port N] [--bind HOST] [--no-log-scan] [--ingest-manifest PATH --aldigest-bin PATH [--ingest-sources LIST]]");
    exit(64);
}

fn main() {
    install_exit_on_panic();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("serve") {
        usage("command required (serve)");
    }
    let mut data_dir = String::new();
    // REQUIRED, never guessed from the exe location: the binary reaches this process through three
    // layouts (bin-native/<plat>/ in the tarball, <dataDir>/bin/ as a dev copy, target/debug/ under
    // cargo) and an exe-relative `../../media` is right for exactly one of them. The spawn site
    // (serverControl.ts alcoreServeArgs) knows the package root; a cargo dev passes it by hand.
    let mut media_dir = String::new();
    let mut port: u16 = 4319;
    let mut ui_port: u16 = 3001;
    // 4317, NOT the TS's 4316 — the same +1 convention as 4318→4319 and 3000→3001, so alcore can
    // run ALONGSIDE the TS server before the cutover instead of fighting it for a port. At cutover
    // this becomes 4316 (or the operator passes --mcp-port 4316), because that is the port every
    // existing Claude Code MCP config points at.
    let mut mcp_port: u16 = 4317;
    let mut bind = "127.0.0.1".to_owned();
    let mut log_scan = true;
    // The digest spool tap (spool_tap.rs): ON only when BOTH --ingest-manifest and --aldigest-bin
    // are given. --ingest-interval-secs is a hidden test knob (the seal + collect period).
    let mut ingest_manifest: Option<String> = None;
    let mut aldigest_bin: Option<String> = None;
    let mut ingest_interval_secs: Option<u64> = None;
    // Hidden test knob, like --ingest-interval-secs (deliberately not in usage()): it can only crash the
    // process its own spawner started. The trigger thread itself is spawned just before block_on.
    let mut panic_after_ready = false;
    // --ingest-sources hooks,statusline,events,spans,bodies (default: all but bodies). API bodies are
    // OFF unless asked for: measured at about 7 GB/day of spool plus about 16 GB/day of events.duckdb
    // growth (the typed tables store each body's messages again, with no de-duplication).
    let mut ingest_sources: Option<Vec<String>> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--no-log-scan" => log_scan = false,
            "--panic-after-ready" => panic_after_ready = true,
            "--ingest-manifest" => {
                i += 1;
                ingest_manifest = Some(args.get(i).cloned().unwrap_or_else(|| usage("--ingest-manifest needs a path")));
            }
            "--aldigest-bin" => {
                i += 1;
                aldigest_bin = Some(args.get(i).cloned().unwrap_or_else(|| usage("--aldigest-bin needs a path")));
            }
            "--ingest-sources" => {
                i += 1;
                let v = args.get(i).cloned().unwrap_or_else(|| usage("--ingest-sources needs a comma separated list"));
                ingest_sources = Some(agentlens_core::spool_tap::parse_sources(&v).unwrap_or_else(|e| usage(&e)));
            }
            "--ingest-interval-secs" => {
                i += 1;
                ingest_interval_secs = Some(args.get(i).and_then(|v| v.parse().ok()).filter(|n| *n > 0).unwrap_or_else(|| usage("--ingest-interval-secs needs a positive number of seconds")));
            }
            "--data-dir" => {
                i += 1;
                data_dir = args.get(i).cloned().unwrap_or_else(|| usage("--data-dir needs a path"));
            }
            "--media-dir" => {
                i += 1;
                media_dir = args.get(i).cloned().unwrap_or_else(|| usage("--media-dir needs a path"));
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
    if media_dir.is_empty() {
        usage("--media-dir is required");
    }
    // Checked here, before the pid lock or any file is touched: half a tap configuration is a
    // mistake, never a silent "tap off".
    if ingest_manifest.is_some() != aldigest_bin.is_some() {
        usage("--ingest-manifest and --aldigest-bin must be given together (the digest spool tap needs both, and is off when neither is given)");
    }
    if (ingest_interval_secs.is_some() || ingest_sources.is_some()) && ingest_manifest.is_none() {
        usage("--ingest-interval-secs and --ingest-sources only apply together with --ingest-manifest and --aldigest-bin");
    }
    // Boot-time check, not first-request: a wrong dir would otherwise report "UI/API listening"
    // and hand every browser a bare 404 — the exact silent-dark-dashboard failure of VHH7FXGC.
    let media_dir = std::fs::canonicalize(&media_dir).unwrap_or_else(|e| usage(&format!("--media-dir {media_dir}: {e}")));
    if !media_dir.join("index.html").is_file() {
        usage(&format!("--media-dir {}: no index.html there", media_dir.display()));
    }
    // BOOT PROVENANCE + THE NO_REVIVE BRAKE WARN (TRDD-Q8ZW00CI, ported from standalone/server.ts
    // :293-307 as part of TRDD-1B98LCVR).
    //
    // WHY THIS HAD TO MOVE. Enforcement of the brake is CLI-side (`src/cli/serverControl.ts`), and
    // that is TypeScript which stays. This server-side line is the DEFENCE IN DEPTH: it is the only
    // thing that speaks up when a spawner bypasses the CLI entirely, which is precisely the case the
    // brake exists for. alcore had NONE of it — verified by grep, zero hits for NO_REVIVE /
    // STARTED_BY anywhere under rust-core — while the CLI has been stamping AGENTLENS_STARTED_BY on
    // the alcore spawn all along (serverControl.ts:218-220). So the stamp was arriving and being
    // dropped on the floor, and the shipped backend was the silent one.
    //
    // The Q8ZW00CI correction is the branch below, not the WARN itself: `server start` and
    // `server restart` are the SANCTIONED overrides — they lift the brake by design — so telling
    // that operator "the starter did not honour it, clear the brake with `server start`" both
    // accuses the wrong party and advises the command that just ran. Provenance-blind wording is
    // the bug; the WARN stays verbatim for every other starter, where it is true and wanted.
    {
        let started_by = std::env::var("AGENTLENS_STARTED_BY").ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| {
            "unknown (no AGENTLENS_STARTED_BY — launched by hand, or by a spawner without the stamp)".to_owned()
        });
        // NO_REVIVE only, never the global DISABLED switch: DISABLED is terminal and is handled by
        // the CLI gate; NO_REVIVE is a pause whose stated scope is resurrection (killSwitch.ts:56).
        let brake_present = std::path::Path::new(&data_dir).join("NO_REVIVE").exists();
        let brake = if brake_present { "PRESENT" } else { "absent" };
        println!(
            "{} [AgentlensPro] boot provenance: started-by={started_by} pid={} brake={brake} data={data_dir}",
            agentlens_core::log_ts(),
            std::process::id()
        );
        if brake_present {
            if agentlens_core::brake_lift_is_sanctioned(&started_by) {
                println!("{} [AgentlensPro] brake {brake} — being lifted by `{started_by}`.", agentlens_core::log_ts());
            } else {
                eprintln!(
                    "{} [AgentlensPro] WARNING: this server started while the NO_REVIVE brake was {brake}. The starter above did not honour it. Clear the brake with `agentlenspro server start`, or stop this server with `agentlenspro server stop --stay-down`.",
                    agentlens_core::log_ts()
                );
            }
        }
    }

    let spans_dir = std::path::Path::new(&data_dir).join("spans");
    if let Err(e) = std::fs::create_dir_all(&spans_dir) {
        eprintln!("{} alcore: cannot create {}: {e}", agentlens_core::log_ts(), spans_dir.display());
        exit(1);
    }
    // TRDD-N60JUWU3: parsed at BOOT, not at stop time. Parsing it in the shutdown path meant a
    // malformed value could fail-fast (`usage()` -> exit(64)) AFTER the listeners were torn down
    // and BEFORE `pid_lock::release` — the worst possible moment to discover a config typo, since
    // it would exit without ever releasing the lock. Server default 8s; the CLI's own wait
    // (serverControl.ts stopServer) is 15s, comfortably above so a real timeout is already logged
    // by the time the CLI gives up.
    let stop_timeout: Duration = std::env::var("AGENTLENS_STOP_LOCK_TIMEOUT_MS")
        .ok()
        .map(|v| {
            v.trim()
                .parse::<u64>()
                .map(Duration::from_millis)
                .unwrap_or_else(|_| usage("AGENTLENS_STOP_LOCK_TIMEOUT_MS must be a number of milliseconds"))
        })
        .unwrap_or(Duration::from_secs(8));
    // Single-owner data-dir lock (TRDD-DMWOBWFH D1 prerequisite) — must claim BEFORE anything
    // else touches the data dir. Two servers appending to the same span store, offsets and cards
    // corrupt each other; this is the only thing standing between "alcore" and the TS server both
    // running against one DATA_DIR.
    match agentlens_core::pid_lock::claim(std::path::Path::new(&data_dir)) {
        agentlens_core::pid_lock::ClaimOutcome::Claimed => {}
        agentlens_core::pid_lock::ClaimOutcome::Refused { holder } => {
            eprintln!(
                "{} alcore: Refusing to start: another AgentlensPro server (pid {holder}) already owns this data directory ({data_dir}).\n\
                 alcore: Only ONE server may run per data directory — two processes appending to the same span store, offsets and cards corrupt each other.\n\
                 alcore: Use `agentlenspro server status` / `agentlenspro server restart`, or for a genuinely isolated instance set DATA_DIR (and HOME) as well as the ports — changing ports alone does NOT isolate storage.",
                agentlens_core::log_ts()
            );
            exit(1);
        }
        agentlens_core::pid_lock::ClaimOutcome::VerifyFailed => {
            eprintln!(
                "{} alcore: pidfile verification failed after claim — refusing to trust a lock we cannot read back correctly ({}).",
                agentlens_core::log_ts(),
                agentlens_core::pid_lock::pidfile_path(std::path::Path::new(&data_dir)).display()
            );
            exit(1);
        }
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
            eprintln!("{} alcore: {e}", agentlens_core::log_ts());
            eprintln!(
                "{} alcore: refusing to boot — chmod 600 the key file or delete it (a fresh 0600 key is created on next boot). See AgentlensPro#4.",
                agentlens_core::log_ts()
            );
            exit(78);
        }
    };
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(std::path::Path::new(&data_dir))));
    // Kept outside the state for the final seal in the shutdown sequence below.
    let mut spool_tap: Option<Arc<agentlens_core::spool_tap::SpoolTap>> = None;
    let mut spool_tap_off_reason: Option<String> = None;
    // The digest spool tap, after the pid lock (so two servers can never register against one
    // database) and BEFORE `chores::spawn_all`, whose boot drain of spooled hook events is already
    // a tap call site. An unreadable manifest is a startup error; a failing `aldigest register`
    // leaves the tap off for this process (the existing stores stay the system of record) and
    // says why on /api/ingest-status. Outside the state lock: register is a child process.
    if let (Some(manifest), Some(bin)) = (&ingest_manifest, &aldigest_bin) {
        let interval = ingest_interval_secs.unwrap_or(agentlens_core::spool_tap::DEFAULT_INTERVAL_SECS);
        let sources = ingest_sources.clone().unwrap_or_else(|| agentlens_core::spool_tap::DEFAULT_SOURCES.iter().map(|s| (*s).to_owned()).collect());
        match agentlens_core::spool_tap::start(std::path::Path::new(manifest), std::path::Path::new(bin), interval, sources, std::path::Path::new(&data_dir)) {
            Ok(agentlens_core::spool_tap::Start::Tap(tap)) => spool_tap = Some(tap),
            Ok(agentlens_core::spool_tap::Start::Disabled(reason)) => spool_tap_off_reason = Some(reason),
            Err(e) => {
                eprintln!("{} alcore: --ingest-manifest {manifest}: {e}", agentlens_core::log_ts());
                agentlens_core::pid_lock::release(std::path::Path::new(&data_dir));
                exit(1);
            }
        }
    }
    {
        let mut st = state.lock_timed();
        st.spool_tap = spool_tap.clone();
        if let Some(reason) = spool_tap_off_reason {
            st.spool_tap_off_reason = reason;
        }
        st.embed_key = Some(embed_key);
        // What /api/server-stats reports as `ports` — the listeners this process ACTUALLY binds.
        // `mcp` used to be left at the env/TS default (4316) while nothing bound it, so the server
        // reported a port a client would find dead while MCP was in fact served elsewhere.
        st.media_dir = Some(media_dir);
        st.ports.ui = ui_port;
        st.ports.otlp = port;
        st.ports.mcp = mcp_port;
        let (segments, total_spans, _) = st.writer.stats();
        println!(
            "{} alcore: loaded {} span(s) (last {}h window) from {} — store holds {total_spans} span(s) across {segments} segment(s), nothing evicted",
            agentlens_core::log_ts(),
            st.window.spans.len(),
            st.window.configured_ms / 3_600_000,
            spans_dir.display()
        );
    }

    // TRDD-RVKQDLRD: the global rayon pool is used by the log scan (`cold_scan_chunked`). It is
    // deliberately NOT lowered to background QoS: rayon also runs the pre-bind boot sweep (and a
    // stale-version cold scan) that the listeners wait on, so starving it would delay startup.
    // Only the thread count is pinned: 4 threads, a prior measurement found 4 faster than the ncpu
    // default for the cold scan. Must be configured before the first `par_iter` (the pool is
    // created lazily on first use); fail loudly if a pool already exists.
    if let Err(e) = rayon::ThreadPoolBuilder::new().num_threads(4).build_global() {
        eprintln!("{} alcore: rayon pool: {e}", agentlens_core::log_ts());
        exit(1);
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
                        "{} alcore: resumed {} log tail offsets ({} invalid/rotated → cold read); restored {} session cards",
                        agentlens_core::log_ts(),
                        boot.offsets_imported, boot.offsets_skipped, boot.restored_cards
                    );
                }
                let s = boot.sweep;
                println!(
                    "{} alcore: log scan files={} changed={} parsed={} cards={} elapsed_ms={} threads={}",
                    agentlens_core::log_ts(),
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
                        "{} alcore: no watcher on {} log dir(s) — they refresh only on the {}s backstop sweep",
                        agentlens_core::log_ts(),
                        boot.watch_failed,
                        agentlens_core::log_reader::FULL_RESCAN.as_secs()
                    );
                }
                if boot.watch_attached == 0 {
                    eprintln!("{} alcore: file watching unavailable on every log dir — falling back to a {}s full poll (higher CPU)", agentlens_core::log_ts(), LOG_SWEEP_INTERVAL.as_secs());
                } else {
                    println!(
                        "{} alcore: watching {} log dir(s); full backstop sweep every {}s",
                        agentlens_core::log_ts(),
                        boot.watch_attached,
                        agentlens_core::log_reader::FULL_RESCAN.as_secs()
                    );
                }
                sweeper = Some(handle);
            }
            Err(e) => {
                eprintln!("{} alcore: {e}", agentlens_core::log_ts());
                exit(1);
            }
        }
    }

    let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| {
        eprintln!("{} alcore: runtime: {e}", agentlens_core::log_ts());
        exit(1);
    });
    // TRDD-RVKQDLRD: a SECOND runtime for the chores, every thread (workers AND its blocking pool)
    // at background QoS. macOS QoS is per-thread and tokio reuses blocking threads across tasks,
    // so the only clean split from the request-serving runtime above is a separate runtime.
    // Small on purpose (2 workers, 4 blocking): chores must not out-run the user's apps.
    let bg_rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .thread_name("alcore-bg")
        .on_thread_start(agentlens_core::bg_qos::set_background_qos)
        .enable_all()
        .build()
        .unwrap_or_else(|e| {
            eprintln!("{} alcore: background runtime: {e}", agentlens_core::log_ts());
            exit(1);
        });
    // TRDD-RVKQDLRD: startup self-check of the PRODUCTION wiring — read the QoS class back from a
    // worker task and from a blocking-pool task of `bg_rt`, so a start hook that silently failed
    // to apply is visible in the log instead of assumed.
    #[cfg(target_os = "macos")]
    bg_rt.spawn(async {
        let worker = agentlens_core::bg_qos::current_qos_name();
        let blocking = tokio::task::spawn_blocking(agentlens_core::bg_qos::current_qos_name).await.unwrap_or("join-failed");
        eprintln!("{} alcore: qos self-check: bg-runtime worker={worker} blocking={blocking}", agentlens_core::log_ts());
    });
    let addr: std::net::SocketAddr = format!("{bind}:{port}").parse().unwrap_or_else(|_| usage("bad bind/port"));
    // Every recurring maintenance task, armed in ONE library call. These used to be declared
    // inline here; they moved to `agentlens_core::chores` so they are reachable from an
    // integration test — the measured cost of the old shape is that `run_burn_tick`, still
    // declared below, HAS NO TEST and cannot have one from outside the binary.
    // `spawn_all` runs the boot passes first (as the TS calls each chore once before setting its
    // interval), so a server restarted more often than a chore's period still performs it — as a
    // task on the background runtime, so the listeners below no longer wait for them.
    // TRDD-RVKQDLRD: BOTH runtimes are passed: durability/latency chores (5s span flush, account
    // flush, heartbeat, hook-drain tick) stay on the normal-priority `rt`; heavy housekeeping goes
    // to `bg_rt`. All chores on `bg_rt` made tests/shutdown_flush.rs fail under CPU load.
    agentlens_core::chores::spawn_all(&rt, &bg_rt, state.clone());
    let ui_addr: std::net::SocketAddr = format!("{bind}:{ui_port}").parse().unwrap_or_else(|_| usage("bad bind/ui-port"));
    let serve = agentlens_core::serve_otlp(addr, state.clone(), |bound| {
        println!("{} alcore: OTLP listening on http://{bound}", agentlens_core::log_ts());
    });
    let hub = Arc::new(agentlens_core::ui::SseHub::default());
    rt.spawn(agentlens_core::ui::run_push_loop(state.clone(), hub.clone()));
    // The 4s burn tick (server.ts tickBurn): burnStatus SSE frames + once-per-condition alert
    // frames, and the lastBurnStatus cache the TTL resolver + burn-risk read.
    rt.spawn(agentlens_core::ui::run_burn_tick(state.clone(), hub.clone()));
    // Owns summary rebuilds so no HTTP request ever runs one (TRDD-2R36W8Q1). Spawning this is
    // what flips `summary_now` from "the gate winner rebuilds synchronously" to "readers wait and
    // serve" — without it the read path silently keeps the old shape, which is why the flag is set
    // by the task itself rather than by a config knob nobody would remember to turn on.
    rt.spawn(agentlens_core::ui::run_summary_rebuild(state.clone()));
    let serve_ui = agentlens_core::ui::serve_ui(ui_addr, state.clone(), hub.clone(), |bound| {
        println!("{} alcore: UI/API listening on http://{bound}", agentlens_core::log_ts());
    });
    let mcp_addr: std::net::SocketAddr = format!("{bind}:{mcp_port}").parse().unwrap_or_else(|_| usage("bad bind/mcp-port"));
    let serve_mcp = agentlens_core::ui::serve_mcp(mcp_addr, state.clone(), hub, |bound| {
        println!("{} alcore: MCP listening on http://{bound}/mcp", agentlens_core::log_ts());
    });
    // TEST KNOB (--panic-after-ready): reproduces the zombie PRECONDITION, a panic while holding the state
    // lock. It waits for the UI listener, which binds only once block_on runs, and never gives up (the test
    // deadline bounds it). With the hook installed the lock cannot poison: _exit runs before the unwind drops
    // the guard. The zombie itself appears only when the hook is removed (the mutation check).
    if panic_after_ready {
        let trigger_state = state.clone();
        std::thread::Builder::new()
            .name("panic-trigger".to_owned())
            .spawn(move || {
                while std::net::TcpStream::connect(ui_addr).is_err() {
                    std::thread::sleep(Duration::from_millis(50));
                }
                let _guard = trigger_state.lock_timed();
                panic!("alcore: --panic-after-ready test trigger");
            })
            .expect("panic-trigger thread spawns");
    }
    rt.block_on(async move {
        tokio::select! {
            r = serve => {
                if let Err(e) = r {
                    eprintln!("{} alcore: OTLP listener failed: {e}", agentlens_core::log_ts());
                    exit(1);
                }
            }
            r = serve_ui => {
                if let Err(e) = r {
                    eprintln!("{} alcore: UI listener failed: {e}", agentlens_core::log_ts());
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
                            "{} alcore: port {mcp_port} (MCP) already in use — stop the process using it or pass --mcp-port <other>.",
                            agentlens_core::log_ts()
                        );
                    } else {
                        eprintln!("{} alcore: MCP listener failed: {e}", agentlens_core::log_ts());
                    }
                    exit(1);
                }
            }
            _ = tokio::signal::ctrl_c() => {}
            // SIGTERM, not just SIGINT (ctrl_c). `agentlenspro server stop` sends SIGTERM, which
            // is therefore the NORMAL stop path — and since the OTLP HTTP handler stopped
            // flushing per payload (TRDD-HFV4AIT7 root cause 1), the 5 s chores tick is the
            // durability boundary: without this arm the process dies on the default disposition
            // and the flush block below never runs, losing up to 5 s of spans on every stop.
            _ = terminate_signal() => {}
        }
    });
    // Flush on the way out — the writer buffers, and losing the tail on SIGINT/SIGTERM would be
    // a silent hole the store cannot detect. The sweeper flushes the durable state (offsets +
    // cards) the same way: a graceful stop loses nothing.
    //
    // TRDD-N60JUWU3: every step below shares ONE stop budget (`stop_deadline`, from `stop_timeout`
    // parsed at boot, above) instead of each getting its own — a slow flush must not leave the
    // sweeper join or the runtime shutdown with no time at all. Order matters: flush -> sweeper
    // join -> tokio runtime shutdown -> pid_lock::release, in exactly that order, because
    // releasing the pid lock before the runtime (and its background chores — e.g. the DuckDB
    // bodies pass `chores.rs` spawns via `spawn_blocking`) has actually stopped reopens the
    // double-owner window `pid_lock::claim` guards against, above: a second `claim()` between
    // release and process exit would find the data dir "free" while this process is still running.
    let stop_deadline = std::time::Instant::now() + stop_timeout;
    let remaining = |deadline: std::time::Instant| deadline.saturating_duration_since(std::time::Instant::now());

    // Signal the sweeper right away (never blocks) — its own final flush (`log_reader.rs`'s
    // `save_cards`, which takes the SAME state lock) then runs concurrently with the state flush
    // below instead of waiting for it to go first.
    let sweeper = sweeper.take();
    if let Some(h) = &sweeper {
        h.signal();
    }

    match agentlens_core::shutdown::flush_with_deadline(&state, remaining(stop_deadline)) {
        agentlens_core::shutdown::Outcome::Flushed(mut st) => {
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
        }
        agentlens_core::shutdown::Outcome::TimedOut { holder } => {
            let holder = holder.unwrap_or_else(|| "unknown".to_owned());
            // The CLI's own timeout message (serverControl.ts stopServer) greps server.log for
            // exactly this shape to name the holder in ITS error — keep the two in lockstep.
            eprintln!(
                "{} alcore: stop timed out after {} ms waiting on {holder} — skipping the flush, releasing the pid lock anyway",
                agentlens_core::log_ts(),
                stop_timeout.as_millis()
            );
        }
    }

    if let Some(h) = sweeper {
        if !h.join_within(remaining(stop_deadline)) {
            eprintln!("{} alcore: stop gave up waiting on the sweeper thread's own flush — the shared stop budget elapsed", agentlens_core::log_ts());
        }
    }

    // Explicit bounded shutdown, not an implicit drop at the end of `main` — an implicit drop
    // blocks UNBOUNDED on every still-running background task (the DuckDB bodies pass `chores.rs`
    // runs via `spawn_blocking` can take tens of seconds), so dropping `rt` implicitly was itself
    // a SECOND, unbounded starvation point behind the state-lock one this change fixes.
    // TRDD-RVKQDLRD: the background runtime runs the chores (incl. the DuckDB bodies pass), so it
    // is stopped under the same shared budget and BEFORE the pid lock is released. `rt` goes
    // FIRST: a bodies pass on `bg_rt` is uncancellable and can run tens of seconds, so shutting
    // `bg_rt` first could consume the whole budget before the request runtime (which owns the
    // span flush) got any of it.
    rt.shutdown_timeout(remaining(stop_deadline));
    bg_rt.shutdown_timeout(remaining(stop_deadline));

    // The digest spool tap's last seal, AFTER both runtimes stopped: the OTLP tap writes on the
    // blocking pool and a hook/status-line write can be in flight at the signal, so sealing any
    // earlier would leave lines in current.ndjson. Seal only, no collect — a restart must stay fast
    // and the next start's first tick collects.
    if let Some(tap) = &spool_tap {
        tap.seal_for_shutdown();
    }

    // Released LAST, after the runtime (and everything it was running) has actually stopped —
    // releasing it any earlier reopens the double-owner window `pid_lock::claim` guards against:
    // a second server could claim this data dir as "free" while this process is still finishing.
    agentlens_core::pid_lock::release(std::path::Path::new(&data_dir));
}
