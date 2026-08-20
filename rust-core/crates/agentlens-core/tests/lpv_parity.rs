//! Cross-engine parity for `get_loaded_plugin_versions` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-lpv-expected.mjs
//!
//! Both engines read the committed transcripts under `tests/fixtures/lpv-home/` and the fake plugin
//! cache under `tests/fixtures/lpv-cache/`, passed explicitly — never the real `~/.claude`.

use std::path::{Path, PathBuf};

use agentlens_core::loaded_plugin_versions::{build_loaded_versions_report, compare_versions, scan_plugin_cache};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("lpv-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// `lastActivityTs` IS the transcript mtime, and git does not preserve mtimes — so a checkout would
/// otherwise compare this machine's clone times against the generator's. The oracle publishes the
/// exact table it stamped; we stamp the same one. Reading it from the oracle rather than
/// re-declaring it here is the point: a second copy drifts silently and the parity test then
/// compares two different worlds while still passing.
fn stamp_mtimes(o: &Value) {
    for (rel, ms) in o["mtimes"].as_object().unwrap() {
        let secs = ms.as_f64().unwrap() / 1000.0;
        let path = fixtures().join("lpv-home").join(rel);
        // No std API sets mtime and no dep in this crate provides one; `touch -d @<epoch>` is POSIX
        // and needs neither.
        let st = std::process::Command::new("touch")
            .args(["-d", &format!("@{secs}"), path.to_str().unwrap()])
            .status()
            .expect("touch must exist to run this parity suite");
        assert!(st.success(), "failed to stamp {}", path.display());
    }
}

fn run(o: &Value, plugin: Option<&str>, active: Option<f64>, stale_only: bool) -> Value {
    build_loaded_versions_report(
        &[fixtures().join("lpv-home")],
        &fixtures().join("lpv-cache"),
        plugin,
        active,
        stale_only,
        o["nowMs"].as_f64().unwrap(),
    )
}

/// Key ORDER is a wire contract that `assert_eq!` cannot see (`preserve_order` makes `Value::Object`
/// an IndexMap whose `PartialEq` ignores order), so it is asserted explicitly — at the report level
/// and per row, where four fields are ASSIGNED AFTER the object literal and therefore land at the
/// END rather than at their interface positions.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: report key set/ORDER differs");
    let (g, e) = (got["rows"].as_array().unwrap(), exp["rows"].as_array().unwrap());
    assert_eq!(g.len(), e.len(), "{label}.rows: length");
    for (i, (gr, er)) in g.iter().zip(e).enumerate() {
        assert_eq!(keys(gr), keys(er), "{label}.rows[{i}]: key set/ORDER differs");
        assert_eq!(gr, er, "{label}.rows[{i}]");
    }
    for (k, ev) in exp.as_object().unwrap() {
        assert_eq!(&got[k], ev, "{label}.{k}");
    }
}

#[test]
fn compare_versions_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["compareCases"].as_array().unwrap().iter().zip(o["compareSigns"].as_array().unwrap()) {
        let (a, b) = (case[0].as_str().unwrap(), case[1].as_str().unwrap());
        let got = match compare_versions(a, b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        assert_eq!(got, exp.as_i64().unwrap(), "compareVersions({a:?}, {b:?})");
    }
    // The load-bearing one, restated so a regression names itself: a LEXICOGRAPHIC compare puts
    // 1.0.9 above 1.0.10 and would report every 1.0.10 session as ahead of its own cache.
    assert_eq!(compare_versions("1.0.10", "1.0.9"), std::cmp::Ordering::Greater);
}

/// The cache scan takes the MAX by version compare, over entries whose NAME starts with a digit.
/// Both halves matter: `walkthrough` sorts ABOVE `3.4.0` under the comparator, so without the digit
/// filter a scratch directory becomes the newest "version" and every session reads as stale.
#[test]
fn scan_plugin_cache_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let got = scan_plugin_cache(&fixtures().join("lpv-cache"));
    let exp = o["newestCached"].as_object().unwrap();
    assert_eq!(got.len(), exp.len(), "got {got:?}");
    for (k, v) in exp {
        assert_eq!(got.get(k).map(String::as_str), v.as_str(), "newestCached[{k}]");
    }
    // mkt-two/no-versions holds only a README and a scratch dir — it is ABSENT, not empty-stringed.
    assert!(!got.contains_key("mkt-two/no-versions"), "{got:?}");
}

#[test]
fn build_loaded_versions_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    stamp_mtimes(&o);
    same(&run(&o, None, None, false), &o["report"], "report");
}

/// THE CORE CLAIM. `loadedVersion` is the MAXIMUM observed, deliberately NOT the latest by
/// timestamp: a compaction REPLAYS earlier skill invocations as fresh records carrying their
/// ORIGINAL content, so record order stops being chronological (measured: 18 of 19 multi-version
/// sessions non-monotone). sess-replay loads 3.4.0 at 11:00 then replays 3.3.9 at 11:10 — a
/// latest-ts port reports 3.3.9 and libels a current session as a ghost.
#[test]
fn loaded_version_is_the_max_not_the_latest_timestamp() {
    let o = oracle();
    stamp_mtimes(&o);
    let got = run(&o, None, None, false);
    let replay = got["rows"].as_array().unwrap().iter().find(|r| r["session"].as_str().unwrap().starts_with("bbbb")).unwrap();
    assert_eq!(replay["loadedVersion"], "3.4.0", "the 11:10 record replays 3.3.9; max wins: {replay}");
    assert_eq!(replay["stale"], false, "and so the session is NOT a ghost: {replay}");
    // lastObservationTs tracks the version being REPORTED, not the session's newest record.
    assert_eq!(replay["lastObservationTs"], 1785582000000i64, "11:00 — the 3.4.0 record, not the 11:10 replay");
    assert_eq!(replay["versionsSeen"], serde_json::json!(["3.3.9", "3.4.0"]), "{replay}");
}

/// `unknown` is not a softer `true` — it is the ONLY honest answer when a reload landed after our
/// last evidence, because the session may already have moved on unseen. The consumer contract is
/// fail-open: a wrong staleness verdict is worse than an admitted gap.
#[test]
fn a_reload_after_the_last_evidence_is_unknown_not_stale() {
    let o = oracle();
    stamp_mtimes(&o);
    let got = run(&o, None, None, false);
    let blind = got["rows"].as_array().unwrap().iter().find(|r| r["session"].as_str().unwrap().starts_with("cccc")).unwrap();
    assert_eq!(blind["stale"], "unknown", "{blind}");
    assert!(
        blind["lastReloadTs"].as_f64().unwrap() > blind["lastObservationTs"].as_f64().unwrap(),
        "that is exactly what makes it unknowable: {blind}"
    );
    // The ghost, by contrast, is behind with no reload after its evidence — a definite true.
    let ghost = got["rows"].as_array().unwrap().iter().find(|r| r["plugin"] == "ai-maestro-janitor" && r["stale"] == true).unwrap();
    assert_eq!((ghost["loadedVersion"].as_str(), ghost["newestCached"].as_str()), (Some("3.3.18"), Some("3.4.0")));
}

/// ONLY the harness-written attachment is evidence. sess-ghost also carries a versioned path in
/// assistant PROSE (7.7.7) and inside a non-`invoked_skills` attachment (8.8.8); on a 40-file sample
/// such paths appear 576 times, essentially all of them the model TOUCHING a path — often reading an
/// OLD cached version deliberately. Counting them reports whatever the model looked at last.
#[test]
fn only_the_invoked_skills_attachment_counts_as_evidence() {
    let o = oracle();
    stamp_mtimes(&o);
    let got = run(&o, None, None, false);
    let all: Vec<&str> =
        got["rows"].as_array().unwrap().iter().flat_map(|r| r["versionsSeen"].as_array().unwrap()).map(|v| v.as_str().unwrap()).collect();
    for decoy in ["7.7.7", "8.8.8", "9.9.9"] {
        assert!(!all.contains(&decoy), "{decoy} is prose / a wrong attachment type / undateable: {all:?}");
    }
}

/// `sessionsScanned` counts every readable transcript; `sessionsWithSkillEvidence` only those with
/// an attachment. The GAP is the blind spot the note names: those sessions are absent from `rows`
/// and are UNKNOWN, not current. Collapsing the two counters would make the report claim coverage
/// it does not have.
#[test]
fn the_scanned_minus_evidence_gap_is_reported() {
    let o = oracle();
    stamp_mtimes(&o);
    let got = run(&o, None, None, false);
    assert_eq!(got["sessionsScanned"], 5, "{got}");
    assert_eq!(got["sessionsWithSkillEvidence"], 4, "sess-noskills is scanned but has no evidence: {got}");
    assert!(got["note"].as_str().unwrap().contains("NOT current"));
    // A transcript with no sessionId falls back to its own basename rather than an empty id.
    assert!(got["rows"].as_array().unwrap().iter().any(|r| r["session"] == "sess-nosession"), "{got}");
}

#[test]
fn the_filters_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    stamp_mtimes(&o);
    same(&run(&o, Some("ponytail"), None, false), &o["filtered"], "filtered");
    same(&run(&o, Some("ai-maestro-janitor"), None, false), &o["filteredJanitor"], "filteredJanitor");
    same(&run(&o, None, None, true), &o["staleOnly"], "staleOnly");
    same(&run(&o, Some("no-such-plugin"), None, false), &o["filteredMissing"], "filteredMissing");
    // The plugin filter narrows newestCached too — an unknown plugin yields {}, not the full map,
    // so a reader cannot mistake another plugin's cache state for this one's.
    assert_eq!(run(&o, Some("no-such-plugin"), None, false)["newestCached"], serde_json::json!({}));
}

/// `activeMinutes` is a PRESENCE test in the TS, not a truthy one, so `0` is a real window anchored
/// at now — it scans nothing rather than meaning "no window". Porting it as a truthy guard silently
/// turns a deliberate zero into a full-history scan.
#[test]
fn active_minutes_is_a_presence_test_so_zero_is_a_real_window() {
    let o = oracle();
    stamp_mtimes(&o);
    same(&run(&o, None, Some(90.0), false), &o["active90"], "active90");
    same(&run(&o, None, Some(0.0), false), &o["active0"], "active0");
    let z = run(&o, None, Some(0.0), false);
    assert_eq!(z["sessionsScanned"], 0, "every fixture predates `now`: {z}");
    assert_eq!(z["activeMinutes"], 0, "and it is echoed as 0, not null: {z}");
}

/// `opts.plugin &&` is TRUTHY at both use sites, so an EMPTY filter means NO filter. An
/// `Option<&str>` port that honours `Some("")` matches no plugin at all and reports a confidently
/// empty fleet — the failure mode that looks like good news.
#[test]
fn an_empty_plugin_filter_means_no_filter() {
    let o = oracle();
    stamp_mtimes(&o);
    same(&run(&o, Some(""), None, false), &o["report"], "emptyFilter");
}
