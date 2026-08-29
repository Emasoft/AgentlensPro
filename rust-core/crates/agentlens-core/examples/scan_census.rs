//! Times `log_reader::cold_scan` OUTSIDE the server, to separate two explanations for the boot
//! scan being 3.4x slower than `allogscan` (TRDD-HFV4AIT7 item 3):
//!
//!   allogscan (parse only, no cards, no tokio)      6.1 s
//!   THIS      (parse + cards, no tokio)             ?
//!   server boot (parse + cards + tokio runtime)    20.5 s
//!
//! Close to 6 s  => the loss is CONTENTION with the tokio runtime.
//! Close to 20 s => the loss is the post-parse card work, and rayon is innocent.
fn main() {
    let env = agentlens_logscan::discovery::Env::from_process();
    let t0 = std::time::Instant::now();
    let (scanned, stats) = agentlens_core::log_reader::cold_scan(&env, agentlens_core::now_ms());
    let wall = t0.elapsed().as_millis();
    println!(
        "{{\"files\":{},\"parsed\":{},\"cards\":{},\"scan_elapsed_ms\":{},\"wall_ms\":{},\"rayon_threads\":{},\"scanned\":{}}}",
        stats.files, stats.parsed, stats.cards, stats.elapsed_ms, wall,
        rayon::current_num_threads(), scanned.len()
    );
}
