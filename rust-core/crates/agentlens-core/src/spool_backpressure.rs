//! Spool free-space back-pressure — port of the observation half of `src/spoolBackpressure.ts`
//! (`checkSpoolCapacity` + `applySpoolBackpressure`'s redirected/spills transition).
//!
//! alcore does not itself write raw OTEL bodies — Claude Code's exporter does, keyed off an env
//! var this process does not own (see `body_writers.rs`'s header) — so there is nothing here to
//! redirect. What this DOES do is answer the question `/api/server-stats` used to answer with
//! hardcoded `0`/`false`: is the RAM-disk spool at its back-pressure floor right now, and how many
//! times has it crossed into that state since boot. A stub reading like a real measurement is
//! worse than an admitted gap (TRDD-5PUD8RKE box 3).

pub const SPOOL_FLOOR_MB_ENV: &str = "AGENTLENS_SPOOL_FLOOR_MB";
/// Mirrors spoolBackpressure.ts's `DEFAULT_SPOOL_FLOOR_BYTES`.
pub const DEFAULT_SPOOL_FLOOR_BYTES: u64 = 64 * 1024 * 1024;

/// `spoolFloorBytes`: env override (any positive number of MB), else the 64MB default.
pub fn spool_floor_bytes(vars: &std::collections::HashMap<String, String>) -> u64 {
    vars.get(SPOOL_FLOOR_MB_ENV)
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.floor() as u64 * 1024 * 1024)
        .unwrap_or(DEFAULT_SPOOL_FLOOR_BYTES)
}

/// `checkSpoolCapacity`: `free_bytes == None` (statvfs failed / not mounted) reads as NOT over
/// capacity — fail OPEN, same as the TS, so a transient stat hiccup never falsely reports pressure.
pub fn over_capacity(free_bytes: Option<u64>, floor_bytes: u64) -> bool {
    matches!(free_bytes, Some(f) if f < floor_bytes)
}

/// One controller tick: given the current over-capacity reading and the prior `(active, spills)`
/// state, return the next state. `spills` counts TRANSITIONS into over-capacity only — mirrors
/// `applySpoolBackpressure`'s `!state.redirected` guard — so a spool pinned at the floor for many
/// ticks in a row is one spill, not one per tick.
pub fn tick(over: bool, prev_active: bool, prev_spills: u64) -> (bool, u64) {
    let spills = if over && !prev_active { prev_spills + 1 } else { prev_spills };
    (over, spills)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn floor_bytes_default_and_env_override() {
        let empty = std::collections::HashMap::new();
        assert_eq!(spool_floor_bytes(&empty), DEFAULT_SPOOL_FLOOR_BYTES);

        let mut vars = std::collections::HashMap::new();
        vars.insert(SPOOL_FLOOR_MB_ENV.to_string(), "128".to_string());
        assert_eq!(spool_floor_bytes(&vars), 128 * 1024 * 1024);

        // Non-positive / unparseable falls back to the default (tolerant-parse, same as ramdisk.ts).
        vars.insert(SPOOL_FLOOR_MB_ENV.to_string(), "-5".to_string());
        assert_eq!(spool_floor_bytes(&vars), DEFAULT_SPOOL_FLOOR_BYTES);
    }

    #[test]
    fn over_capacity_fails_open_on_unknown_free_bytes() {
        assert!(!over_capacity(None, 100));
        assert!(over_capacity(Some(50), 100));
        assert!(!over_capacity(Some(150), 100));
    }

    #[test]
    fn spills_count_transitions_only() {
        // over-capacity while inactive -> spill increments, becomes active.
        let (active, spills) = tick(true, false, 0);
        assert!(active);
        assert_eq!(spills, 1);
        // stays over-capacity while already active -> no further spill.
        let (active, spills) = tick(true, active, spills);
        assert!(active);
        assert_eq!(spills, 1);
        // recovers -> active clears, spill count untouched.
        let (active, spills) = tick(false, active, spills);
        assert!(!active);
        assert_eq!(spills, 1);
        // crosses over again -> a second spill.
        let (active, spills) = tick(true, active, spills);
        assert!(active);
        assert_eq!(spills, 2);
    }
}
