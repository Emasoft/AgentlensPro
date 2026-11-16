//! The `alstore` CLI DuckDB sizing (TRDD-CQ4652DQ): it is BOUNDED, it is overridable by env,
//! and an unusable override falls back to the bounded default WITH a message.
//!
//! THE DEFECT THIS PINS: the CLI opened its store with `DEFAULT_MEMORY_LIMIT` ("8GB") and
//! `available_parallelism()` threads, while the in-process server path had already moved to a
//! bounded limit and threads=2 for the same reason (chores.rs, TRDD-768NEX6E). A live CLI pass
//! grew to 4.8 GB RSS on a 64 GB machine. These tests are the guard that keeps the CLI bounded:
//! a future edit that re-raises the default to 8GB fails `the_default_cli_limit_is_bounded`.

use std::collections::HashMap;

use agentlens_store::{cli_sizing, CLI_MEMORY_LIMIT, CLI_THREADS};

fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// THE DEFAULT IS THE BOUNDED VALUE. Without this test, a future edit that raises the default
/// back to 8GB is a green build and a 4.8 GB process on the operator machine.
#[test]
fn the_default_cli_limit_is_bounded() {
    assert_eq!(
        CLI_MEMORY_LIMIT, "1GiB",
        "the CLI DuckDB limit must stay bounded — 8GB is the defect this card fixes"
    );
    // And the limit must be materially below the OLD 8GB, not merely different from it.
    assert!(
        CLI_MEMORY_LIMIT != agentlens_store::DEFAULT_MEMORY_LIMIT,
        "the CLI limit must differ from the unbounded DEFAULT_MEMORY_LIMIT it used to use"
    );
    assert_eq!(CLI_THREADS, 2, "the CLI thread count must stay bounded like the server path");
}

/// With no env override at all, the CLI runs at the bounded default and says nothing.
#[test]
fn no_env_override_uses_the_bounded_default() {
    let s = cli_sizing(&vars(&[]));
    assert_eq!(s.memory_limit, CLI_MEMORY_LIMIT);
    assert_eq!(s.threads, CLI_THREADS);
    assert!(s.warnings.is_empty(), "a clean run must not warn: {:?}", s.warnings);
}

/// A VALID override is honoured — this is the operator escape hatch for a deliberate bulk
/// backfill, and it must work without a rebuild.
#[test]
fn a_valid_env_override_is_honoured() {
    let s = cli_sizing(&vars(&[
        ("AGENTLENS_DUCKDB_MEMORY_LIMIT", "16GB"),
        ("AGENTLENS_DUCKDB_THREADS", "8"),
    ]));
    assert_eq!(s.memory_limit, "16GB");
    assert_eq!(s.threads, 8);
    assert!(s.warnings.is_empty(), "a valid override must not warn: {:?}", s.warnings);
}

/// An UNPARSEABLE memory limit falls back to the BOUNDED default, with a message, and NEVER to
/// 8GB and NEVER to a panic. Both properties are asserted: the value AND the message.
#[test]
fn an_unparseable_memory_limit_falls_back_to_the_bounded_default_with_a_message() {
    for bad in ["not-a-size", "12QQ", "0MB", "-4GB", "1.2.3GB", "GB"] {
        let s = cli_sizing(&vars(&[("AGENTLENS_DUCKDB_MEMORY_LIMIT", bad)]));
        assert_eq!(
            s.memory_limit, CLI_MEMORY_LIMIT,
            "an unusable limit {bad:?} must fall back to the bounded default"
        );
        assert_ne!(
            s.memory_limit, agentlens_store::DEFAULT_MEMORY_LIMIT,
            "an unusable limit must NEVER fall back to the unbounded 8GB default"
        );
        assert_eq!(s.warnings.len(), 1, "an unusable limit must say so: {bad:?} gave {:?}", s.warnings);
        assert!(
            s.warnings[0].contains("AGENTLENS_DUCKDB_MEMORY_LIMIT"),
            "the warning must name the variable: {:?}",
            s.warnings[0]
        );
    }
}

/// An unparseable THREAD count falls back to the bounded default with a message.
#[test]
fn an_unparseable_thread_count_falls_back_to_the_bounded_default_with_a_message() {
    for bad in ["zero", "0", "-2", "1000", "2.5"] {
        let s = cli_sizing(&vars(&[("AGENTLENS_DUCKDB_THREADS", bad)]));
        assert_eq!(s.threads, CLI_THREADS, "an unusable thread count {bad:?} must fall back");
        assert_eq!(s.warnings.len(), 1, "an unusable thread count must say so: {bad:?}");
        assert!(
            s.warnings[0].contains("AGENTLENS_DUCKDB_THREADS"),
            "the warning must name the variable: {:?}",
            s.warnings[0]
        );
    }
}

/// An EMPTY value is an ABSENCE, not an error — the TS store treats it the same way
/// (src/store/db.ts memoryLimit), so it must not become a new failure mode here.
#[test]
fn an_empty_value_is_an_absence_not_an_error() {
    let s = cli_sizing(&vars(&[
        ("AGENTLENS_DUCKDB_MEMORY_LIMIT", ""),
        ("AGENTLENS_DUCKDB_THREADS", ""),
    ]));
    assert_eq!(s.memory_limit, CLI_MEMORY_LIMIT);
    assert_eq!(s.threads, CLI_THREADS);
    assert!(s.warnings.is_empty(), "an empty value is not a rejected one: {:?}", s.warnings);
}

/// A value carrying a SQL quote is REJECTED here rather than reaching the `SET memory_limit`
/// statement in `open_store` — the value is interpolated into SQL, so this is a boundary.
#[test]
fn a_value_carrying_a_quote_is_rejected() {
    let quote = char::from_u32(39).unwrap();
    let bad = format!("1GB{quote}; DROP TABLE blob; --");
    let s = cli_sizing(&vars(&[("AGENTLENS_DUCKDB_MEMORY_LIMIT", bad.as_str())]));
    assert_eq!(s.memory_limit, CLI_MEMORY_LIMIT);
    assert_eq!(s.warnings.len(), 1, "a quote-bearing value must be rejected with a message");
}

/// The size the CLI actually asks DuckDB for is the size DuckDB reports — the resolver and the
/// connection must not disagree, or the printed sizing is a lie.
#[test]
fn the_resolved_limit_is_the_limit_duckdb_reports() {
    let dir = std::env::temp_dir().join(format!("al-cli-sizing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let s = cli_sizing(&vars(&[]));
    let store = agentlens_store::open_store(&dir, &s.memory_limit, s.threads).expect("open");
    let lim: String = store
        .con
        .query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0))
        .expect("current_setting");
    let threads: i64 = store
        .con
        .query_row("SELECT current_setting('threads')", [], |r| r.get(0))
        .expect("current_setting");
    assert_eq!(lim, "1.0 GiB", "DuckDB must report the limit the CLI resolved");
    assert_eq!(threads, CLI_THREADS as i64);
    let _ = std::fs::remove_dir_all(&dir);
}
