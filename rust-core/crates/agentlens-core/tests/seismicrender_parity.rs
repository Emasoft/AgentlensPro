//! Cross-engine parity for `renderBurnSeismic` (TRDD-DMWOBWFH P4x.2q, slice A of 3). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicrender-expected.mjs
//!
//! The comparison is LINE BY LINE rather than whole-string, so a failure names the line that
//! diverged instead of printing two 36-line reports and leaving the reader to diff them.

use agentlens_core::burn_seismic as bs;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicrender-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn render_burn_seismic_matches() {
    let o = oracle();
    for (name, input) in o["cases"].as_object().unwrap() {
        let got = bs::render_burn_seismic(input);
        let exp = o["rendered"][name].as_str().unwrap();
        let (g, e): (Vec<&str>, Vec<&str>) = (got.lines().collect(), exp.lines().collect());
        for (i, (gl, el)) in g.iter().zip(&e).enumerate() {
            assert_eq!(gl, el, "{name}: line {}\n  got={gl:?}\n  exp={el:?}", i + 1);
        }
        assert_eq!(g.len(), e.len(), "{name}: line count\n  got={got}\n  exp={exp}");
    }
}

/// `costParts` and the two ISO helpers are NOT exported from the TS, so they have no direct oracle;
/// they are pinned here against hand-computed values and will be covered end-to-end when the
/// analysis slice lands. Stated rather than left implicit: an untested helper that LOOKS covered
/// because it sits in a file with a passing parity test is the worse outcome.
#[test]
fn cost_parts_and_iso_helpers() {
    let now = 1_787_292_000_000.0; // 2026-08-21T06:00:00Z — a fixed instant, not the wall clock.

    // An unpriced model yields zeros, never a guessed rate: this feeds the excess ranking, so a
    // fabricated price would invent a culprit.
    assert_eq!(bs::cost_parts("no-such-model", 1e6, 1e6, 1e6, 1e6, now), bs::CostParts::default());

    // opus-5 per MTok: input 5.00, cacheRead 0.50, cacheWrite 6.25, output 25.00 — one MTok of each
    // makes the parts the rates themselves, which is what makes a swapped-field bug visible.
    let p = bs::cost_parts("claude-opus-5", 1e6, 1e6, 1e6, 1e6, now);
    assert!((p.i - 5.00).abs() < 1e-9, "input {p:?}");
    assert!((p.r - 0.50).abs() < 1e-9, "cacheRead {p:?}");
    assert!((p.w - 6.25).abs() < 1e-9, "cacheWrite {p:?}");
    assert!((p.o - 25.00).abs() < 1e-9, "output {p:?}");

    // DuckDB's naive-UTC label is read back as UTC, not local time. Getting this wrong shifts every
    // bucket by the machine's offset — an hours-long error that still produces a plausible report.
    assert_eq!(bs::iso_to_ms("2026-08-21 06:00:00"), Some(now));
    assert_eq!(bs::ms_to_bucket_iso(now), "2026-08-21 06:00:00");
    // Round-trip at a sub-second instant: the label is seconds-resolution, so the fraction is
    // dropped rather than rounded.
    assert_eq!(bs::ms_to_bucket_iso(now + 999.0), "2026-08-21 06:00:00");
    assert_eq!(bs::iso_to_ms("not a timestamp"), None);
}
