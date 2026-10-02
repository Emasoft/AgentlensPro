use agentlens_core::derived_cache::VersionedCache;
use agentlens_core::rss_guard::pressure_fracs;
use agentlens_core::{pressure_ladder_enabled, pressure_stage, CoreState};

const CAP: u64 = 1000;
const T: [u64; 3] = [700, 800, 900];

/// Stage rises 0->1 exactly at the first threshold.
#[test]
fn rises_at_threshold() {
    assert_eq!(pressure_stage(699, T, 0, CAP), 0);
    assert_eq!(pressure_stage(700, T, 0, CAP), 1);
}

/// A metric above every threshold still climbs only one stage per call.
#[test]
fn never_skips_a_stage() {
    assert_eq!(pressure_stage(5000, T, 0, CAP), 1);
    assert_eq!(pressure_stage(5000, T, 1, CAP), 2);
    assert_eq!(pressure_stage(5000, T, 2, CAP), 3);
    assert_eq!(pressure_stage(5000, T, 3, CAP), 3);
}

/// Inside the hysteresis band (threshold - 10% of cap) the stage holds.
#[test]
fn holds_inside_band() {
    assert_eq!(pressure_stage(699, T, 1, CAP), 1);
    assert_eq!(pressure_stage(600, T, 1, CAP), 1);
}

/// Below the band the stage releases by exactly one.
#[test]
fn releases_below_band() {
    assert_eq!(pressure_stage(599, T, 1, CAP), 0);
    assert_eq!(pressure_stage(0, T, 3, CAP), 2);
}

/// A metric oscillating around the boundary does not flap between stages.
#[test]
fn boundary_oscillation_does_not_flap() {
    let mut s = 0;
    let mut changes = 0;
    for m in [700, 699, 700, 699, 701, 650, 700, 690] {
        let n = pressure_stage(m, T, s, CAP);
        // Stage 1 is also at/above its own threshold only at 700+, so allow the single 1->2 only
        // when 800 is reached; here the metric never reaches it.
        if n != s {
            changes += 1;
        }
        s = n;
    }
    assert_eq!((s, changes), (1, 1));
}

/// The per-OS fraction row is the documented one.
#[test]
fn fracs_per_os() {
    #[cfg(target_os = "macos")]
    assert_eq!(pressure_fracs(), (0.70, 0.80, 0.90));
    #[cfg(not(target_os = "macos"))]
    assert_eq!(pressure_fracs(), (0.75, 0.85, 0.92));
}

/// clear() drops the memo so the next get() recomputes, without touching the version.
#[test]
fn cache_clear_forces_recompute() {
    let mut c: VersionedCache<u32> = VersionedCache::default();
    let mut n = 0;
    c.get(1, || { n += 1; 7 });
    c.get(1, || { n += 1; 7 });
    assert_eq!(n, 1);
    c.clear();
    assert_eq!(c.version(), 1);
    c.get(1, || { n += 1; 7 });
    assert_eq!(n, 2);
}

/// Kill switch: "off" disables the ladder; anything else leaves it on.
#[test]
fn kill_switch_parsing() {
    assert!(!pressure_ladder_enabled(Some("off")));
    assert!(!pressure_ladder_enabled(Some(" OFF ")));
    assert!(pressure_ladder_enabled(None));
    assert!(pressure_ladder_enabled(Some("on")));
}

/// With the env kill switch set, prune_window leaves the stage untouched.
#[test]
fn kill_switch_skips_ladder_in_prune_window() {
    let dir = std::env::temp_dir().join(format!("pressure-ladder-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::env::set_var("AGENTLENS_PRESSURE_LADDER", "off");
    let mut st = CoreState::open(&dir);
    st.pressure_stage = 2;
    st.prune_window(0);
    assert_eq!(st.pressure_stage, 2);
    std::env::remove_var("AGENTLENS_PRESSURE_LADDER");
    let _ = std::fs::remove_dir_all(&dir);
}
