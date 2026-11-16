// This file must hold exactly one test. Cargo runs each integration-test file as its own
// process, while tests inside one file run as parallel threads and would share the process-wide
// memory counter. Do not merge it into tests/lock_holder_site.rs, whose CoreState and 2 s lock
// hold would perturb the reading (TRDD-10NGH2BR).

use agentlens_core::rss_guard::primary_metric;

#[test]
fn primary_metric_reports_a_real_measurement_never_zero() {
    // THE TEST THAT WAS MISSING. Every other test here covers the env parser or the format
    // string; nothing ever called the measurement, so a metric that always read 0 shipped and
    // silently disabled the cap at every threshold (TRDD-WKLD508O, measured 2026-09-07 — two
    // probes at 512 MB and 1 MB both ran to timeout with no guard output).
    //
    // IT ASSERTS ON A DELTA, NOT ON AN ABSOLUTE FLOOR — and that is the whole design. My first
    // version asserted `> 8 MB` against whatever the binary happened to weigh, which cannot
    // tell "the metric works" from "the binary is bigger than the floor". It then failed at
    // 2,556,336 bytes, and an absolute floor gives no way to decide whether that is a broken
    // metric or an honest reading of a small test binary. Dirtying a KNOWN amount first makes
    // the two predict opposite results: a working metric must rise by roughly what was
    // touched, a broken one cannot.
    //
    // WHAT THIS DOES **NOT** PROVE, stated here because I claimed it did: rising with dirtied
    // memory does NOT prove the right FIELD is being read. `ri_resident_size` sits directly
    // before `ri_phys_footprint` in the struct, so an off-by-one-field read tracks real memory
    // just as faithfully and passes this test — while silently giving back RSS, the very
    // counter the module's header rejects. `rusage_fields_agree_with_an_independent_syscall`
    // is what pins the offset; this test only shows the counter is LIVE.
    //
    // `vec![1u8; N]` must memset every byte, so every page is faulted in — no volatile loop is
    // needed and an earlier version's one was dead weight justified by a comment about
    // `vec![0u8; N]`, which can take a zero-page path and is not what this writes.
    const DIRTY: usize = 64 * 1024 * 1024;
    let (_, before) = primary_metric(agentlens_core::server_stats::rss_bytes);
    let ballast: Vec<u8> = vec![1u8; DIRTY];
    let (name, after) = primary_metric(agentlens_core::server_stats::rss_bytes);
    std::hint::black_box(&ballast);

    // `after > before` FIRST, with its own message. Folding this into a `saturating_sub` prints
    // "moved 0 bytes" for a SHRINKING metric, which reads as "static" and hides the direction —
    // the reader at 3am then chases the wrong failure.
    assert!(
        after > before,
        "{name} did not rise after dirtying {DIRTY} bytes: {before} -> {after} (it FELL or held)",
    );
    // Half of what was dirtied. A metric reading an unrelated field cannot pass this. In a shared
    // test process the delta fell short twice on Linux (2 of 10 full lib runs, 84f3b0f8); the
    // mechanism is inferred, either other threads' frees or reuse of already-resident freed
    // memory. Running in a process of its own removes both (TRDD-10NGH2BR).
    let grew = after - before;
    assert!(
        grew > (DIRTY / 2) as u64,
        "{name} moved only {grew} bytes ({before} -> {after}) after dirtying {DIRTY} — a counter \
         that does not track real memory cannot key a hard cap",
    );
}
