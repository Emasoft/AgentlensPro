//! captureConfig.resolveBodiesReadScope + rawBodyCaptureEnabled (TRDD-DMWOBWFH slice B3).
//!
//! Native, not oracle-driven: the answer is a function of what is on disk, and the TS has no seam
//! that would let a fixture pin it. PID-and-tag-scoped temp dirs — cargo runs these as parallel
//! threads in ONE process, so a PID-only path would let siblings delete each other's fixtures.
//! TRDD-Z53IJFE9 step D removed the RAM-disk spool: there is exactly ONE candidate dir
//! (`<data>/otel-bodies`), so the spool-first/dedup/absent-scope cases are retired with it.

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
    assert_eq!(default_bodies_dir(&d), d.join("otel-bodies"), "the single-dir reader agrees");

    let _ = std::fs::remove_dir_all(&d);
}

/// An ABSENT bodies dir is MISSING, not dropped: the report can then say it could not read it,
/// instead of implying the scope was empty.
#[test]
fn an_absent_bodies_dir_is_reported_missing_not_dropped() {
    let d = tmp("absent");
    std::fs::create_dir_all(&d).unwrap();

    let s = resolve_bodies_read_scope(&d, &no_vars());
    assert!(s.dirs.is_empty());
    assert_eq!(s.missing, vec![d.join("otel-bodies")], "named, so coverage can report the blind spot");

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
