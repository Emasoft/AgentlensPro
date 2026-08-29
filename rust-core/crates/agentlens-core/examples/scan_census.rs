//! Times `log_reader::cold_scan` OUTSIDE the server, to separate two explanations for the boot
//! scan being 3.4x slower than `allogscan` (TRDD-HFV4AIT7 item 3):
//!
//!   allogscan (parse only, no cards, no tokio)      6.1 s
//!   THIS      (parse + cards, no tokio)             ?
//!   server boot (parse + cards + tokio runtime)    20.5 s
//!
//! Close to 6 s  => the loss is CONTENTION with the tokio runtime.
//! Close to 20 s => the loss is the post-parse card work, and rayon is innocent.
// THE HARNESS MUST USE THE SAME ALLOCATOR AS THE SERVER, or it measures a different program.
//
// `#[global_allocator]` applies to the crate being linked as the final binary, and it is declared
// in `src/bin/alcore.rs` — NOT in the library. An EXAMPLE is its own binary, so without this line
// scan_census ran on the macOS system allocator while the production server ran on mimalloc. The
// profile said so and it was missed: `_xzm_free`, `_xzm_xzone_malloc` and `_malloc_zone_malloc`
// are libsystem_malloc frames, and macOS's allocator serialises far more aggressively under a
// parallel allocation storm than mimalloc's per-thread heaps.
//
// So every cold_scan core figure taken before this line describes the HARNESS, not the shipped
// scan. Any future harness added here must carry the same declaration.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

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
