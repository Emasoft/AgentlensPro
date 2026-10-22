//! The core cap for alcore and its DuckDB connections. Every thread pool and every DuckDB
//! `SET threads` derives its size from `max_cores()` or `duckdb_threads()`.
//!
//! WHY this lives in agentlens-store and not agentlens-core: agentlens-core depends on
//! agentlens-store, not the reverse. The DuckDB sites that must obey the cap (bodies_evidence.rs,
//! transcript_sql.rs) are in this crate, so the knob has to be reachable from here.
//! agentlens-core re-exports it as `crate::cores`, so its call sites did not change.
//!
//! WHY the cap: the user ruled "2 cores, strict" (TRDD-YH822LDI): alcore may use 2 cores in total.
//! Pools sized one by one could take the whole machine: the rayon pool at 4 threads, the request
//! runtime at one worker per core (14) with up to 512 blocking threads, and the body archive at
//! 12 threads. A pool added later must read this number, so it cannot quietly take all 14 cores.

use std::sync::OnceLock;

/// Core cap when `AGENTLENS_MAX_CORES` is unset (TRDD-YH822LDI).
const DEFAULT_MAX_CORES: usize = 2;

/// Largest value accepted for `AGENTLENS_MAX_CORES`: a sanity bound, not a target.
const MAX_CORES_CEILING: usize = 64;

/// Cores alcore may use in total, read once from `AGENTLENS_MAX_CORES` (TRDD-YH822LDI).
///
/// A malformed value panics (fail fast). A silent fallback would run alcore at a different cap
/// than the one the user typed. A panic, not `process::exit`, because a library must not end the
/// process. In alcore it fires before the rayon pool is built, so startup aborts before any
/// listener binds; under `cargo test` it is a named failure.
pub fn max_cores() -> usize {
    static CORES: OnceLock<usize> = OnceLock::new();
    *CORES.get_or_init(|| {
        let raw = std::env::var_os("AGENTLENS_MAX_CORES").map(|v| v.to_string_lossy().into_owned());
        parse_max_cores(raw.as_deref())
            .unwrap_or_else(|bad| panic!("AGENTLENS_MAX_CORES must be a whole number 1-64, got {bad}"))
    })
}

/// DuckDB threads for each connection alcore opens (TRDD-YH822LDI): `max_cores() / 2`, at least 1.
///
/// WHY half the cap: DuckDB threads multiply across connections. Each connection runs its own
/// thread pool, so two connections at the full cap would put twice the cap on the machine. Half
/// the cap lets two connections run at once within it. At cap 1 the floor of 1 still lets two
/// connections exceed the cap, because DuckDB needs at least one thread per connection.
pub fn duckdb_threads() -> usize {
    (max_cores() / 2).max(1)
}

/// Parses the raw `AGENTLENS_MAX_CORES` value. Unset gives the default. Anything other than plain
/// decimal digits within 1..=64 is an error, and the error carries the value as given.
fn parse_max_cores(raw: Option<&str>) -> Result<usize, String> {
    let Some(value) = raw else {
        return Ok(DEFAULT_MAX_CORES);
    };
    // `str::parse` alone accepts a leading `+`, so the plain-digits check is explicit.
    let plain_digits = !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit());
    match value.parse::<usize>() {
        Ok(n) if plain_digits && (1..=MAX_CORES_CEILING).contains(&n) => Ok(n),
        _ => Err(value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_max_cores;

    /// Unset means the default of 2 cores.
    #[test]
    fn unset_defaults_to_two() {
        assert_eq!(parse_max_cores(None), Ok(2));
    }

    /// The smallest and largest accepted values parse to themselves.
    #[test]
    fn accepts_one_and_sixty_four() {
        assert_eq!(parse_max_cores(Some("1")), Ok(1));
        assert_eq!(parse_max_cores(Some("64")), Ok(64));
    }

    /// Zero, out-of-range, signed, fractional, padded, empty, non-numeric and overflowing values are rejected.
    #[test]
    fn rejects_out_of_range_and_malformed_values() {
        for bad in ["0", "65", "2.5", "-1", " 2", "+2", "", "abc", "99999999999999999999999"] {
            assert_eq!(parse_max_cores(Some(bad)), Err(bad.to_string()), "value {bad:?}");
        }
    }
}
