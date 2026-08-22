//! captureConfig.resolveBodiesReadScope + rawBodyCaptureEnabled (TRDD-DMWOBWFH slice B3).
//!
//! Native, not oracle-driven: the answer is a function of what is on disk, and the TS has no seam
//! that would let a fixture pin it. PID-and-tag-scoped temp dirs — cargo runs these as parallel
//! threads in ONE process, so a PID-only path would let siblings delete each other's fixtures.

use std::collections::HashMap;

use agentlens_core::burn::guard::{default_bodies_dir, raw_body_capture_enabled, resolve_bodies_read_scope};

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-bodies-scope-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write_config(data_dir: &std::path::Path, json: &str) {
    std::fs::write(data_dir.join("config.json"), json).unwrap();
}

fn no_vars() -> HashMap<String, String> {
    HashMap::new()
}

#[test]
fn with_no_spool_the_scope_is_the_legacy_dir_alone() {
    let d = tmp("legacy-only");
    std::fs::create_dir_all(d.join("otel-bodies")).unwrap();

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert_eq!(s.dirs, vec![d.join("otel-bodies")]);
    assert!(s.missing.is_empty());
    assert!(!s.spool_configured);
    assert_eq!(default_bodies_dir(&d), d.join("otel-bodies"), "the single-dir reader agrees");

    let _ = std::fs::remove_dir_all(&d);
}

/// THE CASE B3 EXISTS FOR. Mid-drain both dirs hold bodies; a reader that sees one under-counts,
/// and `windowEstCostUsd` comes back low. Order is load-bearing too: the spool comes FIRST, so
/// `default_bodies_dir` (which takes dirs[0]) picks the LIVE dir rather than a legacy one that is
/// empty on any install redirecting bodies to a spool — reading that empty dir reports "no risk".
#[test]
fn during_a_drain_both_the_spool_and_the_legacy_dir_are_in_scope_spool_first() {
    let d = tmp("drain");
    let spool = d.join("spool-bodies");
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::create_dir_all(d.join("otel-bodies")).unwrap();
    write_config(&d, &format!(r#"{{"capture":{{"spoolDir":"{}"}}}}"#, spool.to_string_lossy()));

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert_eq!(s.dirs, vec![spool.clone(), d.join("otel-bodies")], "BOTH dirs, spool first");
    assert!(s.missing.is_empty());
    assert!(s.spool_configured);
    assert_eq!(default_bodies_dir(&d), spool, "the single-dir reader takes the LIVE spool");

    let _ = std::fs::remove_dir_all(&d);
}

/// A configured-but-absent spool is MISSING, not silently forgotten: the report can then say it
/// could not read it, instead of implying the legacy dir was the whole picture.
#[test]
fn a_configured_but_absent_spool_is_reported_missing_not_dropped() {
    let d = tmp("absent-spool");
    let spool = d.join("not-mounted");
    std::fs::create_dir_all(d.join("otel-bodies")).unwrap();
    write_config(&d, &format!(r#"{{"capture":{{"spoolDir":"{}"}}}}"#, spool.to_string_lossy()));

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert_eq!(s.dirs, vec![d.join("otel-bodies")]);
    assert_eq!(s.missing, vec![spool], "named, so coverage can report the blind spot");
    assert!(s.spool_configured, "configured is not the same question as readable");

    let _ = std::fs::remove_dir_all(&d);
}

/// A spool pointing AT the legacy dir must not scan it twice — the TS dedupes with a Set, and a
/// double-counted dir would double every byte total built from this scope.
#[test]
fn a_spool_equal_to_the_legacy_dir_is_deduped() {
    let d = tmp("dedupe");
    let legacy = d.join("otel-bodies");
    std::fs::create_dir_all(&legacy).unwrap();
    write_config(&d, &format!(r#"{{"capture":{{"spoolDir":"{}"}}}}"#, legacy.to_string_lossy()));

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert_eq!(s.dirs, vec![legacy], "one entry, not two");

    let _ = std::fs::remove_dir_all(&d);
}

/// A corrupt config must not blind the reader: it falls back to the legacy dir rather than
/// throwing or returning an empty scope, because reading config must never crash a reader.
#[test]
fn a_corrupt_config_falls_back_to_the_legacy_dir() {
    let d = tmp("corrupt");
    std::fs::create_dir_all(d.join("otel-bodies")).unwrap();
    write_config(&d, "{not json");

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert_eq!(s.dirs, vec![d.join("otel-bodies")]);
    assert!(!s.spool_configured);

    let _ = std::fs::remove_dir_all(&d);
}

/// env > file > default, and THE DEFAULT IS OFF — a default that silently costs ~35 GB/day is not
/// one a user consented to. A TYPO is not consent either: it must fall through, not be read as
/// true (which would enable capture) or as false (which would override a file that said yes).
#[test]
fn capture_resolves_env_then_file_then_off_and_a_typo_is_not_consent() {
    let d = tmp("capture");
    let v = |s: &str| HashMap::from([("AGENTLENS_CAPTURE_RAW_BODIES".to_owned(), s.to_owned())]);

    assert!(!raw_body_capture_enabled(&d, &no_vars()), "no env, no file ⇒ OFF");

    for on in ["1", "true", "on", "yes", "TRUE", " yes "] {
        assert!(raw_body_capture_enabled(&d, &v(on)), "env {on:?} ⇒ on");
    }
    for off in ["0", "false", "off", "no"] {
        assert!(!raw_body_capture_enabled(&d, &v(off)), "env {off:?} ⇒ off");
    }

    // File says yes; env absent ⇒ yes. Then a TYPO in env must NOT override it — it falls
    // through to the file, which still says yes.
    write_config(&d, r#"{"capture":{"rawBodies":true}}"#);
    assert!(raw_body_capture_enabled(&d, &no_vars()), "file ⇒ on");
    assert!(raw_body_capture_enabled(&d, &v("treu")), "a typo falls THROUGH to the file");
    assert!(!raw_body_capture_enabled(&d, &v("no")), "a valid env value still wins over the file");

    let _ = std::fs::remove_dir_all(&d);
}
